/**
 * Shared Managed Plugin Sync, Node Path Pinning, Stale File Pruning & Runtime Verification.
 * Used by opus-gate, auto-compact, and git-workflow daemon services.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  GLOBAL_PLUGINS_DIR,
  REPO_ROOT,
  readJsonOrFallback,
  writeAtomicUtf8,
} from '../../core/daemon/env.mjs';

export function getPluginTargetDir(pluginName, opts = {}) {
  return path.join(opts.pluginsDir || GLOBAL_PLUGINS_DIR, pluginName);
}

export function isPluginInstalled(pluginName, requiredFiles = ['plugin.json', 'hooks.json'], opts = {}) {
  const targetDir = getPluginTargetDir(pluginName, opts);
  return requiredFiles.every((rel) => fs.existsSync(path.join(targetDir, rel)));
}

export function formatPinnedHookCommand(rawCmd, nodeBin) {
  const cmd = String(rawCmd || '').trim();
  const m = cmd.match(/^node\s+(.+)$/);
  if (!m || !nodeBin) return cmd;
  const quoted =
    process.platform === 'win32'
      ? `"${String(nodeBin).replace(/"/g, '\\"')}"`
      : `'${String(nodeBin).replace(/'/g, `'\\''`)}'`;
  return `${quoted} ${m[1]}`;
}

export function buildPinnedHooksJsonForPlugin(pluginName, rawText, nodeBin = process.execPath) {
  const parsed = JSON.parse(rawText);
  const root = parsed?.[pluginName];
  if (root && typeof root === 'object') {
    for (const handlers of Object.values(root)) {
      if (!Array.isArray(handlers)) continue;
      for (const h of handlers) {
        if (h && typeof h === 'object' && typeof h.command === 'string') {
          h.command = formatPinnedHookCommand(h.command, nodeBin);
        }
        if (Array.isArray(h?.hooks)) {
          for (const sub of h.hooks) {
            if (sub && typeof sub === 'object' && typeof sub.command === 'string') {
              sub.command = formatPinnedHookCommand(sub.command, nodeBin);
            }
          }
        }
      }
    }
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function extractPluginHookNodeBin(pluginName, hooksObj) {
  const root = hooksObj?.[pluginName];
  let cmd = '';
  if (root && typeof root === 'object') {
    for (const handlers of Object.values(root)) {
      if (!Array.isArray(handlers)) continue;
      for (const h of handlers) {
        if (typeof h?.command === 'string' && h.command.trim()) {
          cmd = h.command.trim();
          break;
        }
        if (Array.isArray(h?.hooks)) {
          for (const sub of h.hooks) {
            if (typeof sub?.command === 'string' && sub.command.trim()) {
              cmd = sub.command.trim();
              break;
            }
          }
          if (cmd) break;
        }
      }
      if (cmd) break;
    }
  }
  if (!cmd) return process.execPath;
  const sq = cmd.match(/^'((?:[^']|'\\'')+)'\s+/);
  if (sq) return sq[1].replace(/'\\''/g, "'");
  const dq = cmd.match(/^"([^"]+)"\s+/);
  if (dq) return dq[1];
  const bare = cmd.match(/^(\S+)\s+/);
  return bare ? bare[1] : process.execPath;
}

export function pruneStalePluginFiles(targetDir, expectedRelFiles) {
  const removed = [];
  if (!fs.existsSync(targetDir)) return removed;
  try {
    if (fs.lstatSync(targetDir).isSymbolicLink()) return removed;
  } catch {
    return removed;
  }
  const expectedSet = new Set(expectedRelFiles.map((rel) => rel.split(path.sep).join('/')));
  const walk = (absDir, relPrefix = '') => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        walk(abs, rel);
        try {
          if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
        } catch {}
      } else if (!expectedSet.has(rel)) {
        try {
          fs.rmSync(abs, { force: true });
          removed.push(rel);
        } catch {}
      }
    }
  };
  try {
    walk(targetDir);
  } catch {}
  return removed;
}

export function syncManagedPlugin(
  {
    pluginName,
    pluginFiles,
    requiredFiles = pluginFiles,
    executableFiles = new Set(),
    remove = false,
  },
  opts = {}
) {
  const srcDir = opts.pluginSrcDir || path.join(REPO_ROOT, 'studio', 'plugin', pluginName);
  const targetDir = getPluginTargetDir(pluginName, opts);
  if (remove) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { ok: true, action: 'removed', pluginDir: targetDir, installed: false };
  }
  if (!fs.existsSync(srcDir)) {
    return { ok: false, error: 'missing_plugin_source', srcDir };
  }
  const nodeBin = opts.nodeExecPath || process.execPath;
  const copied = [];
  let pinned = false;
  let pinError = '';
  for (const rel of pluginFiles) {
    const from = path.join(srcDir, rel);
    const to = path.join(targetDir, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let body = fs.readFileSync(from, 'utf8');
    if (rel === 'hooks.json') {
      try {
        body = buildPinnedHooksJsonForPlugin(pluginName, body, nodeBin);
        pinned = Boolean(nodeBin && path.isAbsolute(nodeBin));
      } catch (err) {
        pinned = false;
        pinError = String(err?.message || err).slice(0, 120);
      }
    }
    writeAtomicUtf8(to, body);
    if (executableFiles.has(rel)) {
      try {
        fs.chmodSync(to, 0o755);
      } catch {}
    }
    copied.push(rel);
  }
  const staleRemoved = pruneStalePluginFiles(targetDir, copied);
  return {
    ok: true,
    action: 'synced',
    pluginDir: targetDir,
    files: copied,
    ...(staleRemoved.length > 0 ? { staleRemoved } : {}),
    nodeBin,
    pinned,
    ...(pinError ? { pinError } : {}),
    installed: isPluginInstalled(pluginName, requiredFiles, opts),
  };
}

export function verifyPluginHookNodeRuntime(pluginName, { requireSqlite = false } = {}, opts = {}) {
  const hooksFile = path.join(getPluginTargetDir(pluginName, opts), 'hooks.json');
  const hooksObj = readJsonOrFallback(hooksFile, null);
  const nodeBin = hooksObj ? extractPluginHookNodeBin(pluginName, hooksObj) : opts.nodeExecPath || process.execPath;
  const pinned = Boolean(hooksObj && nodeBin && nodeBin !== 'node' && path.isAbsolute(nodeBin));
  try {
    if (!fs.existsSync(nodeBin) && nodeBin !== 'node') {
      return {
        ok: false,
        pinned,
        nodeBin,
        ...(requireSqlite ? { sqliteSupported: false } : {}),
        error: 'node_binary_missing',
      };
    }
    if (requireSqlite) {
      execFileSync(
        nodeBin,
        ['-e', "import('node:sqlite').then(m => { if (!m.DatabaseSync) process.exit(2); })"],
        { timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return {
        ok: true,
        pinned,
        nodeBin,
        sqliteSupported: true,
        ...(!pinned && hooksObj ? { warning: 'unpinned_node_binary' } : {}),
      };
    }
    const ver = execFileSync(nodeBin, ['--version'], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return {
      ok: true,
      pinned,
      nodeBin,
      version: ver,
      ...(!pinned && hooksObj ? { warning: 'unpinned_node_binary' } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      pinned,
      nodeBin,
      ...(requireSqlite ? { sqliteSupported: false } : {}),
      error: String(err?.message || err).slice(0, 160),
    };
  }
}
