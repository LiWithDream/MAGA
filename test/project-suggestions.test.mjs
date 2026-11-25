import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST_DIR, '..');

const HERMETIC_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-proj-sugg-state-'));
process.env.ANTI_CLAUDE_STATE_DIR = HERMETIC_STATE;
process.on('exit', () => {
  try {
    fs.rmSync(HERMETIC_STATE, { recursive: true, force: true });
  } catch {}
});

let JSDOM = null;
try {
  JSDOM = createRequire(process.env.JSDOM_FROM || import.meta.url)('jsdom').JSDOM;
} catch {}
const skipDom = JSDOM ? false : 'jsdom not installed';

const {
  DEFAULT_SUGGESTIONS_MODEL,
  DEFAULT_GEMINI_BASE_URL,
  loadProjectSuggestionsConfig,
  getPublicProjectSuggestionsConfig,
  saveProjectSuggestionsConfig,
  readTranscriptTailSummary,
  collectProjectBriefAsync,
  getProjectSuggestions,
  testProjectSuggestionsConfig,
} = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'project-suggestions.mjs')).href);

const { sanitizeStudioPrefs } = await import(
  pathToFileURL(path.join(REPO, 'core', 'daemon', 'prefs-bundle.mjs')).href
);

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-sugg-unit-')));
  const projDir = path.join(root, 'repo');
  const wtDir = path.join(root, 'repo-wt', 'feat-demo');
  const brainDir = path.join(root, 'brain');
  const cacheDir = path.join(root, 'cache');
  const convWtDir = path.join(root, 'conv-wt');
  const configFile = path.join(root, 'project-suggestions-config.json');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(convWtDir, { recursive: true });
  return {
    root,
    projDir,
    wtDir,
    brainDir,
    cacheDir,
    convWtDir,
    configFile,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('project-suggestions config: 0o600 permissions, key masking, partial save preservation, clear, env fallback & sanitization', () => {
  const sb = makeSandbox();
  try {
    const emptyCfg = getPublicProjectSuggestionsConfig({ configFile: sb.configFile, env: {} });
    assert.equal(emptyCfg.hasApiKey, false);
    assert.equal(emptyCfg.apiKeySource, 'none');
    assert.equal(emptyCfg.model, DEFAULT_SUGGESTIONS_MODEL);
    assert.equal(emptyCfg.baseUrl, DEFAULT_GEMINI_BASE_URL);

    const saved = saveProjectSuggestionsConfig(
      {
        apiKey: 'AIzaTestSecretKey9876',
        model: '../bad-model',
        baseUrl: 'http://untrusted.example.com',
      },
      { configFile: sb.configFile, env: {} }
    );
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.apiKeySource, 'config');
    assert.equal(saved.apiKeyMask, 'AIza••••9876');
    assert.equal(saved.model, DEFAULT_SUGGESTIONS_MODEL);
    assert.equal(saved.baseUrl, DEFAULT_GEMINI_BASE_URL);
    assert.equal('apiKey' in saved, false, 'public config must never expose raw apiKey');

    if (process.platform !== 'win32') {
      const mode = fs.statSync(sb.configFile).mode & 0o777;
      assert.equal(mode, 0o600, 'config file must use 0o600 permissions');
    }

    // Partial update without apiKey preserves stored key & allows localhost proxy URL
    const updated = saveProjectSuggestionsConfig(
      {
        enabled: false,
        model: 'gemini-2.5-flash',
        baseUrl: 'http://127.0.0.1:8787/',
      },
      { configFile: sb.configFile, env: {} }
    );
    assert.equal(updated.enabled, false);
    assert.equal(updated.model, 'gemini-2.5-flash');
    assert.equal(updated.baseUrl, 'http://127.0.0.1:8787');
    assert.equal(updated.hasApiKey, true);
    assert.equal(loadProjectSuggestionsConfig({ configFile: sb.configFile, env: {} }).apiKey, 'AIzaTestSecretKey9876');

    // Clear key & verify GEMINI_API_KEY env fallback
    const cleared = saveProjectSuggestionsConfig({ clearApiKey: true }, { configFile: sb.configFile, env: {} });
    assert.equal(cleared.hasApiKey, false);
    assert.equal(cleared.apiKeySource, 'none');

    const envFallback = getPublicProjectSuggestionsConfig({
      configFile: sb.configFile,
      env: { GEMINI_API_KEY: 'AIzaEnvFallback1234' },
    });
    assert.equal(envFallback.hasApiKey, true);
    assert.equal(envFallback.apiKeySource, 'env');
    assert.equal(envFallback.apiKeyMask, 'AIza••••1234');

    // Ensure studio-prefs never stores or exports apiKey
    const sanitizedStudio = sanitizeStudioPrefs({ apiKey: 'AIzaLeaked', modelEffortPicker: true });
    assert.equal('apiKey' in sanitizedStudio, false);
  } finally {
    sb.cleanup();
  }
});

