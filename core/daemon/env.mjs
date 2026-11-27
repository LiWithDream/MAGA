/**
 * Core Daemon Environment, Paths, Atomic File I/O & Endpoint Discovery
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CORE_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const HOME = os.homedir();

/* Optional built-in node:sqlite (Node >= 22.5 / unflagged in >= 22.13) */
let loadedDatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync: loadedDatabaseSync } = req('node:sqlite'));
} catch {}
export const DatabaseSync = loadedDatabaseSync;

/* CLI arguments */
export const argv = process.argv.slice(2);
export const VERIFY_ONCE = argv.includes('--verify-once');
export const RUN_ONCE = VERIFY_ONCE || argv.includes('--once');
export const NO_CDP_BOOTSTRAP = process.env.ANTI_CLAUDE_NO_CDP_BOOTSTRAP === '1';

export function resolveArgValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return null;
}

export const STATE_DIR = path.resolve(
  process.env.ANTI_CLAUDE_STATE_DIR || path.join(HOME, '.gemini', 'antigravity', 'anti-claude')
);
export const USER_DIR = path.resolve(
  resolveArgValue('--user-dir') || process.env.ANTI_CLAUDE_USER_DIR || path.join(STATE_DIR, 'user')
);
export const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
export const STOP_SIGNAL_FILE = path.join(STATE_DIR, 'daemon-stop.signal');
export const DAEMON_LOG_FILE = path.join(STATE_DIR, 'daemon.log');
export const WIN_DAEMON_META_FILE = path.join(STATE_DIR, 'win-daemon-meta.json');
export const RELAUNCH_INTENT_FILE = path.join(STATE_DIR, 'relaunch-intent.json');
export const UI_PREFS_FILE = path.join(STATE_DIR, 'ui-prefs.json');
export const STUDIO_PREFS_FILE = path.join(STATE_DIR, 'studio-prefs.json');
export const QUOTA_STATE_FILE = path.join(STATE_DIR, 'quota-state.json');
export const OPUS_GATE_PROPOSALS_DIR = path.join(STATE_DIR, 'opus-gate-proposals');
export const AUTO_COMPACT_REQUESTS_DIR = path.join(STATE_DIR, 'auto-compact-requests');
export const GIT_WORKFLOW_POLICY_FILE = path.join(STATE_DIR, 'git-workflow-policy.json');
export const GIT_WORKFLOW_EVENTS_FILE = path.join(STATE_DIR, 'git-workflow-events.json');
export const PROJECT_SUGGESTIONS_CONFIG_FILE = path.join(STATE_DIR, 'project-suggestions-config.json');
export const PROJECT_SUGGESTIONS_CACHE_DIR = path.join(STATE_DIR, 'project-suggestions-cache');
export const ANTIGRAVITY_BRAIN_DIR = path.resolve(
  process.env.ANTI_CLAUDE_BRAIN_DIR || path.join(HOME, '.gemini', 'antigravity', 'brain')
);
export const BASE_CONFIG_FILE = path.join(STATE_DIR, 'base', 'config.json');
export const PROJECTS_REGISTRY_FILE = path.join(STATE_DIR, 'projects-registry.json');
export const CORE_BASE_CSS_FILE = path.join(CORE_DIR, 'base.css');
export const CORE_I18N_FILE = path.join(CORE_DIR, 'i18n.json');
export const CORE_RUNTIME_FILE = path.join(CORE_DIR, 'runtime.js');
export const PKG_FILE = path.join(REPO_ROOT, 'package.json');
export const GLOBAL_PLUGINS_DIR = path.resolve(
  process.env.ANTI_CLAUDE_PLUGINS_DIR || path.join(HOME, '.gemini', 'config', 'plugins')
);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DB_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i;
export const PROJECT_RULE_BEGIN = '<!-- BEGIN anti-claude-project -->';
export const PROJECT_RULE_END = '<!-- END anti-claude-project -->';
export const PROJECT_META_REL = path.join('.anti-claude', 'project-context.json');
export const PROJECT_FILES_REL = path.join('.anti-claude', 'files');
export const SIDECARS_DIR = path.resolve(
  process.env.ANTI_CLAUDE_SIDECARS_DIR || path.join(HOME, '.gemini', 'config', 'sidecars')
);
export const NATIVE_PROJECTS_DIR = path.resolve(
  process.env.ANTI_CLAUDE_NATIVE_PROJECTS_DIR || path.join(HOME, '.gemini', 'config', 'projects')
);
export const GLOBAL_SKILLS_DIR = path.resolve(
  process.env.ANTI_CLAUDE_SKILLS_DIR || path.join(HOME, '.gemini', 'config', 'skills')
);
export const GLOBAL_AGENTS_DIR = path.resolve(
  process.env.ANTI_CLAUDE_AGENTS_DIR || path.join(HOME, '.gemini', 'config', 'agents')
);
export const RESERVED_AGENT_NAMES = new Set(['self', 'browser', 'research', 'deepagent', 'review-agent', 'image-generator']);
export const ALLOWED_AGENT_TOOLS = ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web'];
export const ALLOWED_UI_MODULE_KEYS = new Set([
  'i18n',
  'metrics',
  'composerWaxSeal',
  'deadlockHealer',
  'coldBootHealer',
  'zoomShortcuts',
  'customCss',
  'customJs',
  'claudeUxStepUnfold',
  'claudeUxCollapseAnimation',
  'claudeUxRunningTimer',
  'claudeUxContextRing',
  'claudeUxInlineUndo',
  'claudeUxFolderStatus',
  'claudeUxRecentSection',
  'claudeUxProjects',
  'claudeUxHideSidebarProjects',
  'claudeUxCustomizations',
  'claudeUxCodeFold',
  'claudeUxOverviewPanel'
]);
export const VALID_CJK_SCALES = new Set(['94.5', '95', '100']);
export const INLINE_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.xml',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go',
  '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.sql', '.sh', '.zsh',
  '.ini', '.conf', '.cfg', '.tex', '.rtf'
]);
export const MAX_INLINE_FILE_BYTES = 12 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 18 * 1024;

