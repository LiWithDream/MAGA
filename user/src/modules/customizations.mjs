/**
 * Claude-Style Customizations Page Polish (category tabs, framed cards, + Add Skill importer).
 */
export function createCustomizationsModule(rt) {
  const { FEAT, L, FILE_MANAGER_ZH, FILE_MANAGER_EN, state: rtState, escapeHtml, hooks } = rt;
  const ensureSharedModalEscBound = (...args) => hooks.ensureSharedModalEscBound?.(...args);
  const closeProjectsModal = (...args) => hooks.closeProjectsModal?.(...args);
  const invalidateOverviewSnapshotCache = (...args) => hooks.invalidateOverviewSnapshotCache?.(...args);
  const SVG_PROJ_FOLDER_OPEN =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.3 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"/></svg>';
  const SVG_PROJ_PLUS =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>';

  /* ==========================================================================
   * 10. Claude-Style Customizations Enhancement (`claudeUxCustomizations`)
   *     - Non-destructively adds category tabs (Skills / Plugins / MCP / Agents / All)
   *       on `/customizations/installed`, crisp sticky header border (no clipped cards),
   *       framed Claude card rows for Skills & Rules, and local `+ Add skill` + Open Folder.
   * ========================================================================== */
  let custActiveCat = 'skills';
  let custUserPickedCat = false;
  let custSearchInputRef = null;
  let custEnhancementActive = false;

  function onCustSearchInput() {
    syncCustomizationsEnhancement();
  }

  function teardownCustomizationsEnhancement(force = false) {
    if (!force && !custEnhancementActive && !custSearchInputRef) return;
    custEnhancementActive = false;
    if (custSearchInputRef) {
      custSearchInputRef.removeEventListener('input', onCustSearchInput);
      custSearchInputRef = null;
    }
    const bar = document.getElementById('ag-cust-cat-bar');
    if (bar) bar.remove();
    const skillActions = document.getElementById('ag-cust-skill-actions');
    if (skillActions) skillActions.remove();
    const agentActions = document.getElementById('ag-cust-agent-actions');
    if (agentActions) agentActions.remove();
    document.querySelectorAll('[data-ag-cust-page]').forEach((el) => {
      el.removeAttribute('data-ag-cust-page');
      el.removeAttribute('data-ag-cust-tab');
      el.removeAttribute('data-ag-cust-searching');
    });
    document.querySelectorAll('[data-ag-cust-sticky]').forEach((el) => el.removeAttribute('data-ag-cust-sticky'));
    document.querySelectorAll('[data-ag-cust-sec]').forEach((el) => {
      el.removeAttribute('data-ag-cust-sec');
      el.removeAttribute('data-ag-cust-hidden');
    });
  }

  function classifyCustomizationsSection(sec) {
    if (!sec) return '';
    if (sec.getAttribute('data-testid') === 'customizations-installed-plugins') return 'plugins';
    if (sec.querySelector('[data-testid="skills-rules-filter"]')) return 'skills';
    if (sec.querySelector('[data-testid="add-mcp-button"]')) return 'mcp';
    const h3 = sec.querySelector('h3');
    const txt = h3 ? (h3.textContent || '').trim() : '';
    if (/Skills\s*&\s*Rules|技能与规则/i.test(txt)) return 'skills';
    if (/Custom Agents|自定义.*Agent|自定义智能体|自定义代理/i.test(txt)) return 'agents';
    if (/MCP/i.test(txt)) return 'mcp';
    if (/Installed Plugins|Plugins|已安装插件|插件/i.test(txt)) return 'plugins';
    return '';
  }

  function openAddSkillModal() {
    ensureSharedModalEscBound();
    closeProjectsModal();
    rtState.projectsModalState = {
      kind: 'addSkill',
      mode: 'create',
      name: '',
      description: '',
      instructions: '',
      saving: false,
      error: '',
      successMsg: '',
      createdDir: ''
    };
    renderAddSkillModal();
  }

  function renderAddSkillModal() {
    if (!rtState.projectsModalState || rtState.projectsModalState.kind !== 'addSkill') return;
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
    const isCreate = st.mode === 'create';
    const canSave = Boolean(st.name.trim() && st.description.trim() && st.instructions.trim() && !st.saving);
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';
    const okHtml = st.successMsg
      ? `<div class="ag-cust-ok-banner"><span>${escapeHtml(st.successMsg)}</span>${
          st.createdDir
            ? `<button type="button" class="ag-cust-ok-open" data-ag-skill-reveal="${escapeHtml(st.createdDir)}">${L('打开目录', 'Open folder')}</button>`
            : ''
        }</div>`
      : '';

    const bodyHtml = isCreate
      ? `
        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-skill-name">${L('技能名称', 'Skill name')} <span class="ag-sched-req">*</span></label>
          <input id="ag-skill-name" class="ag-sched-input" type="text" value="${escapeHtml(st.name)}" placeholder="contract-audit" />
        </div>
        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-skill-desc">${L('触发描述', 'Description')} <span class="ag-sched-req">*</span></label>
          <input id="ag-skill-desc" class="ag-sched-input" type="text" value="${escapeHtml(st.description)}" placeholder="${escapeHtml(
            L('说明何时自动激活该技能（例如：审查商事合同条款并标出风险点）', 'Describe when the agent should activate this skill')
          )}" />
        </div>
        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-skill-body">${L('技能正文（SKILL.md）', 'Instructions (SKILL.md)')} <span class="ag-sched-req">*</span></label>
          <textarea id="ag-skill-body" class="ag-pm-textarea" rows="6" placeholder="${escapeHtml(
            L('# 执行步骤\n1. 先通读用户提供的材料……', '# Workflow\n1. Read the user material carefully...')
          )}">${escapeHtml(st.instructions)}</textarea>
        </div>
        <div class="ag-sched-hint">${L(
          '保存到 ~/.gemini/config/skills/<技能名称>/SKILL.md，Antigravity 会自动扫描识别。',
          'Saved to ~/.gemini/config/skills/<name>/SKILL.md and auto-discovered by Antigravity.'
        )}</div>
      `
      : `
        <div class="ag-cust-import-box">
          <div class="ag-cust-import-title">${L('从本机文件夹导入技能', 'Import a local skill folder')}</div>
          <p class="ag-cust-import-desc">${L(
            '选择一个包含 SKILL.md 的本地技能文件夹，系统将自动完整复制到 ~/.gemini/config/skills/ 目录中。',
            'Pick a local folder containing SKILL.md. It will be copied into ~/.gemini/config/skills/ automatically.'
          )}</p>
          <div class="ag-cust-import-btns">
            <button type="button" class="ag-pm-primary-btn" data-ag-skill-import="true" ${st.saving ? 'disabled' : ''}>${
              st.saving ? L('导入中…', 'Importing…') : L('选择技能文件夹导入…', 'Choose skill folder…')
            }</button>
            <button type="button" class="ag-pm-secondary-btn" data-ag-skill-open-dir="true">${L('打开技能目录', 'Open skills folder')}</button>
          </div>
        </div>
      `;

    rtState.projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog ag-pm-sched-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L('添加技能', 'Add skill'))}">
        <div class="ag-pm-hdr ag-sched-hdr">
          <h2 class="ag-pm-title">${L('添加技能', 'Add skill')}</h2>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>
        <div class="ag-cust-modal-tabs">
          <button type="button" class="ag-cust-mtab" data-ag-skill-mode="create" data-active="${isCreate ? 'true' : 'false'}">${L('新建技能', 'Create skill')}</button>
          <button type="button" class="ag-cust-mtab" data-ag-skill-mode="import" data-active="${!isCreate ? 'true' : 'false'}">${L('导入本地目录', 'Import folder')}</button>
        </div>
        ${bodyHtml}
        ${okHtml}
        ${errHtml}
        <div class="ag-pm-footer ag-sched-footer">
          <button type="button" class="ag-pm-secondary-btn" data-ag-skill-open-dir="true">${L('打开 ~/.gemini/config/skills', 'Open skills folder')}</button>
          <div class="ag-sched-footer-right">
            <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('关闭', 'Close')}</button>
            ${
              isCreate
                ? `<button type="button" class="ag-pm-primary-btn" data-ag-skill-save="true" ${canSave ? '' : 'disabled'}>${
                    st.saving ? L('创建中…', 'Creating…') : L('创建技能', 'Create skill')
                  }</button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;

    rtState.projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });
    rtState.projectsModalEl.querySelectorAll('[data-ag-skill-mode]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.mode = b.getAttribute('data-ag-skill-mode') || 'create';
        rtState.projectsModalState.error = '';
        renderAddSkillModal();
      });
    });
    rtState.projectsModalEl.querySelectorAll('[data-ag-skill-open-dir]').forEach((b) => {
      b.addEventListener('click', () => {
        if (typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('openSkillsDir', {}, 5000);
        }
      });
    });
    const revealBtn = rtState.projectsModalEl.querySelector('[data-ag-skill-reveal]');
    if (revealBtn) {
      revealBtn.addEventListener('click', () => {
        const p = revealBtn.getAttribute('data-ag-skill-reveal');
        if (p && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('revealFile', { targetPath: p }, 5000);
        }
      });
    }

    const nameEl = rtState.projectsModalEl.querySelector('#ag-skill-name');
    const descEl = rtState.projectsModalEl.querySelector('#ag-skill-desc');
    const bodyEl = rtState.projectsModalEl.querySelector('#ag-skill-body');
    const saveBtn = rtState.projectsModalEl.querySelector('[data-ag-skill-save]');
    const syncBtn = () => {
      if (!saveBtn || !rtState.projectsModalState) return;
      saveBtn.disabled = !(
        rtState.projectsModalState.name.trim() &&
        rtState.projectsModalState.description.trim() &&
        rtState.projectsModalState.instructions.trim() &&
        !rtState.projectsModalState.saving
      );
    };
    if (nameEl) {
      if (!st.name) nameEl.focus();
      nameEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.name = nameEl.value;
        syncBtn();
      });
    }
    if (descEl) {
      descEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.description = descEl.value;
        syncBtn();
      });
    }
    if (bodyEl) {
      bodyEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.instructions = bodyEl.value;
        syncBtn();
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const modalRef = rtState.projectsModalState;
        if (!modalRef || modalRef.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          modalRef.error = L('本地写入桥接不可用，请重启 Anti-Claude 守护进程', 'Local write bridge unavailable');
          renderAddSkillModal();
          return;
        }
        modalRef.saving = true;
        modalRef.error = '';
        modalRef.successMsg = '';
        renderAddSkillModal();
        const res = await window.__agProjectCall(
          'createLocalSkill',
          {
            name: modalRef.name,
            description: modalRef.description,
            instructions: modalRef.instructions
          },
          15000
        );
        if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
        modalRef.saving = false;
        if (res && res.ok) {
          modalRef.name = '';
          modalRef.description = '';
          modalRef.instructions = '';
          modalRef.createdDir = res.dirPath || '';
          modalRef.successMsg = L(`已创建技能「${res.folderName}」，重新进入页面或稍候即可在列表中看到。`, `Skill "${res.folderName}" created successfully.`);
          invalidateOverviewSnapshotCache();
          renderAddSkillModal();
        } else {
          const code = (res && res.error) || 'unknown';
          modalRef.error =
            code === 'skill_already_exists'
              ? L('同名技能目录已存在，请换一个名称。', 'A skill with this folder name already exists.')
              : L('创建失败：', 'Create failed: ') + String(code);
          renderAddSkillModal();
        }
      });
    }

    const importBtn = rtState.projectsModalEl.querySelector('[data-ag-skill-import]');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        const modalRef = rtState.projectsModalState;
        if (!modalRef || modalRef.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          modalRef.error = L('本地写入桥接不可用', 'Local write bridge unavailable');
          renderAddSkillModal();
          return;
        }
        modalRef.saving = true;
        modalRef.error = '';
        modalRef.successMsg = '';
        renderAddSkillModal();
        const res = await window.__agProjectCall('importLocalSkill', {}, 120000);
        if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
        modalRef.saving = false;
        if (res && res.ok && res.canceled) {
          renderAddSkillModal();
          return;
        }
        if (res && res.ok) {
          modalRef.createdDir = res.dirPath || '';
          modalRef.successMsg = res.alreadyInstalled
            ? L(`「${res.folderName}」已在全局技能目录中。`, `"${res.folderName}" is already in the skills folder.`)
            : L(`已成功导入技能「${res.folderName}」。`, `Imported skill "${res.folderName}" successfully.`);
          invalidateOverviewSnapshotCache();
          renderAddSkillModal();
        } else {
          const code = (res && res.error) || 'unknown';
          modalRef.error =
            code === 'missing_skill_md'
              ? L('所选文件夹根目录未找到 SKILL.md，请选择包含 SKILL.md 的技能目录。', 'No SKILL.md found in the selected folder.')
              : L('导入失败：', 'Import failed: ') + String(code);
          renderAddSkillModal();
        }
      });
    }
  }

  function openAddAgentModal() {
    ensureSharedModalEscBound();
    closeProjectsModal();
    rtState.projectsModalState = {
      kind: 'addAgent',
      mode: 'create',
      name: '',
      description: '',
      roleMode: 'subagent',
      tools: ['read_file', 'search_web'],
      systemPrompt: '',
      saving: false,
      error: '',
      successMsg: '',
      createdPath: ''
    };
    renderAddAgentModal();
  }

  function renderAddAgentModal() {
    if (!rtState.projectsModalState || rtState.projectsModalState.kind !== 'addAgent') return;
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
    const isCreate = st.mode === 'create';
    const canSave = Boolean(st.name.trim() && st.description.trim() && st.systemPrompt.trim() && !st.saving);
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';
    const okHtml = st.successMsg
      ? `<div class="ag-cust-ok-banner"><span>${escapeHtml(st.successMsg)}</span>${
          st.createdPath
            ? `<button type="button" class="ag-cust-ok-open" data-ag-agent-reveal="${escapeHtml(st.createdPath)}">${L(`在 ${FILE_MANAGER_ZH} 查看`, `Reveal in ${FILE_MANAGER_EN}`)}</button>`
            : ''
        }</div>`
      : '';

    const toolDefs = [
      ['read_file', L('读取文件', 'Read files'), 'read_file'],
      ['search_web', L('联网检索', 'Web search'), 'search_web'],
      ['edit_file', L('编辑文件', 'Edit files'), 'edit_file'],
      ['write_file', L('创建/写入文件', 'Write files'), 'write_file'],
      ['run_command', L('运行命令', 'Run shell'), 'run_command'],
      ['manage_task', L('管理后台任务', 'Manage tasks'), 'manage_task']
    ];
    const selectedSet = new Set(Array.isArray(st.tools) ? st.tools : ['read_file']);
    const hasPreset = (arr) => arr.length === selectedSet.size && arr.every((t) => selectedSet.has(t));

    const bodyHtml = isCreate
      ? `
        <div class="ag-agent-grid-2">
          <div class="ag-sched-field">
            <label class="ag-sched-label" for="ag-agent-name">${L('子 Agent 名称', 'Agent name')} <span class="ag-sched-req">*</span></label>
            <input id="ag-agent-name" class="ag-sched-input" type="text" value="${escapeHtml(st.name)}" placeholder="contract-reviewer" />
          </div>
          <div class="ag-sched-field">
            <label class="ag-sched-label" for="ag-agent-role">${L('角色模式', 'Role mode')}</label>
            <select id="ag-agent-role" class="ag-sched-select ag-agent-full-select">
              <option value="subagent"${st.roleMode === 'subagent' ? ' selected' : ''}>${L('仅子 Agent（推荐，后台委派）', 'Subagent only (Recommended)')}</option>
              <option value="both"${st.roleMode === 'both' ? ' selected' : ''}>${L('子 Agent + 主 Agent', 'Both subagent & main agent')}</option>
              <option value="main_only"${st.roleMode === 'main_only' ? ' selected' : ''}>${L('仅主 Agent', 'Main agent only')}</option>
            </select>
          </div>
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-agent-desc">${L('职责描述（主 AI 据此判断何时委派）', 'Description (when to delegate)')} <span class="ag-sched-req">*</span></label>
          <input id="ag-agent-desc" class="ag-sched-input" type="text" value="${escapeHtml(st.description)}" placeholder="${escapeHtml(
            L('例如：专注核对合同与证据原件的只读审计专员，输出逐条出处与风险点', 'Specialized reviewer for contracts and evidence citations')
          )}" />
        </div>

        <div class="ag-sched-field">
          <div class="ag-agent-tools-hdr">
            <label class="ag-sched-label" style="margin-bottom:0 !important;">${L('工具权限（tools）', 'Tool permissions')}</label>
            <div class="ag-agent-presets">
              <button type="button" class="ag-agent-preset-btn" data-ag-agent-preset="readonly" data-active="${hasPreset(['read_file', 'search_web']) ? 'true' : 'false'}">${L('只读研究', 'Read-only')}</button>
              <button type="button" class="ag-agent-preset-btn" data-ag-agent-preset="editor" data-active="${hasPreset(['read_file', 'edit_file', 'write_file', 'search_web']) ? 'true' : 'false'}">${L('文档编辑', 'Editor')}</button>
              <button type="button" class="ag-agent-preset-btn" data-ag-agent-preset="full" data-active="${hasPreset(['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web']) ? 'true' : 'false'}">${L('完整执行', 'Full tools')}</button>
            </div>
          </div>
          <div class="ag-agent-tools-grid">
            ${toolDefs
              .map(
                ([key, label, code]) => `<label class="ag-agent-tool-chk">
                  <input type="checkbox" data-ag-agent-tool="${key}"${selectedSet.has(key) ? ' checked' : ''} />
                  <span>${escapeHtml(label)}</span>
                  <code>${code}</code>
                </label>`
              )
              .join('')}
          </div>
        </div>

        <div class="ag-sched-field">
          <label class="ag-sched-label" for="ag-agent-prompt">${L('系统提示词（角色设定、工作流程与输出要求）', 'System prompt')} <span class="ag-sched-req">*</span></label>
          <textarea id="ag-agent-prompt" class="ag-pm-textarea" rows="5" placeholder="${escapeHtml(
            L('你是一名严谨的专职审查员。收到任务后：\n1. 逐句核对原始文件；\n2. 仅输出有明确出处的结论……', 'You are a focused specialist subagent. When invoked:\n1. Verify every claim against source files...')
          )}">${escapeHtml(st.systemPrompt)}</textarea>
        </div>
        <div class="ag-sched-hint">${L(
          '自动生成官方格式 ~/.gemini/config/agents/<名称>.md（避免与 self / browser / research 等内置名重名）；模型由主 AI 委派时动态指定（官方 agents/*.md 不设固定 model 字段）。',
          'Saves to ~/.gemini/config/agents/<name>.md using native frontmatter (model is chosen dynamically at invoke time; official agents/*.md does not take a fixed model field).'
        )}</div>
      `
      : `
        <div class="ag-cust-import-box">
          <div class="ag-cust-import-title">${L('导入已有子 Agent 定义文件（.md）', 'Import existing agent Markdown (.md)')}</div>
          <p class="ag-cust-import-desc">${L(
            '选择一个或多个 .md 文件（例如从 Claude Code ~/.claude/agents/ 导出的子 Agent），自动复制到 ~/.gemini/config/agents/。',
            'Pick one or more .md agent files to copy directly into ~/.gemini/config/agents/.'
          )}</p>
          <div class="ag-cust-import-btns">
            <button type="button" class="ag-pm-primary-btn" data-ag-agent-import="true" ${st.saving ? 'disabled' : ''}>${
              st.saving ? L('导入中…', 'Importing…') : L('选择 .md 文件导入…', 'Choose .md file(s)…')
            }</button>
            <button type="button" class="ag-pm-secondary-btn" data-ag-agent-open-dir="true">${L('打开目录', 'Open agents folder')}</button>
          </div>
        </div>
      `;

    rtState.projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog ag-pm-sched-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L('新建子 Agent', 'New subagent'))}">
        <div class="ag-pm-hdr ag-sched-hdr">
          <h2 class="ag-pm-title">${L('新建子 Agent', 'New subagent')}</h2>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>
        <div class="ag-cust-modal-tabs">
          <button type="button" class="ag-cust-mtab" data-ag-agent-mode="create" data-active="${isCreate ? 'true' : 'false'}">${L('新建配置', 'Create')}</button>
          <button type="button" class="ag-cust-mtab" data-ag-agent-mode="import" data-active="${!isCreate ? 'true' : 'false'}">${L('导入 .md 文件', 'Import .md')}</button>
        </div>
        ${bodyHtml}
        ${okHtml}
        ${errHtml}
        <div class="ag-pm-footer ag-sched-footer">
          <button type="button" class="ag-pm-secondary-btn" data-ag-agent-open-dir="true">${L('打开 ~/.gemini/config/agents', 'Open agents folder')}</button>
          <div class="ag-sched-footer-right">
            <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('关闭', 'Close')}</button>
            ${
              isCreate
                ? `<button type="button" class="ag-pm-primary-btn" data-ag-agent-save="true" ${canSave ? '' : 'disabled'}>${
                    st.saving ? L('创建中…', 'Creating…') : L('创建子 Agent', 'Create subagent')
                  }</button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;

    rtState.projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });
    rtState.projectsModalEl.querySelectorAll('[data-ag-agent-mode]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.mode = b.getAttribute('data-ag-agent-mode') || 'create';
        rtState.projectsModalState.error = '';
        renderAddAgentModal();
      });
    });
    rtState.projectsModalEl.querySelectorAll('[data-ag-agent-open-dir]').forEach((b) => {
      b.addEventListener('click', () => {
        if (typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('openAgentsDir', {}, 5000);
        }
      });
    });
    const revealBtn = rtState.projectsModalEl.querySelector('[data-ag-agent-reveal]');
    if (revealBtn) {
      revealBtn.addEventListener('click', () => {
        const p = revealBtn.getAttribute('data-ag-agent-reveal');
        if (p && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('revealFile', { targetPath: p }, 5000);
        }
      });
    }

    const nameEl = rtState.projectsModalEl.querySelector('#ag-agent-name');
    const roleEl = rtState.projectsModalEl.querySelector('#ag-agent-role');
    const descEl = rtState.projectsModalEl.querySelector('#ag-agent-desc');
    const promptEl = rtState.projectsModalEl.querySelector('#ag-agent-prompt');
    const saveBtn = rtState.projectsModalEl.querySelector('[data-ag-agent-save]');
    const syncBtn = () => {
      if (!saveBtn || !rtState.projectsModalState) return;
      saveBtn.disabled = !(
        rtState.projectsModalState.name.trim() &&
        rtState.projectsModalState.description.trim() &&
        rtState.projectsModalState.systemPrompt.trim() &&
        !rtState.projectsModalState.saving
      );
    };
    if (nameEl) {
      if (!st.name) nameEl.focus();
      nameEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.name = nameEl.value;
        syncBtn();
      });
    }
    if (roleEl) {
      roleEl.addEventListener('change', () => {
        if (rtState.projectsModalState) rtState.projectsModalState.roleMode = roleEl.value || 'subagent';
      });
    }
    if (descEl) {
      descEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.description = descEl.value;
        syncBtn();
      });
    }
    if (promptEl) {
      promptEl.addEventListener('input', () => {
        if (!rtState.projectsModalState) return;
        rtState.projectsModalState.systemPrompt = promptEl.value;
        syncBtn();
      });
    }

    rtState.projectsModalEl.querySelectorAll('[data-ag-agent-preset]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!rtState.projectsModalState) return;
        const p = b.getAttribute('data-ag-agent-preset');
        if (p === 'readonly') rtState.projectsModalState.tools = ['read_file', 'search_web'];
        else if (p === 'editor') rtState.projectsModalState.tools = ['read_file', 'edit_file', 'write_file', 'search_web'];
        else rtState.projectsModalState.tools = ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web'];
        renderAddAgentModal();
      });
    });

    rtState.projectsModalEl.querySelectorAll('[data-ag-agent-tool]').forEach((chk) => {
      chk.addEventListener('change', () => {
        if (!rtState.projectsModalState) return;
        const set = new Set(rtState.projectsModalState.tools || []);
        const key = chk.getAttribute('data-ag-agent-tool');
        if (chk.checked) set.add(key);
        else set.delete(key);
        rtState.projectsModalState.tools = Array.from(set);
      });
    });

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const modalRef = rtState.projectsModalState;
        if (!modalRef || modalRef.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          modalRef.error = L('本地写入桥接不可用，请重启 Anti-Claude 守护进程', 'Local write bridge unavailable');
          renderAddAgentModal();
          return;
        }
        modalRef.saving = true;
        modalRef.error = '';
        modalRef.successMsg = '';
        renderAddAgentModal();
        const res = await window.__agProjectCall(
          'createLocalAgent',
          {
            name: modalRef.name,
            description: modalRef.description,
            roleMode: modalRef.roleMode,
            tools: modalRef.tools,
            systemPrompt: modalRef.systemPrompt
          },
          15000
        );
        if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
        modalRef.saving = false;
        if (res && res.ok) {
          modalRef.name = '';
          modalRef.description = '';
          modalRef.systemPrompt = '';
          modalRef.createdPath = res.filePath || res.dirPath || '';
          modalRef.successMsg = L(
            `已创建子 Agent「${res.name}」（~/.gemini/config/agents/${res.name}.md），稍候或重进页面即可看到。`,
            `Subagent "${res.name}" created in ~/.gemini/config/agents/${res.name}.md.`
          );
          invalidateOverviewSnapshotCache();
          renderAddAgentModal();
        } else {
          const code = (res && res.error) || 'unknown';
          modalRef.error =
            code === 'reserved_agent_name'
              ? L('该名称与系统内置 Agent（self / browser / research 等）冲突，请换一个名称。', 'Name conflicts with a built-in agent (self, browser, research, etc.).')
              : code === 'agent_already_exists'
                ? L('同名子 Agent 文件已存在，请换一个名称。', 'An agent with this name already exists.')
                : L('创建失败：', 'Create failed: ') + String(code);
          renderAddAgentModal();
        }
      });
    }

    const importBtn = rtState.projectsModalEl.querySelector('[data-ag-agent-import]');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        const modalRef = rtState.projectsModalState;
        if (!modalRef || modalRef.saving) return;
        if (typeof window.__agProjectCall !== 'function') {
          modalRef.error = L('本地写入桥接不可用', 'Local write bridge unavailable');
          renderAddAgentModal();
          return;
        }
        modalRef.saving = true;
        modalRef.error = '';
        modalRef.successMsg = '';
        renderAddAgentModal();
        const res = await window.__agProjectCall('importLocalAgent', {}, 120000);
        if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
        modalRef.saving = false;
        if (res && res.ok && res.canceled) {
          renderAddAgentModal();
          return;
        }
        if (res && res.ok) {
          const names = (res.imported || []).map((x) => x.name).join('、');
          modalRef.createdPath = (res.imported && res.imported[0] && res.imported[0].filePath) || res.dirPath || '';
          modalRef.successMsg = L(`已成功导入子 Agent：${names}`, `Imported subagent(s): ${names}`);
          invalidateOverviewSnapshotCache();
          renderAddAgentModal();
        } else {
          const code = (res && res.error) || 'unknown';
          modalRef.error =
            code === 'missing_md_file'
              ? L('请选择 .md 格式的子 Agent 定义文件。', 'Please select .md agent definition file(s).')
              : L('导入失败：', 'Import failed: ') + String(code);
          renderAddAgentModal();
        }
      });
    }
  }

  function syncCustomizationsEnhancement() {
    if (rtState.disposed || !FEAT.customizations) {
      teardownCustomizationsEnhancement();
      return;
    }
    const searchInput = document.querySelector('[data-testid="customizations-search"]');
    if (!searchInput) {
      teardownCustomizationsEnhancement();
      return;
    }
    const stickyHdr = searchInput.closest('.sticky');
    const scrollRoot = stickyHdr && stickyHdr.parentElement;
    const bodyWrap = stickyHdr && stickyHdr.nextElementSibling;
    if (!stickyHdr || !scrollRoot || !bodyWrap) return;

    if (custSearchInputRef !== searchInput) {
      if (custSearchInputRef) custSearchInputRef.removeEventListener('input', onCustSearchInput);
      custSearchInputRef = searchInput;
      searchInput.addEventListener('input', onCustSearchInput);
    }

    const instTab = document.querySelector('[data-testid="plugins-tab-installed"]');
    const browseTab = document.querySelector('[data-testid="plugins-tab-browse"]');
    const isBrowse = Boolean(browseTab && browseTab.getAttribute('aria-current') === 'page');
    const isInstalled = !isBrowse && (Boolean(instTab && instTab.getAttribute('aria-current') === 'page') || !browseTab);

    custEnhancementActive = true;
    scrollRoot.setAttribute('data-ag-cust-page', '1');
    scrollRoot.setAttribute('data-ag-cust-tab', isInstalled ? 'installed' : 'browse');
    stickyHdr.setAttribute('data-ag-cust-sticky', '1');

    const searching = Boolean((searchInput.value || '').trim());
    if (searching) scrollRoot.setAttribute('data-ag-cust-searching', '1');
    else scrollRoot.removeAttribute('data-ag-cust-searching');

    if (!isInstalled) {
      const oldBar = document.getElementById('ag-cust-cat-bar');
      if (oldBar) oldBar.remove();
      const oldAct = document.getElementById('ag-cust-skill-actions');
      if (oldAct) oldAct.remove();
      const oldAgentAct = document.getElementById('ag-cust-agent-actions');
      if (oldAgentAct) oldAgentAct.remove();
      return;
    }

    const sections = Array.from(bodyWrap.querySelectorAll('section'));
    const foundByCat = new Map();
    for (const sec of sections) {
      const cat = classifyCustomizationsSection(sec);
      if (!cat) continue;
      sec.setAttribute('data-ag-cust-sec', cat);
      const cntEl = sec.querySelector('[data-testid="customization-section-count"]');
      const countTxt = cntEl ? (cntEl.textContent || '').trim() : '';
      foundByCat.set(cat, { sec, countTxt });
    }

    const orderedCats = ['skills', 'plugins', 'mcp', 'agents'].filter((c) => foundByCat.has(c));
    if (orderedCats.length === 0) return;

    if (!custUserPickedCat && foundByCat.has('skills')) {
      custActiveCat = 'skills';
    } else if (custActiveCat !== 'all' && !foundByCat.has(custActiveCat)) {
      custActiveCat = orderedCats[0] || 'all';
    }

    const catLabels = {
      all: L('全部', 'All'),
      skills: L('技能与规则', 'Skills & Rules'),
      plugins: L('已安装插件', 'Plugins'),
      mcp: L('MCP 服务器', 'MCP Servers'),
      agents: L('自定义 Agent', 'Agents')
    };

    const hdrInner = stickyHdr.firstElementChild || stickyHdr;
    let catBar = document.getElementById('ag-cust-cat-bar');
    if (!catBar || !hdrInner.contains(catBar)) {
      if (catBar) catBar.remove();
      catBar = document.createElement('div');
      catBar.id = 'ag-cust-cat-bar';
      catBar.setAttribute('data-ag-i18n-ignore', '1');
      catBar.setAttribute('role', 'tablist');
      hdrInner.appendChild(catBar);
    }

    const tabsSpec = [...orderedCats, 'all'];
    const sig = tabsSpec.map((k) => `${k}:${k === custActiveCat ? 1 : 0}:${foundByCat.get(k)?.countTxt || ''}:${FEAT.i18n ? 1 : 0}`).join('|');
    if (catBar.dataset.agSig !== sig) {
      catBar.dataset.agSig = sig;
      catBar.innerHTML = tabsSpec
        .map((k) => {
          const active = k === custActiveCat;
          const cnt = k !== 'all' ? foundByCat.get(k)?.countTxt || '' : '';
          return `<button type="button" role="tab" class="ag-cust-cat-tab" data-ag-cust-cat="${k}" data-active="${active ? 'true' : 'false'}" aria-selected="${active ? 'true' : 'false'}"><span>${escapeHtml(
            catLabels[k] || k
          )}</span>${cnt ? `<span class="ag-cust-cat-cnt">${escapeHtml(cnt)}</span>` : ''}</button>`;
        })
        .join('');
      catBar.querySelectorAll('[data-ag-cust-cat]').forEach((b) => {
        b.addEventListener('click', () => {
          custUserPickedCat = true;
          custActiveCat = b.getAttribute('data-ag-cust-cat') || 'all';
          syncCustomizationsEnhancement();
          try {
            scrollRoot.scrollTop = 0;
          } catch {}
        });
      });
    }

    for (const [cat, { sec }] of foundByCat.entries()) {
      const shouldHide = !searching && custActiveCat !== 'all' && cat !== custActiveCat;
      if (shouldHide) sec.setAttribute('data-ag-cust-hidden', '1');
      else sec.removeAttribute('data-ag-cust-hidden');
    }

    /* Inject native-missing "+ Add skill" & "Open skills folder" buttons into Skills & Rules header */
    const skillsEntry = foundByCat.get('skills');
    if (skillsEntry && skillsEntry.sec) {
      const skillsSec = skillsEntry.sec;
      const filterBtn = skillsSec.querySelector('[data-testid="skills-rules-filter"]');
      const hdrRow = (filterBtn && filterBtn.parentElement) || (skillsSec.firstElementChild && skillsSec.firstElementChild);
      if (hdrRow) {
        let actWrap = document.getElementById('ag-cust-skill-actions');
        if (!actWrap || !hdrRow.contains(actWrap)) {
          if (actWrap) actWrap.remove();
          actWrap = document.createElement('div');
          actWrap.id = 'ag-cust-skill-actions';
          actWrap.setAttribute('data-ag-i18n-ignore', '1');
          actWrap.innerHTML =
            `<button type="button" id="ag-cust-open-skills-dir-btn" class="ag-cust-act-icon" title="${escapeHtml(
              L('打开技能目录 (~/.gemini/config/skills)', 'Open skills folder')
            )}" aria-label="${escapeHtml(L('打开技能目录', 'Open skills folder'))}">${SVG_PROJ_FOLDER_OPEN}</button>` +
            `<button type="button" id="ag-cust-add-skill-btn" class="ag-cust-act-btn">${SVG_PROJ_PLUS}<span>${L('添加技能', 'Add skill')}</span></button>`;
          if (filterBtn && filterBtn.parentElement === hdrRow) {
            filterBtn.insertAdjacentElement('beforebegin', actWrap);
          } else {
            hdrRow.appendChild(actWrap);
          }
          actWrap.querySelector('#ag-cust-open-skills-dir-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof window.__agProjectCall === 'function') {
              window.__agProjectCall('openSkillsDir', {}, 5000);
            }
          });
          actWrap.querySelector('#ag-cust-add-skill-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddSkillModal();
          });
        } else {
          const addLbl = actWrap.querySelector('#ag-cust-add-skill-btn span');
          if (addLbl) addLbl.textContent = L('添加技能', 'Add skill');
        }
      }
    }

    /* Inject native-missing "+ New subagent" & "Open agents folder" buttons into Custom Agents header */
    const agentsEntry = foundByCat.get('agents');
    if (agentsEntry && agentsEntry.sec) {
      const agentsSec = agentsEntry.sec;
      const hdrRow = agentsSec.firstElementChild;
      if (hdrRow) {
        let actWrap = document.getElementById('ag-cust-agent-actions');
        if (!actWrap || !hdrRow.contains(actWrap)) {
          if (actWrap) actWrap.remove();
          actWrap = document.createElement('div');
          actWrap.id = 'ag-cust-agent-actions';
          actWrap.className = 'ag-cust-hdr-actions';
          actWrap.setAttribute('data-ag-i18n-ignore', '1');
          actWrap.innerHTML =
            `<button type="button" id="ag-cust-open-agents-dir-btn" class="ag-cust-act-icon" title="${escapeHtml(
              L('打开子 Agent 目录 (~/.gemini/config/agents)', 'Open agents folder')
            )}" aria-label="${escapeHtml(L('打开子 Agent 目录', 'Open agents folder'))}">${SVG_PROJ_FOLDER_OPEN}</button>` +
            `<button type="button" id="ag-cust-add-agent-btn" class="ag-cust-act-btn">${SVG_PROJ_PLUS}<span>${L('新建子 Agent', 'New subagent')}</span></button>`;
          hdrRow.appendChild(actWrap);
          actWrap.querySelector('#ag-cust-open-agents-dir-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof window.__agProjectCall === 'function') {
              window.__agProjectCall('openAgentsDir', {}, 5000);
            }
          });
          actWrap.querySelector('#ag-cust-add-agent-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddAgentModal();
          });
        } else {
          const addLbl = actWrap.querySelector('#ag-cust-add-agent-btn span');
          if (addLbl) addLbl.textContent = L('新建子 Agent', 'New subagent');
        }
      }
    }
  }


  return {
    syncCustomizationsEnhancement,
    teardownCustomizationsEnhancement,
    dispose: () => teardownCustomizationsEnhancement(true),
  };
}