test('readTranscriptTailSummary & collectProjectBriefAsync: 64KB tail read, metadata strip, artifacts & fingerprint invalidation', async () => {
  const sb = makeSandbox();
  try {
    const convId = '11111111-2222-4333-8444-555555555555';
    const logsDir = path.join(sb.brainDir, convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    // Write > 80 KB of old filler lines before recent entries
    const filler = JSON.stringify({ source: 'MODEL', type: 'GENERIC', content: 'x'.repeat(1800) });
    const oldLines = Array.from({ length: 50 }, () => filler).join('\n');
    const recentUser = JSON.stringify({
      source: 'USER',
      type: 'USER_INPUT',
      content:
        '<USER_REQUEST>\nFix worktree handoff bug in daemon\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time: 2026\n</ADDITIONAL_METADATA>',
    });
    const recentModel = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Root cause located in worktrees.mjs. Next step: add regression tests and verify npm test.',
    });
    fs.writeFileSync(transcriptPath, `${oldLines}\n${recentUser}\n${recentModel}\n`, 'utf8');

    // Write top-level markdown artifacts
    const art1 = path.join(sb.brainDir, convId, 'implementation_plan.md');
    const art2 = path.join(sb.brainDir, convId, 'notes.md');
    fs.writeFileSync(art1, '# Plan\n', 'utf8');
    fs.writeFileSync(art2, '# Notes\n', 'utf8');

    const tail = readTranscriptTailSummary(convId, sb.brainDir);
    assert.equal(tail.lastUserText, 'Fix worktree handoff bug in daemon');
    assert.match(tail.lastModelText, /Root cause located in worktrees\.mjs/);
    assert.equal(tail.artifacts.length, 2);

    const opts = {
      brainDir: sb.brainDir,
      convWtDir: sb.convWtDir,
      worktrees: [
        { path: sb.projDir, realPath: sb.projDir, branch: 'main', isMain: true, ahead: 0, git: { changedFiles: 0 } },
        { path: sb.wtDir, realPath: sb.wtDir, branch: 'feat/demo', isMain: false, ahead: 2, git: { changedFiles: 1 } },
      ],
      wsStatus: {
        ok: true,
        git: { branch: 'main', changedFiles: 0 },
        recentCommits: [{ hash: 'abc1234', subject: 'feat: init', relTime: '5m' }],
      },
      convWorktreeMap: {
        entries: {
          [convId]: { cid: convId, branch: 'feat/demo', worktreePath: sb.wtDir },
        },
      },
    };

    const brief1 = await collectProjectBriefAsync(
      { dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 1000 }], lang: 'en' },
      opts
    );
    const brief2 = await collectProjectBriefAsync(
      { dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 1000 }], lang: 'en' },
      opts
    );
    assert.equal(brief1.ok, true);
    assert.equal(brief1.fingerprint, brief2.fingerprint, 'fingerprint must be deterministic');
    assert.equal(brief1.conversations[0].branch, 'feat/demo');

    // Changing commit hash or language changes fingerprint
    const briefDiff = await collectProjectBriefAsync(
      { dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 1000 }], lang: 'zh' },
      opts
    );
    assert.notEqual(brief1.fingerprint, briefDiff.fingerprint);
  } finally {
    sb.cleanup();
  }
});

