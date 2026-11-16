#!/usr/bin/env node
/**
 * antigravity-claude-ux — install.mjs
 * Zero-dependency CLI installer, step-stream unlocker, auto-updater, doctor & uninstaller (Node.js >= 22)
 *
 * Commands:
 *   node install.mjs install          Install/update UX layer, unlock step stream, inject AGENTS.md rule
 *   node install.mjs sync-upgrade     Pull latest GitHub updates & re-apply cleanly on Antigravity app update
 *   node install.mjs auto-update-on   Register macOS LaunchAgent watching Antigravity.app updates + 12h sync
 *   node install.mjs auto-update-off  Remove auto-update LaunchAgent
 *   node install.mjs doctor           Non-destructive health check across all layers
 *   node install.mjs sync-fonts       Copy Anthropic variable fonts from local macOS Claude.app if available
 *   node install.mjs uninstall        Restore previous user/ config, remove auto-updater & AGENTS.md rule block
 */

import crypto from 'node:crypto';
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
const SYNC_STATE_FILE = path.join(THEME_USER_DIR, '.claude-ux-sync-state.json');
const SYNC_LOG_FILE = path.join(THEME_USER_DIR, 'auto-sync.log');
const AGY_STATE_PBTXT = path.join(AGY_DIR, 'antigravity_state.pbtxt');
const AGY_CONFIG_JSON = path.join(GEMINI_DIR, 'config', 'config.json');
const AGENTS_MD = path.join(GEMINI_DIR, 'AGENTS.md');

const AUTOSYNC_LABEL = 'com.antigravity.claude-ux.autosync';
const AUTOSYNC_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${AUTOSYNC_LABEL}.plist`);

const UPSTREAM_REPO = 'https://github.com/Anarcadia/chuanban-antigravity-theme-patch.git';
const SELF_REPO = 'https://github.com/hongqi7/antigravity-claude-ux.git';
const RULE_BEGIN = '<!-- BEGIN antigravity-claude-ux -->';
const RULE_END = '<!-- END antigravity-claude-ux -->';
const LEGACY_HEADING = '## 执行过程同步（Claude 式边做边汇报）';
const USER_LAYER_FILES = ['config.json', 'custom.css', 'custom.js', 'i18n.override.json'];

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function sha256File(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return '';
  }
}

function appendSyncLog(msg) {
  try {
    fs.mkdirSync(THEME_USER_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}`;
    const prev = readTextSafe(SYNC_LOG_FILE);
    const lines = prev ? prev.trim().split('\n').slice(-199) : [];
    lines.push(line);
    fs.writeFileSync(SYNC_LOG_FILE, `${lines.join('\n')}\n`, 'utf8');
  } catch {}
}

