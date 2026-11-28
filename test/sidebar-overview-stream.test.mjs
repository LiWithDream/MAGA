import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');

function withDomGlobals(dom, fn) {
  const keys = [
    'window',
    'document',
    'location',
    'navigator',
    'localStorage',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'CustomEvent',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
  ];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const k of keys) {
    const v = dom.window[k];
    if (v !== undefined) {
      const val = typeof v === 'function' && (k === 'requestAnimationFrame' || k === 'cancelAnimationFrame')
        ? v.bind(dom.window)
        : v;
      Object.defineProperty(globalThis, k, {
        value: val,
        configurable: true,
        writable: true,
      });
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of keys) {
        const desc = prev.get(k);
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
      dom.window.close();
    });
}

test('computeSidebarProjectAllocation balances 4/8 budgets, protects priority chats & honors overrides', async () => {
  const { computeSidebarProjectAllocation } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'sidebar-projects.mjs')).href
  );

  const mkChats = (prefix, count, overrides = {}) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i + 1}`,
      title: `${prefix} Chat ${i + 1}`,
      updatedAt: 1000 - i * 10,
      status: overrides[i] || null,
    }));

  // 1. Asymmetric counts: 1 + 1 + 1 + 25 under 4/8 -> 1, 1, 1, 4 (total 7 <= 8)
  const asym = computeSidebarProjectAllocation(
    [
      { id: 'levi', collapsed: false, expandedOverride: false, chats: mkChats('levi', 1) },
      { id: 'cluster', collapsed: false, expandedOverride: false, chats: mkChats('cluster', 1) },
      { id: 'sscl', collapsed: false, expandedOverride: false, chats: mkChats('sscl', 1) },
      { id: 'maga', collapsed: false, expandedOverride: false, chats: mkChats('maga', 25) },
    ],
    { maxPerProject: 4, maxTotal: 8 }
  );
  assert.deepEqual(
    asym.items.map((x) => x.visibleChats.length),
    [1, 1, 1, 4]
  );
  assert.equal(asym.items[3].hiddenCount, 21);
  assert.equal(asym.totalVisible, 7);

  // 2. Multi-large projects: 25 + 8 + 6 under 4/8 -> 3 + 3 + 2 = 8 (fair water-filling)
  const multi = computeSidebarProjectAllocation(
    [
      { id: 'maga', collapsed: false, expandedOverride: false, chats: mkChats('maga', 25) },
      { id: 'sscl', collapsed: false, expandedOverride: false, chats: mkChats('sscl', 8) },
      { id: 'levi', collapsed: false, expandedOverride: false, chats: mkChats('levi', 6) },
    ],
    { maxPerProject: 4, maxTotal: 8 }
  );
  assert.deepEqual(
    multi.items.map((x) => x.visibleChats.length),
    [3, 3, 2]
  );
  assert.equal(multi.totalVisible, 8);

  // 3. Priority protection: activeId & pending/running in tail are promoted into the 4 visible slots
  const prio = computeSidebarProjectAllocation(
    [
      {
        id: 'maga',
        collapsed: false,
        expandedOverride: false,
        chats: mkChats('maga', 10, { 7: { kind: 'pending', subkind: 'terminal' }, 9: { kind: 'running', subkind: 'orbit' } }),
      },
    ],
    { maxPerProject: 4, maxTotal: 8, activeId: 'maga-6' }
  );
  assert.deepEqual(
    prio.items[0].visibleChats.map((c) => c.id),
    ['maga-1', 'maga-6', 'maga-8', 'maga-10']
  );

  // 4. Collapsed consumes 0 budget; expandedOverride shows all without starving siblings
  const ovr = computeSidebarProjectAllocation(
    [
      { id: 'col', collapsed: true, expandedOverride: false, chats: mkChats('col', 12) },
      { id: 'exp', collapsed: false, expandedOverride: true, chats: mkChats('exp', 7) },
      { id: 'sib', collapsed: false, expandedOverride: false, chats: mkChats('sib', 5) },
    ],
    { maxPerProject: 4, maxTotal: 8 }
  );
  assert.equal(ovr.items[0].visibleChats.length, 0);
  assert.equal(ovr.items[1].visibleChats.length, 7);
  assert.equal(ovr.items[2].visibleChats.length, 4);

  // 5. Zero = unlimited
  const unl = computeSidebarProjectAllocation(
    [{ id: 'maga', collapsed: false, expandedOverride: false, chats: mkChats('maga', 12) }],
    { maxPerProject: 0, maxTotal: 0 }
  );
  assert.equal(unl.items[0].visibleChats.length, 12);
  assert.equal(unl.items[0].hiddenCount, 0);
});

test('usage tier classification & logarithmic bar spread differentiate 366k / 36.6M / 1.19B', async () => {
  const { classifyUsageTier, computeLogUsageRatio, createProjectUsageRuntime } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'modules', 'project-usage.mjs')).href
  );
  assert.equal(classifyUsageTier(0), 'none');
  assert.equal(classifyUsageTier(366_000), 'light');
  assert.equal(classifyUsageTier(36_600_000), 'mid');
  assert.equal(classifyUsageTier(120_000_000), 'heavy');
  assert.equal(classifyUsageTier(1_190_000_000), 'flagship');

  const rSmall = computeLogUsageRatio(366_000, 1_190_000_000);
  const rMid = computeLogUsageRatio(36_600_000, 1_190_000_000);
  const rTop = computeLogUsageRatio(1_190_000_000, 1_190_000_000);
  assert.ok(rSmall >= 0.35 && rSmall < rMid && rMid < rTop && rTop === 1);

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="ag-claude-projects-view" data-open="true">
        <span data-ag-proj-total-usage="1" hidden></span>
        <div class="ag-proj-grid">
          <article class="ag-proj-card" data-ag-proj-id="p-small" data-ag-proj-chat-ids="c1">
            <span class="ag-proj-card-usage" data-ag-proj-usage-badge="p-small" hidden></span>
            <span class="ag-proj-card-share" data-ag-proj-usage-share="p-small" hidden></span>
          </article>
          <article class="ag-proj-card" data-ag-proj-id="p-mid" data-ag-proj-chat-ids="c2">
            <span class="ag-proj-card-usage" data-ag-proj-usage-badge="p-mid" hidden></span>
            <span class="ag-proj-card-share" data-ag-proj-usage-share="p-mid" hidden></span>
          </article>
          <article class="ag-proj-card" data-ag-proj-id="p-top" data-ag-proj-chat-ids="c3">
            <span class="ag-proj-card-usage" data-ag-proj-usage-badge="p-top" hidden></span>
            <span class="ag-proj-card-share" data-ag-proj-usage-share="p-top" hidden></span>
          </article>
        </div>
      </div>
    </body></html>`,
    { url: 'http://127.0.0.1/' }
  );

  await withDomGlobals(dom, async () => {
    dom.window.__agProjectCall = async (action) => {
      if (action === 'getUsageStats') {
        return {
          ok: true,
          byProject: {
            'p-small': { totalTokens: 366_000, requests: 8 },
            'p-mid': { totalTokens: 36_600_000, requests: 90 },
            'p-top': { totalTokens: 1_190_000_000, requests: 2100 },
          },
        };
      }
      return { ok: false };
    };
    const rt = createProjectUsageRuntime({ motionThemes: () => ({ dotColorFor: () => '#388bfd' }) });
    dom.window.dispatchEvent(new dom.window.CustomEvent('agy:projects-rendered'));
    await new Promise((r) => setTimeout(r, 25));

    const smallCard = dom.window.document.querySelector('[data-ag-proj-id="p-small"]');
    const midCard = dom.window.document.querySelector('[data-ag-proj-id="p-mid"]');
    const topCard = dom.window.document.querySelector('[data-ag-proj-id="p-top"]');
    const totalEl = dom.window.document.querySelector('[data-ag-proj-total-usage]');
    assert.equal(smallCard.getAttribute('data-usage-tier'), 'light');
    assert.equal(midCard.getAttribute('data-usage-tier'), 'mid');
    assert.equal(topCard.getAttribute('data-usage-tier'), 'flagship');
    assert.equal(topCard.style.getPropertyValue('--ag-usage-ratio'), '1');
    assert.equal(dom.window.document.querySelector('[data-ag-proj-usage-share="p-small"]').textContent, '<0.1%');
    assert.equal(dom.window.document.querySelector('[data-ag-proj-usage-share="p-mid"]').textContent, '3.0%');
    assert.equal(dom.window.document.querySelector('[data-ag-proj-usage-share="p-top"]').textContent, '97%');
    assert.equal(totalEl.hidden, false);
    assert.match(totalEl.textContent, /1\.23B/);
    rt.dispose();
  });
});