test('getProjectSuggestions & testProjectSuggestionsConfig: Gemini 3.8 Flash payload, hallucination guard, caching, cooldown, dedupe & error mapping', async () => {
  const sb = makeSandbox();
  try {
    const convId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    fs.mkdirSync(path.join(sb.brainDir, convId), { recursive: true });
    saveProjectSuggestionsConfig({ apiKey: 'AIzaMockKey123456', model: 'gemini-3.8-flash' }, { configFile: sb.configFile });

    let fetchCount = 0;
    let capturedReq = null;
    const mockFetch = async (url, init) => {
      fetchCount += 1;
      capturedReq = { url, init, body: JSON.parse(init.body) };
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        suggestions: [
                          {
                            label: 'Finish feat/demo tests',
                            reason: 'Follows Fix handoff on feat/demo',
                            prompt: 'In worktree feat/demo, add regression tests and run npm test.',
                            sourceConvId: convId,
                            sourceTitle: 'Fix handoff',
                            branch: 'feat/demo',
                            worktreePath: sb.wtDir,
                            anchorFiles: ['studio/daemon/project-suggestions.mjs', '../outside/secret.txt'],
                          },
                          {
                            label: 'Hallucinated worktree check',
                            reason: 'Should drop fake worktreePath & fake convId',
                            prompt: 'Check docs and clean up.',
                            sourceConvId: '99999999-9999-4999-8999-999999999999',
                            branch: 'main',
                            worktreePath: '/tmp/nonexistent-worktree-path',
                            anchorFiles: ['/etc/passwd'],
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { totalTokenCount: 420 },
          }),
      };
    };

    let nowMs = 1_700_000_000_000;
    const baseOpts = {
      configFile: sb.configFile,
      cacheDir: sb.cacheDir,
      brainDir: sb.brainDir,
      convWtDir: sb.convWtDir,
      fetchImpl: mockFetch,
      nowFn: () => nowMs,
      cooldownMs: 60_000,
      worktrees: [
        { path: sb.projDir, realPath: sb.projDir, branch: 'main', isMain: true, ahead: 0, git: { changedFiles: 0 } },
        { path: sb.wtDir, realPath: sb.wtDir, branch: 'feat/demo', isMain: false, ahead: 1, git: { changedFiles: 0 } },
      ],
      wsStatus: {
        ok: true,
        git: { branch: 'main', changedFiles: 0 },
        recentCommits: [{ hash: '1111111', subject: 'init', relTime: '1m' }],
      },
      convWorktreeMap: { entries: {} },
    };

    // cacheOnly on empty cache makes zero network calls
    const cacheMiss = await getProjectSuggestions(
      { dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 100 }], cacheOnly: true },
      baseOpts
    );
    assert.equal(cacheMiss.needsRefresh, true);
    assert.equal(cacheMiss.suggestions.length, 0);
    assert.equal(fetchCount, 0);

    // Concurrent calls deduplicate in-flight
    const [r1, r2] = await Promise.all([
      getProjectSuggestions({ dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 100 }] }, baseOpts),
      getProjectSuggestions({ dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 100 }] }, baseOpts),
    ]);
    assert.equal(fetchCount, 1, 'concurrent calls must share in-flight request');
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.match(capturedReq.url, /\/v1beta\/models\/gemini-3\.8-flash:generateContent$/);
    assert.equal(capturedReq.init.headers['x-goog-api-key'], 'AIzaMockKey123456');
    assert.equal(capturedReq.body.generationConfig.responseMimeType, 'application/json');
    assert.ok(capturedReq.body.generationConfig.responseSchema);

    // Post-validation preserves valid worktree/conv/relative path and drops hallucinations
    assert.equal(r1.suggestions[0].worktreePath, sb.wtDir);
    assert.equal(r1.suggestions[0].sourceConvId, convId);
    assert.deepEqual(r1.suggestions[0].anchorFiles, ['studio/daemon/project-suggestions.mjs']);
    assert.equal(r1.suggestions[1].worktreePath, '');
    assert.equal(r1.suggestions[1].sourceConvId, '');
    assert.deepEqual(r1.suggestions[1].anchorFiles, []);

    // Second call with unchanged fingerprint reads disk cache
    const r3 = await getProjectSuggestions(
      { dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 100 }] },
      baseOpts
    );
    assert.equal(r3.fromCache, true);
    assert.equal(fetchCount, 1);

    // Fingerprint changed within cooldown -> returns stale cache without hitting network
    nowMs += 10_000;
    const rCooldown = await getProjectSuggestions(
      { dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 100 }], lang: 'zh' },
      baseOpts
    );
    assert.equal(rCooldown.cooldown, true);
    assert.equal(fetchCount, 1);

    // Force bypasses cooldown; test error mapping preserves cached suggestions
    const errRes401 = await getProjectSuggestions(
      { dirPath: sb.projDir, chats: [{ id: convId, title: 'Fix handoff', updatedAt: 100 }], force: true },
      {
        ...baseOpts,
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }),
      }
    );
    assert.equal(errRes401.ok, false);
    assert.equal(errRes401.error, 'invalid_api_key');
    assert.equal(errRes401.suggestions.length, 2, 'preserves cached suggestions on API error');

    const errRes429 = await testProjectSuggestionsConfig(
      {},
      { ...baseOpts, fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'Quota exceeded' }) }
    );
    assert.equal(errRes429.ok, false);
    assert.equal(errRes429.error, 'quota_exceeded');

    const errTimeout = await testProjectSuggestionsConfig(
      {},
      {
        ...baseOpts,
        fetchImpl: async () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        },
      }
    );
    assert.equal(errTimeout.ok, false);
    assert.equal(errTimeout.error, 'timeout');

    const okTest = await testProjectSuggestionsConfig({}, baseOpts);
    assert.equal(okTest.ok, true);
    assert.equal(okTest.model, 'gemini-3.8-flash');
  } finally {
    sb.cleanup();
  }
});

