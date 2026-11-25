/**
 * 4.5 Local Zero-Config Project Context Bridge, Scheduled Sidecars & Native Pickers
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GLOBAL_AGENTS_DIR,
  GLOBAL_SKILLS_DIR,
  HOME,
  INLINE_TEXT_EXTS,
  MAX_INLINE_FILE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  PROJECTS_REGISTRY_FILE,
  PROJECT_FILES_REL,
  PROJECT_META_REL,
  PROJECT_RULE_BEGIN,
  PROJECT_RULE_END,
  SIDECARS_DIR,
  STATE_DIR,
  readJsonOrFallback,
  readTextOrEmpty,
  writeAtomicUtf8
} from './env.mjs';

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function normalizePathForCompare(p) {
  const resolved = path.resolve(String(p || ''));
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

function resolveRealPathBestEffort(absPath) {
  const resolved = path.resolve(String(absPath || ''));
  try {
    return fs.realpathSync(resolved);
  } catch {}
  /* Walk up until an existing ancestor is found, then join the remaining suffix */
  const suffix = [];
  let cur = resolved;
  while (cur && cur !== path.dirname(cur)) {
    try {
      const realBase = fs.realpathSync(cur);
      return suffix.length ? path.join(realBase, ...suffix.reverse()) : realBase;
    } catch {}
    suffix.push(path.basename(cur));
    cur = path.dirname(cur);
  }
  return resolved;
}

function getBlockedSystemPrefixes() {
  const resolvedHome = path.resolve(HOME);
  const realHome = resolveRealPathBestEffort(resolvedHome);
  const homes = resolvedHome === realHome ? [resolvedHome] : [resolvedHome, realHome];
  const prefixes = [
    STATE_DIR,
    resolveRealPathBestEffort(STATE_DIR),
    GLOBAL_SKILLS_DIR,
    resolveRealPathBestEffort(GLOBAL_SKILLS_DIR),
    GLOBAL_AGENTS_DIR,
    resolveRealPathBestEffort(GLOBAL_AGENTS_DIR),
    SIDECARS_DIR,
    resolveRealPathBestEffort(SIDECARS_DIR),
    '/System',
    '/bin',
    '/sbin',
    '/usr',
    '/etc',
    '/private/etc',
    '/private/var/db',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)'
  ];
  for (const h of homes) {
    prefixes.push(
      path.join(h, '.ssh'),
      path.join(h, '.gnupg'),
      path.join(h, '.aws'),
      path.join(h, '.kube'),
      path.join(h, '.config', 'gcloud'),
      path.join(h, 'Library', 'Keychains')
    );
  }
  return prefixes;
}

export function isPathInsideDir(parentDir, targetPath) {
  const rel = path.relative(normalizePathForCompare(parentDir), normalizePathForCompare(targetPath));
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isSensitiveSourcePath(absPath) {
  if (!absPath || !path.isAbsolute(absPath)) return true;
  const candidates = [path.resolve(absPath), resolveRealPathBestEffort(absPath)];
  const blockedPrefixes = getBlockedSystemPrefixes();
  for (const cand of candidates) {
    const normCand = normalizePathForCompare(cand);
    for (const blocked of blockedPrefixes) {
      const normBlocked = normalizePathForCompare(blocked);
      if (normCand === normBlocked || isPathInsideDir(normBlocked, normCand)) return true;
    }
    /* Block common credential/key files directly under HOME */
    const base = path.basename(cand).toLowerCase();
    if (
      base === '.netrc' ||
      base === '.npmrc' ||
      base === '.pypirc' ||
      base === '.git-credentials' ||
      base === 'id_rsa' ||
      base === 'id_ed25519' ||
      base === 'id_ecdsa'
    ) {
      return true;
    }
  }
  return false;
}

export function isSafeProjectDir(absDir) {
  if (!absDir || !path.isAbsolute(absDir)) return false;
  const resolved = path.resolve(absDir);
  if (path.dirname(resolved) === resolved) return false;
  const realResolved = resolveRealPathBestEffort(resolved);
  if (path.dirname(realResolved) === realResolved) return false;

  const normHome = normalizePathForCompare(HOME);
  const normRealHome = normalizePathForCompare(resolveRealPathBestEffort(HOME));
  for (const cand of [resolved, realResolved]) {
    const normCand = normalizePathForCompare(cand);
    if (normCand === normHome || normCand === normRealHome) return false;
  }
  const blockedPrefixes = getBlockedSystemPrefixes();
  for (const cand of [resolved, realResolved]) {
    const normCand = normalizePathForCompare(cand);
    for (const blocked of blockedPrefixes) {
      const normBlocked = normalizePathForCompare(blocked);
      if (normCand === normBlocked || isPathInsideDir(normBlocked, normCand)) return false;
    }
  }
  return true;
}

function recordManagedProjectDir(dirPath, active = true, registryFile = PROJECTS_REGISTRY_FILE) {
  if (!registryFile) return;
  try {
    const cur = readJsonOrFallback(registryFile, null);
    const list = new Set(Array.isArray(cur?.dirs) ? cur.dirs : []);
    if (active) list.add(dirPath);
    else list.delete(dirPath);
    if (list.size > 0) {
      writeAtomicUtf8(registryFile, `${JSON.stringify({ schema: 1, dirs: [...list] }, null, 2)}\n`);
    } else if (fs.existsSync(registryFile)) {
      fs.rmSync(registryFile, { force: true });
    }
  } catch {}
}

export function getRegisteredProjectDirs() {
  const cur = readJsonOrFallback(PROJECTS_REGISTRY_FILE, null);
  return Array.isArray(cur?.dirs) ? cur.dirs.map((d) => resolveLocalProjectDir(d)).filter(Boolean) : [];
}

export function resolveLocalProjectDir(rawDir) {
  if (!rawDir || typeof rawDir !== 'string') return null;
  let p = rawDir.trim();
  if (!p) return null;
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    } catch {
      return null;
    }
  }
  const abs = path.resolve(p);
  if (!isSafeProjectDir(abs)) return null;
  try {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) return null;
    return abs;
  } catch {
    return null;
  }
}

function formatHumanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function isInlineCandidate(fileName, sizeBytes) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return INLINE_TEXT_EXTS.has(ext) && Number(sizeBytes) > 0 && Number(sizeBytes) <= MAX_INLINE_FILE_BYTES;
}

function splitAgentsMdDocument(agentsText, rawMeta) {
  const raw = String(agentsText || '');
  const beginIdx = raw.indexOf(PROJECT_RULE_BEGIN);
  const endIdx = beginIdx !== -1 ? raw.indexOf(PROJECT_RULE_END, beginIdx) : -1;
  const hasManagedBlock = beginIdx !== -1 && endIdx > beginIdx;

  let outsideText = '';
  let legacyFromBlock = '';
  if (hasManagedBlock) {
    const before = raw
      .slice(0, beginIdx)
      .replace(/\s+$/, '')
      .replace(/(?:\r?\n)*---$/, '')
      .trim();
    const after = raw
      .slice(endIdx + PROJECT_RULE_END.length)
      .replace(/^\s+/, '')
      .replace(/^---(?:\r?\n)*/, '')
      .trim();
    outsideText = [before, after].filter(Boolean).join('\n\n').trim();

    const inner = raw.slice(beginIdx + PROJECT_RULE_BEGIN.length, endIdx).trim();
    if (/^##\s+Project Context & Instructions\b/i.test(inner)) {
      const afterHdr = inner.replace(/^##\s+Project Context & Instructions[^\n]*\n*/i, '');
      const nextSecMatch = afterHdr.match(/\n##\s+(?:Project Reference Files|Linked Project Folders)\b/i);
      legacyFromBlock = (nextSecMatch ? afterHdr.slice(0, nextSecMatch.index) : afterHdr).trim();
    } else if (inner && !/^##\s+(?:Project Reference Files|Linked Project Folders)\b/i.test(inner)) {
      legacyFromBlock = inner;
    }
  } else {
    outsideText = raw.trim();
  }

  const metaSchema = Number(rawMeta?.schema) || 1;
  const legacyFromMeta =
    metaSchema < 2 && typeof rawMeta?.instructions === 'string' ? rawMeta.instructions.replace(/\r\n/g, '\n').trim() : '';
  const legacyInst = legacyFromBlock || legacyFromMeta;

  let bodyText = '';
  if (outsideText && legacyInst && !outsideText.includes(legacyInst)) {
    bodyText = `${outsideText}\n\n${legacyInst}`;
  } else {
    bodyText = outsideText || legacyInst || '';
  }

  return { bodyText, outsideText, hasManagedBlock };
}

function toFileUriSafe(absPath) {
  try {
    return pathToFileURL(path.resolve(absPath)).href;
  } catch {
    return `file://${encodeURI(String(absPath || ''))}`;
  }
}

function fromFileUriSafe(uri) {
  if (!uri || typeof uri !== 'string') return '';
  try {
    if (uri.startsWith('file://')) return path.resolve(fileURLToPath(uri));
    return path.resolve(uri);
  } catch {
    return '';
  }
}

function getHostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

function slugifySidecarId(rawName, dirPath) {
  const ascii = String(rawName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const hash = crypto
    .createHash('sha1')
    .update(`${dirPath}:${rawName}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return ascii ? `ac-${ascii}-${hash}` : `ac-task-${hash}`;
}

function buildScheduleCronExpr(task) {
  const freq = String(task?.frequency || 'manual').toLowerCase();
  if (freq === 'manual') return '';
  const tz = String(task?.timezone || getHostTimeZone()).trim() || 'Asia/Shanghai';
  const rawTime = String(task?.time || '09:00').trim();
  const tm = rawTime.match(/^(\d{1,2}):(\d{2})$/);
  const hour = tm ? Math.min(23, Math.max(0, Number(tm[1]))) : 9;
  const min = tm ? Math.min(59, Math.max(0, Number(tm[2]))) : 0;

  if (freq === 'hourly') {
    const hMin = Math.min(59, Math.max(0, Number.isFinite(Number(task?.minute)) ? Number(task.minute) : 0));
    return `CRON_TZ=${tz} ${hMin} * * * *`;
  }
  if (freq === 'daily') {
    return `CRON_TZ=${tz} ${min} ${hour} * * *`;
  }
  if (freq === 'weekdays') {
    return `CRON_TZ=${tz} ${min} ${hour} * * 1-5`;
  }
  if (freq === 'weekly') {
    const dow = Math.min(6, Math.max(0, Number.isFinite(Number(task?.dayOfWeek)) ? Number(task.dayOfWeek) : 1));
    return `CRON_TZ=${tz} ${min} ${hour} * * ${dow}`;
  }
  const custom = String(task?.customCron || '').trim();
  if (!custom) return `CRON_TZ=${tz} 0 9 * * *`;
  if (/^(CRON_TZ|TZ)=/i.test(custom)) return custom;
  return `CRON_TZ=${tz} ${custom}`;
}

function parseScheduleCronExpr(rawExpr) {
  const s = String(rawExpr || '').trim();
  if (!s) return { frequency: 'manual', time: '09:00', dayOfWeek: 1, minute: 0, customCron: '', timezone: getHostTimeZone() };
  let timezone = getHostTimeZone();
  let expr = s;
  const tzMatch = expr.match(/^(?:CRON_TZ|TZ)=([^\s]+)\s+(.+)$/);
  if (tzMatch) {
    timezone = tzMatch[1];
    expr = tzMatch[2].trim();
  }
  const fields = expr.split(/\s+/);
  if (fields.length === 5) {
    const [m, h, dom, mon, dow] = fields;
    const mNum = /^\d{1,2}$/.test(m) ? Number(m) : null;
    const hNum = /^\d{1,2}$/.test(h) ? Number(h) : null;
    if (mNum !== null && h === '*' && dom === '*' && mon === '*' && dow === '*') {
      return { frequency: 'hourly', minute: mNum, time: '09:00', dayOfWeek: 1, customCron: expr, timezone };
    }
    if (mNum !== null && hNum !== null && dom === '*' && mon === '*') {
      const time = `${String(hNum).padStart(2, '0')}:${String(mNum).padStart(2, '0')}`;
      if (dow === '*') return { frequency: 'daily', time, dayOfWeek: 1, minute: mNum, customCron: expr, timezone };
      if (dow === '1-5') return { frequency: 'weekdays', time, dayOfWeek: 1, minute: mNum, customCron: expr, timezone };
      if (/^[0-6]$/.test(dow)) return { frequency: 'weekly', time, dayOfWeek: Number(dow), minute: mNum, customCron: expr, timezone };
    }
  }
  return { frequency: 'custom', time: '09:00', dayOfWeek: 1, minute: 0, customCron: expr, timezone };
}

function buildProjectDirSet(dirPath, prevMeta) {
  const dirs = new Set([path.resolve(dirPath)]);
  const extra = Array.isArray(prevMeta?.extraFolders) ? prevMeta.extraFolders : [];
  for (const ef of extra) {
    const p = resolveLocalProjectDir(typeof ef === 'string' ? ef : ef?.absPath);
    if (p) dirs.add(p);
  }
  return dirs;
}

function sidecarBelongsToProject(sc, sidecarId, projectDirs, dirPath) {
  if (!sc || typeof sc !== 'object') return false;
  const normDirs = new Set([...projectDirs].map((d) => normalizePathForCompare(resolveRealPathBestEffort(d))));
  normDirs.add(normalizePathForCompare(resolveRealPathBestEffort(dirPath)));
  if (sc.anti_claude_project_dir) {
    const scDir = normalizePathForCompare(resolveRealPathBestEffort(path.resolve(sc.anti_claude_project_dir)));
    if (normDirs.has(scDir)) return true;
  }
  if (sc.builtin !== 'schedule') return false;
  const uris = Array.isArray(sc.agent_permissions?.workspace_uris) ? sc.agent_permissions.workspace_uris : [];
  return uris
    .map(fromFileUriSafe)
    .some((p) => p && normDirs.has(normalizePathForCompare(resolveRealPathBestEffort(p))));
}

function readProjectScheduledTasks(dirPath, rawMeta, extraFolders = []) {
  const projectDirs = new Set([path.resolve(dirPath)]);
  for (const ef of extraFolders) {
    if (ef?.absPath) projectDirs.add(path.resolve(ef.absPath));
  }

  const stored = Array.isArray(rawMeta?.scheduledTasks) ? rawMeta.scheduledTasks : [];
  const tasks = [];
  const knownSidecarIds = new Set();

  for (const t of stored) {
    if (!t || typeof t !== 'object' || !t.name) continue;
    const rawSidecarId = typeof t.sidecarId === 'string' ? t.sidecarId.trim() : '';
    let sidecarId = '';
    let syncedSidecar = false;
    if (rawSidecarId && /^[a-z0-9._-]+$/i.test(rawSidecarId)) {
      const sidecarPath = path.join(SIDECARS_DIR, rawSidecarId, 'sidecar.json');
      const sc = isPathInsideDir(SIDECARS_DIR, sidecarPath) ? readJsonOrFallback(sidecarPath, null) : null;
      if (sc && sidecarBelongsToProject(sc, rawSidecarId, projectDirs, path.resolve(dirPath))) {
        sidecarId = rawSidecarId;
        syncedSidecar = true;
        knownSidecarIds.add(sidecarId);
      }
    }
    tasks.push({
      id: String(t.id || sidecarId || `task-${tasks.length + 1}`),
      name: String(t.name),
      description: String(t.description || ''),
      instructions: String(t.instructions || ''),
      folderPath: resolveLocalProjectDir(t.folderPath) || dirPath,
      model: String(t.model || ''),
      frequency: String(t.frequency || 'manual'),
      time: String(t.time || '09:00'),
      dayOfWeek: Number.isFinite(Number(t.dayOfWeek)) ? Number(t.dayOfWeek) : 1,
      minute: Number.isFinite(Number(t.minute)) ? Number(t.minute) : 0,
      customCron: String(t.customCron || ''),
      timezone: String(t.timezone || getHostTimeZone()),
      cron: String(t.cron || ''),
      sidecarId,
      syncedSidecar,
      externalSidecar: false,
      updatedAt: Number(t.updatedAt || 0)
    });
  }

  try {
    if (fs.existsSync(SIDECARS_DIR)) {
      for (const entry of fs.readdirSync(SIDECARS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || knownSidecarIds.has(entry.name)) continue;
        const scPath = path.join(SIDECARS_DIR, entry.name, 'sidecar.json');
        const sc = readJsonOrFallback(scPath, null);
        if (!sc || sc.builtin !== 'schedule' || !Array.isArray(sc.args)) continue;
        const uris = Array.isArray(sc.agent_permissions?.workspace_uris) ? sc.agent_permissions.workspace_uris : [];
        const matchedDir = uris.map(fromFileUriSafe).find((p) => p && projectDirs.has(p));
        if (!matchedDir) continue;
        const parsed = parseScheduleCronExpr(sc.args[0]);
        const sepIdx = sc.args.indexOf('--');
        const instructions = sepIdx !== -1 && sc.args[sepIdx + 1] ? String(sc.args[sepIdx + 1]) : '';
        const modelArg = sc.args.find((a) => typeof a === 'string' && a.startsWith('--model='));
        const model = modelArg ? modelArg.slice('--model='.length) : '';
        let updatedAt = 0;
        try {
          updatedAt = Math.floor(fs.statSync(scPath).mtimeMs);
        } catch {}
        tasks.push({
          id: `sidecar:${entry.name}`,
          name: String(sc.display_name || entry.name),
          description: String(sc.description || ''),
          instructions,
          folderPath: matchedDir,
          model,
          frequency: parsed.frequency,
          time: parsed.time,
          dayOfWeek: parsed.dayOfWeek,
          minute: parsed.minute,
          customCron: parsed.customCron,
          timezone: parsed.timezone,
          cron: String(sc.args[0] || ''),
          sidecarId: entry.name,
          syncedSidecar: true,
          externalSidecar: true,
          updatedAt
        });
      }
    }
  } catch {}

  return tasks;
}

export function readProjectContext(rawDir) {
  const dirPath = resolveLocalProjectDir(rawDir);
  if (!dirPath) return { ok: false, error: 'invalid_directory' };

  const metaPath = path.join(dirPath, PROJECT_META_REL);
  const agentsPath = path.join(dirPath, 'AGENTS.md');
  const rawMeta = readJsonOrFallback(metaPath, null);
  const agentsText = readTextOrEmpty(agentsPath);
  const hasAgentsMd = fs.existsSync(agentsPath);
  const { bodyText: instructions } = splitAgentsMdDocument(agentsText, rawMeta);
  const rawFiles = Array.isArray(rawMeta?.files) ? rawMeta.files : [];

  let inlineBytesUsed = 0;
  const files = [];
  for (const item of rawFiles) {
    if (!item || typeof item.relPath !== 'string') continue;
    const absPath = path.resolve(dirPath, item.relPath);
    if (!isPathInsideDir(dirPath, absPath)) continue;
    const st = fs.statSync(absPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    const name = item.name || path.basename(absPath);
    const canInline = isInlineCandidate(name, st.size) && inlineBytesUsed + st.size <= MAX_INLINE_TOTAL_BYTES;
    if (canInline) inlineBytesUsed += st.size;
    files.push({
      name,
      relPath: item.relPath.replace(/\\/g, '/'),
      absPath,
      size: st.size,
      sizeText: formatHumanBytes(st.size),
      mtimeMs: Math.floor(st.mtimeMs),
      managedCopy: Boolean(item.managedCopy),
      inlined: canInline
    });
  }

  let lastModifiedMs = 0;
  let dirMtimeMs = 0;
  try {
    const dst = fs.statSync(dirPath, { throwIfNoEntry: false });
    if (dst) dirMtimeMs = Math.floor(dst.mtimeMs);
    const mst = fs.statSync(metaPath, { throwIfNoEntry: false });
    if (mst) lastModifiedMs = Math.max(lastModifiedMs, Math.floor(mst.mtimeMs));
    const ast = fs.statSync(agentsPath, { throwIfNoEntry: false });
    if (ast) lastModifiedMs = Math.max(lastModifiedMs, Math.floor(ast.mtimeMs));
  } catch {}

  const rawFolders = Array.isArray(rawMeta?.extraFolders) ? rawMeta.extraFolders : [];
  const extraFolders = [];
  const seenFolders = new Set([dirPath]);
  for (const rf of rawFolders) {
    const fp = resolveLocalProjectDir(typeof rf === 'string' ? rf : rf?.absPath);
    if (!fp || seenFolders.has(fp)) continue;
    seenFolders.add(fp);
    extraFolders.push({
      name: (typeof rf === 'object' && rf?.name) || path.basename(fp) || fp,
      absPath: fp
    });
  }

  const scheduledTasks = readProjectScheduledTasks(dirPath, rawMeta, extraFolders);

  return {
    ok: true,
    dirPath,
    instructions,
    files,
    extraFolders,
    scheduledTasks,
    hasAgentsMd,
    hasOtherAgentsMd: false,
    lastModifiedMs,
    dirMtimeMs
  };
}

function summarizeFolderEntries(absDir) {
  try {
    const entries = fs
      .readdirSync(absDir)
      .filter((n) => n && !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    if (!entries.length) return 'empty';
    const shown = entries.slice(0, 15).map((n) => `\`${n}\``);
    const suffix = entries.length > 15 ? `, +${entries.length - 15} more` : '';
    return `${entries.length} items: ${shown.join(', ')}${suffix}`;
  } catch {
    return 'read on demand';
  }
}

function buildManagedAgentsBlock(files, extraFolders = []) {
  const hasFiles = Array.isArray(files) && files.length > 0;
  const hasFolders = Array.isArray(extraFolders) && extraFolders.length > 0;
  if (!hasFiles && !hasFolders) return '';

  const parts = [PROJECT_RULE_BEGIN];
  if (hasFiles) {
    parts.push('## Project Reference Files', '');
    let inlineBytesUsed = 0;
    const inlineLines = [];
    const pointerLines = [];
    for (const f of files) {
      const safeRel = String(f.relPath || '').replace(/\\/g, '/');
      const safeLabel = String(f.name || path.basename(safeRel)).replace(/[\[\]()]/g, '_');
      if (isInlineCandidate(f.name, f.size) && inlineBytesUsed + f.size <= MAX_INLINE_TOTAL_BYTES) {
        inlineBytesUsed += f.size;
        inlineLines.push(`@[${safeLabel}](${safeRel})`);
      } else {
        pointerLines.push(`- \`${f.name}\` (\`${safeRel}\`, ${formatHumanBytes(f.size)} — read on demand with \`read_file\`)`);
      }
    }
    if (inlineLines.length) parts.push(...inlineLines);
    if (inlineLines.length && pointerLines.length) parts.push('');
    if (pointerLines.length) parts.push(...pointerLines);
  }
  if (hasFolders) {
    if (parts.length > 1) parts.push('');
    parts.push('## Linked Project Folders', '');
    for (const fld of extraFolders) {
      const abs = fld.absPath;
      const summary = summarizeFolderEntries(abs);
      parts.push(`- **${fld.name || path.basename(abs)}** (\`${abs}\` — ${summary})`);
    }
  }
  parts.push(PROJECT_RULE_END);
  return parts.join('\n');
}

function uniqueDestPath(destDir, rawBaseName) {
  const cleanName = String(rawBaseName || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'file';
  const ext = path.extname(cleanName);
  const stem = ext ? cleanName.slice(0, -ext.length) : cleanName;
  let candidate = path.join(destDir, cleanName);
  let idx = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${stem}-${idx}${ext}`);
    idx += 1;
  }
  return candidate;
}

export function saveProjectContext(payload, { registryFile = PROJECTS_REGISTRY_FILE } = {}) {
  const dirPath = resolveLocalProjectDir(payload?.dirPath);
  if (!dirPath) return { ok: false, error: 'invalid_directory' };

  const agentsPath = path.join(dirPath, 'AGENTS.md');
  const existingAgents = readTextOrEmpty(agentsPath);
  const prevMeta = readJsonOrFallback(path.join(dirPath, PROJECT_META_REL), null);
  const prevFiles = Array.isArray(prevMeta?.files) ? prevMeta.files : [];
  const filesDir = path.join(dirPath, PROJECT_FILES_REL);

  const curDoc = splitAgentsMdDocument(existingAgents, prevMeta);
  const instructions =
    typeof payload?.instructions === 'string'
      ? payload.instructions.replace(/\r\n/g, '\n').trim()
      : curDoc.bodyText;

  const hasExplicitFiles = Array.isArray(payload?.files);
  const ops = hasExplicitFiles
    ? payload.files
    : prevFiles.map((f) => ({ action: 'keep', relPath: f.relPath, name: f.name }));

  const keptManagedRelPaths = new Set();
  const nextFiles = [];
  const seenRelPaths = new Set();

  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.action === 'keep' && typeof op.relPath === 'string') {
      const absPath = path.resolve(dirPath, op.relPath);
      if (!isPathInsideDir(dirPath, absPath)) continue;
      const st = fs.statSync(absPath, { throwIfNoEntry: false });
      if (!st || !st.isFile()) continue;
      const relNorm = path.relative(dirPath, absPath).replace(/\\/g, '/');
      if (seenRelPaths.has(relNorm)) continue;
      seenRelPaths.add(relNorm);
      const managedCopy = isPathInsideDir(filesDir, absPath);
      if (managedCopy) keptManagedRelPaths.add(relNorm);
      nextFiles.push({ name: op.name || path.basename(absPath), relPath: relNorm, size: st.size, managedCopy });
    } else if (op.action === 'add' && typeof op.sourcePath === 'string') {
      const srcAbs = path.resolve(op.sourcePath.trim());
      if (isSensitiveSourcePath(srcAbs)) continue;
      const st = fs.statSync(srcAbs, { throwIfNoEntry: false });
      if (!st || !st.isFile()) continue;
      const realSrc = resolveRealPathBestEffort(srcAbs);
      if (isSensitiveSourcePath(realSrc)) continue;
      let finalAbs = srcAbs;
      let managedCopy = false;
      if (!isPathInsideDir(dirPath, realSrc)) {
        fs.mkdirSync(filesDir, { recursive: true });
        finalAbs = uniqueDestPath(filesDir, path.basename(srcAbs));
        fs.copyFileSync(realSrc, finalAbs);
        try {
          fs.chmodSync(finalAbs, 0o644);
        } catch {}
        managedCopy = true;
      } else {
        managedCopy = isPathInsideDir(filesDir, srcAbs);
      }
      const relNorm = path.relative(dirPath, finalAbs).replace(/\\/g, '/');
      if (seenRelPaths.has(relNorm)) continue;
      seenRelPaths.add(relNorm);
      if (managedCopy) keptManagedRelPaths.add(relNorm);
      const finalSt = fs.statSync(finalAbs);
      nextFiles.push({ name: path.basename(finalAbs), relPath: relNorm, size: finalSt.size, managedCopy });
    } else if (op.action === 'addContent' && typeof op.name === 'string' && typeof op.base64 === 'string') {
      const buf = Buffer.from(op.base64, 'base64');
      if (buf.length > 50 * 1024 * 1024) continue;
      fs.mkdirSync(filesDir, { recursive: true });
      const finalAbs = uniqueDestPath(filesDir, op.name);
      fs.writeFileSync(finalAbs, buf, { mode: 0o644 });
      const relNorm = path.relative(dirPath, finalAbs).replace(/\\/g, '/');
      if (seenRelPaths.has(relNorm)) continue;
      seenRelPaths.add(relNorm);
      keptManagedRelPaths.add(relNorm);
      nextFiles.push({ name: path.basename(finalAbs), relPath: relNorm, size: buf.length, managedCopy: true });
    }
  }

  if (hasExplicitFiles) {
    for (const old of prevFiles) {
      if (!old?.managedCopy || typeof old.relPath !== 'string') continue;
      const relNorm = old.relPath.replace(/\\/g, '/');
      if (keptManagedRelPaths.has(relNorm)) continue;
      const oldAbs = path.resolve(dirPath, relNorm);
      if (isPathInsideDir(filesDir, oldAbs)) {
        try {
          fs.rmSync(oldAbs, { force: true });
        } catch {}
      }
    }
  }

  const rawExtraFolders = Array.isArray(payload?.extraFolders)
    ? payload.extraFolders
    : Array.isArray(prevMeta?.extraFolders)
      ? prevMeta.extraFolders
      : [];
  const nextExtraFolders = [];
  const seenExtraFolders = new Set([dirPath]);
  for (const rf of rawExtraFolders) {
    const fp = resolveLocalProjectDir(typeof rf === 'string' ? rf : rf?.absPath);
    if (!fp || seenExtraFolders.has(fp)) continue;
    seenExtraFolders.add(fp);
    nextExtraFolders.push({
      name: (typeof rf === 'object' && rf?.name) || path.basename(fp) || fp,
      absPath: fp
    });
  }

  const managedBlock = buildManagedAgentsBlock(nextFiles, nextExtraFolders);
  let nextAgents = '';
  if (instructions && managedBlock) {
    nextAgents = `${instructions}\n\n---\n\n${managedBlock}\n`;
  } else if (instructions) {
    nextAgents = `${instructions}\n`;
  } else if (managedBlock) {
    nextAgents = `${managedBlock}\n`;
  }

  if (nextAgents !== existingAgents) {
    if (nextAgents) {
      writeAtomicUtf8(agentsPath, nextAgents);
    } else if (fs.existsSync(agentsPath)) {
      fs.rmSync(agentsPath, { force: true });
    }
  }

  const preservedTasks = Array.isArray(prevMeta?.scheduledTasks) ? prevMeta.scheduledTasks : [];
  const metaPath = path.join(dirPath, PROJECT_META_REL);
  const hasManagedData = Boolean(
    nextFiles.length > 0 || nextExtraFolders.length > 0 || preservedTasks.length > 0
  );
  if (hasManagedData) {
    writeAtomicUtf8(
      metaPath,
      `${JSON.stringify(
        {
          schema: 2,
          updatedAt: Date.now(),
          files: nextFiles.map((f) => ({ name: f.name, relPath: f.relPath, managedCopy: f.managedCopy })),
          extraFolders: nextExtraFolders,
          scheduledTasks: preservedTasks
        },
        null,
        2
      )}\n`
    );
    recordManagedProjectDir(dirPath, true, registryFile);
  } else {
    try {
      fs.rmSync(metaPath, { force: true });
      if (fs.existsSync(filesDir) && fs.readdirSync(filesDir).length === 0) fs.rmdirSync(filesDir);
      const acDir = path.join(dirPath, '.anti-claude');
      if (fs.existsSync(acDir) && fs.readdirSync(acDir).length === 0) fs.rmdirSync(acDir);
    } catch {}
    recordManagedProjectDir(dirPath, false, registryFile);
  }

  return readProjectContext(dirPath);
}

export function saveProjectScheduledTask(
  payload,
  { sidecarsDir = SIDECARS_DIR, registryFile = sidecarsDir === SIDECARS_DIR ? PROJECTS_REGISTRY_FILE : null } = {}
) {
  const dirPath = resolveLocalProjectDir(payload?.dirPath);
  if (!dirPath) return { ok: false, error: 'invalid_directory' };
  const rawTask = payload?.task;
  if (!rawTask || typeof rawTask !== 'object') return { ok: false, error: 'missing_task' };

  const name = String(rawTask.name || '').trim();
  const description = String(rawTask.description || '').trim();
  const instructions = String(rawTask.instructions || '').replace(/\r\n/g, '\n').trim();
  if (!name || !description || !instructions) {
    return { ok: false, error: 'required_fields_missing' };
  }

  const folderPath = resolveLocalProjectDir(rawTask.folderPath) || dirPath;
  const model = String(rawTask.model || '').trim();
  const frequency = ['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom'].includes(String(rawTask.frequency || 'manual'))
    ? String(rawTask.frequency || 'manual')
    : 'manual';
  const time = /^\d{1,2}:\d{2}$/.test(String(rawTask.time || '')) ? String(rawTask.time) : '09:00';
  const dayOfWeek = Math.min(6, Math.max(0, Number.isFinite(Number(rawTask.dayOfWeek)) ? Number(rawTask.dayOfWeek) : 1));
  const minute = Math.min(59, Math.max(0, Number.isFinite(Number(rawTask.minute)) ? Number(rawTask.minute) : 0));
  const customCron = String(rawTask.customCron || '').trim();
  const timezone = String(rawTask.timezone || getHostTimeZone()).trim() || 'Asia/Shanghai';

  const metaPath = path.join(dirPath, PROJECT_META_REL);
  const prevMeta = readJsonOrFallback(metaPath, null) || {};
  const prevTasks = Array.isArray(prevMeta.scheduledTasks) ? prevMeta.scheduledTasks.slice() : [];
  const projectDirs = buildProjectDirSet(dirPath, prevMeta);
  projectDirs.add(folderPath);

  const editId = typeof rawTask.id === 'string' && rawTask.id.trim() ? rawTask.id.trim() : '';
  const existingIdx = editId ? prevTasks.findIndex((t) => t && t.id === editId) : -1;
  const existing = existingIdx !== -1 ? prevTasks[existingIdx] : null;
  let sidecarId = String(existing?.sidecarId || rawTask.sidecarId || '').trim();
  const cron = buildScheduleCronExpr({ frequency, time, dayOfWeek, minute, customCron, timezone });

  if (frequency === 'manual') {
    if (sidecarId && /^[a-z0-9._-]+$/i.test(sidecarId)) {
      const scDir = path.join(sidecarsDir, sidecarId);
      if (isPathInsideDir(sidecarsDir, scDir) && fs.existsSync(scDir)) {
        const existingSc = readJsonOrFallback(path.join(scDir, 'sidecar.json'), null);
        if (!sidecarBelongsToProject(existingSc, sidecarId, projectDirs, dirPath)) {
          return { ok: false, error: 'sidecar_not_in_project' };
        }
        try {
          fs.rmSync(scDir, { recursive: true, force: true });
        } catch {}
      }
    }
    sidecarId = '';
  } else {
    if (!sidecarId || !/^[a-z0-9._-]+$/i.test(sidecarId)) {
      sidecarId = slugifySidecarId(name, dirPath);
    }
    const scDir = path.join(sidecarsDir, sidecarId);
    if (!isPathInsideDir(sidecarsDir, scDir)) return { ok: false, error: 'invalid_sidecar_id' };
    const existingSc = readJsonOrFallback(path.join(scDir, 'sidecar.json'), null);
    if (existingSc && !sidecarBelongsToProject(existingSc, sidecarId, projectDirs, dirPath)) {
      return { ok: false, error: 'sidecar_not_in_project' };
    }
    const args = [cron, 'agentapi', 'new-conversation'];
    if (model) args.push(`--model=${model}`);
    args.push('--', instructions);

    const nextUri = toFileUriSafe(folderPath);
    const existingUris = Array.isArray(existingSc?.agent_permissions?.workspace_uris)
      ? existingSc.agent_permissions.workspace_uris
      : [];
    let nextWorkspaceUris = [nextUri];
    if (existingUris.length > 0) {
      const prevMatchedDir =
        (existing?.folderPath && resolveLocalProjectDir(existing.folderPath)) ||
        existingUris.map(fromFileUriSafe).find((p) => p && projectDirs.has(p)) ||
        '';
      if (prevMatchedDir && folderPath === prevMatchedDir) {
        nextWorkspaceUris = existingUris.slice();
      } else if (prevMatchedDir) {
        const replaced = [];
        let didReplace = false;
        for (const u of existingUris) {
          if (!didReplace && fromFileUriSafe(u) === prevMatchedDir) {
            replaced.push(nextUri);
            didReplace = true;
          } else if (u !== nextUri) {
            replaced.push(u);
          }
        }
        if (!didReplace && !replaced.includes(nextUri)) replaced.unshift(nextUri);
        nextWorkspaceUris = replaced;
      }
    }

    const nextSidecar = {
      ...(existingSc && typeof existingSc === 'object' ? existingSc : { created_by: 'anti-claude', anti_claude_project_dir: dirPath }),
      builtin: 'schedule',
      args,
      restart_policy: 'always',
      display_name: name,
      description,
      agent_permissions: {
        ...(existingSc?.agent_permissions && typeof existingSc.agent_permissions === 'object' ? existingSc.agent_permissions : {}),
        workspace_uris: nextWorkspaceUris
      }
    };
    writeAtomicUtf8(path.join(scDir, 'sidecar.json'), `${JSON.stringify(nextSidecar, null, 2)}\n`);
  }

  const savedId = editId && !editId.startsWith('sidecar:') ? editId : sidecarId || `task-${Date.now().toString(36)}`;
  const taskRecord = {
    id: savedId,
    name,
    description,
    instructions,
    folderPath,
    model,
    frequency,
    time,
    dayOfWeek,
    minute,
    customCron,
    timezone,
    cron,
    sidecarId,
    updatedAt: Date.now()
  };

  if (existingIdx !== -1) prevTasks[existingIdx] = taskRecord;
  else prevTasks.unshift(taskRecord);

  const nextSchema = Number(prevMeta.schema) >= 2 ? 2 : prevMeta.instructions ? 1 : 2;
  const metaPayload = {
    schema: nextSchema,
    updatedAt: Date.now(),
    ...(nextSchema < 2 && typeof prevMeta.instructions === 'string' ? { instructions: prevMeta.instructions } : {}),
    files: Array.isArray(prevMeta.files) ? prevMeta.files : [],
    extraFolders: Array.isArray(prevMeta.extraFolders) ? prevMeta.extraFolders : [],
    scheduledTasks: prevTasks
  };
  writeAtomicUtf8(metaPath, `${JSON.stringify(metaPayload, null, 2)}\n`);
  recordManagedProjectDir(dirPath, true, registryFile);

  const ctx = readProjectContext(dirPath);
  return { ...ctx, savedTaskId: savedId, sidecarId };
}

export function deleteProjectScheduledTask(
  payload,
  { sidecarsDir = SIDECARS_DIR, registryFile = sidecarsDir === SIDECARS_DIR ? PROJECTS_REGISTRY_FILE : null } = {}
) {
  const dirPath = resolveLocalProjectDir(payload?.dirPath);
  if (!dirPath) return { ok: false, error: 'invalid_directory' };
  const taskId = String(payload?.taskId || '').trim();
  const reqSidecarId = String(payload?.sidecarId || '').trim();
  if (!taskId && !reqSidecarId) return { ok: false, error: 'missing_task_id' };

  const metaPath = path.join(dirPath, PROJECT_META_REL);
  const prevMeta = readJsonOrFallback(metaPath, null);
  const prevTasks = Array.isArray(prevMeta?.scheduledTasks) ? prevMeta.scheduledTasks : [];
  const projectDirs = buildProjectDirSet(dirPath, prevMeta);
  const target = prevTasks.find((t) => t && (t.id === taskId || (reqSidecarId && t.sidecarId === reqSidecarId)));
  const inferredSidecarId = !target && taskId.startsWith('sidecar:') ? taskId.slice('sidecar:'.length) : '';
  const sidecarId = String(target?.sidecarId || reqSidecarId || inferredSidecarId || '').trim();

  if (sidecarId) {
    if (!/^[a-z0-9._-]+$/i.test(sidecarId)) return { ok: false, error: 'invalid_sidecar_id' };
    const scDir = path.join(sidecarsDir, sidecarId);
    if (!isPathInsideDir(sidecarsDir, scDir)) return { ok: false, error: 'invalid_sidecar_id' };
    if (fs.existsSync(scDir)) {
      const existingSc = readJsonOrFallback(path.join(scDir, 'sidecar.json'), null);
      if (!sidecarBelongsToProject(existingSc, sidecarId, projectDirs, dirPath)) {
        return { ok: false, error: 'sidecar_not_in_project' };
      }
      try {
        fs.rmSync(scDir, { recursive: true, force: true });
      } catch {}
    } else if (!target) {
      return { ok: false, error: 'sidecar_not_found' };
    }
  }

  if (prevMeta) {
    const nextTasks = prevTasks.filter((t) => t && t.id !== taskId && (!sidecarId || t.sidecarId !== sidecarId));
    const prevSchema = Number(prevMeta.schema) >= 2 ? 2 : 1;
    const hasLegacyInst = prevSchema < 2 && typeof prevMeta.instructions === 'string' && prevMeta.instructions.trim();
    const hasAnything =
      hasLegacyInst ||
      (Array.isArray(prevMeta.files) && prevMeta.files.length > 0) ||
      (Array.isArray(prevMeta.extraFolders) && prevMeta.extraFolders.length > 0) ||
      nextTasks.length > 0;
    if (hasAnything) {
      writeAtomicUtf8(
        metaPath,
        `${JSON.stringify(
          {
            ...prevMeta,
            schema: prevSchema,
            updatedAt: Date.now(),
            scheduledTasks: nextTasks
          },
          null,
          2
        )}\n`
      );
    } else {
      try {
        fs.rmSync(metaPath, { force: true });
        const acDir = path.join(dirPath, '.anti-claude');
        if (fs.existsSync(acDir) && fs.readdirSync(acDir).length === 0) fs.rmdirSync(acDir);
      } catch {}
      const agentsText = readTextOrEmpty(path.join(dirPath, 'AGENTS.md'));
      if (!agentsText.includes(PROJECT_RULE_BEGIN)) recordManagedProjectDir(dirPath, false);
    }
  }

  return readProjectContext(dirPath);
}

export function pickLocalFilesNative() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      const script = [
        'activate',
        'set fs to choose file with prompt "选择要添加到项目上下文的参考文件" with multiple selections allowed',
        'set out to ""',
        'repeat with f in fs',
        'set out to out & POSIX path of f & linefeed',
        'end repeat',
        'return out'
      ];
      const args = [];
      for (const line of script) args.push('-e', line);
      execFile('osascript', args, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = `${err.message || ''}\n${stderr || ''}`;
          if (/User canceled|-128/i.test(msg)) {
            return resolve({ ok: true, canceled: true, paths: [] });
          }
          console.error('[Anti-Claude Daemon] pickLocalFilesNative failed:', msg.trim());
          return resolve({ ok: false, error: msg.trim() || 'pick_files_failed', paths: [] });
        }
        if (!stdout) return resolve({ ok: true, canceled: true, paths: [] });
        const paths = String(stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && fs.existsSync(s));
        resolve({ ok: true, canceled: paths.length === 0, paths });
      });
      return;
    }
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
        '$dlg.Multiselect = $true',
        'if ($dlg.ShowDialog() -eq "OK") { $dlg.FileNames -join "`n" }'
      ].join('; ');
      execFile('powershell', ['-NoProfile', '-STA', '-Command', ps], { timeout: 120000 }, (err, stdout) => {
        if (err || !stdout) return resolve({ ok: true, canceled: true, paths: [] });
        const paths = String(stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && fs.existsSync(s));
        resolve({ ok: true, canceled: paths.length === 0, paths });
      });
      return;
    }
    resolve({ ok: false, error: 'unsupported_platform', paths: [] });
  });
}

