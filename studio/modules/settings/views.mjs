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
      return { title: L('MAGA 设置', 'MAGA Settings'), parent: '' };
    case 'models':
      return { title: L('模型与思考', 'Models & Thinking'), parent: L('MAGA 设置', 'MAGA') };
    case 'models-tiers':
      return { title: L('按家族默认思考档位', 'Default Tier by Family'), parent: L('模型与思考', 'Models') };
    case 'models-hidden':
      return { title: L('隐藏不常用模型', 'Hidden Models'), parent: L('模型与思考', 'Models') };
    case 'models-theme':
      return { title: L('Effort Bar 与主题皮肤', 'Effort Bar & Themes'), parent: L('模型与思考', 'Models') };
    case 'stream':
      return { title: L('对话与过程流', 'Conversation & Stream'), parent: L('MAGA 设置', 'MAGA') };
    case 'workspace':
      return { title: L('工作区与面板', 'Workspace & Panels'), parent: L('MAGA 设置', 'MAGA') };
    case 'appearance':
      return { title: L('语言与外观', 'Language & Appearance'), parent: L('MAGA 设置', 'MAGA') };
    default:
      return { title: L('MAGA 设置', 'MAGA Settings'), parent: '' };
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
    base.modules?.claudeUxHideSidebarProjects !== false ? L('最近对话', 'Recents') : L('原生分组', 'Native')
  }`;

  const motionLabels = { full: L('完整', 'Full'), reduced: L('精简', 'Reduced'), off: L('关闭', 'Off') };
  const appSummary = `${base.modules?.i18n ? '中文' : 'EN'} · ${base.cjkFontScale || '95'}% · ${motionLabels[p.motionLevel] || 'Full'}`;

  const cats = [
    ['models', L('模型与思考', 'Models & Thinking'), L('胶囊显示、家族档位、隐藏模型、主题与执行器', 'Capsule UI, family tiers, hidden list, themes & executor'), modelsSummary],
    ['stream', L('对话与过程流', 'Conversation & Stream'), L('思考正文显隐、步骤流模式、恢复提示与代码折叠', 'Thinking prose, step flow, resume banner & code fold'), streamSummary],
    ['workspace', L('工作区与面板', 'Workspace & Panels'), L('用量统计、子代理胶囊、侧栏与项目增强', 'Usage card, subagents, sidebar & Projects'), wsSummary],
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
                  <span>${esc(L('确认将 MAGA、外观与默认模型恢复为出厂推荐设置？', 'Reset all MAGA, layout & host model preferences to defaults?'))}</span>
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
        <span>MAGA · agy-studio</span>
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

export function renderL2Stream(p, base, { studioPrefs, L }) {
  const stepMode = studioPrefs.getStepStreamMode();
  return `
      <div class="agy-ms-card">
        ${renderSwitchRow('hideThinkingProse', 'studio', L('隐藏思考过程正文', 'Hide Thinking Prose'), L('开启时隐藏英文 Thought 正文与展开箭头，需要查看推理细节时可随时关闭', 'Hides verbose Thought bodies & chevrons; turn off to inspect reasoning'), p.hideThinkingProse)}
        ${renderSegRow('stepStream', 'step', L('步骤流展示模式', 'Step Stream Mode'), L('统一控制宿主与底座：紧凑折叠不打断阅读，展开摘要可保留中间叙述与工具进展', 'Controls verboseConversationSteps + step unfold together'), [
          ['compact', L('紧凑折叠', 'Compact')],
          ['expanded', L('展开摘要', 'Expanded')],
        ], stepMode)}
        ${renderSwitchRow('resumeBannerEnabled', 'studio', L('中断恢复胶囊 (Resume)', 'Interrupted Task Resume Pill'), L('检测到对话因崩溃、超时或网络意外中断时在底栏显示一键继续按钮', 'Shows one-click Resume pill when a conversation terminated mid-task'), p.resumeBannerEnabled)}
        ${renderSwitchRow('claudeUxCodeFold', 'base', L('长代码块折叠与吸顶', 'Long Code Folding (>40 lines)'), L('超过 40 行的代码块自动折叠为预览并保持语言与复制栏吸顶', 'Collapses long code blocks with sticky language & copy bar'), base.modules?.claudeUxCodeFold !== false)}
      </div>`;
}

export function renderL2Workspace(p, base, { L }) {
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
        ${renderSwitchRow('claudeUxHideSidebarProjects', 'base', L('侧栏统一「最近对话」', 'Unified Sidebar Recents'), L('合并原生项目与普通对话分组，统一按最近时间混排显示', 'Replaces split Projects/Chats with a single chronological Recents list'), base.modules?.claudeUxHideSidebarProjects !== false)}
        ${renderSwitchRow('claudeUxProjects', 'base', L('项目工作区 (Projects)', 'Projects Workspace'), L('启用 Claude 风格项目卡片墙、本地 AGENTS 指令与上下文文件管理', 'Enables Claude-style Projects workspace, AGENTS.md & context files'), base.modules?.claudeUxProjects !== false)}
        ${renderSwitchRow('claudeUxCustomizations', 'base', L('技能与自定义页优化', 'Customizations Layout & Import'), L('增强「技能与自定义」页分类标签与本地技能快捷导入', 'Adds category tabs and quick local skill import'), base.modules?.claudeUxCustomizations !== false)}
      </div>`;
}

export function renderL2Appearance(p, base, { L }) {
  return `
      <div class="agy-ms-card">
        ${renderSwitchRow('i18n', 'base', L('中文界面汉化', 'Chinese UI Localization'), L('将 Antigravity 原生界面与 MAGA 面板切换为简体中文', 'Translates Antigravity UI & MAGA settings into Simplified Chinese'), Boolean(base.modules?.i18n))}
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