test('studio-prefs supports 3-mode stepStreamMode (inline default) & sidebar project cap prefs', async () => {
  const { DEFAULT_STUDIO_PREFS, sanitizeStudioPrefs } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'shared', 'prefs-schema.mjs')).href
  );
  const { createStudioPrefsRuntime } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'modules', 'studio-prefs.mjs')).href
  );
  const { renderL2Stream, renderL2Workspace } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'views.mjs')).href
  );

  assert.equal(DEFAULT_STUDIO_PREFS.sidebarProjectCapEnabled, true);
  assert.equal(DEFAULT_STUDIO_PREFS.sidebarProjectMaxPerProject, 4);
  assert.equal(DEFAULT_STUDIO_PREFS.sidebarProjectMaxTotal, 8);

  const sanitized = sanitizeStudioPrefs({
    sidebarProjectCapEnabled: false,
    sidebarProjectMaxPerProject: 0,
    sidebarProjectMaxTotal: 99,
  });
  assert.equal(sanitized.sidebarProjectCapEnabled, false);
  assert.equal(sanitized.sidebarProjectMaxPerProject, 0);
  assert.equal(sanitized.sidebarProjectMaxTotal, 40);

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  await withDomGlobals(dom, async () => {
    let verbose = false;
    let baseStepUnfold = true;
    const events = [];
    dom.window.addEventListener('agy:sidebar-cap-prefs-changed', () => events.push('cap'));
    dom.window.__agClaudeUxBridge = {
      getState: () => ({ modules: { claudeUxStepUnfold: baseStepUnfold } }),
      setModule: (k, v) => {
        if (k === 'claudeUxStepUnfold') baseStepUnfold = Boolean(v);
        return true;
      },
      setCjkScale: () => '95',
    };
    dom.window.document.documentElement.__reactFiber$root = {
      memoizedProps: {
        value: {
          getState: () => ({
            getPrefValue: (k) => (k === 'verboseConversationSteps' ? verbose : undefined),
            setPrefValue: async (k, v) => {
              if (k === 'verboseConversationSteps') verbose = Boolean(v);
            },
          }),
        },
      },
    };
    const rootDiv = dom.window.document.createElement('div');
    rootDiv.id = 'root';
    rootDiv.__reactFiber$root = dom.window.document.documentElement.__reactFiber$root;
    dom.window.document.body.appendChild(rootDiv);

    const prefsRt = createStudioPrefsRuntime({});
    assert.equal(prefsRt.getStepStreamMode(), 'inline');
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-cap'), '1');
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-cap-per'), '4');
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-cap-total'), '8');

    await prefsRt.setStepStreamMode('compact');
    assert.equal(prefsRt.getStepStreamMode(), 'compact');
    assert.equal(baseStepUnfold, false);
    assert.equal(verbose, false);

    await prefsRt.setStepStreamMode('verbose');
    assert.equal(prefsRt.getStepStreamMode(), 'verbose');
    assert.equal(baseStepUnfold, true);
    assert.equal(verbose, true);

    await prefsRt.setStepStreamMode('inline');
    assert.equal(prefsRt.getStepStreamMode(), 'inline');
    assert.equal(baseStepUnfold, true);
    assert.equal(verbose, false);

    prefsRt.patch({ sidebarProjectMaxPerProject: 5, sidebarProjectMaxTotal: 10 }, { skipDaemon: true });
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-cap-per'), '5');
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-cap-total'), '10');
    assert.ok(events.includes('cap'));

    const streamHtml = renderL2Stream(prefsRt.get(), { modules: { claudeUxCodeFold: true } }, { studioPrefs: prefsRt, L: (_zh, en) => en });
    assert.match(streamHtml, /data-ms-seg-val="inline"[^>]*aria-checked="true"/);
    assert.match(streamHtml, /data-ms-seg-val="compact"/);
    assert.match(streamHtml, /data-ms-seg-val="verbose"/);
    assert.doesNotMatch(streamHtml, /对齐 Remote|Remote-like|matches Remote/i);
    assert.match(streamHtml, /agy-ms-stream-preview[^>]*data-mode="inline"[^>]*data-hide-thinking="1"/);
    assert.match(streamHtml, /agy-ms-sp-prose/);
    assert.match(streamHtml, /agy-ms-sp-action is-summary/);
    assert.doesNotMatch(streamHtml, /agy-ms-sp-think/);

    await prefsRt.setStepStreamMode('compact');
    const compactHtml = renderL2Stream(prefsRt.get(), { modules: { claudeUxCodeFold: true } }, { studioPrefs: prefsRt, L: (_zh, en) => en });
    assert.match(compactHtml, /agy-ms-stream-preview[^>]*data-mode="compact"/);
    assert.match(compactHtml, /agy-ms-sp-folded-tag/);
    assert.doesNotMatch(compactHtml, /agy-ms-sp-detail-box/);

    await prefsRt.setStepStreamMode('verbose');
    prefsRt.patch({ hideThinkingProse: false }, { skipDaemon: true });
    const verboseHtml = renderL2Stream(prefsRt.get(), { modules: { claudeUxCodeFold: true } }, { studioPrefs: prefsRt, L: (_zh, en) => en });
    assert.match(verboseHtml, /agy-ms-stream-preview[^>]*data-mode="verbose"[^>]*data-hide-thinking="0"/);
    assert.match(verboseHtml, /agy-ms-sp-detail-box/);
    assert.match(verboseHtml, /agy-ms-sp-think/);
    prefsRt.patch({ hideThinkingProse: true }, { skipDaemon: true });
    await prefsRt.setStepStreamMode('inline');

    const wsHtml = renderL2Workspace(prefsRt.get(), { modules: { claudeUxHideSidebarProjects: false } }, { state: {}, L: (_zh, en) => en });
    assert.match(wsHtml, /data-ms-key="sidebarProjectCapEnabled"/);
    assert.match(wsHtml, /data-ms-seg-key="sidebarProjectMaxPerProject"/);
    assert.match(wsHtml, /data-ms-seg-key="sidebarProjectMaxTotal"/);

    prefsRt.dispose();
  });
});

