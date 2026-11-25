/**
 * MAGA Remote Gateway — Transport Security, Host/Origin Guards, CSP & Edge Auth
 * Fail-closed verification for loopback, tailscale-serve, cloudflare-access.
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': STRICT_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

const PROXY_FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'cf-access-jwt-assertion',
  'tailscale-user-login',
];

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

export function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(k, v);
  }
}

export function isLoopbackAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function getHeaderSingle(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const val = headers[name.toLowerCase()];
  if (val === undefined || val === null) return null;
  if (Array.isArray(val)) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : '';
}

export function parseHostHeader(rawHost) {
  if (typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim();
  if (!trimmed || /[\s\\/?#@]/.test(trimmed) || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('[')) {
    const closeIdx = lower.indexOf(']');
    if (closeIdx <= 1) return null;
    const hostname = lower.slice(1, closeIdx);
    const rest = lower.slice(closeIdx + 1);
    if (!rest) return { raw: lower, hostname, port: '' };
    if (!rest.startsWith(':')) return null;
    const portStr = rest.slice(1);
    if (!/^\d{1,5}$/.test(portStr)) return null;
    const p = Number(portStr);
    if (p < 1 || p > 65535) return null;
    return { raw: lower, hostname, port: portStr };
  }
  const colonIdx = lower.indexOf(':');
  if (colonIdx !== -1) {
    if (lower.indexOf(':', colonIdx + 1) !== -1) return null;
    const hostname = lower.slice(0, colonIdx);
    const portStr = lower.slice(colonIdx + 1);
    if (!hostname || !/^\d{1,5}$/.test(portStr)) return null;
    const p = Number(portStr);
    if (p < 1 || p > 65535) return null;
    return { raw: lower, hostname, port: portStr };
  }
  return { raw: lower, hostname: lower, port: '' };
}

export function validateHostHeader(req, config, boundPort = null) {
  const raw = getHeaderSingle(req?.headers, 'host');
  if (!raw) return { ok: false, error: 'missing_host_header' };
  const parsed = parseHostHeader(raw);
  if (!parsed) return { ok: false, error: 'invalid_host_header' };

  const allowed = new Set((config?.allowedHosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  if (allowed.has(parsed.raw)) {
    return { ok: true, parsed };
  }

  const isLocalName = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (isLocalName && boundPort && parsed.port && Number(parsed.port) === Number(boundPort)) {
    return { ok: true, parsed };
  }

  if (allowed.has(parsed.hostname)) {
    if (isLocalName && boundPort && parsed.port && Number(parsed.port) !== Number(boundPort)) {
      return { ok: false, error: 'host_port_mismatch' };
    }
    return { ok: true, parsed };
  }

  return { ok: false, error: 'host_not_allowed' };
}

function normalizeOriginString(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

export function validateOriginHeader(req, config, parsedHost = null, { requireOrigin = false } = {}) {
  const rawOrigin = req?.headers?.origin;
  if (rawOrigin === undefined) {
    return requireOrigin ? { ok: false, error: 'missing_origin' } : { ok: true, absent: true };
  }
  if (Array.isArray(rawOrigin)) return { ok: false, error: 'invalid_origin_header' };
  const s = String(rawOrigin).trim();
  if (!s || s.toLowerCase() === 'null') {
    return { ok: false, error: 'null_or_empty_origin' };
  }
  const originUrl = normalizeOriginString(s);
  if (!originUrl) return { ok: false, error: 'invalid_origin_url' };

  const allowedOrigins = new Set();
  for (const item of config?.allowedOrigins || []) {
    const u = normalizeOriginString(item);
    if (u) allowedOrigins.add(u.origin.toLowerCase());
  }
  if (allowedOrigins.has(originUrl.origin.toLowerCase())) {
    return { ok: true, origin: originUrl.origin };
  }

  if (parsedHost) {
    const originHost = originUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const originPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');
    const hostPort = parsedHost.port || (originUrl.protocol === 'https:' ? '443' : '80');
    if (originHost === parsedHost.hostname && originPort === hostPort) {
      return { ok: true, origin: originUrl.origin };
    }
    if (originUrl.host.toLowerCase() === parsedHost.raw) {
      return { ok: true, origin: originUrl.origin };
    }
  }

  return { ok: false, error: 'origin_not_allowed' };
}

function constantTimeStringEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function defaultJwksFetcher(teamDomain) {
  return async () => {
    if (!/^[a-z0-9.-]+$/i.test(teamDomain)) {
      throw new Error('invalid_cf_team_domain');
    }
    const url = `https://${teamDomain}/cdn-cgi/access/certs`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new Error(`cf_jwks_http_${res.status}`);
    }
    return res.json();
  };
}

function decodeBase64UrlJson(segment) {
  const raw = Buffer.from(segment, 'base64url').toString('utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_jwt_json');
  }
  return parsed;
}

export function createTransportGuard({
  config,
  boundPort = null,
  jwks = null,
  jwksFetcher = null,
  jwksCacheTtlMs = 5 * 60 * 1000,
  requireWsOrigin = false,
  now = Date.now,
} = {}) {
  let cachedJwks = jwks && Array.isArray(jwks.keys) ? jwks : null;
  let cachedJwksAt = cachedJwks ? now() : 0;
  let lastForceRefreshAt = 0;

  function getConfiguredAuds() {
    const raw = config?.cfAccessAud;
    if (Array.isArray(raw)) {
      return raw.map((s) => String(s || '').trim()).filter(Boolean);
    }
    if (typeof raw === 'string' && raw.trim()) {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }

  async function resolveJwks(forceRefresh = false) {
    if (jwks && Array.isArray(jwks.keys) && !jwksFetcher) {
      return jwks;
    }
    const ts = now();
    if (!forceRefresh && cachedJwks && ts - cachedJwksAt < jwksCacheTtlMs) {
      return cachedJwks;
    }
    if (forceRefresh && ts - lastForceRefreshAt < 10_000 && cachedJwks) {
      return cachedJwks;
    }
    if (forceRefresh) lastForceRefreshAt = ts;
    const fetcher =
      typeof jwksFetcher === 'function'
        ? () => jwksFetcher(config.cfAccessTeamDomain)
        : defaultJwksFetcher(config.cfAccessTeamDomain);
    const data = await fetcher();
    if (!data || !Array.isArray(data.keys)) {
      throw new Error('invalid_cf_jwks_payload');
    }
    cachedJwks = data;
    cachedJwksAt = now();
    return cachedJwks;
  }

  async function verifyCfAccessJwt(token) {
    const teamDomain = String(config?.cfAccessTeamDomain || '').trim().toLowerCase();
    const expectedAuds = getConfiguredAuds();
    if (!teamDomain || !/^[a-z0-9.-]+$/i.test(teamDomain) || expectedAuds.length === 0) {
      return { ok: false, status: 403, error: 'cf_access_not_configured' };
    }

    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts.some((p) => !p)) {
      return { ok: false, status: 401, error: 'invalid_cf_jwt_format' };
    }
    const [headerB64, payloadB64, sigB64] = parts;

    let header;
    let payload;
    try {
      header = decodeBase64UrlJson(headerB64);
      payload = decodeBase64UrlJson(payloadB64);
    } catch {
      return { ok: false, status: 401, error: 'invalid_cf_jwt_encoding' };
    }

    if (header.alg !== 'RS256') {
      return { ok: false, status: 401, error: 'unsupported_cf_jwt_alg' };
    }

    let jwkSet;
    try {
      jwkSet = await resolveJwks(false);
    } catch {
      return { ok: false, status: 503, error: 'cf_jwks_unavailable' };
    }

    const findMatchingKey = (set) => {
      const keys = Array.isArray(set?.keys) ? set.keys : [];
      if (header.kid) {
        return keys.find((k) => k && k.kid === header.kid && k.kty === 'RSA') || null;
      }
      const rsaKeys = keys.filter((k) => k && k.kty === 'RSA');
      return rsaKeys.length === 1 ? rsaKeys[0] : null;
    };

    let matchedJwk = findMatchingKey(jwkSet);
    if (!matchedJwk && header.kid) {
      try {
        jwkSet = await resolveJwks(true);
        matchedJwk = findMatchingKey(jwkSet);
      } catch {
        return { ok: false, status: 503, error: 'cf_jwks_unavailable' };
      }
    }
    if (!matchedJwk) {
      return { ok: false, status: 401, error: 'cf_jwt_unknown_kid' };
    }

    let verified = false;
    try {
      const keyObj = crypto.createPublicKey({ key: matchedJwk, format: 'jwk' });
      if (keyObj.asymmetricKeyType !== 'rsa') {
        return { ok: false, status: 401, error: 'cf_jwt_invalid_key_type' };
      }
      const sigBuf = Buffer.from(sigB64, 'base64url');
      verified = crypto.verify('sha256', Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), keyObj, sigBuf);
    } catch {
      verified = false;
    }
    if (!verified) {
      return { ok: false, status: 401, error: 'cf_jwt_invalid_signature' };
    }

    const nowSec = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || nowSec >= payload.exp) {
      return { ok: false, status: 401, error: 'cf_jwt_expired' };
    }
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || nowSec < payload.nbf) {
        return { ok: false, status: 401, error: 'cf_jwt_not_yet_valid' };
      }
    }
    if (payload.iat !== undefined) {
      if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > nowSec + 60) {
        return { ok: false, status: 401, error: 'cf_jwt_invalid_iat' };
      }
    }
    if (typeof payload.iss === 'string' && payload.iss.trim()) {
      const normalizedIss = payload.iss.trim().replace(/\/+$/, '').toLowerCase();
      if (normalizedIss !== `https://${teamDomain}`) {
        return { ok: false, status: 401, error: 'cf_jwt_invalid_issuer' };
      }
    }

    const tokenAuds = Array.isArray(payload.aud)
      ? payload.aud.map((a) => String(a || '').trim()).filter(Boolean)
      : typeof payload.aud === 'string' && payload.aud.trim()
        ? [payload.aud.trim()]
        : [];
    const audOk = tokenAuds.some((ta) => expectedAuds.some((ea) => constantTimeStringEqual(ta, ea)));
    if (!audOk) {
      return { ok: false, status: 401, error: 'cf_jwt_invalid_aud' };
    }

    return {
      ok: true,
      method: 'cloudflare-access',
      user: String(payload.email || payload.sub || 'cf-access'),
      claims: payload,
    };
  }

  async function verifyEdgeTransport(req) {
    const remoteAddr = req?.socket?.remoteAddress || '';
    if (!isLoopbackAddress(remoteAddr)) {
      return { ok: false, status: 403, error: 'non_loopback_socket' };
    }

    const mode = config?.transport || 'loopback';

    if (mode === 'loopback') {
      for (const h of PROXY_FORWARDING_HEADERS) {
        const val = req?.headers?.[h];
        if (val !== undefined && String(val).trim() !== '') {
          return { ok: false, status: 403, error: `proxy_header_forbidden:${h}` };
        }
      }
      return { ok: true, method: 'loopback', user: 'loopback' };
    }

    if (mode === 'tailscale-serve') {
      const allowedUsers = (config?.tailscaleAllowedUsers || [])
        .map((u) => String(u || '').trim().toLowerCase())
        .filter(Boolean);
      if (allowedUsers.length === 0) {
        return { ok: false, status: 403, error: 'tailscale_allowed_users_empty' };
      }
      const rawLogin = getHeaderSingle(req?.headers, 'tailscale-user-login');
      if (!rawLogin || /[\s,]/.test(rawLogin)) {
        return { ok: false, status: 401, error: 'missing_tailscale_user_login' };
      }
      const login = rawLogin.toLowerCase();
      if (!allowedUsers.some((u) => constantTimeStringEqual(login, u))) {
        return { ok: false, status: 403, error: 'tailscale_user_not_allowed' };
      }
      return { ok: true, method: 'tailscale-serve', user: login };
    }

    if (mode === 'cloudflare-access') {
      const jwt = getHeaderSingle(req?.headers, 'cf-access-jwt-assertion');
      if (!jwt) {
        return { ok: false, status: 401, error: 'missing_cf_access_jwt' };
      }
      return verifyCfAccessJwt(jwt);
    }

    return { ok: false, status: 403, error: 'unsupported_transport' };
  }

  async function verifyHttp(req, { activePort = boundPort } = {}) {
    const hostCheck = validateHostHeader(req, config, activePort);
    if (!hostCheck.ok) {
      return { ok: false, status: 403, error: hostCheck.error };
    }
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && req?.headers?.origin !== undefined) {
      const originCheck = validateOriginHeader(req, config, hostCheck.parsed, { requireOrigin: false });
      if (!originCheck.ok) {
        return { ok: false, status: 403, error: originCheck.error };
      }
    }
    const edge = await verifyEdgeTransport(req);
    if (!edge.ok) return edge;
    return { ok: true, host: hostCheck.parsed, edge };
  }

  async function verifyUpgrade(req, { activePort = boundPort } = {}) {
    const hostCheck = validateHostHeader(req, config, activePort);
    if (!hostCheck.ok) {
      return { ok: false, status: 403, error: hostCheck.error };
    }
    const originCheck = validateOriginHeader(req, config, hostCheck.parsed, { requireOrigin: requireWsOrigin });
    if (!originCheck.ok) {
      return { ok: false, status: 403, error: originCheck.error };
    }
    const edge = await verifyEdgeTransport(req);
    if (!edge.ok) return edge;
    return { ok: true, host: hostCheck.parsed, origin: originCheck.origin || null, edge };
  }

  function getClientKey(req, edge = null) {
    if (edge?.user && edge.user !== 'loopback') {
      return `${edge.method}:${edge.user}`;
    }
    const cfIp = getHeaderSingle(req?.headers, 'cf-connecting-ip');
    if (cfIp) return `ip:${cfIp}`;
    const rawAddr = req?.socket?.remoteAddress || '127.0.0.1';
    const normAddr = rawAddr === '::ffff:127.0.0.1' || rawAddr === '::1' ? '127.0.0.1' : rawAddr;
    return `addr:${normAddr}`;
  }

  return {
    verifyHttp,
    verifyUpgrade,
    verifyEdgeTransport,
    getClientKey,
  };
}

export function resolveStaticFile(urlPathname, pwaDistDir) {
  if (!pwaDistDir) return { ok: false, status: 404, error: 'not_found' };
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPathname || '/'));
  } catch {
    return { ok: false, status: 400, error: 'invalid_path_encoding' };
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return { ok: false, status: 400, error: 'invalid_path' };
  }
  const normalizedPath = decoded === '/' ? '/index.html' : decoded;
  const relRaw = normalizedPath.replace(/^\/+/, '');
  if (!relRaw) return { ok: false, status: 404, error: 'not_found' };
  const segments = relRaw.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) {
    return { ok: false, status: 403, error: 'forbidden_path' };
  }

  let distReal;
  try {
    distReal = fs.realpathSync(pwaDistDir);
  } catch {
    return { ok: false, status: 404, error: 'dist_unavailable' };
  }

  const candidate = path.resolve(distReal, relRaw);
  const rel = path.relative(distReal, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, status: 403, error: 'path_traversal_blocked' };
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    return { ok: false, status: 404, error: 'not_found' };
  }
  const realRel = path.relative(distReal, realTarget);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return { ok: false, status: 403, error: 'path_traversal_blocked' };
  }

  try {
    const st = fs.statSync(realTarget);
    if (!st.isFile()) return { ok: false, status: 404, error: 'not_found' };
    const ext = path.extname(realTarget).toLowerCase();
    const contentType = MIME_TYPES.get(ext) || 'application/octet-stream';
    return { ok: true, filePath: realTarget, contentType, size: st.size, relPath: realRel };
  } catch {
    return { ok: false, status: 404, error: 'not_found' };
  }
}
