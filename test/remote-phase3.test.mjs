/**
 * AGY Studio Remote Control — Phase 3 Desktop Settings, QR SVG & RPC Test Suite
 * Tests: zero-dep QR SVG generator (V1..V10 Level L), hermetic daemon settings RPCs,
 * Desktop Settings Remote Control view & click events, XSS escaping, and static invariants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GW_DIR = path.join(REPO, 'remote', 'gateway');

const qrMod = await import(pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'qr-svg.mjs')).href);
const rpcMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote', 'settings-rpc.mjs')).href);
const remViewMod = await import(pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'remote-view.mjs')).href);
const remEventsMod = await import(pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'remote-events.mjs')).href);
const viewsMod = await import(pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'views.mjs')).href);
const gwConfigMod = await import(pathToFileURL(path.join(GW_DIR, 'config.mjs')).href);

function assertValidFormatBits(modules) {
  const size = modules.length;
  const copy1Coords = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7],
    [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  const copy2Coords = [
    [8, size - 1], [8, size - 2], [8, size - 3], [8, size - 4],
    [8, size - 5], [8, size - 6], [8, size - 7], [8, size - 8],
    [size - 7, 8], [size - 6, 8], [size - 5, 8], [size - 4, 8],
    [size - 3, 8], [size - 2, 8], [size - 1, 8],
  ];
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < 15; i++) {
    if (modules[copy1Coords[i][0]][copy1Coords[i][1]]) b1 |= 1 << i;
    if (modules[copy2Coords[i][0]][copy2Coords[i][1]]) b2 |= 1 << i;
  }
  assert.equal(b1, b2, 'Format info copy 1 and copy 2 must match');
  const unmasked = b1 ^ 0x5412;
  assert.equal(unmasked >>> 13, 0b01, 'ECC level bits must encode Level L (01)');
  let rem = unmasked;
  for (let bit = 14; bit >= 10; bit--) {
    if ((rem >>> bit) & 1) rem ^= 0x537 << (bit - 10);
  }
  assert.equal(rem, 0, 'BCH(15,5) format syndrome must be 0');
}

function assertFinderAt(modules, top, left) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const border = r === 0 || r === 6 || c === 0 || c === 6;
      const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      assert.equal(modules[top + r][left + c], border || center, `finder mismatch at (${top + r},${left + c})`);
    }
  }
}

test('Phase 3 qr-svg encodes V1..V10 Level L matrices, dark module, finders & crisp inline SVG', () => {
  // V1 (21x21) for short loopback string
  const v1 = qrMod.encodeQrMatrix('HELLO WORLD');
  assert.equal(v1.version, 1);
  assert.equal(v1.size, 21);
  assert.equal(v1.modules.length, 21);
  assertFinderAt(v1.modules, 0, 0);
  assertFinderAt(v1.modules, 0, 14);
  assertFinderAt(v1.modules, 14, 0);
  assertValidFormatBits(v1.modules);
  assert.equal(v1.modules[21 - 8][8], true, 'ISO 18004 dark module at (size-8, 8)');

  // Typical Cloudflare Access pairing URL (~60 bytes -> V3..V5)
  const cfUrl = 'https://agy.example.com/#pair=0123456789ABCDEF';
  const vCf = qrMod.encodeQrMatrix(cfUrl);
  assert.ok(vCf.version >= 3 && vCf.version <= 5);
  assert.equal(vCf.size, 4 * vCf.version + 17);
  assertFinderAt(vCf.modules, 0, 0);
  assertFinderAt(vCf.modules, 0, vCf.size - 7);
  assertFinderAt(vCf.modules, vCf.size - 7, 0);
  assertValidFormatBits(vCf.modules);

  // V7+ & V10 (16-bit byte length header path)
  const v8 = qrMod.encodeQrMatrix('x'.repeat(160));
  assert.equal(v8.version, 8);
  assert.equal(v8.size, 49);
  assert.equal(v8.modules[49 - 8][8], true);
  assertValidFormatBits(v8.modules);

  const v10 = qrMod.encodeQrMatrix('y'.repeat(271));
  assert.equal(v10.version, 10);
  assert.equal(v10.size, 57);
  assert.equal(v10.modules[57 - 8][8], true);
  assertValidFormatBits(v10.modules);

  // Inline SVG output check (no external refs, crispEdges, white quiet-zone rect)
  const svg = qrMod.renderQrSvg(cfUrl, { sizePx: 180, quietZone: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" width="180" height="180"/);
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  assert.ok(svg.includes('<rect width='));
  assert.ok(svg.includes('<path d="M'));

  // Reject empty or oversize inputs cleanly
  assert.throws(() => qrMod.encodeQrMatrix(''), /qr_empty_input/);
  assert.throws(() => qrMod.encodeQrMatrix('z'.repeat(272)), /qr_input_too_long/);
});

test('Phase 3 settings-rpc manages config, Cloudflare/Tailscale fail-closed validation, pairing, devices & diagnostics hermetically', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p3rpc-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const fakeDist = path.join(tmpRoot, 'pwa-dist');
  fs.mkdirSync(fakeDist, { recursive: true });
  fs.writeFileSync(path.join(fakeDist, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(fakeDist, 'app.js'), '// built');

  let reconcileCalls = 0;
  const opts = {
    remoteDir,
    pwaDistDir: fakeDist,
    hostCount: 1,
    onConfigChanged: () => {
      reconcileCalls += 1;
    },
    checkBinary: async (bin) => bin === 'cloudflared',
  };

  try {
    // 1. Default status when unconfigured
    const st0 = await rpcMod.getRemoteControlStatus(opts);
    assert.equal(st0.ok, true);
    assert.equal(st0.configured, false);
    assert.equal(st0.config.enabled, false);
    assert.equal(st0.config.transport, 'loopback');
    assert.equal(st0.pwaBuilt, true);
    assert.equal(st0.hostAttached, true);

    // 2. Fail-closed checks
    assert.equal(
      (await rpcMod.saveRemoteControlConfig({ enabled: true, transport: 'cloudflare-access', cfAccessTeamDomain: '', cfAccessAud: '' }, opts)).error,
      'missing_cf_access_config'
    );
    assert.equal(
      (await rpcMod.saveRemoteControlConfig({ enabled: true, transport: 'tailscale-serve', tailscaleAllowedUsers: '' }, opts)).error,
      'missing_tailscale_allowlist'
    );
    assert.equal(
      (await rpcMod.saveRemoteControlConfig({ port: 80 }, opts)).error,
      'invalid_port'
    );
    assert.equal(
      (await rpcMod.saveRemoteControlConfig({ allowedHosts: ['*'] }, opts)).error,
      'wildcard_forbidden'
    );
    assert.equal(
      (await rpcMod.saveRemoteControlConfig({ publicUrl: 'http://insecure.example.com' }, opts)).error,
      'public_url_must_be_https'
    );

    // 3. Valid Cloudflare Access config + custom domain
    const saved = await rpcMod.saveRemoteControlConfig(
      {
        enabled: true,
        port: 18792,
        transport: 'cloudflare-access',
        publicUrl: 'https://Agy.Example.com/',
        cfAccessTeamDomain: 'https://MyTeam.cloudflareaccess.com/',
        cfAccessAud: 'aud-tag-1234',
      },
      opts
    );
    assert.equal(saved.ok, true);
    assert.equal(saved.saved, true);
    assert.equal(reconcileCalls, 1);
    assert.equal(saved.config.enabled, true);
    assert.equal(saved.config.port, 18792);
    assert.equal(saved.config.cfAccessTeamDomain, 'myteam.cloudflareaccess.com');
    assert.equal(saved.config.cfAccessAud, 'aud-tag-1234');
    assert.ok(saved.config.allowedHosts.includes('agy.example.com'));
    assert.ok(saved.config.allowedOrigins.includes('https://agy.example.com'));
    assert.equal(saved.publicBaseUrl, 'https://agy.example.com');

    // Verify 0600 file permissions on config.json
    const cfgMode = fs.lstatSync(path.join(remoteDir, 'config.json')).mode & 0o777;
    assert.equal(cfgMode, 0o600);

    // 4. Create pairing -> writes 0600 pairing.json + returns HTTPS Cloudflare pairingUrl
    const pair = await rpcMod.createRemotePairing({ role: 'steer', ttlSec: 180 }, opts);
    assert.equal(pair.ok, true);
    assert.match(pair.code, /^[0-9A-F]{16}$/);
    assert.equal(pair.role, 'steer');
    assert.equal(pair.pairingUrl, `https://agy.example.com/#pair=${pair.code}`);
    assert.equal(pair.localUrl, `http://127.0.0.1:18792/#pair=${pair.code}`);
    assert.equal(fs.lstatSync(path.join(remoteDir, 'pairing.json')).mode & 0o777, 0o600);

    // 5. Device role update & revocation
    gwConfigMod.writeDevices(
      [
        {
          deviceId: 'dev-1',
          name: 'iPhone 16 Pro',
          role: 'steer',
          publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
          createdAt: 1000,
          revokedAt: null,
        },
      ],
      { remoteDir }
    );

    const demoted = await rpcMod.updateRemoteDeviceRole({ deviceId: 'dev-1', role: 'observe' }, opts);
    assert.equal(demoted.ok, true);
    assert.equal(demoted.devices[0].role, 'observe');

    const revoked = await rpcMod.revokeRemoteDevice({ deviceId: 'dev-1' }, opts);
    assert.equal(revoked.ok, true);
    assert.equal(revoked.activeDeviceCount, 0);
    assert.equal(revoked.revokedDeviceCount, 1);

    // Revoked device role update must fail
    const errRev = await rpcMod.updateRemoteDeviceRole({ deviceId: 'dev-1', role: 'steer' }, opts);
    assert.equal(errRev.ok, false);
    assert.equal(errRev.error, 'device_revoked');

    // 6. Diagnostics reports binary availability cleanly
    const diag = await rpcMod.runRemoteDiagnostics(opts);
    assert.equal(diag.binaries.cloudflared, true);
    assert.equal(diag.binaries.tailscale, false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 3 desktop Settings UI: L1 card, L2 Remote Control view, QR SVG, XSS escaping & interactive RPC events', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' });
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;

    const rpcCalls = [];
    let mockStatus = {
      ok: true,
      configured: true,
      config: {
        enabled: true,
        port: 18791,
        transport: 'cloudflare-access',
        allowedHosts: ['127.0.0.1', 'localhost', 'agy.example.com'],
        allowedOrigins: ['https://agy.example.com'],
        cfAccessTeamDomain: 'team.cloudflareaccess.com',
        cfAccessAud: 'aud-xyz',
        tailscaleAllowedUsers: [],
        allowLocalPairingWithoutEdge: true,
      },
      publicBaseUrl: 'https://agy.example.com',
      gateway: { running: true, pid: 12345, port: 18791, healthStatus: 'edge_auth_required' },
      hostAttached: true,
      hostCount: 1,
      gatewayFingerprint: 'abcdef1234567890abcdef1234567890',
      pwaBuilt: true,
      devices: [
        {
          deviceId: 'd-xss',
          name: '<img src=x onerror=alert(1)>',
          role: 'steer',
          lastSeenAt: Date.now(),
          revokedAt: null,
        },
      ],
      activeDeviceCount: 1,
      revokedDeviceCount: 0,
      diagnostics: { ok: true, items: [] },
    };

    dom.window.__agProjectCall = async (action, payload) => {
      rpcCalls.push({ action, payload });
      if (action === 'getRemoteControlStatus') return mockStatus;
      if (action === 'createRemotePairing') {
        return {
          ok: true,
          code: 'AABBCCDDEEFF0011',
          role: payload.role,
          ttlSec: payload.ttlSec,
          expiresAt: Date.now() + 120_000,
          pairingUrl: 'https://agy.example.com/#pair=AABBCCDDEEFF0011',
          localUrl: 'http://127.0.0.1:18791/#pair=AABBCCDDEEFF0011',
        };
      }
      if (action === 'saveRemoteControlConfig') {
        mockStatus = {
          ...mockStatus,
          config: { ...mockStatus.config, ...payload },
        };
        return { ...mockStatus, saved: true };
      }
      if (action === 'revokeRemoteDevice') {
        mockStatus = { ...mockStatus, devices: [], activeDeviceCount: 0, revokedDeviceCount: 1 };
        return mockStatus;
      }
      if (action === 'runRemoteDiagnostics') {
        return { ok: true, items: [], binaries: { cloudflared: true, tailscale: false } };
      }
      return { ok: false };
    };

    const L = (zh, en) => en;
    const state = {
      remoteStatus: mockStatus,
      remoteLoading: false,
      remotePairing: null,
      remoteDiagnostics: null,
      remoteDraft: null,
      remotePairRole: 'observe',
      remotePairTtl: 120,
      resetArmed: false,
    };

    // L1 includes Remote Control drill row
    const l1Html = viewsMod.renderL1(
      { customizeModelList: false, hiddenModels: [], hideThinkingProse: false, overviewUsageEnabled: true, motionLevel: 'full' },
      { modules: { i18n: false, claudeUxHideSidebarProjects: false }, cjkFontScale: '95' },
      { executors: [] },
      {
        studioPrefs: { getHostPref: () => 0, getStepStreamMode: () => 'compact' },
        state,
        L,
      }
    );
    assert.ok(l1Html.includes('data-ms-nav="remote"'));
    assert.ok(l1Html.includes('Remote Control'));

    // L2 escapes XSS in device name & renders Cloudflare inputs cleanly
    const root = dom.window.document.getElementById('root');
    const rerender = () => {
      root.innerHTML = remViewMod.renderL2Remote(state, { L });
    };
    rerender();
    assert.equal(root.innerHTML.includes('<img src=x'), false, 'device name HTML must be escaped');
    assert.ok(root.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(root.innerHTML.includes('https://agy.example.com'));

    // Click Pair button -> generates inline QR SVG in DOM
    const pairBtn = root.querySelector('[data-ms-remote-action="pair"]');
    const toasts = [];
    const handledPair = await remEventsMod.handleRemoteSettingsClick(pairBtn, root, {
      state,
      renderActiveHost: rerender,
      flashToast: (zh, en, tone = 'ok') => toasts.push({ zh, en, tone }),
    });
    assert.equal(handledPair, true);
    assert.equal(rpcCalls.at(-1).action, 'createRemotePairing');
    assert.ok(root.querySelector('.agy-ms-remote-qr-box svg'), 'should render local QR SVG inside box');
    assert.ok(root.textContent.includes('AABBCCDDEEFF0011'));

    // Click Revoke -> sends revokeRemoteDevice
    const revBtn = root.querySelector('[data-ms-remote-revoke="d-xss"]');
    const handledRev = await remEventsMod.handleRemoteSettingsClick(revBtn, root, {
      state,
      renderActiveHost: rerender,
      flashToast: (zh, en, tone = 'ok') => toasts.push({ zh, en, tone }),
    });
    assert.equal(handledRev, true);
    assert.deepEqual(rpcCalls.at(-1), { action: 'revokeRemoteDevice', payload: { deviceId: 'd-xss' } });
    assert.equal(root.querySelectorAll('.agy-ms-remote-dev-row').length, 0);
  } finally {
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    dom.window.close();
  }
});

test('Phase 3 static invariants: studio-settings < 550 lines, zero :has(), zero new observers & valid syntax', () => {
  const settingsOrchestrator = fs.readFileSync(path.join(REPO, 'studio', 'modules', 'studio-settings.mjs'), 'utf8');
  assert.ok(
    settingsOrchestrator.split('\n').length < 550,
    `studio-settings.mjs must stay < 550 lines (got ${settingsOrchestrator.split('\n').length})`
  );

  const settingsCss = fs.readFileSync(path.join(REPO, 'studio', 'styles', 'studio-settings.css'), 'utf8');
  assert.equal(settingsCss.includes(':has('), false, 'studio-settings.css must have zero :has() selectors');

  const phase3Files = [
    path.join(REPO, 'core', 'daemon', 'remote', 'settings-rpc.mjs'),
    path.join(REPO, 'studio', 'modules', 'settings', 'qr-svg.mjs'),
    path.join(REPO, 'studio', 'modules', 'settings', 'remote-view.mjs'),
    path.join(REPO, 'studio', 'modules', 'settings', 'remote-events.mjs'),
    path.join(REPO, 'studio', 'modules', 'settings', 'views.mjs'),
    path.join(REPO, 'studio', 'modules', 'settings', 'events.mjs'),
    path.join(REPO, 'studio', 'modules', 'studio-settings.mjs'),
  ];
  for (const abs of phase3Files) {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    const src = fs.readFileSync(abs, 'utf8');
    assert.ok(src.split('\n').length < 2000, `${path.relative(REPO, abs)} must stay < 2000 lines`);
    assert.equal(/\bMutationObserver\b/.test(src), false, `${path.relative(REPO, abs)} must not spawn MutationObserver`);
  }
});
