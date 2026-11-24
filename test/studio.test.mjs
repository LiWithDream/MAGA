import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStudioBundle, CSS_BEGIN, CSS_END, JS_BEGIN, JS_END } from '../studio/build.mjs';
import {
  buildPickerShadowCss,
  createCapsulePickerRuntime,
  shortenEffortBadge,
  shortenModelName,
} from '../studio/modules/capsule-picker.mjs';
import { createFooterUnifiedRuntime } from '../studio/modules/footer-unified.mjs';
import { createSubagentFooterRuntime } from '../studio/modules/subagent-footer.mjs';
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

  // Verify MutationObserver self-trigger draining & shortenEffortBadge wiring
  assert.match(jsBlock, /finally\s*\{\s*docObs\.takeRecords\(\);\s*\}/);
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
