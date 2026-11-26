import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildStudioBundle, CSS_BEGIN, CSS_END, JS_BEGIN, JS_END } from '../studio/build.mjs';
import {
  buildPickerShadowCss,
  createCapsulePickerRuntime,
  shortenEffortBadge,
  shortenModelName,
} from '../studio/modules/capsule-picker.mjs';
import { createFooterUnifiedRuntime } from '../studio/modules/footer-unified.mjs';
import { createProjectUsageRuntime } from '../studio/modules/project-usage.mjs';
import { createResumeBannerRuntime } from '../studio/modules/resume-banner.mjs';
import { clampOverlayScrollbar, createScrollbarClampRuntime } from '../studio/modules/scrollbar-clamp.mjs';
import { createSubagentFooterRuntime } from '../studio/modules/subagent-footer.mjs';
import { createUsageHistory } from '../vendor/agy-capsule/usage_history.mjs';
import { collectResumeState } from '../studio/daemon/resume-detector.mjs';
import { createStudioPrefsRuntime } from '../studio/modules/studio-prefs.mjs';
import { OWN_HOST_IDS, OWN_ATTR, setAttr, setLeafText } from '../studio/core/dom.mjs';
import { createDomFlagsFeature } from '../studio/core/dom-flags.mjs';
import { createMagaKernel } from '../studio/core/kernel.mjs';
import { renderSpeedSlots } from '../studio/core/metrics-bus.mjs';
import { syncModelPicker } from '../vendor/agy-capsule/model_picker.mjs';
import { motionThemes } from '../vendor/agy-capsule/motion_themes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOOTER_CSS_PATH = path.join(REPO, 'studio', 'styles', 'footer-capsules.css');

function hasNestedHasSelector(cssText) {
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  let idx = 0;
  while ((idx = clean.indexOf(':has(', idx)) !== -1) {
    let depth = 1;
    let pos = idx + 5;
    while (pos < clean.length && depth > 0) {
      if (clean.startsWith(':has(', pos)) return true;
      const ch = clean[pos++];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    idx += 5;
  }
  return false;
}

function makeMockDomEnv({ pathname = '/c/chat-1', lang = 'en', width = 620 } = {}) {
  const listeners = new Map();
  const makeStyle = () => {
    const map = new Map();
    return {
      setProperty: (k, v) => map.set(k, v),
      getPropertyValue: (k) => map.get(k) || '',
      display: '',
      left: '',
      bottom: '',
      top: '',
      marginLeft: '',
    };
  };

  function matchSimpleSelector(node, sel) {
    if (!node || node.nodeType !== 1) return false;
    let s = sel.trim();
    if (!s || s === '*') return true;
    const isFirstChild = s.includes(':first-child');
    if (isFirstChild) {
      s = s.replace(/:first-child/g, '');
      if (!node.parentElement || node.parentElement.children[0] !== node) return false;
    }
    const isFirstOfType = s.includes(':first-of-type');
    if (isFirstOfType) {
      s = s.replace(/:first-of-type/g, '');
      if (!node.parentElement) return false;
      const same = node.parentElement.children.filter((c) => c.tagName === node.tagName);
      if (same[0] !== node) return false;
    }
    const attrs = [];
    s = s.replace(/\[([^=\]]+)(?:="([^"]*)")?\]/g, (_, k, v) => {
      attrs.push([k, v]);
      return '';
    });
    const ids = [];
    s = s.replace(/#([A-Za-z0-9_\\-]+)/g, (_, id) => {
      ids.push(id.replace(/\\/g, ''));
      return '';
    });
    const classes = [];
    s = s.replace(/\.([A-Za-z0-9_-]+)/g, (_, cls) => {
      classes.push(cls);
      return '';
    });
    const tag = s.trim();
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const id of ids) if (node.id !== id) return false;
    const nodeCls = (node.className || '').split(/\s+/).filter(Boolean);
    for (const cls of classes) if (!nodeCls.includes(cls)) return false;
    for (const [k, v] of attrs) {
      const val = node.getAttribute(k);
      if (v !== undefined ? val !== v : val === null) return false;
    }
    return true;
  }

  function matchComplexSelector(node, sel, scopeRoot) {
    const tokens = sel.trim().split(/\s+/);
    if (!tokens.length) return false;
    let cur = node;
    let i = tokens.length - 1;
    if (!matchSimpleSelector(cur, tokens[i])) return false;
    i -= 1;
    while (i >= 0) {
      const tok = tokens[i];
      if (tok === '>') {
        i -= 1;
        const parentSel = tokens[i];
        if (parentSel === ':scope') return cur.parentElement === scopeRoot;
        cur = cur.parentElement;
        if (!cur || !matchSimpleSelector(cur, parentSel)) return false;
        i -= 1;
      } else {
        let p = cur.parentElement;
        let found = null;
        while (p) {
          if (tok === ':scope' ? p === scopeRoot : matchSimpleSelector(p, tok)) {
            found = p;
            break;
          }
          p = p.parentElement;
        }
        if (!found) return false;
        cur = found;
        i -= 1;
      }
    }
    return true;
  }

  function createEl(tag = 'div') {
    const attrs = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      parentElement: null,
      children,
      style: makeStyle(),
      dataset: {},
      className: '',
      id: '',
      title: '',
      hidden: false,
      disabled: false,
      _text: '',
      _html: '',
      _listeners: new Map(),
      get classList() {
        return {
          add: (...cls) => {
            const set = new Set((el.className || '').split(/\s+/).filter(Boolean));
            cls.forEach((c) => set.add(c));
            el.className = Array.from(set).join(' ');
          },
          contains: (c) => (el.className || '').split(/\s+/).includes(c),
        };
      },
      get textContent() {
        if (children.length === 0) return el._text;
        return children.map((c) => c.textContent).join('');
      },
      set textContent(v) {
        children.length = 0;
        el._text = String(v ?? '');
      },
      get innerHTML() {
        return el._html;
      },
      set innerHTML(v) {
        children.length = 0;
        el._html = String(v ?? '');
      },
      get firstChild() {
        return children[0] || null;
      },
      get nextElementSibling() {
        if (!el.parentElement) return null;
        const sibs = el.parentElement.children;
        const idx = sibs.indexOf(el);
        return idx >= 0 && idx + 1 < sibs.length ? sibs[idx + 1] : null;
      },
      get isConnected() {
        return true;
      },
      setAttribute(k, v) {
        const s = String(v);
        attrs.set(k, s);
        if (k === 'id') el.id = s;
        if (k === 'class') el.className = s;
        if (k === 'title') el.title = s;
        if (k.startsWith('data-')) {
          const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
          el.dataset[camel] = s;
        }
      },
      getAttribute(k) {
        if (k === 'id' && el.id) return el.id;
        if (k === 'class' && el.className) return el.className;
        if (k === 'title' && el.title) return el.title;
        return attrs.has(k) ? attrs.get(k) : null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      append(...nodes) {
        for (const n of nodes) {
          if (n && typeof n === 'object') {
            n.parentElement = el;
            children.push(n);
          }
        }
      },
      appendChild(n) {
        el.append(n);
        return n;
      },
      insertBefore(n, ref) {
        n.parentElement = el;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, n);
        else children.push(n);
        return n;
      },
      insertAdjacentElement(pos, n) {
        if (!el.parentElement) return;
        const sibs = el.parentElement.children;
        const idx = sibs.indexOf(el);
        n.parentElement = el.parentElement;
        if (pos === 'afterend' && idx >= 0) sibs.splice(idx + 1, 0, n);
        else if (pos === 'beforebegin' && idx >= 0) sibs.splice(idx, 0, n);
        else sibs.push(n);
      },
      insertAdjacentHTML() {},
      replaceChildren(...nodes) {
        children.length = 0;
        el.append(...nodes);
      },
      prepend(...nodes) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i];
          n.parentElement = el;
          children.unshift(n);
        }
      },
      remove() {
        if (!el.parentElement) return;
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
      },
      contains(target) {
        if (target === el) return true;
        return children.some((c) => c.contains?.(target));
      },
      closest(sel) {
        const list = sel.split(',').map((s) => s.trim()).filter(Boolean);
        let cur = el;
        while (cur) {
          if (list.some((s) => matchComplexSelector(cur, s, docEl))) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      matches(sel) {
        return sel.split(',').some((s) => matchComplexSelector(el, s.trim(), docEl));
      },
      addEventListener(type, fn) {
        if (!el._listeners.has(type)) el._listeners.set(type, []);
        el._listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = el._listeners.get(type);
        if (arr) {
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        }
      },
      click() {
        for (const fn of el._listeners.get('click') || []) {
          fn({ preventDefault() {}, stopPropagation() {}, target: el });
        }
      },
      getBoundingClientRect() {
        return { width, height: 30, top: 100, left: 10, right: 10 + width, bottom: 130 };
      },
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const selectors = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const walk = (root) => {
          for (const ch of root.children) {
            if (selectors.some((s) => matchComplexSelector(ch, s, el))) {
              out.push(ch);
            }
            walk(ch);
          }
        };
        walk(el);
        return out;
      },
    };
    return el;
  }

  const docEl = createEl('html');
  docEl.lang = lang;
  docEl.setAttribute('data-ag-ux-lang', lang);
  const body = createEl('body');
  const head = createEl('head');
  docEl.append(head, body);

  const findById = (root, id) => {
    for (const ch of root.children) {
      if (ch.id === id) return ch;
      const hit = findById(ch, id);
      if (hit) return hit;
    }
    return null;
  };

  const doc = {
    documentElement: docEl,
    head,
    body,
    createElement: (tag) => createEl(tag),
    getElementById: (id) => findById(docEl, id),
    querySelector: (sel) => docEl.querySelector(sel),
    querySelectorAll: (sel) => docEl.querySelectorAll(sel),
    addEventListener: (t, fn) => {
      if (!listeners.has(t)) listeners.set(t, []);
      listeners.get(t).push(fn);
    },
    removeEventListener: () => {},
  };

  const win = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };

  return {
    createEl,
    doc,
    win,
    loc: { pathname, search: '', href: `http://127.0.0.1${pathname}`, hash: '' },
  };
}

async function withGlobals(mockEnv, fn) {
  const keys = [
    'document',
    'window',
    'location',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'ResizeObserver',
    'MutationObserver',
    'getComputedStyle',
    'innerWidth',
    'innerHeight',
  ];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.document = mockEnv.doc;
  globalThis.window = mockEnv.win;
  globalThis.location = mockEnv.loc;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = undefined;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
  globalThis.getComputedStyle = () => ({ display: 'flex' });
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }
}