test('Frontend cockpit UI, suggestions controller & MAGA settings integration', { skip: skipDom }, async () => {
  const { createProjectSharedContext } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'projects', 'shared.mjs')).href
  );
  const { createProjectWorkspaceUi } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'projects', 'workspace-ui.mjs')).href
  );
  const { createProjectSuggestionsController } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'projects', 'suggestions-ui.mjs')).href
  );
  const { createStudioSettingsRuntime } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'modules', 'studio-settings.mjs')).href
  );

  // Verify line counts & syntax for new modules
  const suggUiLines = fs.readFileSync(path.join(REPO, 'user/src/modules/projects/suggestions-ui.mjs'), 'utf8').split('\n').length;
  assert.ok(suggUiLines < 400);
  execFileSync(process.execPath, ['--check', path.join(REPO, 'user/src/modules/projects/suggestions-ui.mjs')], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', path.join(REPO, 'studio/daemon/project-suggestions.mjs')], { stdio: 'pipe' });

  const dom = new JSDOM('<!doctype html><html><body><textarea id="ag-pd-composer-input"></textarea></body></html>', {
    url: 'http://127.0.0.1/c/conv-sugg',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  const doc = win.document;

  const keys = ['window', 'document', 'location', 'CustomEvent', 'Event', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: win.location });
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: win.CustomEvent });
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: win.Event });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (cb) => setTimeout(cb, 0) });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id) => clearTimeout(id) });

  try {
    const rpcCalls = [];
    let cfgState = {
      ok: true,
      enabled: true,
      autoRefresh: true,
      model: 'gemini-3.8-flash',
      baseUrl: 'https://generativelanguage.googleapis.com',
      hasApiKey: false,
      apiKeySource: 'none',
      apiKeyMask: '',
    };

    const aiSuggestion = {
      label: 'Run opus-gate tests',
      reason: 'Follows recent chat on feat/opus-gate',
      prompt: 'In feat/opus-gate (/tmp/wt-opus), run npm test and verify hook behavior.',
      sourceConvId: '11111111-2222-4333-8444-555555555555',
      branch: 'feat/opus-gate',
      worktreePath: '/tmp/wt-opus',
    };

    win.__agProjectCall = async (action, payload) => {
      rpcCalls.push({ action, payload });
      if (action === 'getProjectSuggestions') {
        if (payload.cacheOnly) {
          return { ok: true, hasApiKey: true, enabled: true, autoRefresh: true, needsRefresh: true, suggestions: [] };
        }
        return { ok: true, hasApiKey: true, enabled: true, autoRefresh: true, needsRefresh: false, suggestions: [aiSuggestion] };
      }
      if (action === 'getProjectSuggestionsConfig') return cfgState;
      if (action === 'saveProjectSuggestionsConfig') {
        cfgState = {
          ...cfgState,
          enabled: typeof payload.enabled === 'boolean' ? payload.enabled : cfgState.enabled,
          autoRefresh: typeof payload.autoRefresh === 'boolean' ? payload.autoRefresh : cfgState.autoRefresh,
          model: payload.model || cfgState.model,
          hasApiKey: payload.clearApiKey ? false : Boolean(payload.apiKey || cfgState.hasApiKey),
          apiKeySource: payload.clearApiKey ? 'none' : payload.apiKey ? 'config' : cfgState.apiKeySource,
          apiKeyMask: payload.clearApiKey ? '' : payload.apiKey ? 'AIza••••9999' : cfgState.apiKeyMask,
        };
        return cfgState;
      }
      if (action === 'testProjectSuggestionsConfig') {
        return { ok: true, model: payload.model || cfgState.model, latencyMs: 120 };
      }
      return { ok: true };
    };

    const rt = {
      FEAT: { i18n: false },
      L: (_zh, en) => en,
      state: { disposed: false },
      frame: (fn) => fn(),
      later: (fn, ms) => setTimeout(fn, ms),
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      setLeafText: (el, txt) => {
        if (el) el.textContent = txt;
      },
      syncAttrTargetSet: () => {},
      hooks: {},
    };
    const ctx = createProjectSharedContext(rt, {});
    const notices = [];
    let renderCount = 0;
    ctx.rtState.projectsViewOpen = true;
    ctx.pState.activeProjectId = 'p1';
    ctx.pHooks.renderProjectsView = () => {
      renderCount += 1;
    };
    ctx.pHooks.showProjectsFloatingNotice = (msg) => notices.push(msg);

    const wsUi = createProjectWorkspaceUi(ctx);
    const suggCtrl = createProjectSuggestionsController(ctx);
    const project = {
      id: 'p1',
      dirPath: '/tmp/repo',
      chats: [{ id: '11111111-2222-4333-8444-555555555555', title: 'Opus chat', updatedAt: 100 }],
    };

    // Static fallback when no AI suggestions loaded
    const staticHtml = wsUi.buildQuickActionsStripHtml({
      project,
      hasLocalDir: true,
      wsStatus: { ok: true, git: { changedFiles: 1 }, scripts: ['test'], recentCommits: [{ hash: 'a' }] },
      instructions: 'rules',
    });
    assert.match(staticHtml, /Review changes \(1\)/);
    assert.match(staticHtml, /Run tests/);

    // Load triggers cacheOnly then background refresh
    suggCtrl.loadProjectSuggestions(project, { force: false });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rpcCalls.filter((c) => c.action === 'getProjectSuggestions').length, 2);
    assert.equal(ctx.pState.projectSuggestionsMap['/tmp/repo'].suggestions.length, 1);

    const aiHtml = wsUi.buildQuickActionsStripHtml({
      project,
      hasLocalDir: true,
      wsStatus: { ok: true, git: { changedFiles: 2 }, scripts: ['test'], recentCommits: [] },
      instructions: '',
      aiSuggestionsState: ctx.pState.projectSuggestionsMap['/tmp/repo'],
      isLoadingAi: false,
    });
    assert.match(aiHtml, /ag-pd-quick-pill is-ai/);
    assert.match(aiHtml, /Run opus-gate tests/);
    assert.match(aiHtml, /feat\/opus-gate/);
    assert.match(aiHtml, /data-ag-pd-sugg-refresh="true"/);

    // Apply suggestion switches worktree and fills cold-start prompt
    const refreshedWts = [];
    const compInput = doc.getElementById('ag-pd-composer-input');
    suggCtrl.applySuggestion({
      suggestion: aiSuggestion,
      project,
      el: doc.body,
      compInput,
      syncSend: () => {},
      dispatchPrompt: () => {},
      shiftKey: false,
      onRefreshStatus: (wt) => refreshedWts.push(wt),
    });
    assert.equal(ctx.pState.pdActiveWorktreeByProj['/tmp/repo'], '/tmp/wt-opus');
    assert.deepEqual(refreshedWts, ['/tmp/wt-opus']);
    assert.equal(ctx.pState.projectComposerDrafts.get('p1'), aiSuggestion.prompt);
    assert.match(notices[0] || '', /Switched worktree: feat\/opus-gate/);

    // Settings UI drill-down to workspace-ai-suggestions
    const studioPrefs = {
      get: () => ({
        overviewUsageEnabled: true,
        overviewUsageDefaultPeriod: 'day',
        subagentFooterEnabled: true,
        motionLevel: 'off',
        defaultTierByFamily: {},
      }),
      getBaseState: () => ({ modules: { claudeUxProjects: true } }),
      getModelCatalog: () => ({ executors: [], planners: [], families: [] }),
      getHostPref: () => 0,
      getStepStreamMode: () => 'compact',
      subscribe: () => () => {},
    };
    const settingsRt = createStudioSettingsRuntime({ studioPrefs });
    settingsRt.openDrawer();
    settingsRt.pushView('workspace');
    await new Promise((r) => setTimeout(r, 20));
    const drawer = doc.getElementById('agy-maga-settings-drawer');
    assert.ok(drawer.querySelector('[data-ms-nav="workspace-ai-suggestions"]'));

    settingsRt.pushView('workspace-ai-suggestions');
    await new Promise((r) => setTimeout(r, 20));
    const keyInput = drawer.querySelector('[data-ms-ai-input="apiKey"]');
    assert.ok(keyInput, 'renders Gemini API Key input');
    keyInput.value = 'AIzaLiveKey9999';
    drawer.querySelector('[data-ms-action="ai-sugg-save"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cfgState.hasApiKey, true);

    drawer.querySelector('[data-ms-action="ai-sugg-test"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(drawer.querySelector('.agy-ms-status-line')?.textContent || '', /Connected/);

    settingsRt.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    win.close();
  }
});