/* Shared daemon runtime state maps & lifecycle hooks (breaks circular module dependencies) */
export const attachedTargets = new Map();
export const skippedNonHostTargets = new Map();
export const targetThemeModes = new Map();
export const fallbackBackoffUntil = new Map();
export const runtimeState = {
  activeRelaunchPromise: null,
  wakeMacBootstrap: null,
  shuttingDown: false,
  lastReachablePort: 0,
  syncFn: null
};

export function statSig(p) {
  try {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    return st ? `${st.size}:${Math.floor(st.mtimeMs)}` : 'missing';
  } catch {
    return 'missing';
  }
}

export function readTextOrEmpty(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function readJsonOrFallback(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function setBounded(map, key, val, max = 128) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

export function resolveAtomicWriteTarget(filePath) {
  try {
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      try {
        return fs.realpathSync(filePath);
      } catch {
        return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
      }
    }
  } catch {}
  return filePath;
}

const WIN_RETRY_SLEEP_BUF =
  typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

export function renameWithWinRetry(
  src,
  dst,
  { platform = process.platform, maxAttempts = 10, backoffMs = 20, renameFn = fs.renameSync } = {}
) {
  if (platform !== 'win32') {
    renameFn(src, dst);
    return;
  }
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let i = 0; i < attempts; i += 1) {
    try {
      renameFn(src, dst);
      return;
    } catch (err) {
      const code = err?.code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || i === attempts - 1) throw err;
      if (WIN_RETRY_SLEEP_BUF) {
        try {
          const delayMs = Math.min(200, Math.round(backoffMs * Math.pow(1.6, i)));
          Atomics.wait(WIN_RETRY_SLEEP_BUF, 0, 0, delayMs);
        } catch {}
      }
    }
  }
}

let logTeeInstalled = false;

/** Tee console output to STATE_DIR/daemon.log when running headless on Windows without a TTY. */
export function installWinHeadlessLogTee({
  platform = process.platform,
  isTTY = Boolean(process.stdout?.isTTY),
  logFile = DAEMON_LOG_FILE,
  maxBytes = 512 * 1024,
} = {}) {
  if (logTeeInstalled || platform !== 'win32' || isTTY) return false;
  logTeeInstalled = true;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile)) {
      const st = fs.statSync(logFile);
      if (st.size > maxBytes) {
        const prev = `${logFile}.prev`;
        try {
          fs.rmSync(prev, { force: true });
        } catch {}
        renameWithWinRetry(logFile, prev, { platform });
      }
    }
  } catch {}

  const appendLine = (level, args) => {
    try {
      const msg = args
        .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${msg}\n`, 'utf8');
    } catch {}
  };

  for (const [method, level] of [
    ['log', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
  ]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      appendLine(level, args);
      return orig(...args);
    };
  }
  return true;
}

export function writeAtomicUtf8(filePath, content) {
  const target = resolveAtomicWriteTarget(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let prevMode = null;
  try {
    const st = fs.statSync(target, { throwIfNoEntry: false });
    if (st && st.isFile()) prevMode = st.mode & 0o777;
  } catch {}
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, prevMode !== null ? { encoding: 'utf8', mode: prevMode } : 'utf8');
    if (prevMode !== null) {
      try {
        fs.chmodSync(tmp, prevMode);
      } catch {}
    }
    renameWithWinRetry(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

export function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(os.release()) || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
  } catch {
    return false;
  }
}

export function isUncPath(p) {
  const s = String(p || '');
  return s.startsWith('\\\\') || s.startsWith('//') || s.startsWith('/mnt/');
}

export function discoverEndpoints() {
  const endpoints = [];
  const defaultConvDir = path.join(HOME, '.gemini', 'antigravity', 'conversations');

  if (process.platform === 'darwin') {
    endpoints.push({
      channel: 'darwin',
      portFile: path.join(HOME, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
      fallbackPort: 9222,
      conversationsDir: defaultConvDir
    });
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    endpoints.push({
      channel: 'win32',
      portFile: path.join(appData, 'Antigravity', 'DevToolsActivePort'),
      fallbackPort: 9222,
      conversationsDir: defaultConvDir
    });
  } else {
    endpoints.push({
      channel: 'linux',
      portFile: path.join(HOME, '.config', 'Antigravity', 'DevToolsActivePort'),
      fallbackPort: 9222,
      conversationsDir: defaultConvDir
    });
    if (isWsl()) {
      try {
        const usersDir = '/mnt/c/Users';
        if (fs.existsSync(usersDir)) {
          for (const u of fs.readdirSync(usersDir)) {
            if (/^(Public|Default|Default User|All Users)$/i.test(u)) continue;
            const winPort = path.join(usersDir, u, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort');
            if (fs.existsSync(path.dirname(winPort))) {
              const winConv = path.join(usersDir, u, '.gemini', 'antigravity', 'conversations');
              endpoints.push({
                channel: `wsl:${u}`,
                portFile: winPort,
                fallbackPort: 9222,
                conversationsDir: fs.existsSync(winConv) ? winConv : defaultConvDir
              });
            }
          }
        }
      } catch {}
    }
  }
  return endpoints;
}

export function readPort(portFile) {
  try {
    if (!portFile || !fs.existsSync(portFile)) return 0;
    const first = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0];
    const p = parseInt(first, 10);
    return p > 0 && p < 65536 ? p : 0;
  } catch {
    return 0;
  }
}
