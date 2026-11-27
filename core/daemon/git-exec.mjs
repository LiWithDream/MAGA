/**
 * Leaf Git Execution & Diff/Status Helpers for MAGA Daemon.
 * Uses `GIT_OPTIONAL_LOCKS=0` on every background read so status polling never
 * contends with user or agent `git add` / `git commit` index.lock operations.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setBounded } from './env.mjs';

const overviewGitCache = new Map();
const overviewGitInFlight = new Map();

export function execGitAsync(absDir, args, timeoutMs = 1200) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', absDir, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout || ''));
      }
    );
  });
}

export function normalizeNumstatPath(rawPath) {
  const s = String(rawPath || '').trim();
  if (!s) return '';
  const braceM = s.match(/^(.*?)\{([^{}]*?)\s*=>\s*([^{}]*?)\}(.*)$/);
  if (braceM) {
    return `${braceM[1]}${braceM[3].trim()}${braceM[4]}`.replace(/\/{2,}/g, '/');
  }
  const arrowIdx = s.indexOf(' => ');
  if (arrowIdx !== -1) {
    return s.slice(arrowIdx + 4).trim();
  }
  return s;
}

export function parseNumstatZ(numstatZ) {
  const entries = [];
  if (!numstatZ) return entries;
  const parts = String(numstatZ).split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i].replace(/^(?:\r?\n)+/, '');
    if (!raw) continue;
    const cols = raw.split('\t');
    if (cols.length < 3) continue;
    const a = parseInt(cols[0], 10);
    const d = parseInt(cols[1], 10);
    const added = Number.isFinite(a) ? a : 0;
    const deleted = Number.isFinite(d) ? d : 0;
    let filePath = cols.slice(2).join('\t');
    if (filePath === '' && i + 2 < parts.length) {
      // git --numstat -z encodes renames/copies as "<added>\t<deleted>\t\0<old>\0<new>\0"
      filePath = parts[i + 2];
      i += 2;
    }
    if (!filePath) continue;
    entries.push({ path: filePath, added, deleted });
  }
  return entries;
}

export function parseNumstatPerFile(numstatZ) {
  const map = new Map();
  for (const entry of parseNumstatZ(numstatZ)) {
    const prev = map.get(entry.path) || { added: 0, deleted: 0 };
    prev.added += entry.added;
    prev.deleted += entry.deleted;
    map.set(entry.path, prev);
  }
  return map;
}

export function parseNumstatOutput(numstatZ) {
  let added = 0;
  let deleted = 0;
  for (const entry of parseNumstatZ(numstatZ)) {
    added += entry.added;
    deleted += entry.deleted;
  }
  return { added, deleted };
}

export function parsePorcelainDirtyFiles(porcelainZ, numstatMap) {
  const files = [];
  if (!porcelainZ) return files;
  const entries = String(porcelainZ).split('\0');
  for (let i = 0; i < entries.length && files.length < 30; i += 1) {
    const rec = entries[i];
    if (!rec || rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const filePath = rec.slice(3);
    if (!filePath) continue;
    if (xy.includes('R') || xy.includes('C')) i += 1;
    let status = 'M';
    if (xy === '??') status = '?';
    else if (xy.includes('D')) status = 'D';
    else if (xy.includes('A')) status = 'A';
    else if (xy.includes('R')) status = 'R';
    const stat = numstatMap.get(filePath) || { added: 0, deleted: 0 };
    files.push({ path: filePath, status, added: stat.added, deleted: stat.deleted });
  }
  return files;
}

export function invalidateOverviewGitCache(absDir = '') {
  if (absDir) {
    overviewGitCache.delete(absDir);
  } else {
    overviewGitCache.clear();
  }
}

export async function readOverviewGitStatusAsync(absDir, { force = false } = {}) {
  if (!absDir) return null;
  const now = Date.now();
  const cached = overviewGitCache.get(absDir);
  if (!force && cached && now - cached.ts < 5000) return cached.git;
  if (overviewGitInFlight.has(absDir)) return overviewGitInFlight.get(absDir);
  const prevGood = cached && cached.git ? cached.git : null;

  const task = (async () => {
    let git = null;
    try {
      const [statusOut, headNumstat] = await Promise.all([
        execGitAsync(absDir, ['status', '--porcelain=v2', '--branch'], 1200),
        execGitAsync(absDir, ['diff', 'HEAD', '--numstat', '-z'], 1200),
      ]);
      if (statusOut !== null) {
        let branch = '';
        let changedFiles = 0;
        for (const line of statusOut.split(/\r?\n/)) {
          if (!line) continue;
          if (line.startsWith('# branch.head ')) {
            const rawHead = line.slice('# branch.head '.length).trim();
            branch = rawHead === '(detached)' ? 'HEAD' : rawHead;
          } else if (!line.startsWith('#')) {
            changedFiles += 1;
          }
        }
        if (branch) {
          let numstatZ = headNumstat;
          if (numstatZ === null && changedFiles > 0) {
            const [unstaged, staged] = await Promise.all([
              execGitAsync(absDir, ['diff', '--numstat', '-z'], 1000),
              execGitAsync(absDir, ['diff', '--cached', '--numstat', '-z'], 1000),
            ]);
            numstatZ = `${unstaged || ''}\0${staged || ''}`;
          }
          const { added, deleted } = parseNumstatOutput(numstatZ);
          git = { branch, added, deleted, changedFiles };
        }
      } else if (prevGood && fs.existsSync(path.join(absDir, '.git'))) {
        git = prevGood;
      }
    } catch {
      git = prevGood && fs.existsSync(path.join(absDir, '.git')) ? prevGood : null;
    }
    setBounded(overviewGitCache, absDir, { ts: Date.now(), git }, 32);
    return git;
  })().finally(() => {
    overviewGitInFlight.delete(absDir);
  });

  overviewGitInFlight.set(absDir, task);
  return task;
}
