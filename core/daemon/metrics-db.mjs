/**
 * 4. Read-Only SQLite & Protobuf Conversation Metrics Engine
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DB_FILE_RE,
  DatabaseSync,
  UUID_RE,
  isUncPath,
  setBounded
} from './env.mjs';
import { getActiveConfig } from './prefs-bundle.mjs';

function parseProto(buf) {
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf || []);
  const out = new Map();
  let pos = 0;
  const len = bytes.length;

  const readVarint = () => {
    let result = 0;
    let shift = 0;
    while (pos < len) {
      const b = bytes[pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 53) {
        while (pos < len && (bytes[pos++] & 0x80) !== 0) {}
        return result;
      }
    }
    return result;
  };

  while (pos < len) {
    const tag = readVarint();
    if (!tag) break;
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 0) {
      out.set(fieldNo, readVarint());
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const subLen = readVarint();
      if (subLen < 0 || pos + subLen > len) break;
      out.set(fieldNo, bytes.subarray(pos, pos + subLen));
      pos += subLen;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return out;
}

function readUtf8(val) {
  if (!(val instanceof Uint8Array)) return '';
  return Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('utf8');
}

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtNum(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function formatContextCeiling(tokens) {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

function getDbStatByPath(dbPath) {
  try {
    const st = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (!st) return null;
    const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const walSig = wst ? `${wst.size}:${Math.floor(wst.mtimeMs)}` : '0:0';
    return {
      dbPath,
      mtimeMs: Math.max(st.mtimeMs, wst ? wst.mtimeMs : 0),
      sig: `${st.size}:${Math.floor(st.mtimeMs)}|${walSig}`
    };
  } catch {
    return null;
  }
}

let tmpSeq = 0;
function withReadOnlyDb(dbPath, timeoutMs, fn) {
  if (!isUncPath(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutMs });
    try {
      return fn(db);
    } finally {
      try {
        db.close();
      } catch {}
    }
  }
  tmpSeq = (tmpSeq + 1) % 100000;
  const tmpBase = path.join(os.tmpdir(), `ac-wsl-sqlite-${process.pid}-${Date.now()}-${tmpSeq}.db`);
  let tmpDb = null;
  try {
    fs.copyFileSync(dbPath, tmpBase);
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      try {
        fs.copyFileSync(walPath, `${tmpBase}-wal`);
      } catch {}
    }
    tmpDb = new DatabaseSync(tmpBase, { readOnly: true, timeout: timeoutMs });
    return fn(tmpDb);
  } finally {
    try {
      tmpDb?.close();
    } catch {}
    for (const sfx of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(`${tmpBase}${sfx}`, { force: true });
      } catch {}
    }
  }
}

function parseGenMetadataRow(r) {
  const top = parseProto(r.data);
  const chatRaw = top.get(1);
  const chat = chatRaw instanceof Uint8Array ? parseProto(chatRaw) : new Map();
  const usageRaw = chat.get(4);
  const usage = usageRaw instanceof Uint8Array ? parseProto(usageRaw) : new Map();
  const chatStartRaw = chat.get(9);
  const chatStart = chatStartRaw instanceof Uint8Array ? parseProto(chatStartRaw) : new Map();
  const ctxWinRaw = chatStart.get(10);
  const ctxWin = ctxWinRaw instanceof Uint8Array ? parseProto(ctxWinRaw) : new Map();
  const maxCtx = ctxWin.get(4) || 0;
  const ttftRaw = chat.get(11);
  const ttftMap = ttftRaw instanceof Uint8Array ? parseProto(ttftRaw) : new Map();
  const streamRaw = chat.get(12);
  const streamMap = streamRaw instanceof Uint8Array ? parseProto(streamRaw) : new Map();

  const inTok = usage.get(2) || 0;
  const outTok = usage.get(3) || 0;
  const cacheRead = usage.get(5) || 0;
  const thinkTok = usage.get(9) || 0;
  const respTok = usage.get(10) || 0;
  const ttft = (ttftMap.get(1) || 0) + (ttftMap.get(2) || 0) / 1e9;
  const stream = (streamMap.get(1) || 0) + (streamMap.get(2) || 0) / 1e9;

  return {
    idx: r.idx,
    inTok,
    outTok,
    cacheRead,
    ctx: inTok + cacheRead,
    maxCtx,
    thinkTok,
    respTok,
    ttft,
    stream,
    totDur: ttft + stream
  };
}

const lineageCacheByDir = new Map();
const summaryLineageCache = new Map();
const childScalarCache = new Map();
const metricsPayloadCache = new Map();

function readSummaryParentEdges(conversationsDir) {
  if (!DatabaseSync || !conversationsDir) return new Map();
  const sumDbPath = path.join(path.dirname(conversationsDir), 'conversation_summaries.db');
  const info = getDbStatByPath(sumDbPath);
  if (!info) return new Map();
  const cached = summaryLineageCache.get(sumDbPath);
  if (cached && cached.sig === info.sig) return cached.byParent;
  try {
    const byParent = withReadOnlyDb(sumDbPath, 30, (db) => {
      const map = new Map();
      const rows = db
        .prepare(
          "SELECT conversation_id, parent_conversation_id FROM conversation_summaries WHERE parent_conversation_id IS NOT NULL AND parent_conversation_id != ''"
        )
        .all();
      for (const row of rows) {
        const cid = String(row.conversation_id || '').trim();
        const pid = String(row.parent_conversation_id || '').trim();
        if (!cid || !pid || cid === pid) continue;
        let s = map.get(pid);
        if (!s) {
          s = new Set();
          map.set(pid, s);
        }
        s.add(cid);
      }
      return map;
    });
    setBounded(summaryLineageCache, sumDbPath, { sig: info.sig, byParent }, 16);
    return byParent;
  } catch {
    return cached?.byParent || new Map();
  }
}

function getDescendantIds(cascadeId, conversationsDir) {
  if (!DatabaseSync || !conversationsDir) return [];
  let dirState = lineageCacheByDir.get(conversationsDir);
  if (!dirState) {
    dirState = { dirMtimeMs: -1, nodes: new Map() };
    lineageCacheByDir.set(conversationsDir, dirState);
  }
  const st = fs.statSync(conversationsDir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return [];

  if (st.mtimeMs !== dirState.dirMtimeMs) {
    let entries = [];
    try {
      entries = fs.readdirSync(conversationsDir);
    } catch {
      return [];
    }
    const seen = new Set();
    let opens = 0;
    for (const name of entries) {
      const m = name.match(DB_FILE_RE);
      if (!m) continue;
      const uuid = m[1];
      seen.add(uuid);
      const existing = dirState.nodes.get(uuid);
      if (existing?.hasMeta) continue;
      const dbPath = path.join(conversationsDir, name);
      const info = getDbStatByPath(dbPath);
      if (!info || (existing && existing.sig === info.sig)) continue;
      if (opens >= 20) continue;
      opens += 1;
      try {
        const metaRes = withReadOnlyDb(dbPath, 20, (db) => {
          const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
          if (!row?.data) return { hasMeta: false, parentId: '', rootId: '' };
          const meta = parseProto(row.data);
          return {
            hasMeta: true,
            parentId: readUtf8(meta.get(5)).trim(),
            rootId: readUtf8(meta.get(6)).trim()
          };
        });
        dirState.nodes.set(uuid, { ...metaRes, sig: info.sig });
      } catch {
        dirState.nodes.set(uuid, { hasMeta: false, parentId: '', rootId: '', sig: info.sig });
      }
    }
    for (const id of Array.from(dirState.nodes.keys())) {
      if (!seen.has(id)) dirState.nodes.delete(id);
    }
    if (opens < 20) dirState.dirMtimeMs = st.mtimeMs;
  }

  const byParent = new Map();
  const direct = new Set();
  for (const [uuid, node] of dirState.nodes.entries()) {
    if (node.parentId) {
      let s = byParent.get(node.parentId);
      if (!s) {
        s = new Set();
        byParent.set(node.parentId, s);
      }
      s.add(uuid);
    }
    if (node.rootId === cascadeId && uuid !== cascadeId) direct.add(uuid);
  }
  const summaryEdges = readSummaryParentEdges(conversationsDir);
  for (const [pid, childSet] of summaryEdges.entries()) {
    let s = byParent.get(pid);
    if (!s) {
      s = new Set();
      byParent.set(pid, s);
    }
    for (const cid of childSet) {
      if (cid !== pid) s.add(cid);
    }
  }
  const hasChildDb = (id) => dirState.nodes.has(id) || fs.existsSync(path.join(conversationsDir, `${id}.db`));
  const pSet = byParent.get(cascadeId);
  if (pSet) for (const id of pSet) if (id !== cascadeId && hasChildDb(id)) direct.add(id);

  const queue = Array.from(direct);
  const visited = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const next = byParent.get(queue[i]);
    if (!next) continue;
    for (const id of next) {
      if (id !== cascadeId && !visited.has(id) && hasChildDb(id)) {
        visited.add(id);
        queue.push(id);
      }
    }
  }
  return queue.sort();
}

function readChildMetrics(childId, conversationsDir) {
  const dbPath = path.join(conversationsDir, `${childId}.db`);
  const info = getDbStatByPath(dbPath);
  if (!info) return null;
  const cached = childScalarCache.get(dbPath);
  if (cached && cached.sig === info.sig) return cached;
  try {
    const entry = withReadOnlyDb(dbPath, 30, (db) => {
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      let calls = 0;
      let totalIn = 0;
      let totalCache = 0;
      let totalOut = 0;
      for (let i = 0; i < rows.length; i++) {
        const p = parseGenMetadataRow(rows[i]);
        if (p.ctx > 0 || p.outTok > 0) {
          calls += 1;
          totalIn += p.inTok;
          totalCache += p.cacheRead;
          totalOut += p.outTok;
        }
      }
      return { sig: info.sig, hasData: calls > 0, calls, totalIn, totalCache, totalOut };
    });
    setBounded(childScalarCache, dbPath, entry, 256);
    return entry;
  } catch {
    return cached || null;
  }
}

function readSubagentSummaries(descendantIds, conversationsDir) {
  if (!DatabaseSync || !Array.isArray(descendantIds) || !descendantIds.length || !conversationsDir) return [];
  const sumDbPath = path.join(path.dirname(conversationsDir), 'conversation_summaries.db');
  const info = getDbStatByPath(sumDbPath);
  if (!info) return [];
  const ids = descendantIds.slice(0, 40).filter((id) => UUID_RE.test(String(id || '')));
  if (!ids.length) return [];
  try {
    return withReadOnlyDb(sumDbPath, 30, (db) => {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT conversation_id, title, agent_name, status, not_fully_idle, killed, last_modified_time FROM conversation_summaries WHERE conversation_id IN (${placeholders})`
        )
        .all(...ids);
      return rows.map((row) => ({
        id: String(row.conversation_id || ''),
        title: String(row.title || '').trim(),
        agentName: String(row.agent_name || '').trim(),
        status: String(row.status || '').trim(),
        running: Boolean(
          row &&
            !Number(row.killed) &&
            (Number(row.not_fully_idle) === 1 || /RUNNING|IN_PROGRESS|ACTIVE/i.test(String(row.status || '')))
        ),
        killed: Boolean(Number(row.killed)),
        lastModifiedTime: String(row.last_modified_time || '')
      }));
    });
  } catch {
    return [];
  }
}

export function parseConversationMetrics(cascadeId, conversationsDir) {
  if (!DatabaseSync || !cascadeId || !UUID_RE.test(cascadeId) || !conversationsDir) return null;
  const dbPath = path.join(conversationsDir, `${cascadeId}.db`);
  const statInfo = getDbStatByPath(dbPath);
  if (!statInfo) return { cascadeId, hasData: false };

  const activeConfig = getActiveConfig();
  const descendantIds = getDescendantIds(cascadeId, conversationsDir);
  const childSigParts = [];
  for (const cid of descendantIds) {
    const cs = getDbStatByPath(path.join(conversationsDir, `${cid}.db`));
    childSigParts.push(`${cid}=${cs ? cs.sig : '0'}`);
  }
  const sumDbStat =
    descendantIds.length > 0
      ? getDbStatByPath(path.join(path.dirname(conversationsDir), 'conversation_summaries.db'))
      : null;
  const compositeSig = `${statInfo.sig}|c:${childSigParts.join(',')}|s:${sumDbStat ? sumDbStat.sig : '0'}|lim:${activeConfig.contextLimitOverride || activeConfig.contextLimit}`;

  const cached = metricsPayloadCache.get(dbPath);
  if (cached && cached.sig === compositeSig) return cached.payload;

  try {
    const dbRes = withReadOnlyDb(dbPath, 150, (db) => {
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      if (!rows.length) return { empty: true };
      const userStat = db
        .prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS lastIdx FROM steps WHERE step_type = 14')
        .get();
      const lastUserIdx = userStat?.lastIdx ?? -1;
      const userStepsCount = userStat?.cnt ?? 0;
      const turnStat = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 15 AND idx > ?').get(lastUserIdx);
      const rawTurnSteps = turnStat?.cnt ?? 0;
      return { empty: false, rows, userStepsCount, rawTurnSteps };
    });

    if (dbRes.empty) {
      const emptyPayload = { cascadeId, hasData: false, sig: compositeSig };
      setBounded(metricsPayloadCache, dbPath, { sig: compositeSig, payload: emptyPayload }, 64);
      return emptyPayload;
    }

    const valid = [];
    let totalIn = 0;
    let totalCache = 0;
    let totalOut = 0;
    let totalThink = 0;
    let totalResp = 0;
    for (const r of dbRes.rows) {
      const p = parseGenMetadataRow(r);
      totalIn += p.inTok;
      totalCache += p.cacheRead;
      totalOut += p.outTok;
      totalThink += p.thinkTok;
      totalResp += p.respTok;
      if (p.ctx > 0 || p.outTok > 0) valid.push(p);
    }

    if (!valid.length) {
      const emptyPayload = { cascadeId, hasData: false, sig: compositeSig };
      setBounded(metricsPayloadCache, dbPath, { sig: compositeSig, payload: emptyPayload }, 64);
      return emptyPayload;
    }

    let childCount = 0;
    let childCalls = 0;
    let childIn = 0;
    let childCache = 0;
    let childOut = 0;
    for (const cid of descendantIds) {
      const cm = readChildMetrics(cid, conversationsDir);
      if (!cm?.hasData) continue;
      childCount += 1;
      childCalls += cm.calls;
      childIn += cm.totalIn;
      childCache += cm.totalCache;
      childOut += cm.totalOut;
    }

    const turnSlice = dbRes.rawTurnSteps > 0 ? valid.slice(-dbRes.rawTurnSteps) : [];
    const turnSteps = turnSlice.length;
    let turnOut = 0;
    let turnThink = 0;
    let turnResp = 0;
    let turnDur = 0;
    for (const s of turnSlice) {
      turnOut += s.outTok;
      turnThink += s.thinkTok;
      turnResp += s.respTok;
      turnDur += s.totDur;
    }

    const last = valid[valid.length - 1];
    const contextLimitTokens =
      activeConfig.contextLimitOverride > 0
        ? activeConfig.contextLimitOverride
        : last.maxCtx > 0
          ? last.maxCtx
          : activeConfig.contextLimit || 256000;
    const limitStr = formatContextCeiling(contextLimitTokens);

    const rawStreamTps = last.stream >= 0.5 ? last.outTok / last.stream : 0;
    const e2eTps = last.totDur > 0 ? last.outTok / last.totDur : 0;
    const streamRatio = last.totDur > 0 ? last.stream / last.totDur : 0;
    const useStream =
      rawStreamTps > 0 &&
      rawStreamTps <= 600 &&
      (streamRatio >= 0.15 || (last.stream >= 2.0 && rawStreamTps <= 250));
    const displayTps = useStream ? rawStreamTps : e2eTps;
    const ctxPct = Math.round((last.ctx / contextLimitTokens) * 100);
    const ctxClass = ctxPct >= 90 ? 'ag-ctx-crit' : ctxPct >= 75 ? 'ag-ctx-warn' : 'ag-ctx-ok';
    const lastCacheRate = last.ctx > 0 ? ((last.cacheRead / last.ctx) * 100).toFixed(1) : '0.0';
    const sessionCacheRate = totalIn + totalCache > 0 ? ((totalCache / (totalIn + totalCache)) * 100).toFixed(1) : '0.0';
    const remainCtx = Math.max(0, contextLimitTokens - last.ctx);

    const subInlineHtml =
      childCount > 0 ? `<span class="ag-sep">·</span><span class="ag-sub-badge">+${childCount} sub</span>` : '';
    const inlineHtml = [
      `<span>${Math.round(displayTps)} tok/s</span>`,
      `<span class="ag-sep">·</span>`,
      `<span>${useStream ? 'TTFT' : 'Hold'} ${last.ttft.toFixed(1)}s</span>`,
      `<span class="ag-sep">·</span>`,
      `<span>Ctx ${fmtTok(last.ctx)}/${limitStr} <span class="${ctxClass}">(${ctxPct}%)</span></span>`,
      `<span class="ag-sep">·</span>`,
      `<span>Out ${fmtTok(last.outTok)}</span>`,
      subInlineHtml
    ].join('');

    const turnRowHtml =
      turnSteps > 1
        ? `<div class="ag-tt-row"><span class="ag-tt-lbl">本轮合计 (${turnSteps}步)</span><span class="ag-tt-val">输出 ${fmtNum(turnOut)} (思考 ${fmtNum(turnThink)} + 响应 ${fmtNum(turnResp)}) | 耗时 ${turnDur.toFixed(1)}s</span></div>`
        : '';
    const subRowHtml =
      childCount > 0
        ? `<div class="ag-tt-row"><span class="ag-tt-lbl">子 Agent (${childCount})</span><span class="ag-tt-val">${childCalls} 次 · 新增 ${fmtTok(childIn)} + 缓存 ${fmtTok(childCache)} · 输出 ${fmtTok(childOut)}</span></div>`
        : '';
    const combinedOut = totalOut + childOut;
    const outputRowHtml =
      childCount > 0
        ? `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 ${fmtTok(combinedOut)} (主 ${fmtTok(totalOut)} + 子 ${fmtTok(childOut)})</span></div>`
        : `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 ${fmtTok(totalOut)} (思考链 ${fmtTok(totalThink)} + 正文/工具 ${fmtTok(totalResp)})</span></div>`;

    const tooltipHtml = [
      `<div class="ag-tt-hdr">本轮最新调用 (Gen #${last.idx + 1})</div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">${useStream ? `流式 ${rawStreamTps.toFixed(1)} tok/s | ` : ''}端到端（含等待） ${e2eTps.toFixed(1)} tok/s</span></div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">${useStream ? `TTFT ${last.ttft.toFixed(2)}s | 流式 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s` : `等待 ${last.ttft.toFixed(2)}s | 刷出 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s`}</span></div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">当前上下文</span><span class="ag-tt-val">${fmtNum(last.ctx)} (新增 ${fmtNum(last.inTok)} + 缓存 ${fmtNum(last.cacheRead)}, ${lastCacheRate}%)</span></div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">本步输出量</span><span class="ag-tt-val">${fmtNum(last.outTok)} (思考链 ${fmtNum(last.thinkTok)} + 正文/工具 ${fmtNum(last.respTok)})</span></div>`,
      turnRowHtml,
      `<div class="ag-tt-hdr ag-tt-sec">当前会话累计 (${dbRes.userStepsCount} 轮提问 / ${valid.length} 次有效调用)</div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">压缩水位线</span><span class="ag-tt-val">${fmtTok(last.ctx)} / ${limitStr} (${ctxPct}%) · 距压缩余 ${fmtTok(remainCtx)}</span></div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输入量</span><span class="ag-tt-val">新增 ${fmtTok(totalIn)} + 缓存读取 ${fmtTok(totalCache)} (命中率 ${sessionCacheRate}%)</span></div>`,
      subRowHtml,
      outputRowHtml
    ].join('');

    const subSummaryMap = new Map(readSubagentSummaries(descendantIds, conversationsDir).map((s) => [s.id, s]));
    const children = descendantIds.slice(0, 24).map((cid) => {
      const cm = readChildMetrics(cid, conversationsDir);
      const sm = subSummaryMap.get(cid);
      return {
        id: cid,
        title: sm?.title || '',
        agentName: sm?.agentName || '',
        status: sm?.status || '',
        running: Boolean(sm?.running),
        killed: Boolean(sm?.killed),
        calls: cm?.calls || 0,
        outTok: cm?.totalOut || 0
      };
    });
    const stats = {
      ctx: last.ctx,
      cached: last.cacheRead,
      uncached: last.inTok,
      limit: contextLimitTokens,
      limitStr,
      remain: remainCtx,
      pct: ctxPct,
      lastCacheRate: Number(lastCacheRate),
      sessionCacheRate: Number(sessionCacheRate),
      turns: dbRes.userStepsCount,
      calls: valid.length,
      totalThink,
      totalResp,
      totalOut,
      childCount,
      childCalls,
      children
    };

    const metrics = {
      displayTps,
      rawStreamTps,
      e2eTps,
      useStream,
      ttft: last.ttft,
      streamDur: last.stream,
      totDur: last.totDur,
      outTok: last.outTok,
      ctx: last.ctx,
      ctxLimit: contextLimitTokens,
      ctxLimitStr: limitStr,
      ctxRatioStr: `${fmtTok(last.ctx)} / ${limitStr}`,
      ctxPct,
      ctxClass,
      remainCtx,
      lastCacheRate: Number(lastCacheRate),
      sessionCacheRate: Number(sessionCacheRate),
      genIdx: last.idx + 1,
      turnSteps,
      turnOut,
      turnThink,
      turnResp,
      turnDur,
      totalIn,
      totalCache,
      totalThink,
      totalResp,
      totalOut,
      childCount,
      childCalls,
      childIn,
      childCache,
      childOut
    };

    const payload = { cascadeId, hasData: true, sig: compositeSig, inlineHtml, tooltipHtml, stats, metrics };
    setBounded(metricsPayloadCache, dbPath, { sig: compositeSig, payload }, 64);
    return payload;
  } catch {
    return { cascadeId, transientError: true, cachedPayload: cached?.payload || null };
  }
}
