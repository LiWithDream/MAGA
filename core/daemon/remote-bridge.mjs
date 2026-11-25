/**
 * MAGA Remote Control — Daemon-side Bridge, UDS NDJSON RPC Server, Disk Fallback & Gateway Supervisor
 */
import { execFile, fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DatabaseSync,
  HOME,
  REPO_ROOT,
  STATE_DIR,
  UUID_RE,
  attachedTargets,
  readJsonOrFallback,
  runtimeState
} from './env.mjs';
import { isPathInsideDir } from './projects.mjs';

export const DEFAULT_REMOTE_CONFIG = Object.freeze({
  enabled: false,
  port: 18791,
  transport: 'loopback',
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: [],
  cfAccessTeamDomain: '',
  cfAccessAud: '',
  tailscaleAllowedUsers: [],
  allowLocalPairingWithoutEdge: true
});

const MAX_ACTIVE_STREAMS = 3;
const MAX_UDS_LINE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_STEPS = 200;
const MAX_SNAPSHOT_BYTES = Math.floor(1.5 * 1024 * 1024);
const MAX_TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const MAX_FIELD_CHARS = 16384;
const GATEWAY_RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

let bridgeState = null;

export function resolveRemotePaths(env = process.env) {
  const baseStateDir = path.resolve(env.ANTI_CLAUDE_STATE_DIR || STATE_DIR);
  const remoteDir = path.resolve(env.MAGA_REMOTE_STATE_DIR || path.join(baseStateDir, 'remote'));
  const configFile = path.join(remoteDir, 'config.json');
  const explicitSock = typeof env.MAGA_REMOTE_SOCK_PATH === 'string' && env.MAGA_REMOTE_SOCK_PATH.trim();
  let sockPath = explicitSock ? path.resolve(explicitSock) : path.join(remoteDir, 'bridge.sock');
  if (Buffer.byteLength(sockPath, 'utf8') > 95) {
    const hash = crypto.createHash('sha256').update(remoteDir).digest('hex').slice(0, 12);
    sockPath = path.join(os.tmpdir(), `maga-rem-${hash}.sock`);
  }
  return { remoteDir, configFile, sockPath };
}

function ensureRemoteDir(remoteDir) {
  fs.mkdirSync(remoteDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(remoteDir, 0o700);
  } catch {}
}

function truncateText(val, max = MAX_FIELD_CHARS) {
  const s = String(val ?? '');
  if (s.length <= max) return s;
  const prefix = '…(truncated)\n';
  const keep = Math.max(256, max - prefix.length);
  return `${prefix}${s.slice(-keep)}`;
}

function normalizeGlobalPresetValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/TURBO/i.test(s)) return 3;
  if (/REQUEST_REVIEW|REVIEW/i.test(s)) return 2;
  if (/AUTO|SAFE|DEFAULT/i.test(s)) return 1;
  if (/OFF|READ_ONLY|NONE/i.test(s)) return 0;
  return null;
}

export function readDiskGlobalPreset(configPath = path.join(HOME, '.gemini', 'config', 'config.json')) {
  const cfg = readJsonOrFallback(configPath, null);
  const us = cfg && typeof cfg === 'object' ? cfg.userSettings || cfg : null;
  if (!us || typeof us !== 'object') return null;
  const raw = us.globalPreset ?? us.permissionPreset ?? null;
  return normalizeGlobalPresetValue(raw);
}

export function computeWaitingStepHash(cascadeId, step) {
  const stepIndex = Number(step?.stepIndex ?? 0);
  const trajectoryId = String(step?.trajectoryId || '');
  const interactionCase = String(step?.interactionCase || '');
  const toolName = String(step?.toolName || '');
  const commandLine = String(step?.commandLine || '');
  return crypto
    .createHash('sha256')
    .update(`${cascadeId}|${trajectoryId}|${stepIndex}|${interactionCase}|${toolName}|${commandLine}`)
    .digest('hex')
    .slice(0, 16);
}

function normalizeWaitingStepsWithSha(cascadeId, list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.map((w) => ({
    stepIndex: Number(w?.stepIndex ?? 0),
    waitingStepHash: computeWaitingStepHash(cascadeId, w),
    toolName: String(w?.toolName || ''),
    action: String(w?.action || ''),
    commandLine: String(w?.commandLine || ''),
    trajectoryId: String(w?.trajectoryId || ''),
    interactionCase: String(w?.interactionCase || '')
  }));
}

function parsePbMap(buf) {
  const bytes = buf instanceof Uint8Array ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : Buffer.alloc(0);
  const fields = new Map();
  let i = 0;
  const readVarint = () => {
    let val = 0n;
    let shift = 0n;
    const start = i;
    while (i < bytes.length && i - start < 10) {
      const b = bytes[i++];
      val |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return Number(val);
      shift += 7n;
    }
    return 0;
  };
  while (i < bytes.length) {
    const tag = readVarint();
    if (!tag) break;
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 0) break;
    if (!fields.has(fn)) fields.set(fn, []);
    if (wt === 0) {
      fields.get(fn).push(readVarint());
    } else if (wt === 2) {
      const len = readVarint();
      if (len < 0 || i + len > bytes.length) break;
      fields.get(fn).push(bytes.subarray(i, i + len));
      i += len;
    } else if (wt === 5) {
      if (i + 4 > bytes.length) break;
      fields.get(fn).push(bytes.subarray(i, i + 4));
      i += 4;
    } else if (wt === 1) {
      if (i + 8 > bytes.length) break;
      fields.get(fn).push(bytes.subarray(i, i + 8));
      i += 8;
    } else {
      break;
    }
  }
  return fields;
}

function asUtf8(val) {
  if (!(val instanceof Uint8Array)) return '';
  return Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('utf8');
}

function decodeProtoTimestamp(buf) {
  if (!(buf instanceof Uint8Array)) return '';
  const m = parsePbMap(buf);
  const sec = m.get(1)?.[0];
  const ns = m.get(2)?.[0] || 0;
  if (!Number.isFinite(sec) || sec <= 0) return '';
  return new Date(sec * 1000 + Math.floor(ns / 1e6)).toISOString();
}

