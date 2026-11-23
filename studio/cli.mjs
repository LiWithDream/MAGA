#!/usr/bin/env node
/**
 * agy-studio CLI — unified manager for Anti-Claude + internalized agy-capsule modules.
 *
 * Commands:
 *   node studio/cli.mjs install         Install Anti-Claude daemon from this repo + deploy studio + sync fast-io rules
 *   node studio/cli.mjs deploy          Rebuild & hot-deploy studio JS/CSS bundle into live user/ directory
 *   node studio/cli.mjs sync-rules      Sync critically pruned fast-io rules into ~/.gemini/AGENTS.md
 *   node studio/cli.mjs sync-capsule [dir]  Refresh vendored agy-capsule files from a local checkout
 *   node studio/cli.mjs doctor          Verify daemon, plist, CDP, usage stats, bundle markers & config
 *   node studio/cli.mjs rollback        Strip studio blocks and restore stock Anti-Claude defaults
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CSS_BEGIN,
  JS_BEGIN,
  REPO_ROOT,
  TARGET_CONFIG_JSON,
  TARGET_CUSTOM_CSS,
  TARGET_CUSTOM_JS,
  deployStudio,
  rollbackStudio,
  stripBlock,
} from './build.mjs';
import { collectUsageStatsAsync } from './daemon/usage-service.mjs';

const HOME = homedir();
const AGENTS_MD = path.join(HOME, '.gemini', 'AGENTS.md');
const AGY_CONFIG_JSON = path.join(HOME, '.gemini', 'config', 'config.json');
const DAEMON_PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'com.antigravity.anti-claude.daemon.plist');
const RULES_SRC = path.join(REPO_ROOT, 'studio', 'rules', 'fast-io.md');
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor', 'agy-capsule');
const VENDOR_VERSION = path.join(VENDOR_DIR, 'VERSION.json');

const RULE_BEGIN = '<!-- BEGIN agy-fast-io-pruned -->';
const RULE_END = '<!-- END agy-fast-io-pruned -->';

function syncFastIoRules() {
  const block = readFileSync(RULES_SRC, 'utf8').trim();
  const existing = existsSync(AGENTS_MD) ? readFileSync(AGENTS_MD, 'utf8') : '';
  const cleaned = stripBlock(existing, RULE_BEGIN, RULE_END).trim();
  const next = cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`;
  writeFileSync(AGENTS_MD, next, 'utf8');
  return { ok: true, path: AGENTS_MD };
}

function runAntiClaudeInstall() {
  const installScript = path.join(REPO_ROOT, 'install.mjs');
  execFileSync(
    process.execPath,
    [installScript, 'install', '--no-auto-update', '--no-agents-rule', '--no-step-unlock'],
    { stdio: 'inherit', cwd: REPO_ROOT }
  );
  // Keep tool groups collapsed by default (clickable to expand on demand)
  if (existsSync(AGY_CONFIG_JSON)) {
    try {
      const cfg = JSON.parse(readFileSync(AGY_CONFIG_JSON, 'utf8'));
      cfg.userSettings = cfg.userSettings || {};
      if (cfg.userSettings.verboseConversationSteps !== false) {
        cfg.userSettings.verboseConversationSteps = false;
        writeFileSync(AGY_CONFIG_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      }
    } catch {}
  }
}

function syncCapsuleVendor(sourceDir) {
  const meta = JSON.parse(readFileSync(VENDOR_VERSION, 'utf8'));
  const resolved = path.resolve(sourceDir || path.join(HOME, 'agy-capsule'));
  const sidecarDir = existsSync(path.join(resolved, 'agy-capsule', 'sidecars', 'agy_capsule'))
    ? path.join(resolved, 'agy-capsule', 'sidecars', 'agy_capsule')
    : resolved;

  for (const file of meta.files) {
    const src = path.join(sidecarDir, file);
    if (!existsSync(src)) {
      throw new Error(`Missing expected agy-capsule file: ${src}`);
    }
    copyFileSync(src, path.join(VENDOR_DIR, file));
  }

  let commit = meta.commit;
  try {
    commit = execFileSync('git', ['-C', resolved, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {}
  meta.commit = commit;
  meta.syncedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(VENDOR_VERSION, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { ok: true, source: sidecarDir, commit, files: meta.files.length };
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
  const hasJsMarker = existsSync(TARGET_CUSTOM_JS) && readFileSync(TARGET_CUSTOM_JS, 'utf8').includes(JS_BEGIN);
  const hasCssMarker = existsSync(TARGET_CUSTOM_CSS) && readFileSync(TARGET_CUSTOM_CSS, 'utf8').includes(CSS_BEGIN);
  const cfg = existsSync(TARGET_CONFIG_JSON) ? JSON.parse(readFileSync(TARGET_CONFIG_JSON, 'utf8')) : null;
  const agyCfg = existsSync(AGY_CONFIG_JSON) ? JSON.parse(readFileSync(AGY_CONFIG_JSON, 'utf8')) : null;
  const hasFastIo = existsSync(AGENTS_MD) && readFileSync(AGENTS_MD, 'utf8').includes(RULE_BEGIN);
  const usage = await collectUsageStatsAsync({ force: true });

  return {
    ok: Boolean(baseDoctor?.ok && pointsToStudio && hasJsMarker && hasCssMarker && usage?.ok),
    repoRoot: REPO_ROOT,
    daemonPointsToStudio: pointsToStudio,
    studioBundle: { jsInjected: hasJsMarker, cssInjected: hasCssMarker },
    claudeUxModelMenu: cfg?.modules?.claudeUxModelMenu ?? null,
    remoteControlEnabled: agyCfg?.userSettings?.remoteControlEnabled ?? agyCfg?.remoteControlEnabled ?? null,
    fastIoRuleInstalled: hasFastIo,
    usageSummary: {
      daysCount: usage.days.length,
      unread: usage.unread,
      latestDay: usage.days.at(-1)?.date || null,
    },
    baseDoctor,
  };
}

const [cmd = 'deploy', arg1] = process.argv.slice(2);

try {
  if (cmd === 'install') {
    runAntiClaudeInstall();
    const deployRes = await deployStudio();
    const rulesRes = syncFastIoRules();
    console.log(JSON.stringify({ ok: true, command: 'install', deploy: deployRes, rules: rulesRes }, null, 2));
  } else if (cmd === 'deploy') {
    const res = await deployStudio();
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'sync-rules') {
    console.log(JSON.stringify(syncFastIoRules(), null, 2));
  } else if (cmd === 'sync-capsule') {
    const syncRes = syncCapsuleVendor(arg1);
    const deployRes = await deployStudio();
    console.log(JSON.stringify({ ok: true, sync: syncRes, deploy: deployRes }, null, 2));
  } else if (cmd === 'doctor') {
    const report = await runDoctor();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } else if (cmd === 'rollback') {
    console.log(JSON.stringify(rollbackStudio(), null, 2));
  } else {
    console.error(`Unknown command: ${cmd}\nUse: install | deploy | sync-rules | sync-capsule | doctor | rollback`);
    process.exit(1);
  }
} catch (err) {
  console.error('[agy-studio]', err?.message || err);
  process.exit(1);
}
