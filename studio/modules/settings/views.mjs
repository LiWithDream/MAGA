/**
 * Pure HTML View Templates for MAGA Settings (L1 Overview -> L2/L3 Drill-down Pages).
 */
import {
  CAT_ICONS,
  ORCH_MINI_ICONS,
  SVG_CHEV_R,
  TIER_NAMES,
  TIER_ORDER,
  esc,
} from './constants.mjs';
import { getRemoteL1Summary } from './remote-view.mjs';

export function getHostExecutorSummary(catalog, val, L) {
  if (val && val !== 0) {
    const hit = catalog.executors.find((e) => e.value === val);
    if (hit) return hit.label.replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, '');
  }
  return L('默认执行器', 'Default exec');
}

export function getViewMeta(view, L) {
  switch (view) {
    case 'l1':
      return { title: L('AGY Studio 设置', 'AGY Studio Settings'), parent: '' };
    case 'models':
      return { title: L('模型与思考', 'Models & Thinking'), parent: L('AGY Studio 设置', 'AGY Studio') };
    case 'models-tiers':
      return { title: L('按家族默认思考档位', 'Default Tier by Family'), parent: L('模型与思考', 'Models') };
    case 'models-hidden':
      return { title: L('隐藏不常用模型', 'Hidden Models'), parent: L('模型与思考', 'Models') };
    case 'models-opus-gate':
      return { title: L('审查关卡', 'Review Gate'), parent: L('模型与思考', 'Models') };
    case 'models-theme':
      return { title: L('Effort Bar 与主题皮肤', 'Effort Bar & Themes'), parent: L('模型与思考', 'Models') };
    case 'stream':
      return { title: L('对话与过程流', 'Conversation & Stream'), parent: L('AGY Studio 设置', 'AGY Studio') };
    case 'stream-auto-compact':
      return { title: L('智能压缩上下文', 'Auto-Compact'), parent: L('对话与过程流', 'Conversation & Stream') };
    case 'workspace':
      return { title: L('工作区与面板', 'Workspace & Panels'), parent: L('AGY Studio 设置', 'AGY Studio') };
    case 'workspace-ai-suggestions':
      return { title: L('AI 对话建议', 'AI Chat Suggestions'), parent: L('工作区与面板', 'Workspace & Panels') };
    case 'workspace-git-workflow':
      return { title: L('Git 并行工作流', 'Git Workflow'), parent: L('工作区与面板', 'Workspace & Panels') };
    case 'remote':
      return { title: L('远程控制', 'Remote Control'), parent: L('AGY Studio 设置', 'AGY Studio') };
    case 'appearance':
      return { title: L('语言与外观', 'Language & Appearance'), parent: L('AGY Studio 设置', 'AGY Studio') };
    default:
      return { title: L('AGY Studio 设置', 'AGY Studio Settings'), parent: '' };
  }
}

export function renderSwitchRow(key, kind, title, desc, checked) {
  return `
      <div class="agy-ms-row">
        <div class="agy-ms-row-text">
          <div class="agy-ms-row-title">${esc(title)}</div>
          ${desc ? `<div class="agy-ms-row-desc">${esc(desc)}</div>` : ''}
        </div>
        <button type="button" class="agy-ms-switch" role="switch" data-ms-kind="${kind}" data-ms-key="${esc(key)}" aria-label="${esc(title)}" aria-checked="${checked ? 'true' : 'false'}"><span></span></button>
      </div>`;
}

export function renderSegRow(key, kind, title, desc, options, activeVal, wrap = false) {
  return `
      <div class="agy-ms-row${wrap ? ' is-stack' : ''}">
        <div class="agy-ms-row-text">
          <div class="agy-ms-row-title">${esc(title)}</div>
          ${desc ? `<div class="agy-ms-row-desc">${esc(desc)}</div>` : ''}
        </div>
        <div class="agy-ms-seg${wrap ? ' is-wrap' : ''}" role="radiogroup" aria-label="${esc(title)}">
          ${options
            .map(
              ([val, lbl]) =>
                `<button type="button" class="agy-ms-seg-btn" role="radio" data-ms-seg-kind="${kind}" data-ms-seg-key="${esc(key)}" data-ms-seg-val="${esc(val)}" aria-checked="${activeVal === val ? 'true' : 'false'}">${esc(lbl)}</button>`
            )
            .join('')}
        </div>
      </div>`;
}

export function renderDrillRow(targetView, title, desc, summary) {
  return `
      <button type="button" class="agy-ms-drill" data-ms-nav="${esc(targetView)}">
        <div class="agy-ms-row-text">
          <div class="agy-ms-row-title">${esc(title)}</div>
          ${desc ? `<div class="agy-ms-row-desc">${esc(desc)}</div>` : ''}
        </div>
        <span class="agy-ms-drill-end">
          <span class="agy-ms-summary">${esc(summary)}</span>
          ${SVG_CHEV_R}
        </span>
      </button>`;
}

export function renderOptGroup(key, title, options, activeVal, cols, withOrchIcon = false) {
  return `
      <div class="agy-ms-opt-group" data-opt-group="${esc(key)}">
        <div class="agy-ms-opt-label">${esc(title)}</div>
        <div class="agy-ms-opt-grid" data-cols="${cols}" role="radiogroup" aria-label="${esc(title)}">
          ${options
            .map(([val, lbl]) => {
              const iconHtml = withOrchIcon && ORCH_MINI_ICONS[val] ? ORCH_MINI_ICONS[val] : '';
              return `<button type="button" class="agy-ms-opt" role="radio" data-ms-seg-kind="studio" data-ms-seg-key="${esc(key)}" data-ms-seg-val="${esc(val)}" aria-checked="${activeVal === val ? 'true' : 'false'}">${iconHtml}<span>${esc(lbl)}</span></button>`;
            })
            .join('')}
        </div>
      </div>`;
}