function openReadOnlySqlite(dbPath) {
  if (!DatabaseSync) return null;
  const walSt = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
  const hasActiveWal = Boolean(walSt && walSt.size > 0);
  let location = dbPath;
  if (!hasActiveWal) {
    location = pathToFileURL(dbPath);
    location.searchParams.set('immutable', '1');
  }
  const db = new DatabaseSync(location, { readOnly: true, timeout: 150 });
  if (hasActiveWal) {
    try {
      db.exec('PRAGMA busy_timeout = 150');
    } catch {}
  }
  return db;
}

function normalizeDiskDatetime(raw) {
  const s = String(raw || '').trim();
  if (!s || s.startsWith('0001-01-01')) return '';
  const isoCandidate = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(isoCandidate);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function mapDiskSummaryStatus(row) {
  if (Number(row?.killed) === 1) return 'KILLED';
  const raw = String(row?.status || '');
  if (Number(row?.not_fully_idle) === 1 || /RUNNING|IN_PROGRESS|ACTIVE/i.test(raw)) return 'RUNNING';
  if (/CANCEL/i.test(raw)) return 'CANCELED';
  if (/ERROR/i.test(raw)) return 'ERROR';
  return 'IDLE';
}

function mapDiskStepType(stepType, txType = '') {
  if (stepType === 14) return 'USER_INPUT';
  if (stepType === 15) return 'PLANNER_RESPONSE';
  if (stepType === 17) return 'ERROR_MESSAGE';
  if (stepType === 23) return 'CHECKPOINT';
  if (stepType === 101) return 'SYSTEM_MESSAGE';
  if (stepType === 132) return 'TOOL_CALL';
  return txType || 'GENERIC';
}

function mapDiskStepStatus(status, txStatus = '') {
  switch (status) {
    case 1:
      return 'PENDING';
    case 2:
    case 8:
      return 'RUNNING';
    case 3:
      return 'DONE';
    case 4:
    case 7:
      return 'ERROR';
    case 5:
      return 'CLEARED';
    case 6:
      return 'CANCELED';
    default:
      return txStatus || 'IDLE';
  }
}

export function readConversationListFromDisk({
  includeSubagents = false,
  antigravityDir = path.join(HOME, '.gemini', 'antigravity'),
  agConfigPath = path.join(HOME, '.gemini', 'config', 'config.json')
} = {}) {
  const globalPreset = readDiskGlobalPreset(agConfigPath);
  if (!DatabaseSync) {
    return { source: 'disk', globalPreset, conversations: [] };
  }
  const sumDbPath = path.join(antigravityDir, 'conversation_summaries.db');
  if (!isPathInsideDir(antigravityDir, sumDbPath) || !fs.existsSync(sumDbPath)) {
    return { source: 'disk', globalPreset, conversations: [] };
  }

  let db = null;
  try {
    db = openReadOnlySqlite(sumDbPath);
    if (!db) return { source: 'disk', globalPreset, conversations: [] };
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time, status, project_id, agent_name, parent_conversation_id, not_fully_idle, killed
         FROM conversation_summaries
         ORDER BY last_modified_time DESC
         LIMIT 250`
      )
      .all();
    const conversations = [];
    for (const row of rows) {
      const id = String(row.conversation_id || '');
      if (!UUID_RE.test(id)) continue;
      const parentConversationId = String(row.parent_conversation_id || '');
      if (!includeSubagents && parentConversationId) continue;
      const title = String(row.title || row.preview || id).trim();
      conversations.push({
        id,
        title,
        summary: String(row.preview || row.title || '').trim(),
        status: mapDiskSummaryStatus(row),
        stepCount: Number(row.step_count || 0),
        lastModifiedTime: normalizeDiskDatetime(row.last_modified_time),
        projectId: String(row.project_id || ''),
        parentConversationId,
        waitingSteps: []
      });
    }
    return { source: 'disk', globalPreset, conversations };
  } catch {
    return { source: 'disk', globalPreset, conversations: [] };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function readTranscriptTailMap(transcriptPath, maxTailBytes = MAX_TRANSCRIPT_TAIL_BYTES) {
  const map = new Map();
  let st = null;
  try {
    st = fs.statSync(transcriptPath, { throwIfNoEntry: false });
  } catch {}
  if (!st || !st.isFile() || st.size === 0) return map;

  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const readSize = Math.min(st.size, maxTailBytes);
    const offset = st.size - readSize;
    const buf = Buffer.allocUnsafe(readSize);
    let totalRead = 0;
    while (totalRead < readSize) {
      const n = fs.readSync(fd, buf, totalRead, readSize - totalRead, offset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    let raw = buf.subarray(0, totalRead).toString('utf8');
    if (offset > 0) {
      const firstNl = raw.indexOf('\n');
      raw = firstNl !== -1 ? raw.slice(firstNl + 1) : '';
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (Number.isInteger(obj?.step_index)) {
          map.set(obj.step_index, obj);
        }
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return map;
}

function decodeProtoStepFields(row) {
  const metaMap = row.metadata ? parsePbMap(row.metadata) : new Map();
  const payloadMap = row.step_payload ? parsePbMap(row.step_payload) : new Map();
  const createdAt = decodeProtoTimestamp(metaMap.get(1)?.[0]);
  let text = '';
  let thinking = '';
  const toolCalls = [];

  if (row.step_type === 14) {
    const f19 = payloadMap.get(19)?.[0];
    if (f19 instanceof Uint8Array) {
      const m19 = parsePbMap(f19);
      const userResp = asUtf8(m19.get(2)?.[0]);
      if (userResp) {
        text = userResp;
      } else {
        const parts = [];
        for (const itemBuf of m19.get(12) || []) {
          const itemMap = parsePbMap(itemBuf);
          const txt = asUtf8(itemMap.get(1)?.[0]);
          if (txt) parts.push(txt);
        }
        text = parts.join('');
      }
    }
  } else if (row.step_type === 15) {
    const f20 = payloadMap.get(20)?.[0];
    if (f20 instanceof Uint8Array) {
      const m20 = parsePbMap(f20);
      text = asUtf8(m20.get(8)?.[0]) || asUtf8(m20.get(1)?.[0]);
      thinking = asUtf8(m20.get(3)?.[0]);
      for (const tcBuf of m20.get(7) || []) {
        const tcMap = parsePbMap(tcBuf);
        const name = asUtf8(tcMap.get(2)?.[0]);
        if (!name) continue;
        toolCalls.push({
          id: asUtf8(tcMap.get(1)?.[0]),
          name: name.includes(':') ? name.split(':').pop() : name,
          args: truncateText(asUtf8(tcMap.get(3)?.[0]), 4096)
        });
      }
    }
  } else if (row.step_type === 132) {
    const tcBuf = metaMap.get(4)?.[0];
    const tcMap = tcBuf instanceof Uint8Array ? parsePbMap(tcBuf) : new Map();
    const rawName = asUtf8(tcMap.get(2)?.[0]);
    const f140 = payloadMap.get(140)?.[0];
    const m140 = f140 instanceof Uint8Array ? parsePbMap(f140) : new Map();
    const outBuf = m140.get(2)?.[0];
    const mOut = outBuf instanceof Uint8Array ? parsePbMap(outBuf) : new Map();
    const output = asUtf8(mOut.get(1)?.[0]) || asUtf8(mOut.get(3)?.[0]);
    if (rawName || output) {
      toolCalls.push({
        id: asUtf8(tcMap.get(1)?.[0]),
        name: rawName.includes(':') ? rawName.split(':').pop() : rawName || 'tool',
        args: truncateText(asUtf8(tcMap.get(3)?.[0]), 4096),
        output: truncateText(output, 8192)
      });
    }
  } else if (row.step_type === 17) {
    text = asUtf8(row.error_details);
  }

  let error = null;
  if (row.error_details && row.error_details.length > 0) {
    const errMap = parsePbMap(row.error_details);
    const msg = asUtf8(errMap.get(1)?.[0]) || asUtf8(errMap.get(2)?.[0]) || asUtf8(row.error_details);
    if (msg) error = { message: truncateText(msg, 2048) };
  }

  return { createdAt, text, thinking, toolCalls, error };
}

function normalizeTranscriptToolCalls(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((tc) => ({
    id: String(tc?.id || ''),
    name: String(tc?.name || 'tool'),
    args: truncateText(typeof tc?.args === 'string' ? tc.args : JSON.stringify(tc?.args ?? {}), 4096)
  }));
}

function applySnapshotByteBudget(snapshot, maxBytes = MAX_SNAPSHOT_BYTES) {
  if (!snapshot || !Array.isArray(snapshot.steps)) return snapshot;
  const out = {
    ...snapshot,
    streamingText: snapshot.streamingText ? truncateText(snapshot.streamingText, 64 * 1024) : ''
  };
  let steps = out.steps.map((s) => ({
    ...s,
    toolCalls: Array.isArray(s.toolCalls) ? s.toolCalls.map((tc) => ({ ...tc })) : []
  }));
  out.steps = steps;
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') <= maxBytes) return out;

  const recentPreserve = 10;
  const trimOlderEnd = Math.max(0, steps.length - recentPreserve);
  for (let i = 0; i < trimOlderEnd; i++) {
    const s = steps[i];
    if (s.thinking) s.thinking = '';
    for (const tc of s.toolCalls) {
      if (tc.output && tc.output.length > 512) tc.output = truncateText(tc.output, 512);
      if (tc.args && tc.args.length > 512) tc.args = truncateText(tc.args, 512);
    }
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') <= maxBytes) return out;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (i < steps.length - 1 && s.thinking) s.thinking = '';
    if (i < trimOlderEnd && s.text && s.text.length > 1024) s.text = truncateText(s.text, 1024);
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') <= maxBytes) return out;

  while (steps.length > 1 && Buffer.byteLength(JSON.stringify(out), 'utf8') > maxBytes) {
    steps.shift();
    out.hasMore = true;
  }
  if (out.hasMore && steps.length > 0) {
    out.nextBeforeIdx = steps[0].idx;
  }
  return out;
}

export function readConversationSnapshotFromDisk(
  cascadeId,
  { antigravityDir = path.join(HOME, '.gemini', 'antigravity'), beforeIdx = null } = {}
) {
  if (!UUID_RE.test(String(cascadeId || ''))) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const hasBefore = Number.isInteger(beforeIdx) && beforeIdx >= 0;
  const convDir = path.join(antigravityDir, 'conversations');
  const brainDir = path.join(antigravityDir, 'brain');
  const dbPath = path.join(convDir, `${cascadeId}.db`);
  const transcriptPath = path.join(brainDir, cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
  const safeDb = isPathInsideDir(convDir, dbPath) && fs.existsSync(dbPath);
  const safeTx = isPathInsideDir(brainDir, transcriptPath) && fs.existsSync(transcriptPath);
  const txMap = safeTx ? readTranscriptTailMap(transcriptPath) : new Map();

  let steps = [];
  let status = 'IDLE';
  let hasMore = false;

  if (safeDb && DatabaseSync) {
    let db = null;
    try {
      db = openReadOnlySqlite(dbPath);
      if (db) {
        const rows = hasBefore
          ? db
              .prepare(
                'SELECT idx, step_type, status, metadata, error_details, step_payload FROM steps WHERE idx < ? ORDER BY idx DESC LIMIT ?'
              )
              .all(beforeIdx, MAX_SNAPSHOT_STEPS + 1)
          : db
              .prepare(
                'SELECT idx, step_type, status, metadata, error_details, step_payload FROM steps ORDER BY idx DESC LIMIT ?'
              )
              .all(MAX_SNAPSHOT_STEPS + 1);
        hasMore = rows.length > MAX_SNAPSHOT_STEPS;
        const slice = (hasMore ? rows.slice(0, MAX_SNAPSHOT_STEPS) : rows).reverse();
        steps = slice.map((row) => {
          const tx = txMap.get(row.idx);
          const pb = decodeProtoStepFields(row);
          const normStatus = mapDiskStepStatus(row.status, tx?.status);
          const useTx = Boolean(tx && (normStatus === 'DONE' || pb.text === ''));
          const text = useTx && typeof tx.content === 'string' ? tx.content : pb.text || (typeof tx?.content === 'string' ? tx.content : '');
          const thinking =
            useTx && typeof tx.thinking === 'string' ? tx.thinking : pb.thinking || (typeof tx?.thinking === 'string' ? tx.thinking : '');
          const toolCalls =
            Array.isArray(tx?.tool_calls) && tx.tool_calls.length > 0
              ? normalizeTranscriptToolCalls(tx.tool_calls)
              : pb.toolCalls;
          return {
            idx: Number(row.idx),
            type: mapDiskStepType(row.step_type, tx?.type),
            status: normStatus,
            createdAt: tx?.created_at || pb.createdAt || '',
            text: truncateText(text),
            thinking: truncateText(thinking),
            toolCalls,
            error: pb.error
          };
        });
      }
    } catch {
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  if (steps.length === 0 && txMap.size > 0) {
    let entries = Array.from(txMap.values()).sort((a, b) => a.step_index - b.step_index);
    if (hasBefore) entries = entries.filter((tx) => tx.step_index < beforeIdx);
    hasMore = entries.length > MAX_SNAPSHOT_STEPS;
    const slice = hasMore ? entries.slice(-MAX_SNAPSHOT_STEPS) : entries;
    steps = slice.map((tx) => ({
      idx: Number(tx.step_index),
      type: String(tx.type || 'GENERIC'),
      status: String(tx.status || 'DONE'),
      createdAt: String(tx.created_at || ''),
      text: truncateText(tx.content || ''),
      thinking: truncateText(tx.thinking || ''),
      toolCalls: normalizeTranscriptToolCalls(tx.tool_calls),
      error: null
    }));
  }

  const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
  if (lastStep && (lastStep.status === 'RUNNING' || lastStep.status === 'PENDING')) {
    status = 'RUNNING';
  }

  return applySnapshotByteBudget({
    cascadeId,
    source: 'disk',
    status,
    steps,
    hasMore,
    nextBeforeIdx: hasMore && steps.length > 0 ? steps[0].idx : null,
    waitingSteps: [],
    streamingText: ''
  });
}

function getConfirmedHostEntries() {
  const pages = [];
  for (const [, entry] of attachedTargets.entries()) {
    if (entry?.hostConfirmed && entry.type === 'page' && entry.ws?.readyState === WebSocket.OPEN) {
      pages.push(entry);
    }
  }
  return pages;
}

function scoreHostCapabilities(tapCap) {
  if (!tapCap || !tapCap.capabilities) return -1;
  const c = tapCap.capabilities;
  return (
    (c.reduxSummaries ? 8 : 0) +
    (c.agentStream ? 4 : 0) +
    (c.sendMessage ? 2 : 0) +
    (c.approval ? 2 : 0) +
    (c.cancel ? 1 : 0)
  );
}

function pickPrimaryHostEntry() {
  const hosts = getConfirmedHostEntries();
  if (hosts.length === 0) return null;
  if (hosts.length === 1) return hosts[0];
  let best = hosts[0];
  let bestScore = typeof best._remoteCapScore === 'number' ? best._remoteCapScore : -1;
  for (const h of hosts) {
    const score = typeof h._remoteCapScore === 'number' ? h._remoteCapScore : -1;
    if (score > bestScore) {
      best = h;
      bestScore = score;
    }
  }
  return best;
}

async function resolvePrimaryHostEntry() {
  const hosts = getConfirmedHostEntries();
  if (hosts.length === 0) return null;
  if (hosts.length === 1) {
    const only = hosts[0];
    const r = await evalOnHost(only, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 2500);
    if (r.ok && r.value && typeof r.value === 'object') {
      only._remoteCap = r.value;
      only._remoteCapScore = scoreHostCapabilities(r.value);
    }
    return only;
  }
  const results = await Promise.all(
    hosts.map(async (entry) => {
      const r = await evalOnHost(entry, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 2500);
      const cap = r.ok && r.value && typeof r.value === 'object' ? r.value : null;
      if (cap) {
        entry._remoteCap = cap;
        entry._remoteCapScore = scoreHostCapabilities(cap);
      }
      return { entry, score: cap ? scoreHostCapabilities(cap) : -1 };
    })
  );
  results.sort((a, b) => b.score - a.score);
  return results[0]?.entry || hosts[0];
}

async function evalOnHost(entry, expression, timeoutMs = 4500) {
  if (!entry?.hostConfirmed || entry.ws?.readyState !== WebSocket.OPEN) {
    return { ok: false, error: 'host_not_ready' };
  }
  const params = {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(entry.trustedContextId !== null ? { contextId: entry.trustedContextId } : {})
  };
  try {
    const res = await entry.send('Runtime.evaluate', params, timeoutMs);
    if (res?.exceptionDetails) {
      return { ok: false, error: res.exceptionDetails.text || 'cdp_eval_exception' };
    }
    return { ok: true, value: res?.result?.result?.value ?? null };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function probeRemoteCapabilities() {
  const hosts = getConfirmedHostEntries();
  const primary = await resolvePrimaryHostEntry();
  const diskPreset = readDiskGlobalPreset();
  const state = bridgeState;

  const base = {
    ok: true,
    hostAttached: hosts.length > 0,
    hostCount: hosts.length,
    capabilities: {
      reduxSummaries: false,
      agentStream: false,
      sendMessage: false,
      cancel: false,
      approval: false,
      diskRead: Boolean(DatabaseSync)
    },
    agVersion: null,
    globalPreset: diskPreset,
    tapActive: Boolean(state?.tapDesiredActive ?? state?.tapActive),
    activeStreams: state ? Array.from(state.watchedStreams.keys()) : []
  };

  if (!primary) return base;

  const tapCap =
    primary._remoteCap ||
    (await evalOnHost(primary, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 3000)).value ||
    null;
  if (!tapCap || typeof tapCap !== 'object') return base;

  return {
    ok: true,
    hostAttached: true,
    hostCount: hosts.length,
    capabilities: {
      reduxSummaries: Boolean(tapCap.capabilities?.reduxSummaries),
      agentStream: Boolean(tapCap.capabilities?.agentStream),
      sendMessage: Boolean(tapCap.capabilities?.sendMessage),
      cancel: Boolean(tapCap.capabilities?.cancel),
      approval: Boolean(tapCap.capabilities?.approval),
      diskRead: Boolean(DatabaseSync)
    },
    agVersion: tapCap.agVersion || null,
    globalPreset: tapCap.globalPreset ?? diskPreset,
    tapActive: Boolean(state ? state.tapActive && tapCap.tapActive : tapCap.tapActive),
    activeStreams: state ? Array.from(state.watchedStreams.keys()) : tapCap.activeStreams || []
  };
}

function broadcastTapEvent(kind, data) {
  if (!bridgeState) return;
  const line = `${JSON.stringify({
    event: 'tap',
    payload: {
      kind,
      ts: Date.now(),
      data
    }
  })}\n`;
  for (const client of bridgeState.clients.keys()) {
    if (!client.destroyed && client.writable) {
      try {
        client.write(line);
      } catch {}
    }
  }
}

async function applyTapStateToHost(entry, active, skipWatchCid = null) {
  if (!entry?.hostConfirmed || entry.type !== 'page' || !entry.rpcToken) return false;
  if (active) {
    const r = await evalOnHost(
      entry,
      `window.__agRemoteTap ? window.__agRemoteTap.enable(${JSON.stringify({ token: entry.rpcToken, throttleMs: 150 })}) : { ok: false }`,
      3000
    );
    if (!r.ok || !r.value?.ok) return false;
    if (bridgeState) {
      for (const cid of bridgeState.watchedStreams.keys()) {
        if (skipWatchCid && cid === skipWatchCid) continue;
        await evalOnHost(
          entry,
          `window.__agRemoteTap ? window.__agRemoteTap.watch(${JSON.stringify(cid)}) : { ok: false }`,
          3000
        );
      }
    }
    return true;
  }
  await evalOnHost(entry, 'window.__agRemoteTap ? window.__agRemoteTap.disable() : { ok: true }', 2500);
  return true;
}

async function setTapActive(active, { skipWatchCid = null } = {}) {
  if (!bridgeState) return { ok: false, active: false };
  const next = Boolean(active);
  bridgeState.tapDesiredActive = next;
  const hosts = getConfirmedHostEntries();
  if (!next) {
    bridgeState.tapActive = false;
    bridgeState.activeTapTargetId = null;
    bridgeState.tapRetryNextAt = 0;
    bridgeState.tapRetryBackoffMs = 2000;
    bridgeState.watchedStreams.clear();
    await Promise.allSettled(hosts.map((entry) => applyTapStateToHost(entry, false)));
    return { ok: true, active: false };
  }
  const primary = await resolvePrimaryHostEntry();
  let applied = false;
  if (primary) {
    bridgeState.activeTapTargetId = primary.id;
    const results = await Promise.allSettled(
      hosts.map((entry) => applyTapStateToHost(entry, entry.id === primary.id, skipWatchCid))
    );
    const pIdx = hosts.indexOf(primary);
    applied = pIdx !== -1 && results[pIdx]?.status === 'fulfilled' && results[pIdx].value === true;
    bridgeState.tapActive = applied;
    if (!applied) {
      bridgeState.tapRetryBackoffMs = 2000;
      bridgeState.tapRetryNextAt = Date.now() + 2000;
    } else {
      bridgeState.tapRetryBackoffMs = 2000;
      bridgeState.tapRetryNextAt = 0;
    }
  } else {
    bridgeState.tapActive = false;
  }
  return { ok: true, active: next, tapEnabledOnHost: applied };
}

async function handleConvoList(params = {}) {
  const includeSubagents = Boolean(params?.includeSubagents);
  const primary = await resolvePrimaryHostEntry();
  if (primary) {
    const r = await evalOnHost(
      primary,
      `window.__agRemoteTap ? window.__agRemoteTap.listSummaries(${JSON.stringify({ includeSubagents })}) : null`,
      4500
    );
    if (r.ok && r.value?.ok && Array.isArray(r.value.conversations)) {
      const conversations = r.value.conversations.map((c) => ({
        id: String(c.id || ''),
        title: String(c.title || ''),
        summary: String(c.summary || ''),
        status: String(c.status || 'IDLE'),
        stepCount: Number(c.stepCount || 0),
        lastModifiedTime: String(c.lastModifiedTime || ''),
        projectId: String(c.projectId || ''),
        parentConversationId: String(c.parentConversationId || ''),
        waitingSteps: normalizeWaitingStepsWithSha(c.id, c.waitingSteps),
        ...(Array.isArray(c.waitingSubagents) && c.waitingSubagents.length > 0
          ? {
              waitingSubagents: c.waitingSubagents.map((sub) => ({
                id: String(sub.id || ''),
                title: String(sub.title || ''),
                waitingSteps: normalizeWaitingStepsWithSha(sub.id, sub.waitingSteps)
              }))
            }
          : {})
      }));
      return {
        source: 'cdp',
        globalPreset: r.value.globalPreset ?? readDiskGlobalPreset(),
        conversations,
        ...(r.value.byParent ? { byParent: r.value.byParent } : {})
      };
    }
  }
  return readConversationListFromDisk({ includeSubagents });
}

async function handleConvoSnapshot(params = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  const rawBefore = params?.beforeIdx;
  const beforeIdx =
    rawBefore !== undefined && rawBefore !== null && Number.isInteger(Number(rawBefore)) && Number(rawBefore) >= 0
      ? Number(rawBefore)
      : null;

  const primary = await resolvePrimaryHostEntry();
  if (primary) {
    const tapOpts = beforeIdx !== null ? { beforeIdx } : {};
    const r = await evalOnHost(
      primary,
      `window.__agRemoteTap ? window.__agRemoteTap.getSnapshot(${JSON.stringify(cascadeId)}, ${JSON.stringify(tapOpts)}) : null`,
      6000
    );
    if (r.ok && r.value?.ok && Array.isArray(r.value.steps)) {
      return applySnapshotByteBudget({
        cascadeId,
        source: 'cdp',
        status: String(r.value.status || 'IDLE'),
        steps: r.value.steps,
        hasMore: Boolean(r.value.hasMore),
        nextBeforeIdx: Number.isInteger(r.value.nextBeforeIdx) ? r.value.nextBeforeIdx : null,
        waitingSteps: normalizeWaitingStepsWithSha(cascadeId, r.value.waitingSteps),
        streamingText: String(r.value.streamingText || '')
      });
    }
  }
  const disk = readConversationSnapshotFromDisk(cascadeId, { beforeIdx });
  if (disk.ok === false) {
    throw Object.assign(new Error(disk.error || 'snapshot_failed'), { code: disk.error || 'snapshot_failed' });
  }
  return disk;
}

async function handleConvoWatch(client, params = {}) {
  if (!bridgeState) throw new Error('bridge_not_initialized');
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  const watch = Boolean(params?.watch);
  const clientSet = bridgeState.clients.get(client);
  const streams = bridgeState.watchedStreams;

  if (watch) {
    let streamEntry = streams.get(cascadeId);
    if (!streamEntry) {
      if (streams.size >= MAX_ACTIVE_STREAMS) {
        throw Object.assign(new Error('max_streams_reached'), { code: 'max_streams_reached' });
      }
      const primary =
        (bridgeState.activeTapTargetId &&
          getConfirmedHostEntries().find((e) => e.id === bridgeState.activeTapTargetId)) ||
        pickPrimaryHostEntry();
      if (!primary) {
        throw Object.assign(new Error('no_host_attached'), { code: 'no_host_attached' });
      }

      streamEntry = { owners: new Set([client]), readyPromise: null };
      streams.set(cascadeId, streamEntry);
      clientSet?.add(cascadeId);

      streamEntry.readyPromise = (async () => {
        if (!bridgeState) throw new Error('bridge_closed');
        if (!bridgeState.tapActive || bridgeState.activeTapTargetId !== primary.id) {
          await setTapActive(true, { skipWatchCid: cascadeId });
        }
        const target =
          getConfirmedHostEntries().find((e) => e.id === bridgeState.activeTapTargetId) ||
          (await resolvePrimaryHostEntry());
        if (!target) {
          throw Object.assign(new Error('no_host_attached'), { code: 'no_host_attached' });
        }
        const r = await evalOnHost(
          target,
          `window.__agRemoteTap ? window.__agRemoteTap.watch(${JSON.stringify(cascadeId)}) : { ok: false, error: "tap_not_mounted" }`,
          4000
        );
        if (!r.ok || !r.value?.ok) {
          throw Object.assign(new Error(r.value?.error || r.error || 'watch_failed'), {
            code: r.value?.error || r.error || 'watch_failed'
          });
        }
      })();
    } else {
      streamEntry.owners.add(client);
      clientSet?.add(cascadeId);
    }

    try {
      await streamEntry.readyPromise;
    } catch (err) {
      streamEntry.owners.delete(client);
      clientSet?.delete(cascadeId);
      if (streamEntry.owners.size === 0 && streams.get(cascadeId) === streamEntry) {
        streams.delete(cascadeId);
      }
      throw err;
    }

    if (client.destroyed) {
      await handleConvoWatch(client, { cascadeId, watch: false }).catch(() => {});
      throw Object.assign(new Error('client_closed'), { code: 'client_closed' });
    }
    return { ok: true, watching: true, activeStreams: Array.from(streams.keys()) };
  }

  clientSet?.delete(cascadeId);
  const streamEntry = streams.get(cascadeId);
  if (streamEntry) {
    streamEntry.owners.delete(client);
    if (streamEntry.owners.size === 0) {
      streams.delete(cascadeId);
      const hosts = getConfirmedHostEntries();
      await Promise.allSettled(
        hosts.map((entry) =>
          evalOnHost(
            entry,
            `window.__agRemoteTap ? window.__agRemoteTap.unwatch(${JSON.stringify(cascadeId)}, true) : { ok: true }`,
            3000
          )
        )
      );
    }
  }
  return { ok: true, watching: streams.has(cascadeId), activeStreams: Array.from(streams.keys()) };
}

async function releaseClientWatches(client) {
  if (!bridgeState) return;
  const watched = bridgeState.clients.get(client);
  if (!watched) return;
  for (const cid of Array.from(watched)) {
    await handleConvoWatch(client, { cascadeId: cid, watch: false }).catch(() => {});
  }
}

async function dispatchUdsRpc(client, req) {
  const id = req?.id;
  const method = req?.method;
  const params = req?.params && typeof req.params === 'object' ? req.params : {};
  const reply = (ok, result = null, error = null) => {
    if (id === undefined || client.destroyed || !client.writable) return;
    try {
      client.write(`${JSON.stringify({ id, ok, result, error })}\n`);
    } catch {}
  };

  if (typeof method !== 'string' || !method) {
    reply(false, null, 'invalid_request');
    return;
  }

  try {
    if (method === 'bridge.health') {
      const res = await probeRemoteCapabilities();
      reply(true, res, null);
    } else if (method === 'tap.setActive') {
      const res = await setTapActive(Boolean(params.active));
      reply(true, res, null);
    } else if (method === 'convo.list') {
      const res = await handleConvoList(params);
      reply(true, res, null);
    } else if (method === 'convo.snapshot') {
      const res = await handleConvoSnapshot(params);
      reply(true, res, null);
    } else if (method === 'convo.watch') {
      const res = await handleConvoWatch(client, params);
      reply(true, res, null);
    } else {
      reply(false, null, 'method_not_supported');
    }
  } catch (err) {
    reply(false, null, String(err?.code || err?.message || err || 'rpc_error'));
  }
}

function safeUnlinkSocket(sockPath) {
  try {
    const lst = fs.lstatSync(sockPath);
    if (lst.isSocket()) {
      fs.rmSync(sockPath, { force: true });
    }
  } catch {}
}

function createUdsServer(sockPath, remoteDir) {
  try {
    const lst = fs.lstatSync(sockPath);
    if (lst.isSocket()) {
      fs.rmSync(sockPath, { force: true });
    } else {
      throw new Error(`refusing_to_unlink_non_socket:${sockPath}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const parentDir = path.dirname(sockPath);
  if (parentDir === remoteDir || isPathInsideDir(remoteDir, sockPath)) {
    ensureRemoteDir(parentDir);
  } else {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const server = net.createServer((client) => {
    if (!bridgeState) {
      client.destroy();
      return;
    }
    bridgeState.clients.set(client, new Set());
    let buf = Buffer.alloc(0);

    client.on('data', (chunk) => {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length + piece.length > MAX_UDS_LINE_BYTES) {
        client.destroy();
        return;
      }
      buf = buf.length === 0 ? piece : Buffer.concat([buf, piece]);
      let nlIdx;
      while ((nlIdx = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nlIdx).toString('utf8').trim();
        buf = buf.subarray(nlIdx + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        dispatchUdsRpc(client, req).catch(() => {});
      }
    });

    const cleanup = () => {
      releaseClientWatches(client)
        .catch(() => {})
        .finally(() => {
          bridgeState?.clients.delete(client);
        });
    };
    client.on('close', cleanup);
    client.on('error', cleanup);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {}
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function stopGatewayChildSync() {
  if (!bridgeState?.gatewayChild) return;
  const child = bridgeState.gatewayChild;
  bridgeState.gatewayChild = null;
  if (bridgeState.restartTimer) {
    clearTimeout(bridgeState.restartTimer);
    bridgeState.restartTimer = 0;
  }
  try {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM');
    }
  } catch {}
}

async function stopGatewayChildGracefully() {
  if (!bridgeState?.gatewayChild) return;
  const child = bridgeState.gatewayChild;
  bridgeState.gatewayChild = null;
  if (bridgeState.restartTimer) {
    clearTimeout(bridgeState.restartTimer);
    bridgeState.restartTimer = 0;
  }
  if (child.killed || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    child.once('exit', finish);
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish();
    }, 3000);
    killTimer.unref?.();
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}

function readRemoteConfigSig(configFile) {
  try {
    return fs.readFileSync(configFile, 'utf8');
  } catch {
    return '';
  }
}

function reconcileGatewayProcess() {
  if (!bridgeState || bridgeState.shuttingDown) return;
  const rawConfig = readRemoteConfigSig(bridgeState.paths.configFile);
  let cfg = DEFAULT_REMOTE_CONFIG;
  if (rawConfig) {
    try {
      const parsed = JSON.parse(rawConfig);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
    } catch {}
  }
  const enabled = Boolean(cfg && cfg.enabled === true);
  const gatewayScript = bridgeState.gatewayScript;

  if (!enabled || !fs.existsSync(gatewayScript)) {
    bridgeState.lastConfigRaw = rawConfig;
    if (bridgeState.gatewayChild) {
      stopGatewayChildGracefully().catch(() => {});
    }
    bridgeState.backoffIdx = 0;
    return;
  }

  if (bridgeState.gatewayChild && bridgeState.lastConfigRaw && rawConfig !== bridgeState.lastConfigRaw) {
    bridgeState.lastConfigRaw = rawConfig;
    bridgeState.backoffIdx = 0;
    stopGatewayChildGracefully()
      .then(() => reconcileGatewayProcess())
      .catch(() => {});
    return;
  }

  if (bridgeState.gatewayChild || bridgeState.restartTimer) return;
  bridgeState.lastConfigRaw = rawConfig;

  try {
    const child = fork(gatewayScript, [], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MAGA_REMOTE_STATE_DIR: bridgeState.paths.remoteDir,
        MAGA_REMOTE_SOCK_PATH: bridgeState.paths.sockPath
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    const startedAt = Date.now();
    bridgeState.gatewayChild = child;

    child.once('exit', () => {
      if (!bridgeState || bridgeState.gatewayChild !== child) return;
      bridgeState.gatewayChild = null;
      if (bridgeState.shuttingDown) return;
      const latest = readJsonOrFallback(bridgeState.paths.configFile, DEFAULT_REMOTE_CONFIG);
      if (!latest || latest.enabled !== true) {
        bridgeState.backoffIdx = 0;
        return;
      }
      if (Date.now() - startedAt > 10000) bridgeState.backoffIdx = 0;
      const delay = GATEWAY_RESTART_BACKOFF_MS[Math.min(bridgeState.backoffIdx, GATEWAY_RESTART_BACKOFF_MS.length - 1)];
      bridgeState.backoffIdx += 1;
      bridgeState.restartTimer = setTimeout(() => {
        if (!bridgeState) return;
        bridgeState.restartTimer = 0;
        reconcileGatewayProcess();
      }, delay);
      bridgeState.restartTimer.unref?.();
    });
  } catch (err) {
    console.warn(`[Anti-Claude RemoteBridge] Failed to fork gateway: ${err?.message || err}`);
  }
}

function handleTapBindingEvent(parsed, entry) {
  if (!bridgeState || !parsed || typeof parsed !== 'object') return;
  const kind = parsed.kind;
  if (kind !== 'summaries' && kind !== 'stream' && kind !== 'host_status') return;
  let data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  if (kind === 'summaries' && Array.isArray(data.changed)) {
    data = {
      ...data,
      changed: data.changed.map((c) => ({
        ...c,
        waitingSteps: normalizeWaitingStepsWithSha(c.id, c.waitingSteps)
      }))
    };
  }
  broadcastTapEvent(kind, data);
}

function readProcessCommandLineAsync(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (raw) return resolve(raw.replace(/\0+/g, ' ').trim());
      } catch {}
    }
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: 1500 },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim())
      );
      return;
    }
    execFile('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1500 }, (err, stdout) =>
      resolve(err ? '' : String(stdout || '').trim())
    );
  });
}

