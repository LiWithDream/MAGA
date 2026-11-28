/**
 * Pure HTML Templates for AGY Studio Settings -> Version & Self-Update Card (L1).
 */
import { esc } from './constants.mjs';

const BLOCK_REASON_TEXT = {
  dirty_worktree: [
    '检测到本地工作区存在未提交改动，已禁用一键更新以免覆盖代码。',
    'Local uncommitted changes detected; one-click update is disabled.',
  ],
  linked_worktree: [
    '当前运行在 Git linked worktree 中，请从主仓库或终端手动更新。',
    'Running from a Git linked worktree; update from primary checkout or CLI.',
  ],
  non_release_branch: [
    '当前处于自定义分支（非 Release Tag / main），请使用终端手动同步。',
    'On a custom branch (neither Release Tag nor main); please update via CLI.',
  ],
  local_ahead_commits: [
    '当前 main 分支包含未推送的本地提交，已禁用一键覆盖更新。',
    'Local ahead commits detected on main; one-click update is disabled.',
  ],
  deploy_mismatch: [
    '当前部署目录与守护进程仓库不一致（preview / split-brain），请先手动对齐。',
    'Live bundle path differs from daemon repo (preview / split-brain); sync via CLI.',
  ],
  parent_dir_not_writable: [
    '安装父目录无写入权限，无法原地替换目录，请手动更新。',
    'Install parent directory is not writable; please update manually.',
  ],
  missing_release_asset: [
    '新版本对应平台的预编译包或 SHA-256 校验文件暂未就绪，请稍后再试或前往 Release 页面下载。',
    'Platform prebuilt archive or .sha256 asset is not available yet on this release.',
  ],
  unsupported_install_mode: [
    '当前目录缺少完整 Git 或预编译包结构，请使用手动安装命令更新。',
    'Unsupported install layout for in-place update; use the manual CLI command.',
  ],
};

const WORKER_ERR_TEXT = {
  rate_limited: [
    'GitHub API 请求达到每小时匿名限流，请稍后再试或使用下方手动命令。',
    'GitHub API rate limit reached; try again later or run the manual command.',
  ],
  network_timeout: [
    '连接 GitHub 超时，请检查网络或代理设置后重试。',
    'Timed out reaching GitHub; check your network or proxy settings.',
  ],
  network_error: [
    '未能连接 GitHub 检查版本，请检查网络或代理设置。',
    'Unable to reach GitHub; check your network or proxy settings.',
  ],
  worker_exited_unexpectedly: [
    '后台更新进程意外退出，请使用下方手动命令完成更新或检查状态。',
    'Background updater exited unexpectedly; finish via manual CLI command.',
  ],
  update_timed_out: [
    '后台更新等待超时，请运行 doctor 或使用手动命令检查状态。',
    'Background update timed out; check status via CLI.',
  ],
  reconnect_timeout: [
    '守护进程重启耗时较长，暂未恢复重连；若界面未自动刷新，请手动刷新或检查守护进程状态。',
    'Daemon reconnect timed out after restart; check `studio/cli.mjs doctor` if needed.',
  ],
  invalid_sha256_manifest: [
    'Release 校验文件（.sha256）格式无效，已中止更新。',
    'Invalid .sha256 manifest on release; update aborted.',
  ],
};

function mapChannelLabel(channel, L) {
  switch (channel) {
    case 'prebuilt':
      return L('预编译包', 'Prebuilt');
    case 'stable':
      return L('Stable 稳定版', 'Stable');
    case 'edge':
      return L('Edge (main)', 'Edge (main)');
    case 'custom':
      return L('自定义分支', 'Custom Branch');
    default:
      return L('本地安装', 'Local');
  }
}

function mapPhaseView(job, disconnectCount, L) {
  const phase = job?.phase || 'downloading';
  const reconnectNote =
    disconnectCount > 0 ? L(' · 等待重连…', ' · waiting to reconnect…') : '';
  switch (phase) {
    case 'downloading':
      return { pct: 22, label: L('1/4 正在下载或拉取更新…', '1/4 Downloading update…') };
    case 'verifying':
      return { pct: 42, label: L('2/4 正在校验 SHA-256 完整性…', '2/4 Verifying SHA-256 checksum…') };
    case 'staging':
    case 'applying':
      return { pct: 60, label: L('2/4 正在切换版本文件…', '2/4 Staging & applying update…') };
    case 'installing':
      return { pct: 78, label: L('3/4 正在安装依赖与同步插件…', '3/4 Installing & syncing plugins…') };
    case 'restarting':
      return {
        pct: 92,
        label:
          L('4/4 正在重启守护进程（不会关闭 Antigravity）', '4/4 Restarting daemon (Antigravity stays open)') +
          reconnectNote,
      };
    default:
      return { pct: 50, label: L('正在执行更新…', 'Updating…') };
  }
}

function safeHttpsReleaseUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.protocol === 'https:' && u.hostname === 'github.com') return u.toString();
  } catch {}
  return 'https://github.com/LiWithDream/agy-studio/releases/latest';
}

