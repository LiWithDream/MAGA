/**
 * Pure HTML Templates for AGY Studio Settings -> Remote Control L2 View & L1 Summary.
 */
import { esc } from './constants.mjs';
import { renderQrSvg } from './qr-svg.mjs';

function renderLocalSwitchRow(key, kind, title, desc, checked) {
  return `
      <div class="agy-ms-row">
        <div class="agy-ms-row-text">
          <div class="agy-ms-row-title">${esc(title)}</div>
          ${desc ? `<div class="agy-ms-row-desc">${esc(desc)}</div>` : ''}
        </div>
        <button type="button" class="agy-ms-switch" role="switch" data-ms-kind="${kind}" data-ms-key="${esc(key)}" aria-label="${esc(title)}" aria-checked="${checked ? 'true' : 'false'}"><span></span></button>
      </div>`;
}

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

export function extractEditablePublicUrl(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  for (const orig of cfg.allowedOrigins || []) {
    try {
      const u = new URL(String(orig || '').trim());
      if (u.protocol === 'https:' && !isLoopbackHost(u.hostname)) return u.origin;
    } catch {}
  }
  for (const host of cfg.allowedHosts || []) {
    const clean = String(host || '').trim().toLowerCase();
    if (clean && !isLoopbackHost(clean) && !clean.startsWith('127.0.0.1:') && !clean.startsWith('localhost:')) {
      return `https://${clean}`;
    }
  }
  return '';
}

export function getRemoteL1Summary(state, L) {
  const st = state?.remoteStatus;
  if (!st || !st.config) return L('远程网关 ·配对与通道', 'Gateway · QR & Tunnel');
  const cfg = st.config;
  const gw = st.gateway || {};
  if (!cfg.enabled) return L('已关闭', 'Off');
  const port = gw.port || cfg.port || 18791;
  const runLbl = gw.running ? L(`运行中 :${port}`, `Running :${port}`) : L('等待守护', 'Starting');
  const devCnt = Number(st.activeDeviceCount || 0);
  return `${runLbl}${devCnt > 0 ? ` · ${L(`${devCnt} 台设备`, `${devCnt} dev`)}` : ''}`;
}

