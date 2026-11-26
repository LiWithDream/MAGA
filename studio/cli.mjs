#!/usr/bin/env node
/**
 * MAGA (agy-studio) CLI — unified manager for daemon installation, hot-deploy, rules & diagnostics.
 *
 * Commands:
 *   node studio/cli.mjs install         Build & install daemon from this repo + deploy studio + sync fast-io rules
 *   node studio/cli.mjs deploy          Rebuild & hot-deploy studio JS/CSS bundle into live user/ directory
 *   node studio/cli.mjs sync-rules      Sync critically pruned fast-io rules into ~/.gemini/AGENTS.md
 *   node studio/cli.mjs doctor          Verify daemon, plist, CDP, usage stats, bundle markers & config
 *   node studio/cli.mjs rollback        Strip studio blocks and restore stock defaults
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CSS_BEGIN,
  JS_BEGIN,
  REPO_ROOT,
  TARGET_CUSTOM_CSS,
  TARGET_CUSTOM_JS,
  buildUserCustomJs,
  deployStudio,
  rollbackStudio,
  stripBlock,
  stripStudioBlocksOnly,
} from './build.mjs';
import { collectUsageStatsAsync } from './daemon/usage-service.mjs';
import { isOpusGatePluginInstalled, syncOpusGatePlugin } from './daemon/opus-gate-service.mjs';
import {
  isAutoCompactPluginInstalled,
  syncAutoCompactPlugin,
  verifyLiveScheduleStepDecoder,
} from './daemon/auto-compact-service.mjs';
import { QUOTA_STATE_FILE } from '../core/daemon/env.mjs';
import { evaluateDeployGuard, readDeployMeta } from './deploy-meta.mjs';

const HOME = homedir();
const AGENTS_MD = path.join(HOME, '.gemini', 'AGENTS.md');
const AGY_CONFIG_JSON = path.join(HOME, '.gemini', 'config', 'config.json');
const DAEMON_PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'com.antigravity.anti-claude.daemon.plist');
const RULES_SRC = path.join(REPO_ROOT, 'studio', 'rules', 'fast-io.md');

const RULE_BEGIN = '<!-- BEGIN agy-fast-io-pruned -->';
const RULE_END = '<!-- END agy-fast-io-pruned -->';
const DEFAULT_ORCHESTRATOR_MODEL_ID = 1532; // Gemini 4 Neon (High)
const DEFAULT_ORCHESTRATOR_MODEL_ENUM = 'MODEL_PLACEHOLDER_M532';

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function syncFastIoRules() {
  const block = readFileSync(RULES_SRC, 'utf8').trim();
  const existing = existsSync(AGENTS_MD) ? readFileSync(AGENTS_MD, 'utf8') : '';
  const cleaned = stripBlock(existing, RULE_BEGIN, RULE_END).trim();
  const next = cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`;
  mkdirSync(path.dirname(AGENTS_MD), { recursive: true });
  writeFileSync(AGENTS_MD, next, 'utf8');
  return { ok: true, path: AGENTS_MD };
}

async function applyCollapsedStepsPreference() {
  // Persist verboseConversationSteps: false on disk AND push into live React pref store via CDP
  // so running Antigravity does not overwrite the disk edit on exit.
  if (existsSync(AGY_CONFIG_JSON)) {
    const cfg = readJsonSafe(AGY_CONFIG_JSON);
    if (cfg && typeof cfg === 'object') {
      cfg.userSettings = cfg.userSettings || {};
      if (cfg.userSettings.verboseConversationSteps !== false) {
        cfg.userSettings.verboseConversationSteps = false;
        writeFileSync(AGY_CONFIG_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      }
    }
  }
  try {
    const { cdpPrefs } = await import(path.join(REPO_ROOT, 'install.mjs'));
    if (typeof cdpPrefs === 'function') {
      await cdpPrefs({ project4kMode: 1, verboseConversationSteps: false });
    }
  } catch {}
}

async function applyDefaultOrchestratorModelPreference() {
  // Default Orchestrator planner to Gemini 4 Neon (High) only when unset, preserving explicit user overrides.
  let cdpHandled = false;
  try {
    const { cdpPrefs } = await import(path.join(REPO_ROOT, 'install.mjs'));
    if (typeof cdpPrefs === 'function') {
      const live = await cdpPrefs(null, ['orchestratorModel']);
      if (live?.ok) {
        cdpHandled = true;
        const current = live.after?.orchestratorModel;
        if (current === 0 || current === undefined || current === null) {
          await cdpPrefs({ orchestratorModel: DEFAULT_ORCHESTRATOR_MODEL_ID });
        }
      }
    }
  } catch {}
  if (!cdpHandled && existsSync(AGY_CONFIG_JSON)) {
    const cfg = readJsonSafe(AGY_CONFIG_JSON);
    if (cfg && typeof cfg === 'object') {
      cfg.userSettings = cfg.userSettings || {};
      const cur = cfg.userSettings.orchestratorModel;
      if (cur === undefined || cur === null || cur === '' || cur === 0 || cur === 'MODEL_UNSPECIFIED') {
        cfg.userSettings.orchestratorModel = DEFAULT_ORCHESTRATOR_MODEL_ENUM;
        writeFileSync(AGY_CONFIG_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      }
    }
  }
}

async function runAntiClaudeInstall() {
  await buildUserCustomJs({ writeToRepo: true, allowPrebuilt: true });
  // Strip studio blocks before base install so base custom.{js,css} installs cleanly
  stripStudioBlocksOnly();
  const installScript = path.join(REPO_ROOT, 'install.mjs');
  execFileSync(
    process.execPath,
    [installScript, 'install', '--no-auto-update', '--no-agents-rule', '--no-step-unlock'],
    { stdio: 'inherit', cwd: REPO_ROOT }
  );
  await applyCollapsedStepsPreference();
  await applyDefaultOrchestratorModelPreference();
}

async function runDoctor() {
  let baseDoctor = null;
  try {
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'install.mjs'), 'doctor'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    baseDoctor = JSON.parse(out);
  } catch (err) {
    baseDoctor = { ok: false, error: String(err?.message || err) };
  }

  const plistText = existsSync(DAEMON_PLIST) ? readFileSync(DAEMON_PLIST, 'utf8') : '';
  const pointsToStudio = plistText.includes(path.join(REPO_ROOT, 'core', 'daemon.mjs'));
  const plistDaemonMatch = plistText.match(/<string>([^<]*[\\/]core[\\/]daemon\.mjs)<\/string>/);
  const daemonRepoDir = plistDaemonMatch ? path.dirname(path.dirname(plistDaemonMatch[1].trim())) : null;
  const hasJsMarker = existsSync(TARGET_CUSTOM_JS) && readFileSync(TARGET_CUSTOM_JS, 'utf8').includes(JS_BEGIN);
  const hasCssMarker = existsSync(TARGET_CUSTOM_CSS) && readFileSync(TARGET_CUSTOM_CSS, 'utf8').includes(CSS_BEGIN);
  const agyCfg = readJsonSafe(AGY_CONFIG_JSON);
  const hasFastIo = existsSync(AGENTS_MD) && readFileSync(AGENTS_MD, 'utf8').includes(RULE_BEGIN);
  const usage = await collectUsageStatsAsync({ force: true });
  const deployMeta = readDeployMeta();

  let daemonAlignedWithDeploy = true;
  if (daemonRepoDir && deployMeta.present && deployMeta.meta?.worktreePath) {
    try {
      const a = realpathSync(deployMeta.meta.worktreePath);
      const b = realpathSync(daemonRepoDir);
      daemonAlignedWithDeploy = process.platform === 'darwin' || process.platform === 'win32'
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    } catch {
      daemonAlignedWithDeploy = deployMeta.meta.worktreePath === daemonRepoDir;
    }
  }
  const daemonSplitBrainWarning =
    !daemonAlignedWithDeploy && deployMeta.meta
      ? `UI/daemon split-brain: live bundle deployed from '${deployMeta.meta.branch || 'unknown'}' (${deployMeta.meta.worktreePath}), while LaunchAgent daemon runs core/daemon.mjs from '${daemonRepoDir}'.`
      : null;

  return {
    ok: Boolean(
      baseDoctor?.ok &&
      pointsToStudio &&
      hasJsMarker &&
      hasCssMarker &&
      usage?.ok
    ),
    repoRoot: REPO_ROOT,
    daemonRepoDir,
    daemonAlignedWithDeploy,
    ...(daemonSplitBrainWarning ? { daemonSplitBrainWarning } : {}),
    deployedFrom: deployMeta.meta,
    ...(deployMeta.nonMainWarning ? { deployedFromWarning: deployMeta.nonMainWarning } : {}),
    daemonPointsToStudio: pointsToStudio,
    studioBundle: { jsInjected: hasJsMarker, cssInjected: hasCssMarker },
    remoteControlEnabled: agyCfg?.userSettings?.remoteControlEnabled ?? agyCfg?.remoteControlEnabled ?? null,
    verboseConversationSteps: agyCfg?.userSettings?.verboseConversationSteps ?? null,
    orchestratorModel: agyCfg?.userSettings?.orchestratorModel ?? null,
    fastIoRuleInstalled: hasFastIo,
    opusGatePluginInstalled: isOpusGatePluginInstalled(),
    opusGateQuotaStatePresent: existsSync(QUOTA_STATE_FILE),
    autoCompactPluginInstalled: isAutoCompactPluginInstalled(),
    autoCompactDecoder: verifyLiveScheduleStepDecoder(),
    proxyDiagnostics: collectProxyDiagnostics(),
    usageSummary: {
      daysCount: usage.days.length,
      unread: usage.unread,
      latestDay: usage.days.at(-1)?.date || null,
    },
    baseDoctor,
  };
}

function collectProxyDiagnostics() {
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const shellProxyEnvKeys = proxyKeys.filter((k) => {
    const v = process.env[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
  let systemProxy = null;
  let hint = null;
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
      systemProxy = {
        httpEnabled: /\bHTTPEnable\s*:\s*1\b/.test(raw),
        httpsEnabled: /\bHTTPSEnable\s*:\s*1\b/.test(raw),
        socksEnabled: /\bSOCKSEnable\s*:\s*1\b/.test(raw),
        pacEnabled: /\bProxyAutoConfigEnable\s*:\s*1\b/.test(raw),
      };
      const anySysProxy = systemProxy.httpEnabled || systemProxy.httpsEnabled || systemProxy.socksEnabled || systemProxy.pacEnabled;
      if (shellProxyEnvKeys.length > 0 && !anySysProxy) {
        hint = 'Shell proxy env vars detected while macOS System Proxy is disabled; MAGA auto-forwards proxy env vars during CDP relaunch, and enabling System Proxy or TUN mode is recommended if Antigravity language_server reports loadCodeAssist: EOF.';
      }
    } catch {
      systemProxy = null;
    }
  }
  return { shellProxyEnvKeys, systemProxy, hint };
}

const [cmd = 'deploy', ...cliArgs] = process.argv.slice(2);
const allowNonMainDeploy =
  cliArgs.includes('--preview') ||
  cliArgs.includes('--force') ||
  process.env.MAGA_DEPLOY_ALLOW_NON_MAIN === '1';
const skipRulesSync = cliArgs.includes('--no-rules');

try {
  if (cmd === 'install') {
    const installGuard = evaluateDeployGuard(REPO_ROOT, { allowNonMain: allowNonMainDeploy });
    if (!installGuard.allowed) {
      throw new Error(installGuard.reason);
    }
    await runAntiClaudeInstall();
    const deployRes = await deployStudio({ allowNonMain: allowNonMainDeploy });
    const rulesRes = skipRulesSync
      ? { ok: true, skipped: true, reason: '--no-rules' }
      : syncFastIoRules();
    const pluginRes = syncOpusGatePlugin();
    const compactPluginRes = syncAutoCompactPlugin();
    console.log(JSON.stringify({ ok: true, command: 'install', deploy: deployRes, rules: rulesRes, opusGatePlugin: pluginRes, autoCompactPlugin: compactPluginRes }, null, 2));
  } else if (cmd === 'deploy') {
    const res = await deployStudio({ allowNonMain: allowNonMainDeploy });
    await applyDefaultOrchestratorModelPreference();
    const compactPluginRes = syncAutoCompactPlugin();
    console.log(JSON.stringify({ ...res, autoCompactPlugin: compactPluginRes }, null, 2));
  } else if (cmd === 'sync-rules') {
    const rulesRes = syncFastIoRules();
    const pluginRes = syncOpusGatePlugin();
    const compactPluginRes = syncAutoCompactPlugin();
    console.log(JSON.stringify({ ...rulesRes, opusGatePlugin: pluginRes, autoCompactPlugin: compactPluginRes }, null, 2));
  } else if (cmd === 'doctor') {
    const report = await runDoctor();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } else if (cmd === 'rollback') {
    const rollbackRes = rollbackStudio();
    const pluginRes = syncOpusGatePlugin({ remove: true });
    const compactPluginRes = syncAutoCompactPlugin({ remove: true });
    console.log(JSON.stringify({ ...rollbackRes, opusGatePlugin: pluginRes, autoCompactPlugin: compactPluginRes }, null, 2));
  } else {
    console.error(`Unknown command: ${cmd}\nUse: install | deploy | sync-rules | doctor | rollback`);
    process.exit(1);
  }
} catch (err) {
  console.error('[MAGA]', err?.message || err);
  process.exit(1);
}