function formatErrorText(code, rawMessage, L) {
  if (code && WORKER_ERR_TEXT[code]) {
    const [zh, en] = WORKER_ERR_TEXT[code];
    return L(zh, en);
  }
  const msg = String(rawMessage || code || 'unknown_error');
  if (msg.startsWith('sha256_mismatch')) {
    return L('下载包 SHA-256 校验不匹配，已阻止安装。', 'Downloaded archive SHA-256 mismatch; installation blocked.');
  }
  return L(`更新失败：${msg}`, `Update failed: ${msg}`);
}

export function renderUpdateCard(state, L) {
  const info = state?.updateVersionInfo || null;
  const local = state?.updateCheck?.local || info?.local || null;
  const checkRes = state?.updateCheck || null;
  const check = checkRes?.ok ? checkRes.check : null;
  const job = state?.updateJob !== undefined ? state.updateJob : info?.status || null;
  const inProgress = Boolean(job?.inProgress);
  const checking = Boolean(state?.updateChecking);

  const verStr = local?.version && local.version !== '0.0.0' ? `v${local.version}` : '—';
  const channel = local?.channel || 'unknown';
  const channelLabel = mapChannelLabel(channel, L);
  const subMeta =
    channel === 'edge' && local?.shortSha
      ? `${L('当前提交', 'Commit')} ${local.shortSha}`
      : local?.releaseTag
        ? `${L('标签', 'Tag')} ${local.releaseTag}`
        : L('仅点击按钮时联网检测，绝不后台轮询', 'Manual check only; never polls in background');

  const releaseUrl = safeHttpsReleaseUrl(
    check?.releasePageUrl || checkRes?.releasePageUrl || info?.releasePageUrl
  );

  let detailHtml = '';

  if (inProgress) {
    const pv = mapPhaseView(job, Number(state?.updateDisconnectCount || 0), L);
    detailHtml = `
      <div class="agy-ms-upd-panel">
        <div class="agy-ms-upd-phase-row">
          <span>${esc(pv.label)}</span>
          <span class="agy-ms-upd-pct">${pv.pct}%</span>
        </div>
        <div class="agy-ms-upd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pv.pct}">
          <div class="agy-ms-upd-bar-fill" style="width:${pv.pct}%"></div>
        </div>
      </div>`;
  } else if (job?.phase === 'succeeded') {
    const targetText =
      job.installMode === 'git-edge' && job.targetSha
        ? `main (${job.targetSha.slice(0, 7)})`
        : `v${job.toVersion || local?.version || ''}`;
    detailHtml = `
      <div class="agy-ms-upd-panel is-ok">
        <div class="agy-ms-upd-status-title">${esc(L(`✓ 已更新至 ${targetText}`, `✓ Updated to ${targetText}`))}</div>
        <div class="agy-ms-row-desc">${esc(L('界面与守护进程已同步至最新版本，无需重启 Antigravity。', 'UI and daemon are synced; no Antigravity restart needed.'))}</div>
      </div>`;
  } else if (job?.phase === 'failed') {
    const errText = formatErrorText(job.error, job.error, L);
    detailHtml = `
      <div class="agy-ms-upd-panel is-err">
        <div class="agy-ms-upd-status-title">${esc(errText)}</div>
        ${
          job.rolledBack
            ? `<div class="agy-ms-upd-rollback">${esc(L('✓ 已自动回滚至更新前版本', '✓ Rolled back cleanly to previous version'))}</div>`
            : ''
        }
        <div class="agy-ms-upd-actions">
          <button type="button" class="agy-ms-btn" data-ms-action="update-copy-cmd">${esc(L('复制更新命令', 'Copy Command'))}</button>
          <a class="agy-ms-btn agy-ms-upd-link" href="${esc(releaseUrl)}" target="_blank" rel="noopener noreferrer">${esc(L('查看 Release', 'View Release'))}</a>
        </div>
      </div>`;
  } else if (checkRes && !checkRes.ok) {
    const errText = formatErrorText(checkRes.error, checkRes.message, L);
    detailHtml = `
      <div class="agy-ms-upd-panel is-warn">
        <div class="agy-ms-upd-status-title">${esc(errText)}</div>
        <div class="agy-ms-upd-actions">
          <button type="button" class="agy-ms-btn" data-ms-action="update-copy-cmd">${esc(L('复制更新命令', 'Copy Command'))}</button>
          <a class="agy-ms-btn agy-ms-upd-link" href="${esc(releaseUrl)}" target="_blank" rel="noopener noreferrer">${esc(L('查看 Release', 'View Release'))}</a>
        </div>
      </div>`;
  } else if (check && !check.updateAvailable) {
    const extraHint =
      check.channel === 'edge' && check.latestTag
        ? L(`主分支已是最新 · 最近正式版 ${check.latestTag}`, `main is up to date · Latest Release ${check.latestTag}`)
        : L('当前已运行最新可用版本。', 'You are already running the latest version.');
    detailHtml = `
      <div class="agy-ms-upd-panel is-ok">
        <div class="agy-ms-upd-status-title">${esc(L(`✓ 已是最新版本 (${verStr})`, `✓ Up to date (${verStr})`))}</div>
        <div class="agy-ms-row-desc">${esc(extraHint)}</div>
      </div>`;
  } else if (check && check.updateAvailable) {
    const elig = checkRes?.eligibility || info?.eligibility || { canSelfUpdate: false, blockReason: 'unsupported_install_mode' };
    const headline =
      check.channel === 'edge'
        ? L(
            `发现新提交：${local?.shortSha || 'HEAD'} → ${check.targetShortSha || 'origin/main'}${check.behindCount ? `（落后 ${check.behindCount} 个提交）` : ''}`,
            `New commits on main: ${local?.shortSha || 'HEAD'} → ${check.targetShortSha || 'origin/main'}${check.behindCount ? ` (${check.behindCount} behind)` : ''}`
          )
        : L(`发现新版本：${verStr} → v${check.latestVersion}`, `Update available: ${verStr} → v${check.latestVersion}`);

    const edgeReleaseRef =
      check.channel === 'edge' && check.latestTag
        ? `<div class="agy-ms-row-desc">${esc(L(`最近正式版：${check.latestTag}`, `Latest Release: ${check.latestTag}`))}</div>`
        : '';

    const notesHtml =
      Array.isArray(check.notes) && check.notes.length > 0
        ? `<ul class="agy-ms-upd-notes">${check.notes.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`
        : '';

    const reasonPair = !elig.canSelfUpdate ? BLOCK_REASON_TEXT[elig.blockReason] || BLOCK_REASON_TEXT.unsupported_install_mode : null;
    const blockHtml = reasonPair
      ? `<div class="agy-ms-upd-reason">${esc(L(reasonPair[0], reasonPair[1]))}</div>`
      : '';

    const primaryBtnLabel =
      check.channel === 'edge'
        ? L('一键同步更新', 'Update Now')
        : L(`一键更新到 v${check.latestVersion}`, `Update to v${check.latestVersion}`);

    const actionsHtml = elig.canSelfUpdate
      ? `<div class="agy-ms-upd-actions">
           <button type="button" class="agy-ms-btn is-primary" data-ms-action="update-arm">${esc(primaryBtnLabel)}</button>
           <button type="button" class="agy-ms-btn" data-ms-action="update-copy-cmd">${esc(L('复制命令', 'Copy Command'))}</button>
           <a class="agy-ms-btn agy-ms-upd-link" href="${esc(releaseUrl)}" target="_blank" rel="noopener noreferrer">${esc(L('查看 Release', 'Release Notes'))}</a>
         </div>
         ${
           state?.updateArmed
             ? `<div class="agy-ms-upd-confirm">
                  <span>${esc(L('将更新 AGY Studio 并短暂重启守护进程（不会关闭 Antigravity），确认继续？', 'Update AGY Studio and briefly restart its daemon (Antigravity stays open)?'))}</span>
                  <span style="display:inline-flex;gap:6px;flex-shrink:0">
                    <button type="button" class="agy-ms-btn" data-ms-action="update-cancel">${esc(L('取消', 'Cancel'))}</button>
                    <button type="button" class="agy-ms-btn is-primary" data-ms-action="update-confirm">${esc(L('确认更新', 'Confirm Update'))}</button>
                  </span>
                </div>`
             : ''
         }`
      : `<div class="agy-ms-upd-actions">
           <button type="button" class="agy-ms-btn" data-ms-action="update-copy-cmd">${esc(L('复制更新命令', 'Copy Command'))}</button>
           <a class="agy-ms-btn agy-ms-upd-link" href="${esc(releaseUrl)}" target="_blank" rel="noopener noreferrer">${esc(L('查看 Release', 'View Release'))}</a>
         </div>`;

    detailHtml = `
      <div class="agy-ms-upd-panel">
        <div class="agy-ms-upd-status-title">${esc(headline)}</div>
        ${edgeReleaseRef}
        ${notesHtml}
        ${blockHtml}
        ${actionsHtml}
      </div>`;
  }

  return `
      <div class="agy-ms-sec-hdr">${esc(L('版本与更新', 'Version & Updates'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-upd-hdr">
          <div class="agy-ms-row-text">
            <div class="agy-ms-upd-title-line">
              <span class="agy-ms-row-title">AGY Studio ${esc(verStr)}</span>
              <span class="agy-ms-upd-badge" data-channel="${esc(channel)}">${esc(channelLabel)}</span>
            </div>
            <div class="agy-ms-row-desc">${esc(subMeta)}</div>
          </div>
          <button type="button" class="agy-ms-btn" data-ms-action="update-check"${checking || inProgress ? ' disabled' : ''}>${esc(
            checking ? L('检查中…', 'Checking…') : L('检查更新', 'Check Updates')
          )}</button>
        </div>
        ${detailHtml}
      </div>`;
}