test('buildStudioBundle compiles clean JS and complete CSS bundle', async () => {
  const { jsBlock, cssBlock, prefs } = await buildStudioBundle();
  assert.equal(prefs.modelEffortPicker, true);
  assert.ok(jsBlock.startsWith(JS_BEGIN));
  assert.ok(jsBlock.trimEnd().endsWith(JS_END));
  assert.ok(cssBlock.startsWith(CSS_BEGIN));
  assert.ok(cssBlock.trimEnd().endsWith(CSS_END));

  // Verify JS syntax compiles cleanly
  assert.doesNotThrow(() => new Function('ctx', jsBlock));

  // Verify esbuild output retains MagaKernel self-trigger draining, data-maga-own filter & hidden guard
  assert.match(jsBlock, /finally\s*\{\s*docObs\?\.takeRecords\?\.\(\);\s*\}/);
  assert.match(jsBlock, /OWN_ATTR\s*=\s*["']data-maga-own["']/);
  assert.match(jsBlock, /document\.hidden/);
  assert.match(jsBlock, /createMagaKernel/);
  assert.match(jsBlock, /createSubagentFooterRuntime\(/);

  // Verify all 5 style files are bundled
  for (const name of ['typography.css', 'footer-capsules.css', 'quota-popover.css', 'overview-usage.css', 'studio-settings.css']) {
    assert.ok(cssBlock.includes(`/* --- studio/styles/${name} --- */`), `Missing ${name}`);
  }
});

test('shortenModelName and shortenEffortBadge handle edge cases cleanly', () => {
  assert.equal(shortenModelName('Orchestrator', false), 'Orch');
  assert.equal(shortenModelName('Orchestrator', true), '路由');
  assert.equal(shortenModelName('Gemini 4 Neon'), 'Neon');
  assert.equal(shortenModelName('Google Gemini 3.1 Pro'), 'Pro');
  assert.equal(shortenModelName('Claude 4.5 Sonnet'), 'Sonnet');
  assert.equal(shortenModelName('OpenAI o3'), 'o3');

  assert.equal(shortenEffortBadge('Claude 4.5 Sonnet High'), 'Sonnet High');
  assert.equal(shortenEffortBadge('Claude Sonnet 4.5 Medium'), 'Sonnet Med');
  assert.equal(shortenEffortBadge('Claude Opus 4.6'), 'Opus');
  assert.equal(shortenEffortBadge('Gemini 4 Neon Extra High'), 'Neon XHigh');
  assert.equal(shortenEffortBadge('Minimal'), 'Min');
  assert.equal(shortenEffortBadge('Medium'), 'Med');
  assert.equal(shortenEffortBadge('Extra High'), 'XHigh');
});

test('buildPickerShadowCss uses inline-block on effort badges so ellipsis works', () => {
  const css = buildPickerShadowCss({ effortBarCss: '', agentEntryCss: '' });
  const ruleBlocks = css.match(/[^{}]+\{[^{}]*\}/g) || [];
  const effortBlocks = ruleBlocks.filter((blk) => {
    const sel = blk.slice(0, blk.indexOf('{'));
    return sel.includes('.dk-mp-effort') || sel.includes('.agy-mp-effort-short');
  });
  assert.ok(effortBlocks.length >= 4, 'Expected effort badge CSS rules');
  for (const blk of effortBlocks) {
    assert.ok(!/display:\s*inline-flex\b/.test(blk), `Unexpected inline-flex in: ${blk}`);
  }
  assert.match(css, /\.dk-mp-effort[\s\S]*?display:\s*inline-block;/);
  assert.match(css, /vertical-align:\s*middle;/);
  assert.match(css, /line-height:\s*17px;/);
  assert.match(css, /text-overflow:\s*ellipsis;/);
});

test('footer-capsules.css hides subagent sidebar without nested :has() and defines pure CSS 4-tier rules', () => {
  const css = readFileSync(FOOTER_CSS_PATH, 'utf8');
  assert.equal(hasNestedHasSelector(css), false, 'Nested :has() is invalid CSS');

  // Direct hide selector + flex/width fallback for conversation container
  assert.ok(css.includes('[data-testid="aux-pane-split"] > div:last-child [data-testid="subagent-tab-sidebar"]'));
  assert.ok(css.includes('[data-testid="subagent-tab-conversation"]'));
  assert.match(
    css,
    /\[data-testid="aux-pane-split"\]\s*>\s*div:last-child\s+\[data-testid="subagent-tab-conversation"\][\s\S]*?flex:\s*1 1 0%\s*!important;[\s\S]*?min-width:\s*0\s*!important;[\s\S]*?width:\s*100%\s*!important;[\s\S]*?max-width:\s*100%\s*!important;/
  );

  // Main Context Capsule pure CSS 4-tier spans & icon collapse
  assert.ok(css.includes('.agy-ctx-full'));
  assert.ok(css.includes('.agy-ctx-tight'));
  assert.ok(css.includes('[data-agy-ctx-compacting="1"]'));

  // Subagent 3 capsules pure CSS 4-tier compression (20em/15em/11em/8em + 26px icon collapse)
  for (const [tier, mw] of [
    ['full', '20em'],
    ['compact', '15em'],
    ['tight', '11em'],
    ['icon', '8em'],
  ]) {
    assert.match(
      css,
      new RegExp(`data-agy-dock-tier="${tier}"[\\s\\S]*?\\.agy-sub-model[\\s\\S]*?max-width:\\s*${mw}`),
      `Missing ${tier} max-width ${mw}`
    );
  }
  assert.ok(css.includes('.agy-sub-mname-full'));
  assert.ok(css.includes('.agy-sub-mname-short'));
  assert.ok(css.includes('.agy-sub-ctx-full'));
  assert.ok(css.includes('.agy-sub-ctx-pct'));
  assert.ok(css.includes('.agy-sub-spd-full'));
  assert.ok(css.includes('.agy-sub-spd-tight'));
  assert.ok(css.includes('.agy-sub-spd-sep'));
  assert.ok(css.includes('.agy-sub-spd-ttft'));
  assert.ok(css.includes('[data-agy-sub-state="ended"]'));
  assert.ok(css.includes('.agy-sub-menu-sep'));
  assert.ok(css.includes('max-height: min(280px, 55vh)'));
});

test('footer-unified maintains pure CSS context spans and caches layout signature in WeakMap', async () => {
  const env = makeMockDomEnv({ pathname: '/c/conv-1', width: 620 });
  await withGlobals(env, () => {
    const footer = env.createEl('div');
    footer.className = 'agy-composer-footer';
    const leftGroup = env.createEl('div');
    const addBtn = env.createEl('button');
    const ring = env.createEl('button');
    ring.id = 'ag-claude-ctx-ring';
    ring.title = 'Context 4.8k / 512k (12%)';
    leftGroup.append(addBtn, ring);
    footer.append(leftGroup);
    env.doc.body.append(footer);

    let ringRectCalls = 0;
    ring.getBoundingClientRect = () => {
      ringRectCalls += 1;
      return { width: 70, height: 26, top: 100, left: 20, right: 90, bottom: 126 };
    };

    const rt = createFooterUnifiedRuntime();
    rt.sync();

    assert.equal(ring.getAttribute('data-agy-ctx-compacting'), '0');
    assert.equal(ring.getAttribute('data-agy-has-ratio'), 'true');
    assert.equal(ring.querySelector('.agy-ctx-full')?.textContent, '4.8k / 512k');
    assert.equal(ring.querySelector('.agy-ctx-tight')?.textContent, '12%');
    assert.equal(footer.getAttribute('data-agy-dock-tier'), 'full');
    assert.ok(ringRectCalls >= 1);

    const callsAfterFirst = ringRectCalls;
    rt.sync();
    assert.equal(ringRectCalls, callsAfterFirst, 'WeakMap signature cache should skip re-measuring on idle sync');

    // Compacting state flips attributes cleanly without dockTier dependence
    ring.setAttribute('data-compact-state', 'compacting');
    rt.sync();
    assert.equal(ring.getAttribute('data-agy-ctx-compacting'), '1');
    assert.equal(ring.querySelector('.agy-ctx-full')?.textContent, 'Compacting…');
    assert.equal(ring.querySelector('.agy-ctx-tight')?.textContent, '');
    rt.dispose();
  });
});

test('subagent-footer isolates routes, shows ended historical pill + sectioned menu, and emits tier-agnostic pills', async () => {
  const env = makeMockDomEnv({ pathname: '/c/conv-a', width: 520 });
  await withGlobals(env, async () => {
    const convView = env.createEl('div');
    convView.setAttribute('data-testid', 'conversation-view');
    const mainBox = env.createEl('div');
    mainBox.id = 'antigravity.agentSidePanelInputBox';
    const mainFooter = env.createEl('div');
    mainFooter.className = 'agy-composer-footer';
    const mainLeft = env.createEl('div');
    mainLeft.append(env.createEl('button'));
    mainFooter.append(mainLeft);
    mainBox.append(mainFooter);
    convView.append(mainBox);

    const subComp = env.createEl('div');
    subComp.setAttribute('data-testid', 'subagent-tab-composer');
    const subFooter = env.createEl('div');
    subFooter.className = 'agy-composer-footer';
    subFooter.setAttribute('data-agy-dock-tier', 'compact');
    const subLeft = env.createEl('div');
    subLeft.append(env.createEl('button'));
    subFooter.append(subLeft);
    subComp.append(subFooter);
    env.doc.body.append(convView, subComp);

    // Route isolation: stale metrics from another chat must not render a pill
    env.win.__ag_last_metrics = {
      cascadeId: 'conv-other',
      stats: { children: [{ id: 'sub-1', agentName: 'Explorer', running: true }] },
    };
    const rt = createSubagentFooterRuntime({ motionThemes, shortenModelName, shortenEffortBadge });
    rt.sync();
    assert.equal(env.doc.getElementById('agy-main-subagent-pill'), null);

    // Matching route with only ended/killed children -> neutral ended capsule + sectioned menu
    env.win.__ag_last_metrics = {
      cascadeId: 'conv-a',
      stats: {
        children: [
          { id: 'sub-1', agentName: 'Explorer', running: false, killed: true },
          { id: 'sub-2', agentName: 'Reviewer', running: false, killed: true },
        ],
      },
    };
    rt.sync();
    const pill = env.doc.getElementById('agy-main-subagent-pill');
    assert.ok(pill, 'Expected neutral historical subagent pill when all sessions ended');
    assert.equal(pill.getAttribute('data-agy-sub-state'), 'ended');
    pill.click();
    const menu = env.doc.getElementById('agy-subagent-menu');
    assert.ok(menu && menu.getAttribute('data-open') === '1');
    assert.ok(menu.innerHTML.includes('agy-sub-menu-sep'), 'Expected History group separator');

    // Side-panel 3 capsules emit tier-agnostic spans without data-agy-icon-only
    env.loc.search = '?tab=subagent_convo__sub-1';
    env.win.__agProjectCall = async () => ({
      ok: true,
      hasData: true,
      modelName: 'Claude 4.5 Sonnet',
      effort: 'Claude 4.5 Sonnet High',
      contextTokens: 24000,
      maxContextTokens: 200000,
      pct: 12,
      tps: 92,
      ttft: 1.4,
      running: true,
    });

    rt.sync();
    await new Promise((r) => setTimeout(r, 15));
    const mPill = subLeft.querySelector('[data-agy-sub-pill="model"]');
    const cPill = subLeft.querySelector('[data-agy-sub-pill="ctx"]');
    const sPill = subLeft.querySelector('[data-agy-sub-pill="speed"]');
    assert.ok(mPill && cPill && sPill);
    assert.equal(mPill.getAttribute('data-agy-icon-only'), null);
    assert.equal(cPill.getAttribute('data-agy-icon-only'), null);
    assert.equal(sPill.getAttribute('data-agy-icon-only'), null);
    assert.ok(mPill.innerHTML.includes('agy-sub-mname-full'));
    assert.ok(mPill.innerHTML.includes('agy-sub-mname-short'));
    assert.ok(mPill.innerHTML.includes('>Sonnet High<'));
    assert.ok(cPill.innerHTML.includes('agy-sub-ctx-full'));
    assert.ok(cPill.innerHTML.includes('agy-sub-ctx-pct'));
    assert.ok(sPill.innerHTML.includes('agy-sub-spd-full'));
    assert.ok(sPill.innerHTML.includes('agy-sub-spd-tight'));
    assert.ok(sPill.innerHTML.includes('agy-sub-spd-sep'));
    assert.ok(sPill.innerHTML.includes('agy-sub-spd-ttft'));
    rt.dispose();
  });
});

test('model_picker and decorateModelCapsule preserve clean aria-label and wrap plain single-tier labels', async () => {
  const modelPickerSrc = readFileSync(path.join(REPO, 'vendor', 'agy-capsule', 'model_picker.mjs'), 'utf8');
  // Assert refresh() no longer reads .dk-mp-text.textContent and !match wraps in .dk-mp-name
  assert.ok(!modelPickerSrc.includes("button.querySelector('.dk-mp-text').textContent"));
  assert.match(modelPickerSrc, /else if \(!match\) \{[\s\S]*?nameEl\.className = 'dk-mp-name';[\s\S]*?textWrap\.append\(nameEl\);/);

  // Exercise decorateModelCapsule plain-text fallback & aria-hidden / clean aria-label
  const env = makeMockDomEnv({ pathname: '/c/conv-1', lang: 'en', width: 620 });
  await withGlobals(env, () => {
    const convView = env.createEl('div');
    convView.setAttribute('data-testid', 'conversation-view');
    const footer = env.createEl('div');
    footer.className = 'agy-composer-footer';
    const leftGroup = env.createEl('div');
    const triggerWrap = env.createEl('div');
    const trigger = env.createEl('button');
    trigger.setAttribute('data-testid', 'model-selector-trigger');
    triggerWrap.append(trigger);
    leftGroup.append(triggerWrap);
    footer.append(leftGroup);
    convView.append(footer);
    env.doc.body.append(convView);

    const picker = createCapsulePickerRuntime({
      prefs: { modelEffortPicker: true },
      labelsByLang: {
        en: { modelEffortPicker: 'Enhanced model capsule' },
        'zh-CN': { modelEffortPicker: '优化模型胶囊' },
      },
      shadowCss: '',
      syncModelPicker: (root) => {
        if (!root.querySelector('button.dk-pill[data-el="modelPicker"]')) {
          const btn = env.createEl('button');
          btn.className = 'dk-pill';
          btn.setAttribute('data-el', 'modelPicker');
          const tw = env.createEl('span');
          tw.className = 'dk-mp-text';
          tw.textContent = 'OpenAI GPT-4o';
          btn.append(tw);
          root.append(btn);
        }
      },
      effortEffects: () => ({ applySidecarPrefs() {} }),
      motionThemes,
      shortenModelName,
      shortenEffortBadge,
    });

    // Make leftGroup & host visible to findEligibleFooterLefts
    leftGroup.checkVisibility = () => true;
    footer.checkVisibility = () => true;
    leftGroup.attachShadow = undefined;

    // Provide attachShadow + shadowRoot query support for hostEl
    const origCreate = env.doc.createElement;
    env.doc.createElement = (tag) => {
      const el = origCreate(tag);
      el.attachShadow = () => {
        const sr = origCreate('shadow-root');
        sr.getElementById = (id) => sr.querySelector(`#${id}`);
        el.shadowRoot = sr;
        return sr;
      };
      return el;
    };

    picker.sync(() => {});
    const host = leftGroup.querySelector('[data-agy-picker-host="1"]');
    assert.ok(host?.shadowRoot, 'Expected shadow host mounted');
    const btn = host.shadowRoot.querySelector('button.dk-pill[data-el="modelPicker"]');
    const nameEl = btn.querySelector('.dk-mp-name');
    const shortEl = btn.querySelector('.agy-mp-short');
    assert.equal(nameEl?.textContent, 'OpenAI GPT-4o');
    assert.equal(shortEl?.textContent, 'GPT-4o');
    assert.equal(shortEl?.getAttribute('aria-hidden'), 'true');
    assert.equal(btn.getAttribute('aria-label'), 'Enhanced model capsule: OpenAI GPT-4o');
    picker.dispose();
  });

  // Ensure syncModelPicker import stays used/valid
  assert.equal(typeof syncModelPicker, 'function');
});

test('capsule-picker avoids redundant style writes, marks data-agy-model-wrap, and skips idle sync', async () => {
  const env = makeMockDomEnv({ pathname: '/c/conv-opt', lang: 'en', width: 620 });
  await withGlobals(env, () => {
    const convView = env.createEl('div');
    convView.setAttribute('data-testid', 'conversation-view');
    const footer = env.createEl('div');
    footer.className = 'agy-composer-footer';
    footer.setAttribute('data-agy-has-row2', 'true');
    const leftGroup = env.createEl('div');
    const triggerWrap = env.createEl('div');
    const trigger = env.createEl('button');
    trigger.setAttribute('data-testid', 'model-selector-trigger');
    trigger.textContent = 'Gemini 4 Neon High';
    triggerWrap.append(trigger);
    leftGroup.append(triggerWrap);
    footer.append(leftGroup);
    convView.append(footer);
    env.doc.body.append(convView);

    leftGroup.checkVisibility = () => true;
    footer.checkVisibility = () => true;

    let styleSetCount = 0;
    let pickerSyncCalls = 0;
    const origCreate = env.doc.createElement;
    env.doc.createElement = (tag) => {
      const el = origCreate(tag);
      if (tag === 'style') {
        let cssVal = '';
        Object.defineProperty(el, 'textContent', {
          get() { return cssVal; },
          set(v) {
            styleSetCount += 1;
            cssVal = String(v ?? '');
          },
          configurable: true,
        });
      }
      el.attachShadow = () => {
        const sr = origCreate('shadow-root');
        sr.getElementById = (id) => sr.querySelector(`#${id}`);
        el.shadowRoot = sr;
        return sr;
      };
      return el;
    };

    const picker = createCapsulePickerRuntime({
      prefs: { modelEffortPicker: true },
      labelsByLang: {
        en: { modelEffortPicker: 'Enhanced model capsule' },
        'zh-CN': { modelEffortPicker: '优化模型胶囊' },
      },
      shadowCss: '',
      syncModelPicker: (root) => {
        pickerSyncCalls += 1;
        root._modelPicker = {
          setBubble() {},
          dispose() { delete root._modelPicker; },
        };
        if (!root.querySelector('button.dk-pill[data-el="modelPicker"]')) {
          const btn = origCreate('button');
          btn.className = 'dk-pill';
          btn.setAttribute('data-el', 'modelPicker');
          const tw = origCreate('span');
          tw.className = 'dk-mp-text';
          tw.textContent = trigger.textContent;
          btn.append(tw);
          root.append(btn);
        }
      },
      effortEffects: () => ({ applySidecarPrefs() {} }),
      motionThemes,
      shortenModelName,
      shortenEffortBadge,
    });

    picker.sync(() => {});
    assert.equal(styleSetCount, 2, 'Expected 1 native layout style + 1 shadow style write');
    assert.equal(pickerSyncCalls, 1);
    assert.equal(triggerWrap.getAttribute('data-agy-model-wrap'), '1');

    // Repeated idle syncs skip rewriting native <style> and skip calling syncModelPicker
    picker.sync(() => {});
    picker.sync(() => {});
    assert.equal(styleSetCount, 2);
    assert.equal(pickerSyncCalls, 1);

    // Label change invalidates dirty cache immediately
    trigger.textContent = 'Claude 4.5 Sonnet Medium';
    picker.sync(() => {});
    assert.equal(pickerSyncCalls, 2);

    picker.dispose();
    assert.equal(triggerWrap.getAttribute('data-agy-model-wrap'), null);
  });
});

test('footer-capsules.css uses pure GPU composited animations and eliminates footer :has() wrap probe', () => {
  const css = readFileSync(FOOTER_CSS_PATH, 'utf8');
  assert.equal(css.includes(':has(button[data-deck-model-bubble="hidden"])'), false);
  assert.ok(css.includes('[data-agy-model-wrap="1"]'));

  const speedBlock = css.match(/@keyframes\s+agySpeedBreathe\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(speedBlock.length > 0, 'Missing @keyframes agySpeedBreathe');
  assert.equal(speedBlock.includes('box-shadow'), false, 'agySpeedBreathe must not animate box-shadow');

  const critBlock = css.match(/@keyframes\s+agyCtxCritRing\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(critBlock.length > 0, 'Missing @keyframes agyCtxCritRing');
  assert.equal(critBlock.includes('box-shadow'), false, 'agyCtxCritRing must stay GPU transform/opacity only');
});

test('resume-banner marks resumed steps and caches plain messages across syncs', async () => {
  const env = makeMockDomEnv({ pathname: '/c/conv-res', lang: 'en', width: 520 });
  await withGlobals(env, () => {
    const view = env.createEl('div');
    view.setAttribute('data-testid', 'conversation-view');

    const normalStep = env.createEl('div');
    normalStep.setAttribute('data-testid', 'user-input-step');
    const normalContent = env.createEl('div');
    normalContent.setAttribute('data-testid', 'user-message-content');
    let normalReads = 0;
    Object.defineProperty(normalContent, 'textContent', {
      get() {
        normalReads += 1;
        return 'Optimize performance smoothly';
      },
    });
    normalStep.append(normalContent);

    const resumedStep = env.createEl('div');
    resumedStep.setAttribute('data-testid', 'user-input-step');
    const resumedContent = env.createEl('div');
    resumedContent.setAttribute('data-testid', 'user-message-content');
    resumedContent.textContent = '\u2063\u200B\u2063Please resume from where the task was interrupted';
    resumedStep.append(resumedContent);

    view.append(normalStep, resumedStep);
    env.doc.body.append(view);

    const rt = createResumeBannerRuntime();
    rt.sync();
    assert.equal(normalReads, 1);
    assert.equal(resumedStep.getAttribute('data-agy-resumed-step'), '1');

    rt.sync();
    rt.sync();
    assert.equal(normalReads, 1, 'Plain user steps should not be re-scanned on subsequent syncs');
    rt.dispose();
  });
});

test('resume-detector reads idle SQLite DB with immutable=1 and leaves zero WAL/SHM sidecars', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-resume-det-'));
  const cid = 'conv_immutable_test_01';
  const dbPath = path.join(dir, `${cid}.db`);
  try {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB);');
    db.exec("INSERT INTO steps (idx, step_type, status, error_details) VALUES (1, 132, 3, X'');");
    db.close();

    const res = collectResumeState({ cascadeId: cid }, { conversationsDir: dir });
    assert.equal(res.ok, true);
    assert.equal(res.interrupted, true);
    assert.equal(res.reason, 'mid_tool');
    assert.equal(existsSync(`${dbPath}-wal`), false, 'Idle DB read must not create -wal');
    assert.equal(existsSync(`${dbPath}-shm`), false, 'Idle DB read must not create -shm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('footer-capsules.css scopes aux min-width outside active split transitions and styles panel handoff', () => {
  const css = readFileSync(FOOTER_CSS_PATH, 'utf8');
  assert.equal(hasNestedHasSelector(css), false, 'Nested :has() is invalid CSS');

  assert.ok(css.includes('[data-testid="aux-pane-split"]:not([data-split-transition]) > div:last-child:not([style*="width: 0px"])'));
  assert.ok(css.includes('[data-testid="aux-pane-split"][data-split-transition="closing"] > div:last-child > div:first-child'));
  assert.ok(css.includes('@keyframes agyAuxReveal'));
  assert.ok(css.includes('@keyframes agySubSwapIn'));
  assert.ok(css.includes('html[data-agy-panel-handoff="ov-to-aux-closing"] .animate-overview-panel'));
  assert.ok(css.includes('html[data-agy-panel-handoff="ov-to-aux-opening"] .animate-overview-panel'));
  assert.ok(css.includes('--agy-hold-ov-reserve'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
});

test('subagent-footer choreographs Overview <-> Aux transitions and pre-arms 50/50 split cleanly', async () => {
  const env = makeMockDomEnv({ pathname: '/c/conv-handoff', lang: 'en', width: 620 });

  // Local capture-phase click dispatch wrapper so we can verify e.stopPropagation() cleanly
  const docClickHandlers = [];
  const origDocAdd = env.doc.addEventListener;
  env.doc.addEventListener = (t, fn, opts) => {
    if (t === 'click') docClickHandlers.push({ fn, capture: Boolean(opts === true || opts?.capture) });
    origDocAdd(t, fn, opts);
  };
  env.doc.removeEventListener = (t, fn) => {
    if (t === 'click') {
      const idx = docClickHandlers.findIndex((h) => h.fn === fn);
      if (idx >= 0) docClickHandlers.splice(idx, 1);
    }
  };
  const dispatchUserClick = (target) => {
    let stopped = false;
    const ev = {
      target,
      preventDefault() {},
      stopPropagation() { stopped = true; },
    };
    for (const h of docClickHandlers) {
      if (h.capture) h.fn(ev);
    }
    if (!stopped) target.click();
  };

  await withGlobals(env, async () => {
    const extraKeys = ['history', 'PopStateEvent', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const prevExtra = new Map(extraKeys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.PopStateEvent = class { constructor(type, init) { this.type = type; this.state = init?.state; } };
    globalThis.history = {
      state: null,
      pushState(_st, _t, urlStr) {
        const u = new URL(urlStr, 'http://127.0.0.1');
        env.loc.pathname = u.pathname;
        env.loc.search = u.search;
        env.loc.href = u.href;
      },
    };

    try {
      const convView = env.createEl('div');
      convView.setAttribute('data-testid', 'conversation-view');
      const mainBox = env.createEl('div');
      mainBox.id = 'antigravity.agentSidePanelInputBox';
      const mainFooter = env.createEl('div');
      mainFooter.className = 'agy-composer-footer';
      const mainLeft = env.createEl('div');
      mainLeft.append(env.createEl('button'));
      mainFooter.append(mainLeft);
      mainBox.append(mainFooter);
      convView.append(mainBox);

      const ovHost = env.createEl('div');
      ovHost.setAttribute('data-testid', 'overview-panel-host');
      ovHost.style.setProperty('--overview-panel-reserve', '336px');
      ovHost.style.setProperty('--overview-panel-gutter-reserve', '0px');

      const split = env.createEl('div');
      split.setAttribute('data-testid', 'aux-pane-split');
      let resizeCalls = [];
      let dragEndCalls = 0;
      const fiberProps = {
        sidePanelWidth: 50,
        auxPaneWidthUnit: '%',
        onResize: (w) => {
          resizeCalls.push(w);
          fiberProps.sidePanelWidth = w;
        },
        onDragEnd: () => { dragEndCalls += 1; },
      };
      split['__reactFiber$mock'] = { memoizedProps: fiberProps, return: null };

      const auxBtn = env.createEl('button');
      auxBtn.setAttribute('data-testid', 'toggle-aux-sidebar');
      auxBtn.setAttribute('aria-expanded', 'false');
      let auxClicks = 0;
      auxBtn.addEventListener('click', () => {
        auxClicks += 1;
        const open = auxBtn.getAttribute('aria-expanded') === 'true';
        auxBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
      });

      const ovBtn = env.createEl('button');
      ovBtn.setAttribute('data-testid', 'toggle-overview-panel');
      ovBtn.setAttribute('aria-pressed', 'true');
      let ovClicks = 0;
      ovBtn.addEventListener('click', () => {
        ovClicks += 1;
        const open = ovBtn.getAttribute('aria-pressed') === 'true';
        ovBtn.setAttribute('aria-pressed', open ? 'false' : 'true');
      });

      env.doc.body.append(convView, ovHost, split, auxBtn, ovBtn);
      env.win.__ag_last_metrics = {
        cascadeId: 'conv-handoff',
        stats: { children: [{ id: 'sub-1', agentName: 'Explorer', running: true }] },
      };

      const rt = createSubagentFooterRuntime({ motionThemes, shortenModelName, shortenEffortBadge });
      rt.sync();

      // Side panel already 50% -> initial pre-arm skips redundant onResize and never touches onDragEnd
      assert.equal(resizeCalls.length, 0);
      assert.equal(dragEndCalls, 0);

      // Scenario A: Open subagent from footer pill while Overview is open -> staggered 2-phase handoff
      const pill = env.doc.getElementById('agy-main-subagent-pill');
      assert.ok(pill);
      pill.click();

      assert.equal(env.doc.documentElement.getAttribute('data-agy-panel-handoff'), 'ov-to-aux-closing');
      assert.equal(env.doc.documentElement.style.getPropertyValue('--agy-hold-ov-reserve'), '336px');
      assert.equal(ovClicks, 1, 'Overview should start closing immediately in phase 1');
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'false');
      assert.equal(auxClicks, 0, 'Aux panel must wait until phase 2 (~120ms) before opening');
      assert.equal(dragEndCalls, 0);
      assert.equal(resizeCalls.length, 0);

      await new Promise((r) => setTimeout(r, 150));
      assert.equal(env.doc.documentElement.getAttribute('data-agy-panel-handoff'), 'ov-to-aux-opening');
      assert.equal(env.loc.search, '?tab=subagent_convo__sub-1');
      assert.equal(auxClicks, 1);
      assert.equal(auxBtn.getAttribute('aria-expanded'), 'true');
      assert.equal(dragEndCalls, 0);
      assert.equal(resizeCalls.length, 0);

      // Wait for phase 2 handoff state cleanup (~640ms total -> wait another 530ms)
      await new Promise((r) => setTimeout(r, 530));
      assert.equal(env.doc.documentElement.getAttribute('data-agy-panel-handoff'), null);

      // Scenario B: Aux is open -> user clicks Overview toggle -> capture intercepts and closes Aux first
      const ovClicksBefore = ovClicks;
      const auxClicksBefore = auxClicks;
      dispatchUserClick(ovBtn);
      assert.equal(ovClicks, ovClicksBefore, 'Overview click must be intercepted while Aux is open');
      assert.equal(auxClicks, auxClicksBefore + 1, 'Aux must start closing immediately');
      assert.equal(auxBtn.getAttribute('aria-expanded'), 'false');

      await new Promise((r) => setTimeout(r, 270));
      assert.equal(ovClicks, ovClicksBefore + 1, 'Overview click replays smoothly after Aux exits');
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'true');

      rt.dispose();

      // Scenario C: Non-50% sidePanelWidth pre-arms cleanly when both panels are closed
      fiberProps.sidePanelWidth = 34;
      ovBtn.setAttribute('aria-pressed', 'false');
      auxBtn.setAttribute('aria-expanded', 'false');
      const rt2 = createSubagentFooterRuntime({ motionThemes, shortenModelName, shortenEffortBadge });
      rt2.sync();
      assert.deepEqual(resizeCalls, [50]);
      assert.equal(dragEndCalls, 0);
      rt2.dispose();
    } finally {
      for (const k of extraKeys) {
        const desc = prevExtra.get(k);
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
    }
  });
});

test('subagent-footer opens Overview by default and restores previous Overview state on side-panel close', async () => {
  const env = makeMockDomEnv({ pathname: '/c/conv-default', lang: 'en', width: 620 });

  const docClickHandlers = [];
  const origDocAdd = env.doc.addEventListener;
  env.doc.addEventListener = (t, fn, opts) => {
    if (t === 'click') docClickHandlers.push({ fn, capture: Boolean(opts === true || opts?.capture) });
    origDocAdd(t, fn, opts);
  };
  env.doc.removeEventListener = (t, fn) => {
    if (t === 'click') {
      const idx = docClickHandlers.findIndex((h) => h.fn === fn);
      if (idx >= 0) docClickHandlers.splice(idx, 1);
    }
  };
  const dispatchUserClick = (target) => {
    let stopped = false;
    const ev = {
      target,
      preventDefault() {},
      stopPropagation() { stopped = true; },
    };
    for (const h of docClickHandlers) {
      if (h.capture) h.fn(ev);
    }
    if (!stopped) target.click();
  };

  await withGlobals(env, async () => {
    const extraKeys = ['history', 'PopStateEvent', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const prevExtra = new Map(extraKeys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.PopStateEvent = class { constructor(type, init) { this.type = type; this.state = init?.state; } };
    globalThis.history = {
      state: null,
      pushState(_st, _t, urlStr) {
        const u = new URL(urlStr, 'http://127.0.0.1');
        env.loc.pathname = u.pathname;
        env.loc.search = u.search;
        env.loc.href = u.href;
      },
    };

    try {
      const convView = env.createEl('div');
      convView.setAttribute('data-testid', 'conversation-view');
      const mainBox = env.createEl('div');
      mainBox.id = 'antigravity.agentSidePanelInputBox';
      const mainFooter = env.createEl('div');
      mainFooter.className = 'agy-composer-footer';
      const mainLeft = env.createEl('div');
      mainLeft.append(env.createEl('button'));
      mainFooter.append(mainLeft);
      mainBox.append(mainFooter);
      convView.append(mainBox);

      const s2Value = {
        breakpoint: 'medium',
        presentation: 'inline',
        cascadeId: 'conv-default',
        hydrated: true,
        isOpen: false,
        isPanelVisible: false,
      };
      const ovHost = env.createEl('div');
      ovHost.setAttribute('data-testid', 'overview-panel-host');
      ovHost['__reactFiber$ov'] = { memoizedProps: { value: s2Value }, return: null };

      const split = env.createEl('div');
      split.setAttribute('data-testid', 'aux-pane-split');
      split['__reactFiber$split'] = {
        memoizedProps: { sidePanelWidth: 50, auxPaneWidthUnit: '%', onResize() {} },
        return: null,
      };

      const auxBtn = env.createEl('button');
      auxBtn.setAttribute('data-testid', 'toggle-aux-sidebar');
      auxBtn.setAttribute('aria-expanded', 'false');
      auxBtn.addEventListener('click', () => {
        const open = auxBtn.getAttribute('aria-expanded') === 'true';
        auxBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
      });

      const ovBtn = env.createEl('button');
      ovBtn.setAttribute('data-testid', 'toggle-overview-panel');
      ovBtn.setAttribute('aria-pressed', 'false');
      ovBtn.addEventListener('click', () => {
        const open = ovBtn.getAttribute('aria-pressed') === 'true';
        ovBtn.setAttribute('aria-pressed', open ? 'false' : 'true');
      });

      env.doc.body.append(convView, ovHost, split, auxBtn, ovBtn);
      env.win.__ag_last_metrics = {
        cascadeId: 'conv-default',
        stats: { children: [{ id: 'sub-1', agentName: 'Explorer', running: true }] },
      };

      const rt = createSubagentFooterRuntime({ motionThemes, shortenModelName, shortenEffortBadge });

      // 1. Default-open Overview on entering a conversation when both panels are closed
      rt.sync();
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'true', 'Overview should default open');

      // Manual close must be respected across subsequent syncs
      dispatchUserClick(ovBtn);
      await new Promise((r) => setTimeout(r, 20));
      rt.sync();
      rt.sync();
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'false', 'Manual Overview close must stick');

      // 2. Re-open Overview -> enter subagent -> exit subagent => Overview automatically restores
      dispatchUserClick(ovBtn);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'true');

      const pill = env.doc.getElementById('agy-main-subagent-pill');
      assert.ok(pill);
      pill.click();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(auxBtn.getAttribute('aria-expanded'), 'true');
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'false');

      // Clear full handoff timer window before toggling closed
      await new Promise((r) => setTimeout(r, 520));
      pill.click(); // Toggle closed
      assert.equal(auxBtn.getAttribute('aria-expanded'), 'false');
      await new Promise((r) => setTimeout(r, 290));
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'true', 'Closing Aux should restore previously open Overview');

      // 3. Overview closed before entering subagent -> exit subagent keeps Overview closed
      await new Promise((r) => setTimeout(r, 320));
      dispatchUserClick(ovBtn);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'false');

      pill.click();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(auxBtn.getAttribute('aria-expanded'), 'true');
      pill.click();
      await new Promise((r) => setTimeout(r, 320));
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'false', 'Closing Aux must not re-open previously closed Overview');

      // 4. Narrow "small" breakpoint skips default-open; medium/large opens on new conversation route
      s2Value.breakpoint = 'small';
      s2Value.cascadeId = 'conv-small';
      env.loc.pathname = '/c/conv-small';
      env.loc.href = 'http://127.0.0.1/c/conv-small';
      env.win.__ag_last_metrics = {
        cascadeId: 'conv-small',
        stats: { children: [{ id: 'sub-2', agentName: 'Planner', running: false }] },
      };
      rt.sync();
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'false', 'Must not auto-open overlay on small breakpoint');

      s2Value.breakpoint = 'medium';
      s2Value.cascadeId = 'conv-default-2';
      env.loc.pathname = '/c/conv-default-2';
      env.loc.href = 'http://127.0.0.1/c/conv-default-2';
      env.win.__ag_last_metrics = {
        cascadeId: 'conv-default-2',
        stats: { children: [{ id: 'sub-3', agentName: 'Verifier', running: false }] },
      };
      rt.sync();
      assert.equal(ovBtn.getAttribute('aria-pressed'), 'true', 'New conversation with medium/large breakpoint opens Overview by default');

      rt.dispose();
    } finally {
      for (const k of extraKeys) {
        const desc = prevExtra.get(k);
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
    }
  });
});

test('Gemini 4 Neon defaults to High thinking effort across picker rows and fallback selector', async () => {
  const modelPickerSrc = readFileSync(path.join(REPO, 'vendor', 'agy-capsule', 'model_picker.mjs'), 'utf8');
  const customJsSrc = readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');

  assert.match(modelPickerSrc, /const defaultTierFor = name => \{[\s\S]*?return \/\\bneon\\b\/i\.test\(key\) \? 'high' : 'medium';/);
  assert.match(modelPickerSrc, /showSubFor[\s\S]*?const defTier = defaultTierFor\(planner\.name\);/);
  assert.match(modelPickerSrc, /renderedGroups[\s\S]*?const defTier = defaultTierFor\(group\.name\);/);
  assert.match(customJsSrc, /function pickVariantForFamily[\s\S]*?\/\\bneon\\b\/i[\s\S]*?v\.effort === ['"]High['"]/);

  const env = makeMockDomEnv({ pathname: '/c/conv-neon', lang: 'en', width: 620 });
  const enhanceEl = (el, rootRef) => {
    Object.defineProperty(el, 'firstElementChild', { get: () => el.children[0] || null, configurable: true });
    Object.defineProperty(el, 'lastElementChild', { get: () => el.children[el.children.length - 1] || null, configurable: true });
    el.after = (...nodes) => {
      if (!el.parentElement) return;
      const sibs = el.parentElement.children;
      let idx = sibs.indexOf(el);
      for (const n of nodes) {
        n.parentElement = el.parentElement;
        if (idx >= 0) sibs.splice(++idx, 0, n);
        else sibs.push(n);
      }
    };
    const origClassList = el.classList;
    Object.defineProperty(el, 'classList', {
      get: () => ({
        add: origClassList.add,
        contains: origClassList.contains,
        remove: (...cls) => {
          const rm = new Set(cls);
          el.className = (el.className || '').split(/\s+/).filter((c) => c && !rm.has(c)).join(' ');
        },
        toggle: (c, force) => {
          const has = origClassList.contains(c);
          const want = force === undefined ? !has : Boolean(force);
          if (want) origClassList.add(c);
          else {
            const next = (el.className || '').split(/\s+/).filter((x) => x && x !== c);
            el.className = next.join(' ');
          }
          return want;
        },
      }),
      configurable: true,
    });
    el.getRootNode = () => rootRef;
    el.focus = () => {};
    el.hidePopover = () => {};
    el.observe = () => {};
    return el;
  };

  await withGlobals(env, () => {
    const prevMatchMedia = globalThis.matchMedia;
    env.win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    globalThis.matchMedia = env.win.matchMedia;

    const footer = env.createEl('div');
    const leftGroup = env.createEl('div');
    const root = enhanceEl(env.createEl('div'), null);
    root.getRootNode = () => root;
    const origCreate = env.doc.createElement;
    env.doc.createElement = (tag) => {
      const el = enhanceEl(origCreate(tag), root);
      const desc = Object.getOwnPropertyDescriptor(el, 'innerHTML') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'innerHTML');
      Object.defineProperty(el, 'innerHTML', {
        get: () => el._html,
        set: (v) => {
          const html = String(v ?? '');
          el._html = html;
          el.children.length = 0;
          if (html.includes('ces-ag-effort-row')) {
            const row = enhanceEl(origCreate('div'), root);
            row.className = 'ces-ag-effort-row';
            const head = enhanceEl(origCreate('div'), root);
            head.className = 'ces-ag-effort-head';
            head.append(enhanceEl(origCreate('span'), root), enhanceEl(origCreate('span'), root));
            const inline = enhanceEl(origCreate('div'), root);
            inline.className = 'ces-inline';
            row.append(head, inline);
            el.append(row);
          }
        },
        configurable: true,
      });
      return el;
    };

    try {
      const trigger = env.createEl('button');
      trigger.setAttribute('data-testid', 'model-selector-trigger');
      const modelOptions = [
        { label: 'Claude 4.5 Sonnet (Medium)', modelId: 'claude-4-5-sonnet-med', value: 1 },
        { label: 'Gemini 4 Neon (Low)', modelId: 'gemini-4-neon-low', value: 2 },
        { label: 'Gemini 4 Neon (Medium)', modelId: 'gemini-4-neon-med', value: 3 },
        { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', value: 4 },
        { label: 'Gemini 4 Neon (XHigh)', modelId: 'gemini-4-neon-xhigh', value: 5 },
        { label: 'GPT-5 (Low)', modelId: 'gpt-5-low', value: 6 },
        { label: 'GPT-5 (Medium)', modelId: 'gpt-5-med', value: 7 },
        { label: 'GPT-5 (High)', modelId: 'gpt-5-high', value: 8 },
      ];
      trigger['__reactFiber$m'] = {
        memoizedProps: {
          placement: 'footer',
          conversationId: 'conv-neon',
          selectedModel: modelOptions[0],
          modelOptions,
          setSelectedModel() {},
        },
        return: null,
      };
      footer.append(leftGroup, trigger);
      leftGroup.append(root);
      env.doc.body.append(footer);

      syncModelPicker(root, footer, { modelEffortPicker: true, showEffortBar: true }, {}, () => leftGroup);

      const rows = root.querySelectorAll('button.dk-model-row');
      const neonRow = rows.find((r) => r.dataset.family === 'Gemini 4 Neon');
      const gptRow = rows.find((r) => r.dataset.family === 'GPT-5');
      assert.equal(neonRow?.dataset.label, 'Gemini 4 Neon (High)');
      assert.equal(gptRow?.dataset.label, 'GPT-5 (Medium)');

      // Verify custom defaultTierByFamily overrides apply dynamically
      syncModelPicker(
        root,
        footer,
        {
          modelEffortPicker: true,
          showEffortBar: true,
          defaultTierByFamily: { 'Gemini 4 Neon': 'low', 'GPT-5': 'high' },
        },
        {},
        () => leftGroup
      );
      const updatedRows = root.querySelectorAll('button.dk-model-row');
      assert.equal(updatedRows.find((r) => r.dataset.family === 'Gemini 4 Neon')?.dataset.label, 'Gemini 4 Neon (Low)');
      assert.equal(updatedRows.find((r) => r.dataset.family === 'GPT-5')?.dataset.label, 'GPT-5 (High)');
      root._modelPicker?.dispose?.();
    } finally {
      if (prevMatchMedia === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = prevMatchMedia;
    }
  });
});

test('sanitizeStudioPrefs, loadStudioPrefs & saveStudioPrefs validate enums, defaults and support reset', async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-studio-prefs-'));
  try {
    const studioFile = path.join(dir, 'studio-prefs.json');

    const initial = daemon.loadStudioPrefs({ studioPrefsFile: studioFile });
    assert.equal(initial.customizeModelList, false);
    assert.deepEqual(initial.hiddenModels, []);
    assert.equal(initial.effortTheme, 'auto');
    assert.equal(initial.claudeTheme, 'matrix');
    assert.equal(initial.defaultTierByFamily['Gemini 4 Neon'], 'high');
    assert.equal(initial.hideThinkingProse, true);

    const saved = daemon.saveStudioPrefs(
      {
        hideThinkingProse: false,
        motionLevel: 'reduced',
        overviewUsageDefaultPeriod: 'week',
        defaultTierByFamily: { 'Gemini 4 Neon': 'high', 'Claude Opus 5.5': 'HIGH', Invalid: 'nope' },
      },
      { studioPrefsFile: studioFile }
    );
    assert.equal(saved.ok, true);
    assert.equal(saved.prefs.hideThinkingProse, false);
    assert.equal(saved.prefs.motionLevel, 'reduced');
    assert.equal(saved.prefs.overviewUsageDefaultPeriod, 'week');
    assert.deepEqual(saved.prefs.defaultTierByFamily, {
      'Gemini 4 Neon': 'high',
      'Claude Opus 5.5': 'high',
    });

    const sanitized = daemon.sanitizeStudioPrefs({
      effortTheme: 'bogus',
      motionLevel: 'invalid',
      hiddenModels: ['A', 123, 'A', 'B'],
    });
    assert.equal(sanitized.effortTheme, 'auto');
    assert.equal(sanitized.motionLevel, 'full');
    assert.deepEqual(sanitized.hiddenModels, ['A', 'B']);

    const resetRes = daemon.saveStudioPrefs({ reset: true }, { studioPrefsFile: studioFile });
    assert.equal(resetRes.ok, true);
    assert.equal(resetRes.prefs.hideThinkingProse, true);
    assert.deepEqual(resetRes.prefs.hiddenModels, []);
    assert.equal(resetRes.prefs.motionLevel, 'full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildStudioBundle includes unified MAGA settings runtime & non-nested CSS', async () => {
  const { jsBlock, cssBlock } = await buildStudioBundle();
  assert.ok(jsBlock.includes('createStudioPrefsRuntime'));
  assert.ok(jsBlock.includes('createStudioSettingsRuntime'));
  assert.ok(cssBlock.includes('/* --- studio/styles/studio-settings.css --- */'));
  assert.equal(hasNestedHasSelector(cssBlock), false);
});

test('studio-settings & capsule-picker enforce symmetrical centering, merge capsule/theme 3-tab workbench & show all Gemini 4 elements', () => {
  const settingsSrc = [
    readFileSync(path.join(REPO, 'studio', 'modules', 'studio-settings.mjs'), 'utf8'),
    readFileSync(path.join(REPO, 'studio', 'modules', 'settings', 'constants.mjs'), 'utf8'),
    readFileSync(path.join(REPO, 'studio', 'modules', 'settings', 'events.mjs'), 'utf8'),
    readFileSync(path.join(REPO, 'studio', 'modules', 'settings', 'preview.mjs'), 'utf8'),
    readFileSync(path.join(REPO, 'studio', 'modules', 'settings', 'views.mjs'), 'utf8'),
  ].join('\n');
  const settingsCss = readFileSync(path.join(REPO, 'studio', 'styles', 'studio-settings.css'), 'utf8');
  const pickerSrc = readFileSync(path.join(REPO, 'studio', 'modules', 'capsule-picker.mjs'), 'utf8');

  assert.match(settingsSrc, /viewBox="0 0 24 24"[\s\S]*?<circle cx="12" cy="12" r="3"\/>/);
  assert.match(settingsCss, /\.agy-ms-body\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0/);
  assert.equal(settingsSrc.includes('data-ms-host="orchestratorModel"'), false, 'Planner dropdown must be removed');
  assert.equal(settingsSrc.includes('agy-ms-prev-effortbar'), false, 'Fake stretched progress bar must be removed');
  assert.equal(settingsSrc.includes('GPT-OSS'), false, 'Unused GPT-OSS / Codex sample must be removed');

  for (const modelName of ['Gemini 4 Neon', 'Gemini 4 Carbon', 'Gemini 4 Argon', 'Gemini 4 Hydrogen', 'Claude Opus 5.5']) {
    assert.ok(settingsSrc.includes(modelName), `Missing preview model ${modelName}`);
  }

  assert.ok(settingsSrc.includes('agy-ms-studio-split'));
  assert.ok(settingsSrc.includes('agy-ms-model-rail'));
  assert.ok(settingsSrc.includes('agy-ms-model-chip'));
  assert.ok(settingsSrc.includes('data-ms-host="orchestratorExecutorModel"'));
  assert.ok(settingsSrc.includes('agy-ms-preview-stage'));
  assert.ok(settingsSrc.includes('agy-ms-prev-fx-host'));
  assert.ok(settingsSrc.includes('data-ms-studio-tab="capsule"'));
  assert.ok(settingsSrc.includes('data-ms-studio-tab="slider"'));
  assert.ok(settingsSrc.includes('data-ms-studio-tab="orch"'));
  assert.match(settingsSrc, /const\s+showCodex\s*=\s*p\.effortTheme\s*===\s*'codex'/);
  assert.ok(settingsSrc.includes('agy-ms-opt-grid'));
  assert.ok(settingsSrc.includes('ORCH_MINI_ICONS'));
  assert.ok(settingsSrc.includes('mountOrchestratorSwitch'));
  assert.ok(settingsSrc.includes('mountEffortBar'));

  // Symmetrical vertical centering & spacing across all Effort Bar modes
  assert.match(pickerSrc, /\.dk-orch-btn\s+\.dk-orch-label\s*\{[^}]*line-height:\s*1\s*!important/);
  assert.match(pickerSrc, /\.ces-ag-effort-row\s*\{[^}]*padding:\s*8px\s+10px\s+9px\s*!important[^}]*gap:\s*8px\s*!important/);
  assert.match(pickerSrc, /\.ces-ag-effort-head\s*\{[^}]*align-items:\s*center\s*!important/);
  assert.equal(settingsSrc.includes('margin: 5px 0 1px'), false, 'Asymmetric preview .agy-effort margin override must be removed');
  assert.ok(settingsSrc.includes('.agy-fx-stage .agy-effort { margin: 0 !important; }'));
});

test('studio-prefs getModelCatalog sorts executor & planner tiers monotonically (XHigh before High) including cached fallback', async () => {
  const env = makeMockDomEnv({ pathname: '/c/conv-cat', lang: 'zh', width: 720 });
  const prevLS = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storeMap = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => { storeMap.set(k, String(v)); },
    removeItem: (k) => { storeMap.delete(k); },
  };

  await withGlobals(env, () => {
    let prefsRt;
    try {
      const trigger = env.createEl('button');
      trigger.setAttribute('data-testid', 'model-selector-trigger');
      const modelOptions = [
        { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', value: 1532 },
        { label: 'Gemini 4 Neon (XHigh)', modelId: 'gemini-4-neon-xhigh', value: 1533 },
        { label: 'Gemini 4 Hydrogen (High)', modelId: 'gemini-4-hydrogen-high', value: 1603 },
        { label: 'Gemini 4 Hydrogen (XHigh)', modelId: 'gemini-4-hydrogen-xhigh', value: 1604 },
        { label: 'Gemini 4 Hydrogen (Medium)', modelId: 'gemini-4-hydrogen-medium', value: 1602 },
        { label: 'Gemini 4 Hydrogen (Low)', modelId: 'gemini-4-hydrogen-low', value: 1601 },
        { label: 'Claude 4.5 Sonnet (Medium)', modelId: 'claude-4-5-sonnet-medium', value: 1702 },
        { label: 'Claude 4.5 Sonnet (High)', modelId: 'claude-4-5-sonnet-high', value: 1703 },
        { label: 'Claude 4.5 Sonnet (Low)', modelId: 'claude-4-5-sonnet-low', value: 1701 },
      ];
      const orchestratorPlanners = [
        { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', value: 1532 },
        { label: 'Gemini 4 Neon (XHigh)', modelId: 'gemini-4-neon-xhigh', value: 1533 },
        { label: 'Gemini 4 Neon (Low)', modelId: 'gemini-4-neon-low', value: 1530 },
      ];
      trigger.__reactFiber$test = {
        memoizedProps: {
          setSelectedModel() {},
          modelOptions,
          orchestratorPlanners,
        },
        return: null,
      };
      env.doc.body.append(trigger);

      prefsRt = createStudioPrefsRuntime({});
      const cat = prefsRt.getModelCatalog();

      assert.deepEqual(
        cat.executors.map((e) => e.label),
        [
          'Gemini 4 Hydrogen (XHigh)',
          'Gemini 4 Hydrogen (High)',
          'Gemini 4 Hydrogen (Medium)',
          'Gemini 4 Hydrogen (Low)',
          'Claude 4.5 Sonnet (High)',
          'Claude 4.5 Sonnet (Medium)',
          'Claude 4.5 Sonnet (Low)',
        ]
      );
      assert.deepEqual(
        cat.planners.map((p) => p.label),
        ['Gemini 4 Neon (XHigh)', 'Gemini 4 Neon (High)', 'Gemini 4 Neon (Low)']
      );
      const hyd = cat.families.find((f) => f.name === 'Gemini 4 Hydrogen');
      assert.deepEqual(hyd?.items.map((i) => i.tier), ['low', 'medium', 'high', 'xhigh']);

      // Seed unsorted legacy cache, detach trigger & verify cache fallback re-sorts too
      trigger.remove();
      globalThis.localStorage.setItem(
        'agy_studio_model_catalog_v1',
        JSON.stringify({
          families: [
            {
              name: 'Gemini 4 Hydrogen',
              displayName: 'Gemini 4 Hydrogen',
              isMultiTier: true,
              items: [
                { label: 'Gemini 4 Hydrogen (High)', tier: 'high', value: 1603 },
                { label: 'Gemini 4 Hydrogen (XHigh)', tier: 'xhigh', value: 1604 },
                { label: 'Gemini 4 Hydrogen (Low)', tier: 'low', value: 1601 },
              ],
            },
          ],
          planners: [
            { label: 'Gemini 4 Neon (High)', value: 1532 },
            { label: 'Gemini 4 Neon (XHigh)', value: 1533 },
          ],
          executors: [
            { label: 'Gemini 4 Hydrogen (High)', value: 1603 },
            { label: 'Gemini 4 Hydrogen (XHigh)', value: 1604 },
            { label: 'Gemini 4 Hydrogen (Medium)', value: 1602 },
          ],
        })
      );

      const cachedCat = prefsRt.getModelCatalog();
      assert.deepEqual(cachedCat.executors.map((e) => e.label), [
        'Gemini 4 Hydrogen (XHigh)',
        'Gemini 4 Hydrogen (High)',
        'Gemini 4 Hydrogen (Medium)',
      ]);
      assert.deepEqual(cachedCat.planners.map((p) => p.label), ['Gemini 4 Neon (XHigh)', 'Gemini 4 Neon (High)']);
      assert.deepEqual(cachedCat.families[0].items.map((i) => i.tier), ['low', 'high', 'xhigh']);
    } finally {
      prefsRt?.dispose?.();
      if (prevLS) Object.defineProperty(globalThis, 'localStorage', prevLS);
      else delete globalThis.localStorage;
    }
  });
});

test('subagent-footer, resume-banner and footer-unified recognize data-ag-ux-lang="zh" for Chinese i18n', async () => {
  const env = makeMockDomEnv({ pathname: '/c/conv-zh', lang: 'zh', width: 720 });
  const resumeRt = createResumeBannerRuntime({});
  const footerRt = createFooterUnifiedRuntime({});
  const origDocEl = env.doc.documentElement;
  origDocEl.setAttribute('data-ag-ux-lang', 'zh');

  const extraKeys = ['CustomEvent', 'history', 'PopStateEvent'];
  const prevExtra = new Map();
  for (const k of extraKeys) prevExtra.set(k, Object.getOwnPropertyDescriptor(globalThis, k));

  await withGlobals(env, () => {
    try {
      // Subagent-footer Chinese check under data-ag-ux-lang="zh"
      const mainBox = env.createEl('div');
      mainBox.id = 'antigravity.agentSidePanelInputBox';
      const footer = env.createEl('div');
      footer.className = 'agy-composer-footer';
      const leftGroup = env.createEl('div');
      const addBtn = env.createEl('button');
      leftGroup.append(addBtn);
      footer.append(leftGroup);
      mainBox.append(footer);
      env.doc.body.append(mainBox);

      env.win.__ag_last_metrics = {
        cascadeId: 'conv-zh',
        stats: {
          children: [
            { id: 'c1', agentName: '', running: true, calls: 1, outTok: 10 },
            { id: 'c2', agentName: 'Tester', running: false, calls: 2, outTok: 20 },
          ],
        },
      };

      const subRt = createSubagentFooterRuntime({
        motionThemes,
        shortenModelName,
        shortenEffortBadge,
      });
      subRt.sync();
      const pill = env.doc.getElementById('agy-main-subagent-pill');
      assert.ok(pill, 'subagent pill mounts');
      assert.match(pill.innerHTML, /子代理/, 'subagent pill switches to Chinese on data-ag-ux-lang="zh"');
      assert.match(pill.title, /工作中/, 'tooltip switches to Chinese');
      subRt.dispose();

      // Footer-unified Chinese Compacting check
      const ring = env.createEl('button');
      ring.id = 'ag-claude-ctx-ring';
      ring.setAttribute('data-compact-state', 'compacting');
      leftGroup.append(ring);
      footerRt.sync();
      assert.equal(ring.querySelector('.agy-ctx-full')?.textContent, '压缩中…');

      // Resume-banner Chinese divider check
      const step = env.createEl('div');
      step.setAttribute('data-testid', 'user-input-step');
      const content = env.createEl('div');
      content.setAttribute('data-testid', 'user-message-content');
      content.textContent = '\u2063\u200B\u2063Please resume from where the task was interrupted';
      step.append(content);
      const convView = env.createEl('div');
      convView.setAttribute('data-testid', 'conversation-view');
      convView.append(step);
      env.doc.body.append(convView);
      resumeRt.sync();
      assert.equal(step.getAttribute('data-agy-resumed-label'), '已从中断处继续');

      resumeRt.dispose();
      footerRt.dispose();
    } finally {
      for (const k of extraKeys) {
        const desc = prevExtra.get(k);
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
    }
  });
});

test('effort_upstream, effort_bar, motion_themes & capsule-picker apply canvas buffer reuse, style caching, idle throttling & drop opaque backdrop blur', () => {
  const upstreamSrc = readFileSync(path.join(REPO, 'vendor', 'agy-capsule', 'effort_upstream.mjs'), 'utf8');
  const effortBarSrc = readFileSync(path.join(REPO, 'vendor', 'agy-capsule', 'effort_bar.mjs'), 'utf8');
  const themesSrc = readFileSync(path.join(REPO, 'vendor', 'agy-capsule', 'motion_themes.mjs'), 'utf8');
  const pickerSrc = readFileSync(path.join(REPO, 'studio', 'modules', 'capsule-picker.mjs'), 'utf8');

  // effort_upstream: fixed full-track canvas width via CSS 100%, visibility pause, DOM write deduplication
  assert.match(upstreamSrc, /\.ces-claude-canvas\s*\{[^}]*width:\s*100%/);
  assert.equal(upstreamSrc.includes('tw * dpr'), false, 'Canvas buffer width must not depend on fill width tw');
  assert.ok(upstreamSrc.includes('trackW * dpr'));
  assert.ok(upstreamSrc.includes('lastAccentRgb'));
  assert.ok(upstreamSrc.includes('lastOffsetCss'));
  assert.ok(upstreamSrc.includes('lastFillBg'));
  assert.ok(upstreamSrc.includes('lastVisualSig'));
  assert.ok(upstreamSrc.includes('visibilitychange'));
  assert.ok(upstreamSrc.includes('isMotionDisabled'));

  // effort_bar: boxShadow / transform caching, visibilitychange pause, idle throttling & no sync double paint
  assert.ok(effortBarSrc.includes('lastTransform'));
  assert.ok(effortBarSrc.includes('lastBoxShadow'));
  assert.ok(effortBarSrc.includes('lastDrawTs'));
  assert.ok(effortBarSrc.includes('visibilitychange'));
  assert.ok(effortBarSrc.includes('minInterval'));
  assert.match(effortBarSrc, /setContext\(\)\s*\{\s*if\s*\(!rafId\s*\|\|\s*motionOff\(\)\)\s*paint/);

  // motion_themes: HEX_COS precomputation & WeakMap caches for glass sheen and exec palette
  assert.ok(themesSrc.includes('HEX_COS'));
  assert.ok(themesSrc.includes('HEX_SIN'));
  assert.ok(themesSrc.includes('GLASS_SHEEN_CACHE'));
  assert.ok(themesSrc.includes('EXEC_PALETTE_CACHE'));

  // capsule-picker: no redundant backdrop-filter on opaque popover card
  const popoverBlock = pickerSrc.match(/\.dk-model-options,\s*\.dk-model-sub,\s*\.dk-model-tiers,\s*\.dk-model-tip\s*\{[^}]*\}/)?.[0] || '';
  assert.ok(popoverBlock.length > 0, 'Missing popover CSS block');
  assert.equal(popoverBlock.includes('backdrop-filter'), false, 'Opaque popover should avoid expensive backdrop-filter blur');
  assert.ok(pickerSrc.includes('panelOpen && now - inst.lastPickerSyncTs >= 800'), 'panelOpen must throttle repeated Fiber scans');
  assert.equal(effortBarSrc.includes('backdrop-filter'), false, 'effort_bar .ces-set should not use backdrop-filter');
  assert.equal(upstreamSrc.includes('backdrop-filter'), false, 'effort_upstream .ces-set should not use backdrop-filter');
});

test('observer loop prevention & idempotent DOM writes across studio-settings, build & user/custom.js', () => {
  const settingsSrc = readFileSync(path.join(REPO, 'studio', 'modules', 'studio-settings.mjs'), 'utf8');
  const buildSrc = readFileSync(path.join(REPO, 'studio', 'build.mjs'), 'utf8');
  const customJsSrc = readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const modelPickerSrc = readFileSync(path.join(REPO, 'vendor', 'agy-capsule', 'model_picker.mjs'), 'utf8');

  // studio-settings: updateTriggerState delegates aria-expanded / aria-label idempotently via setAttr
  const trigFn = settingsSrc.match(/function updateTriggerState\(\)\s*\{[\s\S]*?\n\s*\}/)?.[0] || '';
  assert.ok(trigFn.includes("setAttr(btn, 'aria-expanded', exp)"), 'updateTriggerState must guard aria-expanded writes via setAttr');
  assert.ok(trigFn.includes("setAttr(btn, 'aria-label', lbl)"), 'updateTriggerState must guard aria-label writes via setAttr');

  // user/custom.js: OWN_SEL ignores MAGA settings trigger/drawer/root & guards projects nav label
  const ownSelLine = customJsSrc.match(/const OWN_SEL\s*=\s*[\s\S]*?;/)?.[0] || '';
  assert.ok(ownSelLine.includes('#agy-maga-settings-trigger'), 'OWN_SEL must include #agy-maga-settings-trigger');
  assert.ok(ownSelLine.includes('#agy-maga-settings-drawer'), 'OWN_SEL must include #agy-maga-settings-drawer');
  assert.ok(ownSelLine.includes('#agy-maga-settings-root'), 'OWN_SEL must include #agy-maga-settings-root');
  const navFn = customJsSrc.match(/function updateProjectsNavActiveVisual\(\)\s*\{[\s\S]*?\n\s*\}/)?.[0] || '';
  assert.ok(navFn.includes('setLeafText(lbl, nextLbl)') || navFn.includes('lbl.textContent !== nextLbl'), 'updateProjectsNavActiveVisual must guard textContent writes');
  const setLeafFn = customJsSrc.match(/function setLeafText\([\s\S]*?\n\s*\}/)?.[0] || '';
  assert.ok(setLeafFn.includes('first.nodeValue'), 'setLeafText must update Text nodeValue in place');
  const runTimerFn = customJsSrc.match(/function syncRunningToolIndicators\([\s\S]*?\n    \}/)?.[0] || '';
  assert.ok(runTimerFn.includes('setLeafText(timerEl, txt)'), 'syncRunningToolIndicators must use setLeafText');

  // studio/core & build.mjs: unified OWN_ATTR + OWN_HOST_IDS, esbuild bundling (no .toString()), repo sync in deployStudio
  assert.equal(OWN_ATTR, 'data-maga-own');
  for (const ownId of ['ag-claude-projects-nav-btn', 'ag-claude-ov-sections', 'ag-live-metrics-pill']) {
    assert.ok(OWN_HOST_IDS.has(ownId), `OWN_HOST_IDS must ignore user/custom.js node #${ownId}`);
  }
  assert.equal(buildSrc.includes('.toString()'), false, 'studio/build.mjs must bundle via esbuild instead of .toString() concatenation');
  assert.ok(buildSrc.includes('esbuild.build('), 'studio/build.mjs must invoke esbuild.build');
  assert.ok(buildSrc.includes('REPO_USER_JS') && buildSrc.includes('REPO_USER_CSS'), 'deployStudio must sync repo user/custom.{js,css}');

  // model_picker.mjs: only clears title when label changes
  assert.ok(modelPickerSrc.includes('if (labelChanged) {') && modelPickerSrc.includes("button.removeAttribute('title')"));
});

test('MagaKernel routes dirty topics with 1 root observer, filters data-maga-own & batches read/write phases', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div class="agy-composer-footer"></div><aside data-testid="overview-panel"></aside></body></html>', {
    url: 'http://127.0.0.1/c/conv-kernel-1',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const doc = win.document;

  const keys = ['window', 'document', 'location', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'Node', 'Element', 'CustomEvent'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.location = win.location;
  globalThis.MutationObserver = win.MutationObserver;
  globalThis.Node = win.Node;
  globalThis.Element = win.Element;
  globalThis.CustomEvent = win.CustomEvent;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  let kernel = null;
  try {
    const events = [];
    kernel = createMagaKernel({ fallbackPollMs: 60000 });
    let disposedCount = 0;

    kernel.register({
      id: 'composer-mod',
      topics: ['composer'],
      read(snap) {
        events.push(`read:composer:${Array.from(snap.topics).join(',')}`);
        return { count: snap.footers.length };
      },
      write(snap, plan) {
        events.push(`write:composer:${plan.count}`);
        const badge = doc.createElement('span');
        badge.setAttribute(OWN_ATTR, '1');
        badge.id = 'test-own-badge';
        doc.querySelector('.agy-composer-footer').appendChild(badge);
      },
      dispose() { disposedCount += 1; },
    });

    kernel.register({
      id: 'overview-mod',
      topics: ['overview'],
      read() { events.push('read:overview'); return {}; },
      write() { events.push('write:overview'); },
      dispose() { disposedCount += 1; },
    });

    kernel.start();
    assert.deepEqual(events.slice(0, 4), ['read:composer:all', 'read:overview', 'write:composer:1', 'write:overview']);
    assert.equal(kernel.getStats().observerCount, 1);

    // Mutate inside own data-maga-own subtree -> must NOT wake any feature
    events.length = 0;
    const ownBadge = doc.getElementById('test-own-badge');
    ownBadge.appendChild(doc.createElement('i'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(events.length, 0, 'Own data-maga-own subtree mutations must be ignored');

    // Mutate overview panel -> wakes only overview-mod, NOT composer-mod
    doc.querySelector('[data-testid="overview-panel"]').appendChild(doc.createElement('div'));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(events, ['read:overview', 'write:overview']);

    kernel.dispose();
    assert.equal(disposedCount, 2);
    assert.equal(kernel.getStats().observerCount, 0);
  } finally {
    kernel?.dispose?.();
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    dom.window.close();
  }
});

test('MetricsBus renders permanent speed slots via setLeafText with zero childList mutations after init', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="ag-live-metrics-pill"><span id="ag-live-metrics-text"></span></div></body></html>', {
    url: 'http://127.0.0.1/c/conv-metrics-1',
  });
  const doc = dom.window.document;
  const keys = ['document', 'window', 'location'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.document = doc;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;

  try {
    const pill = doc.getElementById('ag-live-metrics-pill');
    const textEl = doc.getElementById('ag-live-metrics-text');

    renderSpeedSlots(pill, textEl, {
      cascadeId: 'conv-metrics-1',
      hasData: true,
      metrics: { displayTps: 108, useStream: true, ttft: 9.4 },
    }, { cid: 'conv-metrics-1', running: false, isZh: false });

    assert.equal(textEl.querySelector('[data-agy-speed-num="1"]').textContent, '108 tok/s');
    assert.equal(textEl.querySelector('[data-agy-speed-short="1"]').textContent, '108');
    assert.equal(textEl.querySelector('[data-agy-speed-slot="extra"]').textContent, 'TTFT 9.4s');

    let childListMutCount = 0;
    const obs = new dom.window.MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') childListMutCount += 1;
      }
    });
    obs.observe(textEl, { childList: true, subtree: true });

    // Push updated metrics -> must mutate Text.nodeValue only, zero childList mutations!
    renderSpeedSlots(pill, textEl, {
      cascadeId: 'conv-metrics-1',
      hasData: true,
      metrics: { displayTps: 0.4, useStream: false, ttft: 125 },
    }, { cid: 'conv-metrics-1', running: false, isZh: true });

    await new Promise((r) => setTimeout(r, 15));
    obs.disconnect();

    assert.equal(childListMutCount, 0, 'Speed updates must cause zero childList mutations on #ag-live-metrics-text');
    assert.equal(textEl.querySelector('[data-agy-speed-num="1"]').textContent, '0.4 tok/s');
    assert.equal(textEl.querySelector('[data-agy-speed-slot="extra"]').textContent, 'Hold 2m 5s');
    assert.equal(setAttr(pill, 'data-test', '1'), true);
    assert.equal(setAttr(pill, 'data-test', '1'), false);
    assert.equal(setLeafText(textEl.querySelector('[data-agy-speed-num="1"]'), '0.4 tok/s'), false);
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    dom.window.close();
  }
});

test('Stage 3: eliminates all global CSS :has() rules and applies safe containment isolation', async () => {
  const globalCssPaths = [
    path.join(REPO, 'user', 'custom.css'),
    path.join(REPO, 'studio', 'styles', 'footer-capsules.css'),
    path.join(REPO, 'studio', 'styles', 'typography.css'),
    path.join(REPO, 'studio', 'styles', 'overview-usage.css'),
    path.join(REPO, 'studio', 'styles', 'studio-settings.css'),
  ];
  for (const p of globalCssPaths) {
    const css = readFileSync(p, 'utf8');
    assert.equal(css.includes(':has('), false, `${path.relative(REPO, p)} must contain zero :has() rules`);
  }
  const runtimeJs = readFileSync(path.join(REPO, 'core', 'runtime.js'), 'utf8');
  assert.equal(runtimeJs.includes(':has('), false, 'core/runtime.js must contain zero :has() rules in dynamic CSS');

  const userCss = readFileSync(path.join(REPO, 'user', 'custom.css'), 'utf8');
  const footerCss = readFileSync(FOOTER_CSS_PATH, 'utf8');
  const usageCss = readFileSync(path.join(REPO, 'studio', 'styles', 'overview-usage.css'), 'utf8');
  const drawerCss = readFileSync(path.join(REPO, 'studio', 'styles', 'studio-settings.css'), 'utf8');
  assert.match(userCss, /\.ag-orbit-dots\s*\{[\s\S]*?contain:\s*layout style;/);
  assert.match(userCss, /\.ag-elapsed-timer\s*\{[\s\S]*?contain:\s*layout style;/);
  assert.match(userCss, /\[data-testid="overview-panel"\]\[data-ag-ov-enhanced="1"\]\s*\{[\s\S]*?contain:\s*style;/);
  assert.match(footerCss, /#ag-live-metrics-pill\s*\{[\s\S]*?contain:\s*layout style;/);
  assert.match(usageCss, /#agy-ov-usage-card\s*\{[\s\S]*?contain:\s*layout style;/);
  assert.match(drawerCss, /#agy-maga-settings-drawer\s*\{[\s\S]*?contain:\s*layout style;/);

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="antigravity.agentSidePanelInputBox" data-testid="agent-input-box">
        <div id="ed-wrap"><div data-lexical-editor="true"></div><p class="pointer-events-none"></p></div>
        <div id="footer-shell"><div class="agy-composer-footer"></div></div>
      </div>
      <div id="ag-live-metrics-tooltip"><div class="ag-ux-tt"></div></div>
      <div class="agy-sheet" data-sheet-inset="1"><div id="hole-host" data-main-content-body="1"><span data-browser-hole="true"></span></div></div>
      <div id="steps-row" data-step-rows="true">
        <button data-testid="tool-group-collapsible"><span data-testid="tool-group-elapsed">2s</span></button>
      </div>
      <div class="rounded-xl border"><div class="border-b"><svg id="q-svg"><path d="M477.92-295.77z"></path></svg></div></div>
      <div data-testid="aux-pane-split">
        <div></div>
        <div>
          <div id="sub-sb-wrap"><div data-testid="subagent-tab-sidebar"></div></div>
          <div id="sub-conv-outer"><div id="sub-conv-wrap"><div data-testid="subagent-tab-conversation"></div></div></div>
        </div>
      </div>
      <div id="dlg" role="dialog">
        <div id="wrap-outer"><div id="wrap-inner"><div data-testid="settings-sidebar"></div></div></div>
        <div class="agy-card"><div id="split-card"><div class="w-full flex justify-between"></div></div></div>
      </div>
      <div data-testid="conversation-row-sidebar" data-pinned="true"><span id="pin-span"><svg data-project-glyph="1"></svg></span></div>
      <section id="ag-claude-recent-section"><button class="ag-recent-hdr" aria-expanded="false"></button></section>
      <div data-testid="overview-panel">
        <button id="ov-rev" data-testid="overview-panel-row-review"><span data-testid="overview-panel-row-review-detail">+3 -1</span></button>
      </div>
    </body></html>`,
    { url: 'http://127.0.0.1/' }
  );
  const keys = ['document', 'window', 'location'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;

  try {
    const doc = dom.window.document;
    const domFlags = createDomFlagsFeature();
    domFlags.sync();

    assert.equal(doc.getElementById('footer-shell').getAttribute('data-maga-footer-shell'), '1');
    assert.equal(doc.getElementById('ed-wrap').getAttribute('data-maga-editor-wrap'), '1');
    assert.equal(doc.getElementById('ag-live-metrics-tooltip').getAttribute('data-ag-ux-tt'), '1');
    assert.equal(doc.getElementById('steps-row').getAttribute('data-maga-has-tools'), '1');
    assert.equal(doc.querySelector('[data-testid="tool-group-collapsible"]').getAttribute('data-maga-native-elapsed'), '1');
    assert.equal(doc.getElementById('q-svg').getAttribute('data-maga-q-icon'), '1');
    assert.equal(doc.getElementById('hole-host').getAttribute('data-maga-has-browser-hole'), '1');
    assert.equal(doc.getElementById('sub-sb-wrap').getAttribute('data-maga-sub-sidebar-wrap'), '1');
    assert.equal(doc.getElementById('sub-conv-wrap').getAttribute('data-maga-sub-conv-wrap'), '1');
    assert.equal(doc.getElementById('sub-conv-outer').getAttribute('data-maga-sub-conv-outer'), '1');
    assert.equal(doc.getElementById('dlg').getAttribute('data-maga-settings-host'), '1');
    assert.equal(doc.getElementById('wrap-inner').getAttribute('data-maga-settings-wrap'), '1');
    assert.equal(doc.getElementById('wrap-outer').getAttribute('data-maga-settings-wrap'), '1');
    assert.equal(doc.getElementById('split-card').getAttribute('data-maga-card-split'), '1');
    assert.equal(doc.getElementById('pin-span').getAttribute('data-maga-pin-glyph'), '1');
    assert.equal(doc.getElementById('ag-claude-recent-section').getAttribute('data-collapsed'), '1');
    assert.equal(doc.getElementById('ov-rev').getAttribute('data-ag-has-detail'), '1');

    domFlags.dispose();
    assert.equal(doc.getElementById('footer-shell').hasAttribute('data-maga-footer-shell'), false);
    assert.equal(doc.getElementById('sub-sb-wrap').hasAttribute('data-maga-sub-sidebar-wrap'), false);
    assert.equal(doc.getElementById('dlg').hasAttribute('data-maga-settings-host'), false);
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    dom.window.close();
  }
});

test('Stage 4: daemon, studio-settings & subagent-footer maintain thin orchestrators and acyclic submodules', async () => {
  const { execFileSync } = await import('node:child_process');
  const countLines = (rel) => readFileSync(path.join(REPO, rel), 'utf8').split('\n').length;

  assert.ok(countLines('core/daemon.mjs') < 350, `core/daemon.mjs should stay <350 lines (got ${countLines('core/daemon.mjs')})`);
  assert.ok(countLines('studio/modules/studio-settings.mjs') < 550, `studio-settings.mjs should stay <550 lines (got ${countLines('studio/modules/studio-settings.mjs')})`);
  assert.ok(countLines('studio/modules/subagent-footer.mjs') < 550, `subagent-footer.mjs should stay <550 lines (got ${countLines('studio/modules/subagent-footer.mjs')})`);

  const expectedSubmodules = [
    'core/daemon/env.mjs',
    'core/daemon/pid.mjs',
    'core/daemon/prefs-bundle.mjs',
    'core/daemon/metrics-db.mjs',
    'core/daemon/projects.mjs',
    'core/daemon/overview-skills.mjs',
    'core/daemon/cdp-bootstrap.mjs',
    'core/daemon/cdp-attach.mjs',
    'core/daemon/sync-loop.mjs',
    'studio/modules/settings/constants.mjs',
    'studio/modules/settings/events.mjs',
    'studio/modules/settings/preview.mjs',
    'studio/modules/settings/views.mjs',
    'studio/modules/subagent/panel-handoff.mjs',
    'studio/modules/subagent/pills.mjs',
  ];
  for (const rel of expectedSubmodules) {
    const abs = path.join(REPO, rel);
    assert.equal(existsSync(abs), true, `Missing Stage 4 submodule ${rel}`);
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  }

  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  for (const sym of [
    'isOwnDaemonProcess', 'claimPidFile', 'checkPidOwnership', 'waitForMacRelaunchReady',
    'saveUiPrefs', 'DEFAULT_STUDIO_PREFS', 'sanitizeStudioPrefs', 'loadStudioPrefs', 'saveStudioPrefs',
    'isSensitiveSourcePath', 'isSafeProjectDir', 'saveProjectContext', 'saveProjectScheduledTask', 'deleteProjectScheduledTask',
    'createLocalSkill', 'createLocalAgent', 'readOverviewGitStatusAsync', 'collectOverviewSnapshot', 'collectOverviewSnapshotAsync',
    'isAllowedOrigin', 'HOST_IDENTITY_PROBE_EXPR', 'attachTarget', 'attachedTargets', 'skippedNonHostTargets',
    'sync', 'rebuildBundleIfNeeded', 'getCachedBootPayload',
  ]) {
    assert.ok(sym in daemon, `core/daemon.mjs must re-export ${sym}`);
  }
});

test('Stage 5: user/src modular decomposition, zero legacy dead code, and MagaKernel single-observer bridge', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const { JSDOM } = await import('jsdom');

  const expectedUserModules = [
    'user/src/entry.mjs',
    'user/src/core/runtime-ctx.mjs',
    'user/src/core/model-api.mjs',
    'user/src/modules/step-stream.mjs',
    'user/src/modules/metrics-quota.mjs',
    'user/src/modules/inline-undo.mjs',
    'user/src/modules/sidebar-recents.mjs',
    'user/src/modules/i18n.mjs',
    'user/src/modules/settings-host.mjs',
    'user/src/modules/projects/shared.mjs',
    'user/src/modules/projects/mentions-media.mjs',
    'user/src/modules/projects/native-store.mjs',
    'user/src/modules/projects/modals.mjs',
    'user/src/modules/projects/workspace-ui.mjs',
    'user/src/modules/projects/conv-topbar.mjs',
    'user/src/modules/projects/worktree-ui.mjs',
    'user/src/modules/projects/index.mjs',
    'user/src/modules/customizations.mjs',
    'user/src/modules/overview-panel.mjs',
  ];
  assert.equal(existsSync(path.join(REPO, 'user/src/modules/projects.mjs')), false, 'monolithic projects.mjs must be removed');
  for (const rel of expectedUserModules) {
    const abs = path.join(REPO, rel);
    assert.equal(existsSync(abs), true, `Missing Stage 5 user module ${rel}`);
    const lineCount = readFileSync(abs, 'utf8').split('\n').length;
    assert.ok(lineCount < 2000, `User module ${rel} must be < 2000 lines (got ${lineCount})`);
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  }

  // Pre-1.0 clean-slate guards: compiled user/custom.js is gitignored & untracked; zero compat shims remain
  const gitignoreSrc = readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  assert.match(gitignoreSrc, /^user\/custom\.js$/m, '.gitignore must ignore generated user/custom.js');
  const trackedCustom = execFileSync('git', ['-C', REPO, 'ls-files', 'user/custom.js'], { encoding: 'utf8' }).trim();
  assert.equal(trackedCustom, '', 'user/custom.js build artifact must not be tracked in git');

  const shimPattern = /CAPSULE_SETTINGS_PATH|CAPSULE_SETTINGS_FILE|LEGACY_JS_MARKERS|LEGACY_CSS_MARKERS|claudeUxModelMenu|\.ag-cux-settings-wrap/;
  const collectMjsAndCss = (dir) => {
    const out = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...collectMjsAndCss(full));
      else if (/\.(mjs|css)$/.test(ent.name)) out.push(full);
    }
    return out;
  };
  for (const f of [...collectMjsAndCss(path.join(REPO, 'studio')), ...collectMjsAndCss(path.join(REPO, 'core', 'daemon'))]) {
    const text = readFileSync(f, 'utf8');
    assert.equal(shimPattern.test(text), false, `Removed Pre-1.0 shim found in ${path.relative(REPO, f)}`);
  }

  const customJsSrc = readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const customCssSrc = readFileSync(path.join(REPO, 'user', 'custom.css'), 'utf8');
  assert.equal(customCssSrc.includes(':has('), false, 'user/custom.css must have zero :has() rules');
  assert.equal(/#ag-claude-model-popover|\.ag-cm-row/.test(customCssSrc), false, 'legacy model popover CSS removed');
  assert.equal(/ag-claude-model-popover|ag-cux-settings-wrap|renderSettingsPanelContent/.test(customJsSrc), false, 'legacy model popover & toggle form JS removed');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"><div id="antigravity.agentSidePanelInputBox"></div></div></body></html>', {
    url: 'http://127.0.0.1/c/conv-stage5',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const doc = win.document;

  const keys = ['window', 'document', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.location = win.location;
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globalThis.MutationObserver = win.MutationObserver;

  try {
    win.ctx = { modules: { i18n: false }, onCleanup: () => {} };
    win.eval(customJsSrc);

    const hooks = win.__agClaudeUxKernelHooks;
    assert.ok(hooks && typeof hooks.attachKernel === 'function', 'user/custom.js must expose __agClaudeUxKernelHooks');
    assert.equal(hooks.isUsingKernel(), false, 'starts standalone until kernel attaches');

    const kernel = createMagaKernel();
    hooks.attachKernel(kernel);
    const offImmediate = kernel.registerImmediateMutationHandler(hooks.handleImmediateMutation);
    kernel.register({
      id: 'custom-ux',
      topics: ['all'],
      write: (snap) => hooks.syncByTopics(snap.topics),
      dispose: () => {
        offImmediate?.();
        hooks.detachKernel?.();
      },
    });
    kernel.start();

    assert.equal(hooks.isUsingKernel(), true, 'custom runtime runs under unified MagaKernel');
    const st = kernel.getStats();
    assert.equal(st.observerCount, 1, 'exactly 1 root MutationObserver when custom-ux + kernel are active');
    assert.ok(st.features.includes('custom-ux'));

    kernel.markDirty(['stream'], false);
    kernel.flush();
    kernel.markDirty(['composer'], false);
    kernel.flush();

    kernel.dispose();
    win.__agClaudeUxDispose();
    assert.equal(win.__agClaudeUxKernelHooks, null, 'dispose clears __agClaudeUxKernelHooks');
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    win.close();
  }
});

test('capsule-picker mounts MAGA capsule in Project Detail composer, uses downward popover near top, and tears down on close', async () => {
  const { syncModelPicker: realSyncModelPicker } = await import(
    pathToFileURL(path.join(REPO, 'vendor', 'agy-capsule', 'model_picker.mjs')).href
  );
  const env = makeMockDomEnv({ pathname: '/projects', lang: 'en', width: 1200 });
  await withGlobals(env, () => {
    const pv = env.createEl('section');
    pv.id = 'ag-claude-projects-view';
    pv.setAttribute('data-open', 'true');
    const right = env.createEl('div');
    right.className = 'ag-pd-composer-right';
    right.checkVisibility = () => true;
    const pdBtn = env.createEl('button');
    pdBtn.id = 'ag-pd-model-btn';
    pdBtn.setAttribute('data-ag-pd-model-trigger', 'true');
    pdBtn.textContent = 'Claude Opus 5.5 Medium';
    const sendBtn = env.createEl('button');
    sendBtn.className = 'ag-pd-send-btn';
    right.append(pdBtn, sendBtn);
    pv.append(right);
    env.doc.body.append(pv);

    const origCreate = env.doc.createElement;
    env.doc.createElement = (tag) => {
      const el = origCreate(tag);
      el.attachShadow = () => {
        const sr = origCreate('shadow-root');
        sr.getElementById = (id) => sr.querySelector(`#${id}`);
        el.shadowRoot = sr;
        return sr;
      };
      return el;
    };

    const picker = createCapsulePickerRuntime({
      prefs: {
        modelEffortPicker: true,
        showEffortBar: true,
        customizeModelList: true,
        hiddenModels: ['Gemini 4 Argon'],
        claudeTheme: 'matrix',
      },
      labelsByLang: {
        en: { modelEffortPicker: 'Enhanced model capsule', effortLevel: 'Effort level' },
        'zh-CN': { modelEffortPicker: '优化模型胶囊', effortLevel: '思考强度' },
      },
      shadowCss: '',
      syncModelPicker: (root) => {
        if (!root.querySelector('button.dk-pill[data-el="modelPicker"]')) {
          const btn = env.createEl('button');
          btn.className = 'dk-pill';
          btn.setAttribute('data-el', 'modelPicker');
          const tw = env.createEl('span');
          tw.className = 'dk-mp-text';
          tw.textContent = pdBtn.textContent;
          btn.append(tw);
          root.append(btn);
        }
      },
      effortEffects: () => ({ applySidecarPrefs() {} }),
      motionThemes,
      shortenModelName,
      shortenEffortBadge,
    });

    picker.sync(() => {});
    const host = right.querySelector('[data-agy-pd-picker-host="1"]');
    assert.ok(host?.shadowRoot, 'Project Detail composer mounts shadow capsule host');
    assert.equal(host.id || '', '', 'Project Detail host must not claim main composer HOST_ID');
    assert.equal(pdBtn.getAttribute('data-agy-model-wrap'), '1', 'native #ag-pd-model-btn wrapped for hiding');
    const capBtn = host.shadowRoot.querySelector('button.dk-pill[data-el="modelPicker"]');
    assert.equal(capBtn?.querySelector('.dk-mp-name')?.textContent, 'Claude Opus 5.5 Medium');

    // Closing Projects view must tear down the Project Detail capsule cleanly and unwrap #ag-pd-model-btn
    pv.setAttribute('data-open', 'false');
    picker.sync(() => {});
    assert.equal(right.querySelector('[data-agy-pd-picker-host="1"]'), null, 'capsule torn down on close');
    assert.equal(pdBtn.getAttribute('data-agy-model-wrap'), null, 'native button unwrapped on close');
    picker.dispose();
  });

  // Also verify vendor/agy-capsule/model_picker.mjs resolves getProjectModelSelector & opens downward when spaceAbove < 380
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="ag-claude-projects-view" data-open="true"><div class="ag-pd-composer-right"><button id="ag-pd-model-btn" data-ag-pd-model-trigger="true">Orchestrator</button></div></div></body></html>',
    { url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document', 'innerWidth', 'innerHeight', 'localStorage'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 900;
  globalThis.localStorage = w.localStorage;
  try {
    let selectedModel = { label: 'Claude Opus 5.5 (Medium)', value: 201, modelId: 'claude-opus-5-5' };
    const modelOptions = [
      { label: 'Gemini 4 Argon (Low)', value: 101, modelId: 'g4-argon' },
      selectedModel,
      { label: 'Claude Opus 5.5 (High)', value: 202, modelId: 'claude-opus-5-5' },
    ];
    w.__agClaudeUxBridge = {
      getProjectModelSelector: () => ({
        isReduxFallback: true,
        modelOptions,
        selectedModel,
        setSelectedModel: (o) => { selectedModel = o; },
      }),
    };
    const root = d.createElement('div');
    const right = d.querySelector('.ag-pd-composer-right');
    right.prepend(root);
    realSyncModelPicker(
      root,
      right,
      {
        modelEffortPicker: true,
        showEffortBar: true,
        customizeModelList: true,
        hiddenModels: ['Gemini 4 Argon'],
        claudeTheme: 'matrix',
      },
      { modelEffortPicker: 'Enhanced model capsule', effortLevel: 'Effort level' },
      () => right
    );
    const btn = root.querySelector('button.dk-pill[data-el="modelPicker"]');
    const panel = root.querySelector('.dk-model-options');
    assert.ok(btn && panel, 'model_picker mounts pill & options popover for Project Detail trigger');
    const visibleModels = [...root.querySelectorAll('.dk-model-row')].map((r) => r.dataset.family);
    assert.equal(visibleModels.includes('Gemini 4 Argon'), false, 'hiddenModels filter applies in Project Detail');
    assert.equal(visibleModels.includes('Claude Opus 5.5'), true);

    btn.getBoundingClientRect = () => ({ left: 500, right: 640, top: 240, bottom: 266, width: 140, height: 26 });
    const ev = new w.Event('beforetoggle');
    ev.newState = 'open';
    panel.dispatchEvent(ev);
    assert.equal(panel.style.top, '272px', 'opens downward when button sits in upper half of Project Detail');
    assert.equal(panel.style.bottom, 'auto');
    root._modelPicker?.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('readProjectWorkspaceStatusAsync & handleProjectRpcRequest return Git commits/branch/version/dirty/remote safely and reject unsafe dirs', async () => {
  const { readProjectWorkspaceStatusAsync, readGitCommitDetailAsync, handleProjectRpcRequest } = await import(
    pathToFileURL(path.join(REPO, 'core', 'daemon', 'overview-skills.mjs')).href
  );
  const { normalizeGitRemoteUrl, openExternalUrl } = await import(
    pathToFileURL(path.join(REPO, 'core', 'daemon', 'projects.mjs')).href
  );
  const direct = await readProjectWorkspaceStatusAsync(REPO, { force: true });
  assert.equal(direct.ok, true);
  assert.equal(direct.dirPath, REPO);
  assert.equal(direct.pkgVersion, '1.2.0');
  assert.ok(Array.isArray(direct.scripts) && direct.scripts.includes('test'));
  assert.ok(direct.git && direct.git.branch, 'detects live git branch');
  assert.ok(Array.isArray(direct.recentCommits) && direct.recentCommits.length >= 1);
  assert.ok(direct.recentCommits[0].hash && direct.recentCommits[0].fullHash && direct.recentCommits[0].subject);
  assert.ok(Array.isArray(direct.dirtyFiles));
  assert.match(direct.remoteUrl || '', /github\.com\/LiWithDream\/(MAGA|agy-studio)/i);
  assert.ok(typeof direct.latestTag === 'string' && direct.latestTag.startsWith('v'));

  const detailOk = await readGitCommitDetailAsync(REPO, direct.recentCommits[0].hash);
  assert.equal(detailOk.ok, true);
  assert.equal(detailOk.fullHash, direct.recentCommits[0].fullHash);
  assert.ok(Array.isArray(detailOk.files));
  const detailBad = await readGitCommitDetailAsync(REPO, 'bad;rm');
  assert.equal(detailBad.ok, false);
  assert.equal(detailBad.error, 'invalid_commit_hash');

  assert.deepEqual(normalizeGitRemoteUrl('git@github.com:LiWithDream/MAGA.git'), {
    url: 'https://github.com/LiWithDream/MAGA',
    label: 'LiWithDream/MAGA',
  });
  assert.equal(openExternalUrl('file:///etc/passwd').ok, false);

  const rpcOk = await handleProjectRpcRequest(
    JSON.stringify({
      reqId: 'ws-1',
      action: 'readProjectWorkspaceStatus',
      payload: { dirPath: REPO },
    })
  );
  assert.equal(rpcOk?.reqId, 'ws-1');
  assert.equal(rpcOk?.result?.ok, true);
  assert.equal(rpcOk?.result?.pkgVersion, '1.2.0');

  const unsafeEtc = await readProjectWorkspaceStatusAsync('/etc');
  assert.equal(unsafeEtc.ok, false);
  assert.equal(unsafeEtc.error, 'invalid_project_dir');
  const unsafeRoot = await readProjectWorkspaceStatusAsync('/');
  assert.equal(unsafeRoot.ok, false);
});

test('Projects Cockpit renders left Hero, interactive Git dirty/commit drawers, remote links, Quick Actions, Switcher & 3-state Grid sort', async () => {
  const { JSDOM } = await import('jsdom');
  const { createProjectsModule } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'projects', 'index.mjs')).href
  );

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document', 'location', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;
  globalThis.location = w.location;
  globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);

  try {
    const mockState = {
      sidebarProjects: {
        projects: [
          { id: 'proj-maga', name: 'MAGA', folderUris: ['file:///tmp/maga-repo'] },
          { id: 'proj-remote', name: 'RemoteRepo', folderUris: [], remoteUrl: 'https://github.com/LiWithDream/MAGA' },
        ],
      },
      trajectorySummaries: {
        summaries: {},
        indexes: { byProject: { 'proj-maga': [], 'proj-remote': [] } },
      },
    };
    const rpcCalls = [];
    const sampleCtx = {
      ok: true,
      dirPath: '/tmp/maga-repo',
      gitBranch: 'main',
      remoteUrl: 'https://github.com/LiWithDream/MAGA',
      remoteLabel: 'LiWithDream/MAGA',
      instructions: '# MAGA — Project Rules\n\n> Core note\n\n**Single** root `MagaKernel` observer only.',
      files: [{ name: 'CHANGELOG.md', relPath: 'CHANGELOG.md', absPath: '/tmp/maga-repo/CHANGELOG.md', inlined: true, sizeText: '1.2 KB' }],
      extraFolders: [],
      scheduledTasks: [],
      lastModifiedMs: Date.now(),
    };
    w.__agProjectCall = async (action, payload) => {
      rpcCalls.push({ action, payload });
      if (action === 'listContexts') {
        const contexts = {};
        for (const p of payload.paths || []) contexts[p] = { ...sampleCtx, dirPath: p };
        return { ok: true, contexts, projectMtimes: {} };
      }
      if (action === 'readContext') {
        return { ...sampleCtx, dirPath: payload.dirPath };
      }
      if (action === 'readProjectWorkspaceStatus') {
        return {
          ok: true,
          dirPath: payload.dirPath,
          git: { branch: 'main', changedFiles: 2, added: 14, deleted: 3 },
          remoteUrl: 'https://github.com/LiWithDream/MAGA',
          remoteLabel: 'LiWithDream/MAGA',
          dirtyFiles: [{ path: 'studio/entry.mjs', status: 'M', added: 5, deleted: 1 }],
          recentCommits: [
            { hash: 'abc1234', fullHash: 'abc1234567890abcdef1234567890', subject: 'feat: Projects Cockpit UI', relTime: '2 hours ago' },
          ],
          latestTag: 'v1.0.0',
          pkgVersion: '1.1.0',
          scripts: ['test', 'deploy', 'doctor'],
          fetchedAt: Date.now(),
        };
      }
      if (action === 'readGitCommitDetail') {
        return {
          ok: true,
          fullHash: 'abc1234567890abcdef1234567890',
          hash: 'abc1234',
          author: 'Dev',
          date: '2026-11-25',
          subject: 'feat: Projects Cockpit UI',
          body: 'Detailed notes',
          files: [{ path: 'user/custom.css', added: 10, deleted: 2 }],
          totalFiles: 1,
        };
      }
      if (action === 'openExternalUrl') return { ok: true, url: payload.url };
      if (action === 'revealFile') return { ok: true };
      return { ok: false };
    };

    const escapeHtml = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const rt = {
      FEAT: { projects: true, i18n: false },
      L: (_zh, en) => en,
      state: { disposed: false },
      frame: (cb) => setTimeout(cb, 0),
      later: (cb, ms) => setTimeout(cb, ms),
      escapeHtml,
      setLeafText: (el, txt) => { if (el) el.textContent = txt; },
      syncAttrTargetSet: () => {},
      hooks: {
        activeReactFiber: () => null,
        findSidebarBindings: () => ({ store: { getState: () => mockState }, router: null }),
        isSidebarVisibleSummary: () => true,
        isSummaryPinned: () => false,
        protoSeconds: (v) => Number(v?.seconds || 0),
      },
    };
    const modelApi = {
      displayEffortLabel: (e) => e,
      buildReduxModelSelectorApi: () => null,
      discoverModelSelectorApi: () => null,
      buildModelCatalog: () => ({ primaryFamilies: [], moreFamilies: [] }),
      pickVariantForFamily: () => null,
      formatProjectComposerModelParts: () => ({ name: 'Orchestrator', effort: 'Neon High' }),
      syncProjectDetailModelTrigger: () => {},
      applyModelSelectionOption: () => {},
    };

    const projMod = createProjectsModule(rt, modelApi);
    projMod.openProjectsView('proj-maga');
    await new Promise((r) => setTimeout(r, 35));

    const view = d.getElementById('ag-claude-projects-view');
    // Streamlined layout: Hero sits inside .ag-pd-left, `...` menu sits in topbar, no redundant copy/refresh icons
    assert.ok(view.querySelector('.ag-pd-left .ag-pd-hero'), 'Hero Header sits inside .ag-pd-left so right rail starts at top');
    assert.ok(view.querySelector('.ag-pd-topbar [data-ag-pd-proj-menu]'), 'More menu button moved to topbar');
    assert.equal(view.querySelector('[data-ag-pd-copy-path]'), null, 'omits redundant copy button');
    assert.equal(view.querySelector('[data-ag-pd-refresh-ws]'), null, 'omits redundant refresh button');
    assert.equal(view.querySelector('.ag-pd-ver-badge')?.textContent, 'v1.0.0');
    assert.match(view.querySelector('.ag-pd-meta-git')?.textContent || '', /main.*2 modified/);
    assert.ok(view.querySelector('[data-ag-pd-open-finder]'), 'path chip acts as Open in Finder trigger');

    // Interactive dirty drawer + mention dirty file
    view.querySelector('[data-ag-pd-toggle-dirty]').click();
    assert.ok(view.querySelector('[data-ag-pd-dirty-drawer]'), 'expands dirty files drawer');
    view.querySelector('[data-ag-pd-mention-rel="studio/entry.mjs"]').click();
    assert.match(d.getElementById('ag-pd-composer-input').value, /@\[entry\.mjs\]/, 'mentions dirty file into composer');

    // Interactive commit row expands commit detail + Remote Commit link
    view.querySelector('[data-ag-pd-commit-hash="abc1234"]').click();
    await new Promise((r) => setTimeout(r, 25));
    const cDetail = view.querySelector('[data-ag-pd-commit-detail="abc1234"]');
    assert.ok(cDetail, 'expands commit detail inline');
    assert.match(cDetail.textContent, /user\/custom\.css/);
    assert.ok(
      cDetail.querySelector('[data-ag-pd-open-remote="https://github.com/LiWithDream/MAGA/commit/abc1234567890abcdef1234567890"]'),
      'renders Remote commit URL'
    );

    // Clean Markdown preview (at most 3 body lines)
    const instRich = view.querySelector('.ag-pd-inst-rich');
    assert.ok(instRich, 'renders structured Instructions preview');
    assert.equal(/\*\*|`|# /.test(instRich.textContent), false, 'strips raw markdown syntax');

    // Empty-state Quick Starters fill composer
    const starters = view.querySelectorAll('.ag-pd-ready-card [data-ag-pd-starter-prompt]');
    assert.equal(starters.length, 4, 'renders 4 starter tiles when empty');
    starters[0].click();
    assert.equal(view.querySelector('[data-ag-pd-send]').disabled, false, 'enables send button');

    // Populate 4 conversations: quick strip + search filter + breadcrumb switcher -> Remote project external URL
    mockState.trajectorySummaries.indexes.byProject['proj-maga'] = ['c1', 'c2', 'c3', 'c4'];
    mockState.trajectorySummaries.summaries = {
      c1: { summary: 'Fix picker regression', lastModifiedTime: { seconds: 400 } },
      c2: { summary: 'Refactor MagaKernel loops', lastModifiedTime: { seconds: 300 } },
      c3: { summary: 'Release v1.1.0 changelog', lastModifiedTime: { seconds: 200 } },
      c4: { summary: 'Update README images', lastModifiedTime: { seconds: 100 } },
    };
    projMod.openProjectsView('proj-maga');
    assert.ok(view.querySelector('.ag-pd-quick-strip'), 'renders single-row quick actions strip when project has chats');
    assert.ok(view.querySelector('[data-ag-pd-chat-usage="c1"]'), 'renders per-chat usage badge placeholder');

    const searchEl = d.getElementById('ag-pd-chat-search');
    assert.ok(searchEl, 'renders #ag-pd-chat-search when >= 4 conversations exist');
    assert.equal(view.querySelectorAll('.ag-pd-chat-row').length, 4);
    searchEl.value = 'kernel';
    searchEl.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(view.querySelectorAll('.ag-pd-chat-row').length, 1);

    // Breadcrumb project switcher -> RemoteRepo -> click remote link triggers openExternalUrl
    view.querySelector('[data-ag-pd-crumb-toggle]').click();
    assert.ok(view.querySelector('.ag-pd-crumb-menu'), 'opens breadcrumb project switcher');
    view.querySelector('[data-ag-pd-crumb-select="proj-remote"]').click();
    await new Promise((r) => setTimeout(r, 20));
    const remoteBtn = view.querySelector('.ag-pd-meta-remote[data-ag-pd-open-remote]');
    assert.ok(remoteBtn, 'renders clickable remote repo chip for remote project');
    remoteBtn.click();
    assert.ok(
      rpcCalls.some((c) => c.action === 'openExternalUrl' && c.payload?.url === 'https://github.com/LiWithDream/MAGA'),
      'clicking remote chip invokes openExternalUrl'
    );

    // Back to Grid & test 3-state sorting (Recent -> Usage -> Name)
    view.querySelector('[data-ag-pd-back]').click();
    w.dispatchEvent(
      new w.CustomEvent('agy:projects-usage-updated', {
        detail: {
          byProject: {
            'proj-maga': { totalTokens: 5000, requests: 2 },
            'proj-remote': { totalTokens: 90000, requests: 10 },
          },
        },
      })
    );
    const sortBtn = view.querySelector('[data-ag-proj-sort]');
    assert.match(sortBtn.textContent, /Recent/);
    sortBtn.click();
    assert.match(view.querySelector('[data-ag-proj-sort]').textContent, /Usage/);
    const cardsInUsageOrder = [...view.querySelectorAll('.ag-proj-card')].map((c) => c.getAttribute('data-ag-proj-id'));
    assert.deepEqual(cardsInUsageOrder, ['proj-remote', 'proj-maga'], 'Usage sort puts higher-token project first');

    projMod.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('Stage 6: createUsageHistory summarizeForIds and summarizeGroups aggregate per-project usage in memory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'maga-usage-hist-'));
  try {
    for (const cid of ['c1', 'c2', 'c3']) {
      writeFileSync(path.join(dir, `${cid}.db`), `${cid}-sqlite-stub`);
    }
    let readCalls = 0;
    const tToday = new Date();
    tToday.setHours(10, 0, 0, 0);
    const todayMs = tToday.getTime();
    const byCid = {
      c1: [
        { id: 'r1', at: todayMs, model: 'Claude Opus 4.6 (High)', uncached: 100, cacheRead: 900, cacheWrite: 200, output: 300 },
        { id: 'dup', at: todayMs, model: 'Claude Opus 4.6 (High)', uncached: 50, cacheRead: 0, cacheWrite: 0, output: 50 },
      ],
      c2: [
        { id: 'dup', at: todayMs, model: 'Claude Opus 4.6 (High)', uncached: 200, cacheRead: 1000, cacheWrite: 100, output: 200 },
      ],
      c3: [
        { id: 'r3', at: todayMs, model: 'Gemini 3.1 Pro (Medium)', uncached: 400, cacheRead: 600, cacheWrite: 0, output: 500 },
      ],
    };
    const history = createUsageHistory({
      directories: [dir],
      recentMs: 0,
      readRequests: (dbPath) => {
        readCalls += 1;
        const cid = path.basename(dbPath, '.db');
        return byCid[cid] || [];
      },
    });

    const base = await history.read();
    assert.equal(readCalls, 3, 'initial scan reads each conversation DB once');
    assert.equal(base.days.length, 1);

    // Query subsets without triggering extra disk reads
    const sub = history.summarizeForIds(['c1', 'c2']);
    assert.equal(readCalls, 3, 'summarizeForIds uses cached request rows only');
    assert.equal(sub.globalTotalTokens, 4500, 'globalTotalTokens sums deduplicated total across all DBs (1500+1500+1500)');
    assert.equal(sub.days[0].requests, 2, 'deduplicates shared dup request between c1 and c2');
    assert.equal(sub.byChat.c1.totalTokens, 1600, 'per-chat breakdown retains c1 total');
    assert.equal(sub.byChat.c2.totalTokens, 1500, 'per-chat breakdown retains c2 total');
    assert.equal(
      sub.days[0].uncached + sub.days[0].cacheRead + sub.days[0].cacheWrite + sub.days[0].output,
      3000
    );

    const empty = history.summarizeForIds([]);
    assert.equal(empty.days.length, 0);
    assert.equal(empty.globalTotalTokens, 4500);
    assert.deepEqual(empty.byChat, {});

    const grouped = history.summarizeGroups({
      pA: ['c1', 'c2'],
      pB: ['c3'],
      pEmpty: [],
    });
    assert.equal(readCalls, 3, 'summarizeGroups executes purely in memory');
    assert.deepEqual(grouped.byProject, {
      pA: { totalTokens: 3000, requests: 2 },
      pB: { totalTokens: 1500, requests: 1 },
      pEmpty: { totalTokens: 0, requests: 0 },
    });

    // Descendant / swarm Opus worker expansion (child -> grandchild) without double-counting
    const cChild = 'child-opus-1';
    const cGrand = 'grand-opus-2';
    writeFileSync(path.join(dir, `${cChild}.db`), 'child-stub');
    writeFileSync(path.join(dir, `${cGrand}.db`), 'grand-stub');
    const historyTree = createUsageHistory({
      directories: [dir],
      recentMs: 0,
      readRequests: (dbPath) => {
        const cid = path.basename(dbPath, '.db');
        if (cid === 'c1') return { parentId: '', rootId: '', requests: byCid.c1 };
        if (cid === 'c2') return { parentId: '', rootId: '', requests: byCid.c2 };
        if (cid === 'c3') return { parentId: '', rootId: '', requests: byCid.c3 };
        if (cid === cChild) {
          return {
            parentId: 'c1',
            rootId: 'c1',
            requests: [
              { id: 'opus-1', at: todayMs, model: 'Claude Opus 5.5 (High)', uncached: 500, cacheRead: 1500, cacheWrite: 0, output: 200 },
            ],
          };
        }
        if (cid === cGrand) {
          return {
            parentId: cChild,
            rootId: 'c1',
            requests: [
              { id: 'opus-2', at: todayMs, model: 'Claude Opus 5.5 (High)', uncached: 300, cacheRead: 400, cacheWrite: 0, output: 100 },
              { id: 'opus-1', at: todayMs, model: 'Claude Opus 5.5 (High)', uncached: 500, cacheRead: 1500, cacheWrite: 0, output: 200 },
            ],
          };
        }
        return [];
      },
    });
    await historyTree.read();
    const treeForTopOnly = historyTree.summarizeForIds(['c1']);
    assert.equal(treeForTopOnly.byChat.c1.totalTokens, 1600 + 2200 + 800, 'byChat expands Opus child + grandchild into parent chat');
    assert.equal(treeForTopOnly.byChat.c1.requests, 4, 'byChat deduplicates shared request IDs across descendants');
    const opusDayModel = treeForTopOnly.days[0].models.find((m) => m.name === 'Claude Opus 5.5 (High)');
    assert.equal(
      opusDayModel ? opusDayModel.uncached + opusDayModel.cacheRead + opusDayModel.cacheWrite + opusDayModel.output : 0,
      3000,
      'summarizeForIds includes descendant Opus tokens in project days breakdown'
    );
    const treeBothPassed = historyTree.summarizeForIds(['c1', cChild]);
    const opusBoth = treeBothPassed.days[0].models.find((m) => m.name === 'Claude Opus 5.5 (High)');
    assert.equal(
      opusBoth.uncached + opusBoth.cacheRead + opusBoth.cacheWrite + opusBoth.output,
      3000,
      'passing both parent and child IDs never double-counts descendant Opus usage'
    );
    const groupedTree = historyTree.summarizeGroups({ pA: ['c1', 'c2'], pB: ['c3'] });
    assert.equal(groupedTree.byProject.pA.totalTokens, 1600 + 1500 - 100 + 3000, 'summarizeGroups expands descendant Opus tokens into owning project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stage 6: createProjectUsageRuntime renders detail usage card, hero badge, and grid badges', async () => {
  const { JSDOM } = await import('jsdom');
  const dNow = new Date();
  const todayStr = `${dNow.getFullYear()}-${String(dNow.getMonth() + 1).padStart(2, '0')}-${String(dNow.getDate()).padStart(2, '0')}`;
  const dom = new JSDOM(
    `<!doctype html><html><body lang="en">
      <section id="ag-claude-projects-view" data-open="true">
        <div class="ag-pd-hero"><span id="agy-pd-hero-usage" class="ag-pd-meta-chip ag-pd-meta-usage" hidden></span></div>
        <button class="ag-pd-chat-row" data-ag-pd-chat="c1"><span class="ag-pd-chat-usage" data-ag-pd-chat-usage="c1" hidden></span></button>
        <aside class="ag-pd-right">
          <div id="agy-pd-usage-slot" data-maga-own="1" data-ag-pd-proj-id="p-empty" data-ag-pd-chat-ids=""></div>
        </aside>
      </section>
    </body></html>`,
    { url: 'http://127.0.0.1/' }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document', 'location', 'localStorage', 'CustomEvent'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;
  globalThis.location = w.location;
  globalThis.localStorage = w.localStorage;
  globalThis.CustomEvent = w.CustomEvent;

  try {
    const rpcCalls = [];
    w.__agProjectCall = async (action, payload) => {
      rpcCalls.push({ action, payload });
      if (action === 'getUsageStats' && payload?.projectGroups) {
        return {
          ok: true,
          generatedAt: Date.now(),
          globalTotalTokens: 30000,
          byProject: {
            p1: { totalTokens: 15000, requests: 8 },
            p2: { totalTokens: 0, requests: 0 },
          },
        };
      }
      if (action === 'getUsageStats' && Array.isArray(payload?.conversationIds)) {
        return {
          ok: true,
          generatedAt: Date.now(),
          globalTotalTokens: 30000,
          unread: 0,
          conversationCount: payload.conversationIds.length,
          byChat: {
            c1: { totalTokens: 12300, requests: 5 },
          },
          undated: { requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          days: [
            {
              date: todayStr,
              requests: 8,
              uncached: 2000,
              cacheRead: 10000,
              cacheWrite: 1000,
              output: 2000,
              models: [
                {
                  name: 'Claude Opus 4.6 (High)',
                  requests: 8,
                  uncached: 2000,
                  cacheRead: 10000,
                  cacheWrite: 1000,
                  output: 2000,
                },
              ],
            },
          ],
        };
      }
      return { ok: false };
    };

    const studioPrefs = {
      get: () => ({ overviewUsageDefaultPeriod: 'day' }),
      subscribe: () => () => {},
    };
    const projUsage = createProjectUsageRuntime({ motionThemes: () => motionThemes, studioPrefs });

    // Case A: empty project renders compact empty state with zero RPC calls
    projUsage.sync();
    assert.equal(rpcCalls.length, 0, 'empty project skips daemon getUsageStats call');
    const cardA = d.getElementById('agy-pd-usage-card');
    assert.ok(cardA, 'mounts #agy-pd-usage-card');
    assert.equal(cardA.getAttribute('data-empty'), 'true');
    assert.equal(d.getElementById('agy-pd-hero-usage').hidden, true);

    // Case B: project with conversations fetches filtered stats & renders charts + hero pill
    const slot = d.getElementById('agy-pd-usage-slot');
    slot.setAttribute('data-ag-pd-proj-id', 'p-maga');
    slot.setAttribute('data-ag-pd-chat-ids', 'c1,c2');
    w.dispatchEvent(new w.CustomEvent('agy:projects-rendered'));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(rpcCalls[0].payload.conversationIds, ['c1', 'c2']);
    const cardB = d.getElementById('agy-pd-usage-card');
    assert.equal(cardB.getAttribute('data-empty'), 'false');
    assert.equal(cardB.querySelectorAll('.agy-usage-kpi').length, 3);
    assert.equal(cardB.querySelectorAll('.agy-usage-model-row').length, 1);
    assert.match(cardB.querySelector('.agy-usage-share-tag')?.textContent || '', /50%/);
    const heroBadge = d.getElementById('agy-pd-hero-usage');
    assert.equal(heroBadge.hidden, false);
    assert.match(heroBadge.textContent, /15\.0k/);
    const chatUsageBadge = d.querySelector('[data-ag-pd-chat-usage="c1"]');
    assert.equal(chatUsageBadge.hidden, false, 'populates per-chat usage badge');
    assert.equal(chatUsageBadge.textContent, '12.3k');

    // Period switching (Day -> Week)
    const weekBtn = cardB.querySelector('[data-agy-usage-period="week"]');
    weekBtn.click();
    assert.equal(cardB.querySelector('.agy-usage-chart')?.getAttribute('data-period'), 'week');

    // Case C: Projects Grid batched lookup + usage update event
    let gridEventDetail = null;
    w.addEventListener('agy:projects-usage-updated', (ev) => {
      gridEventDetail = ev.detail;
    });
    const view = d.getElementById('ag-claude-projects-view');
    view.innerHTML = `<div class="ag-proj-grid">
      <article class="ag-proj-card" data-ag-proj-id="p1" data-ag-proj-chat-ids="c1,c2">
        <span class="ag-proj-card-usage" data-ag-proj-usage-badge="p1" hidden></span>
      </article>
      <article class="ag-proj-card" data-ag-proj-id="p2" data-ag-proj-chat-ids="">
        <span class="ag-proj-card-usage" data-ag-proj-usage-badge="p2" hidden></span>
      </article>
    </div>`;
    w.dispatchEvent(new w.CustomEvent('agy:projects-rendered'));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(rpcCalls.length, 2);
    assert.deepEqual(rpcCalls[1].payload.projectGroups, { p1: ['c1', 'c2'], p2: [] });
    const badge1 = view.querySelector('[data-ag-proj-usage-badge="p1"]');
    const badge2 = view.querySelector('[data-ag-proj-usage-badge="p2"]');
    assert.equal(badge1.hidden, false);
    assert.equal(badge1.textContent, '15.0k');
    assert.equal(badge2.hidden, true);
    assert.equal(gridEventDetail?.byProject?.p1?.totalTokens, 15000);

    projUsage.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('capsule picker isolates [role="status"] inline-size and soft-intercepts locked/busy model clicks without 3s error', async () => {
  const pickerCssSrc = readFileSync(path.join(REPO, 'studio', 'modules', 'capsule-picker.mjs'), 'utf8');
  assert.match(
    pickerCssSrc,
    /\.dk-model-options\s*>\s*:is\([^)]*\[role="status"\][^)]*\)\s*\{\s*contain:\s*inline-size;/,
    'status banner must be inline-size contained so error/busy text never widens the capsule popover'
  );
  assert.match(
    pickerCssSrc,
    /\.dk-model-options\s*>\s*\[role="status"\]\[data-tone="muted"\]/,
    'muted tone style exists for busy notice'
  );

  const { syncModelPicker: realSyncModelPicker } = await import(
    pathToFileURL(path.join(REPO, 'vendor', 'agy-capsule', 'model_picker.mjs')).href
  );
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html data-ag-ux-lang="zh-CN"><body><div id="ag-claude-projects-view" data-open="true"><div class="ag-pd-composer-right"><button id="ag-pd-model-btn" data-ag-pd-model-trigger="true" aria-disabled="true">Gemini 4 Carbon (High)</button></div></div></body></html>',
    { url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document', 'innerWidth', 'innerHeight', 'localStorage'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 900;
  globalThis.localStorage = w.localStorage;
  try {
    let chooseCalls = 0;
    const modelA = { label: 'Gemini 4 Carbon (High)', value: 1, modelId: 'g4-carbon-high' };
    const modelB = { label: 'Gemini 4 Neon (High)', value: 2, modelId: 'g4-neon-high' };
    w.__agClaudeUxBridge = {
      getProjectModelSelector: () => ({
        modelOptions: [modelA, modelB],
        selectedModel: modelA,
        lockedReason: 'Model cannot be changed while the agent is running',
        setSelectedModel: () => { chooseCalls += 1; },
      }),
    };
    const root = d.createElement('div');
    const right = d.querySelector('.ag-pd-composer-right');
    right.prepend(root);
    realSyncModelPicker(
      root,
      right,
      { modelEffortPicker: true, showEffortBar: false },
      { modelEffortPicker: '优化模型胶囊' },
      () => right
    );
    const panel = root.querySelector('.dk-model-options');
    const status = panel.querySelector('[role="status"]');
    const neonRow = [...panel.querySelectorAll('button.dk-model-row')].find((r) => r.dataset.label === modelB.label);
    assert.ok(neonRow, 'target model row rendered');
    neonRow.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(chooseCalls, 0, 'does not invoke host setSelectedModel while locked');
    assert.equal(status.dataset.tone, 'muted', 'uses subtle muted tone instead of red error');
    assert.equal(status.textContent, '生成中，完成后可切换', 'shows concise localized busy hint immediately');

    // Closing popover clears the transient status immediately
    const closeEv = new w.Event('beforetoggle');
    closeEv.newState = 'closed';
    panel.dispatchEvent(closeEv);
    assert.equal(status.textContent, '', 'closing popover clears status text');
    assert.equal(status.dataset.tone, undefined, 'closing popover clears tone attribute');

    root._modelPicker?.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('Project Detail Redux-only model selector (no native trigger in DOM) preserves standalone Orchestrator dock instead of flat Orchestrator (Carbon/Neon) rows', async () => {
  const { createModelApi } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'core', 'model-api.mjs')).href
  );
  const { syncModelPicker: realSyncModelPicker } = await import(
    pathToFileURL(path.join(REPO, 'vendor', 'agy-capsule', 'model_picker.mjs')).href
  );
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="ag-claude-projects-view" data-open="true"><div class="ag-pd-composer-right"><button id="ag-pd-model-btn" data-ag-pd-model-trigger="true">Gemini 4 Neon High</button></div></div></body></html>',
    { url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document', 'innerWidth', 'innerHeight', 'localStorage'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 900;
  globalThis.localStorage = w.localStorage;
  try {
    const dispatched = [];
    const reduxStore = {
      getState: () => ({
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', modelOrAlias: { choice: { value: 1532 } } },
              { label: 'Gemini 4 Neon (Medium)', modelId: 'gemini-4-neon-medium', modelOrAlias: { choice: { value: 1533 } } },
              { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon-high', modelOrAlias: { choice: { value: 1427 } } },
              { label: 'Gemini 4 Carbon (Medium)', modelId: 'gemini-4-carbon-medium', modelOrAlias: { choice: { value: 1437 } } },
              { label: 'Gemini 4 Hydrogen (High)', modelId: 'gemini-4-hydrogen-high', modelOrAlias: { choice: { value: 1525 } } },
              { label: 'Claude Opus 5.5 (High)', modelId: 'claude-opus-5-5-high', modelOrAlias: { choice: { value: 1402 } } },
              { label: 'Orchestrator (Neon)', modelId: 'gemini-pro-orchestrator-neon', modelOrAlias: { choice: { value: 1537 } } },
              { label: 'Orchestrator (Carbon)', modelId: 'gemini-pro-orchestrator', modelOrAlias: { choice: { value: 1667 } } },
              { label: 'Orchestrator (Argon)', modelId: 'gemini-pro-orchestrator-argon', modelOrAlias: { choice: { value: 1681 } } },
            ],
            clientModelSorts: [
              {
                name: 'Recommended',
                groups: [
                  {
                    groupName: '',
                    modelLabels: [
                      'Gemini 4 Neon (High)',
                      'Gemini 4 Neon (Medium)',
                      'Gemini 4 Carbon (High)',
                      'Gemini 4 Carbon (Medium)',
                      'Gemini 4 Hydrogen (High)',
                      'Orchestrator (Neon)',
                      'Orchestrator (Carbon)',
                      'Orchestrator (Argon)',
                      'Claude Opus 5.5 (High)',
                    ],
                  },
                ],
              },
            ],
            defaultOverrideModelConfig: { modelOrAlias: { choice: { value: 1532 } } },
          },
        },
        modelSelection: {
          default: { model: 1532 },
          orchestratorByConversation: {},
        },
      }),
      dispatch: (act) => dispatched.push(act),
    };
    const modelApi = createModelApi({
      L: (_zh, en) => en,
      later: (fn) => fn(),
      state: { disposed: false },
      hooks: { resolveProjectsStoreAndBindings: () => ({ store: reduxStore }) },
    });
    const pdBtn = d.getElementById('ag-pd-model-btn');
    assert.equal(d.querySelector('button[data-testid="model-selector-trigger"]'), null, 'no native trigger in DOM');

    w.__agClaudeUxBridge = {
      getProjectModelSelector: (btn) => modelApi.discoverModelSelectorApi(btn),
      getOrchestratorPrefModel: () => modelApi.getOrchestratorPrefModel(),
    };
    const root = d.createElement('div');
    const right = d.querySelector('.ag-pd-composer-right');
    right.prepend(root);
    realSyncModelPicker(
      root,
      right,
      { modelEffortPicker: true, showEffortBar: true },
      { modelEffortPicker: 'Enhanced model capsule', effortLevel: 'Effort level' },
      () => right
    );
    const panel = root.querySelector('.dk-model-options');
    const rowFamilies = [...panel.querySelectorAll('button.dk-model-row')].map((r) => r.dataset.family);
    const orchSlot = panel.querySelector('.dk-orch-slot');

    assert.equal(orchSlot.hidden, false, 'standalone Orchestrator dock toggle is visible even without native trigger');
    assert.equal(
      rowFamilies.some((f) => /orchestrator/i.test(f)),
      false,
      `Orchestrator (Carbon/Neon/Argon) must not leak into flat model rows, got: ${JSON.stringify(rowFamilies)}`
    );
    assert.deepEqual(
      rowFamilies,
      ['Gemini 4 Neon', 'Gemini 4 Carbon', 'Gemini 4 Hydrogen (High)', 'Claude Opus 5.5 (High)'],
      'model list stays clean and preserves standalone families'
    );

    root._modelPicker?.dispose();
    modelApi.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('Remote/cloud native trigger (orchestratorPick undefined, static Orchestrator (Neon/Carbon/Argon) options) folds into standalone Orchestrator dock and switches cleanly', async () => {
  const { syncModelPicker: realSyncModelPicker } = await import(
    pathToFileURL(path.join(REPO, 'vendor', 'agy-capsule', 'model_picker.mjs')).href
  );
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body><div class="footer"><button data-testid="model-selector-trigger">Orchestrator (Neon)</button></div></body></html>',
    { url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document', 'innerWidth', 'innerHeight', 'localStorage', 'requestAnimationFrame'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 900;
  globalThis.localStorage = w.localStorage;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  try {
    const modelOptions = [
      { label: 'Gemini 4 Neon (High)', value: 1532, modelId: 'gemini-4-neon-high' },
      { label: 'Gemini 4 Neon (Medium)', value: 1533, modelId: 'gemini-4-neon-medium' },
      { label: 'Gemini 4 Carbon (High)', value: 1427, modelId: 'gemini-4-carbon-high' },
      { label: 'Gemini 4 Carbon (Medium)', value: 1437, modelId: 'gemini-4-carbon-medium' },
      { label: 'Gemini 4 Hydrogen (High)', value: 1525, modelId: 'gemini-4-hydrogen-high' },
      { label: 'Claude Opus 5.5 (High)', value: 1402, modelId: 'claude-opus-5-5-high' },
      { label: 'Orchestrator (Neon)', value: 1537, modelId: 'gemini-pro-orchestrator-neon' },
      { label: 'Orchestrator (Carbon)', value: 1667, modelId: 'gemini-pro-orchestrator' },
      { label: 'Orchestrator (Argon)', value: 1681, modelId: 'gemini-pro-orchestrator-argon' },
    ];
    let selectedModel = modelOptions[6]; // Orchestrator (Neon)
    const selectedCalls = [];
    const selectorObj = {
      get selectedModel() { return selectedModel; },
      modelOptions,
      groups: [{ options: modelOptions }],
      orchestratorPick: undefined,
      orchestratorPlanners: [],
      bestOfNConfig: { isBestOfNEnabled: false },
      setSelectedModel(opt) {
        selectedCalls.push(opt.label);
        selectedModel = opt;
      },
    };
    const trig = d.querySelector('button[data-testid="model-selector-trigger"]');
    trig.__reactFiber$test = {
      memoizedProps: { placement: 'top-start', conversationId: undefined },
      return: { memoizedProps: { value: selectorObj }, return: null },
    };
    const footer = d.querySelector('.footer');
    const root = d.createElement('div');
    footer.prepend(root);
    realSyncModelPicker(
      root,
      footer,
      { modelEffortPicker: true, showEffortBar: true },
      { modelEffortPicker: 'Enhanced model capsule', effortLevel: 'Effort level' },
      () => footer
    );

    const panel = root.querySelector('.dk-model-options');
    const rowFamilies = [...panel.querySelectorAll('button.dk-model-row')].map((r) => r.dataset.family);
    const orchSlot = panel.querySelector('.dk-orch-slot');
    const orchBtn = orchSlot.querySelector('button');

    assert.equal(orchSlot.hidden, false, 'Orchestrator dock toggle is visible for static remote variants');
    assert.equal(orchBtn.getAttribute('aria-checked'), 'true', 'Orchestrator dock shows ON when Orchestrator (Neon) is selected');
    assert.equal(panel.querySelector('.agy-effort'), null, 'omits blank single-tier Effort bar for static remote Orchestrator');
    assert.equal(
      rowFamilies.some((f) => /orchestrator/i.test(f)),
      false,
      `Static Orchestrator (Neon/Carbon/Argon) must not appear as flat rows, got: ${JSON.stringify(rowFamilies)}`
    );

    // Clicking Carbon while Orchestrator is ON switches directly to native static Orchestrator (Carbon)
    const carbonRow = [...panel.querySelectorAll('button.dk-model-row')].find((r) => r.dataset.family === 'Gemini 4 Carbon');
    assert.ok(carbonRow, 'Gemini 4 Carbon row exists');
    carbonRow.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(selectedCalls.at(-1), 'Orchestrator (Carbon)', 'clicking Carbon while Orchestrator ON picks Orchestrator (Carbon)');

    // Toggling Orchestrator OFF switches to standalone Gemini 4 Carbon (Medium) and reveals Effort bar
    orchBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(selectedCalls.at(-1), 'Gemini 4 Carbon (Medium)', 'toggling Orchestrator OFF switches to standalone Carbon');
    assert.ok(panel.querySelector('.agy-effort'), 'Effort bar appears once switched to standalone multi-tier Carbon');

    // Toggling Orchestrator back ON switches back to Orchestrator (Carbon)
    orchBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(selectedCalls.at(-1), 'Orchestrator (Carbon)', 'toggling Orchestrator ON re-selects Orchestrator (Carbon)');

    root._modelPicker?.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('footer-capsules.css positions conversation scrollbar left of Overview, bounds track, and removes bottom spacers', () => {
  const css = readFileSync(FOOTER_CSS_PATH, 'utf8');
  assert.equal(css.includes(':has('), false, 'footer-capsules.css must contain zero :has() rules');
  assert.ok(
    css.includes('right: calc(var(--overview-panel-reserve, 0px) + var(--overview-panel-gutter-reserve, 0px) + 4px) !important;'),
    'scrollbar right offset tracks Overview reserve & gutter reserve'
  );
  assert.ok(css.includes('top: 6px !important;') && css.includes('bottom: 8px !important;'), 'track vertical insets set');
  assert.ok(css.includes('overflow: hidden !important;') && css.includes('align-items: flex-start !important;'), 'track clips and top-aligns thumb');
  assert.match(
    css,
    /\[data-testid="autoscroll-viewport"\]\s*>\s*div\s*>\s*div\[style\*="min-height"\],\s*\n\[data-testid="autoscroll-viewport"\]\s+\[style\*="75cqh"\]\s*\{[\s\S]*?min-height:\s*0\s*!important;/,
    'clears both cZc shrink-holder pixel min-height and 75cqh bottom blank-space min-height'
  );
});

test('scrollbar-clamp clamps thumb geometry, overscroll bounds, pointerover/ResizeObserver overwrites, and non-scrollable keyframes without extra MutationObserver', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div data-testid="conversation-view">
        <div data-autoscroll-overlay-host="true">
          <div data-testid="autoscroll-viewport"><div class="mx-auto"></div></div>
          <div data-testid="overlay-scrollbar" data-orientation="vertical">
            <div data-testid="overlay-scrollbar-thumb" style="width: 6px; height: 280px; transform: translate(0px, 600px);"></div>
          </div>
        </div>
      </div>
    </body></html>`,
    { url: 'http://127.0.0.1/', pretendToBeVisual: true }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document', 'MutationObserver', 'ResizeObserver'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));

  let observerCreations = 0;
  class CountingMutationObserver {
    constructor() { observerCreations += 1; }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  const resizeInstances = [];
  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = new Set();
      this.disconnected = false;
      resizeInstances.push(this);
    }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() {
      this.disconnected = true;
      this.observed.clear();
    }
    trigger() { this.cb([]); }
  }

  globalThis.window = w;
  globalThis.document = d;
  globalThis.MutationObserver = CountingMutationObserver;
  globalThis.ResizeObserver = MockResizeObserver;

  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

  try {
    const vp = d.querySelector('[data-testid="autoscroll-viewport"]');
    const vpContent = vp.firstElementChild;
    const track = d.querySelector('[data-testid="overlay-scrollbar"]');
    const thumb = d.querySelector('[data-testid="overlay-scrollbar-thumb"]');

    let vpScrollTop = 1000;
    let vpScrollHeight = 2400;
    Object.defineProperties(vp, {
      clientHeight: { value: 600, configurable: true },
      scrollHeight: { get: () => vpScrollHeight, configurable: true },
      scrollTop: { get: () => vpScrollTop, set: (v) => { vpScrollTop = v; }, configurable: true },
    });
    Object.defineProperty(track, 'clientHeight', { value: 586, configurable: true });

    let latestKeyframes = [
      { transform: 'translate(0px, 12px)' },
      { transform: 'translateY(720px)' },
    ];
    thumb.getAnimations = () => [{
      effect: {
        getKeyframes: () => latestKeyframes,
        setKeyframes: (kfs) => { latestKeyframes = kfs; },
      },
    }];

    // Direct clamp checks normal, negative overscroll, positive overscroll, start keyframe & translateY() reset
    // expected thumbH = round((600/2400)*586) = 147, maxOffset = 586 - 147 = 439
    assert.equal(clampOverlayScrollbar(track, vp), true);
    assert.equal(thumb.style.height, '147px');
    assert.equal(thumb.style.transform, 'translate(0px, 244px)');
    assert.equal(latestKeyframes[0].transform, 'translate(0px, 0px)');
    assert.equal(latestKeyframes[1].transform, 'translate(0px, 439px)');

    vpScrollTop = -120;
    clampOverlayScrollbar(track, vp);
    assert.match(thumb.style.transform, /^translate\(0px(?:,\s*0px)?\)$/);

    vpScrollTop = 9999;
    clampOverlayScrollbar(track, vp);
    assert.equal(thumb.style.transform, 'translate(0px, 439px)');

    // Non-scrollable viewport clamps stale ScrollTimeline animation keyframes down to 0px
    vpScrollHeight = 600;
    vpScrollTop = 0;
    thumb.style.height = '200px';
    latestKeyframes = [
      { transform: 'translate(0px, 0px)' },
      { transform: 'translate(0px, 439px)' },
    ];
    clampOverlayScrollbar(track, vp);
    assert.match(thumb.style.transform, /^translate\(0px(?:,\s*0px)?\)$/);
    assert.equal(latestKeyframes[1].transform, 'translate(0px, 0px)');

    // Restore scrollable height and bind runtime via MagaKernel lifecycle
    vpScrollHeight = 2400;
    vpScrollTop = 900;
    const rt = createScrollbarClampRuntime();
    const pairs = rt.read();
    assert.equal(pairs.length, 1);

    thumb.style.transform = 'translate(0px, 999px)';
    rt.write(null, pairs);
    assert.equal(thumb.style.transform, 'translate(0px, 220px)');
    assert.equal(resizeInstances.length, 1, 'attaches ResizeObserver for track/viewport/content');
    assert.ok(
      resizeInstances[0].observed.has(track) &&
        resizeInstances[0].observed.has(vp) &&
        resizeInstances[0].observed.has(vpContent),
      'observes track, viewport, and viewport firstElementChild'
    );

    // Re-observes replaced viewport content child on subsequent write()
    const nextContent = d.createElement('div');
    vp.replaceChild(nextContent, vpContent);
    rt.write(null, rt.read());
    assert.equal(resizeInstances[0].observed.has(vpContent), false);
    assert.equal(resizeInstances[0].observed.has(nextContent), true);

    // Simulate native i2b mutating thumb/ScrollTimeline synchronously on pointerover
    vpScrollTop = 1800;
    vp.dispatchEvent(new w.Event('pointerover'));
    thumb.style.height = '149px';
    thumb.style.transform = 'translate(0px, 596px)';
    latestKeyframes = [
      { transform: 'translate(0px, 0px)' },
      { transform: 'translate(0px, 596px)' },
    ];
    await flushMicrotasks();
    assert.equal(thumb.style.height, '147px');
    assert.equal(thumb.style.transform, 'translate(0px, 439px)');
    assert.equal(latestKeyframes[1].transform, 'translate(0px, 439px)');

    // Simulate native f2b ResizeObserver recalculating oversized clientHeight - 4 values
    thumb.style.height = '155px';
    thumb.style.transform = 'translate(0px, 596px)';
    latestKeyframes = [
      { transform: 'translate(0px, 0px)' },
      { transform: 'translate(0px, 596px)' },
    ];
    resizeInstances[0].trigger();
    await flushMicrotasks();
    assert.equal(thumb.style.height, '147px');
    assert.equal(thumb.style.transform, 'translate(0px, 439px)');
    assert.equal(latestKeyframes[1].transform, 'translate(0px, 439px)');
    assert.equal(observerCreations, 0, 'scrollbar-clamp must create zero MutationObserver instances');

    // Pending microtask & ResizeObserver are cleaned up on dispose
    vpScrollTop = 0;
    vp.dispatchEvent(new w.Event('scroll'));
    rt.dispose();
    assert.equal(resizeInstances[0].disconnected, true, 'dispose disconnects ResizeObserver');
    thumb.style.transform = 'translate(0px, 999px)';
    await flushMicrotasks();
    assert.equal(thumb.style.transform, 'translate(0px, 999px)', 'queued microtask is a no-op after dispose');
    vp.dispatchEvent(new w.Event('pointerover'));
    await flushMicrotasks();
    assert.equal(thumb.style.transform, 'translate(0px, 999px)', 'listeners removed after dispose');
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('project-usage.mjs re-renders detail card & hero badge on zh <-> en UI language switch', async () => {
  const { JSDOM } = await import('jsdom');
  const dNow = new Date();
  const todayStr = `${dNow.getFullYear()}-${String(dNow.getMonth() + 1).padStart(2, '0')}-${String(dNow.getDate()).padStart(2, '0')}`;
  const dom = new JSDOM(
    `<!doctype html><html data-ag-ux-lang="zh-CN"><body>
      <section id="ag-claude-projects-view" data-open="true">
        <div class="ag-pd-hero"><span id="agy-pd-hero-usage" data-maga-own="1" class="ag-pd-meta-chip ag-pd-meta-usage" hidden></span></div>
        <aside class="ag-pd-right">
          <div id="agy-pd-usage-slot" data-maga-own="1" data-ag-pd-proj-id="p-lang" data-ag-pd-chat-ids="c1"></div>
        </aside>
      </section>
    </body></html>`,
    { url: 'http://127.0.0.1/' }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document', 'location', 'localStorage', 'CustomEvent'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;
  globalThis.location = w.location;
  globalThis.localStorage = w.localStorage;
  globalThis.CustomEvent = w.CustomEvent;

  try {
    w.__agProjectCall = async (action) => {
      if (action === 'getUsageStats') {
        return {
          ok: true,
          generatedAt: Date.now(),
          globalTotalTokens: 10000,
          unread: 0,
          conversationCount: 1,
          byChat: { c1: { totalTokens: 5000, requests: 2 } },
          undated: { requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          days: [
            {
              date: todayStr,
              requests: 2,
              uncached: 1000,
              cacheRead: 3000,
              cacheWrite: 0,
              output: 1000,
              models: [{ name: 'Gemini 4 Neon (High)', requests: 2, uncached: 1000, cacheRead: 3000, cacheWrite: 0, output: 1000 }],
            },
          ],
        };
      }
      return { ok: false };
    };
    const studioPrefs = { get: () => ({ overviewUsageDefaultPeriod: 'day' }), subscribe: () => () => {} };
    const projUsage = createProjectUsageRuntime({ motionThemes: () => motionThemes, studioPrefs });

    projUsage.sync();
    await new Promise((r) => setTimeout(r, 20));
    const card = d.getElementById('agy-pd-usage-card');
    const hero = d.getElementById('agy-pd-hero-usage');
    assert.match(card.querySelector('.ag-ov-hdr-toggle')?.textContent || '', /项目用量/);
    assert.match(hero.textContent || '', /用量/);

    d.documentElement.setAttribute('data-ag-ux-lang', 'en');
    projUsage.sync();
    assert.match(card.querySelector('.ag-ov-hdr-toggle')?.textContent || '', /Project Usage/);
    assert.match(hero.textContent || '', /Usage/);

    d.documentElement.setAttribute('data-ag-ux-lang', 'zh-CN');
    projUsage.sync();
    assert.match(card.querySelector('.ag-ov-hdr-toggle')?.textContent || '', /项目用量/);
    assert.match(hero.textContent || '', /用量/);

    projUsage.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('overview-usage.css places #agy-pd-usage-card compact chart override after shared :is() plot rule', () => {
  const usageCss = readFileSync(path.join(REPO, 'studio', 'styles', 'overview-usage.css'), 'utf8');
  const sharedPlotRe = /:is\(#ag-claude-ov-sections #agy-ov-usage-card,\s*#ag-claude-projects-view #agy-pd-usage-card\)\s*\.agy-usage-plot\s*\{[^}]*height:\s*78px/;
  const pdCompactRe = /#ag-claude-projects-view #agy-pd-usage-card \.agy-usage-plot\s*\{\s*height:\s*62px;\s*\}/;
  const sharedMatch = sharedPlotRe.exec(usageCss);
  const pdMatch = pdCompactRe.exec(usageCss);
  assert.ok(sharedMatch, 'shared plot rule exists');
  assert.ok(pdMatch, 'project detail compact 62px plot override exists');
  assert.ok(pdMatch.index > sharedMatch.index, 'compact 62px override must come after shared 78px rule with equal specificity');
});

test('normalizeNumstatPath preserves directory prefixes and openExternalUrl rejects invalid URLs', async () => {
  const { normalizeNumstatPath } = await import(
    pathToFileURL(path.join(REPO, 'core', 'daemon', 'overview-skills.mjs')).href
  );
  const { openExternalUrl } = await import(
    pathToFileURL(path.join(REPO, 'core', 'daemon', 'projects.mjs')).href
  );

  assert.equal(normalizeNumstatPath('src/{a.js => b.js}'), 'src/b.js');
  assert.equal(normalizeNumstatPath('src/{ => sub}/a.js'), 'src/sub/a.js');
  assert.equal(normalizeNumstatPath('src/{sub => }/a.js'), 'src/a.js');
  assert.equal(normalizeNumstatPath('{old => new}/index.mjs'), 'new/index.mjs');
  assert.equal(normalizeNumstatPath('old/x.js => new/x.js'), 'new/x.js');
  assert.equal(normalizeNumstatPath('studio/core/dom.mjs'), 'studio/core/dom.mjs');

  assert.equal(openExternalUrl('javascript:alert(1)').ok, false);
  assert.equal(openExternalUrl('file:///etc/passwd').ok, false);
  assert.equal(openExternalUrl('http:///missing-host').ok, false);
  assert.equal(openExternalUrl('').ok, false);
});

test('model-api.mjs invalidates cachedNativeMeta when Redux cascadeModelConfigData changes', async () => {
  const { createModelApi } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'core', 'model-api.mjs')).href
  );
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <button data-testid="model-selector-trigger">Gemini 4 Neon (High)</button>
      <button id="ag-pd-model-btn" data-ag-pd-model-trigger="true">Gemini 4 Neon High</button>
    </body></html>`,
    { url: 'http://127.0.0.1/' }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;

  try {
    const accountAState = {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', modelOrAlias: { choice: { value: 1532 } } },
            { label: 'Orchestrator (Neon)', modelId: 'gemini-pro-orchestrator-neon', modelOrAlias: { choice: { value: 1537 } } },
          ],
          clientModelSorts: [{ groups: [{ groupName: 'Account A Group', modelLabels: ['Gemini 4 Neon (High)'] }] }],
          defaultOverrideModelConfig: { modelOrAlias: { choice: { value: 1532 } } },
        },
      },
      modelSelection: { default: { model: 1532 }, orchestratorByConversation: {} },
    };
    const accountBState = {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Claude Opus 5.5 (High)', modelId: 'claude-opus-5-5-high', modelOrAlias: { choice: { value: 2402 } } },
            { label: 'Orchestrator (Carbon)', modelId: 'gemini-pro-orchestrator', modelOrAlias: { choice: { value: 2667 } } },
          ],
          clientModelSorts: [{ groups: [{ groupName: 'Account B Group', modelLabels: ['Claude Opus 5.5 (High)'] }] }],
          defaultOverrideModelConfig: { modelOrAlias: { choice: { value: 2402 } } },
        },
      },
      modelSelection: { default: { model: 2402 }, orchestratorByConversation: {} },
    };

    let activeState = accountAState;
    const reduxStore = {
      getState: () => activeState,
      dispatch: () => {},
    };
    const nativeBtn = d.querySelector('button[data-testid="model-selector-trigger"]');
    const pdBtn = d.getElementById('ag-pd-model-btn');
    nativeBtn.__reactFiber$test = {
      memoizedProps: {
        value: {
          selectedModel: { label: 'Gemini 4 Neon (High)', value: 1532, modelId: 'gemini-4-neon-high' },
          modelOptions: [
            { label: 'Gemini 4 Neon (High)', value: 1532, modelId: 'gemini-4-neon-high' },
            { label: 'Orchestrator (Neon)', value: 1537, modelId: 'gemini-pro-orchestrator-neon' },
          ],
          groups: [{ title: 'Account A Group', options: [{ label: 'Gemini 4 Neon (High)', value: 1532 }] }],
          orchestratorPlanners: [{ label: 'Account A Planner (High)', value: 9001, modelId: 'acc-a-planner' }],
          orchestratorDefaultPlanner: { label: 'Account A Planner (High)', value: 9001, modelId: 'acc-a-planner' },
          setSelectedModel: () => {},
        },
      },
      return: null,
    };

    const modelApi = createModelApi({
      L: (_zh, en) => en,
      later: (fn) => fn(),
      state: { disposed: false },
      hooks: { resolveProjectsStoreAndBindings: () => ({ store: reduxStore }) },
    });

    // Populate cachedNativeMeta while Account A is active
    const apiA = modelApi.discoverModelSelectorApi(nativeBtn);
    assert.equal(apiA.groups[0].title, 'Account A Group');

    // Switch account in Redux & remove native trigger from DOM (Project Detail fallback)
    nativeBtn.remove();
    activeState = accountBState;

    const pdApiB = modelApi.discoverModelSelectorApi(pdBtn);
    assert.deepEqual(
      pdApiB.groups.map((g) => g.title),
      ['Account B Group'],
      'discoverModelSelectorApi invalidates stale Account A groups after Redux config change'
    );
    assert.equal(
      pdApiB.orchestratorDefaultPlanner?.label,
      'Claude Opus 5.5 (High)',
      'discoverModelSelectorApi invalidates stale Account A default planner'
    );
    assert.equal(
      pdApiB.orchestratorPlanners?.some((p) => p.label === 'Account A Planner (High)'),
      false,
      'stale Account A planner does not leak into Account B'
    );

    const rxApiB = modelApi.buildReduxModelSelectorApi();
    assert.equal(rxApiB.orchestratorDefaultPlanner?.label, 'Claude Opus 5.5 (High)');

    modelApi.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('conv-topbar.mjs handles malformed percent-encoding in /c/%E0%A4%A without throwing', async () => {
  const { createConvProjectTopbar } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'projects', 'conv-topbar.mjs')).href
  );
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="@container/titlebar">
        <div></div>
        <div data-testid="titlebar-service-announcement-slot"></div>
      </div>
    </body></html>`,
    { url: 'http://127.0.0.1/c/%E0%A4%A' }
  );
  const w = dom.window;
  const d = w.document;
  const keys = ['window', 'document'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;

  try {
    let curPathname = '/c/%E0%A4%A';
    const summaries = {
      '%E0%A4%A': { projectId: 'p1' },
    };
    const topbar = createConvProjectTopbar({
      FEAT: { projects: true, i18n: false },
      L: (_zh, en) => en,
      rtState: { disposed: false, projectsViewOpen: false },
      pState: { projectsContextMap: {}, projectsWorkspaceStatusMap: {} },
      escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      later: (fn) => fn(),
      getActiveCascadeId: () => '',
      decodeFileUriToPath: (u) => u,
      formatShortHomePath: (p) => p,
      resolveProjectsStoreAndBindings: () => ({
        store: { getState: () => ({ trajectorySummaries: { summaries } }) },
        bindings: { router: { state: { location: { pathname: curPathname } } } },
      }),
      collectNativeProjects: () => [{ id: 'p1', name: 'Demo', dirPath: '/tmp/demo', chats: [], isRemote: false }],
      openProjectsView: () => {},
      startNewChatInProject: () => {},
      showProjectsFloatingNotice: () => {},
    });

    assert.doesNotThrow(() => topbar.sync(), 'malformed %E0%A4%A route must not throw');
    const bar = d.getElementById('agy-conv-project-bar');
    assert.ok(bar, 'falls back to raw conversation id and renders topbar');
    assert.match(bar.textContent || '', /Demo/);

    curPathname = '/c/%E0%A4%A-unknown';
    assert.doesNotThrow(() => topbar.sync(), 'malformed %E0%A4%A route with no matching summary must not throw');
    assert.equal(d.getElementById('agy-conv-project-bar'), null);

    topbar.teardown();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    w.close();
  }
});

test('readGitCommitDetailAsync rejects tree/blob hashes via ^{commit} and parseNumstatZ handles -z renames and special paths', async () => {
  const { readGitCommitDetailAsync, parseNumstatZ } = await import(
    pathToFileURL(path.join(REPO, 'core', 'daemon', 'overview-skills.mjs')).href
  );
  const treeHash = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const blobHash = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD:package.json'], { encoding: 'utf8' }).trim();

  const treeRes = await readGitCommitDetailAsync(REPO, treeHash);
  assert.equal(treeRes.ok, false, 'tree hash must be rejected by ^{commit}');
  assert.equal(treeRes.error, 'commit_not_found');

  const blobRes = await readGitCommitDetailAsync(REPO, blobHash);
  assert.equal(blobRes.ok, false, 'blob hash must be rejected by ^{commit}');
  assert.equal(blobRes.error, 'commit_not_found');

  const sampleZ =
    '\n12\t3\tsrc/中文 file.js\0' +
    '5\t1\t\0docs/old name.md\0docs/new "quoted" name.md\0' +
    '\r\n-\t-\tassets/logo final.png\0' +
    '\0' +
    '7\t2\t\0src/{old}/a.mjs\0src/new dir/a.mjs\0';
  assert.deepEqual(parseNumstatZ(sampleZ), [
    { path: 'src/中文 file.js', added: 12, deleted: 3 },
    { path: 'docs/new "quoted" name.md', added: 5, deleted: 1 },
    { path: 'assets/logo final.png', added: 0, deleted: 0 },
    { path: 'src/new dir/a.mjs', added: 7, deleted: 2 },
  ]);
});

test('readConversationUsageRecord and parseConversationMetrics discover Opus swarm descendants via SQLite lineage', async () => {
  const { readConversationUsage, readConversationUsageRecord } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'daemon', 'usage-reader.mjs')).href
  );
  const { parseConversationMetrics } = await import(
    pathToFileURL(path.join(REPO, 'core', 'daemon', 'metrics-db.mjs')).href
  );

  const pbVarint = (n) => {
    const out = [];
    let v = BigInt(n);
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return Buffer.from(out);
  };
  const pbInt = (fn, n) => Buffer.concat([pbVarint((fn << 3) | 0), pbVarint(n)]);
  const pbBytes = (fn, buf) => Buffer.concat([pbVarint((fn << 3) | 2), pbVarint(buf.length), buf]);
  const pbStr = (fn, str) => pbBytes(fn, Buffer.from(str, 'utf8'));

  const makeGenBlob = ({ uncached, output, cacheRead, model, responseId, epochSec }) => {
    const usage = Buffer.concat([
      pbInt(2, uncached),
      pbInt(3, output),
      pbInt(5, cacheRead),
      pbInt(6, 1),
      pbStr(11, responseId),
    ]);
    const chatStart = Buffer.concat([pbBytes(4, pbInt(1, epochSec)), pbBytes(10, pbInt(4, 200000))]);
    const chat = Buffer.concat([
      pbBytes(4, usage),
      pbBytes(9, chatStart),
      pbBytes(11, pbInt(1, 1)),
      pbBytes(12, pbInt(1, 1)),
      pbStr(21, model),
    ]);
    return pbBytes(1, chat);
  };

  const rootDir = mkdtempSync(path.join(tmpdir(), 'maga-opus-db-'));
  try {
    const convDir = path.join(rootDir, 'conversations');
    const parentId = '11111111-1111-4111-8111-111111111111';
    const opusChildId = 'ffffffff-2222-4222-8222-222222222222';
    const sumDbPath = path.join(rootDir, 'conversation_summaries.db');

    const fsMod = await import('node:fs');
    fsMod.mkdirSync(convDir, { recursive: true });

    // Create 25 dummy DBs sorting before opusChildId so cold 20-file blob scan alone would miss it
    for (let i = 0; i < 25; i++) {
      const dummyId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const ddb = new DatabaseSync(path.join(convDir, `${dummyId}.db`));
      ddb.exec('CREATE TABLE trajectory_metadata_blob (data BLOB)');
      ddb.close();
    }

    const epochSec = Math.floor(Date.now() / 1000) - 30;
    const pdb = new DatabaseSync(path.join(convDir, `${parentId}.db`));
    pdb.exec(
      'CREATE TABLE trajectory_metadata_blob (data BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);'
    );
    pdb.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (0, 14, NULL), (1, 15, NULL)').run();
    pdb
      .prepare('INSERT INTO gen_metadata (idx, data) VALUES (0, ?)')
      .run(makeGenBlob({ uncached: 1000, output: 200, cacheRead: 4000, model: 'Gemini 4 Neon (High)', responseId: 'req-p1', epochSec }));
    pdb.close();

    const cdb = new DatabaseSync(path.join(convDir, `${opusChildId}.db`));
    cdb.exec('CREATE TABLE trajectory_metadata_blob (data BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    cdb
      .prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)')
      .run(Buffer.concat([pbStr(5, parentId), pbStr(6, parentId)]));
    cdb
      .prepare('INSERT INTO gen_metadata (idx, data) VALUES (0, ?)')
      .run(makeGenBlob({ uncached: 600, output: 150, cacheRead: 900, model: 'Claude Opus 5.5 (High)', responseId: 'req-o1', epochSec }));
    cdb.close();

    const sdb = new DatabaseSync(sumDbPath);
    sdb.exec(
      'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, agent_name TEXT, status TEXT, not_fully_idle INTEGER, killed INTEGER, last_modified_time TEXT, parent_conversation_id TEXT);'
    );
    sdb
      .prepare(
        'INSERT INTO conversation_summaries (conversation_id, title, agent_name, status, not_fully_idle, killed, last_modified_time, parent_conversation_id) VALUES (?, ?, ?, ?, 0, 1, ?, ?)'
      )
      .run(opusChildId, '', 'opus-gate', 'CASCADE_RUN_STATUS_IDLE', '2026-11-26T00:00:00Z', parentId);
    sdb.close();

    const rec = readConversationUsageRecord(path.join(convDir, `${opusChildId}.db`), { immutable: false });
    assert.equal(rec.parentId, parentId);
    assert.equal(rec.rootId, parentId);
    assert.equal(rec.requests.length, 1);
    assert.equal(rec.requests[0].model, 'Claude Opus 5.5 (High)');
    assert.equal(readConversationUsage(path.join(convDir, `${opusChildId}.db`), { immutable: false }).length, 1);

    const metrics = parseConversationMetrics(parentId, convDir);
    assert.equal(metrics.hasData, true);
    assert.equal(metrics.metrics.childCount, 1, 'discovers Opus child immediately beyond 20-file cold cap via conversation_summaries.db');
    assert.equal(metrics.metrics.childCalls, 1);
    assert.equal(metrics.stats.children[0].agentName, 'opus-gate');
    assert.equal(metrics.stats.children[0].outTok, 150);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('footer-unified ignores closed stale quota popover & decorative compacted arc so brand-new/compacted ctx ring stays centered', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="agy-composer-footer">
        <div>
          <button type="button" aria-label="Add context"></button>
          <button id="ag-claude-ctx-ring" type="button" title="No context usage yet · Click for plan usage">
            <svg width="15" height="15" viewBox="0 0 20 20">
              <circle class="ag-ctx-ring-track" cx="10" cy="10" r="7"></circle>
              <circle class="ag-ctx-ring-arc" cx="10" cy="10" r="7" style="stroke-dashoffset: 43.98; stroke-opacity: 0;"></circle>
            </svg>
          </button>
        </div>
        <div></div>
      </div>
      <div id="ag-claude-quota-popover" data-open="false">
        <div class="ag-qp-item">
          <div class="ag-qp-row">
            <span class="ag-qp-reset">165.4k / 512k</span>
            <span class="ag-qp-pct">82%</span>
          </div>
        </div>
      </div>
      <div id="ag-claude-ov-sections">
        <section class="ag-ov-card" data-ov-card="context"></section>
      </div>
    </body></html>`,
    { url: 'http://127.0.0.1/c/conv-new-1' }
  );
  const doc = dom.window.document;
  const keys = ['document', 'window', 'location'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.document = doc;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;

  try {
    const footer = doc.querySelector('.agy-composer-footer');
    footer.getBoundingClientRect = () => ({ width: 620, height: 60, top: 0, left: 0, right: 620, bottom: 60 });

    const ring = doc.getElementById('ag-claude-ctx-ring');
    const pop = doc.getElementById('ag-claude-quota-popover');
    const ovCtxCard = doc.querySelector('#ag-claude-ov-sections [data-ov-card="context"]');
    const arc = ring.querySelector('.ag-ctx-ring-arc');

    const rt = createFooterUnifiedRuntime();
    rt.sync();

    // Case A: brand-new conversation ignores closed 82% popover
    assert.equal(ring.getAttribute('data-agy-has-ratio'), null);
    assert.equal(ring.getAttribute('data-agy-has-tight'), '0');
    assert.equal(ring.getAttribute('data-agy-ctx-tier'), 'cool');
    assert.equal(ring.querySelector('.agy-ctx-ratio')?.hidden, true);
    assert.equal(ovCtxCard.getAttribute('data-agy-ctx-tier'), 'cool');
    assert.equal(pop.querySelector('.ag-qp-reset')?.textContent, '165.4k / 512k');

    // Case B: compacted state with decorative 2% arc must stay centered without ratio
    ring.setAttribute('data-compact-state', 'compacted');
    ring.setAttribute('title', 'Context compacted · Click for plan usage');
    arc.style.strokeOpacity = '1';
    arc.style.strokeDashoffset = (2 * Math.PI * 7 * 0.98).toFixed(2);
    rt.sync();

    assert.equal(ring.getAttribute('data-agy-has-ratio'), null);
    assert.equal(ring.getAttribute('data-agy-has-tight'), '0');
    assert.equal(ring.querySelector('.agy-ctx-ratio')?.hidden, true);

    // Case C: real ratio only updates open popover reset text
    ring.removeAttribute('data-compact-state');
    ring.setAttribute('title', 'Context 12k / 512k (2%) · Click for plan usage');
    rt.sync();
    assert.equal(ring.getAttribute('data-agy-has-ratio'), 'true');
    assert.equal(ring.getAttribute('data-agy-has-tight'), '1');
    assert.equal(ring.querySelector('.agy-ctx-ratio')?.hidden, false);
    assert.equal(pop.querySelector('.ag-qp-reset')?.textContent, '165.4k / 512k');

    pop.setAttribute('data-open', 'true');
    rt.sync();
    assert.equal(pop.querySelector('.ag-qp-reset')?.textContent, '12k / 512k');

    rt.dispose();
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    dom.window.close();
  }
});

test('MetricsBus tracks data-agy-has-speed-num, hides unused short slot, and hides pill when stopped without data', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="ag-live-metrics-pill"><span id="ag-live-metrics-text"></span></div></body></html>',
    { url: 'http://127.0.0.1/c/conv-metrics-empty' }
  );
  const doc = dom.window.document;
  const keys = ['document', 'window', 'location'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.document = doc;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;

  try {
    const pill = doc.getElementById('ag-live-metrics-pill');
    const textEl = doc.getElementById('ag-live-metrics-text');

    renderSpeedSlots(
      pill,
      textEl,
      { cascadeId: 'conv-metrics-empty', hasData: true, metrics: { displayTps: 0, useStream: false, ttft: 3.2 } },
      { cid: 'conv-metrics-empty', running: false, isZh: false }
    );
    assert.equal(pill.getAttribute('data-agy-has-speed-num'), '0');
    assert.equal(textEl.querySelector('[data-agy-speed-short="1"]').hidden, true);
    assert.equal(textEl.querySelector('[data-agy-speed-slot="extra"]').hidden, false);
    assert.equal(pill.style.display, 'inline-flex');

    renderSpeedSlots(
      pill,
      textEl,
      { cascadeId: 'conv-metrics-empty', hasData: false },
      { cid: 'conv-metrics-empty', running: true, isZh: false }
    );
    assert.equal(pill.getAttribute('data-agy-working-placeholder'), 'true');
    assert.equal(pill.getAttribute('data-agy-has-speed-num'), '0');

    renderSpeedSlots(
      pill,
      textEl,
      { cascadeId: 'conv-metrics-empty', hasData: false },
      { cid: 'conv-metrics-empty', running: false, isZh: false }
    );
    assert.equal(pill.getAttribute('data-agy-working-placeholder'), null);
    assert.equal(pill.style.display, 'none');
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    dom.window.close();
  }
});

test('subagent pills handle empty states and footer-capsules.css enforces centering & [hidden] invariants', async () => {
  const { renderSubCtxPill, renderSubSpeedPill } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'modules', 'subagent', 'pills.mjs')).href
  );
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/c/conv-sub-1' });
  const doc = dom.window.document;
  const keys = ['document', 'window', 'location'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.document = doc;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;

  try {
    const ctxEl = doc.createElement('span');
    renderSubCtxPill(ctxEl, { contextTokens: 0, maxContextTokens: 0, pct: 0 });
    assert.equal(ctxEl.getAttribute('data-agy-has-ratio'), null);
    assert.equal(ctxEl.getAttribute('data-agy-ctx-tier'), 'cool');
    assert.equal(ctxEl.querySelector('.agy-sub-ctx-full'), null);

    renderSubCtxPill(ctxEl, { contextTokens: 24000, maxContextTokens: 200000, pct: 12 });
    assert.equal(ctxEl.getAttribute('data-agy-has-ratio'), 'true');
    assert.equal(ctxEl.querySelector('.agy-sub-ctx-full')?.textContent, '24.0k / 200.0k');

    const spdEl = doc.createElement('span');
    renderSubSpeedPill(spdEl, { tps: null, ttft: 2.4, isHold: false, running: false });
    assert.equal(spdEl.hidden, false);
    assert.equal(spdEl.getAttribute('data-has-spd-num'), '0');

    renderSubSpeedPill(spdEl, { tps: null, ttft: null, running: false });
    assert.equal(spdEl.hidden, true);
  } finally {
    for (const k of keys) {
      const desc = prev.get(k);
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    dom.window.close();
  }

  const css = readFileSync(FOOTER_CSS_PATH, 'utf8');
  assert.equal(css.includes(':has('), false, 'footer-capsules.css must contain zero :has() rules');
  assert.ok(css.includes('.agy-sub-pill[hidden]'));
  assert.ok(css.includes('[data-agy-has-tight="0"]'));
  assert.ok(css.includes('[data-agy-has-speed-num="0"]'));
  assert.ok(css.includes('.agy-sub-pill.agy-sub-ctx:not([data-agy-has-ratio="true"])'));
  assert.match(css, /\.agy-composer-footer #ag-claude-ctx-ring#ag-claude-ctx-ring\s*\{[\s\S]*?gap:\s*0\s*!important;/);
});