export function renderL1(p, base, catalog, { studioPrefs, state, L }) {
  const execVal = studioPrefs.getHostPref('orchestratorExecutorModel');
  const hiddenCount = p.customizeModelList ? p.hiddenModels.length : 0;
  const modelsSummary = `${getHostExecutorSummary(catalog, execVal, L)}${
    hiddenCount > 0 ? ` · ${L(`隐藏 ${hiddenCount}`, `${hiddenCount} hidden`)}` : ''
  }`;

  const stepMode = studioPrefs.getStepStreamMode();
  const streamSummary = `${
    p.hideThinkingProse ? L('隐藏思考正文', 'Thought hidden') : L('显示思考正文', 'Thought shown')
  } · ${stepMode === 'expanded' ? L('步骤展开', 'Expanded') : L('步骤紧凑', 'Compact')}`;

  const wsSummary = `${
    p.overviewUsageEnabled ? L('用量开', 'Usage on') : L('用量关', 'Usage off')
  } · ${
    base.modules?.claudeUxHideSidebarProjects === true ? L('最近对话', 'Recents') : L('原生分组', 'Native')
  }`;

  const motionLabels = { full: L('完整', 'Full'), reduced: L('精简', 'Reduced'), off: L('关闭', 'Off') };
  const appSummary = `${base.modules?.i18n ? '中文' : 'EN'} · ${base.cjkFontScale || '95'}% · ${motionLabels[p.motionLevel] || 'Full'}`;

  const remoteSummary = getRemoteL1Summary(state, L);
  const cats = [
    ['models', L('模型与思考', 'Models & Thinking'), L('胶囊显示、家族档位、隐藏模型、主题与执行器', 'Capsule UI, family tiers, hidden list, themes & executor'), modelsSummary],
    ['stream', L('对话与过程流', 'Conversation & Stream'), L('思考正文显隐、步骤流模式、恢复提示与代码折叠', 'Thinking prose, step flow, resume banner & code fold'), streamSummary],
    ['workspace', L('工作区与面板', 'Workspace & Panels'), L('用量统计、子代理胶囊、侧栏与项目增强', 'Usage card, subagents, sidebar & Projects'), wsSummary],
    ['remote', L('远程控制', 'Remote Control'), L('本机网关开关、Cloudflare 域通道、扫码配对与设备吊销', 'Gateway switch, Cloudflare tunnel, QR pairing & devices'), remoteSummary],
    ['appearance', L('语言与外观', 'Language & Appearance'), L('界面语言、中文字体字高与动效强度', 'UI language, CJK optical scale & motion'), appSummary],
  ];

  return `
      <div class="agy-ms-card">
        ${cats
          .map(
            ([id, title, desc, sum]) => `
          <button type="button" class="agy-ms-cat" data-ms-nav="${id}">
            <span class="agy-ms-cat-main">
              <span class="agy-ms-cat-ico">${CAT_ICONS[id] || ''}</span>
              <span class="agy-ms-row-text">
                <span class="agy-ms-row-title" style="display:block">${esc(title)}</span>
                <span class="agy-ms-row-desc" style="display:block">${esc(desc)}</span>
              </span>
            </span>
            <span class="agy-ms-drill-end">
              <span class="agy-ms-summary">${esc(sum)}</span>
              ${SVG_CHEV_R}
            </span>
          </button>`
          )
          .join('')}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('配置管理', 'Configuration'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-tools">
          <button type="button" class="agy-ms-btn" data-ms-action="export">${esc(L('导出配置', 'Export JSON'))}</button>
          <button type="button" class="agy-ms-btn" data-ms-action="import">${esc(L('导入配置', 'Import JSON'))}</button>
          <button type="button" class="agy-ms-btn is-danger" data-ms-action="reset-arm" style="margin-left:auto">${esc(L('恢复默认', 'Reset Defaults'))}</button>
          <input type="file" data-ms-file-input accept="application/json,.json" hidden />
          ${
            state.resetArmed
              ? `<div class="agy-ms-reset-confirm">
                  <span>${esc(L('确认将 AGY Studio、外观与默认模型恢复为出厂推荐设置？', 'Reset all AGY Studio, layout & host model preferences to defaults?'))}</span>
                  <span style="display:inline-flex;gap:6px;flex-shrink:0">
                    <button type="button" class="agy-ms-btn" data-ms-action="reset-cancel">${esc(L('取消', 'Cancel'))}</button>
                    <button type="button" class="agy-ms-btn is-danger-solid" data-ms-action="reset-confirm">${esc(L('确认重置', 'Confirm Reset'))}</button>
                  </span>
                </div>`
              : ''
          }
        </div>
      </div>

      <div class="agy-ms-foot-meta">
        <span>AGY Studio · agy-studio</span>
        <span>${esc(L('改动即时生效并自动保存', 'Instant & persistent'))}</span>
      </div>`;
}