export function pickLocalFolderNative() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile(
        'osascript',
        ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "选择要加入本项目的本地文件夹")'],
        { timeout: 120000 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = `${err.message || ''}\n${stderr || ''}`;
            if (/User canceled|-128/i.test(msg)) {
              return resolve({ ok: true, canceled: true, folderPath: '' });
            }
            console.error('[Anti-Claude Daemon] pickLocalFolderNative failed:', msg.trim());
            return resolve({ ok: false, error: msg.trim() || 'pick_folder_failed', folderPath: '' });
          }
          if (!stdout) return resolve({ ok: true, canceled: true, folderPath: '' });
          const folderPath = String(stdout).trim().replace(/\/+$/, '');
          if (!folderPath || !fs.existsSync(folderPath)) return resolve({ ok: true, canceled: true, folderPath: '' });
          resolve({ ok: true, canceled: false, folderPath, name: path.basename(folderPath) || folderPath });
        }
      );
      return;
    }
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
        'if ($dlg.ShowDialog() -eq "OK") { $dlg.SelectedPath }'
      ].join('; ');
      execFile('powershell', ['-NoProfile', '-STA', '-Command', ps], { timeout: 120000 }, (err, stdout) => {
        if (err || !stdout) return resolve({ ok: true, canceled: true, folderPath: '' });
        const folderPath = String(stdout).trim();
        if (!folderPath || !fs.existsSync(folderPath)) return resolve({ ok: true, canceled: true, folderPath: '' });
        resolve({ ok: true, canceled: false, folderPath, name: path.basename(folderPath) || folderPath });
      });
      return;
    }
    resolve({ ok: false, error: 'unsupported_platform', folderPath: '' });
  });
}

export function revealLocalPath(rawPath, { openFolderContents = false } = {}) {
  if (!rawPath || typeof rawPath !== 'string') return { ok: false, error: 'missing_path' };
  const abs = path.resolve(rawPath);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st) return { ok: false, error: 'not_found' };
  const openInside = openFolderContents && st.isDirectory();
  if (process.platform === 'darwin') {
    execFile('open', openInside ? [abs] : ['-R', abs], () => {});
    return { ok: true };
  }
  if (process.platform === 'win32') {
    execFile('explorer', openInside ? [abs] : [`/select,${abs}`], () => {});
    return { ok: true };
  }
  execFile('xdg-open', [openInside ? abs : path.dirname(abs)], () => {});
  return { ok: true };
}
