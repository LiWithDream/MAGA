#!/usr/bin/env node
/**
 * Anti-Claude — core/daemon.mjs
 * Thin CDP runtime & SQLite metrics daemon entrypoint delegating to `core/daemon/*.mjs`.
 *
 * Modes:
 *   node core/daemon.mjs [--user-dir <dir>]          Continuous background daemon (2.5s heartbeat + instant hot-reload)
 *   node core/daemon.mjs --once [--user-dir <dir>]   Single injection pass then exit 0
 *   node core/daemon.mjs --verify-once               Inject & verify DOM styles on live Antigravity window, print JSON
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DatabaseSync,
  RUN_ONCE,
  USER_DIR,
  VERIFY_ONCE,
  attachedTargets,
  runtimeState,
  skippedNonHostTargets
} from './daemon/env.mjs';
import { checkPidOwnership, claimPidFile, isOwnDaemonProcess } from './daemon/pid.mjs';
import { startMacCdpBootstrap, waitForMacRelaunchReady } from './daemon/cdp-bootstrap.mjs';
import {
  DEFAULT_STUDIO_PREFS,
  getCachedBootPayload,
  getCachedVersion,
  loadStudioPrefs,
  rebuildBundleIfNeeded,
  sanitizeStudioPrefs,
  saveStudioPrefs,
  saveUiPrefs
} from './daemon/prefs-bundle.mjs';
import {
  deleteProjectScheduledTask,
  isSafeProjectDir,
  isSensitiveSourcePath,
  saveProjectContext,
  saveProjectScheduledTask
} from './daemon/projects.mjs';
import {
  collectOverviewSnapshot,
  collectOverviewSnapshotAsync,
  createLocalAgent,
  createLocalSkill,
  readOverviewGitStatusAsync
} from './daemon/overview-skills.mjs';
import {
  HOST_IDENTITY_PROBE_EXPR,
  attachTarget,
  isAllowedOrigin
} from './daemon/cdp-attach.mjs';
import { runVerifyOnce, sync } from './daemon/sync-loop.mjs';

const __filename = fileURLToPath(import.meta.url);

/* Hermetic unit-test shortcut for `--verify-once` */
if (VERIFY_ONCE && (process.env.ANTI_CLAUDE_FAKE_VERIFY_OK === '1' || process.env.ANTI_CLAUDE_FAKE_VERIFY_OK === '0')) {
  const ok = process.env.ANTI_CLAUDE_FAKE_VERIFY_OK === '1';
  console.log(
    JSON.stringify(
      {
        ok,
        fake: true,
        userDir: USER_DIR,
        themeStyle: { present: ok, length: ok ? 1024 : 0 },
        customStyle: { present: ok, length: ok ? 4096 : 0 },
        live: { reachable: ok, port: ok ? 9222 : null, targets: ok ? 1 : 0 }
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
}

runtimeState.syncFn = sync;

export {
  isOwnDaemonProcess,
  claimPidFile,
  checkPidOwnership,
  waitForMacRelaunchReady,
  saveUiPrefs,
  DEFAULT_STUDIO_PREFS,
  sanitizeStudioPrefs,
  loadStudioPrefs,
  saveStudioPrefs,
  isSensitiveSourcePath,
  isSafeProjectDir,
  saveProjectContext,
  saveProjectScheduledTask,
  deleteProjectScheduledTask,
  createLocalSkill,
  createLocalAgent,
  readOverviewGitStatusAsync,
  collectOverviewSnapshot,
  collectOverviewSnapshotAsync,
  isAllowedOrigin,
  HOST_IDENTITY_PROBE_EXPR,
  attachTarget,
  attachedTargets,
  skippedNonHostTargets,
  sync,
  rebuildBundleIfNeeded,
  getCachedBootPayload
};

const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  claimPidFile();
  startMacCdpBootstrap();

  if (VERIFY_ONCE) {
    await runVerifyOnce();
  } else if (RUN_ONCE) {
    await sync();
    for (const [, entry] of attachedTargets.entries()) {
      try {
        entry.ws.close();
      } catch {}
    }
    process.exit(0);
  } else {
    rebuildBundleIfNeeded();
    console.log(`[Anti-Claude Daemon] Started (${getCachedVersion()}) | userDir=${USER_DIR} | sqlite=${Boolean(DatabaseSync)}`);
    await sync();
    setInterval(sync, 2500);
  }
}
