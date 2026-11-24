import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { buildStudioBundle, CSS_BEGIN, CSS_END, JS_BEGIN, JS_END } from '../studio/build.mjs';
import {
  buildPickerShadowCss,
  createCapsulePickerRuntime,
  shortenEffortBadge,
  shortenModelName,
} from '../studio/modules/capsule-picker.mjs';
import { createFooterUnifiedRuntime } from '../studio/modules/footer-unified.mjs';
import { createResumeBannerRuntime } from '../studio/modules/resume-banner.mjs';
import { createSubagentFooterRuntime } from '../studio/modules/subagent-footer.mjs';
import { collectResumeState } from '../studio/daemon/resume-detector.mjs';
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

  // Verify MutationObserver self-trigger draining, studio filter & hidden poll guard
  assert.match(jsBlock, /finally\s*\{\s*docObs\.takeRecords\(\);\s*\}/);
  assert.match(jsBlock, /STUDIO_OWN_SEL/);
  assert.match(jsBlock, /document\.hidden/);
  assert.match(jsBlock, /createSubagentFooterRuntime\(\{\s*motionThemes,\s*shortenModelName,\s*shortenEffortBadge\s*\}\)/);

  // Verify all 4 style files are bundled
  for (const name of ['typography.css', 'footer-capsules.css', 'quota-popover.css', 'overview-usage.css']) {
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
      cfgMods: { claudeUxModelMenu: false },
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
      cfgMods: { claudeUxModelMenu: false },
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

  assert.match(modelPickerSrc, /const defaultTierFor = name => \/\\bneon\\b\/i\.test\(String\(name \|\| ''\)\) \? 'high' : 'medium';/);
  assert.match(modelPickerSrc, /showSubFor[\s\S]*?const defTier = defaultTierFor\(planner\.name\);/);
  assert.match(modelPickerSrc, /renderedGroups[\s\S]*?const defTier = defaultTierFor\(group\.name\);/);
  assert.match(customJsSrc, /function pickVariantForFamily[\s\S]*?\/\\bneon\\b\/i[\s\S]*?v\.effort === 'High'/);

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
      root._modelPicker?.dispose?.();
    } finally {
      if (prevMatchMedia === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = prevMatchMedia;
    }
  });
});
