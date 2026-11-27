/**
 * Windows Service, Start-Menu Shortcut, App Fingerprint, Proxy & Cooperative Daemon Lifecycle.
 * Pure Node built-ins; cross-platform unit-testable via dependency injection.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOME,
  PID_FILE,
  REPO_ROOT,
  STATE_DIR,
  STOP_SIGNAL_FILE,
  USER_DIR,
  WIN_DAEMON_META_FILE,
  readJsonOrFallback,
  writeAtomicUtf8,
} from './env.mjs';
import { isOwnDaemonProcess, requestCooperativeStop } from './pid.mjs';

export const WIN_TASK_NAME = 'AGYStudioDaemon';

function usesWinStylePath(p) {
  const s = String(p || '');
  return /^[A-Za-z]:[\\/]/.test(s) || s.includes('\\');
}

function dirnameSameStyle(p) {
  return usesWinStylePath(p) ? path.win32.dirname(p) : path.dirname(p);
}

function basenameSameStyle(p) {
  return usesWinStylePath(p) ? path.win32.basename(p) : path.basename(p);
}

function joinSameStyle(base, ...segs) {
  return usesWinStylePath(base) ? path.win32.join(base, ...segs) : path.join(base, ...segs);
}

function normalizeComparePath(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(s) {
  return String(s ?? '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function encodeUtf16LeWithBom(text) {
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(String(text ?? ''), 'utf16le');
  return Buffer.concat([bom, body]);
}

export function encodePowerShellBase64(script) {
  return Buffer.from(String(script ?? ''), 'utf16le').toString('base64');
}

export function psSingleQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

export function getWinStartupVbsPath(home = HOME, env = process.env) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Anti-Claude-Daemon.vbs');
}

export function getWinShortcutPath(home = HOME, env = process.env) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Antigravity (AGY Studio).lnk');
}

/**
 * Disambiguate Antigravity Desktop 2.0 from Antigravity IDE (VS Code fork sharing `Antigravity.exe`).
 */
export function isAntigravityDesktopExe(exePath, { existsSync = fs.existsSync, env = process.env } = {}) {
  if (!exePath || typeof exePath !== 'string') return false;
  const override = env.AGY_APP_EXE || env.ANTI_CLAUDE_APP_EXE || '';
  if (override && normalizeComparePath(override) === normalizeComparePath(exePath)) {
    return true;
  }
  const dir = dirnameSameStyle(exePath);
  if (!dir || dir === exePath) return false;
  if (existsSync(joinSameStyle(dir, 'resources', 'app', 'product.json'))) return false;
  if (existsSync(joinSameStyle(dir, 'resources', 'app', 'out', 'vs'))) return false;
  return Boolean(existsSync(joinSameStyle(dir, 'resources', 'app.asar')));
}

function compareSquirrelVersionDesc(a, b) {
  const pa = String(a || '').replace(/^app-/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^app-/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i += 1) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return String(b || '').localeCompare(String(a || ''));
}