export function renderL2Models(p, catalog, { studioPrefs, state, L, renderCapsulePreviewHtml }) {
  const hostStoreReady = Boolean(studioPrefs.discoverHostPrefStore());
  const execVal = studioPrefs.getHostPref('orchestratorExecutorModel') ?? 0;

  const execOpts = [
    { value: 0, label: L('跟随系统默认', 'System Default') },
    ...catalog.executors,
  ];
  if (execVal && !execOpts.some((o) => o.value === execVal)) {
    execOpts.push({ value: execVal, label: `${L('模型', 'Model')} #${execVal}` });
  }

  const tierCount = Object.keys(p.defaultTierByFamily || {}).length;
  const hiddenSum = p.customizeModelList
    ? L(`隐藏 ${p.hiddenModels.length} 项`, `${p.hiddenModels.length} hidden`)
    : L('全部显示', 'All shown');
  const opusModeLbl =
    p.opusGateMode === 'auto'
      ? L('受控自动', 'Auto')
      : p.opusGateMode === 'off'
        ? L('关闭', 'Off')
        : L('半自动', 'Semi-auto');
  const modelLbl = p.opusGateModel === 'carbon' ? 'Carbon High' : 'Opus High';
  const opusSum =
    p.opusGateMode === 'off'
      ? opusModeLbl
      : `${modelLbl} · ${opusModeLbl} · 5h≥${p.opusGateMinQuota5hPct ?? 20}%`;

  const capsuleTabHtml = `
      ${renderSwitchRow('showEffortBar', 'studio', L('显示思考强度条 (Effort Bar)', 'Show Effort Slider Bar'), L('打开模型菜单时显示顶部连续思考强度滑块与 Orchestrator 开关', 'Displays the interactive effort slider & Orchestrator toggle'), p.showEffortBar)}
      ${renderSwitchRow('showModelDots', 'studio', L('显示模型品牌色点', 'Show Model Accent Dots'), L('在底栏胶囊与菜单行前显示模型品牌识别圆点', 'Shows brand-colored accent dot beside model names'), p.showModelDots)}
      ${renderSwitchRow('hideModelTags', 'studio', L('隐藏角标标签 (New / Leaving Soon)', 'Hide Model Badges'), L('精简模型菜单中的辅助营销/下线角标', 'Hides New / Leaving Soon tag pills in model menu'), p.hideModelTags)}
      ${renderSwitchRow('hideDefaultEffort', 'studio', L('精简默认档位辅助文字', 'Hide Default Effort Sub-labels'), L('保持菜单行干净，仅在需要时展示次级档位文本', 'Keeps menu rows clean without extra effort tag pills'), p.hideDefaultEffort)}`;

  const showGemini = p.effortTheme === 'auto' || p.effortTheme === 'gemini';
  const showClaude = p.effortTheme === 'auto' || p.effortTheme === 'claude';
  const showCodex = p.effortTheme === 'codex';

  const sliderTabHtml = [
    renderOptGroup(
      'effortTheme',
      L('样式模式', 'Theme Mode'),
      [
        ['auto', L('跟随模型', 'Follow')],
        ['gemini', 'Gemini'],
        ['claude', 'Claude'],
        ['codex', 'Codex'],
      ],
      p.effortTheme,
      4
    ),
    showGemini
      ? renderOptGroup(
          'geminiTheme',
          L('Gemini 主题', 'Gemini Theme'),
          [
            ['physical', L('物理本征', 'Physical')],
            ['ribbon', L('丝滑光带', 'Ribbon')],
            ['nebula', L('星云粒子', 'Nebula')],
          ],
          p.geminiTheme,
          3
        )
      : '',
    showClaude
      ? renderOptGroup(
          'claudeTheme',
          L('Claude 主题', 'Claude Theme'),
          [
            ['matrix', L('像素矩阵', 'Matrix')],
            ['bars', L('诗行织纹', 'Verse weave')],
            ['spark', L('星芒散落', 'Starburst')],
          ],
          p.claudeTheme,
          3
        )
      : '',
    showCodex
      ? renderOptGroup(
          'codexTheme',
          L('Codex 主题', 'Codex Theme'),
          [
            ['nebula', L('星云充能', 'Nebula')],
            ['beam', L('流光边界', 'Border beam')],
            ['orb', L('液态流珠', 'Liquid orb')],
          ],
          p.codexTheme,
          3
        )
      : '',
    renderOptGroup(
      'effortTicks',
      L('已到达档位刻度点', 'Reached Tier Marks'),
      [
        ['highlight', L('亮白显示', 'Bright')],
        ['dim', L('全部同色', 'Dim')],
        ['hidden', L('隐藏', 'Hidden')],
      ],
      p.effortTicks,
      3
    ),
  ].join('');

  const orchTabHtml = [
    renderOptGroup(
      'orchestratorMode',
      L('动效模式', 'Effect Mode'),
      [
        ['follow', L('跟随主题', 'Follow theme')],
        ['dock', L('指挥舱', 'Command dock')],
        ['custom3d', L('指定样式', 'Custom')],
      ],
      p.orchestratorMode,
      3
    ),
    p.orchestratorMode === 'custom3d'
      ? renderOptGroup(
          'orchestrator3dStyle',
          L('指定样式', 'Custom Style'),
          [
            ['chamber', L('磁约束腔', 'Chamber')],
            ['helix', L('螺旋星流', 'Helix')],
            ['orbital', L('双核星轨', 'Orbital')],
            ['c-matrix', L('曲面点阵', 'Matrix 3D')],
            ['c-louver', L('动态光栅', 'Louver')],
            ['c-spark', L('✦ 星花轨', '✦ Spark')],
            ['nebula', L('星云充能', 'Nebula')],
            ['beam', L('流光边界', 'Border beam')],
            ['orb', L('液态流珠', 'Liquid orb')],
          ],
          p.orchestrator3dStyle,
          3
        )
      : '',
    renderOptGroup(
      'orchestratorIcon',
      L('Orchestrator 图标', 'Orchestrator Icon'),
      [
        ['prism', L('棱镜分流', 'Prism')],
        ['gravity', L('引力核心', 'Gravity')],
        ['semicircle', L('扇形声部', 'Fan')],
        ['none', L('无', 'None')],
      ],
      p.orchestratorIcon,
      2,
      true
    ),
  ].join('');

  const activeTabHtml =
    state.fxStudioTab === 'slider' ? sliderTabHtml : state.fxStudioTab === 'orch' ? orchTabHtml : capsuleTabHtml;

  return `
      <div class="agy-ms-sec-hdr">${esc(L('胶囊与视觉主题', 'Capsule & Visual Themes'))}</div>
      <div class="agy-ms-card">
        ${renderCapsulePreviewHtml(p)}
        <div class="agy-ms-card-tabs">
          <div class="agy-ms-tabs is-3" role="tablist" aria-label="${esc(L('胶囊与主题配置分页', 'Capsule & theme tabs'))}">
            <button type="button" class="agy-ms-tab" role="tab" data-ms-studio-tab="capsule" aria-selected="${state.fxStudioTab === 'capsule' ? 'true' : 'false'}">${esc(L('胶囊显示', 'Capsule'))}</button>
            <button type="button" class="agy-ms-tab" role="tab" data-ms-studio-tab="slider" aria-selected="${state.fxStudioTab === 'slider' ? 'true' : 'false'}">${esc(L('滑条样式', 'Slider'))}</button>
            <button type="button" class="agy-ms-tab" role="tab" data-ms-studio-tab="orch" aria-selected="${state.fxStudioTab === 'orch' ? 'true' : 'false'}">Orchestrator</button>
          </div>
        </div>
        ${activeTabHtml}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('档位与模型列表', 'Tiers & Model List'))}</div>
      <div class="agy-ms-card">
        ${renderDrillRow(
          'models-tiers',
          L('按模型家族默认思考档位', 'Default Tier by Model Family'),
          L('在模型菜单切换不同家族时默认选中的思考强度', 'Initial effort tier when picking a model family'),
          L(`已设 ${tierCount} 项`, `${tierCount} set`)
        )}
        ${renderDrillRow(
          'models-hidden',
          L('隐藏不常用模型', 'Hide Unused Models'),
          L('动态勾选账号模型即可在底部选择器中隐藏', 'Hide rarely used models from the bottom picker'),
          hiddenSum
        )}
        ${renderDrillRow(
          'models-opus-gate',
          L('审查关卡 (Review Gate)', 'Review Gate'),
          L('在方案定型、高风险改动、连续报错与收尾节点调度 Carbon High 或 Opus High 把关，支持分池配额熔断', 'Quota-guarded Carbon High / Opus High checkpoints via /swarm'),
          opusSum
        )}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('Orchestrator 执行器（重启持久保留）', 'Orchestrator Executor (Persistent)'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-row is-stack">
          <div class="agy-ms-row-text">
            <div class="agy-ms-row-title">${esc(L('Orchestrator 执行器模型', 'Orchestrator Executor Model'))}</div>
            <div class="agy-ms-row-desc">${esc(L('开启 Orchestrator 开关后，负责执行搜索、编辑、构建与验证步骤的轻量模型', 'Faster model handling routine execution steps when Orchestrator is enabled'))}</div>
          </div>
          <select class="agy-ms-select" data-ms-host="orchestratorExecutorModel" ${!hostStoreReady ? 'disabled' : ''}>
            ${execOpts
              .map(
                (o) =>
                  `<option value="${o.value}" ${Number(execVal) === Number(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`
              )
              .join('')}
          </select>
        </div>
      </div>`;
}

export function renderL3ModelTiers(p, catalog, { L }) {
  const multiFamilies = catalog.families.filter((f) => f.isMultiTier);
  const tierMap = p.defaultTierByFamily || {};
  if (!multiFamilies.length) {
    return `<div class="agy-ms-card"><div class="agy-ms-row"><div class="agy-ms-row-desc">${esc(
      L('当前页面暂无模型列表信息，请先打开任意对话视图后再试。', 'No model catalog cached yet. Open any conversation view once to load your account models.')
    )}</div></div></div>`;
  }

  const rows = multiFamilies
    .map((fam) => {
      const seenTiers = new Set(fam.items.map((i) => i.tier).filter(Boolean));
      const tiers = TIER_ORDER.filter((t) => seenTiers.has(t));
      const curTier =
        (typeof tierMap[fam.name] === 'string' && seenTiers.has(tierMap[fam.name].toLowerCase())
          ? tierMap[fam.name].toLowerCase()
          : '') || (/\bneon\b/i.test(fam.name) && seenTiers.has('high') ? 'high' : seenTiers.has('medium') ? 'medium' : tiers[0]);
      return renderSegRow(
        fam.name,
        'tier',
        fam.name,
        '',
        tiers.map((t) => [t, TIER_NAMES[t] || t]),
        curTier,
        true
      );
    })
    .join('');

  return `
      <div class="agy-ms-card">
        <div class="agy-ms-toolbar">
          <span class="agy-ms-row-desc" style="margin:0">${esc(L('点击模型家族行时的默认档位', 'Default tier when clicking a family row'))}</span>
          <button type="button" class="agy-ms-link-btn" data-ms-action="reset-tiers">${esc(L('恢复推荐', 'Reset'))}</button>
        </div>
        ${rows}
      </div>`;
}

export function renderL3HiddenModels(p, catalog, { L }) {
  const hiddenSet = new Set(p.hiddenModels || []);
  const allFamilies = catalog.families || [];
  const listHtml = allFamilies.length
    ? allFamilies
        .map((fam) => {
          const key = fam.displayName;
          const isHidden = hiddenSet.has(key);
          return `
              <button type="button" class="agy-ms-model-item" data-ms-hide-model="${esc(key)}" aria-pressed="${isHidden ? 'true' : 'false'}">
                <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(key)}</span>
                <span class="agy-ms-model-badge">${esc(isHidden ? L('已隐藏', 'Hidden') : L('显示中', 'Visible'))}</span>
              </button>`;
        })
        .join('')
    : `<div class="agy-ms-row"><div class="agy-ms-row-desc">${esc(
        L('暂无模型目录缓存，请先打开任意对话视图。', 'No model list cached yet. Open any conversation view first.')
      )}</div></div>`;

  return `
      <div class="agy-ms-card">
        ${renderSwitchRow('customizeModelList', 'studio', L('启用隐藏模型过滤', 'Enable Model Hiding'), L('关闭后暂时展示全部模型，保留以下勾选记录', 'Temporarily show all models while preserving selections'), p.customizeModelList)}
      </div>
      <div class="agy-ms-card">
        <div class="agy-ms-toolbar">
          <span class="agy-ms-row-desc" style="margin:0">${esc(L(`已隐藏 ${hiddenSet.size} / ${allFamilies.length}`, `Hidden ${hiddenSet.size} / ${allFamilies.length}`))}</span>
          <button type="button" class="agy-ms-link-btn" data-ms-action="show-all-models">${esc(L('全部显示', 'Show All'))}</button>
        </div>
        ${listHtml}
      </div>`;
}

export function renderL3OpusGate(p, { L }) {
  const cp = p.opusGateCheckpoints || { plan: true, risk: true, debug: true, stop: true };
  const selectedModel = p.opusGateModel === 'carbon' ? 'carbon' : 'opus';
  const poolName = selectedModel === 'carbon' ? 'Gemini' : 'Claude';
  return `
      <div class="agy-ms-sec-hdr">${esc(L('协同策略', 'Orchestration Policy'))}</div>
      <div class="agy-ms-card">
        ${renderSegRow(
          'opusGateMode',
          'studio',
          L('工作模式', 'Gate Mode'),
          L('半自动仅在命中关键节点时于底栏温和提示；受控自动在所选模型配额健康时通过 /swarm 直接唤起审查', 'Semi-auto proposes in dock; Auto triggers /swarm review within quota limits'),
          [
            ['off', L('关闭', 'Off')],
            ['semi', L('半自动', 'Semi-auto')],
            ['auto', L('受控自动', 'Auto')],
          ],
          p.opusGateMode || 'semi'
        )}
        ${renderSegRow(
          'opusGateModel',
          'studio',
          L('审查模型 (锁定 High)', 'Review Model (High)'),
          L('选择关键节点把关模型（固定 High 思考档位）；配额熔断自动跟随所选模型的配额池', 'Choose checkpoint reviewer (locked to High effort); quota breaker follows its pool'),
          [
            ['carbon', 'Carbon High'],
            ['opus', 'Opus High'],
          ],
          selectedModel
        )}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('关键把关节点', 'Checkpoint Triggers'))}</div>
      <div class="agy-ms-card">
        ${renderSwitchRow('plan', 'opus-cp', L('方案定型门禁', 'Plan Gate'), L('复杂改造前由审查模型评审架构与边界', 'Review architecture & invariants before large edits'), cp.plan !== false)}
        ${renderSwitchRow('risk', 'opus-cp', L('高风险改动审计', 'Risk Diff Gate'), L('触及核心调度器、Daemon、构建或安全路径时审计', 'Audit edits touching kernel, daemon, build, or security paths'), cp.risk !== false)}
        ${renderSwitchRow('debug', 'opus-cp', L('连续报错升级排障', 'Debug Escalation'), L('命令连续失败 2 次以上时调度审查模型定位根因', 'Escalate to reviewer after >=2 consecutive command errors'), cp.debug !== false)}
        ${renderSwitchRow('stop', 'opus-cp', L('收尾 / 发布前终审', 'Pre-Stop Final Audit'), L('改动规模较大且准备结束前做只读 P0/P1/P2 终审', 'Read-only final audit on substantial diffs before stopping'), cp.stop !== false)}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('配额熔断与限流', 'Quota Circuit Breaker'))}</div>
      <div class="agy-ms-card">
        ${renderSegRow(
          'opusGateMinQuota5hPct',
          'studio-num',
          L(`${poolName} 5h 熔断水位`, `${poolName} 5h Floor`),
          L(`低于当前审查模型 (${poolName}) 5h 剩余百分比时暂停自动拉起，仅保留手动入口`, `Pause auto-triggers below this ${poolName} 5h remaining %`),
          [
            ['10', '10%'],
            ['20', '20%'],
            ['30', '30%'],
            ['40', '40%'],
          ],
          String(p.opusGateMinQuota5hPct ?? 20)
        )}
        ${renderSegRow(
          'opusGateMinQuotaWeeklyPct',
          'studio-num',
          L(`${poolName} 周配额熔断水位`, `${poolName} Weekly Floor`),
          L(`低于当前审查模型 (${poolName}) 周剩余百分比时暂停自动拉起`, `Pause auto-triggers below this ${poolName} weekly remaining %`),
          [
            ['10', '10%'],
            ['15', '15%'],
            ['25', '25%'],
          ],
          String(p.opusGateMinQuotaWeeklyPct ?? 15)
        )}
        ${renderSegRow(
          'opusGateMaxAutoPerSession',
          'studio-num',
          L('单会话自动把关上限', 'Max Auto Calls / Session'),
          L('单次审查固定使用 High 档位，建议保持上限 ≤ 2 以防配额过快消耗', 'High-effort audits only; caps automatic checkpoints per conversation'),
          [
            ['1', '1'],
            ['2', '2'],
            ['3', '3'],
          ],
          String(p.opusGateMaxAutoPerSession ?? 2)
        )}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('原生插件与手动触发', 'Native Plugin & Manual Trigger'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-tools">
          <button type="button" class="agy-ms-btn" data-ms-action="sync-opus-plugin">${esc(L('同步审查插件', 'Sync Gate Plugin'))}</button>
          <button type="button" class="agy-ms-btn" data-ms-action="trigger-opus-gate">${esc(L('呼出审查菜单', 'Open Review Menu'))}</button>
        </div>
      </div>`;
}

export function renderL2Stream(p, base, { studioPrefs, L }) {
  const stepMode = studioPrefs.getStepStreamMode();
  const acMode = p.autoCompactMode || 'semi';
  const acModeLbl =
    acMode === 'auto'
      ? L('全自动', 'Auto')
      : acMode === 'off'
        ? L('关闭', 'Off')
        : L('半自动', 'Semi-auto');
  const acMin = Math.max(1, Math.round((p.autoCompactMinWaitSec ?? 300) / 60));
  const acSum = acMode === 'off' ? acModeLbl : `${acModeLbl} · ≥${p.autoCompactThresholdPct ?? 50}% / ${acMin}m`;
  return `
      <div class="agy-ms-card">
        ${renderSwitchRow('hideThinkingProse', 'studio', L('隐藏思考过程正文', 'Hide Thinking Prose'), L('开启时隐藏英文 Thought 正文与展开箭头，需要查看推理细节时可随时关闭', 'Hides verbose Thought bodies & chevrons; turn off to inspect reasoning'), p.hideThinkingProse)}
        ${renderSegRow('stepStream', 'step', L('步骤流展示模式', 'Step Stream Mode'), L('统一控制宿主与底座：紧凑折叠不打断阅读，展开摘要可保留中间叙述与工具进展', 'Controls verboseConversationSteps + step unfold together'), [
          ['compact', L('紧凑折叠', 'Compact')],
          ['expanded', L('展开摘要', 'Expanded')],
        ], stepMode)}
        ${renderDrillRow('stream-auto-compact', L('智能压缩上下文 (Auto-Compact)', 'Auto-Compact'), L('高上下文且设了长定时等待时，回合结束趁缓存未失效自动触发 /compact', 'Runs /compact right after long-wait or high-context turns while cache is warm'), acSum)}
        ${renderSegRow(
          'anchorsMode',
          'studio',
          L('抗漂移锚点与交接 (Experimental)', 'Anti-Drift Anchors & Handoff (Experimental)'),
          L('追踪压缩代数 G、一键无损换窗、纠偏原话审批卡与 .agents/locks.json 减速带；关闭后停用钩子与底栏胶囊', 'Tracks compaction generation G, 1-click milestone handoff, verbatim anchor cards & .agents/locks.json speed-bumps; set Off to disable'),
          [
            ['off', L('关闭', 'Off')],
            ['semi', L('半自动', 'Semi-auto')],
          ],
          p.anchorsMode || 'semi'
        )}
        ${renderSwitchRow('resumeBannerEnabled', 'studio', L('中断恢复胶囊 (Resume)', 'Interrupted Task Resume Pill'), L('检测到对话因崩溃、超时或网络意外中断时在底栏显示一键继续按钮', 'Shows one-click Resume pill when a conversation terminated mid-task'), p.resumeBannerEnabled)}
        ${renderSwitchRow('claudeUxCodeFold', 'base', L('长代码块折叠与吸顶', 'Long Code Folding (>40 lines)'), L('超过 40 行的代码块自动折叠为预览并保持语言与复制栏吸顶', 'Collapses long code blocks with sticky language & copy bar'), base.modules?.claudeUxCodeFold !== false)}
      </div>`;
}

export function renderL3AutoCompact(p, { L }) {
  const tr = p.autoCompactTriggers || { longTimer: true, modelRequest: true, highWater: false };
  return `
      <div class="agy-ms-sec-hdr">${esc(L('自动压缩策略', 'Compaction Policy'))}</div>
      <div class="agy-ms-card">
        ${renderSegRow(
          'autoCompactMode',
          'studio',
          L('工作模式', 'Execution Mode'),
          L('半自动在底栏展示一键建议胶囊；全自动在回合落定且输入框无草稿时直接静默执行 /compact', 'Semi-auto shows a one-click dock pill; Auto runs /compact silently when idle & draft-free'),
          [
            ['off', L('关闭', 'Off')],
            ['semi', L('半自动', 'Semi-auto')],
            ['auto', L('全自动', 'Auto')],
          ],
          p.autoCompactMode || 'semi'
        )}
        ${renderSegRow(
          'autoCompactThresholdPct',
          'studio-num',
          L('长等待触发上下文阈值', 'Long-Wait Context Threshold'),
          L('设了长定时器且上下文达到此百分比时触发压缩', 'Trigger compaction when context reaches this % before a long timer'),
          [
            ['40', '40%'],
            ['50', '50%'],
            ['60', '60%'],
            ['70', '70%'],
          ],
          String(p.autoCompactThresholdPct ?? 50)
        )}
        ${renderSegRow(
          'autoCompactMinWaitSec',
          'studio-num',
          L('长定时器判定阈值', 'Minimum Timer Wait'),
          L('定时器/Cron 间隔达到此时间（Prompt Cache 易过期区间）才介入', 'Minimum timer or cron interval before triggering compaction'),
          [
            ['180', '3m'],
            ['300', '5m'],
            ['600', '10m'],
            ['900', '15m'],
          ],
          String(p.autoCompactMinWaitSec ?? 300)
        )}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('触发条件', 'Triggers'))}</div>
      <div class="agy-ms-card">
        ${renderSwitchRow('longTimer', 'ac-trigger', L('长定时等待前趁热压缩', 'Before Long Timers / Crons'), L('在长等待回合结束瞬间趁 Prompt Cache 未过期执行 /compact', 'Compacts right after setting a long wait while Prompt Cache is still warm'), tr.longTimer !== false)}
        ${renderSwitchRow('modelRequest', 'ac-trigger', L('允许模型主动请求压缩', 'Agent-Requested Compaction'), L('允许模型在复杂阶段收尾时调用 auto-compact 技能排队压缩', 'Allows the agent to queue end-of-turn compaction via the auto-compact skill'), tr.modelRequest !== false)}
        ${renderSwitchRow('highWater', 'ac-trigger', L('纯高水位线自动保护', 'Pure High-Water Guard'), L('无定时器时，只要上下文超过下方高水位阈值也在回合结束后触发', 'Also triggers after any turn exceeding the high-water % below'), tr.highWater === true)}
        ${renderSegRow(
          'autoCompactHighWaterPct',
          'studio-num',
          L('高水位保护阈值', 'High-Water Threshold'),
          L('仅在开启「纯高水位线自动保护」时生效', 'Active only when Pure High-Water Guard is enabled'),
          [
            ['0', L('关闭', 'Off')],
            ['75', '75%'],
            ['80', '80%'],
            ['85', '85%'],
          ],
          String(p.autoCompactHighWaterPct ?? 0)
        )}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('原生插件与手动触发', 'Native Plugin & Manual Action'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-tools">
          <button type="button" class="agy-ms-btn" data-ms-action="sync-auto-compact-plugin">${esc(L('同步原生插件', 'Sync Native Plugin'))}</button>
          <button type="button" class="agy-ms-btn" data-ms-action="trigger-compact-now">${esc(L('立即压缩当前会话', 'Compact Now'))}</button>
        </div>
      </div>`;
}

export function renderL2Workspace(p, base, { state, L }) {
  const aiCfg = state?.aiSuggestionsCfg;
  const aiSum = !aiCfg
    ? L('Gemini 3.8 Flash', 'Gemini 3.8 Flash')
    : !aiCfg.hasApiKey
      ? L('未配置 Key', 'No API key')
      : !aiCfg.enabled
        ? `${aiCfg.model || 'gemini-3.8-flash'} · ${L('已关闭', 'Off')}`
        : `${aiCfg.model || 'gemini-3.8-flash'} · ${L('已就绪', 'Ready')}`;
  const wfSt = state?.gitWorkflowStatus;
  const wfProtectedCnt = Array.isArray(wfSt?.projectsSummary)
    ? wfSt.projectsSummary.filter((it) => it && it.mode !== 'observe').length
    : 0;
  const wfDefMode = wfSt?.policy?.defaultMode || 'observe';
  const wfModeLbl =
    wfDefMode === 'worktree-only'
      ? L('默认工作树', 'Worktree-Only')
      : wfDefMode === 'protect-main'
        ? L('默认护主干', 'Protect Main')
        : L('默认观察', 'Observe');
  const wfSum = !wfSt
    ? L('默认观察 · 分级护栏', 'Observe · Tiered guard')
    : !wfSt.guardActive
      ? L('护栏未生效', 'Guard inactive')
      : wfProtectedCnt > 0
        ? `${wfModeLbl} · ${L(`${wfProtectedCnt} 项目受保护`, `${wfProtectedCnt} protected`)}`
        : wfModeLbl;
  return `
      <div class="agy-ms-sec-hdr">${esc(L('Overview 与底栏胶囊', 'Overview & Footer Capsules'))}</div>
      <div class="agy-ms-card">
        ${renderSwitchRow('overviewUsageEnabled', 'studio', L('Overview 用量统计卡片', 'Overview Usage Card'), L('在右侧概览中展示日 / 周 / 月 Token 与分模型用量柱状图', 'Displays daily / weekly / monthly token & model charts in Overview'), p.overviewUsageEnabled)}
        ${
          p.overviewUsageEnabled
            ? renderSegRow('overviewUsageDefaultPeriod', 'studio', L('默认统计周期', 'Default Period'), '', [
                ['day', L('日', 'Day')],
                ['week', L('周', 'Week')],
                ['month', L('月', 'Month')],
              ], p.overviewUsageDefaultPeriod)
            : ''
        }
        ${renderSwitchRow('subagentFooterEnabled', 'studio', L('底部子代理胶囊与侧栏联动', 'Bottom Subagent Capsule'), L('在输入区底栏显示子代理状态胶囊并一键切入双栏分屏视图', 'Shows live subagent capsule & split-pane switcher in footer'), p.subagentFooterEnabled)}
        ${renderSwitchRow('claudeUxContextRing', 'base', L('上下文圆环与限额浮层', 'Context Ring & Quota Popover'), L('在模型胶囊旁显示实时上下文占用与账号 5h/周限额、一键压缩', 'Shows context ring beside model picker with quotas & Compact'), base.modules?.claudeUxContextRing !== false)}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('侧边栏与工作区页面', 'Sidebar & Pages'))}</div>
      <div class="agy-ms-card">
        ${renderSwitchRow('claudeUxHideSidebarProjects', 'base', L('侧栏统一「最近对话」', 'Unified Sidebar Recents'), L('合并原生项目与普通对话分组，统一按最近时间混排显示', 'Replaces split Projects/Chats with a single chronological Recents list'), base.modules?.claudeUxHideSidebarProjects === true)}
        ${renderSwitchRow('claudeUxProjects', 'base', L('项目工作区 (Projects)', 'Projects Workspace'), L('启用 Claude 风格项目卡片墙、本地 AGENTS 指令与上下文文件管理', 'Enables Claude-style Projects workspace, AGENTS.md & context files'), base.modules?.claudeUxProjects !== false)}
        ${renderDrillRow('workspace-ai-suggestions', L('AI 历史对话建议', 'AI Conversation Suggestions'), L('使用 Gemini 3.8 Flash 基于最近对话推荐新会话起点并自动切换 Worktree', 'Suggests follow-up chats from recent history with cold-start context handoff'), aiSum)}
        ${renderDrillRow('workspace-git-workflow', L('Git 并行工作流 (Git Workflow)', 'Git Parallel Workflow'), L('全项目分级分支护栏、Worktree 隔离策略与拦截记录', 'Tiered branch protection, parallel worktree isolation & guard logs'), wfSum)}
        ${renderSwitchRow('claudeUxCustomizations', 'base', L('技能与自定义页优化', 'Customizations Layout & Import'), L('增强「技能与自定义」页分类标签与本地技能快捷导入', 'Adds category tabs and quick local skill import'), base.modules?.claudeUxCustomizations !== false)}
      </div>`;
}

export function renderL3AiSuggestions(state, { L }) {
  const cfg = state?.aiSuggestionsCfg || {
    enabled: true,
    autoRefresh: true,
    model: 'gemini-3.8-flash',
    baseUrl: 'https://generativelanguage.googleapis.com',
    hasApiKey: false,
    apiKeySource: 'none',
    apiKeyMask: '',
  };
  const activeModel = cfg.model || 'gemini-3.8-flash';
  const activeBase = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
  const testSt = state?.aiSuggestionsTestStatus || null;
  const presets = [
    ['gemini-3.8-flash', '3.8 Flash'],
    ['gemini-2.5-flash', '2.5 Flash'],
    ['gemini-2.5-flash-lite', '2.5 Flash-Lite'],
  ];

  const keyStatusText = testSt
    ? testSt.message
    : cfg.hasApiKey
      ? `${L('当前 Key', 'Active key')}: ${cfg.apiKeyMask} (${
          cfg.apiKeySource === 'env' ? L('来自环境变量', 'from env') : L('本地已保存', 'saved locally')
        })`
      : L('未配置 API Key · 留空时项目页保持静态快捷按钮', 'No API Key configured · static quick pills stay active');
  const statusTone = testSt ? (testSt.busy ? 'muted' : testSt.ok ? 'ok' : 'err') : cfg.hasApiKey ? 'ok' : 'muted';

  return `
      <div class="agy-ms-card">
        ${renderSwitchRow('enabled', 'ai-sugg', L('启用 AI 历史对话建议', 'Enable AI Chat Suggestions'), L('在项目详情页输入框下方，基于最近 5 条对话与分支状态生成冷启动交接建议', 'Generates 3 follow-up chat pills with cold-start context handoff from recent history'), cfg.enabled !== false)}
        ${renderSwitchRow('autoRefresh', 'ai-sugg', L('指纹变化时自动后台刷新', 'Auto-Refresh on History Change'), L('仅当近期对话或 Git 分支变化且超出冷却时间时后台刷新一次，并缓存结果', 'Refreshes in background only when recent chat/git fingerprint changes beyond cooldown'), cfg.autoRefresh !== false)}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('Gemini API 凭据与模型', 'Gemini API Key & Model'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-field">
          <div class="agy-ms-row-title">${esc(L('Gemini API Key', 'Gemini API Key'))}</div>
          <div class="agy-ms-row-desc">${esc(L('可使用 Google AI Studio 领取的 Ultra 每月赠金对应的 API Key（也可使用环境变量 GEMINI_API_KEY）', 'Works with your Google AI Studio API Key (Ultra monthly credits) or GEMINI_API_KEY env var'))}</div>
          <div class="agy-ms-input-row">
            <input type="password" class="agy-ms-input" data-ms-ai-input="apiKey" autocomplete="off" spellcheck="false" placeholder="${esc(
              cfg.hasApiKey ? `${cfg.apiKeyMask} · ${L('留空保持不变，输入新 Key 将覆盖', 'Leave blank to keep current key')}` : 'AIza...'
            )}" />
          </div>
          <div class="agy-ms-status-line" data-tone="${esc(statusTone)}">${esc(keyStatusText)}</div>
        </div>

        <div class="agy-ms-field">
          <div class="agy-ms-row-title">${esc(L('模型 ID', 'Model ID'))}</div>
          <div class="agy-ms-seg is-wrap" role="group" aria-label="${esc(L('常用模型预设', 'Model presets'))}">
            ${presets
              .map(
                ([val, lbl]) =>
                  `<button type="button" class="agy-ms-seg-btn" data-ms-ai-model-preset="${esc(val)}" aria-checked="${activeModel === val ? 'true' : 'false'}">${esc(lbl)}</button>`
              )
              .join('')}
          </div>
          <div class="agy-ms-input-row">
            <input type="text" class="agy-ms-input" data-ms-ai-input="model" value="${esc(activeModel)}" spellcheck="false" placeholder="gemini-3.8-flash" />
          </div>
        </div>

        <div class="agy-ms-field">
          <div class="agy-ms-row-title">${esc(L('API Base URL（可选代理地址）', 'API Base URL (Optional)'))}</div>
          <div class="agy-ms-input-row">
            <input type="url" class="agy-ms-input" data-ms-ai-input="baseUrl" value="${esc(activeBase)}" spellcheck="false" placeholder="https://generativelanguage.googleapis.com" />
          </div>
        </div>

        <div class="agy-ms-tools">
          <button type="button" class="agy-ms-btn" data-ms-action="ai-sugg-save">${esc(L('保存配置', 'Save'))}</button>
          <button type="button" class="agy-ms-btn" data-ms-action="ai-sugg-test">${esc(L('测试连接', 'Test Connection'))}</button>
          ${
            cfg.hasApiKey && cfg.apiKeySource === 'config'
              ? `<button type="button" class="agy-ms-btn is-danger" data-ms-action="ai-sugg-clear-key" style="margin-left:auto">${esc(L('清除 Key', 'Clear Key'))}</button>`
              : ''
          }
        </div>
      </div>

      <div class="agy-ms-note">${esc(
        L(
          '隐私与额度说明：API Key 仅保存在本地 ~/.gemini/antigravity/anti-claude/project-suggestions-config.json（0600 权限），不会出现在设置 JSON 导出中；每次建议仅发送最近 5 条对话的脱水摘要（约 800 tokens），不占用 Antigravity 桌面模型主额度。',
          'Security & quota note: Your API key stays strictly in local project-suggestions-config.json (0600) and is excluded from Settings JSON exports. Each refresh sends only a compact summary (~800 tokens) and does not consume Antigravity quota.'
        )
      )}</div>`;
}

export function renderL3GitWorkflow(state, { L }) {
  const st = state?.gitWorkflowStatus || null;
  const policy = st?.policy || {
    defaultMode: 'observe',
    blockForcePushProtected: true,
    blockPushTags: false,
    projects: {},
  };
  const projects = Array.isArray(st?.projectsSummary) ? st.projectsSummary : [];
  const stale = Array.isArray(st?.staleProjects) ? st.staleProjects : [];
  const events = Array.isArray(st?.recentEvents) ? st.recentEvents.slice(0, 5) : [];

  const healthWarnHtml =
    st && (!st.guardActive || st.hookNode?.pinned === false)
      ? `<div class="agy-ms-wf-warn" data-ms-wf-warn="true">
          <div class="agy-ms-wf-warn-txt">
            <strong>${esc(L('护栏未生效', 'Guard inactive'))}</strong>：${esc(
              !st.pluginInstalled
                ? L('原生插件 maga-git-workflow 尚未同步或文件缺失。', 'Native plugin maga-git-workflow is not synced or incomplete.')
                : !st.hookNode?.ok
                  ? L(`Hook Node 路径不可用（${st.hookNode?.nodeBin || 'node'}），升级 Node 后请重新同步。`, `Hook Node binary is unavailable (${st.hookNode?.nodeBin || 'node'}). Re-sync plugin to refresh path.`)
                  : L('hooks.json 未使用固定 Node 绝对路径，请重新同步插件。', 'hooks.json is using an unpinned node path. Re-sync plugin to pin binary.')
            )}
          </div>
          <button type="button" class="agy-ms-btn" data-ms-action="sync-git-workflow-plugin">${esc(L('重新同步', 'Re-Sync'))}</button>
        </div>`
      : '';

  const projectsHtml = projects.length
    ? projects
        .map((proj) => {
          const ctrlHtml = proj.localGuardrailActive
            ? `<span class="agy-ms-wf-lock">${esc(L('工作树 · 仓库护栏', 'Worktree · Repo Guard'))}</span>`
            : `<div class="agy-ms-seg" role="radiogroup" aria-label="${esc(proj.name)}">
                ${[
                  ['default', L('默认', 'Default')],
                  ['observe', L('观察', 'Observe')],
                  ['protect-main', L('护主干', 'Protect')],
                  ['worktree-only', L('工作树', 'Worktree')],
                ]
                  .map(([val, lbl]) => {
                    const active = val === 'default' ? !proj.overrideMode : proj.overrideMode === val;
                    return `<button type="button" class="agy-ms-seg-btn" role="radio" data-ms-wf-proj-dir="${esc(proj.dirPath)}" data-ms-wf-proj-mode="${esc(val)}" aria-checked="${active ? 'true' : 'false'}">${esc(lbl)}</button>`;
                  })
                  .join('')}
              </div>`;
          return `<div class="agy-ms-wf-proj-row">
            <div class="agy-ms-row-text">
              <div class="agy-ms-row-title">${esc(proj.name)}</div>
              <div class="agy-ms-row-desc">${esc(proj.dirPath)}</div>
            </div>
            ${ctrlHtml}
          </div>`;
        })
        .join('')
    : `<div class="agy-ms-row"><div class="agy-ms-row-desc">${esc(
        state?.gitWorkflowLoading
          ? L('正在扫描已授权 Git 项目…', 'Scanning registered Git projects…')
          : L('暂未检测到本地 Git 项目；任何新打开的项目均可自动受控。', 'No local Git projects detected yet.')
      )}</div></div>`;

  const staleHtml = stale.length
    ? `<div class="agy-ms-tools" style="border-top:1px solid var(--ms-border)">
        <span class="agy-ms-row-desc" style="margin-right:auto">${esc(L(`检测到 ${stale.length} 条已移动/删除项目的策略残留`, `${stale.length} stale project entries detected`))}</span>
        <button type="button" class="agy-ms-btn" data-ms-action="prune-git-workflow-stale">${esc(L('清理残留', 'Prune Stale'))}</button>
      </div>`
    : '';

  const eventsHtml = events.length
    ? events
        .map((ev) => {
          const tsLabel = ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          return `<div class="agy-ms-wf-event-row">
            <div class="agy-ms-wf-event-meta">
              <span class="agy-ms-wf-event-repo">${esc(ev.repoName || L('策略保护', 'Policy'))}</span>
              <span class="agy-ms-wf-event-mode">${esc(ev.mode)}</span>
              ${tsLabel ? `<span class="agy-ms-wf-event-time">${esc(tsLabel)}</span>` : ''}
            </div>
            <div class="agy-ms-wf-event-reason">${esc(ev.reason)}</div>
          </div>`;
        })
        .join('')
    : `<div class="agy-ms-row"><div class="agy-ms-row-desc">${esc(L('近期无护栏拦截记录。', 'No recent guard blocks recorded.'))}</div></div>`;

  return `
      ${healthWarnHtml}
      <div class="agy-ms-sec-hdr">${esc(L('全局默认策略与安全基线', 'Global Defaults & Safety'))}</div>
      <div class="agy-ms-card">
        ${renderSegRow(
          'defaultMode',
          'wf-global',
          L('新项目默认级别', 'Default Project Tier'),
          L('观察零打扰（仅防强制推送主干并自动追踪 Worktree）；护主干禁止直改主干；工作树锁死主目录', 'Observe (zero friction + force-push guard + auto worktree tracking); Protect Main; or strict Worktree-Only'),
          [
            ['observe', L('观察', 'Observe')],
            ['protect-main', L('护主干', 'Protect Main')],
            ['worktree-only', L('工作树', 'Worktree')],
          ],
          policy.defaultMode || 'observe',
          true
        )}
        ${renderSwitchRow('blockForcePushProtected', 'wf-global', L('禁止强制推送受保护主干', 'Block Force-Push to Protected Branches'), L('拦截对 main / master / origin/HEAD 的 --force 与 +refspec 推送', 'Blocks --force and +refspec pushes targeting main / master / origin/HEAD'), policy.blockForcePushProtected !== false)}
        ${renderSwitchRow('blockPushTags', 'wf-global', L('全局禁止 git push --tags', 'Block Bulk git push --tags'), L('默认仅建议在历史 Tag 较杂的仓库开启；单 Tag 显式推送始终放行', 'Blocks bulk --tags pushes while allowing explicit single-tag pushes'), policy.blockPushTags === true)}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('分项目隔离级别', 'Per-Project Tiers'))}</div>
      <div class="agy-ms-card">
        ${projectsHtml}
        ${staleHtml}
      </div>

      <div class="agy-ms-sec-hdr">${esc(
        L(`最近拦截记录（24h：${st?.denyCount24h || 0} 次）`, `Recent Guard Blocks (24h: ${st?.denyCount24h || 0})`)
      )}</div>
      <div class="agy-ms-card">
        ${eventsHtml}
      </div>

      <div class="agy-ms-sec-hdr">${esc(L('原生插件与工具', 'Native Plugin & CLI'))}</div>
      <div class="agy-ms-card">
        <div class="agy-ms-tools">
          <button type="button" class="agy-ms-btn" data-ms-action="sync-git-workflow-plugin">${esc(L('同步原生插件', 'Sync Native Plugin'))}</button>
        </div>
      </div>

      <div class="agy-ms-note">${esc(
        L(
          '零仓库污染：分级策略集中保存在 ~/.gemini/antigravity/anti-claude/git-workflow-policy.json，不会往项目写入配置文件；Node 仓库仅在存在 node_modules 时于未跟踪的 .git/info/exclude 中排重。本地 Hook 属于客户端防呆护栏，关键仓库仍建议同时开启远端分支保护。',
          'Zero repo pollution: policies live centrally in git-workflow-policy.json (Node repos only touch untracked .git/info/exclude when node_modules exists). Client hooks complement server-side remote branch protection.'
        )
      )}</div>`;
}

export function renderL2Appearance(p, base, { L }) {
  return `
      <div class="agy-ms-card">
        ${renderSwitchRow('i18n', 'base', L('中文界面汉化', 'Chinese UI Localization'), L('将 Antigravity 原生界面与 AGY Studio 面板切换为简体中文', 'Translates Antigravity UI & AGY Studio settings into Simplified Chinese'), Boolean(base.modules?.i18n))}
        ${renderSegRow('cjkFontScale', 'cjk', L('中文字体字高校准', 'CJK Optical Font Scale'), L('校准苹方汉字与西文的视觉高度比例（95% 为均衡默认）', 'Calibrates CJK glyph height relative to Latin characters'), [
          ['94.5', '94.5%'],
          ['95', '95%'],
          ['100', '100%'],
        ], base.cjkFontScale || '95')}
        ${renderSegRow('motionLevel', 'studio', L('交互动效强度', 'Animation & Motion'), L('控制侧栏滑入、胶囊切换与 Effort Bar 动画节奏', 'Controls panel transitions, capsules & Effort Bar animation pace'), [
          ['full', L('完整', 'Full')],
          ['reduced', L('精简', 'Reduced')],
          ['off', L('关闭', 'Off')],
        ], p.motionLevel)}
      </div>`;
}