function getAntigravityAppFingerprint() {
  if (process.platform === 'darwin') {
    const plist = '/Applications/Antigravity.app/Contents/Info.plist';
    const asar = '/Applications/Antigravity.app/Contents/Resources/app.asar';
    let version = 'unknown';
    try {
      version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], {
        encoding: 'utf8'
      }).trim();
    } catch {}
    let asarSig = 'missing';
    let asarMtimeMs = 0;
    try {
      const st = fs.statSync(asar);
      asarMtimeMs = st.mtimeMs;
      asarSig = `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {}
    return { version, asarSig, asarMtimeMs, sig: `${version}|${asarSig}` };
  }
  return { version: 'unknown', asarSig: 'unknown', asarMtimeMs: 0, sig: process.platform };
}

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

function ensureOrUpgradeUpstreamThemePatch({ checkRemoteUpdate = false } = {}) {
  const upstreamEntry = path.join(THEME_PATCH_DIR, 'install.mjs');
  const localInstalled = fs.existsSync(upstreamEntry);
  if (localInstalled && !checkRemoteUpdate) {
    return { alreadyInstalled: true, upgraded: false, path: THEME_PATCH_DIR };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chuanban-base-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', UPSTREAM_REPO, tmpDir], {
      stdio: localInstalled ? 'pipe' : 'inherit',
      timeout: 25000
    });
    const remoteManifestSha = sha256File(path.join(tmpDir, 'core', 'manifest.json'));
    const localManifestSha = sha256File(path.join(THEME_PATCH_DIR, 'core', 'manifest.json'));
    if (localInstalled && remoteManifestSha && remoteManifestSha === localManifestSha) {
      return { alreadyInstalled: true, upgraded: false, upToDate: true, path: THEME_PATCH_DIR };
    }
    execFileSync(process.execPath, [path.join(tmpDir, 'install.mjs'), 'install'], {
      stdio: localInstalled ? 'pipe' : 'inherit',
      timeout: 30000
    });
    return { alreadyInstalled: localInstalled, upgraded: true, path: THEME_PATCH_DIR };
  } catch (err) {
    if (localInstalled) {
      return { alreadyInstalled: true, upgraded: false, networkSkipped: String(err?.message || err) };
    }
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function pullSelfRepoIfGit() {
  if (!fs.existsSync(path.join(__dirname, '.git'))) {
    return { pulled: false, reason: 'not_git_checkout' };
  }
  try {
    const beforeHead = execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8'
    }).trim();
    execFileSync('git', ['-C', __dirname, 'pull', '--ff-only', '--quiet'], {
      stdio: 'pipe',
      timeout: 20000
    });
    const afterHead = execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8'
    }).trim();
    return { pulled: true, updated: beforeHead !== afterHead, beforeHead, afterHead };
  } catch (err) {
    return { pulled: false, reason: String(err?.message || err) };
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
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        (err) => {
          clearTimeout(t);
          reject(err);
        },
        { once: true }
      );
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

function injectAgentsMdRule(sourceRoot = __dirname) {
  const ruleBlock = fs.readFileSync(path.join(sourceRoot, 'rules', 'claude-execution-sync.md'), 'utf8').trim();
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

function installUserLayer(sourceRoot = __dirname) {
  fs.mkdirSync(THEME_USER_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (const f of USER_LAYER_FILES) {
      const cur = path.join(THEME_USER_DIR, f);
      if (fs.existsSync(cur)) {
        fs.copyFileSync(cur, path.join(BACKUP_DIR, f));
      }
    }
  }
  const copied = [];
  for (const f of USER_LAYER_FILES) {
    const src = path.join(sourceRoot, 'user', f);
    const dst = path.join(THEME_USER_DIR, f);
    if (fs.existsSync(src)) {
      if (sha256File(src) !== sha256File(dst)) {
        fs.copyFileSync(src, dst);
        copied.push(f);
      }
    }
  }
  return copied;
}

function runUpstreamVerify() {
  const upstreamEntry = path.join(THEME_PATCH_DIR, 'install.mjs');
  if (!fs.existsSync(upstreamEntry)) return { ok: false, reason: 'upstream_missing' };
  try {
    const out = execFileSync(process.execPath, [upstreamEntry, 'verify'], { encoding: 'utf8', timeout: 15000 });
    return { ok: true, output: out.trim() };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

function saveSyncState(fp) {
  fs.mkdirSync(THEME_USER_DIR, { recursive: true });
  fs.writeFileSync(
    SYNC_STATE_FILE,
    `${JSON.stringify({ appVersion: fp.version, appSig: fp.sig, lastSyncAt: Date.now(), repoUrl: SELF_REPO }, null, 2)}\n`,
    'utf8'
  );
}

function enableMacAutoUpdateAgent() {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'macos_launchd_only' };
  }
  fs.mkdirSync(path.dirname(AUTOSYNC_PLIST), { recursive: true });
  const scriptPath = path.join(__dirname, 'install.mjs');
  const envPath = Array.from(
    new Set(['/opt/homebrew/bin', '/usr/local/bin', path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
  ).join(':');

  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSYNC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
    <string>sync-upgrade</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
  </dict>
  <key>WatchPaths</key>
  <array>
    <string>/Applications/Antigravity.app/Contents/Info.plist</string>
    <string>/Applications/Antigravity.app/Contents/Resources/app.asar</string>
  </array>
  <key>StartInterval</key>
  <integer>43200</integer>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${SYNC_LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${SYNC_LOG_FILE}</string>
</dict>
</plist>
`;
  fs.writeFileSync(AUTOSYNC_PLIST, plistXml, 'utf8');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, AUTOSYNC_PLIST], { stdio: 'ignore' });
  } catch {}
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, AUTOSYNC_PLIST], { stdio: 'inherit' });
  return { ok: true, label: AUTOSYNC_LABEL, plist: AUTOSYNC_PLIST };
}

function disableMacAutoUpdateAgent() {
  if (process.platform !== 'darwin' || !fs.existsSync(AUTOSYNC_PLIST)) {
    return { removed: false };
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, AUTOSYNC_PLIST], { stdio: 'ignore' });
  } catch {}
  fs.rmSync(AUTOSYNC_PLIST, { force: true });
  return { removed: true, label: AUTOSYNC_LABEL };
}

async function cmdDoctor() {
  const fonts = checkFontsInstalled();
  const fp = getAntigravityAppFingerprint();
  const syncState = readJsonSafe(SYNC_STATE_FILE, null);
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
    antigravityAppVersion: fp.version,
    baseThemePatchInstalled: fs.existsSync(path.join(THEME_PATCH_DIR, 'install.mjs')),
    userLayerInstalled: (readTextSafe(path.join(THEME_USER_DIR, 'custom.js')) || '').includes('ag-claude-todo-card'),
    autoUpdateWatcherInstalled: fs.existsSync(AUTOSYNC_PLIST),
    lastSyncState: syncState,
    fonts,
    developerStepSkinUnlocked: pbtxt.includes('PRODUCT_SKIN_DEVELOPER'),
    verboseConversationSteps: verboseSteps,
    agentsRuleConfigured: agentsRaw.includes(RULE_BEGIN) || agentsRaw.includes(LEGACY_HEADING)
  };
  console.log(JSON.stringify(report, null, 2));
}