test('step-stream keeps prose open while compressing pure-tool worked-for blocks & tagging action cards', async () => {
  const { createStepStreamModule } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'step-stream.mjs')).href
  );
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="turn-host" data-testid="agent-response">
        <div id="direct-wrap">
          <button id="btn-direct" type="button" data-testid="worked-for-collapsible" aria-expanded="false">Worked for 1m</button>
          <div id="direct-panel"><div class="select-text"><p>Intermediate summary text</p></div></div>
        </div>
        <div id="trailing-host">
          <div class="flex min-w-0 items-center">
            <button id="btn-trailing" type="button" data-testid="worked-for-collapsible" aria-expanded="true">Worked for 2m</button>
            <span class="trailing" data-testid="step-plan-chip">3/3 steps</span>
          </div>
          <div id="trailing-panel"><div class="select-text"><p>Trailing summary text</p></div></div>
        </div>
        <div id="tools-only-wrap">
          <button id="btn-tools" type="button" data-testid="worked-for-collapsible" aria-expanded="false">Worked for 41s</button>
          <div id="tools-panel">
            <div data-step-rows="true">
              <button type="button" data-testid="tool-group-collapsible" aria-expanded="false">Explored files, Ran command</button>
              <button type="button" data-testid="tool-group-collapsible" aria-expanded="false">Edited file</button>
            </div>
          </div>
        </div>
        <div id="active-tools-wrap">
          <button id="btn-active-tools" type="button" data-testid="worked-for-collapsible" aria-expanded="true">Worked for 9s</button>
          <div id="active-tools-panel">
            <span id="active-ephemeral" data-testid="ephemeral-tool-status">Running build</span>
            <div data-step-rows="true">
              <button type="button" data-testid="tool-group-collapsible" aria-expanded="false">Running build</button>
            </div>
          </div>
        </div>
        <div id="standalone-action-wrap" class="rounded-lg border">
          <button id="btn-ran-card" type="button">Ran build · Exited with code 1</button>
        </div>
        <div id="cjk-action-wrap" class="rounded-lg border">
          <button id="btn-cjk-ran" type="button">已运行 重新运行构建与全量测试套件</button>
        </div>
        <div id="combo-guard-wrap" class="rounded-lg border">
          <button id="btn-combo-guard" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false">Model choice</button>
        </div>
        <div data-markdown-root="true">
          <div id="md-btn-wrap" class="rounded-lg border">
            <button id="btn-md-guard" type="button" aria-expanded="false">已运行 Markdown Quoted Block</button>
          </div>
        </div>
      </div>
    </body></html>`,
    { url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );

  await withDomGlobals(dom, async () => {
    const doc = dom.window.document;
    const btnDirect = doc.getElementById('btn-direct');
    const btnTrailing = doc.getElementById('btn-trailing');
    const btnTools = doc.getElementById('btn-tools');
    const btnActiveTools = doc.getElementById('btn-active-tools');
    const btnRan = doc.getElementById('btn-ran-card');
    const btnCjkRan = doc.getElementById('btn-cjk-ran');
    for (const btn of [btnDirect, btnTrailing, btnTools, btnActiveTools]) {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('aria-expanded') === 'true' ? 'false' : 'true';
        btn.setAttribute('aria-expanded', next);
      });
    }

    const rt = {
      FEAT: { stepUnfold: true, collapseAnim: true, runningTimer: true, codeFold: true },
      L: (_zh, en) => en,
      frame: (fn) => setTimeout(fn, 0),
      isTrustedClick: (e) => Boolean(e && e.__testTrusted),
      state: { disposed: false },
      setLeafText: (el, txt) => {
        if (el.textContent !== txt) el.textContent = txt;
      },
      syncAttrTargetSet: (attr, nextSet) => {
        doc.querySelectorAll(`[${attr}]`).forEach((el) => {
          if (!nextSet.has(el)) el.removeAttribute(attr);
        });
        for (const el of nextSet) el.setAttribute(attr, '1');
      },
    };
    const mod = createStepStreamModule(rt);
    mod.sync();
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(btnDirect.getAttribute('aria-expanded'), 'true', 'direct prose turn auto-expands');
    assert.equal(doc.getElementById('direct-wrap').getAttribute('data-ag-inline-stream'), 'true');
    assert.equal(doc.getElementById('direct-wrap').getAttribute('data-ag-inline-kind'), 'prose');
    assert.equal(doc.getElementById('trailing-host').getAttribute('data-ag-inline-stream'), 'true', 'trailing wrapper marks outer host');

    // Pure-tool block probed & compressed to 1 line with inline summary
    assert.equal(doc.getElementById('tools-only-wrap').getAttribute('data-ag-inline-kind'), 'tools');
    assert.equal(btnTools.getAttribute('aria-expanded'), 'false', 'pure-tool worked block stays compressed');
    assert.match(btnTools.querySelector('.ag-worked-inline-summary')?.textContent || '', /Explored files, Ran command · Edited file/);

    // Active tool-first turn must NOT be sealed as 'tools'; late prose arriving before turn-end collapse keeps it expanded
    assert.equal(doc.getElementById('active-tools-wrap').getAttribute('data-ag-inline-kind'), null);
    assert.equal(btnActiveTools.getAttribute('aria-expanded'), 'true');
    doc.getElementById('active-ephemeral').remove();
    const lateProse = doc.createElement('div');
    lateProse.className = 'select-text';
    lateProse.innerHTML = '<p>Late intermediate brief</p>';
    doc.getElementById('active-tools-panel').appendChild(lateProse);
    btnActiveTools.setAttribute('aria-expanded', 'false');
    mod.handleAriaExpandedMutation(btnActiveTools);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(btnActiveTools.getAttribute('aria-expanded'), 'true', 'late prose turn re-expands cleanly after active tools');
    assert.equal(doc.getElementById('active-tools-wrap').getAttribute('data-ag-inline-kind'), 'prose');

    // Standalone bordered command action (EN + CJK) tagged while markdown/combobox guards excluded
    assert.equal(btnRan.getAttribute('data-maga-action-card'), '1');
    assert.equal(doc.getElementById('standalone-action-wrap').getAttribute('data-maga-action-card'), '1');
    assert.equal(btnCjkRan.getAttribute('data-maga-action-card'), '1');
    assert.equal(doc.getElementById('cjk-action-wrap').getAttribute('data-maga-action-card'), '1');
    assert.equal(doc.getElementById('btn-combo-guard').hasAttribute('data-maga-action-card'), false);
    assert.equal(doc.getElementById('combo-guard-wrap').hasAttribute('data-maga-action-card'), false);
    assert.equal(doc.getElementById('btn-md-guard').hasAttribute('data-maga-action-card'), false);
    assert.equal(doc.getElementById('md-btn-wrap').hasAttribute('data-maga-action-card'), false);

    // Manual user expand on pure-tool block stays open across syncs
    const evTools = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    evTools.__testTrusted = true;
    btnTools.dispatchEvent(evTools);
    assert.equal(btnTools.getAttribute('aria-expanded'), 'true');
    mod.sync();
    assert.equal(btnTools.getAttribute('aria-expanded'), 'true', 'manual user expand on tool block stays open');

    // Simulate turn end collapsing btnTrailing from true -> false (programmatic React state update)
    btnTrailing.setAttribute('aria-expanded', 'false');
    mod.handleAriaExpandedMutation(btnTrailing);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(btnTrailing.getAttribute('aria-expanded'), 'true', 'turn-end auto-collapse snaps back open');

    // Simulate user manual click -> userToggled respected on future syncs
    const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    ev.__testTrusted = true;
    btnTrailing.dispatchEvent(ev);
    assert.equal(btnTrailing.getAttribute('aria-expanded'), 'false');
    mod.sync();
    assert.equal(btnTrailing.getAttribute('aria-expanded'), 'false', 'manual user collapse stays collapsed');

    mod.dispose();
    assert.equal(doc.querySelector('[data-ag-inline-stream]'), null);
    assert.equal(doc.querySelector('[data-ag-inline-worked]'), null);
    assert.equal(doc.querySelector('.ag-worked-inline-summary'), null);
    assert.equal(doc.querySelector('[data-maga-action-card]'), null);
  });
});

test('built user/custom.js enforces sidebar 4/8 cap with native Pinned preservation & rich project overview cards', async () => {
  const customJsSrc = readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const { JSDOM } = await import('jsdom');
  const nowSec = Math.floor(Date.now() / 1000);
  const mkProjChats = (pid, count) =>
    Array.from({ length: count }, (_, i) => [
      `${pid}-c-${i + 1}`,
      {
        annotations: { title: `${pid} Chat ${i + 1}` },
        lastModifiedTime: { seconds: nowSec - (i + 1) * 60 },
        trajectoryMetadata: { projectId: pid },
        status: i === 0 && pid === 'p-alpha' ? 2 : 1,
      },
    ]);

  const summaries = Object.fromEntries([
    ['pin-1', { annotations: { title: 'Pinned Chat', pinned: true }, lastModifiedTime: { seconds: nowSec - 5 }, status: 1 }],
    ...mkProjChats('p-alpha', 1),
    ...mkProjChats('p-maga', 10),
    ['stand-1', { annotations: { title: 'Standalone One' }, lastModifiedTime: { seconds: nowSec - 120 }, trajectoryMetadata: { projectId: 'outside-of-project' }, status: 1 }],
  ]);

  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root">
      <div class="bg-sidebar">
        <button data-testid="automations-button">Automations</button>
        <a href="/customizations">Skills</a>
        <div class="sb-grand flex-1 overflow-y-auto flex flex-col">
          <div class="sb-parent w-full relative">
            <div data-testid="conversation-list-sidebar">
              <div class="w-full relative" style="height: 300px;">
                <div data-index="0" style="position: sticky; top: 0px;"><div data-testid="section-header" data-title="Pinned">Pinned</div></div>
                <div data-index="1" style="position: absolute; transform: translateY(24px);">
                  <div data-testid="conversation-row-sidebar" data-pinned="true" data-cascade-id="pin-1"><a href="/c/pin-1">Pinned Chat</a></div>
                </div>
                <div data-index="2" style="position: absolute; transform: translateY(60px);">
                  <div data-testid="section-header"><span>Projects</span><button data-testid="sidebar-add-project-button"></button></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="antigravity.agentSidePanelInputBox"><textarea></textarea></div>
    </div></body></html>`,
    { url: 'http://127.0.0.1/', pretendToBeVisual: true, runScripts: 'outside-only' }
  );

  await withDomGlobals(dom, async () => {
    const { window } = dom;
    const doc = window.document;
    const storeState = {
      sidebarProjects: {
        projects: [
          { id: 'p-alpha', name: 'Alpha', folderUris: ['file:///tmp/alpha'], archived: false },
          { id: 'p-maga', name: 'MAGA', folderUris: ['file:///tmp/maga'], archived: false },
        ],
      },
      trajectorySummaries: {
        summaries,
        indexes: {
          pinned: ['pin-1'],
          sidebar: Object.keys(summaries).filter((k) => k !== 'pin-1'),
        },
      },
    };
    doc.querySelector('[data-testid="conversation-list-sidebar"]').firstElementChild.__reactFiber$sb = {
      memoizedProps: {
        sidebarStore: { getState: () => storeState, subscribe: () => () => {}, dispatch: () => {} },
        sidebarRouter: { state: { location: { pathname: '/' } }, navigate: () => {} },
      },
    };
    window.__agProjectCall = async (action) => {
      if (action === 'listContexts') {
        return {
          ok: true,
          contexts: {
            '/tmp/maga': { ok: true, gitBranch: 'main', instructions: '# Rules', lastModifiedMs: Date.now() },
          },
          projectMtimes: {},
        };
      }
      return { ok: true };
    };
    window.ctx = { modules: { i18n: true, claudeUxHideSidebarProjects: false, claudeUxProjects: true }, onCleanup: () => {} };
    window.eval(customJsSrc);
    await new Promise((r) => setTimeout(r, 30));

    const sbProjSec = doc.getElementById('ag-claude-sidebar-projects');
    assert.ok(sbProjSec, '#ag-claude-sidebar-projects mounted');
    const magaBlock = sbProjSec.querySelector('[data-proj-id="p-maga"]');
    assert.equal(magaBlock.querySelectorAll('.ag-sbp-row').length, 4, 'caps MAGA at 4 rows');
    assert.match(magaBlock.querySelector('[data-ag-sbp-more-proj]')?.textContent || '', /展开余下 6 条/);
    assert.equal(sbProjSec.querySelectorAll('.ag-sbp-row').length, 6, '1 Alpha + 4 MAGA + 1 standalone');

    // Expand MAGA temporarily
    magaBlock.querySelector('[data-ag-sbp-more-proj]').click();
    await new Promise((r) => setTimeout(r, 110));
    assert.equal(sbProjSec.querySelectorAll('[data-proj-id="p-maga"] .ag-sbp-row').length, 10);

    // Native Pinned stays untouched while index >= 2 is hidden
    assert.equal(doc.querySelector('.sb-parent').getAttribute('data-ag-sb-unified'), 'pinned');
    assert.equal(doc.querySelector('[data-index="1"]').hasAttribute('data-ag-sb-hide-proj'), false);
    assert.equal(doc.querySelector('[data-index="2"]').getAttribute('data-ag-sb-hide-proj'), '1');

    // Open Projects Overview and verify rich status + latest chat + AGENTS chip
    doc.getElementById('ag-claude-projects-nav-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    const ovView = doc.getElementById('ag-claude-projects-view');
    const alphaCard = ovView.querySelector('[data-ag-proj-id="p-alpha"]');
    const magaCard = ovView.querySelector('[data-ag-proj-id="p-maga"]');
    assert.equal(alphaCard.getAttribute('data-status'), 'running');
    assert.ok(alphaCard.getAttribute('data-tone'));
    assert.equal(alphaCard.querySelector('.ag-proj-card-avatar')?.textContent.trim(), 'A');
    assert.equal(magaCard.querySelector('.ag-proj-card-avatar')?.textContent.trim(), 'M');
    assert.ok(magaCard.querySelector('[data-ag-proj-usage-share="p-maga"]'));
    assert.match(alphaCard.querySelector('.ag-proj-card-status')?.textContent || '', /1 运行中/);
    assert.equal(magaCard.querySelector('.ag-proj-card-latest')?.textContent.trim(), 'p-maga Chat 1');
    assert.match(magaCard.textContent, /AGENTS/);
    assert.match(ovView.querySelector('.ag-proj-summary')?.textContent || '', /11 个对话/);
    assert.match(ovView.querySelector('.ag-proj-summary')?.textContent || '', /1 运行中/);

    window.__agClaudeUxDispose();
    assert.equal(doc.getElementById('ag-claude-sidebar-projects'), null);
  });
});