async function reclaimOrphanGateway(remoteDir) {
  const pidFile = path.join(remoteDir, 'gateway.pid');
  const pidObj = readJsonOrFallback(pidFile, null);
  const pid = Number(pidObj?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  const cmd = await readProcessCommandLineAsync(pid);
  if (!cmd || !/remote[\\/]+gateway[\\/]+server\.mjs/i.test(cmd)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

async function retryTapIfNeeded() {
  if (!bridgeState || bridgeState.shuttingDown || !bridgeState.tapDesiredActive) return;
  if (Date.now() < bridgeState.tapRetryNextAt) return;
  const hosts = getConfirmedHostEntries();
  if (hosts.length === 0) return;

  const target =
    (bridgeState.activeTapTargetId && hosts.find((e) => e.id === bridgeState.activeTapTargetId)) ||
    (await resolvePrimaryHostEntry());
  if (!target) return;

  const capRes = await evalOnHost(
    target,
    'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null',
    2500
  );
  const cap = capRes.ok && capRes.value && typeof capRes.value === 'object' ? capRes.value : null;
  if (cap?.tapActive) {
    bridgeState.tapActive = true;
    bridgeState.activeTapTargetId = target.id;
    bridgeState.tapRetryBackoffMs = 2000;
    bridgeState.tapRetryNextAt = 0;
    return;
  }

  const ok = await applyTapStateToHost(target, true);
  if (ok) {
    bridgeState.tapActive = true;
    bridgeState.activeTapTargetId = target.id;
    bridgeState.tapRetryBackoffMs = 2000;
    bridgeState.tapRetryNextAt = 0;
    broadcastTapEvent('host_status', {
      hostAttached: true,
      hostCount: hosts.length,
      tapActive: true
    });
  } else {
    bridgeState.tapActive = false;
    const backoff = Math.min(10000, bridgeState.tapRetryBackoffMs || 2000);
    bridgeState.tapRetryNextAt = Date.now() + backoff;
    bridgeState.tapRetryBackoffMs = Math.min(10000, backoff * 2);
  }
}

export async function initRemoteBridge({ env = process.env, gatewayScript } = {}) {
  if (bridgeState) return bridgeState;
  const paths = resolveRemotePaths(env);
  ensureRemoteDir(paths.remoteDir);
  await reclaimOrphanGateway(paths.remoteDir);

  const udsServer = await createUdsServer(paths.sockPath, paths.remoteDir);

  bridgeState = {
    paths,
    gatewayScript: gatewayScript || path.join(REPO_ROOT, 'remote', 'gateway', 'server.mjs'),
    udsServer,
    clients: new Map(),
    watchedStreams: new Map(),
    tapDesiredActive: false,
    tapActive: false,
    tapRetryNextAt: 0,
    tapRetryBackoffMs: 2000,
    activeTapTargetId: null,
    gatewayChild: null,
    lastConfigRaw: '',
    restartTimer: 0,
    backoffIdx: 0,
    pollTimer: null,
    pollInFlight: false,
    lastHostAttached: getConfirmedHostEntries().length > 0,
    shuttingDown: false
  };

  runtimeState.onRemoteTapEvent = handleTapBindingEvent;
  runtimeState.onHostTargetInjected = (entry) => {
    if (!bridgeState) return;
    const hosts = getConfirmedHostEntries();
    const attached = hosts.length > 0;
    if (attached !== bridgeState.lastHostAttached) {
      bridgeState.lastHostAttached = attached;
      broadcastTapEvent('host_status', {
        hostAttached: attached,
        hostCount: hosts.length,
        tapActive: bridgeState.tapActive
      });
    }
    if (bridgeState.tapDesiredActive && entry?.hostConfirmed && entry.type === 'page') {
      if (!bridgeState.activeTapTargetId || bridgeState.activeTapTargetId === entry.id) {
        bridgeState.activeTapTargetId = entry.id;
        applyTapStateToHost(entry, true)
          .then((ok) => {
            if (!bridgeState) return;
            bridgeState.tapActive = Boolean(ok);
            if (ok) {
              bridgeState.tapRetryBackoffMs = 2000;
              bridgeState.tapRetryNextAt = 0;
              broadcastTapEvent('host_status', {
                hostAttached: true,
                hostCount: getConfirmedHostEntries().length,
                tapActive: true
              });
            } else {
              bridgeState.tapRetryBackoffMs = 2000;
              bridgeState.tapRetryNextAt = Date.now() + 2000;
            }
          })
          .catch(() => {});
      }
    }
  };
  runtimeState.onHostTargetClosed = (closedEntry) => {
    if (!bridgeState) return;
    if (closedEntry?.id && bridgeState.activeTapTargetId === closedEntry.id) {
      bridgeState.activeTapTargetId = null;
      bridgeState.tapActive = false;
    }
    const hosts = getConfirmedHostEntries();
    const count = hosts.length;
    const attached = count > 0;
    if (attached !== bridgeState.lastHostAttached) {
      bridgeState.lastHostAttached = attached;
      broadcastTapEvent('host_status', {
        hostAttached: attached,
        hostCount: count,
        tapActive: attached ? bridgeState.tapActive : false
      });
    }
    if (bridgeState.tapDesiredActive && !bridgeState.activeTapTargetId && attached) {
      resolvePrimaryHostEntry()
        .then((nextPrimary) => {
          if (!bridgeState || !nextPrimary) return;
          bridgeState.activeTapTargetId = nextPrimary.id;
          return applyTapStateToHost(nextPrimary, true).then((ok) => {
            if (bridgeState) bridgeState.tapActive = Boolean(ok);
          });
        })
        .catch(() => {});
    }
  };

  reconcileGatewayProcess();

  bridgeState.pollTimer = setInterval(() => {
    if (!bridgeState || bridgeState.shuttingDown || bridgeState.pollInFlight) return;
    bridgeState.pollInFlight = true;
    Promise.resolve()
      .then(async () => {
        reconcileGatewayProcess();
        await retryTapIfNeeded();
      })
      .catch(() => {})
      .finally(() => {
        if (bridgeState) bridgeState.pollInFlight = false;
      });
  }, 2000);
  bridgeState.pollTimer.unref?.();

  return bridgeState;
}

export function shutdownRemoteBridgeSync() {
  if (!bridgeState) return;
  bridgeState.shuttingDown = true;
  if (bridgeState.pollTimer) {
    clearInterval(bridgeState.pollTimer);
    bridgeState.pollTimer = null;
  }
  stopGatewayChildSync();
  for (const client of Array.from(bridgeState.clients.keys())) {
    try {
      client.destroy();
    } catch {}
  }
  bridgeState.clients.clear();
  try {
    bridgeState.udsServer?.close();
  } catch {}
  safeUnlinkSocket(bridgeState.paths.sockPath);
  runtimeState.onRemoteTapEvent = null;
  runtimeState.onHostTargetInjected = null;
  runtimeState.onHostTargetClosed = null;
  bridgeState = null;
}

export async function shutdownRemoteBridge() {
  if (!bridgeState) return;
  const state = bridgeState;
  state.shuttingDown = true;
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.tapActive) {
    await setTapActive(false).catch(() => {});
  }
  await stopGatewayChildGracefully();
  for (const client of Array.from(state.clients.keys())) {
    try {
      client.destroy();
    } catch {}
  }
  state.clients.clear();
  if (state.udsServer) {
    await new Promise((resolve) => {
      try {
        state.udsServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  safeUnlinkSocket(state.paths.sockPath);
  runtimeState.onRemoteTapEvent = null;
  runtimeState.onHostTargetInjected = null;
  runtimeState.onHostTargetClosed = null;
  if (bridgeState === state) bridgeState = null;
}
