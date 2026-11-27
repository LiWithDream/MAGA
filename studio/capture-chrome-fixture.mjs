#!/usr/bin/env node
/**
 * Real-machine Antigravity Chrome DOM Geometry Fixture Capture (`npm run capture:chrome-fixture`).
 * Captures ONLY anonymous layout rectangles, structural CSS overflow/transition hints,
 * and studio geometry CSS variables — zero conversation titles, text content, or user paths.
 */
import fs, { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateOnAntigravityPage } from './cdp-probe.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const realpathNative = fs.realpathSync.native || fs.realpathSync;

function normExecPath(p) {
  const s = String(p || '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

const SAFE_TEST_IDS = new Set([
  'conversation-list-sidebar',
  'overview-panel-host',
  'toggle-overview-panel',
  'toggle-aux-sidebar',
  'automations-button',
  'project-header',
]);

const SAFE_LAYOUT_CLASS_RE = /^(?:bg-sidebar|flex|flex-col|fixed|sticky|relative|absolute|overflow-\S+|h-full|w-full)$/;
const SAFE_TAG_RE = /^[A-Z][A-Z0-9-]{0,20}$/;
const SAFE_OVERFLOW_RE = /^(?:visible|hidden|clip|scroll|auto)(?:\s+(?:visible|hidden|clip|scroll|auto))?$/;
const SAFE_CSS_VAR_RE = /^(?:calc\([^;{}]{1,80}\)|-?\d+(?:\.\d+)?px|0)$/;
const SAFE_HOST_VERSION_RE = /^[0-9]+(?:\.[0-9A-Za-z._-]+){0,5}$/;

export const CHROME_CAPTURE_EXPRESSION = `(() => {
  const rect = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };
  const bgSidebars = Array.from(document.querySelectorAll('.bg-sidebar')).map((el, index) => {
    const parentChain = [];
    let cur = el.parentElement;
    for (let depth = 0; depth < 4 && cur && cur !== document.body; depth += 1, cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      parentChain.push({
        tag: cur.tagName,
        overflow: cs.overflow,
        overflowX: cs.overflowX,
        transition: String(cs.transition || '').slice(0, 120),
        rect: rect(cur),
      });
    }
    return {
      index,
      tag: el.tagName,
      testId: el.getAttribute('data-testid') || null,
      classes: Array.from(el.classList || []),
      rect: rect(el),
      anchors: {
        hasProjectsNav: Boolean(el.querySelector('#ag-claude-projects-nav-btn')),
        hasAutomationsBtn: Boolean(el.querySelector('[data-testid="automations-button"]')),
        hasProjectHeader: Boolean(el.querySelector('[data-testid="project-header"]')),
        hasConversationListSidebar:
          el.getAttribute('data-testid') === 'conversation-list-sidebar' ||
          Boolean(el.querySelector('[data-testid="conversation-list-sidebar"]')),
      },
      parentChain,
    };
  });
  const rootStyle = getComputedStyle(document.documentElement);
  const projEl = document.getElementById('ag-claude-projects-view');
  const drawerEl = document.getElementById('agy-maga-settings-drawer');
  const appCfg = window.__APP_CONFIG__ && typeof window.__APP_CONFIG__ === 'object' ? window.__APP_CONFIG__ : {};
  return {
    hostVersion: typeof appCfg.appVersion === 'string' ? appCfg.appVersion.trim() : '',
    viewport: {
      innerWidth: Math.round(window.innerWidth || 0),
      innerHeight: Math.round(window.innerHeight || 0),
      devicePixelRatio: Number(window.devicePixelRatio || 1),
    },
    cssVars: {
      winTopBar: rootStyle.getPropertyValue('--ag-win-top-bar').trim(),
      projTop: projEl ? getComputedStyle(projEl).getPropertyValue('--ag-proj-top').trim() : '',
      drawerTop: drawerEl ? getComputedStyle(drawerEl).getPropertyValue('--agy-drawer-top').trim() : '',
      ovEffectiveReserve: rootStyle.getPropertyValue('--maga-ov-effective-reserve').trim(),
    },
    bgSidebars,
    controls: {
      overviewToggleRect: rect(document.querySelector('button[data-testid="toggle-overview-panel"]')),
      auxToggleRect: rect(document.querySelector('button[data-testid="toggle-aux-sidebar"]')),
      overviewPanelHostRect: rect(document.querySelector('[data-testid="overview-panel-host"]')),
    },
  };
})()`;

function sanitizeRect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nums = ['left', 'top', 'right', 'bottom', 'width', 'height'];
  const out = {};
  for (const key of nums) {
    const v = Number(raw[key]);
    if (!Number.isFinite(v)) return null;
    out[key] = Math.round(v);
  }
  return out;
}

function sanitizeTag(raw) {
  const tag = String(raw || 'DIV').toUpperCase();
  return SAFE_TAG_RE.test(tag) ? tag : 'DIV';
}

function sanitizeOverflow(raw) {
  const val = String(raw || 'visible').trim().toLowerCase();
  return SAFE_OVERFLOW_RE.test(val) ? val : 'visible';
}

function sanitizeTransition(raw) {
  const s = String(raw || '').trim().slice(0, 120);
  if (!s || /url\(|https?:|file:|\/Users\/|:\\/i.test(s)) return 'all';
  return s;
}

function sanitizeCssVar(raw) {
  const s = String(raw || '').trim();
  return SAFE_CSS_VAR_RE.test(s) ? s : '';
}

function sanitizeHostVersion(raw) {
  const s = String(raw || '').trim().slice(0, 32);
  return SAFE_HOST_VERSION_RE.test(s) ? s : 'unknown';
}

export function sanitizeFixtureSnapshot(raw, { platform = process.platform, source = 'cdp-live', hostVersion = '' } = {}) {
  const normalizedPlatform = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : String(platform || 'linux');
  const vp = raw?.viewport && typeof raw.viewport === 'object' ? raw.viewport : {};
  const innerWidth = Math.max(0, Math.round(Number(vp.innerWidth) || 0));
  const innerHeight = Math.max(0, Math.round(Number(vp.innerHeight) || 0));
  const rawDpr = Number(vp.devicePixelRatio);
  const devicePixelRatio = Number.isFinite(rawDpr) && rawDpr > 0 ? Math.round(rawDpr * 100) / 100 : 1;

  const rawSidebars = Array.isArray(raw?.bgSidebars) ? raw.bgSidebars : [];
  const bgSidebars = rawSidebars.slice(0, 32).map((item, idx) => {
    const classes = Array.isArray(item?.classes)
      ? Array.from(new Set(item.classes.map((c) => String(c || '').trim()).filter((c) => SAFE_LAYOUT_CLASS_RE.test(c))))
      : ['bg-sidebar'];
    if (!classes.includes('bg-sidebar')) classes.unshift('bg-sidebar');
    const rawTestId = typeof item?.testId === 'string' ? item.testId.trim() : '';
    const testId = SAFE_TEST_IDS.has(rawTestId) ? rawTestId : null;
    const rawChain = Array.isArray(item?.parentChain) ? item.parentChain.slice(0, 4) : [];
    const parentChain = rawChain.map((p) => ({
      tag: sanitizeTag(p?.tag),
      overflow: sanitizeOverflow(p?.overflow),
      overflowX: sanitizeOverflow(p?.overflowX),
      transition: sanitizeTransition(p?.transition),
      rect: sanitizeRect(p?.rect),
    }));
    const anchors = item?.anchors && typeof item.anchors === 'object' ? item.anchors : {};
    return {
      index: idx,
      tag: sanitizeTag(item?.tag),
      testId,
      classes,
      rect: sanitizeRect(item?.rect),
      anchors: {
        hasProjectsNav: Boolean(anchors.hasProjectsNav),
        hasAutomationsBtn: Boolean(anchors.hasAutomationsBtn),
        hasProjectHeader: Boolean(anchors.hasProjectHeader),
        hasConversationListSidebar: Boolean(anchors.hasConversationListSidebar),
      },
      parentChain,
    };
  });

  const controls = raw?.controls && typeof raw.controls === 'object' ? raw.controls : {};
  const cssVars = raw?.cssVars && typeof raw.cssVars === 'object' ? raw.cssVars : {};

  return {
    schema: 1,
    platform: normalizedPlatform,
    hostVersion: sanitizeHostVersion(hostVersion || raw?.hostVersion),
    source: String(source || 'cdp-live').slice(0, 64),
    viewport: { innerWidth, innerHeight, devicePixelRatio },
    cssVars: {
      winTopBar: sanitizeCssVar(cssVars.winTopBar),
      projTop: sanitizeCssVar(cssVars.projTop),
      drawerTop: sanitizeCssVar(cssVars.drawerTop),
      ovEffectiveReserve: sanitizeCssVar(cssVars.ovEffectiveReserve),
    },
    bgSidebars,
    controls: {
      overviewToggleRect: sanitizeRect(controls.overviewToggleRect),
      auxToggleRect: sanitizeRect(controls.auxToggleRect),
      overviewPanelHostRect: sanitizeRect(controls.overviewPanelHostRect),
    },
  };
}

export async function captureChromeFixture({
  outPath = '',
  platform = process.platform,
  stdout = false,
  timeoutMs = 5000,
  port = 0,
  evaluateFn = evaluateOnAntigravityPage,
} = {}) {
  const evalRes = await evaluateFn(CHROME_CAPTURE_EXPRESSION, { port, timeoutMs });
  if (!evalRes?.ok || !evalRes.value) {
    throw new Error(evalRes?.error || 'Failed to capture Antigravity Chrome geometry via CDP');
  }

  const snapshot = sanitizeFixtureSnapshot(evalRes.value, { platform, source: 'cdp-live' });
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (stdout) {
    return {
      ok: true,
      platform: snapshot.platform,
      outPath: null,
      bgSidebarCount: snapshot.bgSidebars.length,
      snapshot,
      serialized,
    };
  }

  const targetOut =
    outPath || path.join(REPO_ROOT, 'test', 'fixtures', snapshot.platform, 'chrome-layout.json');
  mkdirSync(path.dirname(targetOut), { recursive: true });
  writeFileSync(targetOut, serialized, 'utf8');

  return {
    ok: true,
    platform: snapshot.platform,
    outPath: targetOut,
    bgSidebarCount: snapshot.bgSidebars.length,
    viewport: snapshot.viewport,
  };
}

function parseArgs(argv) {
  let outPath = '';
  let platform = process.platform;
  let stdout = false;
  let timeoutMs = 5000;
  let port = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) outPath = path.resolve(argv[++i]);
    else if (a === '--platform' && argv[i + 1]) platform = String(argv[++i]).trim().toLowerCase();
    else if (a === '--stdout') stdout = true;
    else if (a === '--timeout' && argv[i + 1]) timeoutMs = Math.max(1000, parseInt(argv[++i], 10) || 5000);
    else if (a === '--port' && argv[i + 1]) port = parseInt(argv[++i], 10) || 0;
  }
  return { outPath, platform, stdout, timeoutMs, port };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return normExecPath(realpathNative(path.resolve(process.argv[1]))) === normExecPath(realpathNative(__filename));
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = await captureChromeFixture(opts);
    if (opts.stdout) {
      process.stdout.write(res.serialized);
    } else {
      console.log(JSON.stringify(res, null, 2));
    }
  } catch (err) {
    console.error('[AGY Studio capture-chrome-fixture]', err?.message || err);
    process.exit(1);
  }
}