export function findWinAntigravityDesktopExe({
  home = HOME,
  env = process.env,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
} = {}) {
  const candidates = [];
  const override = env.AGY_APP_EXE || env.ANTI_CLAUDE_APP_EXE || '';
  if (override) candidates.push(override);

  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || env.PROGRAMFILES_X86 || 'C:\\Program Files (x86)';

  candidates.push(joinSameStyle(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'));

  const squirrelRoot = joinSameStyle(localAppData, 'Antigravity');
  try {
    if (existsSync(squirrelRoot)) {
      const entries = readdirSync(squirrelRoot, { withFileTypes: true });
      const appDirs = entries
        .filter((ent) => {
          const name = typeof ent === 'string' ? ent : ent?.name;
          const isDir = typeof ent === 'string' ? true : ent?.isDirectory?.();
          return Boolean(isDir && /^app-\d+/i.test(name));
        })
        .map((ent) => (typeof ent === 'string' ? ent : ent.name))
        .sort(compareSquirrelVersionDesc);
      for (const dirName of appDirs) {
        candidates.push(joinSameStyle(squirrelRoot, dirName, 'Antigravity.exe'));
      }
    }
  } catch {}

  candidates.push(
    joinSameStyle(programFiles, 'Antigravity', 'Antigravity.exe'),
    joinSameStyle(programFilesX86, 'Antigravity', 'Antigravity.exe')
  );

  for (const cand of candidates) {
    if (!cand) continue;
    try {
      if (existsSync(cand) && isAntigravityDesktopExe(cand, { existsSync, env })) {
        return cand;
      }
    } catch {}
  }
  return null;
}

/** Read `package.json`'s version directly from an Electron ASAR archive without spawning child processes. */
export function readVersionFromAsar(asarPath, { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  if (!asarPath || !existsSync(asarPath)) return null;
  let fd = null;
  try {
    fd = fs.openSync(asarPath, 'r');
    const hdr = Buffer.alloc(16);
    if (fs.readSync(fd, hdr, 0, 16, 0) < 16) return null;
    if (hdr.readUInt32LE(0) !== 4) return null;
    const headerPickleSize = hdr.readUInt32LE(4);
    const headerJsonLen = hdr.readUInt32LE(12);
    if (
      headerPickleSize < 8 ||
      headerJsonLen <= 0 ||
      headerJsonLen > 32 * 1024 * 1024 ||
      headerJsonLen > headerPickleSize
    ) {
      return null;
    }
    const jsonBuf = Buffer.alloc(headerJsonLen);
    if (fs.readSync(fd, jsonBuf, 0, headerJsonLen, 16) < headerJsonLen) return null;
    const idx = JSON.parse(jsonBuf.toString('utf8'));
    const pkg = idx?.files?.['package.json'];
    if (!pkg || typeof pkg !== 'object') return null;

    if (pkg.unpacked === true) {
      const unpackedPkg = joinSameStyle(`${asarPath}.unpacked`, 'package.json');
      if (!existsSync(unpackedPkg)) return null;
      const parsed = JSON.parse(readFileSync(unpackedPkg, 'utf8'));
      const ver = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
      return ver || null;
    }

    const pkgOffset = Number(pkg.offset);
    const pkgSize = Number(pkg.size);
    if (!Number.isFinite(pkgOffset) || pkgOffset < 0 || !Number.isFinite(pkgSize) || pkgSize <= 0 || pkgSize > 256 * 1024) {
      return null;
    }
    const pkgBuf = Buffer.alloc(pkgSize);
    if (fs.readSync(fd, pkgBuf, 0, pkgSize, 8 + headerPickleSize + pkgOffset) < pkgSize) return null;
    const parsed = JSON.parse(pkgBuf.toString('utf8'));
    const ver = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
    return ver || null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function getWinAntigravityFingerprint(opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;
  const statSync = opts.statSync || fs.statSync;
  const readFileSync = opts.readFileSync || fs.readFileSync;
  const exePath = findWinAntigravityDesktopExe(opts);
  if (!exePath) {
    return { version: 'unknown', asarSig: 'missing', changedAtMs: 0, sig: 'win32', exePath: null };
  }
  const appDir = dirnameSameStyle(exePath);
  const asarPath = joinSameStyle(appDir, 'resources', 'app.asar');
  let asarSig = 'missing';
  let changedAtMs = 0;
  try {
    const st = statSync(asarPath);
    changedAtMs = Math.max(st.mtimeMs || 0, st.ctimeMs || 0);
    asarSig = `${st.size}:${Math.floor(st.mtimeMs || 0)}`;
  } catch {}

  let version = 'unknown';
  const parentName = basenameSameStyle(appDir);
  const squirrelMatch = parentName.match(/^app-(\d+\.\d+[^\s\\/]*)$/i);
  if (squirrelMatch) {
    version = squirrelMatch[1];
  } else {
    const updateYml = joinSameStyle(appDir, 'resources', 'app-update.yml');
    try {
      if (existsSync(updateYml)) {
        const raw = readFileSync(updateYml, 'utf8');
        const vm = raw.match(/^\s*version:\s*['"]?([^\s'"\r\n]+)['"]?/m);
        if (vm) version = vm[1].trim();
      }
    } catch {}
  }
  if (version === 'unknown' && existsSync(asarPath)) {
    const asarVer = readVersionFromAsar(asarPath, { existsSync, readFileSync });
    if (asarVer) version = asarVer;
  }
  return {
    version,
    asarSig,
    changedAtMs,
    sig: `${version}|${asarSig}`,
    exePath,
  };
}

export function stableWinNodePath(execPath = process.execPath, { env = process.env, existsSync = fs.existsSync, realpathSync = fs.realpathSync } = {}) {
  const localAppData = env.LOCALAPPDATA || '';
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const nvmSymlink = env.NVM_SYMLINK || '';
  const candidates = [
    nvmSymlink ? joinSameStyle(nvmSymlink, 'node.exe') : '',
    localAppData ? joinSameStyle(localAppData, 'Volta', 'bin', 'node.exe') : '',
    joinSameStyle(programFiles, 'nodejs', 'node.exe'),
  ].filter(Boolean);

  if (localAppData && normalizeComparePath(execPath).includes('/volta/tools/image/node/')) {
    const shim = joinSameStyle(localAppData, 'Volta', 'bin', 'node.exe');
    if (existsSync(shim)) return shim;
  }

  let realExec = execPath;
  try {
    realExec = realpathSync(execPath);
  } catch {}

  if (normalizeComparePath(execPath).includes('/fnm_multishells/')) {
    return realExec || execPath;
  }

  for (const c of candidates) {
    try {
      if (existsSync(c) && normalizeComparePath(realpathSync(c)) === normalizeComparePath(realExec)) {
        return c;
      }
    } catch {}
  }
  return realExec || execPath;
}

export function buildWinStartupVbs(nodePath, daemonScript, userDir) {
  const vbsExpr = (s) => {
    const parts = [];
    let buf = '';
    const flush = () => {
      if (buf) {
        parts.push(`"${buf}"`);
        buf = '';
      }
    };
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (ch === '"') buf += '""';
      else if (cp >= 32 && cp <= 126) buf += ch;
      else if (cp <= 0xffff) {
        flush();
        parts.push(`ChrW(${cp})`);
      } else {
        flush();
        const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
        const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
        parts.push(`ChrW(${hi})`, `ChrW(${lo})`);
      }
    }
    flush();
    return parts.length ? parts.join(' & ') : '""';
  };
  const cmdExpr = vbsExpr(`"${nodePath}" "${daemonScript}" --user-dir "${userDir}"`);
  return `Set sh = CreateObject("WScript.Shell")\r\nsh.Run ${cmdExpr}, 0, False\r\n`;
}

function decodeVbsExpr(expr) {
  const tokens = String(expr || '').split(/\s*&\s*/);
  let out = '';
  for (const tok of tokens) {
    const t = tok.trim();
    if (!t) continue;
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
      out += t.slice(1, -1).replace(/""/g, '"');
    } else {
      const cm = t.match(/^ChrW\((\d+)\)$/i);
      if (cm) {
        out += String.fromCharCode(parseInt(cm[1], 10));
      }
    }
  }
  return out;
}

function parseQuotedTokens(str) {
  const tokens = [];
  const s = String(str || '').trim();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;
    if (s[i] === '"') {
      i += 1;
      let val = '';
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          val += s[i];
          i += 1;
        }
      }
      tokens.push(val);
    } else {
      let start = i;
      while (i < s.length && !/\s/.test(s[i])) i += 1;
      tokens.push(s.slice(start, i));
    }
  }
  return tokens;
}

function extractDaemonArgsFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) {
    return { nodePath: null, scriptPath: null, userDir: null };
  }
  let idx = 0;
  if (/conhost(?:\.exe)?$/i.test(basenameSameStyle(tokens[0]))) {
    idx += 1;
    if (tokens[idx] === '--headless') idx += 1;
  }
  const nodePath = tokens[idx] || null;
  const scriptPath = tokens[idx + 1] || null;
  let userDir = null;
  const udIdx = tokens.indexOf('--user-dir', idx + 2);
  if (udIdx !== -1 && tokens[udIdx + 1]) {
    userDir = tokens[udIdx + 1];
  }
  return { nodePath, scriptPath, userDir };
}

export function parseWinStartupVbs(vbsText) {
  const m = String(vbsText || '').match(/sh\.Run\s+(.+?),\s*0,\s*False/i);
  if (!m) return { nodePath: null, scriptPath: null, userDir: null };
  const cmdLine = decodeVbsExpr(m[1]);
  return extractDaemonArgsFromTokens(parseQuotedTokens(cmdLine));
}

export function getCurrentWinUserId(env = process.env) {
  if (env.USERDOMAIN && env.USERNAME) return `${env.USERDOMAIN}\\${env.USERNAME}`;
  if (env.USERNAME) return env.USERNAME;
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

export function buildWinScheduledTaskXml({
  nodePath,
  daemonScript,
  userDir,
  userId = '',
  conhostPath = '%SystemRoot%\\System32\\conhost.exe',
}) {
  const userTag = userId ? `\n      <UserId>${xmlEscape(userId)}</UserId>` : '';
  const principalUserTag = userId ? `\n      <UserId>${xmlEscape(userId)}</UserId>` : '';
  const args = `--headless "${nodePath}" "${daemonScript}" --user-dir "${userDir}"`;
  const workDir = dirnameSameStyle(daemonScript);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>AGY Studio background CDP and metrics daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>${userTag}
      <Enabled>true</Enabled>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2025-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalUserTag}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(conhostPath)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function parseWinScheduledTaskXml(xmlText) {
  const s = String(xmlText || '');
  const cmdM = s.match(/<Command>([\s\S]*?)<\/Command>/i);
  const argsM = s.match(/<Arguments>([\s\S]*?)<\/Arguments>/i);
  if (!cmdM) return { nodePath: null, scriptPath: null, userDir: null };
  const cmd = xmlUnescape(cmdM[1].trim());
  const args = argsM ? xmlUnescape(argsM[1].trim()) : '';
  const tokens = [cmd, ...parseQuotedTokens(args)];
  return extractDaemonArgsFromTokens(tokens);
}

function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

export function stopWinDaemonGracefully({
  pidFile = PID_FILE,
  stopFile = STOP_SIGNAL_FILE,
  timeoutMs = 7000,
  noKill = false,
  isMatchingPidFn = isOwnDaemonProcess,
  killFn = process.kill,
  sleepFn = sleepSync,
} = {}) {
  let stopped = false;
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pid > 0 && isMatchingPidFn(pid)) {
      stopped = true;
      if (!noKill) {
        try {
          requestCooperativeStop(pid, { stopFile });
        } catch {}
        const deadline = Date.now() + Math.max(200, timeoutMs);
        while (Date.now() < deadline) {
          if (!isMatchingPidFn(pid)) break;
          sleepFn(150);
        }
        if (isMatchingPidFn(pid)) {
          try {
            killFn(pid, 'SIGTERM');
          } catch {}
        }
      }
    }
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {}
  }
  try {
    fs.rmSync(stopFile, { force: true });
  } catch {}
  return { stopped };
}

