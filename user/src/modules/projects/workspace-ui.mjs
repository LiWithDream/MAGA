/**
 * Projects Detail Cockpit UI builders: Streamlined Topbar with Project Switcher,
 * Hero Header in left column, Interactive Git drawer & commits, Quick Actions strip,
 * Remote Repo links, Clean Markdown preview & Recents filter header.
 */
export function createProjectWorkspaceUi(ctx) {
  const { L, rtState, escapeHtml, pState, pHooks, ICONS } = ctx;
  const {
    SVG_CLAUDE_PROJECTS_ICON,
    SVG_PROJ_SEARCH_ICON,
    SVG_PROJ_GIT_BRANCH,
    SVG_PROJ_CHEVRON,
    SVG_PROJ_EXTERNAL,
    SVG_PROJ_FOLDER_OPEN,
    SVG_PROJ_FOLDER_ADD,
    SVG_PROJ_REFRESH,
    RECENT_PIN_SVG,
    RECENT_MORE_SVG,
  } = ICONS;

  const SVG_AI_SPARKLE =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.25c.32 0 .59.22.66.53l.74 3.23c.2.88.88 1.56 1.76 1.76l3.23.74a.68.68 0 0 1 0 1.32l-3.23.74a2.4 2.4 0 0 0-1.76 1.76l-.74 3.23a.68.68 0 0 1-1.32 0l-.74-3.23a2.4 2.4 0 0 0-1.76-1.76l-3.23-.74a.68.68 0 0 1 0-1.32l3.23-.74a2.4 2.4 0 0 0 1.76-1.76l.74-3.23c.07-.31.34-.53.66-.53z"/></svg>';

  function emitProjectsEvent(name, detail) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    const Ctor = window.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (!Ctor) return;
    try {
      window.dispatchEvent(detail === undefined ? new Ctor(name) : new Ctor(name, { detail }));
    } catch {}
  }

  function openExternalOrWindow(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (typeof window.__agProjectCall === 'function') {
      Promise.resolve(window.__agProjectCall('openExternalUrl', { url }, 4000))
        .then((res) => {
          if (!res || !res.ok) {
            try {
              window.open(url, '_blank', 'noopener,noreferrer');
            } catch {}
          }
        })
        .catch(() => {});
      return;
    }
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {}
  }

  function encodeLocalFileUri(absPath) {
    const norm = String(absPath || '').replace(/\\/g, '/');
    if (!norm) return '';
    try {
      return ('file://' + encodeURI(norm.startsWith('/') ? norm : '/' + norm)).replace(/[?#]/g, encodeURIComponent);
    } catch {
      return '';
    }
  }

  function buildFileMentionItem(project, relPath) {
    const rel = String(relPath || '').replace(/^\/+/, '').trim();
    if (!project?.dirPath || !rel) return null;
    const base = String(project.dirPath).replace(/[\\/]+$/, '');
    const abs = `${base}/${rel}`;
    const absUri = encodeLocalFileUri(abs);
    const primaryUri = encodeLocalFileUri(project.dirPath);
    if (!absUri) return null;
    const name = rel.split('/').pop() || rel;
    return {
      kind: 'file',
      label: name,
      desc: rel,
      scopeItem: {
        $typeName: 'exa.codeium_common_pb.ContextScopeItem',
        scopeItem: {
          case: 'file',
          value: {
            $typeName: 'exa.codeium_common_pb.PathScopeItem',
            absoluteUri: absUri,
            workspaceUrisToRelativePaths: primaryUri ? { [primaryUri]: rel } : {},
            numFiles: 0,
          },
        },
      },
    };
  }

  function fetchProjectWorkspaceStatus(dirPath, opts = {}) {
    if (!dirPath || typeof window.__agProjectCall !== 'function') return;
    const force = Boolean(opts && opts.force);
    const worktreePath =
      opts && typeof opts.worktreePath === 'string'
        ? opts.worktreePath
        : pState.pdActiveWorktreeByProj?.[dirPath] || '';
    const statusKey = worktreePath ? `${dirPath}::${worktreePath}` : dirPath;
    const existing = pState.projectsWorkspaceStatusMap[statusKey] || (!worktreePath ? pState.projectsWorkspaceStatusMap[dirPath] : null);
    const now = Date.now();
    if (!force && existing && existing.fetchedAt && now - existing.fetchedAt < 15000) return;
    if (pState.projectsWorkspaceBusyDirs.has(statusKey)) return;
    pState.projectsWorkspaceBusyDirs.add(statusKey);
    const prevSig = JSON.stringify(existing || null);
    window
      .__agProjectCall('readProjectWorkspaceStatus', { dirPath, worktreePath, force }, 6000)
      .then((res) => {
        pState.projectsWorkspaceBusyDirs.delete(statusKey);
        if (rtState.disposed || !res || !res.ok) return;
        pState.projectsWorkspaceStatusMap[statusKey] = res;
        if (res.activeWorktreePath) {
          pState.projectsWorkspaceStatusMap[`${dirPath}::${res.activeWorktreePath}`] = res;
        }
        if (!worktreePath || worktreePath === dirPath || res.activeWorktreePath === dirPath) {
          pState.projectsWorkspaceStatusMap[dirPath] = res;
        }
        if (Array.isArray(res.worktrees) && res.worktrees.length) {
          pState.repoWorktreesMap[dirPath] = {
            ts: Date.now(),
            hasStats: true,
            data: { ok: true, mainDirPath: res.mainDirPath || dirPath, worktrees: res.worktrees },
          };
        }
        if (res.workflowPolicy && typeof res.workflowPolicy === 'object') {
          pState.pdWorkflowPolicyByProj[dirPath] = res.workflowPolicy;
        }
        if (rtState.projectsViewOpen && pState.activeProjectId) {
          const active = (pHooks.collectNativeProjects?.() || []).find((p) => p.id === pState.activeProjectId);
          if (active && active.dirPath === dirPath && (force || JSON.stringify(res) !== prevSig)) {
            pHooks.renderProjectsView?.();
          }
        }
      })
      .catch(() => {
        pState.projectsWorkspaceBusyDirs.delete(statusKey);
      });
  }

  function fetchCommitDetail(dirPath, hash) {
    if (!dirPath || !hash || typeof window.__agProjectCall !== 'function') return;
    const key = `${dirPath}:${hash}`;
    const cached = pState.pdCommitDetailMap[key];
    if (cached && (cached.ok || Date.now() - (cached.ts || 0) <= 5000)) return;
    if (pState.pdCommitBusyKey === key) return;
    pState.pdCommitBusyKey = key;
    Promise.resolve(window.__agProjectCall('readGitCommitDetail', { dirPath, hash }, 5000))
      .then((res) => {
        if (pState.pdCommitBusyKey === key) pState.pdCommitBusyKey = '';
        if (rtState.disposed) return;
        const mapKeys = Object.keys(pState.pdCommitDetailMap);
        if (!Object.prototype.hasOwnProperty.call(pState.pdCommitDetailMap, key) && mapKeys.length >= 40) {
          delete pState.pdCommitDetailMap[mapKeys[0]];
        }
        pState.pdCommitDetailMap[key] =
          res && res.ok ? res : { ok: false, error: res?.error || 'unavailable', ts: Date.now() };
        if (rtState.projectsViewOpen && pState.pdExpandedCommitHash === hash) {
          pHooks.renderProjectsView?.();
        }
      })
      .catch(() => {
        if (pState.pdCommitBusyKey === key) pState.pdCommitBusyKey = '';
      });
  }

  function bindProjectWorkspaceEvents({ el, project, hadChatSearchFocus, chatSelStart, onSwitchProject }) {
    el.querySelectorAll('[data-ag-pd-open-finder]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (project.dirPath && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall(
            'revealFile',
            { dirPath: project.dirPath, targetPath: project.dirPath, openFolder: true },
            5000
          );
        }
      });
      b.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!project.dirPath) return;
        try {
          await navigator.clipboard?.writeText?.(project.dirPath);
          pHooks.showProjectsFloatingNotice?.(L('已复制项目路径', 'Copied project path'));
        } catch {
          pHooks.showProjectsFloatingNotice?.(project.dirPath);
        }
      });
    });

    el.querySelectorAll('[data-ag-pd-open-remote]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = b.getAttribute('data-ag-pd-open-remote');
        if (url) openExternalOrWindow(url);
      });
      b.addEventListener('contextmenu', async (e) => {
        const url = b.getAttribute('data-ag-pd-open-remote');
        if (!url) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard?.writeText?.(url);
          pHooks.showProjectsFloatingNotice?.(L('已复制仓库链接', 'Copied repository URL'));
        } catch {
          pHooks.showProjectsFloatingNotice?.(url);
        }
      });
    });

    el.querySelectorAll('[data-ag-pd-toggle-dirty]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pState.pdDirtyExpanded = !pState.pdDirtyExpanded;
        pHooks.renderProjectsView?.();
      });
    });

    el.querySelectorAll('[data-ag-pd-commit-hash]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hash = b.getAttribute('data-ag-pd-commit-hash') || '';
        if (!hash) return;
        pState.pdExpandedCommitHash = pState.pdExpandedCommitHash === hash ? '' : hash;
        pHooks.renderProjectsView?.();
        const activeDir = (project.dirPath && pState.pdActiveWorktreeByProj?.[project.dirPath]) || project.dirPath;
        if (pState.pdExpandedCommitHash && activeDir) {
          fetchCommitDetail(activeDir, hash);
        }
      });
    });

    el.querySelectorAll('[data-ag-pd-copy-hash]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hash = b.getAttribute('data-ag-pd-copy-hash') || '';
        if (!hash) return;
        try {
          await navigator.clipboard?.writeText?.(hash);
          pHooks.showProjectsFloatingNotice?.(L(`已复制 Hash: ${hash}`, `Copied hash: ${hash}`));
        } catch {
          pHooks.showProjectsFloatingNotice?.(hash);
        }
      });
    });

    el.querySelectorAll('[data-ag-pd-reveal-rel]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rel = b.getAttribute('data-ag-pd-reveal-rel') || '';
        const activeDir = (project.dirPath && pState.pdActiveWorktreeByProj?.[project.dirPath]) || project.dirPath;
        if (!rel || !activeDir || typeof window.__agProjectCall !== 'function') return;
        const targetPath = `${String(activeDir).replace(/[\\/]+$/, '')}/${rel.replace(/^\/+/, '')}`;
        window.__agProjectCall('revealFile', { dirPath: project.dirPath, targetPath }, 5000);
      });
    });

    el.querySelectorAll('[data-ag-pd-mention-rel]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rel = b.getAttribute('data-ag-pd-mention-rel') || '';
        const compInput = el.querySelector('#ag-pd-composer-input');
        const activeDir = (project.dirPath && pState.pdActiveWorktreeByProj?.[project.dirPath]) || project.dirPath;
        const item = buildFileMentionItem({ ...project, dirPath: activeDir }, rel);
        if (item && compInput) {
          pHooks.appendDroppedMentionsToPdComposer?.(project, compInput, [item]);
        }
      });
    });

    pHooks.bindCockpitWorktreeEvents?.({
      el,
      project,
      onRefreshStatus: (wtPath, force) => fetchProjectWorkspaceStatus(project.dirPath, { worktreePath: wtPath, force }),
    });

    const crumbToggle = el.querySelector('[data-ag-pd-crumb-toggle]');
    if (crumbToggle) {
      crumbToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pState.pdBreadcrumbMenuOpen = !pState.pdBreadcrumbMenuOpen;
        pHooks.renderProjectsView?.();
      });
    }

    el.querySelectorAll('[data-ag-pd-crumb-select]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nextId = b.getAttribute('data-ag-pd-crumb-select') || '';
        pState.pdBreadcrumbMenuOpen = false;
        if (nextId && nextId !== project.id) {
          onSwitchProject?.(nextId);
        } else {
          pHooks.renderProjectsView?.();
        }
      });
    });

    const chatSearchInput = el.querySelector('#ag-pd-chat-search');
    if (chatSearchInput) {
      if (hadChatSearchFocus) {
        chatSearchInput.focus();
        if (typeof chatSelStart === 'number') {
          try {
            chatSearchInput.setSelectionRange(chatSelStart, chatSelStart);
          } catch {}
        }
      }
      chatSearchInput.addEventListener('input', () => {
        pState.projectChatSearchQuery = chatSearchInput.value || '';
        pHooks.renderProjectsView?.();
      });
    }
  }

  function cleanInlineMarkdown(raw) {
    return String(raw || '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '• ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatInstructionsPreview(rawMarkdown) {
    const raw = String(rawMarkdown || '').trim();
    if (!raw) return { html: '', lineCount: 0 };
    const rawLines = raw.split(/\r?\n/);
    let heading = '';
    const lines = [];
    let inFence = false;
    let nonEmptyCount = 0;

    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^```/.test(trimmed)) {
        inFence = !inFence;
        continue;
      }
      nonEmptyCount += 1;
      if (inFence || /^[-*_]{3,}$/.test(trimmed)) continue;

      const headingMatch = trimmed.match(/^#{1,4}\s+(.+)$/);
      if (headingMatch) {
        const cleanHead = cleanInlineMarkdown(headingMatch[1]);
        if (!heading && cleanHead) heading = cleanHead;
        else if (cleanHead && lines.length < 3) lines.push(cleanHead);
        continue;
      }

      const strippedQuote = trimmed.replace(/^>+\s*/, '');
      const cleanLine = cleanInlineMarkdown(strippedQuote);
      if (cleanLine && lines.length < 3) lines.push(cleanLine);
    }

    const headHtml = heading ? `<div class="ag-pd-inst-title">${escapeHtml(heading)}</div>` : '';
    const bodyHtml = lines.length
      ? `<div class="ag-pd-inst-lines">${lines.map((ln) => `<div class="ag-pd-inst-line">${escapeHtml(ln)}</div>`).join('')}</div>`
      : '';
    return {
      lineCount: nonEmptyCount,
      html: `<div class="ag-pd-inst-rich">${headHtml}${bodyHtml}</div>`,
    };
  }

  function buildTopbarHtml({ project, allProjects }) {
    const list = Array.isArray(allProjects) ? allProjects : [];
    const hasSwitcher = list.length > 1;
    let curCrumbHtml = '';
    if (hasSwitcher) {
      const menuHtml = pState.pdBreadcrumbMenuOpen
        ? `<div class="ag-pd-crumb-menu" role="menu">${list
            .map((p) => {
              const isCur = p.id === project.id;
              return `<button type="button" class="ag-pd-crumb-opt" role="menuitem" data-active="${isCur ? 'true' : 'false'}" data-ag-pd-crumb-select="${escapeHtml(p.id)}">
                <span class="ag-pd-crumb-opt-name">${escapeHtml(p.name)}</span>
                <span class="ag-pd-crumb-opt-meta">${escapeHtml(String(p.chatCount || 0))}</span>
                ${isCur ? '<span class="ag-pd-crumb-check" aria-hidden="true">✓</span>' : ''}
              </button>`;
            })
            .join('')}</div>`
        : '';
      curCrumbHtml = `<div class="ag-pd-crumb-wrap">
        <button type="button" class="ag-pd-crumb-switch" data-ag-pd-crumb-toggle="true" aria-haspopup="menu" aria-expanded="${pState.pdBreadcrumbMenuOpen ? 'true' : 'false'}" title="${escapeHtml(L('切换项目', 'Switch project'))}">
          <span class="ag-pd-crumb-cur">${escapeHtml(project.name)}</span>
          ${SVG_PROJ_CHEVRON}
        </button>
        ${menuHtml}
      </div>`;
    } else {
      curCrumbHtml = `<span class="ag-pd-crumb-cur">${escapeHtml(project.name)}</span>`;
    }

    const moreBtnHtml = !project.isBuiltin
      ? `<button type="button" class="ag-pd-more-btn" data-ag-pd-proj-menu="true" aria-label="${escapeHtml(L('项目操作', 'Project options'))}" title="${escapeHtml(L('更多操作', 'More options'))}">${RECENT_MORE_SVG}</button>`
      : '';

    return `
      <div class="ag-pd-topbar">
        <nav class="ag-pd-breadcrumb" aria-label="Breadcrumb">
          <button type="button" class="ag-pd-crumb-root" data-ag-pd-back="true">${L('项目', 'Projects')}</button>
          <span class="ag-pd-crumb-sep">/</span>
          ${curCrumbHtml}
        </nav>
        ${moreBtnHtml ? `<div class="ag-pd-topbar-right">${moreBtnHtml}</div>` : ''}
      </div>
    `;
  }

  function buildGitMetaTag(git, remoteUrl) {
    if (!git || !git.branch) return '';
    const dirty = Number(git.changedFiles || 0);
    const added = Number(git.added || 0);
    const deleted = Number(git.deleted || 0);
    const stateLabel = dirty > 0 ? L(`${dirty} 个修改`, `${dirty} modified`) : 'clean';
    const diffTip = dirty > 0 ? ` (+${added} / -${deleted})` : '';
    const inner = `${SVG_PROJ_GIT_BRANCH}<span>${escapeHtml(git.branch)}</span><span class="ag-pd-meta-dot" aria-hidden="true"></span><span class="ag-pd-meta-state">${escapeHtml(stateLabel)}</span>`;
    if (dirty > 0) {
      return `<button type="button" class="ag-pd-meta-chip ag-pd-meta-git" data-dirty="true" data-ag-pd-toggle-dirty="true" title="${escapeHtml(`${git.branch} · ${stateLabel}${diffTip} — ${L('点击展开改动清单', 'Click to view dirty files')}`)}">${inner}</button>`;
    }
    if (remoteUrl) {
      return `<button type="button" class="ag-pd-meta-chip ag-pd-meta-git" data-dirty="false" data-ag-pd-open-remote="${escapeHtml(remoteUrl)}" title="${escapeHtml(`${git.branch} · clean — ${L('点击打开远程仓库', 'Click to open remote repo')}`)}">${inner}</button>`;
    }
    return `<span class="ag-pd-meta-chip ag-pd-meta-git" data-dirty="false" title="${escapeHtml(`${git.branch} · ${stateLabel}`)}">${inner}</span>`;
  }

  function buildProjectHeroHtml({ project, wsStatus, hasLocalDir, shortPath }) {
    const data = wsStatus && wsStatus.ok ? wsStatus : null;
    const rawVer = data?.latestTag || (data?.pkgVersion ? `v${data.pkgVersion}` : '');
    const verBadgeHtml = rawVer ? `<span class="ag-pd-ver-badge">${escapeHtml(rawVer)}</span>` : '';
    const chatCount = Array.isArray(project?.chats) ? project.chats.length : 0;
    const remoteUrl = project?.remoteUrl || data?.remoteUrl || '';
    const remoteLabel = project?.remoteLabel || data?.remoteLabel || remoteUrl;

    const metaChips = [];
    if (hasLocalDir && shortPath) {
      metaChips.push(
        `<button type="button" class="ag-pd-meta-chip ag-pd-meta-path" data-ag-pd-open-finder="true" title="${escapeHtml(L('点击在访达中打开 · 右键复制路径：', 'Click to open in Finder · Right-click to copy: ') + project.dirPath)}">${SVG_CLAUDE_PROJECTS_ICON}<span>${escapeHtml(shortPath)}</span></button>`
      );
    } else if (remoteUrl) {
      metaChips.push(
        `<button type="button" class="ag-pd-meta-chip ag-pd-meta-path ag-pd-meta-remote" data-ag-pd-open-remote="${escapeHtml(remoteUrl)}" title="${escapeHtml(L('点击在浏览器打开 Git 仓库 · 右键复制链接：', 'Click to open Git repository · Right-click to copy: ') + remoteUrl)}">${SVG_PROJ_EXTERNAL}<span>${escapeHtml(remoteLabel)}</span></button>`
      );
    }
    if (data?.git) {
      metaChips.push(buildGitMetaTag(data.git, remoteUrl));
    }
    metaChips.push(
      `<span class="ag-pd-meta-chip">${escapeHtml(L(`${chatCount} 场对话`, `${chatCount} ${chatCount === 1 ? 'chat' : 'chats'}`))}</span>`,
      `<span id="agy-pd-hero-usage" data-maga-own="1" class="ag-pd-meta-chip ag-pd-meta-usage" hidden></span>`
    );

    return `
      <div class="ag-pd-title-row ag-pd-hero">
        <div class="ag-pd-hero-main">
          <div class="ag-pd-hero-title-wrap">
            <h1 class="ag-pd-title">${escapeHtml(project.name)}</h1>
            ${verBadgeHtml}
          </div>
          <div class="ag-pd-meta-strip">${metaChips.join('')}</div>
        </div>
      </div>
    `;
  }

  function buildCommitDetailHtml({ project, commit, remoteUrl, activeDir }) {
    if (pState.pdExpandedCommitHash !== commit.hash) return '';
    const detailDir = activeDir || (project.dirPath && pState.pdActiveWorktreeByProj?.[project.dirPath]) || project.dirPath;
    const cacheKey = `${detailDir}:${commit.hash}`;
    const detail = pState.pdCommitDetailMap[cacheKey] || null;
    const isLoading = pState.pdCommitBusyKey === cacheKey;

    if (!detail) {
      return `<div class="ag-pd-commit-detail">${
        isLoading
          ? `<div class="ag-pd-card-muted">${L('正在加载提交详情…', 'Loading commit details…')}</div>`
          : `<div class="ag-pd-card-muted">${L('准备读取提交详情…', 'Reading commit metadata…')}</div>`
      }</div>`;
    }
    if (!detail.ok) {
      return `<div class="ag-pd-commit-detail"><div class="ag-pd-card-muted">${L('无法读取该提交明细。', 'Commit details unavailable.')}</div></div>`;
    }

    const files = Array.isArray(detail.files) ? detail.files : [];
    const shownFiles = files.slice(0, 7);
    const filesHtml = shownFiles.length
      ? `<div class="ag-pd-commit-files">${shownFiles
          .map(
            (f) => `<button type="button" class="ag-pd-commit-file-btn" data-ag-pd-reveal-rel="${escapeHtml(f.path)}" title="${escapeHtml(`${f.path} (+${f.added}/-${f.deleted})`)}">
              <span class="ag-pd-dirty-path-txt">${escapeHtml(f.path)}</span>
              <span class="ag-pd-dirty-stat">+${f.added} -${f.deleted}</span>
            </button>`
          )
          .join('')}${
          detail.totalFiles > shownFiles.length
            ? `<div class="ag-pd-commit-more">${escapeHtml(L(`还有 ${detail.totalFiles - shownFiles.length} 个改动文件`, `+${detail.totalFiles - shownFiles.length} more files`))}</div>`
            : ''
        }</div>`
      : '';

    const askPrompt = L(
      `请使用 \`git show ${commit.hash}\` 检查这次提交（"${commit.subject}"）的全部代码改动，梳理影响范围并指出潜在风险。`,
      `Inspect commit \`${commit.hash}\` ("${commit.subject}") via \`git show ${commit.hash}\`, summarize the changes, and flag any risks.`
    );
    const fullHash = detail.fullHash || commit.fullHash || commit.hash;
    let remoteCommitUrl = '';
    if (remoteUrl) {
      let host = '';
      try {
        host = new URL(remoteUrl).hostname.toLowerCase();
      } catch {}
      if (host.includes('gitlab')) remoteCommitUrl = `${remoteUrl}/-/commit/${fullHash}`;
      else if (host.includes('bitbucket')) remoteCommitUrl = `${remoteUrl}/commits/${fullHash}`;
      else remoteCommitUrl = `${remoteUrl}/commit/${fullHash}`;
    }
    const remoteCommitBtn = remoteCommitUrl
      ? `<button type="button" class="ag-pd-git-act-btn" data-ag-pd-open-remote="${escapeHtml(remoteCommitUrl)}">${L('Git 链接 ↗', 'Remote ↗')}</button>`
      : '';

    return `
      <div class="ag-pd-commit-detail" data-ag-pd-commit-detail="${escapeHtml(commit.hash)}">
        <div class="ag-pd-commit-meta">${escapeHtml([detail.author, detail.date, detail.totalFiles ? L(`${detail.totalFiles} 个文件`, `${detail.totalFiles} files`) : ''].filter(Boolean).join(' · '))}</div>
        ${detail.body ? `<div class="ag-pd-commit-body">${escapeHtml(detail.body)}</div>` : ''}
        ${filesHtml}
        <div class="ag-pd-git-actions">
          <button type="button" class="ag-pd-git-act-btn is-primary" data-ag-pd-starter-prompt="${escapeHtml(askPrompt)}">${L('让 Agent 分析', 'Ask Agent')}</button>
          <button type="button" class="ag-pd-git-act-btn" data-ag-pd-copy-hash="${escapeHtml(commit.hash)}">${L('复制 Hash', 'Copy hash')}</button>
          ${remoteCommitBtn}
        </div>
      </div>
    `;
  }

  function buildWorkspacePulseSectionHtml({ project, hasLocalDir, wsStatus, isLoading }) {
    const data = wsStatus && wsStatus.ok ? wsStatus : null;
    const remoteUrl = project?.remoteUrl || data?.remoteUrl || '';
    const remoteLabel = project?.remoteLabel || data?.remoteLabel || remoteUrl;

    if (!hasLocalDir) {
      if (!remoteUrl) return '';
      return `
        <div class="ag-pd-section ag-pd-repo-sec" data-ag-pd-repo-sec="true">
          <div class="ag-pd-sec-hdr">
            <span class="ag-pd-sec-title">${L('代码仓库', 'Repository')}</span>
            <button type="button" class="ag-pd-repo-ext-btn" data-ag-pd-open-remote="${escapeHtml(remoteUrl)}" title="${escapeHtml(remoteUrl)}">${SVG_PROJ_EXTERNAL}</button>
          </div>
          <button type="button" class="ag-pd-remote-link-row" data-ag-pd-open-remote="${escapeHtml(remoteUrl)}">
            ${SVG_PROJ_GIT_BRANCH}
            <span>${escapeHtml(remoteLabel)}</span>
            <span class="ag-pd-remote-arrow">↗</span>
          </button>
        </div>
      `;
    }

    const git = data?.git || null;
    const commits = Array.isArray(data?.recentCommits) ? data.recentCommits.slice(0, 3) : [];
    const dirtyFiles = Array.isArray(data?.dirtyFiles) ? data.dirtyFiles : [];
    const dirtyCount = Number(git?.changedFiles || 0);
    const wtStripHtml = pHooks.buildCockpitWorktreeStripHtml?.({ project, wsStatus }) || '';
    const hasWtStrip = Boolean(wtStripHtml);

    const extBtnHtml = remoteUrl
      ? `<button type="button" class="ag-pd-repo-ext-btn" data-ag-pd-open-remote="${escapeHtml(remoteUrl)}" title="${escapeHtml(L('在浏览器打开远程仓库：', 'Open remote repo: ') + remoteLabel)}" aria-label="${escapeHtml(L('打开远程仓库', 'Open remote repo'))}">${SVG_PROJ_EXTERNAL}</button>`
      : '';

    const added = Number(git?.added || 0);
    const deleted = Number(git?.deleted || 0);
    const diffParts = [];
    if (added > 0) diffParts.push(`<span class="ag-pd-diff-add">+${added}</span>`);
    if (deleted > 0) diffParts.push(`<span class="ag-pd-diff-del">-${deleted}</span>`);
    const diffStatHtml = diffParts.length ? `<span class="ag-pd-repo-diff">${diffParts.join('')}</span>` : '';

    const dirtyPillHtml = dirtyCount > 0
      ? `<button type="button" class="ag-pd-repo-status ag-pd-repo-dirty ag-pd-repo-dirty-btn" data-ag-pd-toggle-dirty="true" aria-expanded="${pState.pdDirtyExpanded ? 'true' : 'false'}" title="${escapeHtml(L('点击展开或收起未提交文件', 'Click to inspect uncommitted files'))}"><span class="ag-pd-repo-dirty-cnt">${escapeHtml(L(`${dirtyCount} 修改`, `${dirtyCount} mod`))}</span>${diffStatHtml}<svg class="ag-pd-repo-chev" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
      : `<span class="ag-pd-repo-status ag-pd-repo-clean"><span class="ag-pd-repo-clean-dot" aria-hidden="true"></span><span>${escapeHtml(L('干净', 'Clean'))}</span></span>`;

    const branchPillHtml = !hasWtStrip && git?.branch
      ? `<span class="ag-pd-repo-branch" title="${escapeHtml(git.branch)}">${escapeHtml(git.branch)}</span>`
      : '';

    const rightPills = git
      ? `<div class="ag-pd-repo-pills">${branchPillHtml}${dirtyPillHtml}${extBtnHtml}</div>`
      : isLoading
        ? `<div class="ag-pd-repo-pills"><span class="ag-pd-repo-status ag-pd-repo-loading">${L('读取中…', 'Loading…')}</span>${extBtnHtml}</div>`
        : extBtnHtml
          ? `<div class="ag-pd-repo-pills">${extBtnHtml}</div>`
          : '';

    let dirtyDrawerHtml = '';
    if (pState.pdDirtyExpanded && dirtyFiles.length > 0) {
      const reviewPrompt = L(
        `请检查当前工作区全部 ${dirtyCount} 个未提交改动（\`git status\` / \`git diff\`），总结关键变更并排查潜在风险。`,
        `Inspect all ${dirtyCount} uncommitted changes (\`git status\` / \`git diff\`), summarize the diff, and check for bugs or risks.`
      );
      const commitPrompt = L(
        '请查看当前 `git diff`，为这批未提交改动拟定一条清晰规范的 Conventional Commit 提交信息（先不要自动提交）。',
        'Review current `git diff` and draft a concise Conventional Commit message for these changes (do not commit yet).'
      );
      dirtyDrawerHtml = `
        <div class="ag-pd-dirty-drawer" data-ag-pd-dirty-drawer="true">
          <div class="ag-pd-dirty-list">
            ${dirtyFiles
              .map((f) => {
                const statTxt = f.added || f.deleted ? `+${f.added} -${f.deleted}` : '';
                return `<div class="ag-pd-dirty-row">
                  <span class="ag-pd-dirty-st" data-st="${escapeHtml(f.status)}">${escapeHtml(f.status)}</span>
                  <button type="button" class="ag-pd-dirty-path" data-ag-pd-reveal-rel="${escapeHtml(f.path)}" title="${escapeHtml(L('在访达中定位：', 'Reveal in Finder: ') + f.path)}">${escapeHtml(f.path)}</button>
                  ${statTxt ? `<span class="ag-pd-dirty-stat">${escapeHtml(statTxt)}</span>` : ''}
                  <button type="button" class="ag-pd-dirty-mention-btn" data-ag-pd-mention-rel="${escapeHtml(f.path)}" title="${escapeHtml(L('引用 @文件 到输入框', 'Mention @file in composer'))}" aria-label="${escapeHtml(L('引用文件', 'Mention file'))}">+</button>
                </div>`;
              })
              .join('')}
          </div>
          <div class="ag-pd-git-actions">
            <button type="button" class="ag-pd-git-act-btn is-primary" data-ag-pd-starter-prompt="${escapeHtml(reviewPrompt)}">${L('审查全部改动', 'Review changes')}</button>
            <button type="button" class="ag-pd-git-act-btn" data-ag-pd-starter-prompt="${escapeHtml(commitPrompt)}">${L('生成 Commit', 'Draft commit')}</button>
          </div>
        </div>
      `;
    }

    let bodyHtml = '';
    if (commits.length) {
      bodyHtml = `<div class="ag-pd-commit-list">${commits
        .map((c) => {
          const isExp = pState.pdExpandedCommitHash === c.hash;
          return `<div class="ag-pd-commit-item" data-expanded="${isExp ? 'true' : 'false'}">
            <button type="button" class="ag-pd-commit-row" data-ag-pd-commit-hash="${escapeHtml(c.hash)}" data-expanded="${isExp ? 'true' : 'false'}" title="${escapeHtml(`${c.hash} ${c.subject} — ${L('点击展开详情', 'Click for details')}`)}">
              <span class="ag-pd-commit-hash">${escapeHtml(c.hash)}</span>
              <span class="ag-pd-commit-subj">${escapeHtml(c.subject)}</span>
              <span class="ag-pd-commit-time">${escapeHtml(c.relTime)}</span>
            </button>
            ${buildCommitDetailHtml({ project, commit: c, remoteUrl, activeDir: data?.activeWorktreePath || project.dirPath })}
          </div>`;
        })
        .join('')}</div>`;
    } else if (isLoading && !data) {
      bodyHtml = `<div class="ag-pd-card-muted">${L('正在读取本地 Git 状态与最近提交…', 'Reading Git branch & recent commits…')}</div>`;
    } else if (!git) {
      bodyHtml = `<div class="ag-pd-card-muted">${L('当前目录未初始化 Git 仓库或暂无提交记录。', 'No Git repository or commits detected.')}</div>`;
    } else {
      bodyHtml = `<div class="ag-pd-card-muted">${L('当前分支工作区干净，暂无最近提交列表。', 'Clean working tree.')}</div>`;
    }

    return `
      <div class="ag-pd-section ag-pd-repo-sec" data-ag-pd-repo-sec="true">
        <div class="ag-pd-sec-hdr">
          <span class="ag-pd-sec-title">${L('代码仓库', 'Repository')}</span>
          ${rightPills}
        </div>
        ${wtStripHtml}
        ${dirtyDrawerHtml}
        ${bodyHtml}
      </div>
    `;
  }

  function buildQuickActionsStripHtml({
    project,
    hasLocalDir,
    wsStatus,
    instructions,
    aiSuggestionsState = null,
    isLoadingAi = false,
  }) {
    if (!project || !Array.isArray(project.chats) || project.chats.length === 0) return '';
    const data = wsStatus && wsStatus.ok ? wsStatus : null;
    const git = data?.git || null;
    const scripts = Array.isArray(data?.scripts) ? data.scripts : [];
    const aiList = Array.isArray(aiSuggestionsState?.suggestions) ? aiSuggestionsState.suggestions.slice(0, 3) : [];
    const showRefreshBtn = Boolean(hasLocalDir && aiSuggestionsState?.hasApiKey && aiSuggestionsState?.enabled);
    const refreshBtnHtml = showRefreshBtn
      ? `<button type="button" class="ag-pd-quick-refresh${isLoadingAi ? ' is-busy' : ''}" data-ag-pd-sugg-refresh="true" title="${escapeHtml(
          L('基于最近对话刷新 AI 建议', 'Refresh AI suggestions from recent chats')
        )}" aria-label="${escapeHtml(L('刷新建议', 'Refresh suggestions'))}">${SVG_PROJ_REFRESH}</button>`
      : '';

    if (aiList.length > 0) {
      const pills = aiList.map((s, idx) => {
        const branchName = typeof s.branch === 'string' ? s.branch.trim() : '';
        const showBranch = Boolean(branchName && branchName !== 'main' && branchName !== 'master');
        const branchBadge = showBranch
          ? `<span class="ag-pd-quick-pill-branch" title="${escapeHtml(branchName)}">${escapeHtml(branchName)}</span>`
          : '';
        const tip = [
          showBranch ? `${s.label} (${branchName})` : s.label,
          s.reason,
          L('点击填入输入框 · 按住 Shift 直接发送', 'Click to fill · Shift+Click to send'),
        ]
          .filter(Boolean)
          .join('\n');
        return `<button type="button" class="ag-pd-quick-pill is-ai" data-ag-pd-ai-sugg-idx="${idx}" title="${escapeHtml(tip)}"><span class="ag-pd-quick-pill-spark" aria-hidden="true">${SVG_AI_SPARKLE}</span><span class="ag-pd-quick-pill-label">${escapeHtml(s.label)}</span>${branchBadge}</button>`;
      });
      return `<div class="ag-pd-quick-strip" data-ag-pd-quick-strip="true" data-mode="ai" data-count="${aiList.length}"><div class="ag-pd-quick-pills">${pills.join('')}</div>${refreshBtnHtml}</div>`;
    }

    const actions = [];

    if (git && git.changedFiles > 0) {
      actions.push({
        label: L(`审查改动 (${git.changedFiles})`, `Review changes (${git.changedFiles})`),
        prompt: L(
          `请先检查当前工作区 ${git.changedFiles} 个未提交改动（\`git status\` / \`git diff\`），总结变更并排查隐患。`,
          `Inspect the ${git.changedFiles} uncommitted changes (\`git status\` / \`git diff\`), summarize the delta, and check for risks.`
        ),
      });
    }
    if (scripts.includes('test')) {
      actions.push({
        label: L('运行测试', 'Run tests'),
        prompt: L('请运行项目测试（`npm test`）并汇报通过情况与耗时；若有失败请定位原因。', 'Run the project test suite (`npm test`), report results, and diagnose any failures.'),
      });
    }
    if (hasLocalDir && data?.recentCommits?.length) {
      actions.push({
        label: L('梳理最近提交', 'Summarize commits'),
        prompt: L('请梳理最近几次 Git 提交的改动主线、当前阶段重点及下一步建议。', 'Summarize the recent Git commits, current project status, and suggested next steps.'),
      });
    }
    if (instructions) {
      actions.push({
        label: L('完善 AGENTS.md', 'Refine AGENTS.md'),
        prompt: L('请检查项目当前结构与 AGENTS.md 内容，补充或精简更实用的协作规范。', 'Review the repo layout and AGENTS.md to keep project rules sharp and accurate.'),
      });
    }

    if (!actions.length && !refreshBtnHtml) return '';
    const staticPills = actions
      .slice(0, 4)
      .map(
        (a) =>
          `<button type="button" class="ag-pd-quick-pill" data-ag-pd-starter-prompt="${escapeHtml(a.prompt)}" title="${escapeHtml(L('点击填入输入框 · 按住 Shift 直接发送', 'Click to fill · Shift+Click to send'))}">${escapeHtml(a.label)}</button>`
      )
      .join('');
    return `<div class="ag-pd-quick-strip" data-ag-pd-quick-strip="true" data-mode="static"><div class="ag-pd-quick-pills">${staticPills}</div>${refreshBtnHtml}</div>`;
  }

  function buildQuickStartersHtml({ project, hasLocalDir, wsStatus, instructions, filesCount }) {
    if (!project || (Array.isArray(project.chats) && project.chats.length > 0)) return '';
    const data = wsStatus && wsStatus.ok ? wsStatus : null;
    const git = data?.git || null;
    const scripts = Array.isArray(data?.scripts) ? data.scripts : [];

    const pills = [];
    if (instructions) pills.push(`<span class="ag-pd-ready-pill is-ok">AGENTS.md ✓</span>`);
    if (git?.branch) {
      const dirty = Number(git.changedFiles || 0);
      pills.push(
        `<span class="ag-pd-ready-pill${dirty > 0 ? ' is-warn' : ''}">Git: ${escapeHtml(git.branch)}${
          dirty > 0 ? ` · ${L(`${dirty} 项未提交`, `${dirty} dirty`)}` : ''
        }</span>`
      );
    }
    if (filesCount > 0) {
      pills.push(`<span class="ag-pd-ready-pill">${escapeHtml(L(`已附加 ${filesCount} 个文件`, `${filesCount} context files`))}</span>`);
    }

    const starters = [];
    if (git && git.changedFiles > 0) {
      starters.push({
        label: L('审查未提交改动', 'Review uncommitted changes'),
        sub: L(`检查当前 ${git.changedFiles} 个修改文件并给出改进建议`, `Inspect ${git.changedFiles} modified files for bugs or risks`),
        prompt: L(
          '请先检查当前工作区所有未提交改动（`git status` / `git diff`），总结变更内容并指出潜在风险或可优化点。',
          'Inspect all uncommitted changes (`git status` / `git diff`), summarize the delta, and highlight any bugs or risks.'
        ),
      });
    } else if (hasLocalDir) {
      starters.push({
        label: L('梳理最近提交与架构', 'Summarize repo & recent commits'),
        sub: L('快速建立项目上下文，准备下一轮开发', 'Catch up on recent commits and core module layout'),
        prompt: L(
          '请结合项目 `AGENTS.md` 与最近几次提交记录，快速梳理当前项目的核心架构与待办脉络。',
          'Review `AGENTS.md` and recent commits to summarize the current project architecture and active focus.'
        ),
      });
    } else {
      starters.push({
        label: L('明确任务目标与范围', 'Define task scope'),
        sub: L('描述需求与预期产出，开启项目第一场对话', 'Outline requirements and deliverables to get started'),
        prompt: L('帮我梳理并规划这个任务的目标、边界与实施步骤：', 'Help me scope and plan this task step by step: '),
      });
    }

    if (scripts.includes('test')) {
      starters.push({
        label: L('运行测试并排查问题', 'Run test suite & check health'),
        sub: L('执行 `npm test` 验证当前代码库稳定性', 'Execute `npm test` and inspect any warnings or failures'),
        prompt: L(
          '请运行本项目的测试套件（`npm test`）并汇报通过情况；如有失败项请定位根因。',
          'Run the project test suite (`npm test`), report results, and diagnose any failures.'
        ),
      });
    } else {
      starters.push({
        label: L('诊断与性能优化排查', 'Audit performance & bottlenecks'),
        sub: L('定位潜在冗余逻辑、边界异常或性能瓶颈', 'Check hot paths, state management, and error handling'),
        prompt: L(
          '请从性能、冗余代码与边界异常处理三个维度检查本项目关键路径并给出重构建议。',
          'Audit this codebase for performance bottlenecks, redundant logic, and missing edge-case handling.'
        ),
      });
    }

    starters.push({
      label: L('深度规划下一步 (/plan)', 'Plan next milestone (/plan)'),
      sub: L('拆解实现方案与验收标准后再动手编码', 'Design architecture & verification plan before editing'),
      prompt: `/plan ${L('请针对我接下来要做的需求先输出结构化方案与验证清单：', 'Design a concise plan and verification checklist for: ')}`,
    });

    starters.push({
      label: L('完善项目指令 (AGENTS.md)', 'Refine AGENTS.md rules'),
      sub: L('检查仓库结构与常用命令，更新协作规范', 'Keep build commands, invariants, and conventions sharp'),
      prompt: L(
        '请检查当前项目结构与 `package.json` 脚本，帮我审阅并补充更精炼实用的 `AGENTS.md` 协作规范。',
        'Inspect the repository layout and scripts, then suggest refinements to keep `AGENTS.md` concise and accurate.'
      ),
    });

    return `
      <div class="ag-pd-ready-card" data-ag-pd-ready="true">
        <div class="ag-pd-ready-hdr">
          <div class="ag-pd-ready-title">${L('工作台已就绪 · 选个起点快速开聊', 'Workspace ready · Pick a starting point')}</div>
          ${pills.length ? `<div class="ag-pd-ready-pills">${pills.join('')}</div>` : ''}
        </div>
        <div class="ag-pd-starter-grid">
          ${starters
            .map(
              (s) => `<button type="button" class="ag-pd-starter-btn" data-ag-pd-starter-prompt="${escapeHtml(s.prompt)}">
                <span class="ag-pd-starter-label">${escapeHtml(s.label)}</span>
                <span class="ag-pd-starter-sub">${escapeHtml(s.sub)}</span>
              </button>`
            )
            .join('')}
        </div>
      </div>
    `;
  }

  function buildRecentsHeaderHtml({ totalCount, query }) {
    const countBadge = totalCount > 0 ? `<span class="ag-pd-recents-count">${totalCount}</span>` : '';
    const searchHtml =
      totalCount >= 4
        ? `<label class="ag-pd-chat-search">
            ${SVG_PROJ_SEARCH_ICON}
            <input id="ag-pd-chat-search" type="search" value="${escapeHtml(query || '')}" placeholder="${escapeHtml(
              L('筛选历史对话…', 'Filter conversations…')
            )}" />
          </label>`
        : '';
    return `
      <div class="ag-pd-recents-hdr">
        <div class="ag-pd-recents-title-wrap">
          <span>${L('最近对话', 'Recents')}</span>
          ${countBadge}
        </div>
        ${searchHtml}
      </div>
    `;
  }

  function buildProjectsGridViewHtml({ allProjects, FEAT, RECENT_MORE_SVG, formatProjectTimeAgo }) {
    const q = pState.projectsSearchQuery.trim().toLowerCase();
    const filtered = allProjects
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.shortPath.toLowerCase().includes(q) ||
          (p.remoteLabel || '').toLowerCase().includes(q)
      )
      .sort((a, b) => {
        if (pState.projectsSortMode === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
        if (pState.projectsSortMode === 'usage') {
          const uA = Number(pState.projectsUsageMap?.[a.id]?.totalTokens || 0);
          const uB = Number(pState.projectsUsageMap?.[b.id]?.totalTokens || 0);
          if (uB !== uA) return uB - uA;
        }
        const ctxA = a.dirPath ? pState.projectsContextMap[a.dirPath] : null;
        const ctxB = b.dirPath ? pState.projectsContextMap[b.dirPath] : null;
        const tA = Math.max(
          a.lastSec * 1000,
          Number(pState.projectsNativeMtimeMap[a.id] || 0),
          ctxA ? Number(ctxA.lastModifiedMs || 0) : 0
        );
        const tB = Math.max(
          b.lastSec * 1000,
          Number(pState.projectsNativeMtimeMap[b.id] || 0),
          ctxB ? Number(ctxB.lastModifiedMs || 0) : 0
        );
        return tB - tA || a.name.localeCompare(b.name, 'zh-Hans-CN');
      });

    const cardsHtml = filtered.length
      ? filtered
          .map((p) => {
            const ctx = p.dirPath ? pState.projectsContextMap[p.dirPath] : null;
            const nativeProjMs = Number(pState.projectsNativeMtimeMap[p.id] || 0);
            const ctxActivityMs = ctx ? Math.max(Number(ctx.lastModifiedMs || 0), Number(ctx.dirMtimeMs || 0)) : 0;
            const effectiveSec = p.lastSec || Math.floor(Math.max(nativeProjMs, ctxActivityMs) / 1000);
            const timeLabel = effectiveSec ? formatProjectTimeAgo(effectiveSec) : L('刚刚', 'now');
            const chatLabel = FEAT.i18n ? `${p.chatCount} 个对话` : `${p.chatCount} ${p.chatCount === 1 ? 'chat' : 'chats'}`;
            const metaText = `${timeLabel} · ${chatLabel}`;
            const tagLabel = (ctx && ctx.gitBranch) || (p.isRemote ? p.remoteLabel : '');
            const tagHtml = tagLabel ? `<span class="ag-proj-card-tag">${escapeHtml(tagLabel)}</span>` : '';
            const moreBtnHtml = !p.isBuiltin
              ? `<button type="button" class="ag-proj-card-more" data-ag-proj-menu="${escapeHtml(p.id)}" aria-label="${escapeHtml(L('项目操作', 'Project options'))}" title="${escapeHtml(L('更多操作', 'More options'))}">${RECENT_MORE_SVG}</button>`
              : '';
            const metaTitleAttr = p.shortPath
              ? ` title="${escapeHtml(p.shortPath)}"`
              : p.remoteUrl
                ? ` title="${escapeHtml(p.remoteUrl)}"`
                : '';
            const projChatIds = (Array.isArray(p.chats) ? p.chats : []).map((c) => c && c.id).filter(Boolean).join(',');
            return `<article class="ag-proj-card" data-ag-proj-id="${escapeHtml(p.id)}" data-ag-proj-chat-ids="${escapeHtml(projChatIds)}" tabindex="0">
              <div class="ag-proj-card-head">
                <div class="ag-proj-card-title">${escapeHtml(p.name)}</div>
                ${moreBtnHtml}
              </div>
              <div class="ag-proj-card-foot">
                <div class="ag-proj-card-meta-wrap">
                  <span class="ag-proj-card-meta"${metaTitleAttr}>${escapeHtml(metaText)}</span>
                  ${tagHtml}
                </div>
                <span class="ag-proj-card-usage" data-ag-proj-usage-badge="${escapeHtml(p.id)}" hidden></span>
              </div>
            </article>`;
          })
          .join('')
      : `<div class="ag-proj-empty">${
          q
            ? L(`没有匹配「${escapeHtml(pState.projectsSearchQuery)}」的项目`, `No projects matching "${escapeHtml(pState.projectsSearchQuery)}"`)
            : L('还没有本地项目文件夹，点击右上角「新建项目」添加一个吧。', 'No local project folders yet. Click "New project" to add one.')
        }</div>`;

    const sortLabel =
      pState.projectsSortMode === 'usage'
        ? L('按用量', 'Usage')
        : pState.projectsSortMode === 'name'
          ? L('按名称', 'Name')
          : L('最近活跃', 'Recent');

    return `
      <div class="ag-proj-shell">
        <header class="ag-proj-header">
          <h1 class="ag-proj-heading">${L('项目', 'Projects')}</h1>
          <div class="ag-proj-header-controls">
            <label class="ag-proj-search-wrap">
              ${SVG_PROJ_SEARCH_ICON}
              <input id="ag-proj-search-input" type="search" value="${escapeHtml(pState.projectsSearchQuery)}" placeholder="${escapeHtml(L('搜索项目…', 'Search projects…'))}" />
            </label>
            <button type="button" class="ag-proj-sort-btn" data-ag-proj-sort="true" title="${escapeHtml(L('切换排序方式', 'Toggle sort order'))}">⇅ ${escapeHtml(sortLabel)}</button>
            <button type="button" class="ag-proj-new-btn" data-ag-proj-new="true">${L('新建项目', 'New project')}</button>
          </div>
        </header>
        <div class="ag-proj-grid">${cardsHtml}</div>
      </div>
    `;
  }

  function buildDetailChatsHtml({ project, hasLocalDir, wsStatus, instructions, filesCount, chatQueryRaw, formatProjectTimeAgo }) {
    const query = String(chatQueryRaw || '').trim().toLowerCase();
    const filteredChats = query
      ? project.chats.filter((c) => String(c.title || '').toLowerCase().includes(query))
      : project.chats;

    if (filteredChats.length) {
      return filteredChats
        .map((c) => {
          const statusDot = c.waiting
            ? `<span class="ag-pd-dot ag-pd-dot-wait" title="${escapeHtml(L('待确认', 'Waiting'))}"></span>`
            : c.running
              ? `<span class="ag-pd-dot ag-pd-dot-run" title="${escapeHtml(L('运行中', 'Running'))}"></span>`
              : '';
          const pinBadge = c.pinned
            ? `<span class="ag-pd-chat-pin" title="${escapeHtml(L('已置顶', 'Pinned'))}">${RECENT_PIN_SVG}</span>`
            : '';
          const wtBranch = pHooks.getConversationBranchBadge?.(c.id) || '';
          const wtBadgeHtml = wtBranch ? `<span class="ag-pd-chat-branch">${escapeHtml(wtBranch)}</span>` : '';
          const timeTxt = c.lastSec ? formatProjectTimeAgo(c.lastSec) : '';
          return `<button type="button" class="ag-pd-chat-row" draggable="true" data-ag-pd-chat="${escapeHtml(c.id)}" data-ag-pd-chat-title="${escapeHtml(c.title)}">
            <div class="ag-pd-chat-main">
              <span class="ag-pd-chat-title">${statusDot}${pinBadge}${escapeHtml(c.title)}</span>${wtBadgeHtml}
            </div>
            <span class="ag-pd-chat-meta-r"><span class="ag-pd-chat-usage" data-ag-pd-chat-usage="${escapeHtml(c.id)}" hidden></span><span class="ag-pd-chat-time">${escapeHtml(timeTxt)}</span></span>
          </button>`;
        })
        .join('');
    }
    if (project.chats.length > 0 && query) {
      return `<div class="ag-pd-chat-empty">${L(
        `没有匹配「${escapeHtml(chatQueryRaw)}」的对话`,
        `No conversations matching "${escapeHtml(chatQueryRaw)}"`
      )}</div>`;
    }
    return buildQuickStartersHtml({
      project,
      hasLocalDir,
      wsStatus,
      instructions,
      filesCount,
    });
  }

  function buildDetailFilesHtml({ files }) {
    if (!files.length) {
      return `<div class="ag-pd-card-muted">${L(
        '尚未添加参考文件。点右上角 + 或直接把文件拖到这里。',
        'No context added yet. Click + or drop files here.'
      )}</div>`;
    }
    return `<div class="ag-pd-file-list">${files
      .map((f) => {
        const modeTag = f.inlined
          ? `<span class="ag-pm-tag ag-pm-tag-inline">${L('自动内联', 'Inline')}</span>`
          : `<span class="ag-pm-tag">${L('按需读取', 'On-demand')}</span>`;
        return `<div class="ag-pd-file-row" draggable="true" data-ag-pd-drag-file="${escapeHtml(f.absPath || '')}">
          <button type="button" class="ag-pd-file-name" data-ag-pd-reveal-file="${escapeHtml(f.absPath || '')}" title="${escapeHtml(f.absPath || f.name)}">${escapeHtml(f.name)}</button>
          <span class="ag-pd-file-meta">${modeTag}<span>${escapeHtml(f.sizeText || '')}</span></span>
          <button type="button" class="ag-pd-file-del" data-ag-pd-rm-file="${escapeHtml(f.relPath)}" aria-label="${escapeHtml(L('移除文件', 'Remove file'))}">×</button>
        </div>`;
      })
      .join('')}</div>`;
  }

  function buildDetailScheduledHtml({ scheduledTasks }) {
    if (!scheduledTasks.length) {
      return `<div class="ag-pd-card-muted">${L(
        '为这个项目设置定期自动执行的任务。',
        'Set up recurring tasks for this project.'
      )}</div>`;
    }
    const formatSchedFreq = (t) => {
      const f = String((t && t.frequency) || 'manual');
      if (f === 'manual') return L('手动', 'Manual');
      if (f === 'hourly') return `${L('每小时', 'Hourly')} :${String(t.minute || 0).padStart(2, '0')}`;
      if (f === 'daily') return `${L('每天', 'Daily')} ${t.time || '09:00'}`;
      if (f === 'weekdays') return `${L('工作日', 'Weekdays')} ${t.time || '09:00'}`;
      if (f === 'weekly') {
        const dowsZh = ['日', '一', '二', '三', '四', '五', '六'];
        const dowsEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const rawDow = Number(t.dayOfWeek);
        const idx = Number.isFinite(rawDow) ? Math.min(6, Math.max(0, rawDow)) : 1;
        return `${L(`每周${dowsZh[idx]}`, `Weekly ${dowsEn[idx]}`)} ${t.time || '09:00'}`;
      }
      return t.customCron || 'Cron';
    };
    const hasSyncedCron = scheduledTasks.some((t) => t && t.frequency !== 'manual');
    return `<div class="ag-pd-sched-list">${scheduledTasks
      .map((t) => {
        const freqLabel = formatSchedFreq(t);
        const isAuto = t.frequency && t.frequency !== 'manual';
        return `<div class="ag-pd-sched-row" data-ag-pd-sched-id="${escapeHtml(t.id)}">
          <button type="button" class="ag-pd-sched-main" data-ag-pd-edit-sched="${escapeHtml(t.id)}" title="${escapeHtml(t.description || t.name)}">
            <div class="ag-pd-sched-top">
              <span class="ag-pd-sched-name">${escapeHtml(t.name)}</span>
              <span class="ag-pm-tag${isAuto ? ' ag-pm-tag-inline' : ''}">${escapeHtml(freqLabel)}</span>
            </div>
            ${t.description ? `<div class="ag-pd-sched-desc">${escapeHtml(t.description)}</div>` : ''}
          </button>
          <button type="button" class="ag-pd-sched-run" data-ag-pd-run-sched="${escapeHtml(t.id)}" title="${escapeHtml(L('立即运行一次', 'Run now'))}" aria-label="${escapeHtml(L('立即运行', 'Run now'))}">▶</button>
          <button type="button" class="ag-pd-file-del" data-ag-pd-del-sched="${escapeHtml(t.id)}" aria-label="${escapeHtml(L('删除定时任务', 'Delete scheduled task'))}">×</button>
        </div>`;
      })
      .join('')}</div>${
      hasSyncedCron
        ? `<button type="button" class="ag-pd-sched-auto-link" data-ag-pd-open-automations="true">${L(
            '在「自动化任务」中启用与管理 ↗',
            'Enable & manage in Automations ↗'
          )}</button>`
        : ''
    }`;
  }

  function buildFolderMenuHtml({ allFolders, activeFolder }) {
    if (!pState.projectFolderDropdownOpen) return '';
    const fq = pState.projectFolderSearch.trim().toLowerCase();
    const filteredFolders = allFolders.filter(
      (f) => !fq || f.name.toLowerCase().includes(fq) || f.absPath.toLowerCase().includes(fq)
    );
    return `<div class="ag-pd-folder-menu" data-ag-pd-folder-menu="true">
      <div class="ag-pd-fm-search">
        ${SVG_PROJ_SEARCH_ICON}
        <input id="ag-pd-fm-search-input" type="search" value="${escapeHtml(pState.projectFolderSearch)}" placeholder="${escapeHtml(L('搜索文件夹…', 'Search folders…'))}" />
      </div>
      <div class="ag-pd-fm-list">${filteredFolders
        .map((fld) => {
          const isSelected = fld.absPath === activeFolder.absPath;
          return `<div class="ag-pd-fm-item" data-selected="${isSelected ? 'true' : 'false'}" data-ag-pd-select-folder="${escapeHtml(fld.absPath)}">
            <span class="ag-pd-fm-icon">${SVG_PROJ_FOLDER_OPEN}</span>
            <div class="ag-pd-fm-text">
              <div class="ag-pd-fm-name">${escapeHtml(fld.name)}${fld.primary ? ` <span class="ag-pd-fm-badge">${L('主目录', 'Primary')}</span>` : ''}</div>
              <div class="ag-pd-fm-path">${escapeHtml(fld.absPath)}</div>
            </div>
            ${
              fld.primary
                ? ''
                : `<button type="button" class="ag-pd-file-del" data-ag-pd-rm-folder="${escapeHtml(fld.absPath)}" aria-label="${escapeHtml(L('移除文件夹', 'Remove folder'))}">×</button>`
            }
          </div>`;
        })
        .join('')}</div>
      <div class="ag-pd-fm-divider"></div>
      <button type="button" class="ag-pd-fm-add" data-ag-pd-add-folder="true">
        ${SVG_PROJ_FOLDER_ADD}
        <span>${L('添加文件夹', 'Add folder')}</span>
      </button>
    </div>`;
  }

  return {
    emitProjectsEvent,
    fetchProjectWorkspaceStatus,
    bindProjectWorkspaceEvents,
    formatInstructionsPreview,
    buildTopbarHtml,
    buildProjectHeroHtml,
    buildWorkspacePulseSectionHtml,
    buildQuickActionsStripHtml,
    buildQuickStartersHtml,
    buildRecentsHeaderHtml,
    buildProjectsGridViewHtml,
    buildDetailChatsHtml,
    buildDetailFilesHtml,
    buildDetailScheduledHtml,
    buildFolderMenuHtml,
  };
}
