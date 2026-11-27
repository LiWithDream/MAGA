/**
 * AGY Studio Remote Control — Sandboxed Read-Only Conversation Artifact Bridge
 * Reads Markdown artifacts strictly inside ~/.gemini/antigravity/brain/<cascadeId>/.
 * Defends against path traversal, ancestor/child symlinks, FIFOs/special files, and oversized reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOME, UUID_RE } from '../env.mjs';
import { isPathInsideDir } from '../projects.mjs';

export const MAX_ARTIFACT_BYTES = 128 * 1024;
export const MAX_ARTIFACT_LIST = 32;

const ARTIFACT_FILENAME_RE = /^[A-Za-z0-9._-]{1,128}\.md$/i;
const DEFAULT_BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity', 'brain');

function classifyArtifactKind(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.includes('plan')) return 'plan';
  if (lower.includes('walkthrough')) return 'walkthrough';
  if (lower.includes('task')) return 'task';
  return 'doc';
}

function extractMarkdownTitle(headText, fallbackName) {
  const lines = String(headText || '').split(/\r?\n/);
  for (const line of lines.slice(0, 16)) {
    const m = /^\s*#{1,3}\s+(.+)$/.exec(line);
    if (m && m[1].trim()) {
      return m[1].trim().slice(0, 120);
    }
  }
  return fallbackName;
}

function readBoundedUtf8(absPath, maxBytes) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw Object.assign(new Error('artifact_not_regular_file'), { code: 'artifact_not_regular_file' });
    }
    const toRead = Math.min(st.size, maxBytes + 1);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const n = fs.readSync(fd, buf, offset, toRead - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    const truncated = offset > maxBytes || st.size > maxBytes;
    const slice = truncated ? buf.subarray(0, maxBytes) : buf.subarray(0, offset);
    return {
      content: slice.toString('utf8'),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      truncated,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function resolveSafeConvoBrainDir(cascadeId, opts = {}) {
  const cid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
  if (!UUID_RE.test(cid)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  const brainDir = opts.brainDir || DEFAULT_BRAIN_DIR;
  let brainReal = '';
  try {
    const brainLst = fs.lstatSync(brainDir);
    if (brainLst.isSymbolicLink() || !brainLst.isDirectory()) return null;
    brainReal = fs.realpathSync(brainDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }

  const convoDir = path.join(brainReal, cid);
  if (!isPathInsideDir(brainReal, convoDir)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  try {
    const dirLst = fs.lstatSync(convoDir);
    if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) return null;
    const convoReal = fs.realpathSync(convoDir);
    if (!isPathInsideDir(brainReal, convoReal)) {
      throw Object.assign(new Error('artifact_path_forbidden'), { code: 'artifact_path_forbidden' });
    }
    return { cid, convoReal };
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export function listConversationArtifacts(cascadeId, opts = {}) {
  const resolved = resolveSafeConvoBrainDir(cascadeId, opts);
  const cid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
  if (!resolved) {
    return { ok: true, cascadeId: cid, artifacts: [] };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(resolved.convoReal, { withFileTypes: true });
  } catch {
    return { ok: true, cascadeId: resolved.cid, artifacts: [] };
  }

  const artifacts = [];
  for (const ent of entries) {
    if (artifacts.length >= MAX_ARTIFACT_LIST) break;
    const name = String(ent.name || '');
    if (!ARTIFACT_FILENAME_RE.test(name)) continue;
    const abs = path.join(resolved.convoReal, name);
    try {
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink() || !lst.isFile()) continue;
      const real = fs.realpathSync(abs);
      if (!isPathInsideDir(resolved.convoReal, real)) continue;
      const head = readBoundedUtf8(real, 1024);
      artifacts.push({
        name,
        title: extractMarkdownTitle(head.content, name),
        kind: classifyArtifactKind(name),
        sizeBytes: head.sizeBytes,
        updatedAt: new Date(head.mtimeMs).toISOString(),
      });
    } catch {}
  }

  artifacts.sort((a, b) => {
    const priority = { plan: 0, walkthrough: 1, task: 2, doc: 3 };
    const pa = priority[a.kind] ?? 3;
    const pb = priority[b.kind] ?? 3;
    if (pa !== pb) return pa - pb;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  return {
    ok: true,
    cascadeId: resolved.cid,
    artifacts,
  };
}

export function readConversationArtifact(cascadeId, fileName, opts = {}) {
  const resolved = resolveSafeConvoBrainDir(cascadeId, opts);
  const rawName = typeof fileName === 'string' ? fileName.trim() : '';
  if (!ARTIFACT_FILENAME_RE.test(rawName) || rawName.includes('..')) {
    throw Object.assign(new Error('invalid_artifact_name'), { code: 'invalid_artifact_name' });
  }
  if (!resolved) {
    throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
  }

  const abs = path.join(resolved.convoReal, rawName);
  if (!isPathInsideDir(resolved.convoReal, abs)) {
    throw Object.assign(new Error('artifact_path_forbidden'), { code: 'artifact_path_forbidden' });
  }

  let lst;
  try {
    lst = fs.lstatSync(abs);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
    }
    throw err;
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw Object.assign(new Error('artifact_path_forbidden'), { code: 'artifact_path_forbidden' });
  }

  const real = fs.realpathSync(abs);
  if (!isPathInsideDir(resolved.convoReal, real)) {
    throw Object.assign(new Error('artifact_path_forbidden'), { code: 'artifact_path_forbidden' });
  }

  const maxBytes = Number.isInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_ARTIFACT_BYTES;
  const readRes = readBoundedUtf8(real, maxBytes);
  return {
    ok: true,
    cascadeId: resolved.cid,
    name: rawName,
    title: extractMarkdownTitle(readRes.content, rawName),
    kind: classifyArtifactKind(rawName),
    content: readRes.content,
    sizeBytes: readRes.sizeBytes,
    truncated: readRes.truncated,
    updatedAt: new Date(readRes.mtimeMs).toISOString(),
  };
}