export function ensureWinStudioShortcut({
  exePath,
  shortcutPath = getWinShortcutPath(),
  enabled = true,
  execFileSyncFn = execFileSync,
} = {}) {
  if (!enabled || !exePath) return { ok: false, skipped: 'disabled_or_missing_exe' };
  const appDir = dirnameSameStyle(exePath);
  const ps = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$sc = $ws.CreateShortcut(${psSingleQuote(shortcutPath)})`,
    `$sc.TargetPath = ${psSingleQuote(exePath)}`,
    `$sc.Arguments = '--remote-debugging-port=0'`,
    `$sc.WorkingDirectory = ${psSingleQuote(appDir)}`,
    `$sc.Description = 'Launch Antigravity with AGY Studio CDP support'`,
    `$sc.IconLocation = ${psSingleQuote(`${exePath},0`)}`,
    `$sc.Save()`,
  ].join('; ');
  try {
    fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
    execFileSyncFn(
      'powershell',
      ['-NoProfile', '-EncodedCommand', encodePowerShellBase64(ps)],
      { windowsHide: true, timeout: 6000, stdio: 'pipe' }
    );
    return { ok: true, shortcutPath, exePath };
  } catch (err) {
    return { ok: false, shortcutPath, reason: String(err?.stderr || err?.message || err).trim() };
  }
}

export function removeWinStudioShortcut({ shortcutPath = getWinShortcutPath() } = {}) {
  try {
    if (fs.existsSync(shortcutPath)) {
      fs.rmSync(shortcutPath, { force: true });
      return { removed: true, shortcutPath };
    }
  } catch {}
  return { removed: false, shortcutPath };
}

export function ensureWinCoreDaemon({
  nodePath = stableWinNodePath(),
  daemonScript = path.join(REPO_ROOT, 'core', 'daemon.mjs'),
  userDir = USER_DIR,
  stateDir = STATE_DIR,
  pidFile = PID_FILE,
  stopFile = STOP_SIGNAL_FILE,
  metaFile = WIN_DAEMON_META_FILE,
  taskName = WIN_TASK_NAME,
  vbsPath = getWinStartupVbsPath(),
  shortcutPath = getWinShortcutPath(),
  createShortcut = true,
  noLaunchd = false,
  spawnDetachedFn = () => null,
  isMatchingPidFn = isOwnDaemonProcess,
  execFileSyncFn = execFileSync,
  sleepFn = sleepSync,
  waitPidTimeoutMs = 3000,
} = {}) {
  if (noLaunchd) return { ok: true, skipped: 'launchd_disabled' };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });

  stopWinDaemonGracefully({ pidFile, stopFile, isMatchingPidFn, sleepFn });

  const userId = getCurrentWinUserId();
  const xml = buildWinScheduledTaskXml({ nodePath, daemonScript, userDir, userId });
  const tmpXml = path.join(os.tmpdir(), `agy-studio-task-${process.pid}-${Date.now()}.xml`);
  let mode = 'schtasks';
  let schtasksErr = '';

  try {
    fs.writeFileSync(tmpXml, encodeUtf16LeWithBom(xml));
    execFileSyncFn('schtasks', ['/Create', '/F', '/TN', taskName, '/XML', tmpXml], {
      windowsHide: true,
      timeout: 8000,
      stdio: 'pipe',
    });
  } catch (err) {
    mode = 'vbs';
    schtasksErr = String(err?.stderr || err?.message || err).trim();
  } finally {
    try {
      fs.rmSync(tmpXml, { force: true });
    } catch {}
  }

  let pid = null;
  if (mode === 'schtasks') {
    try {
      if (fs.existsSync(vbsPath)) fs.rmSync(vbsPath, { force: true });
    } catch {}
    // Ensure a lingering Running task instance does not swallow /Run under IgnoreNew policy.
    try {
      execFileSyncFn('schtasks', ['/End', '/TN', taskName], {
        windowsHide: true,
        timeout: 4000,
        stdio: 'pipe',
      });
      sleepFn(200);
    } catch {}

    let runOk = false;
    try {
      execFileSyncFn('schtasks', ['/Run', '/TN', taskName], {
        windowsHide: true,
        timeout: 6000,
        stdio: 'pipe',
      });
      runOk = true;
    } catch {}

    if (runOk) {
      const deadline = Date.now() + Math.max(0, Number(waitPidTimeoutMs) || 0);
      while (true) {
        try {
          if (fs.existsSync(pidFile)) {
            const curPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
            if (curPid > 0 && isMatchingPidFn(curPid)) {
              pid = curPid;
              break;
            }
          }
        } catch {}
        if (Date.now() >= deadline) break;
        sleepFn(150);
      }
    }
    if (!pid) {
      pid = spawnDetachedFn(nodePath);
    }
  } else {
    const vbs = buildWinStartupVbs(nodePath, daemonScript, userDir);
    try {
      writeAtomicUtf8(vbsPath, vbs);
    } catch {}
    pid = spawnDetachedFn(nodePath);
  }

  let shortcutRes = { skipped: true };
  if (createShortcut) {
    const exePath = findWinAntigravityDesktopExe();
    if (exePath) {
      shortcutRes = ensureWinStudioShortcut({ exePath, shortcutPath, enabled: true, execFileSyncFn });
    }
  }

  const meta = {
    schema: 1,
    mode,
    taskName,
    vbsPath,
    nodePath,
    scriptPath: daemonScript,
    userDir,
    daemonRepoDir: dirnameSameStyle(dirnameSameStyle(daemonScript)),
    ...(shortcutRes?.ok ? { shortcutPath, shortcutExePath: shortcutRes.exePath } : {}),
    updatedAt: Date.now(),
  };
  try {
    writeAtomicUtf8(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  } catch {}

  return {
    ok: true,
    mode,
    ...(mode === 'schtasks' ? { taskName } : { startupVbs: vbsPath, schtasksNote: schtasksErr || undefined }),
    node: nodePath,
    ...(pid ? { pid } : {}),
    ...(shortcutRes?.ok ? { shortcutPath } : {}),
  };
}

export function disableWinCoreDaemon({
  pidFile = PID_FILE,
  stopFile = STOP_SIGNAL_FILE,
  metaFile = WIN_DAEMON_META_FILE,
  taskName = WIN_TASK_NAME,
  vbsPath = getWinStartupVbsPath(),
  shortcutPath = getWinShortcutPath(),
  noLaunchd = false,
  isMatchingPidFn = isOwnDaemonProcess,
  execFileSyncFn = execFileSync,
} = {}) {
  const stopRes = stopWinDaemonGracefully({ pidFile, stopFile, noKill: noLaunchd, isMatchingPidFn });
  let stopped = stopRes.stopped;

  if (!noLaunchd) {
    try {
      execFileSyncFn('schtasks', ['/End', '/TN', taskName], { windowsHide: true, timeout: 4000, stdio: 'ignore' });
    } catch {}
    try {
      execFileSyncFn('schtasks', ['/Delete', '/F', '/TN', taskName], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
      stopped = true;
    } catch {}
  }

  if (fs.existsSync(vbsPath)) {
    try {
      fs.rmSync(vbsPath, { force: true });
      stopped = true;
    } catch {}
  }
  removeWinStudioShortcut({ shortcutPath });
  if (fs.existsSync(metaFile)) {
    try {
      fs.rmSync(metaFile, { force: true });
    } catch {}
  }
  return { stopped };
}

export function inspectWinCoreDaemon({
  pidFile = PID_FILE,
  metaFile = WIN_DAEMON_META_FILE,
  taskName = WIN_TASK_NAME,
  vbsPath = getWinStartupVbsPath(),
  isMatchingPidFn = isOwnDaemonProcess,
  execFileSyncFn = execFileSync,
  existsSyncFn = fs.existsSync,
} = {}) {
  let pidAlive = false;
  let pid = null;
  if (existsSyncFn(pidFile)) {
    const parsed = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (parsed > 0) {
      pid = parsed;
      pidAlive = isMatchingPidFn(parsed);
    }
  }

  let parsed = { nodePath: null, scriptPath: null, userDir: null };
  let mode = null;
  let installed = false;

  try {
    const xmlOut = execFileSyncFn('schtasks', ['/Query', '/TN', taskName, '/XML'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (xmlOut && /<Task\b/i.test(xmlOut)) {
      installed = true;
      mode = 'schtasks';
      parsed = parseWinScheduledTaskXml(xmlOut);
    }
  } catch {}

  if (!installed && existsSyncFn(vbsPath)) {
    installed = true;
    mode = 'vbs';
    try {
      parsed = parseWinStartupVbs(fs.readFileSync(vbsPath, 'utf8'));
    } catch {}
  }

  // schtasks /Query /XML outputs in the active Windows OEM codepage; non-ASCII usernames can arrive with \uFFFD.
  const meta = readJsonOrFallback(metaFile, null);
  const pickValidPath = (raw, metaVal) => {
    if (!metaVal) return raw;
    if (!raw || raw.includes('\uFFFD')) return metaVal;
    if (!existsSyncFn(raw) && existsSyncFn(metaVal)) return metaVal;
    return raw;
  };
  parsed.nodePath = pickValidPath(parsed.nodePath, meta?.nodePath);
  parsed.scriptPath = pickValidPath(parsed.scriptPath, meta?.scriptPath);
  if ((!parsed.userDir || parsed.userDir.includes('\uFFFD')) && meta?.userDir) {
    parsed.userDir = meta.userDir;
  }
  if (!mode && meta?.mode) mode = meta.mode;

  const nodePath = parsed.nodePath || null;
  const scriptPath = parsed.scriptPath || null;
  const daemonRepoDir = scriptPath ? dirnameSameStyle(dirnameSameStyle(scriptPath)) : null;

  return {
    installed,
    mode,
    running: pidAlive,
    pid,
    taskName: mode === 'schtasks' ? taskName : null,
    startupVbs: existsSyncFn(vbsPath) ? vbsPath : null,
    nodePath,
    nodeExists: Boolean(nodePath && existsSyncFn(nodePath)),
    scriptPath,
    scriptExists: Boolean(scriptPath && existsSyncFn(scriptPath)),
    daemonRepoDir,
  };
}

export function parseWinInternetSettingsReg(regOutput) {
  const out = {
    httpEnabled: false,
    httpsEnabled: false,
    socksEnabled: false,
    pacEnabled: false,
    proxyServer: null,
    pacUrl: null,
  };
  let proxyEnable = false;
  for (const line of String(regOutput || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+REG_[A-Z_]+\s+(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'proxyenable') {
      proxyEnable = /^0x1$/i.test(val) || val === '1';
    } else if (key === 'proxyserver' && val) {
      out.proxyServer = val;
    } else if (key === 'autoconfigurl' && val) {
      out.pacUrl = val;
      out.pacEnabled = true;
    }
  }
  if (proxyEnable && out.proxyServer) {
    const srv = out.proxyServer;
    if (srv.includes('=')) {
      if (/\bhttp=/i.test(srv)) out.httpEnabled = true;
      if (/\bhttps=/i.test(srv)) out.httpsEnabled = true;
      if (/\bsocks=/i.test(srv)) out.socksEnabled = true;
    } else {
      out.httpEnabled = true;
      out.httpsEnabled = true;
    }
  }
  return out;
}

export function collectWinProxyDiagnostics({ execFileSyncFn = execFileSync } = {}) {
  try {
    const res = execFileSyncFn(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return parseWinInternetSettingsReg(res);
  } catch {
    return null;
  }
}

export function runWindowsCimCreate(commandLine, workingDir, { spawnSyncFn = spawnSync } = {}) {
  const script = [
    `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psSingleQuote(commandLine)}; CurrentDirectory = ${psSingleQuote(workingDir)} }`,
    `if ($null -eq $res -or $res.ReturnValue -ne 0) { exit 1 }`,
  ].join('; ');
  const r = spawnSyncFn(
    'powershell',
    ['-NoProfile', '-EncodedCommand', encodePowerShellBase64(script)],
    { windowsHide: true, timeout: 6000, encoding: 'utf8' }
  );
  return r.status === 0;
}
