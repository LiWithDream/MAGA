/**
 * Daemon-side Project Cockpit AI Suggestions Service:
 * - Stores Gemini API config locally in `project-suggestions-config.json` (0o600, never exported)
 * - Dehydrates recent project conversations (tail 64 KB of transcript.jsonl + .md artifacts + worktrees)
 * - Generates 3 cold-start context handoff suggestions via Gemini 3.8 Flash (`responseSchema` JSON)
 * - Caches per-project suggestions on disk keyed by deterministic context fingerprint
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANTIGRAVITY_BRAIN_DIR,
  PROJECT_SUGGESTIONS_CACHE_DIR,
  PROJECT_SUGGESTIONS_CONFIG_FILE,
  UUID_RE,
  readJsonOrFallback,
  writeAtomicUtf8,
} from '../../core/daemon/env.mjs';
import { resolveLocalProjectDir } from '../../core/daemon/projects.mjs';
import {
  CONV_WORKTREES_DIR,
  listRepoWorktreesAsync,
  loadConversationWorktreeMap,
  normalizeRealPath,
} from '../../core/daemon/worktrees.mjs';

export const DEFAULT_SUGGESTIONS_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
export const SUGGESTIONS_COOLDOWN_MS = 60_000;
export const SUGGESTIONS_TIMEOUT_MS = 18_000;
export const TRANSCRIPT_TAIL_BYTES = 65_536;

export const PROJECT_SUGGESTIONS_ACTIONS = new Set([
  'getProjectSuggestionsConfig',
  'saveProjectSuggestionsConfig',
  'testProjectSuggestionsConfig',
  'getProjectSuggestions',
]);

const MODEL_NAME_RE = /^[a-zA-Z0-9._:/-]{2,80}$/;
const inFlightByDir = new Map();

function sanitizeModelName(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || !MODEL_NAME_RE.test(s) || s.includes('..')) return DEFAULT_SUGGESTIONS_MODEL;
  return s;
}

function sanitizeBaseUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!s) return DEFAULT_GEMINI_BASE_URL;
  try {
    const u = new URL(s);
    const isLocalHttp =
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]');
    if (u.protocol !== 'https:' && !isLocalHttp) return DEFAULT_GEMINI_BASE_URL;
    const cleanPath = u.pathname.replace(/\/+$/, '');
    return `${u.origin}${cleanPath}`;
  } catch {
    return DEFAULT_GEMINI_BASE_URL;
  }
}

function maskApiKey(key) {
  const s = String(key || '').trim();
  if (!s) return '';
  if (s.length >= 8) return `${s.slice(0, 4)}••••${s.slice(-4)}`;
  return '••••';
}

function collapseText(raw, maxLen) {
  const clean = String(raw || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, Math.max(0, maxLen - 1))}…` : clean;
}

function cleanUserTranscriptContent(raw) {
  let s = String(raw || '');
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ');
  const unclosedMeta = s.indexOf('<ADDITIONAL_METADATA>');
  if (unclosedMeta !== -1) s = s.slice(0, unclosedMeta);
  s = s.replace(/<\/?USER_REQUEST>/gi, ' ');
  return collapseText(s, 180);
}

export function loadProjectSuggestionsConfig(opts = {}) {
  const configFile = opts.configFile || PROJECT_SUGGESTIONS_CONFIG_FILE;
  const env = opts.env || process.env;
  const raw = readJsonOrFallback(configFile, null);
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const storedApiKey = typeof src.apiKey === 'string' ? src.apiKey.trim() : '';
  const envApiKey = String(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim();
  const apiKey = storedApiKey || envApiKey;
  const apiKeySource = storedApiKey ? 'config' : envApiKey ? 'env' : 'none';

  return {
    schema: 1,
    updatedAt: Number(src.updatedAt) > 0 ? Math.floor(Number(src.updatedAt)) : 0,
    enabled: typeof src.enabled === 'boolean' ? src.enabled : true,
    autoRefresh: typeof src.autoRefresh === 'boolean' ? src.autoRefresh : true,
    model: sanitizeModelName(src.model),
    baseUrl: sanitizeBaseUrl(src.baseUrl),
    storedApiKey,
    apiKey,
    apiKeySource,
  };
}

export function getPublicProjectSuggestionsConfig(opts = {}) {
  const cfg = loadProjectSuggestionsConfig(opts);
  return {
    ok: true,
    enabled: cfg.enabled,
    autoRefresh: cfg.autoRefresh,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    hasApiKey: Boolean(cfg.apiKey),
    apiKeySource: cfg.apiKeySource,
    apiKeyMask: maskApiKey(cfg.apiKey),
  };
}

export function saveProjectSuggestionsConfig(payload = {}, opts = {}) {
  const configFile = opts.configFile || PROJECT_SUGGESTIONS_CONFIG_FILE;
  const cur = loadProjectSuggestionsConfig(opts);
  const src = payload && typeof payload === 'object' ? payload : {};

  let nextStoredKey = cur.storedApiKey;
  if (src.clearApiKey === true) {
    nextStoredKey = '';
  } else if (typeof src.apiKey === 'string' && src.apiKey.trim()) {
    nextStoredKey = src.apiKey.trim();
  }

  const nextDoc = {
    schema: 1,
    updatedAt: Date.now(),
    enabled: typeof src.enabled === 'boolean' ? src.enabled : cur.enabled,
    autoRefresh: typeof src.autoRefresh === 'boolean' ? src.autoRefresh : cur.autoRefresh,
    model: typeof src.model === 'string' && src.model.trim() ? sanitizeModelName(src.model) : cur.model,
    baseUrl: typeof src.baseUrl === 'string' && src.baseUrl.trim() ? sanitizeBaseUrl(src.baseUrl) : cur.baseUrl,
    apiKey: nextStoredKey,
  };

  writeAtomicUtf8(configFile, `${JSON.stringify(nextDoc, null, 2)}\n`);
  try {
    fs.chmodSync(configFile, 0o600);
  } catch {}

  return getPublicProjectSuggestionsConfig(opts);
}

export function readTranscriptTailSummary(convId, brainDir = ANTIGRAVITY_BRAIN_DIR, tailBytes = TRANSCRIPT_TAIL_BYTES) {
  const out = {
    size: 0,
    mtimeMs: 0,
    lastUserText: '',
    lastModelText: '',
    artifacts: [],
  };
  if (!convId || !UUID_RE.test(convId)) return out;

  const convBrainDir = path.join(brainDir, convId);
  const transcriptPath = path.join(convBrainDir, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    const st = fs.statSync(transcriptPath, { throwIfNoEntry: false });
    if (st && st.isFile() && st.size > 0) {
      out.size = st.size;
      out.mtimeMs = Math.floor(st.mtimeMs);
      const readLen = Math.min(st.size, Math.max(1024, tailBytes));
      const start = st.size - readLen;
      const buf = Buffer.alloc(readLen);
      const fd = fs.openSync(transcriptPath, 'r');
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fd, buf, 0, readLen, start);
      } finally {
        fs.closeSync(fd);
      }
      let text = buf.subarray(0, bytesRead).toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!rec || typeof rec !== 'object') continue;
        if (rec.source === 'USER' && typeof rec.content === 'string') {
          const cleaned = cleanUserTranscriptContent(rec.content);
          if (cleaned) out.lastUserText = cleaned;
        } else if (rec.source === 'MODEL' && rec.type === 'PLANNER_RESPONSE' && typeof rec.content === 'string') {
          const cleaned = collapseText(rec.content, 360);
          if (cleaned) out.lastModelText = cleaned;
        }
      }
    }
  } catch {}

  try {
    const entries = fs.readdirSync(convBrainDir, { withFileTypes: true });
    const mdFiles = [];
    for (const ent of entries) {
      if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
      const abs = path.join(convBrainDir, ent.name);
      const st = fs.statSync(abs, { throwIfNoEntry: false });
      if (st && st.isFile()) {
        mdFiles.push({ name: ent.name, path: abs, mtimeMs: Math.floor(st.mtimeMs) });
      }
    }
    mdFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    out.artifacts = mdFiles.slice(0, 3);
  } catch {}

  return out;
}

export async function collectProjectBriefAsync(
  { dirPath, chats = [], lang = 'en', model = DEFAULT_SUGGESTIONS_MODEL } = {},
  opts = {}
) {
  const resolveDir = opts.resolveDir || resolveLocalProjectDir;
  const absDir = resolveDir(dirPath);
  if (!absDir) return { ok: false, error: 'invalid_project_dir' };

  const brainDir = opts.brainDir || ANTIGRAVITY_BRAIN_DIR;
  const convWtDir = opts.convWtDir || CONV_WORKTREES_DIR;
  const normLang = String(lang || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';

  const validChats = (Array.isArray(chats) ? chats : [])
    .filter((c) => c && typeof c.id === 'string' && UUID_RE.test(c.id.trim()))
    .slice(0, 5)
    .map((c) => ({
      id: c.id.trim(),
      title: collapseText(c.title || '', 120),
      updatedAt: Number(c.updatedAt) > 0 ? Math.floor(Number(c.updatedAt)) : 0,
    }));

  const convWtMap = opts.convWorktreeMap || loadConversationWorktreeMap({ convWtDir });
  const convWtEntries = convWtMap?.entries || {};

  let wtListRes;
  if (Array.isArray(opts.worktrees)) {
    wtListRes = { ok: true, worktrees: opts.worktrees };
  } else {
    wtListRes = await listRepoWorktreesAsync(absDir, { force: false, includeStats: true, convWtDir }).catch(() => ({
      ok: false,
      worktrees: [],
    }));
  }

  let wsStatus = opts.wsStatus || null;
  if (!wsStatus) {
    if (typeof opts.readWorkspaceStatus === 'function') {
      wsStatus = await opts.readWorkspaceStatus(absDir, { force: false, convWtDir }).catch(() => null);
    } else {
      const { readProjectWorkspaceStatusAsync } = await import('../../core/daemon/overview-skills.mjs');
      wsStatus = await readProjectWorkspaceStatusAsync(absDir, { force: false, convWtDir }).catch(() => null);
    }
  }

  const activeWorktrees = (Array.isArray(wtListRes?.worktrees) ? wtListRes.worktrees : [])
    .filter((w) => w && !w.bare && !w.prunable)
    .map((w) => {
      const realPath = String(w.realPath || w.path || '').trim();
      const dirtyCount = Number(w.git?.changedFiles || 0);
      const ahead = Number(w.ahead || 0);
      return {
        path: realPath,
        branch: String(w.branch || '').trim(),
        isMain: Boolean(w.isMain),
        ahead,
        dirtyCount,
      };
    })
    .filter((w) => w.path);

  const conversations = validChats.map((c) => {
    const wtBind = convWtEntries[c.id] || null;
    const tail = readTranscriptTailSummary(c.id, brainDir, opts.tailBytes || TRANSCRIPT_TAIL_BYTES);
    return {
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      branch: String(wtBind?.branch || '').trim(),
      worktreePath: String(wtBind?.worktreePath || '').trim(),
      lastUserText: tail.lastUserText,
      lastModelText: tail.lastModelText,
      artifacts: tail.artifacts,
      _sig: [c.id, tail.size, tail.mtimeMs, String(wtBind?.branch || ''), tail.artifacts.map((a) => `${a.name}:${a.mtimeMs}`)],
    };
  });

  const git = wsStatus?.git
    ? {
        branch: String(wsStatus.git.branch || '').trim(),
        changedFiles: Number(wsStatus.git.changedFiles || 0),
        recentCommits: (Array.isArray(wsStatus.recentCommits) ? wsStatus.recentCommits : []).slice(0, 3).map((cm) => ({
          hash: String(cm.hash || '').trim(),
          subject: collapseText(cm.subject || '', 100),
          relTime: String(cm.relTime || '').trim(),
        })),
      }
    : null;

  const fpSource = {
    model: sanitizeModelName(model),
    lang: normLang,
    chats: conversations.map((c) => c._sig),
    git: git
      ? {
          branch: git.branch,
          changedFiles: git.changedFiles,
          commits: git.recentCommits.map((cm) => cm.hash),
        }
      : null,
    worktrees: activeWorktrees.map((w) => [w.branch, w.ahead, w.dirtyCount]),
  };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(fpSource)).digest('hex').slice(0, 20);

  return {
    ok: true,
    dirPath: absDir,
    projectName: path.basename(absDir),
    lang: normLang,
    fingerprint,
    activeWorktrees,
    git,
    conversations: conversations.map(({ _sig, ...rest }) => rest),
  };
}

function getCacheFilePath(dirPath, cacheDir = PROJECT_SUGGESTIONS_CACHE_DIR) {
  const hash = crypto.createHash('sha1').update(normalizeRealPath(dirPath)).digest('hex').slice(0, 16);
  return path.join(cacheDir, `${hash}.json`);
}

function mapGeminiHttpError(status, bodyText) {
  if (status === 401 || status === 403) return 'invalid_api_key';
  if (status === 429) return 'quota_exceeded';
  if (status === 404) return 'model_not_found';
  if (status === 400 && /api[_\s]?key/i.test(bodyText || '')) return 'invalid_api_key';
  return `http_${status || 500}`;
}

function sanitizeSuggestionsOutput(rawList, brief) {
  const validConvMap = new Map((brief.conversations || []).map((c) => [c.id, c]));
  const allowedWorktrees = new Map();
  const addAllowedWt = (p) => {
    if (!p || typeof p !== 'string') return;
    const norm = normalizeRealPath(p);
    if (!allowedWorktrees.has(norm)) allowedWorktrees.set(norm, p);
  };
  addAllowedWt(brief.dirPath);
  for (const w of brief.activeWorktrees || []) {
    addAllowedWt(w.path);
  }

  const allowedArtifactPaths = new Set();
  for (const c of brief.conversations || []) {
    for (const a of c.artifacts || []) {
      if (a?.path) allowedArtifactPaths.add(a.path);
    }
  }

  const out = [];
  for (const item of Array.isArray(rawList) ? rawList : []) {
    if (!item || typeof item !== 'object') continue;
    const label = collapseText(item.label, 48);
    const reason = collapseText(item.reason, 160);
    const prompt = String(item.prompt || '').replace(/\r\n/g, '\n').trim().slice(0, 1400);
    if (!label || !prompt) continue;

    const rawCid = typeof item.sourceConvId === 'string' ? item.sourceConvId.trim() : '';
    const sourceConvId = validConvMap.has(rawCid) ? rawCid : '';
    const sourceTitle = sourceConvId ? validConvMap.get(sourceConvId)?.title || '' : collapseText(item.sourceTitle, 80);

    const rawWt = typeof item.worktreePath === 'string' ? item.worktreePath.trim() : '';
    const matchedWt = rawWt ? allowedWorktrees.get(normalizeRealPath(rawWt)) || '' : '';

    const branch = collapseText(item.branch || '', 64);
    const anchorFiles = [];
    for (const f of Array.isArray(item.anchorFiles) ? item.anchorFiles : []) {
      if (typeof f !== 'string') continue;
      const trimmed = f.trim();
      if (!trimmed || trimmed.length > 220) continue;
      const isKnownArtifact = allowedArtifactPaths.has(trimmed);
      const isSafeRelative = !/^\/|^[a-zA-Z]:|\.\./.test(trimmed) && !/[\r\n\0]/.test(trimmed);
      if ((isKnownArtifact || isSafeRelative) && !anchorFiles.includes(trimmed)) {
        anchorFiles.push(trimmed);
        if (anchorFiles.length >= 4) break;
      }
    }

    out.push({
      label,
      reason,
      prompt,
      sourceConvId,
      sourceTitle,
      branch,
      worktreePath: matchedWt,
      anchorFiles,
    });
    if (out.length >= 3) break;
  }
  return out;
}

const SUGGESTIONS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['label', 'reason', 'prompt'],
        properties: {
          label: { type: 'STRING' },
          reason: { type: 'STRING' },
          prompt: { type: 'STRING' },
          sourceConvId: { type: 'STRING' },
          sourceTitle: { type: 'STRING' },
          branch: { type: 'STRING' },
          worktreePath: { type: 'STRING' },
          anchorFiles: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
        },
      },
    },
  },
};

export async function callGeminiSuggestions({
  brief,
  apiKey,
  model = DEFAULT_SUGGESTIONS_MODEL,
  baseUrl = DEFAULT_GEMINI_BASE_URL,
  lang = 'en',
  fetchImpl = globalThis.fetch,
  timeoutMs = SUGGESTIONS_TIMEOUT_MS,
} = {}) {
  if (!apiKey) return { ok: false, error: 'missing_api_key' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_unavailable' };

  const cleanModel = sanitizeModelName(model);
  const cleanBase = sanitizeBaseUrl(baseUrl);
  const url = `${cleanBase}/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
  const isZh = String(lang || '').toLowerCase().startsWith('zh');

  const systemText = [
    'You are a concise developer workspace assistant inside an AI coding IDE.',
    'Analyze the JSON snapshot of recent conversations, git status, active worktrees, and artifact files.',
    `Return exactly 3 actionable next-conversation suggestions in ${isZh ? 'Simplified Chinese (简体中文)' : 'English'}.`,
    'Rules:',
    `- "label": short pill button title (${isZh ? 'max 16 Chinese chars' : 'max 28 chars'}).`,
    '- "reason": 1 concise line citing which recent conversation, branch, or commit motivates this suggestion.',
    '- "prompt": a token-saving cold-start handoff brief (2-4 crisp sentences) naming the exact branch/worktree if applicable, 1-sentence established conclusion from the prior chat, key file/artifact paths, and the concrete next action so the new conversation skips exploratory turns.',
    '- Only set "sourceConvId" / "worktreePath" to exact values present in the input JSON (leave empty string if none applies).',
  ].join('\n');

  const compactInput = {
    projectName: brief.projectName,
    dirPath: brief.dirPath,
    git: brief.git,
    activeWorktrees: brief.activeWorktrees,
    recentConversations: (brief.conversations || []).map((c) => ({
      id: c.id,
      title: c.title,
      branch: c.branch,
      worktreePath: c.worktreePath,
      lastUser: c.lastUserText,
      lastAssistant: c.lastModelText,
      artifacts: (c.artifacts || []).map((a) => a.path),
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(compactInput) }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
          responseSchema: SUGGESTIONS_RESPONSE_SCHEMA,
        },
      }),
      signal: controller.signal,
    });

    const rawBody = await resp.text().catch(() => '');
    if (!resp.ok) {
      return {
        ok: false,
        error: mapGeminiHttpError(resp.status, rawBody),
        status: resp.status,
        detail: rawBody.slice(0, 240),
      };
    }

    let parsedResp;
    try {
      parsedResp = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: 'invalid_json_response' };
    }

    const candidateText =
      parsedResp?.candidates?.[0]?.content?.parts
        ?.map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .join('') || '';
    let parsedJson;
    try {
      parsedJson = JSON.parse(candidateText);
    } catch {
      return { ok: false, error: 'invalid_model_json' };
    }

    const suggestions = sanitizeSuggestionsOutput(parsedJson?.suggestions, brief);
    if (!suggestions.length) {
      return { ok: false, error: 'empty_suggestions' };
    }
    return {
      ok: true,
      suggestions,
      usage: parsedResp?.usageMetadata || null,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: 'network_error', detail: String(err?.message || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export async function testProjectSuggestionsConfig(payload = {}, opts = {}) {
  const cfg = loadProjectSuggestionsConfig(opts);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_unavailable' };

  const rawKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const apiKey = rawKey || cfg.apiKey;
  if (!apiKey) return { ok: false, error: 'missing_api_key' };

  const model = typeof payload.model === 'string' && payload.model.trim() ? sanitizeModelName(payload.model) : cfg.model;
  const baseUrl =
    typeof payload.baseUrl === 'string' && payload.baseUrl.trim() ? sanitizeBaseUrl(payload.baseUrl) : cfg.baseUrl;
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 12_000);
  timer.unref?.();
  const t0 = Date.now();
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }],
        generationConfig: { maxOutputTokens: 16, temperature: 0 },
      }),
      signal: controller.signal,
    });
    const rawBody = await resp.text().catch(() => '');
    if (!resp.ok) {
      return {
        ok: false,
        error: mapGeminiHttpError(resp.status, rawBody),
        status: resp.status,
        detail: rawBody.slice(0, 200),
      };
    }
    return {
      ok: true,
      model,
      latencyMs: Math.max(1, Date.now() - t0),
    };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: 'network_error', detail: String(err?.message || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export async function getProjectSuggestions(
  { dirPath, chats = [], lang = 'en', cacheOnly = false, force = false } = {},
  opts = {}
) {
  const cfg = loadProjectSuggestionsConfig(opts);
  const brief = await collectProjectBriefAsync({ dirPath, chats, lang, model: cfg.model }, opts);
  if (!brief.ok) return brief;

  const cacheDir = opts.cacheDir || PROJECT_SUGGESTIONS_CACHE_DIR;
  const cacheFile = getCacheFilePath(brief.dirPath, cacheDir);
  const rawCached = readJsonOrFallback(cacheFile, null);
  const cached =
    rawCached && typeof rawCached === 'object' && Array.isArray(rawCached.suggestions)
      ? {
          fingerprint: String(rawCached.fingerprint || ''),
          generatedAt: Number(rawCached.generatedAt) || 0,
          model: String(rawCached.model || cfg.model),
          lang: String(rawCached.lang || brief.lang),
          suggestions: rawCached.suggestions,
        }
      : null;

  const hasApiKey = Boolean(cfg.apiKey);
  const cachedMatches = Boolean(
    cached && cached.fingerprint === brief.fingerprint && cached.lang === brief.lang && cached.suggestions.length > 0
  );
  const needsRefresh = Boolean(hasApiKey && cfg.enabled && !cachedMatches);

  const baseMeta = {
    ok: true,
    hasApiKey,
    enabled: cfg.enabled,
    autoRefresh: cfg.autoRefresh,
    model: cfg.model,
    fingerprint: brief.fingerprint,
    cachedFingerprint: cached?.fingerprint || '',
    generatedAt: cached?.generatedAt || 0,
    needsRefresh,
  };

  if (cacheOnly) {
    return {
      ...baseMeta,
      status: !hasApiKey ? 'unconfigured' : !cfg.enabled ? 'disabled' : cached?.suggestions?.length ? 'ok' : 'empty',
      fromCache: Boolean(cached?.suggestions?.length),
      suggestions: cached?.suggestions || [],
    };
  }

  if (!hasApiKey) {
    return { ...baseMeta, status: 'unconfigured', fromCache: false, suggestions: [] };
  }
  if (!cfg.enabled && !force) {
    return { ...baseMeta, status: 'disabled', fromCache: false, suggestions: [] };
  }
  if (!force && cachedMatches) {
    return {
      ...baseMeta,
      status: 'ok',
      fromCache: true,
      suggestions: cached.suggestions,
      needsRefresh: false,
    };
  }
  if (!force && !cfg.autoRefresh) {
    return {
      ...baseMeta,
      status: cached?.suggestions?.length ? 'stale_cache' : 'manual_only',
      fromCache: Boolean(cached?.suggestions?.length),
      suggestions: cached?.suggestions || [],
    };
  }

  const nowFn = opts.nowFn || (() => Date.now());
  const cooldownMs = opts.cooldownMs ?? SUGGESTIONS_COOLDOWN_MS;
  if (!force && cached && cached.generatedAt > 0 && nowFn() - cached.generatedAt < cooldownMs) {
    return {
      ...baseMeta,
      status: 'cooldown',
      cooldown: true,
      fromCache: Boolean(cached.suggestions.length),
      suggestions: cached.suggestions,
    };
  }

  const flightKey = `${normalizeRealPath(brief.dirPath)}|${brief.lang}|${cfg.model}`;
  if (inFlightByDir.has(flightKey)) {
    return inFlightByDir.get(flightKey);
  }

  const task = (async () => {
    const res = await callGeminiSuggestions({
      brief,
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      lang: brief.lang,
      fetchImpl: opts.fetchImpl || globalThis.fetch,
      timeoutMs: opts.timeoutMs || SUGGESTIONS_TIMEOUT_MS,
    });
    if (!res.ok) {
      return {
        ...baseMeta,
        ok: false,
        status: 'error',
        error: res.error,
        detail: res.detail || '',
        fromCache: Boolean(cached?.suggestions?.length),
        suggestions: cached?.suggestions || [],
      };
    }

    const generatedAt = nowFn();
    const record = {
      schema: 1,
      dirPath: brief.dirPath,
      fingerprint: brief.fingerprint,
      lang: brief.lang,
      model: cfg.model,
      generatedAt,
      suggestions: res.suggestions,
    };
    writeAtomicUtf8(cacheFile, `${JSON.stringify(record, null, 2)}\n`);

    return {
      ...baseMeta,
      status: 'ok',
      fromCache: false,
      needsRefresh: false,
      cachedFingerprint: brief.fingerprint,
      generatedAt,
      suggestions: res.suggestions,
      usage: res.usage || null,
    };
  })().finally(() => {
    inFlightByDir.delete(flightKey);
  });

  inFlightByDir.set(flightKey, task);
  return task;
}

export async function handleProjectSuggestionsRpc(action, payload = {}, opts = {}) {
  if (action === 'getProjectSuggestionsConfig') return getPublicProjectSuggestionsConfig(opts);
  if (action === 'saveProjectSuggestionsConfig') return saveProjectSuggestionsConfig(payload, opts);
  if (action === 'testProjectSuggestionsConfig') return testProjectSuggestionsConfig(payload, opts);
  if (action === 'getProjectSuggestions') return getProjectSuggestions(payload, opts);
  return { ok: false, error: `unknown_action:${action}` };
}