async function cmdInstall({ enableAutoUpdate = true } = {}) {
  const base = ensureOrUpgradeUpstreamThemePatch({ checkRemoteUpdate: false });
  const fontsBefore = checkFontsInstalled();
  let fontSync = null;
  if (!fontsBefore.hasAnthropicSans) {
    fontSync = syncFontsFromLocalClaudeApp();
  }
  const copiedFiles = installUserLayer(__dirname);
  const cdpUnlock = await unlockStepsViaLiveCdp();
  const fileUnlock = unlockStepsInConfigFiles();
  const ruleStatus = injectAgentsMdRule(__dirname);
  const verify = runUpstreamVerify();
  const fp = getAntigravityAppFingerprint();
  saveSyncState(fp);
  const autoUpdate =
    enableAutoUpdate && process.platform === 'darwin' ? enableMacAutoUpdateAgent() : { skipped: true };

  console.log(
    JSON.stringify(
      {
        ok: true,
        antigravityVersion: fp.version,
        base,
        fontSync,
        copiedFiles,
        stepStreamUnlock: { cdpUnlock, fileUnlock },
        ruleStatus,
        autoUpdate,
        verifyOk: verify.ok
      },
      null,
      2
    )
  );
}

async function cmdSyncUpgrade({ force = false } = {}) {
  const fp = getAntigravityAppFingerprint();
  // 若 Antigravity.app 刚刚在 12 秒内完成包体写入，稍候片刻让新进程完成冷启动监听
  if (fp.asarMtimeMs > 0 && Date.now() - fp.asarMtimeMs < 12000) {
    await new Promise((r) => setTimeout(r, 4500));
  }

  const prev = readJsonSafe(SYNC_STATE_FILE, {});
  const appChanged = prev?.appSig !== fp.sig;
  const staleRemoteCheck = !prev?.lastSyncAt || Date.now() - Number(prev.lastSyncAt) > 20 * 3600 * 1000;
  const shouldFetchRemote = force || appChanged || staleRemoteCheck;

  let selfPull = { skipped: true };
  let baseSync = { skipped: true };
  if (shouldFetchRemote) {
    selfPull = pullSelfRepoIfGit();
    baseSync = ensureOrUpgradeUpstreamThemePatch({ checkRemoteUpdate: true });
  }

  const copiedFiles = installUserLayer(__dirname);
  const cdpUnlock = await unlockStepsViaLiveCdp();
  const fileUnlock = unlockStepsInConfigFiles();
  const ruleStatus = injectAgentsMdRule(__dirname);

  let verify = { skipped: true };
  if (force || appChanged || selfPull.updated || baseSync.upgraded || copiedFiles.length > 0 || fileUnlock.length > 0) {
    verify = runUpstreamVerify();
  }

  saveSyncState(fp);
  const summary = `sync-upgrade ok | agy=${fp.version} | appChanged=${appChanged} | selfUpdated=${Boolean(selfPull.updated)} | coreUpgraded=${Boolean(baseSync.upgraded)} | copied=${copiedFiles.length}`;
  appendSyncLog(summary);
  console.log(JSON.stringify({ ok: true, summary, selfPull, baseSync, copiedFiles, cdpUnlock, fileUnlock, ruleStatus, verifyOk: verify.ok ?? null }, null, 2));
}

async function cmdUninstall() {
  const autoUpdateRemoved = disableMacAutoUpdateAgent();
  const restored = [];
  if (fs.existsSync(BACKUP_DIR)) {
    for (const f of USER_LAYER_FILES) {
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
  fs.rmSync(SYNC_STATE_FILE, { force: true });
  const ruleRemoved = removeAgentsMdRule();
  const verify = runUpstreamVerify();
  console.log(JSON.stringify({ ok: true, autoUpdateRemoved, restored, ruleRemoved, verifyOk: verify.ok }, null, 2));
}

const sub = process.argv[2] || 'doctor';
const flags = new Set(process.argv.slice(3));

if (sub === 'install') {
  await cmdInstall({ enableAutoUpdate: !flags.has('--no-auto-update') });
} else if (sub === 'sync-upgrade') {
  await cmdSyncUpgrade({ force: flags.has('--force') });
} else if (sub === 'auto-update-on') {
  console.log(JSON.stringify(enableMacAutoUpdateAgent(), null, 2));
} else if (sub === 'auto-update-off') {
  console.log(JSON.stringify(disableMacAutoUpdateAgent(), null, 2));
} else if (sub === 'uninstall') {
  await cmdUninstall();
} else if (sub === 'sync-fonts') {
  console.log(JSON.stringify(syncFontsFromLocalClaudeApp(), null, 2));
} else {
  await cmdDoctor();
}
