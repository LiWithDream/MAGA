#!/usr/bin/env node
/**
 * antigravity-claude-ux — install.mjs
 * Zero-dependency CLI installer, step-stream unlocker, doctor & uninstaller (Node.js >= 22)
 *
 * Commands:
 *   node install.mjs install     Install/update UX layer, unlock native step stream, inject AGENTS.md rule
 *   node install.mjs doctor      Non-destructive health check across all layers
 *   node install.mjs sync-fonts  Copy Anthropic variable fonts from local macOS Claude.app if available
 *   node install.mjs uninstall   Restore previous theme-patch user/ config and remove AGENTS.md rule block
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const GEMINI_DIR = path.join(HOME, '.gemini');
const AGY_DIR = path.join(GEMINI_DIR, 'antigravity');
const THEME_PATCH_DIR = path.join(AGY_DIR, 'theme-patch');
const THEME_USER_DIR = path.join(THEME_PATCH_DIR, 'user');
const BACKUP_DIR = path.join(THEME_USER_DIR, '.backup-before-claude-ux');
const AGY_STATE_PBTXT = path.join(AGY_DIR, 'antigravity_state.pbtxt');
const AGY_CONFIG_JSON = path.join(GEMINI_DIR, 'config', 'config.json');
const AGENTS_MD = path.join(GEMINI_DIR, 'AGENTS.md');

const UPSTREAM_REPO = 'https://github.com/Anarcadia/chuanban-antigravity-theme-patch.git';
const RULE_BEGIN = '<!-- BEGIN antigravity-claude-ux -->';
const RULE_END = '<!-- END antigravity-claude-ux -->';
const LEGACY_HEADING = '## 执行过程同步（Claude 式边做边汇报）';

function getDevToolsPortFile() {
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity', 'DevToolsActivePort');
  }
  return path.join(HOME, '.config', 'Antigravity', 'DevToolsActivePort');
}

function getUserFontsDir() {
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Fonts');
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    return path.join(localAppData, 'Microsoft', 'Windows', 'Fonts');
  }
  return path.join(HOME, '.local', 'share', 'fonts');
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function checkFontsInstalled() {
  const dir = getUserFontsDir();
  try {
    const files = fs.readdirSync(dir);
    const hasAnthropicSans = files.some((f) => /AnthropicSans/i.test(f));
    const hasAnthropicSerif = files.some((f) => /AnthropicSerif/i.test(f));
    return { dir, hasAnthropicSans, hasAnthropicSerif };
  } catch {
    return { dir, hasAnthropicSans: false, hasAnthropicSerif: false };
  }
}

function syncFontsFromLocalClaudeApp() {
  if (process.platform !== 'darwin') {
    return { synced: false, reason: 'not_macos' };
  }
  const claudeFontsDir = '/Applications/Claude.app/Contents/Resources/fonts';
  if (!fs.existsSync(claudeFontsDir)) {
    return { synced: false, reason: 'claude_app_not_installed' };
  }
  const destDir = getUserFontsDir();
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const name of fs.readdirSync(claudeFontsDir)) {
    if (/^Anthropic.*\.(ttf|otf)$/i.test(name)) {
      const dst = path.join(destDir, name);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(path.join(claudeFontsDir, name), dst);
        copied.push(name);
      }
    }
  }
  return { synced: true, copied };
}

function ensureUpstreamThemePatch() {
  const upstreamEntry = path.join(THEME_PATCH_DIR, 'install.mjs');
  if (fs.existsSync(upstreamEntry)) {
    return { alreadyInstalled: true, path: THEME_PATCH_DIR };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chuanban-base-'));
  try {
    console.log(`[claude-ux] Base theme-patch not found; cloning upstream ${UPSTREAM_REPO}...`);
    execFileSync('git', ['clone', '--depth', '1', UPSTREAM_REPO, tmpDir], { stdio: 'inherit' });
    execFileSync(process.execPath, [path.join(tmpDir, 'install.mjs'), 'install'], { stdio: 'inherit' });
    return { alreadyInstalled: false, installedFromUpstream: true, path: THEME_PATCH_DIR };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function unlockStepsViaLiveCdp() {
  const portFile = getDevToolsPortFile();
  const raw = readTextSafe(portFile);
  if (!raw) return { ok: false, reason: 'no_devtools_port_file' };
  const [port] = raw.trim().split(/\r?\n/);
  if (!port) return { ok: false, reason: 'empty_port' };

  let ws;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const list = await res.json();
    const target = list.find((x) => x.type === 'page' && String(x.url).includes('127.0.0.1:'));
    if (!target || !target.webSocketDebuggerUrl) {
      return { ok: false, reason: 'main_page_not_found' };
    }

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws_timeout')), 2500);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
      ws.addEventListener('error', (err) => {
        clearTimeout(t);
        reject(err);
      }, { once: true });
    });

    const evalFn = async function () {
      const allEls = document.querySelectorAll('#root *');
      let prefStore = null;
      for (const el of allEls) {
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        if (!key) continue;
        for (let f = el[key]; f && !prefStore; f = f.return) {
          for (let d = f.dependencies?.firstContext; d; d = d.next) {
            const v = d.memoizedValue;
            if (v && typeof v.getState === 'function') {
              const st = v.getState();
              if (st && typeof st.setPrefValue === 'function') {
                prefStore = v;
                break;
              }
            }
          }
        }
        if (prefStore) break;
      }
      if (!prefStore) return { found: false };
      const st = prefStore.getState();
      await st.setPrefValue('project4kMode', 1);
      await st.setPrefValue('verboseConversationSteps', true);
      return {
        found: true,
        project4kMode: prefStore.getState().getPrefValue('project4kMode'),
        verboseConversationSteps: prefStore.getState().getPrefValue('verboseConversationSteps')
      };
    };

    const msgPromise = new Promise((resolve) => {
      const handler = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.id === 1) {
          ws.removeEventListener('message', handler);
          resolve(d);
        }
      };
      ws.addEventListener('message', handler);
    });

    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: `(${evalFn.toString()})()`, awaitPromise: true, returnByValue: true }
      })
    );
    const out = await msgPromise;
    return { ok: true, cdp: out?.result?.result?.value || null };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    try {
      ws?.close();
    } catch {}
  }
}

function unlockStepsInConfigFiles() {
  const actions = [];
  if (fs.existsSync(AGY_STATE_PBTXT)) {
    const content = fs.readFileSync(AGY_STATE_PBTXT, 'utf8');
    if (content.includes('PRODUCT_SKIN_NON_TECHNICAL')) {
      const updated = content.replace(/product_skin:\s*PRODUCT_SKIN_NON_TECHNICAL/g, 'product_skin: PRODUCT_SKIN_DEVELOPER');
      fs.writeFileSync(AGY_STATE_PBTXT, updated, 'utf8');
      actions.push('updated_pbtxt_developer_skin');
    }
  }
  if (fs.existsSync(AGY_CONFIG_JSON)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(AGY_CONFIG_JSON, 'utf8'));
      cfg.userSettings = cfg.userSettings || {};
      if (cfg.userSettings.verboseConversationSteps !== true) {
        cfg.userSettings.verboseConversationSteps = true;
        fs.writeFileSync(AGY_CONFIG_JSON, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        actions.push('enabled_verbose_steps_in_config_json');
      }
    } catch {}
  }
  return actions;
}

function injectAgentsMdRule() {
  const ruleBlock = fs.readFileSync(path.join(__dirname, 'rules', 'claude-execution-sync.md'), 'utf8').trim();
  fs.mkdirSync(path.dirname(AGENTS_MD), { recursive: true });
  const existing = readTextSafe(AGENTS_MD) || '';

  if (existing.includes(RULE_BEGIN) && existing.includes(RULE_END)) {
    const re = new RegExp(`${RULE_BEGIN}[\\s\\S]*?${RULE_END}`);
    const next = existing.replace(re, ruleBlock);
    if (next !== existing) fs.writeFileSync(AGENTS_MD, next, 'utf8');
    return 'updated_marked_block';
  }
  if (existing.includes(LEGACY_HEADING)) {
    return 'already_present_unmarked';
  }
  const sep = existing.trim() ? '\n\n---\n\n' : '';
  fs.writeFileSync(AGENTS_MD, `${ruleBlock}${sep}${existing}`, 'utf8');
  return 'prepended_rule_block';
}

function removeAgentsMdRule() {
  const existing = readTextSafe(AGENTS_MD);
  if (!existing || !existing.includes(RULE_BEGIN)) return false;
  const re = new RegExp(`${RULE_BEGIN}[\\s\\S]*?${RULE_END}\\s*(?:---\\s*)?`, 'g');
  const next = existing.replace(re, '').replace(/^\s+/, '');
  fs.writeFileSync(AGENTS_MD, next, 'utf8');
  return true;
}

function installUserLayer() {
  fs.mkdirSync(THEME_USER_DIR, { recursive: true });
  const targets = ['config.json', 'custom.css', 'custom.js', 'i18n.override.json'];
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (const f of targets) {
      const cur = path.join(THEME_USER_DIR, f);
      if (fs.existsSync(cur)) {
        fs.copyFileSync(cur, path.join(BACKUP_DIR, f));
      }
    }
  }
  for (const f of targets) {
    fs.copyFileSync(path.join(__dirname, 'user', f), path.join(THEME_USER_DIR, f));
  }
  return targets;
}

function runUpstreamVerify() {
  const upstreamEntry = path.join(THEME_PATCH_DIR, 'install.mjs');
  if (!fs.existsSync(upstreamEntry)) return { ok: false, reason: 'upstream_missing' };
  const out = execFileSync(process.execPath, [upstreamEntry, 'verify'], { encoding: 'utf8' });
  return { ok: true, output: out.trim() };
}

async function cmdDoctor() {
  const fonts = checkFontsInstalled();
  const pbtxt = readTextSafe(AGY_STATE_PBTXT) || '';
  const cfgRaw = readTextSafe(AGY_CONFIG_JSON);
  let verboseSteps = null;
  try {
    verboseSteps = cfgRaw ? JSON.parse(cfgRaw)?.userSettings?.verboseConversationSteps ?? null : null;
  } catch {}
  const agentsRaw = readTextSafe(AGENTS_MD) || '';
  const report = {
    platform: process.platform,
    node: process.version,
    baseThemePatchInstalled: fs.existsSync(path.join(THEME_PATCH_DIR, 'install.mjs')),
    userLayerInstalled:
      (readTextSafe(path.join(THEME_USER_DIR, 'custom.js')) || '').includes('ag-claude-todo-card'),
    fonts,
    developerStepSkinUnlocked: pbtxt.includes('PRODUCT_SKIN_DEVELOPER'),
    verboseConversationSteps: verboseSteps,
    agentsRuleConfigured: agentsRaw.includes(RULE_BEGIN) || agentsRaw.includes(LEGACY_HEADING)
  };
  console.log(JSON.stringify(report, null, 2));
}

async function cmdInstall() {
  const base = ensureUpstreamThemePatch();
  const fontsBefore = checkFontsInstalled();
  let fontSync = null;
  if (!fontsBefore.hasAnthropicSans) {
    fontSync = syncFontsFromLocalClaudeApp();
  }
  const copiedFiles = installUserLayer();
  const cdpUnlock = await unlockStepsViaLiveCdp();
  const fileUnlock = unlockStepsInConfigFiles();
  const ruleStatus = injectAgentsMdRule();
  const verify = runUpstreamVerify();

  console.log(
    JSON.stringify(
      {
        ok: true,
        base,
        fontSync,
        copiedFiles,
        stepStreamUnlock: { cdpUnlock, fileUnlock },
        ruleStatus,
        verifyOk: verify.ok
      },
      null,
      2
    )
  );
}

async function cmdUninstall() {
  const targets = ['config.json', 'custom.css', 'custom.js', 'i18n.override.json'];
  const restored = [];
  if (fs.existsSync(BACKUP_DIR)) {
    for (const f of targets) {
      const bak = path.join(BACKUP_DIR, f);
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, path.join(THEME_USER_DIR, f));
        restored.push(f);
      }
    }
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  } else {
    fs.writeFileSync(path.join(THEME_USER_DIR, 'custom.css'), '/* user/custom.css */\n', 'utf8');
    fs.writeFileSync(path.join(THEME_USER_DIR, 'custom.js'), '/* user/custom.js */\n', 'utf8');
  }
  const ruleRemoved = removeAgentsMdRule();
  const verify = runUpstreamVerify();
  console.log(JSON.stringify({ ok: true, restored, ruleRemoved, verifyOk: verify.ok }, null, 2));
}

const sub = process.argv[2] || 'doctor';
if (sub === 'install') {
  await cmdInstall();
} else if (sub === 'uninstall') {
  await cmdUninstall();
} else if (sub === 'sync-fonts') {
  console.log(JSON.stringify(syncFontsFromLocalClaudeApp(), null, 2));
} else {
  await cmdDoctor();
}
