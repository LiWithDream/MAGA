/**
 * MAGA Remote Gateway — HTTP + WebSocket Gateway Entrypoint
 * Strictly binds 127.0.0.1 only, enforces transport/host/origin/CSP/auth, IPC orphan exit & graceful shutdown.
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createAuditLogger } from './audit.mjs';
import { createAuthManager } from './auth.mjs';
import {
  getRemotePaths,
  loadRemoteConfig,
  removeGatewayPid,
  writeGatewayPid,
} from './config.mjs';
import {
  applySecurityHeaders,
  createTransportGuard,
  resolveStaticFile,
} from './transport.mjs';
import { createUdsClient } from './uds-client.mjs';
import { createWsServer } from './ws-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PWA_DIST_DIR = path.resolve(__dirname, '..', 'pwa', 'dist');
const MAX_JSON_BODY_BYTES = 16 * 1024;
const ANDROID_APK_FILENAME = 'AGY-Studio-Remote.apk';
const ANDROID_META_FILENAME = 'android-latest.json';

function readAndroidLatestInfo(remoteDir) {
  try {
    const metaPath = path.join(remoteDir, ANDROID_META_FILENAME);
    const apkPath = path.join(remoteDir, ANDROID_APK_FILENAME);
    if (!fs.existsSync(metaPath) || !fs.existsSync(apkPath)) return null;
    const metaStat = fs.lstatSync(metaPath);
    const apkStat = fs.lstatSync(apkPath);
    if (!metaStat.isFile() || metaStat.isSymbolicLink() || !apkStat.isFile() || apkStat.isSymbolicLink()) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const versionCode = Number(raw?.versionCode);
    const versionName = typeof raw?.versionName === 'string' ? raw.versionName.trim().slice(0, 32) : '';
    const sha256 =
      typeof raw?.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(raw.sha256) ? raw.sha256.toLowerCase() : '';
    if (!Number.isInteger(versionCode) || versionCode <= 0 || !versionName || !sha256) return null;
    if (Number(raw?.bytes) !== apkStat.size) return null;
    return {
      versionCode,
      versionName,
      filename: ANDROID_APK_FILENAME,
      bytes: apkStat.size,
      sha256,
      builtAt: typeof raw?.builtAt === 'string' ? raw.builtAt : '',
      apkPath,
    };
  } catch {
    return null;
  }
}

function sendJson(res, status, data) {
  applySecurityHeaders(res);
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  res.end(body);
}

function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const err = new Error('payload_too_large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.once('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks, total).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('invalid_json_object');
          err.status = 400;
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error('invalid_json');
        err.status = 400;
        reject(err);
      }
    });

    req.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export async function createGatewayServer(options = {}) {
  const {
    remoteDir = null,
    sockPath = null,
    pwaDistDir = DEFAULT_PWA_DIST_DIR,
    config: configOverrides = {},
    port: portOverride = undefined,
    host: hostOverride = undefined,
    udsClient: injectedUdsClient = null,
    udsWriteToken = undefined,
    jwks = null,
    jwksFetcher = null,
    requireWsOrigin = undefined,
    helloTimeoutMs = 5000,
    tapDeactivateDelayMs = 30_000,
    pingIntervalMs = 25_000,
    revocationCheckMs = 2000,
    maxWriteBufferBytes = 1024 * 1024,
    maxWritesPerMinute = undefined,
    maxConcurrentWrites = undefined,
    idempotencyTtlMs = undefined,
    now = Date.now,
    writePid = true,
  } = options;

  const mergedOverrides = { ...(configOverrides || {}) };
  if (portOverride !== undefined) mergedOverrides.port = portOverride;
  if (hostOverride !== undefined) mergedOverrides.host = hostOverride;

  const config = loadRemoteConfig({ remoteDir, overrides: mergedOverrides });
  if (config.host !== '127.0.0.1') {
    throw new Error(`refusing_non_loopback_bind:${config.host}`);
  }

  const paths = getRemotePaths(remoteDir, sockPath);
  const audit = createAuditLogger({ remoteDir: paths.remoteDir, auditFile: paths.auditFile, now });
  const ownsUdsClient = !injectedUdsClient;
  const udsClient =
    injectedUdsClient ||
    createUdsClient({
      sockPath: paths.sockPath,
      udsWriteToken: udsWriteToken !== undefined ? udsWriteToken : process.env.MAGA_REMOTE_UDS_TOKEN || '',
      autoConnect: true,
    });

  async function queryBridgeHealth({ fresh = false } = {}) {
    try {
      return await udsClient.request(
        'bridge.health',
        fresh ? { fresh: true } : {},
        { timeoutMs: fresh ? 3000 : 1500 }
      );
    } catch {
      return null;
    }
  }

  const auth = createAuthManager({
    remoteDir: paths.remoteDir,
    audit,
    getHealth: () => queryBridgeHealth({ fresh: true }),
    now,
  });

  let boundPort = config.port;
  const effectiveRequireWsOrigin = requireWsOrigin !== undefined ? Boolean(requireWsOrigin) : config.transport !== 'loopback';
  const transportGuard = createTransportGuard({
    config,
    boundPort,
    jwks,
    jwksFetcher,
    requireWsOrigin: effectiveRequireWsOrigin,
    now,
  });

  const wsServer = createWsServer({
    remoteDir: paths.remoteDir,
    transportGuard,
    auth,
    udsClient,
    audit,
    helloTimeoutMs,
    tapDeactivateDelayMs,
    pingIntervalMs,
    revocationCheckMs,
    maxWriteBufferBytes,
    ...(maxWritesPerMinute !== undefined ? { maxWritesPerMinute } : {}),
    ...(maxConcurrentWrites !== undefined ? { maxConcurrentWrites } : {}),
    ...(idempotencyTtlMs !== undefined ? { idempotencyTtlMs } : {}),
    now,
    getActivePort: () => boundPort,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const check = await transportGuard.verifyHttp(req, { activePort: boundPort });
      if (!check.ok) {
        audit.append('http_access_denied', {
          error: check.error,
          method: req.method,
          url: String(req.url || '/').split('?')[0],
          remoteAddr: req.socket?.remoteAddress,
        });
        sendJson(res, check.status || 403, { ok: false, error: check.error });
        return;
      }

      const clientKey = transportGuard.getClientKey(req, check.edge);
      const rawReqPath = String(req.url || '/').split('?')[0];
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const method = String(req.method || 'GET').toUpperCase();

      if (url.pathname === '/api/health') {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
          return;
        }
        const health = await queryBridgeHealth();
        sendJson(res, 200, {
          ok: true,
          protocol: 'maga-remote/1',
          transport: config.transport,
          hostAttached: Boolean(health?.hostAttached),
          capabilities: health?.capabilities || {},
          globalPreset: health?.globalPreset ?? null,
          gatewayFingerprint: auth.gatewayFingerprint,
        });
        return;
      }

      if (url.pathname === '/api/auth/challenge') {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
          return;
        }
        const challenge = auth.issueChallenge(clientKey);
        if (!challenge.ok) {
          sendJson(res, challenge.status || 429, {
            ok: false,
            error: challenge.error,
            retryAfterSec: challenge.retryAfterSec,
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
        });
        return;
      }

      if (url.pathname === '/api/pair/complete') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
          return;
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, err?.status || 400, { ok: false, error: err?.message || 'invalid_body' });
          return;
        }
        const result = await auth.completePairing(body, { clientKey, config });
        if (!result.ok) {
          sendJson(res, result.status || 400, {
            ok: false,
            error: result.error,
            ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}),
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          deviceId: result.deviceId,
          role: result.role,
          gatewayFingerprint: result.gatewayFingerprint,
        });
        return;
      }

      if (url.pathname === '/api/android/latest') {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
          return;
        }
        const info = readAndroidLatestInfo(paths.remoteDir);
        if (!info) {
          sendJson(res, 200, { ok: true, available: false });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          available: true,
          versionCode: info.versionCode,
          versionName: info.versionName,
          filename: info.filename,
          bytes: info.bytes,
          sha256: info.sha256,
          builtAt: info.builtAt,
          downloadPath: '/api/android/apk',
        });
        return;
      }

      if (url.pathname === '/api/android/apk') {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
          return;
        }
        const info = readAndroidLatestInfo(paths.remoteDir);
        if (!info) {
          sendJson(res, 404, { ok: false, error: 'apk_not_available' });
          return;
        }
        applySecurityHeaders(res);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${info.filename}"`);
        res.setHeader('Content-Length', info.bytes);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-APK-SHA256', info.sha256);
        if (method === 'HEAD') {
          res.end();
          return;
        }
        const apkStream = fs.createReadStream(info.apkPath);
        pipeline(apkStream, res, (err) => {
          if (err && !res.headersSent) {
            sendJson(res, 500, { ok: false, error: 'apk_read_error' });
          }
        });
        return;
      }

      if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
        sendJson(res, 404, { ok: false, error: 'not_found' });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }

      if (/(?:^|\/)\.\.(?:\/|$)|%2e%2e|%5c|\\|%00/i.test(rawReqPath)) {
        sendJson(res, 403, { ok: false, error: 'path_traversal_blocked' });
        return;
      }

      const resolved = resolveStaticFile(url.pathname, pwaDistDir);
      if (!resolved.ok) {
        sendJson(res, resolved.status || 404, { ok: false, error: resolved.error });
        return;
      }

      applySecurityHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', resolved.contentType);
      res.setHeader('Content-Length', resolved.size);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      if (method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(resolved.filePath);
      stream.on('error', () => {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'static_read_error' });
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'internal_error' });
      } else {
        try {
          res.destroy(err);
        } catch {}
      }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      try {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch {}
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head).catch(() => {
      try {
        socket.destroy();
      } catch {}
    });
  });

  await new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    server.once('error', onErr);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', onErr);
      resolve();
    });
  });

  const addr = server.address();
  boundPort = addr && typeof addr === 'object' ? addr.port : config.port;

  if (writePid) {
    writeGatewayPid({ remoteDir: paths.remoteDir, port: boundPort, startedAt: now() });
  }
  audit.append('gateway_start', { port: boundPort, transport: config.transport, epoch: wsServer.epoch });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    wsServer.close();
    if (ownsUdsClient) {
      udsClient.close();
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    if (writePid) {
      removeGatewayPid({ remoteDir: paths.remoteDir });
    }
    audit.append('gateway_stop', { port: boundPort, epoch: wsServer.epoch });
  }

  return {
    server,
    port: boundPort,
    host: '127.0.0.1',
    epoch: wsServer.epoch,
    config,
    paths,
    gatewayFingerprint: auth.gatewayFingerprint,
    auth,
    audit,
    udsClient,
    wsServer,
    close,
  };
}

const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  let gw = null;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await gw?.close();
    } catch {}
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.on('disconnect', () => shutdown());
  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') shutdown();
  });

  try {
    gw = await createGatewayServer();
    console.log(
      JSON.stringify({
        ok: true,
        event: 'maga_remote_gateway_listening',
        host: gw.host,
        port: gw.port,
        epoch: gw.epoch,
        transport: gw.config.transport,
        gatewayFingerprint: gw.gatewayFingerprint,
      })
    );
  } catch (err) {
    console.error('[maga-remote-gateway]', err?.message || err);
    process.exit(1);
  }
}
