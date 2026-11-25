/**
 * Project Context/Instructions Modal & Scheduled Task Editor Modal.
 */
export function createProjectModals(ctx) {
  const { FEAT, L, rtState, later, escapeHtml, invalidateOverviewSnapshotCache, pState, ICONS, pHooks, modelApi } = ctx;
  const { SVG_CLAUDE_PROJECTS_ICON } = ICONS;
  const {
    displayEffortLabel,
    isOrchestratorModelOpt,
    parseModelLabelEffort,
    modelCoreRank,
    sortFamilyVariants,
    buildReduxModelSelectorApi,
    discoverModelSelectorApi,
    applyModelSelectionOption,
  } = modelApi;
  const closeProjectsModal = (...args) => pHooks.closeProjectsModal?.(...args);
  const renderProjectsView = (...args) => pHooks.renderProjectsView?.(...args);
  const startNewChatInProject = (...args) => pHooks.startNewChatInProject?.(...args);
  const saveProjectContextDelta = (...args) => pHooks.saveProjectContextDelta?.(...args);

  async function openProjectInstructionsModal(project) {
    if (!project || !project.dirPath) return;
    closeProjectsModal();
    const cached = pState.projectsContextMap[project.dirPath] || null;
    const modalRef = {
      kind: 'instructions',
      project,
      dirPath: project.dirPath,
      instructions: cached ? cached.instructions || '' : '',
      hasAgentsMd: Boolean(cached && (cached.hasAgentsMd || (cached.instructions && cached.instructions.trim()))),
      userEdited: false,
      saving: false,
      error: ''
    };
    rtState.projectsModalState = modalRef;
    renderProjectContextModal();

    if (typeof window.__agProjectCall === 'function') {
      const fresh = await window.__agProjectCall('readContext', { dirPath: project.dirPath }, 8000);
      if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
      if (fresh && fresh.ok) {
        pState.projectsContextMap[project.dirPath] = fresh;
        const nextHasAgents = Boolean(fresh.hasAgentsMd || (fresh.instructions && fresh.instructions.trim()));
        const needRender = !modalRef.userEdited || modalRef.hasAgentsMd !== nextHasAgents;
        if (!modalRef.userEdited) {
          modalRef.instructions = fresh.instructions || '';
        }
        modalRef.hasAgentsMd = nextHasAgents;
        if (needRender && !modalRef.userEdited) {
          renderProjectContextModal();
        }
      }
    }
  }

  function renderProjectContextModal() {
    if (!rtState.projectsModalState) return;
    if (!rtState.projectsModalEl || !rtState.projectsModalEl.isConnected) {
      rtState.projectsModalEl = document.createElement('div');
      rtState.projectsModalEl.id = 'ag-claude-project-modal';
      rtState.projectsModalEl.setAttribute('data-ag-i18n-ignore', '1');
      rtState.projectsModalEl.addEventListener('click', (e) => {
        if (e.target === rtState.projectsModalEl) closeProjectsModal();
      });
      document.body.appendChild(rtState.projectsModalEl);
    }

    const st = rtState.projectsModalState;
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';

    rtState.projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L('编辑项目 AGENTS.md', 'Edit project AGENTS.md'))}">
        <div class="ag-pm-hdr">
          <div class="ag-pm-title-wrap">
            <span class="ag-pm-icon">${SVG_CLAUDE_PROJECTS_ICON}</span>
            <h2 class="ag-pm-title">${escapeHtml(st.project.name)} · AGENTS.md</h2>
          </div>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>
        <p class="ag-pm-desc">${L(
          '直接读写项目根目录下的 AGENTS.md 正文（右侧添加的「参考文件」与「关联文件夹」会自动维护在文件末尾，互不覆盖）。',
          'Directly reads and writes root AGENTS.md for this project (attached context files and linked folders are maintained automatically at the end of the file).'
        )}</p>
        <div class="ag-pm-field">
          <textarea id="ag-pm-instructions" class="ag-pm-textarea" rows="12" placeholder="${escapeHtml(
            L('例如：填写本项目的架构约定、目录结构、测试命令或回复风格约束……', 'Write project rules, architecture notes, or constraints for AGENTS.md…')
          )}">${escapeHtml(st.instructions)}</textarea>
        </div>
        ${errHtml}
        <div class="ag-pm-footer${st.hasAgentsMd ? ' ag-pm-footer-split' : ''}">
          ${
            st.hasAgentsMd
              ? `<button type="button" class="ag-pm-reveal-link" data-ag-pm-reveal-agents="true">${L('在 Finder 中定位 AGENTS.md', 'Reveal AGENTS.md in Finder')}</button>`
              : ''
          }
          <div class="ag-pm-footer-actions">
            <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('取消', 'Cancel')}</button>
            <button type="button" class="ag-pm-primary-btn" data-ag-pm-save="true" ${st.saving ? 'disabled' : ''}>${
              st.saving ? L('保存中…', 'Saving…') : L('保存 AGENTS.md', 'Save AGENTS.md')
            }</button>
          </div>
        </div>
      </div>
    `;

    const textarea = rtState.projectsModalEl.querySelector('#ag-pm-instructions');
    if (textarea) {
      textarea.focus();
      textarea.addEventListener('input', () => {
        if (rtState.projectsModalState) {
          rtState.projectsModalState.instructions = textarea.value;
          rtState.projectsModalState.userEdited = true;
        }
      });
    }

    const revealBtn = rtState.projectsModalEl.querySelector('[data-ag-pm-reveal-agents]');
    if (revealBtn) {
      revealBtn.addEventListener('click', () => {
        if (st.dirPath && typeof window.__agProjectCall === 'function') {
          const targetPath = `${String(st.dirPath).replace(/[\\/]+$/, '')}/AGENTS.md`;
          window.__agProjectCall('revealFile', { dirPath: st.dirPath, targetPath }, 5000);
        }
      });
    }

    rtState.projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });

    const saveBtn = rtState.projectsModalEl.querySelector('[data-ag-pm-save]');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const modalRef = rtState.projectsModalState;
        if (!modalRef || modalRef.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          modalRef.error = L('本地写入桥接不可用，请重启 Anti-Claude 守护进程', 'Local write bridge unavailable');
          renderProjectContextModal();
          return;
        }
        modalRef.saving = true;
        modalRef.error = '';
        renderProjectContextModal();
        /* Submit only `instructions` so in-flight context loads can never overwrite existing attachments or folders */
        const res = await window.__agProjectCall(
          'saveContext',
          {
            dirPath: modalRef.dirPath,
            instructions: modalRef.instructions
          },
          20000
        );
        if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
        if (res && res.ok) {
          pState.projectsContextMap[modalRef.dirPath] = res;
          closeProjectsModal();
          if (rtState.projectsViewOpen) renderProjectsView();
          invalidateOverviewSnapshotCache();
        } else {
          modalRef.saving = false;
          modalRef.error = L('保存失败：', 'Save failed: ') + String((res && res.error) || 'unknown');
          renderProjectContextModal();
        }
      });
    }
  }

  function runProjectScheduledTask(project, task) {
    if (!project || !task) return;
    const raw = String(task.instructions || '').trim();
    if (!raw) return;
    const taskModelId = String(task.model || '').trim();
    if (taskModelId) {
      const api = discoverModelSelectorApi() || buildReduxModelSelectorApi();
      if (api) {
        const allOpts = []
          .concat(Array.isArray(api.modelOptions) ? api.modelOptions : [])
          .concat(Array.isArray(api.customModels) ? api.customModels : []);
        const matched = allOpts.find((o) => o && !o.disabled && o.modelId === taskModelId);
        if (matched) applyModelSelectionOption(api, matched);
      }
    }
    const normProj = String(project.dirPath || '').replace(/\/+$/, '');
    const normTaskDir = String(task.folderPath || '').replace(/\/+$/, '');
    const finalPrompt =
      normTaskDir && normTaskDir !== normProj
        ? `[${L('关联文件夹', 'Linked folder')}: ${normTaskDir}]\n${raw}`
        : raw;
    startNewChatInProject(project, finalPrompt);
  }

  async function deleteProjectScheduledTaskFromUi(project, task) {
    if (!project || !project.dirPath || !task || typeof window.__agProjectCall !== 'function') {
      return { ok: false, error: 'unavailable' };
    }
    const res = await window.__agProjectCall(
      'deleteScheduledTask',
      { dirPath: project.dirPath, taskId: task.id, sidecarId: task.sidecarId || '' },
      10000
    );
    if (!rtState.disposed && res && res.ok) {
      pState.projectsContextMap[project.dirPath] = res;
      if (rtState.projectsViewOpen) renderProjectsView();
    }
    return res || { ok: false, error: 'delete_failed' };
  }

  function openProjectScheduledModal(project, existingTask = null) {
    if (!project || !project.dirPath) return;
    closeProjectsModal();
    const tz = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      } catch {
        return 'Asia/Shanghai';
      }
    })();
    rtState.projectsModalState = {
      kind: 'scheduled',
      project,
      dirPath: project.dirPath,
      editingId: existingTask ? existingTask.id : '',
      sidecarId: existingTask ? existingTask.sidecarId || '' : '',
      name: existingTask ? existingTask.name || '' : '',
      description: existingTask ? existingTask.description || '' : '',
      instructions: existingTask ? existingTask.instructions || '' : '',
      folderPath: (existingTask && existingTask.folderPath) || pState.projectSelectedFolderPath || project.dirPath,
      model: existingTask ? existingTask.model || '' : '',
      frequency: existingTask ? existingTask.frequency || 'manual' : 'manual',
      time: existingTask ? existingTask.time || '09:00' : '09:00',
      dayOfWeek: existingTask && Number.isFinite(Number(existingTask.dayOfWeek)) ? Number(existingTask.dayOfWeek) : 1,
      minute: existingTask && Number.isFinite(Number(existingTask.minute)) ? Number(existingTask.minute) : 0,
      customCron: existingTask ? existingTask.customCron || '0 9 * * *' : '0 9 * * *',
      timezone: (existingTask && existingTask.timezone) || tz,
      saving: false,
      error: ''
    };
    renderProjectScheduledModal();
  }

  function buildScheduledTaskModelGroups(currentModelId) {
    const api = discoverModelSelectorApi() || buildReduxModelSelectorApi();
    const rawOpts = api && Array.isArray(api.modelOptions) ? api.modelOptions : [];
    const customOpts = api && Array.isArray(api.customModels) ? api.customModels : [];
    const seenIds = new Set();
    const dynamicOpts = [];
    for (const o of rawOpts.concat(customOpts)) {
      if (!o || o.disabled || !o.label) continue;
      const id = typeof o.modelId === 'string' ? o.modelId.trim() : '';
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      dynamicOpts.push(o);
    }

    if (!dynamicOpts.length) {
      const flatOptions = [
        { value: 'gemini-4-neon-high', label: 'Gemini 4 Neon High' },
        { value: 'gemini-4-argon-high', label: 'Gemini 4 Argon High' },
        { value: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon High' },
        { value: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen Low' }
      ];
      if (currentModelId && !flatOptions.some((m) => m.value === currentModelId)) {
        flatOptions.push({ value: currentModelId, label: currentModelId });
      }
      return { groups: [], flatOptions, extraOptions: [] };
    }

    const buckets = { primary: new Map(), orch: new Map(), other: new Map() };
    for (const o of dynamicOpts) {
      const parsed = parseModelLabelEffort(o.label);
      const isOrch = isOrchestratorModelOpt(o);
      const famMap = buckets[isOrch ? 'orch' : /^gemini\b/i.test(parsed.baseName) ? 'primary' : 'other'];
      let fam = famMap.get(parsed.baseName);
      if (!fam) {
        fam = { baseName: parsed.baseName, variants: [] };
        famMap.set(parsed.baseName, fam);
      }
      fam.variants.push({
        effort: parsed.effort,
        opt: o,
        label: parsed.effort ? `${parsed.baseName} · ${displayEffortLabel(parsed.effort)}` : parsed.baseName
      });
    }

    const toOptions = (famList) => {
      const out = [];
      for (const fam of famList) {
        sortFamilyVariants(fam.variants);
        for (const v of fam.variants) out.push({ value: v.opt.modelId, label: v.label });
      }
      return out;
    };

    const primaryFams = Array.from(buckets.primary.values()).sort(
      (a, b) => modelCoreRank(a.baseName) - modelCoreRank(b.baseName)
    );
    const groups = [
      { label: L('主力模型', 'Primary models'), options: toOptions(primaryFams) },
      { label: L('多智能体编排', 'Orchestrators'), options: toOptions(Array.from(buckets.orch.values())) },
      { label: L('其他模型', 'Other models'), options: toOptions(Array.from(buckets.other.values())) }
    ].filter((g) => g.options.length > 0);

    const extraOptions =
      currentModelId && !groups.some((g) => g.options.some((o) => o.value === currentModelId))
        ? [{ value: currentModelId, label: currentModelId }]
        : [];
    return { groups, flatOptions: [], extraOptions };
  }

  function renderProjectScheduledModal() {
    if (!rtState.projectsModalState || rtState.projectsModalState.kind !== 'scheduled') return;
    if (!rtState.projectsModalEl || !rtState.projectsModalEl.isConnected) {
      rtState.projectsModalEl = document.createElement('div');
      rtState.projectsModalEl.id = 'ag-claude-project-modal';
      rtState.projectsModalEl.setAttribute('data-ag-i18n-ignore', '1');
      rtState.projectsModalEl.addEventListener('click', (e) => {
        if (e.target === rtState.projectsModalEl) closeProjectsModal();
      });
      document.body.appendChild(rtState.projectsModalEl);
    }

    const st = rtState.projectsModalState;
    const isEdit = Boolean(st.editingId);
    const ctx = pState.projectsContextMap[st.dirPath] || null;
    const extraFolders = ctx && Array.isArray(ctx.extraFolders) ? ctx.extraFolders : [];
    const folderOptions = [
      { absPath: st.dirPath, label: `${st.project.name} (${L('主目录', 'Primary')})` },
      ...extraFolders.map((f) => ({ absPath: f.absPath, label: f.name || f.absPath }))
    ];
    if (st.folderPath && !folderOptions.some((o) => o.absPath === st.folderPath)) {
      const segs = st.folderPath.split('/').filter(Boolean);
      folderOptions.push({ absPath: st.folderPath, label: segs[segs.length - 1] || st.folderPath });
    }

    const modelData = buildScheduledTaskModelGroups(st.model);
    const renderSchedModelOpt = (m) =>
      `<option value="${escapeHtml(m.value)}"${m.value === st.model ? ' selected' : ''}>${escapeHtml(m.label)}</option>`;
    const modelOptionsHtml =
      renderSchedModelOpt({ value: '', label: L('默认模型', 'Default model') }) +
      modelData.flatOptions.map(renderSchedModelOpt).join('') +
      modelData.groups
        .map(
          (grp) =>
            `<optgroup label="${escapeHtml(grp.label)}">${grp.options.map(renderSchedModelOpt).join('')}</optgroup>`
        )
        .join('') +
      modelData.extraOptions.map(renderSchedModelOpt).join('');

    const freqOptions = [
      { value: 'manual', label: L('手动', 'Manual') },
      { value: 'hourly', label: L('每小时', 'Hourly') },
      { value: 'daily', label: L('每天', 'Daily') },
      { value: 'weekdays', label: L('工作日（周一至周五）', 'Weekdays (Mon–Fri)') },
      { value: 'weekly', label: L('每周', 'Weekly') },
      { value: 'custom', label: L('自定义 Cron', 'Custom cron') }
    ];

    let freqExtraHtml = '';
    if (st.frequency === 'hourly') {
      const mins = [0, 15, 30, 45];
      freqExtraHtml = `<select id="ag-sched-minute" class="ag-sched-select" aria-label="${escapeHtml(L('分钟', 'Minute'))}">${mins
        .map((m) => `<option value="${m}"${Number(st.minute) === m ? ' selected' : ''}>:${String(m).padStart(2, '0')}</option>`)
        .join('')}</select>`;
    } else if (st.frequency === 'daily' || st.frequency === 'weekdays') {
      freqExtraHtml = `<input id="ag-sched-time" class="ag-sched-time-input" type="time" value="${escapeHtml(st.time || '09:00')}" />`;
    } else if (st.frequency === 'weekly') {
      const days = [
        { v: 1, l: L('周一', 'Monday') },
        { v: 2, l: L('周二', 'Tuesday') },
        { v: 3, l: L('周三', 'Wednesday') },
        { v: 4, l: L('周四', 'Thursday') },
        { v: 5, l: L('周五', 'Friday') },
        { v: 6, l: L('周六', 'Saturday') },
        { v: 0, l: L('周日', 'Sunday') }
      ];
      freqExtraHtml = `<select id="ag-sched-dow" class="ag-sched-select" aria-label="${escapeHtml(L('星期', 'Day of week'))}">${days
        .map((d) => `<option value="${d.v}"${Number(st.dayOfWeek) === d.v ? ' selected' : ''}>${escapeHtml(d.l)}</option>`)
        .join('')}</select><input id="ag-sched-time" class="ag-sched-time-input" type="time" value="${escapeHtml(st.time || '09:00')}" />`;
    } else if (st.frequency === 'custom') {
      freqExtraHtml = `<input id="ag-sched-cron" class="ag-sched-cron-input" type="text" value="${escapeHtml(st.customCron || '0 9 * * *')}" placeholder="0 9 * * *" />`;
    }

    const canSave = Boolean(st.name.trim() && st.description.trim() && st.instructions.trim() && !st.saving);
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';
    const autoHintHtml =
      st.frequency !== 'manual'
        ? `<div class="ag-sched-hint">${escapeHtml(
            L(
              `保存后同步写入 Antigravity 原生「自动化任务」（时区 ${st.timezone}），可在左侧「自动化任务」中启用调度，或直接点 ▶ 立即试跑。`,
              `Syncs to Antigravity Automations (${st.timezone}). Enable it in the Automations dashboard or click ▶ to run now.`
            )
          )}</div>`
        : '';

    rtState.projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog ag-pm-sched-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(
        isEdit ? L('编辑定时任务', 'Edit scheduled task') : L('创建定时任务', 'Create scheduled task')
      )}">
        <div class="ag-pm-hdr ag-sched-hdr">
          <h2 class="ag-pm-title">${escapeHtml(
            isEdit ? L('编辑定时任务', 'Edit scheduled task') : L('创建定时任务', 'Create scheduled task')
          )}</h2>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-sched-name">${L('名称', 'Name')} <span class="ag-sched-req">*</span></label>
          <input id="ag-sched-name" class="ag-sched-input" type="text" value="${escapeHtml(st.name)}" placeholder="daily-briefing" />
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-sched-desc">${L('描述', 'Description')} <span class="ag-sched-req">*</span></label>
          <input id="ag-sched-desc" class="ag-sched-input" type="text" value="${escapeHtml(st.description)}" placeholder="${escapeHtml(
            L('汇总今日日程与待办事项', 'Summarize my calendar and inbox for the day')
          )}" />
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-sched-instructions">${L('执行指令', 'Instructions')} <span class="ag-sched-req">*</span></label>
          <div class="ag-sched-inst-box">
            <textarea id="ag-sched-instructions" class="ag-sched-textarea" rows="5" placeholder="${escapeHtml(
              L('汇总今日日程与未读邮件，标出需要优先处理的紧急事项。', 'Summarize my calendar and unread emails. Flag anything urgent.')
            )}">${escapeHtml(st.instructions)}</textarea>
            <div class="ag-sched-inst-bar">
              <label class="ag-sched-picker-wrap">
                <span class="ag-sched-picker-icon">${SVG_CLAUDE_PROJECTS_ICON}</span>
                <select id="ag-sched-folder" class="ag-sched-inline-select" aria-label="${escapeHtml(L('工作文件夹', 'Work in a folder'))}">
                  ${folderOptions
                    .map(
                      (o) =>
                        `<option value="${escapeHtml(o.absPath)}"${o.absPath === st.folderPath ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
                    )
                    .join('')}
                  <option value="__add_folder__">${L('+ 添加文件夹…', '+ Add folder…')}</option>
                </select>
              </label>
              <label class="ag-sched-picker-wrap ag-sched-picker-model">
                <select id="ag-sched-model" class="ag-sched-inline-select" aria-label="${escapeHtml(L('模型', 'Model'))}">
                  ${modelOptionsHtml}
                </select>
              </label>
            </div>
          </div>
        </div>

        <div class="ag-sched-freq-row">
          <label class="ag-sched-label ag-sched-freq-lbl" for="ag-sched-freq">${L('执行频率', 'Frequency')}</label>
          <div class="ag-sched-freq-controls">
            <select id="ag-sched-freq" class="ag-sched-select">
              ${freqOptions
                .map(
                  (o) =>
                    `<option value="${escapeHtml(o.value)}"${o.value === st.frequency ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
                )
                .join('')}
            </select>
            ${freqExtraHtml}
          </div>
        </div>

        ${autoHintHtml}
        ${errHtml}

        <div class="ag-pm-footer ag-sched-footer">
          ${
            isEdit
              ? `<button type="button" class="ag-sched-del-btn" data-ag-sched-del="true" ${st.saving ? 'disabled' : ''}>${L('删除任务', 'Delete')}</button>`
              : '<span></span>'
          }
          <div class="ag-sched-footer-right">
            <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('取消', 'Cancel')}</button>
            <button type="button" class="ag-pm-primary-btn" data-ag-sched-save="true" ${canSave ? '' : 'disabled'}>${
              st.saving ? L('保存中…', 'Saving…') : L('保存', 'Save')
            }</button>
          </div>
        </div>
      </div>
    `;

    const nameEl = rtState.projectsModalEl.querySelector('#ag-sched-name');
    const descEl = rtState.projectsModalEl.querySelector('#ag-sched-desc');
    const instEl = rtState.projectsModalEl.querySelector('#ag-sched-instructions');
    const saveBtn = rtState.projectsModalEl.querySelector('[data-ag-sched-save]');
    const syncSaveDisabled = () => {
      if (!saveBtn || !rtState.projectsModalState) return;
      saveBtn.disabled = !(
        rtState.projectsModalState.name.trim() &&
        rtState.projectsModalState.description.trim() &&
        rtState.projectsModalState.instructions.trim() &&
        !rtState.projectsModalState.saving
      );
    };
    if (nameEl) {
      if (!isEdit && !st.name) nameEl.focus();
      nameEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.name = nameEl.value;
        syncSaveDisabled();
      });
    }
    if (descEl) {
      descEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.description = descEl.value;
        syncSaveDisabled();
      });
    }
    if (instEl) {
      instEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.instructions = instEl.value;
        syncSaveDisabled();
      });
    }

    const folderSel = rtState.projectsModalEl.querySelector('#ag-sched-folder');
    if (folderSel) {
      folderSel.addEventListener('change', async () => {
        const modalRef = rtState.projectsModalState;
        if (!modalRef) return;
        if (folderSel.value === '__add_folder__') {
          if (typeof window.__agProjectCall === 'function') {
            try {
              const picked = await window.__agProjectCall('pickFolder', {}, 120000);
              if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
              if (picked && picked.ok && !picked.canceled && picked.folderPath) {
                const nextPath = picked.folderPath;
                if (nextPath !== modalRef.dirPath) {
                  const saveRes = await saveProjectContextDelta(modalRef.project, (draft) => {
                    const nextExtra = draft.extraFolders.slice();
                    if (!nextExtra.some((f) => f.absPath === nextPath)) {
                      nextExtra.push({
                        name: picked.name || nextPath.split(/[\\/]/).pop() || nextPath,
                        absPath: nextPath
                      });
                    }
                    return Object.assign({}, draft, { extraFolders: nextExtra });
                  });
                  if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
                  if (saveRes && saveRes.ok === false) {
                    modalRef.error =
                      L('关联文件夹保存失败：', 'Failed to link folder: ') + String(saveRes.error || 'unknown');
                  } else {
                    modalRef.folderPath = nextPath;
                    modalRef.error = '';
                  }
                } else {
                  modalRef.folderPath = nextPath;
                  modalRef.error = '';
                }
              }
            } catch (err) {
              if (!rtState.disposed && rtState.projectsModalState === modalRef) {
                modalRef.error =
                  L('关联文件夹保存失败：', 'Failed to link folder: ') + String((err && err.message) || err);
              }
            }
          }
          if (!rtState.disposed && rtState.projectsModalState === modalRef) renderProjectScheduledModal();
          return;
        }
        modalRef.folderPath = folderSel.value || modalRef.dirPath;
      });
    }

    const modelSel = rtState.projectsModalEl.querySelector('#ag-sched-model');
    if (modelSel) {
      modelSel.addEventListener('change', () => {
        if (rtState.projectsModalState) rtState.projectsModalState.model = modelSel.value || '';
      });
    }

    const freqSel = rtState.projectsModalEl.querySelector('#ag-sched-freq');
    if (freqSel) {
      freqSel.addEventListener('change', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.frequency = freqSel.value || 'manual';
        renderProjectScheduledModal();
      });
    }

    const minSel = rtState.projectsModalEl.querySelector('#ag-sched-minute');
    if (minSel) {
      minSel.addEventListener('change', () => {
        if (rtState.projectsModalState) rtState.projectsModalState.minute = Number(minSel.value) || 0;
      });
    }
    const timeEl = rtState.projectsModalEl.querySelector('#ag-sched-time');
    if (timeEl) {
      timeEl.addEventListener('input', () => {
        if (rtState.projectsModalState) rtState.projectsModalState.time = timeEl.value || '09:00';
      });
    }
    const dowSel = rtState.projectsModalEl.querySelector('#ag-sched-dow');
    if (dowSel) {
      dowSel.addEventListener('change', () => {
        if (rtState.projectsModalState) rtState.projectsModalState.dayOfWeek = Number(dowSel.value);
      });
    }
    const cronEl = rtState.projectsModalEl.querySelector('#ag-sched-cron');
    if (cronEl) {
      cronEl.addEventListener('input', () => {
        if (rtState.projectsModalState) rtState.projectsModalState.customCron = cronEl.value;
      });
    }

    rtState.projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });

    const delBtn = rtState.projectsModalEl.querySelector('[data-ag-sched-del]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const modalRef = rtState.projectsModalState;
        if (!modalRef || modalRef.saving) return;
        if (!modalRef.confirmDelete) {
          modalRef.confirmDelete = true;
          delBtn.textContent = L('再次点击确认删除', 'Click again to confirm');
          return;
        }
        modalRef.saving = true;
        modalRef.error = '';
        renderProjectScheduledModal();
        const res = await deleteProjectScheduledTaskFromUi(modalRef.project, {
          id: modalRef.editingId,
          sidecarId: modalRef.sidecarId
        });
        if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
        if (res && res.ok) {
          closeProjectsModal();
        } else {
          modalRef.saving = false;
          modalRef.confirmDelete = false;
          modalRef.error = L('删除失败：', 'Delete failed: ') + String((res && res.error) || 'unknown');
          renderProjectScheduledModal();
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const modalRef = rtState.projectsModalState;
        if (!modalRef || modalRef.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          modalRef.error = L('本地写入桥接不可用，请重启 Anti-Claude 守护进程', 'Local write bridge unavailable');
          renderProjectScheduledModal();
          return;
        }
        modalRef.saving = true;
        modalRef.error = '';
        renderProjectScheduledModal();
        const res = await window.__agProjectCall(
          'saveScheduledTask',
          {
            dirPath: modalRef.dirPath,
            task: {
              id: modalRef.editingId || undefined,
              sidecarId: modalRef.sidecarId || undefined,
              name: modalRef.name,
              description: modalRef.description,
              instructions: modalRef.instructions,
              folderPath: modalRef.folderPath,
              model: modalRef.model,
              frequency: modalRef.frequency,
              time: modalRef.time,
              dayOfWeek: modalRef.dayOfWeek,
              minute: modalRef.minute,
              customCron: modalRef.customCron,
              timezone: modalRef.timezone
            }
          },
          20000
        );
        if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
        if (res && res.ok) {
          pState.projectsContextMap[modalRef.dirPath] = res;
          closeProjectsModal();
          if (rtState.projectsViewOpen) renderProjectsView();
          invalidateOverviewSnapshotCache();
        } else {
          modalRef.saving = false;
          modalRef.error = L('保存失败：', 'Save failed: ') + String((res && res.error) || 'unknown');
          renderProjectScheduledModal();
        }
      });
    }
  }


  return {
    openProjectInstructionsModal,
    renderProjectContextModal,
    runProjectScheduledTask,
    deleteProjectScheduledTaskFromUi,
    openProjectScheduledModal,
    buildScheduledTaskModelGroups,
    renderProjectScheduledModal,
  };
}
