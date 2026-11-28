import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const realpathNative = fs.realpathSync.native || fs.realpathSync;

const {
  evaluateActionLoopPostToolUse,
  evaluateLocksPreToolUse,
  evaluateStopBoundary,
  redactSensitiveText,
  scanTranscriptTailForProposals,
} = await import(
  pathToFileURL(path.join(REPO_ROOT, 'studio', 'plugin', 'maga-anchors', 'hooks', 'anchor-guard.mjs')).href
);

const {
  acceptAnchorProposal,
  createMilestoneHandoff,
  getAnchorsStatus,
  rejectAnchorProposal,
  syncAnchorsPlugin,
} = await import(pathToFileURL(path.join(REPO_ROOT, 'studio', 'daemon', 'anchors-service.mjs')).href);

function createTempGitRepo() {
  const dir = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-anchors-repo-')));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@local'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Research Repo\n', 'utf8');
  execFileSync('git', ['-C', dir, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'init'], { stdio: 'ignore' });
  return dir;
}

test('Pillar 3: .agents/locks.json PreToolUse guard catches locked files, param overrides (local & ssh), and tombstone patterns', () => {
  const repo = createTempGitRepo();
  const stateDir = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-anc-state-')));
  try {
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.agents', 'locks.json'),
      JSON.stringify(
        {
          schema: 1,
          lockedFiles: [{ id: 'eval', path: 'scripts/eval.py', quote: '严禁修改评测脚本刷分', source: 'turn#74' }],
          paramLocks: [{ id: 'ep', key: 'MAX_EPOCHS', expected: '3', quote: '不能改最大epoch', source: 'turn#74' }],
          bannedPatterns: [
            {
              id: 'res-640',
              pattern: '(?:--image-size|--resolution|IMG_SIZE)[=\\s]+640\\b',
              quote: '640分辨率已经证伪掉点',
              source: 'turn#108',
              reopenIf: 'new multi-scale pos-embed',
            },
          ],
          tombstone_rules: [
            {
              id: 'TS-012',
              scope: 'cluster',
              pattern: 'pkill\\s+-STOP|crater_queue_daemon\\.sh\\s+trackC\\b',
              message: 'DDP pkill -STOP loops and rtx4090 trackC are banned.',
              provenance: 'Turn #126,129',
              reopen_if: 'Explicit user quota expansion',
            },
            {
              id: 'TS-013',
              scope: 'sanitization_and_shared_state',
              pattern: '/VM/[A-Za-z0-9_.-]+/',
              message: 'Tracked files must not leak /VM/<user> paths.',
              provenance: 'ENV.md',
              reopen_if: 'Never',
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    // 1. Locked file -> force_ask with verbatim quote
    const fileAsk = evaluateLocksPreToolUse(
      {
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'scripts', 'eval.py') } },
      },
      { stateDir }
    );
    assert.equal(fileAsk.decision, 'force_ask');
    assert.match(fileAsk.reason, /严禁修改评测脚本刷分/);

    // 2. Unlocked file -> allow
    assert.deepEqual(
      evaluateLocksPreToolUse(
        {
          hookEventName: 'PreToolUse',
          cwd: repo,
          toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'src', 'model.py') } },
        },
        { stateDir }
      ),
      { decision: 'allow' }
    );

    // 3. Matching MAX_EPOCHS=3 -> allow; overriding MAX_EPOCHS=6 or --max-epochs 6 over SSH -> force_ask
    assert.deepEqual(
      evaluateLocksPreToolUse(
        {
          hookEventName: 'PreToolUse',
          cwd: repo,
          toolCall: { name: 'run_command', args: { CommandLine: 'ssh pro6000 "MAX_EPOCHS=3 bash train.sh"' } },
        },
        { stateDir }
      ),
      { decision: 'allow' }
    );
    const epAsk = evaluateLocksPreToolUse(
      {
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: 'ssh pro6000 "MAX_EPOCHS=6 bash train.sh"' } },
      },
      { stateDir }
    );
    assert.equal(epAsk.decision, 'force_ask');
    assert.match(epAsk.reason, /MAX_EPOCHS=6/);
    assert.match(epAsk.reason, /不能改最大epoch/);

    // 4. Tombstone 640 pattern -> force_ask with reopen-if condition
    const tombAsk = evaluateLocksPreToolUse(
      {
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: 'python train.py --image-size 640' } },
      },
      { stateDir }
    );
    assert.equal(tombAsk.decision, 'force_ask');
    assert.match(tombAsk.reason, /640分辨率已经证伪掉点/);
    assert.match(tombAsk.reason, /reopen-if: new multi-scale pos-embed/);

    // 5. Research `tombstone_rules` (`message`/`provenance`/`reopen_if`) blocks `pkill -STOP` while skipping `sanitization` scope on SSH commands
    const ts12Ask = evaluateLocksPreToolUse(
      {
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: 'ssh pro6000 "pkill -STOP python"' } },
      },
      { stateDir }
    );
    assert.equal(ts12Ask.decision, 'force_ask');
    assert.match(ts12Ask.reason, /TS-012/);
    assert.match(ts12Ask.reason, /Turn #126,129/);

    assert.deepEqual(
      evaluateLocksPreToolUse(
        {
          hookEventName: 'PreToolUse',
          cwd: repo,
          toolCall: { name: 'run_command', args: { CommandLine: 'ssh pro6000 "ls /VM/dingli/sscl_tpami"' } },
        },
        { stateDir }
      ),
      { decision: 'allow' }
    );

    // File-scoped sanitization rule (`TS-013`) DOES catch leaking `/VM/<user>/` into non-ENV.md file writes!
    const leakWrite = evaluateLocksPreToolUse(
      {
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: {
          name: 'write_file',
          args: { Path: path.join(repo, 'docs', 'guide.md'), Content: 'Path: /VM/dingli/sscl_tpami/code\n' },
        },
      },
      { stateDir }
    );
    assert.equal(leakWrite.decision, 'force_ask');
    assert.match(leakWrite.reason, /TS-013/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Pillar 1, 2 & 3B: UTF-8 tail cursor, CoT redaction, zero-CoT rule file, 400-tok Evict-to-Admit, Stop flush, G>=3 nudge, Hand-off & Action-Loop', async () => {
  const repo = createTempGitRepo();
  const stateDir = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-anc-full-')));
  const pluginsDir = path.join(stateDir, 'plugins');
  const brainDir = path.join(stateDir, 'brain');
  const cid = 'conv-anchor-test-001';
  const logsDir = path.join(brainDir, cid, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  try {
    // Sync managed plugin
    const synced = syncAnchorsPlugin({}, { pluginsDir });
    assert.equal(synced.ok, true);
    assert.equal(synced.installed, true);

    // Copy synthetic research transcript + test partial multi-byte UTF-8 trailing line safety
    const fixtureSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'test', 'fixtures', 'anchors', 'synthetic-research-session.jsonl')
    );
    const transcriptFull = path.join(logsDir, 'transcript_full.jsonl');
    const partialTail = Buffer.from('{"step_index":99,"source":"USER_EXPLICIT","content":"未写完的半行中文', 'utf8');
    fs.writeFileSync(transcriptFull, Buffer.concat([fixtureSrc, partialTail]));

    const scan1 = scanTranscriptTailForProposals(transcriptFull, { byteOffset: 0 });
    assert.equal(scan1.nextByteOffset, fixtureSrc.length, 'cursor stops strictly at last \\n, leaving partial UTF-8 line for next read');
    assert.equal(scan1.checkpointCount, 3);
    assert.equal(scan1.candidates.length, 2, 'code-block cue ignored; 2 real user correction turns extracted');
    assert.doesNotMatch(scan1.candidates[0].thinkingPreview, /sk-test123456/, 'secret in CoT must be redacted before touching disk');
    assert.match(scan1.candidates[0].thinkingPreview, /\[REDACTED_TOKEN\]/);

    // Evaluate Stop hook -> creates proposals + G>=3 zero-token user_markdown nudge
    const stopOut = evaluateStopBoundary(
      {
        hookEventName: 'Stop',
        conversationId: cid,
        cwd: repo,
        transcriptPath: path.join(logsDir, 'transcript.jsonl'),
      },
      { stateDir, brainDir }
    );
    assert.equal(stopOut.systemMessage, '');
    assert.match(stopOut.metadata?.user_markdown || '', /G=3/);

    // Remote projection (stripThinking: true) never leaks thinkingPreview
    const remoteStatus = getAnchorsStatus({ cascadeId: cid, repoRoot: repo }, { stateDir, brainDir, pluginsDir, stripThinking: true });
    assert.equal(remoteStatus.proposals.length, 2);
    assert.equal('thinkingPreview' in remoteStatus.proposals[0], false, 'Remote status strips thinkingPreview (I12)');

    const desktopStatus = getAnchorsStatus({ cascadeId: cid, repoRoot: repo }, { stateDir, brainDir, pluginsDir });
    assert.ok(desktopStatus.proposals[0].thinkingPreview.length > 0, 'Desktop card shows redacted CoT comprehension check');

    // Accept proposal #1 WITHOUT flushNow -> queued in pendingWritesDir so live KV cache is NOT busted mid-turn!
    const acc1 = acceptAnchorProposal(
      {
        cascadeId: cid,
        proposalId: desktopStatus.proposals[0].id,
        repoRoot: repo,
        flushNow: false,
      },
      { stateDir, brainDir, pluginsDir }
    );
    assert.equal(acc1.ok, true);
    assert.equal(acc1.pendingFlush, true);
    assert.equal(fs.existsSync(path.join(repo, '.agents', 'rules', 'anchors.local.md')), false, 'deferred until Stop boundary');

    // Next Stop flushes `.agents/rules/anchors.local.md` AND adds it to `.git/info/exclude`, with ZERO CoT inside!
    evaluateStopBoundary({ hookEventName: 'Stop', conversationId: cid, cwd: repo }, { stateDir, brainDir });
    const ruleMd = fs.readFileSync(path.join(repo, '.agents', 'rules', 'anchors.local.md'), 'utf8');
    assert.match(ruleMd, /MAX_EPOCHS=3/);
    assert.doesNotMatch(ruleMd, /thinking|user explicitly locked|REDACTED_TOKEN/i, 'CoT must NEVER enter anchors.local.md (I12/I16)');
    assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'anchors.local.md is excluded in git');

    // Reject proposal #2 -> permanently muted even if re-scanned from byteOffset 0
    const rej2 = rejectAnchorProposal(
      { cascadeId: cid, proposalId: desktopStatus.proposals[1].id },
      { stateDir, brainDir, pluginsDir }
    );
    assert.equal(rej2.ok, true);
    const convState = JSON.parse(fs.readFileSync(path.join(stateDir, 'anchors-data', `${cid}.json`), 'utf8'));
    const rescanAfterMute = scanTranscriptTailForProposals(transcriptFull, {
      byteOffset: 0,
      mutedHashes: convState.mutedHashes,
    });
    assert.equal(rescanAfterMute.candidates.length, 1, 'rejected quoteHash stays muted permanently');

    // Milestone Handoff enforces userInitiated: true, escapes </untrusted_reference>, and verifies CreateConversation postcondition
    const blockedAuto = await createMilestoneHandoff({ cascadeId: cid, repoRoot: repo }, { stateDir, brainDir });
    assert.equal(blockedAuto.ok, false);
    assert.equal(blockedAuto.error, 'user_click_required');

    const handoffCreated = await createMilestoneHandoff(
      {
        cascadeId: cid,
        repoRoot: repo,
        userInitiated: true,
        // Untrusted payload address/token MUST be ignored in favor of trusted opts/env!
        lsAddress: '127.0.0.1:18791',
        csrfToken: 'evil-override',
      },
      {
        stateDir,
        brainDir,
        lsAddress: '127.0.0.1:51234',
        csrfToken: 'csrf-tok',
        fetchImpl: async (url, init) => {
          assert.match(url, /127\.0\.0\.1:51234/);
          assert.equal(init.headers['x-antigravity-csrf-token'], 'csrf-tok');
          return {
            ok: true,
            status: 200,
            json: async () => ({ conversation: { id: 'new-milestone-cid-999' } }),
          };
        },
      }
    );
    assert.equal(handoffCreated.ok, true);
    assert.equal(handoffCreated.mode, 'created');
    assert.equal(handoffCreated.newConversationId, 'new-milestone-cid-999');
    assert.doesNotMatch(handoffCreated.handoffPrompt.split('<untrusted_reference>')[1]?.split('</untrusted_reference>')[0] || '', /<\/untrusted_reference>/);
    assert.match(handoffCreated.handoffPrompt, /\[sanitized-tag\]/);

    // Action-Loop escalation (3 identical failures -> queues opus-gate debug proposal once)
    for (let k = 0; k < 3; k += 1) {
      evaluateActionLoopPostToolUse(
        {
          hookEventName: 'PostToolUse',
          conversationId: cid,
          toolCall: { name: 'run_command', args: { CommandLine: 'pytest tests/test_loss.py' } },
          toolResult: { output: 'Command exited with code 1\nAssertionError' },
        },
        { stateDir, brainDir }
      );
    }
    const opusProp = JSON.parse(fs.readFileSync(path.join(stateDir, 'opus-gate-proposals', `${cid}.json`), 'utf8'));
    assert.equal(opusProp.kind, 'debug');
    assert.equal(opusProp.trigger, 'action_loop');

    // Redaction unit check
    assert.equal(redactSensitiveText('https://user:pass123@example.com/a'), 'https://[REDACTED]@example.com/a');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Row 1 pill class invariant: #agy-anchors-pill and all OWN_ROW1_PILL_IDS use <div> wrappers and never hijack native + button:first-of-type', async () => {
  const { JSDOM } = await import('jsdom');
  const { OWN_ROW1_PILL_IDS } = await import(pathToFileURL(path.join(REPO_ROOT, 'studio', 'core', 'dom.mjs')).href);
  const { createAnchorsPillRuntime } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'studio', 'modules', 'anchors-pill.mjs')).href
  );

  // 1. Static class-level guard across all Row 1 pill modules: top-level PILL_ID must never be a <button>
  const row1Modules = [
    ['agy-resume-pill', path.join(REPO_ROOT, 'studio', 'modules', 'resume-banner.mjs')],
    ['agy-opus-gate-pill', path.join(REPO_ROOT, 'studio', 'modules', 'opus-gate-pill.mjs')],
    ['agy-auto-compact-pill', path.join(REPO_ROOT, 'studio', 'modules', 'auto-compact.mjs')],
    ['agy-anchors-pill', path.join(REPO_ROOT, 'studio', 'modules', 'anchors-pill.mjs')],
  ];
  assert.deepEqual(
    row1Modules.map(([id]) => id).sort(),
    Array.from(OWN_ROW1_PILL_IDS).sort(),
    'every OWN_ROW1_PILL_IDS entry must be covered by the non-button container guard'
  );
  for (const [pillId, modPath] of row1Modules) {
    const src = fs.readFileSync(modPath, 'utf8');
    assert.match(
      src,
      /pill\s*=\s*document\.createElement\(['"]div['"]\)/,
      `${pillId} (${path.basename(modPath)}) must create a <div> wrapper so it never steals :scope > button:first-of-type from the native + button`
    );
    assert.doesNotMatch(
      src,
      /pill\s*=\s*document\.createElement\(['"]button['"]\)/,
      `${pillId} (${path.basename(modPath)}) must not create a top-level <button>`
    );
  }

  // 2. CSS invariants for anchors-pill.css
  const css = fs.readFileSync(path.join(REPO_ROOT, 'studio', 'styles', 'anchors-pill.css'), 'utf8');
  assert.doesNotMatch(css, /:has\s*\(/, 'anchors-pill.css must contain zero :has()');
  assert.match(css, /#agy-anchors-pill#agy-anchors-pill[\s\S]*?order:\s*0\s*!important/);
  assert.match(css, /#agy-anchors-pill#agy-anchors-pill[\s\S]*?height:\s*28px\s*!important/);
  assert.match(css, /#agy-anchors-pill#agy-anchors-pill[\s\S]*?white-space:\s*nowrap\s*!important/);
  assert.match(css, /#agy-anchors-pill#agy-anchors-pill\[hidden\][\s\S]*?display:\s*none\s*!important/);

  // 3. JSDOM runtime regression: preserves native + button:first-of-type, replaces stale <button>, and opens non-empty G>=3 menu
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
      '<div id="antigravity.agentSidePanelInputBox">' +
      '  <div class="agy-composer-footer" data-agy-has-row2="true">' +
      '    <div class="left-group">' +
      '      <button id="agy-anchors-pill" type="button">stale</button>' +
      '      <button id="native-add-ctx" aria-label="Add context">+</button>' +
      '      <input type="file" class="hidden" />' +
      '    </div>' +
      '    <div class="right-group"><button id="turbo-btn">Turbo</button></div>' +
      '  </div>' +
      '</div></body></html>',
    { url: 'https://127.0.0.1:60000/c/conv-g3-ui-test' }
  );

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevLocation = globalThis.location;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;

  try {
    dom.window.__ag_last_metrics = { metrics: { compactionCount: 3 } };
    const rt = createAnchorsPillRuntime({ studioPrefs: { get: () => ({ anchorsMode: 'semi' }) } });
    const leftGroup = dom.window.document.querySelector('.left-group');
    const nativeAddBtn = dom.window.document.getElementById('native-add-ctx');

    // Visible at G=3: stale <button> replaced by <div>, native + button stays button:first-of-type
    const plan = rt.read({ cid: 'conv-g3-ui-test', isRunning: false });
    rt.write({ cid: 'conv-g3-ui-test', isRunning: false }, plan);

    const pill = dom.window.document.getElementById('agy-anchors-pill');
    assert.ok(pill, '#agy-anchors-pill must mount');
    assert.equal(pill.tagName, 'DIV', '#agy-anchors-pill root must be a DIV');
    assert.equal(pill.hidden, false);
    assert.equal(pill.getAttribute('data-warn'), '1');
    assert.ok(pill.querySelector('button.agy-anchors-go'), 'must render inner button.agy-anchors-go');
    assert.equal(
      leftGroup.querySelector(':scope > button:first-of-type'),
      nativeAddBtn,
      'native + button must remain :scope > button:first-of-type when #agy-anchors-pill is visible'
    );

    // Clicking pill opens non-empty handoff popover even before async status RPC resolves
    pill.getBoundingClientRect = () => ({ left: 40, top: 700, right: 160, bottom: 728, width: 120, height: 28 });
    pill.querySelector('button.agy-anchors-go').click();
    const menu = dom.window.document.getElementById('agy-anchors-menu');
    assert.equal(menu?.getAttribute('data-open'), 'true');
    assert.ok(menu?.querySelector('.agy-anc-handoff-btn'), 'G>=3 handoff button must render even before status RPC returns');

    // Hidden at G=0: native + button STILL remains :scope > button:first-of-type
    dom.window.history.replaceState({}, '', '/c/conv-g0-ui-test');
    dom.window.__ag_last_metrics = { metrics: { compactionCount: 0 } };
    rt.write({ cid: 'conv-g0-ui-test', isRunning: false }, { cid: 'conv-g0-ui-test', running: false });
    assert.equal(pill.hidden, true);
    assert.equal(
      leftGroup.querySelector(':scope > button:first-of-type'),
      nativeAddBtn,
      'native + button must remain :scope > button:first-of-type when #agy-anchors-pill is hidden'
    );

    rt.dispose();
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.location = prevLocation;
  }
});