function formatTsShort(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Date(n).toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function renderL2Remote(state, { L }) {
  const st = state?.remoteStatus;
  const cfg = st?.config || {
    enabled: false,
    port: 18791,
    transport: 'loopback',
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: [],
    cfAccessTeamDomain: '',
    cfAccessAud: '',
    tailscaleAllowedUsers: [],
    allowLocalPairingWithoutEdge: true,
  };
  const draft = state?.remoteDraft || {};
  const transport = draft.transport || cfg.transport || 'loopback';
  const port = draft.port ?? (cfg.port || 18791);
  const publicUrl = draft.publicUrl !== undefined ? draft.publicUrl : extractEditablePublicUrl(cfg);
  const cfTeam = draft.cfAccessTeamDomain !== undefined ? draft.cfAccessTeamDomain : (cfg.cfAccessTeamDomain || '');
  const cfAud = draft.cfAccessAud !== undefined ? draft.cfAccessAud : String(cfg.cfAccessAud || '');
  const tsUsers =
    draft.tailscaleUsers !== undefined
      ? draft.tailscaleUsers
      : (Array.isArray(cfg.tailscaleAllowedUsers) ? cfg.tailscaleAllowedUsers.join(', ') : '');
  const localPairOn =
    draft.allowLocalPairingWithoutEdge !== undefined
      ? Boolean(draft.allowLocalPairingWithoutEdge)
      : cfg.allowLocalPairingWithoutEdge !== false;

  const gw = st?.gateway || {};
  let pillTone = 'muted';
  let pillText = L('未启用', 'Disabled');
  if (cfg.enabled) {
    if (gw.running && gw.healthStatus === 'edge_auth_required') {
      pillTone = 'ok';
      pillText = L(`运行中 :${gw.port || port} · 外网鉴权中`, `Running :${gw.port || port} · Edge Auth`);
    } else if (gw.running && gw.healthStatus === 'ok') {
      pillTone = 'ok';
      pillText = L(`运行中 :${gw.port || port}`, `Running :${gw.port || port}`);
    } else if (gw.running) {
      pillTone = 'warn';
      pillText = L(`网关异常 (${gw.healthStatus || 'checking'})`, `Unhealthy (${gw.healthStatus || 'checking'})`);
    } else {
      pillTone = 'warn';
      pillText = L('已启用 · 等待守护启动', 'Enabled · Waiting');
    }
  }

  const fpShort = st?.gatewayFingerprint ? st.gatewayFingerprint.slice(0, 12) : L('未生成', 'None');
  const diag = state?.remoteDiagnostics || st?.diagnostics || null;
  const diagItems = Array.isArray(diag?.items) ? diag.items.filter((x) => x && x.level !== 'info') : [];
  const diagHtml = diagItems.length
    ? `<div class="agy-ms-remote-diag-list">
        ${diagItems
          .map(
            (it) =>
              `<div class="agy-ms-remote-diag-item" data-level="${esc(it.level || 'warn')}">${esc(it.message || it.code)}</div>`
          )
          .join('')}
      </div>`
    : state?.remoteDiagnostics
      ? `<div class="agy-ms-remote-diag-list"><div class="agy-ms-remote-diag-item">${esc(
          L('✓ 网关配置、权限与构建产物检查全部通过。', '✓ All gateway config, permission & build checks passed.')
        )}</div></div>`
      : '';

  const tunnelTarget = `http://127.0.0.1:${port}`;
  let transportFieldsHtml = '';
  if (transport === 'cloudflare-access') {
    transportFieldsHtml = `
      <div class="agy-ms-field">
        <div class="agy-ms-row-title">${esc(L('公网访问域名 URL（HTTPS）', 'Public HTTPS URL'))}</div>
        <div class="agy-ms-row-desc">${esc(L('填入绑定在 Cloudflare Tunnel 上的自有域名，用于扫码链接与 Origin 白名单校验', 'Your custom Cloudflare Tunnel domain used in QR pairing URLs & Origin validation'))}</div>
        <input type="url" class="agy-ms-input" data-ms-remote-input="publicUrl" value="${esc(publicUrl)}" spellcheck="false" placeholder="https://agy.yourdomain.com" />
      </div>
      <div class="agy-ms-field">
        <div class="agy-ms-row-title">${esc(L('Cloudflare Access Team Domain', 'Cloudflare Access Team Domain'))}</div>
        <input type="text" class="agy-ms-input" data-ms-remote-input="cfAccessTeamDomain" value="${esc(cfTeam)}" spellcheck="false" placeholder="myteam.cloudflareaccess.com" />
      </div>
      <div class="agy-ms-field">
        <div class="agy-ms-row-title">${esc(L('Application AUD Tag', 'Application AUD Tag'))}</div>
        <input type="text" class="agy-ms-input" data-ms-remote-input="cfAccessAud" value="${esc(cfAud)}" spellcheck="false" placeholder="64-char Zero Trust AUD tag" />
      </div>
      <div class="agy-ms-field">
        <div class="agy-ms-remote-tunnel-hint">
          <span>${esc(L('cloudflared 本地源站地址', 'cloudflared origin'))}: <code>${esc(tunnelTarget)}</code></span>
          <button type="button" class="agy-ms-btn" data-ms-remote-action="copy-tunnel-target">${esc(L('复制', 'Copy'))}</button>
        </div>
      </div>`;
  } else if (transport === 'tailscale-serve') {
    transportFieldsHtml = `
      <div class="agy-ms-field">
        <div class="agy-ms-row-title">${esc(L('Tailscale HTTPS 地址（可选）', 'Tailscale HTTPS URL (Optional)'))}</div>
        <input type="url" class="agy-ms-input" data-ms-remote-input="publicUrl" value="${esc(publicUrl)}" spellcheck="false" placeholder="https://mac.tailnet-xxxx.ts.net" />
      </div>
      <div class="agy-ms-field">
        <div class="agy-ms-row-title">${esc(L('允许的 Tailscale 用户邮箱（逗号分隔）', 'Allowed Tailscale Users (comma-separated)'))}</div>
        <input type="text" class="agy-ms-input" data-ms-remote-input="tailscaleUsers" value="${esc(tsUsers)}" spellcheck="false" placeholder="alice@example.com" />
      </div>`;
  } else {
    transportFieldsHtml = `
      ${renderLocalSwitchRow(
        'allowLocalPairingWithoutEdge',
        'remote-local-pair',
        L('允许本机 Loopback 直接配对', 'Allow Local Loopback Pairing'),
        L('仅在通过本机浏览器或 SSH 隧道访问 http://127.0.0.1 时使用', 'For localhost browser or SSH local port-forwarding sessions'),
        localPairOn
      )}
      <div class="agy-ms-field">
        <div class="agy-ms-remote-tunnel-hint">
          <span>${esc(L('本机调试地址', 'Local URL'))}: <code>${esc(tunnelTarget)}</code></span>
          <button type="button" class="agy-ms-btn" data-ms-remote-action="copy-tunnel-target">${esc(L('复制', 'Copy'))}</button>
        </div>
      </div>`;
  }

  const pairRole = state?.remotePairRole || 'observe';
  const pairTtl = Number(state?.remotePairTtl || 120);
  const pairing = state?.remotePairing;
  let qrStageHtml = '';
  if (pairing && pairing.code && pairing.pairingUrl) {
    const isExpired = Number(pairing.expiresAt || 0) > 0 && Date.now() > Number(pairing.expiresAt);
    if (isExpired) {
      qrStageHtml = `
      <div class="agy-ms-remote-qr-stage">
        <div class="agy-ms-remote-diag-item" data-level="warn">${esc(
          L('配对二维码已过期，请点击上方按钮重新生成。', 'Pairing QR expired — generate a new code.')
        )}</div>
        <div class="agy-ms-tools" style="padding:2px 0 0;justify-content:center">
          <button type="button" class="agy-ms-btn" data-ms-remote-action="clear-pair">${esc(L('收起', 'Hide'))}</button>
        </div>
      </div>`;
    } else {
      let qrSvgHtml = '';
      try {
        qrSvgHtml = renderQrSvg(pairing.pairingUrl, { sizePx: 180, quietZone: 4 });
      } catch {
        qrSvgHtml = '';
      }
      const expStr = formatTsShort(pairing.expiresAt);
      qrStageHtml = `
      <div class="agy-ms-remote-qr-stage">
        ${qrSvgHtml ? `<div class="agy-ms-remote-qr-box">${qrSvgHtml}</div>` : ''}
        <div class="agy-ms-remote-qr-code">${esc(pairing.code)}</div>
        <div class="agy-ms-remote-qr-url">${esc(pairing.pairingUrl)}</div>
        <div class="agy-ms-row-desc" style="margin:0">${esc(
          L(
            `角色：${pairing.role === 'steer' ? '受控写 (steer)' : '只读观察 (observe)'} · 过期：${expStr}`,
            `Role: ${pairing.role} · Expires: ${expStr}`
          )
        )}</div>
        <div class="agy-ms-tools" style="padding:2px 0 0;justify-content:center">
          <button type="button" class="agy-ms-btn" data-ms-remote-action="copy-pair-url">${esc(L('复制链接', 'Copy URL'))}</button>
          <button type="button" class="agy-ms-btn" data-ms-remote-action="copy-pair-code">${esc(L('复制配对码', 'Copy Code'))}</button>
          <button type="button" class="agy-ms-btn" data-ms-remote-action="clear-pair">${esc(L('收起', 'Hide'))}</button>
        </div>
      </div>`;
    }
  }

  const activeDevices = Array.isArray(st?.devices) ? st.devices.filter((d) => !d?.revokedAt) : [];
  const revokedCount = Number(st?.revokedDeviceCount || 0);
  const devicesHtml = activeDevices.length
    ? activeDevices
        .map((d) => {
          const isSteer = d.role === 'steer' || d.role === 'admin';
          const nextRole = isSteer ? 'observe' : 'steer';
          const lastSeenStr = d.lastSeenAt ? formatTsShort(d.lastSeenAt) : L('未连接', 'Never');
          return `
            <div class="agy-ms-remote-dev-row">
              <div class="agy-ms-row-text">
                <div class="agy-ms-row-title">${esc(d.name)}</div>
                <div class="agy-ms-remote-dev-meta">
                  <span class="agy-ms-remote-role-badge">${esc(isSteer ? L('受控写 · steer', 'steer') : L('只读 · observe', 'observe'))}</span>
                  <span>${esc(L(`最近活跃 ${lastSeenStr}`, `Last seen ${lastSeenStr}`))}</span>
                </div>
              </div>
              <div class="agy-ms-remote-dev-actions">
                <button type="button" class="agy-ms-btn" data-ms-remote-device-id="${esc(d.deviceId)}" data-ms-remote-device-role="${esc(nextRole)}">${esc(
                  isSteer ? L('降为只读', 'To Observe') : L('升为协作', 'To Steer')
                )}</button>
                <button type="button" class="agy-ms-btn is-danger" data-ms-remote-revoke="${esc(d.deviceId)}">${esc(L('吊销', 'Revoke'))}</button>
              </div>
            </div>`;
        })
        .join('')
    : `<div class="agy-ms-row"><div class="agy-ms-row-desc">${esc(
        L('暂无已配对设备；点击上方生成二维码即可通过手机 Safari/Chrome 配对。', 'No paired devices yet. Generate a QR code above to pair from your phone.')
      )}</div></div>`;

  return `
      <div class="agy-ms-card">
        <div class="agy-ms-remote-hdr">
          <div class="agy-ms-row-text">
            <div class="agy-ms-row-title">${esc(L('启用远程控制网关', 'Enable Remote Gateway'))}</div>
            <div class="agy-ms-row-desc">${esc(L('仅监听 127.0.0.1 回环地址，并受 ECDSA P-256 与外网边界双重保护', 'Binds strictly to 127.0.0.1 with ECDSA P-256 & zero-trust edge auth'))}</div>
          </div>
          <button type="button" class="agy-ms-switch" role="switch" data-ms-remote-toggle="enabled" aria-label="${esc(L('启用远程控制网关', 'Enable Remote Gateway'))}" aria-checked="${cfg.enabled ? 'true' : 'false'}"><span></span></button>
        </div>
        <div class="agy-ms-remote-meta">
          <span class="agy-ms-remote-pill" data-tone="${esc(pillTone)}"><span class="agy-ms-remote-dot"></span><span>${esc(pillText)}</span></span>
          <span>${esc(L('宿主窗口', 'Hosts'))}: ${Number(st?.hostCount || 0)}</span>
          <span>${esc(L('指纹', 'FP'))}: ${esc(fpShort)}</span>
        </div>
        <div class="agy-ms-tools" style="border-top:1px solid var(--ms-border)">
          <button type="button" class="agy-ms-btn" data-ms-remote-action="refresh">${esc(L('刷新状态', 'Refresh'))}</button>
          <button type="button" class="agy-ms-btn" data-ms-remote-action="diagnose">${esc(L('运行诊断', 'Diagnostics'))}</button>
        </div>
        ${diagHtml}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('外网通道与域配置', 'Transport & Custom Domain'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-row is-stack">
          <div class="agy-ms-row-text">
            <div class="agy-ms-row-title">${esc(L('访问通道', 'Access Transport'))}</div>
            <div class="agy-ms-row-desc">${esc(L('推荐使用自有域名 + Cloudflare Tunnel，不占用手机 VPN 槽位', 'Own domain + Cloudflare Tunnel works directly in mobile Safari without a VPN slot'))}</div>
          </div>
          <div class="agy-ms-seg is-wrap" role="radiogroup" aria-label="${esc(L('访问通道', 'Access Transport'))}">
            ${[
              ['cloudflare-access', L('Cloudflare 域名', 'CF Access')],
              ['loopback', L('仅本机', 'Loopback')],
              ['tailscale-serve', 'Tailscale'],
            ]
              .map(
                ([val, lbl]) =>
                  `<button type="button" class="agy-ms-seg-btn" role="radio" data-ms-remote-transport="${esc(val)}" aria-checked="${transport === val ? 'true' : 'false'}">${esc(lbl)}</button>`
              )
              .join('')}
          </div>
        </div>
        <div class="agy-ms-field">
          <div class="agy-ms-row-title">${esc(L('本地网关端口 (127.0.0.1)', 'Loopback Port (127.0.0.1)'))}</div>
          <input type="number" class="agy-ms-input" data-ms-remote-input="port" min="1024" max="65535" value="${esc(port)}" />
        </div>
        ${transportFieldsHtml}
        <div class="agy-ms-tools" style="border-top:1px solid var(--ms-border)">
          <button type="button" class="agy-ms-btn" data-ms-remote-action="save-config">${esc(L('保存通道配置', 'Save Transport Config'))}</button>
        </div>
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('扫码与一次性配对', 'QR Pairing (Single-Use)'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-row is-stack">
          <div class="agy-ms-row-text">
            <div class="agy-ms-row-title">${esc(L('授予设备权限角色', 'Device Role'))}</div>
            <div class="agy-ms-row-desc">${esc(L('只读仅看进度与用量；受控写可审批权限、发送消息、触发 /compact', 'Observe reads status & timeline; Steer can approve actions, send & compact'))}</div>
          </div>
          <div class="agy-ms-seg is-wrap" role="radiogroup" aria-label="${esc(L('配对角色', 'Pairing Role'))}">
            ${[
              ['observe', L('只读观察 (observe)', 'Observe Only')],
              ['steer', L('受控协作 (steer)', 'Steer (Controlled Write)')],
            ]
              .map(
                ([val, lbl]) =>
                  `<button type="button" class="agy-ms-seg-btn" role="radio" data-ms-remote-pair-role="${esc(val)}" aria-checked="${pairRole === val ? 'true' : 'false'}">${esc(lbl)}</button>`
              )
              .join('')}
          </div>
        </div>
        <div class="agy-ms-row">
          <div class="agy-ms-row-text">
            <div class="agy-ms-row-title">${esc(L('配对码有效期', 'Code TTL'))}</div>
          </div>
          <div class="agy-ms-seg" role="radiogroup" aria-label="${esc(L('有效期', 'TTL'))}">
            ${[
              [60, '60s'],
              [120, '2m'],
              [300, '5m'],
            ]
              .map(
                ([sec, lbl]) =>
                  `<button type="button" class="agy-ms-seg-btn" role="radio" data-ms-remote-pair-ttl="${sec}" aria-checked="${pairTtl === sec ? 'true' : 'false'}">${esc(lbl)}</button>`
              )
              .join('')}
          </div>
        </div>
        <div class="agy-ms-tools" style="border-top:1px solid var(--ms-border)">
          <button type="button" class="agy-ms-btn" data-ms-remote-action="pair">${esc(L('生成本地二维码与配对码', 'Generate QR & Code'))}</button>
        </div>
        ${qrStageHtml}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L(`已配对设备（活跃 ${activeDevices.length}）`, `Paired Devices (${activeDevices.length} Active)`))}</div>
      <div class="agy-ms-card">
        ${devicesHtml}
        ${
          revokedCount > 0
            ? `<div class="agy-ms-row"><div class="agy-ms-row-desc">${esc(L(`另有 ${revokedCount} 台已吊销设备记录`, `${revokedCount} revoked device(s) archived`))}</div></div>`
            : ''
        }
      </div>

      <div class="agy-ms-note">${esc(
        L(
          '安全隔离：远程设备公钥、配对码与 Tunnel 配置仅保存在 ~/.gemini/antigravity/anti-claude/remote/（0600 权限），不会包含在「导出配置 JSON」中；点击吊销将立即切断设备 WebSocket 会话。',
          'Isolation: gateway identity, device keys and tunnel settings stay in ~/.gemini/antigravity/anti-claude/remote/ (0600) and are excluded from JSON exports. Revoking a device closes active WebSocket sessions immediately.'
        )
      )}</div>`;
}
