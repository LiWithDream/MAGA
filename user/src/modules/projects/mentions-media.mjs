/**
 * Project Detail @ Mentions engine, image paste/drop staging, URI/RPC & URL caret helpers.
 */
export function createProjectMentionsMedia(ctx) {
  const { FEAT, L, rtState, escapeHtml, pState, ICONS, pHooks, activeReactFiber, isSidebarVisibleSummary, isSummaryPinned, protoSeconds } = ctx;
  const {
    SVG_PROJ_FOLDER_OPEN,
    SVG_PD_MENTION_FILE,
    SVG_PD_MENTION_RULE,
    SVG_PD_MENTION_CHAT,
    SVG_PD_MENTION_DRIVE,
    SVG_PD_MENTION_PLUGIN,
  } = ICONS;
  const resolveProjectsStoreAndBindings = (...args) => pHooks.resolveProjectsStoreAndBindings?.(...args) || {};
  const collectNativeProjects = (...args) => pHooks.collectNativeProjects?.(...args) || [];
  const decodeFileUriToPath = (...args) => pHooks.decodeFileUriToPath?.(...args) || '';
  const formatShortHomePath = (...args) => pHooks.formatShortHomePath?.(...args) || '';
  const formatProjectTimeAgo = (...args) => pHooks.formatProjectTimeAgo?.(...args) || '';

  function encodePathToFileUri(absPath) {
    const raw = String(absPath || '').trim();
    if (!raw) return '';
    if (raw.startsWith('file://')) return raw;
    const norm = raw.replace(/\\/g, '/');
    const withLead = norm.startsWith('/') ? norm : `/${norm}`;
    const parts = withLead.split('/').map((seg, i) => {
      if (i === 1 && /^[A-Za-z]:$/.test(seg)) return seg;
      return encodeURIComponent(seg);
    });
    return `file://${parts.join('/')}`;
  }

  function resolveCascadeRpcService() {
    if (
      pState.cascadeRpcSvcRef &&
      (typeof pState.cascadeRpcSvcRef.searchFiles === 'function' ||
        typeof pState.cascadeRpcSvcRef.getAllRules === 'function' ||
        typeof pState.cascadeRpcSvcRef.getAllPlugins === 'function')
    ) {
      return pState.cascadeRpcSvcRef;
    }
    const rootEl = document.getElementById('root');
    const anchors = [
      document.querySelector('[data-testid="conversation-list-sidebar"]'),
      document.querySelector('[data-testid="sidebar-navigation-items"]'),
      document.querySelector('.bg-sidebar'),
      document.querySelector('[data-testid="automations-button"]'),
      document.querySelector('[data-testid="project-header"]'),
      rootEl && rootEl.firstElementChild
    ];
    const isRpc = (v) =>
      v &&
      typeof v === 'object' &&
      (typeof v.searchFiles === 'function' || typeof v.getAllRules === 'function' || typeof v.getAllPlugins === 'function');
    for (const anchor of anchors) {
      let cur = anchor ? activeReactFiber(anchor) : null;
      for (let d = 0; cur && d < 42; d++, cur = cur.return) {
        const pv = cur.memoizedProps && cur.memoizedProps.value;
        if (isRpc(pv)) {
          pState.cascadeRpcSvcRef = pv;
          return pv;
        }
        for (let dep = cur.dependencies && cur.dependencies.firstContext; dep; dep = dep.next) {
          if (isRpc(dep.memoizedValue)) {
            pState.cascadeRpcSvcRef = dep.memoizedValue;
            return dep.memoizedValue;
          }
        }
      }
    }
    return null;
  }

  function getProjectMentionMap(projectId, create = false) {
    if (!projectId) return null;
    let m = pState.projectComposerMentions.get(projectId);
    if (!m && create) {
      m = new Map();
      pState.projectComposerMentions.set(projectId, m);
    }
    return m || null;
  }

  function iconForMentionKind(kind, logoUrl = '') {
    if (logoUrl && /^(https?:|data:|blob:)/i.test(logoUrl)) {
      return `<img src="${escapeHtml(logoUrl)}" alt="" />`;
    }
    if (kind === 'directory') return SVG_PROJ_FOLDER_OPEN;
    if (kind === 'file') return SVG_PD_MENTION_FILE;
    if (kind === 'rule') return SVG_PD_MENTION_RULE;
    if (kind === 'conversation') return SVG_PD_MENTION_CHAT;
    if (kind === 'drive') return SVG_PD_MENTION_DRIVE;
    return SVG_PD_MENTION_PLUGIN;
  }

  function closePdMentionMenu() {
    pState.pdMentionState.open = false;
    pState.pdMentionState.items = [];
    pState.pdMentionState.loading = false;
    pState.pdMentionState.reqSeq += 1;
    const pop = document.getElementById('ag-pd-mention-popover');
    if (pop) {
      pop.setAttribute('data-open', 'false');
      pop.innerHTML = '';
    }
  }

  function parsePdMentionTrigger(text, caretPos) {
    const pos = typeof caretPos === 'number' ? caretPos : String(text || '').length;
    const before = String(text || '').slice(0, pos);
    const catMatch = before.match(/(?:^|[\s(\[{"'，。；：！？])@(files|rules|conversation|drive):([^@\n]*)$/i);
    if (catMatch) {
      const sub = catMatch[2] || '';
      const cat = catMatch[1].toLowerCase();
      const tokenLen = 1 + catMatch[1].length + 1 + sub.length;
      return {
        startIdx: pos - tokenLen,
        endIdx: pos,
        rawQuery: `${cat}:${sub}`,
        category: cat,
        subQuery: sub
      };
    }
    const rootMatch = before.match(/(?:^|[\s(\[{"'，。；：！？])@([^\s@\n\[]*)$/);
    if (rootMatch) {
      const q = rootMatch[1] || '';
      return {
        startIdx: pos - 1 - q.length,
        endIdx: pos,
        rawQuery: q,
        category: '',
        subQuery: q
      };
    }
    return null;
  }

  function getProjectWorkspaceUris(project) {
    if (!project) return [];
    const dirs = [];
    if (project.dirPath) dirs.push(project.dirPath);
    const ctx = project.dirPath ? pState.projectsContextMap[project.dirPath] : null;
    if (ctx && Array.isArray(ctx.extraFolders)) {
      for (const ef of ctx.extraFolders) {
        if (ef && ef.absPath && !dirs.includes(ef.absPath)) dirs.push(ef.absPath);
      }
    }
    return dirs.map(encodePathToFileUri).filter(Boolean);
  }

  function collectMentionConversationOptions(project, filterQuery) {
    const { store } = resolveProjectsStoreAndBindings();
    const state = store ? store.getState() : null;
    const summaries = Object.assign(
      {},
      (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {},
      (state && state.trajectorySummaries && state.trajectorySummaries.externalSummaries) || {}
    );
    const projNameById = new Map();
    const rawProjs = (state && state.sidebarProjects && state.sidebarProjects.projects) || [];
    for (const rp of rawProjs) {
      if (rp && rp.id && rp.name) projNameById.set(rp.id, rp.name);
    }
    const q = String(filterQuery || '').trim().toLowerCase();
    const rows = [];
    for (const [cid, sum] of Object.entries(summaries)) {
      if (!sum || !isSidebarVisibleSummary(cid, sum, state)) continue;
      const title = String((sum.annotations && sum.annotations.title) || sum.summary || '').trim();
      if (!title) continue;
      const bodyPreview = String(sum.summary || '').trim();
      if (q && !title.toLowerCase().includes(q) && !bodyPreview.toLowerCase().includes(q)) continue;
      const pid = sum.projectId || (sum.trajectoryMetadata && sum.trajectoryMetadata.projectId) || '';
      const inCurrentProj = Boolean(project && project.id && pid === project.id);
      const isPinned = isSummaryPinned(cid, sum, state);
      const ownerLabel = inCurrentProj
        ? L('本项目', 'This project')
        : pid && pid !== 'outside-of-project' && projNameById.get(pid)
          ? projNameById.get(pid)
          : L('项目外对话', 'Outside of project');
      const lastSec = protoSeconds(sum.lastModifiedTime);
      const timeStr = lastSec ? formatProjectTimeAgo(lastSec) : '';
      rows.push({
        kind: 'conversation',
        label: title,
        desc: [isPinned ? L('置顶', 'Pinned') : '', ownerLabel, timeStr].filter(Boolean).join(' · '),
        inCurrentProj,
        isPinned,
        lastSec,
        scopeItem: {
          $typeName: 'exa.codeium_common_pb.ContextScopeItem',
          scopeItem: {
            case: 'conversation',
            value: Object.assign(
              {
                $typeName: 'exa.codeium_common_pb.ConversationScopeItem',
                id: cid,
                title,
                source: ''
              },
              sum.lastModifiedTime ? { lastModifiedTime: sum.lastModifiedTime } : {}
            )
          }
        }
      });
    }
    rows.sort((a, b) => {
      if (a.inCurrentProj !== b.inCurrentProj) return a.inCurrentProj ? -1 : 1;
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return b.lastSec - a.lastSec;
    });
    return rows.slice(0, 60);
  }

  async function fetchPdMentionRules(workspaceUris) {
    const key = workspaceUris.join('|') || '__global__';
    const cached = pState.pdMentionCache.rulesByKey.get(key);
    if (cached && Date.now() - cached.ts < 15000) return cached.items;
    const rt = resolveCascadeRpcService();
    if (!rt || typeof rt.getAllRules !== 'function') return [];
    try {
      const memories = (await rt.getAllRules(workspaceUris)) || [];
      const items = memories
        .map((d) => {
          if (!d) return null;
          const isProjScope = d.scope && d.scope.scope && d.scope.scope.case === 'projectScope';
          const rulePath = isProjScope ? d.scope.scope.value.absoluteFilePath : d.memoryId || d.rulePath || '';
          const ruleName = isProjScope ? d.scope.scope.value.filePath : d.memoryId || d.ruleName || '';
          const rawContent = d.memory && d.memory.case === 'textMemory' ? d.memory.value.content : d.description || '';
          const oneLine = String(rawContent || '')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/[#>*`\-\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
          if (!ruleName) return null;
          return {
            kind: 'rule',
            label: ruleName,
            desc: oneLine || rulePath,
            scopeItem: {
              $typeName: 'exa.codeium_common_pb.ContextScopeItem',
              scopeItem: {
                case: 'rule',
                value: {
                  $typeName: 'exa.codeium_common_pb.RuleScopeItem',
                  rulePath,
                  ruleName,
                  description: String(rawContent || '')
                }
              }
            }
          };
        })
        .filter(Boolean);
      pState.pdMentionCache.rulesByKey.set(key, { ts: Date.now(), items });
      return items;
    } catch {
      return [];
    }
  }

  async function fetchPdMentionPlugins(workspaceUris) {
    const key = workspaceUris.join('|') || '__global__';
    const cached = pState.pdMentionCache.pluginsByKey.get(key);
    if (cached && Date.now() - cached.ts < 15000) return cached.items;
    const rt = resolveCascadeRpcService();
    if (!rt || typeof rt.getAllPlugins !== 'function') return [];
    try {
      const res = await rt.getAllPlugins({ workspaceUris });
      const rawList = Array.isArray(res) ? res : (res && Array.isArray(res.plugins) ? res.plugins : []);
      const items = rawList
        .filter(
          (p) =>
            p &&
            (p.name || p.displayName) &&
            p.enabled !== false &&
            ((Array.isArray(p.skills) && p.skills.length) ||
              (Array.isArray(p.workflows) && p.workflows.length) ||
              (Array.isArray(p.agents) && p.agents.length) ||
              (Array.isArray(p.rules) && p.rules.length) ||
              (Array.isArray(p.mcpServers) && p.mcpServers.length) ||
              (Array.isArray(p.sidecars) && p.sidecars.length) ||
              Boolean(p.hooksJson && String(p.hooksJson).trim()) ||
              !('skills' in p))
        )
        .map((p) => ({
          kind: 'plugin',
          label: p.displayName || p.name,
          desc: String(p.description || '').replace(/\s+/g, ' ').trim(),
          logo: p.logo || '',
          scopeItem: {
            $typeName: 'exa.codeium_common_pb.ContextScopeItem',
            scopeItem: {
              case: 'plugin',
              value: {
                $typeName: 'exa.codeium_common_pb.PluginScopeItem',
                name: p.name || p.displayName,
                displayName: p.displayName || p.name,
                path: p.path || '',
                logo: p.logo || ''
              }
            }
          }
        }));
      pState.pdMentionCache.pluginsByKey.set(key, { ts: Date.now(), items });
      return items;
    } catch {
      return [];
    }
  }

  async function fetchPdMentionProjectFiles(project, subQuery, seq) {
    const wsUris = getProjectWorkspaceUris(project);
    if (!wsUris.length) return [];
    const rt = resolveCascadeRpcService();
    const q = String(subQuery || '').trim();
    const out = [];
    const seenUris = new Set();

    if (rt && typeof rt.searchFiles === 'function') {
      const batches = await Promise.all(
        wsUris.map(async (wsUri, idx) => {
          try {
            const res = await rt.searchFiles({
              query: q,
              workspaceUri: wsUri,
              includeDirectories: true,
              cancelToken: BigInt(6767 + seq * 10 + idx),
              maxResults: 28
            });
            return (res && Array.isArray(res.results) ? res.results : []).map((u) => ({ wsUri, u }));
          } catch {
            return [];
          }
        })
      );
      for (const { wsUri, u } of batches.flat()) {
        if (!u || !u.absoluteUri || seenUris.has(u.absoluteUri)) continue;
        seenUris.add(u.absoluteUri);
        const relMap = u.workspaceUrisToRelativePaths || {};
        const relPath = relMap[wsUri] || Object.values(relMap)[0] || decodeFileUriToPath(u.absoluteUri);
        const cleanRel = String(relPath || '').replace(/\/+$/, '');
        const baseName = cleanRel.split(/[\\/]/).pop() || cleanRel;
        const isDir = Number(u.numFiles || 0) > 1;
        out.push({
          kind: isDir ? 'directory' : 'file',
          label: baseName,
          desc: cleanRel !== baseName ? cleanRel : formatShortHomePath(decodeFileUriToPath(u.absoluteUri)),
          scopeItem: {
            $typeName: 'exa.codeium_common_pb.ContextScopeItem',
            scopeItem: {
              case: isDir ? 'directory' : 'file',
              value: {
                $typeName: 'exa.codeium_common_pb.PathScopeItem',
                absoluteUri: u.absoluteUri,
                workspaceUrisToRelativePaths: Object.assign({}, relMap),
                numFiles: Number(u.numFiles || 0)
              }
            }
          }
        });
      }
    }

    /* Also surface attached project context files if not already returned */
    const ctx = project.dirPath ? pState.projectsContextMap[project.dirPath] : null;
    if (ctx && Array.isArray(ctx.files)) {
      const primaryUri = encodePathToFileUri(project.dirPath);
      const qLower = q.toLowerCase();
      for (const cf of ctx.files) {
        if (!cf || !cf.name) continue;
        if (qLower && !cf.name.toLowerCase().includes(qLower) && !String(cf.relPath || '').toLowerCase().includes(qLower)) continue;
        const abs = cf.absPath || (project.dirPath && cf.relPath ? `${project.dirPath.replace(/\/+$/, '')}/${cf.relPath}` : '');
        const uri = encodePathToFileUri(abs);
        if (!uri || seenUris.has(uri)) continue;
        seenUris.add(uri);
        const rel = cf.relPath || cf.name;
        out.push({
          kind: 'file',
          label: cf.name,
          desc: rel,
          scopeItem: {
            $typeName: 'exa.codeium_common_pb.ContextScopeItem',
            scopeItem: {
              case: 'file',
              value: {
                $typeName: 'exa.codeium_common_pb.PathScopeItem',
                absoluteUri: uri,
                workspaceUrisToRelativePaths: primaryUri ? { [primaryUri]: rel } : {},
                numFiles: 0
              }
            }
          }
        });
      }
    }
    return out.slice(0, 28);
  }

  async function fetchPdMentionDriveItems(subQuery) {
    const rt = resolveCascadeRpcService();
    if (!rt || typeof rt.searchContext !== 'function') return [];
    try {
      const res = await rt.searchContext({ providerLabel: 'drive', query: String(subQuery || '').trim() });
      const items = (res && (res.items || res.results)) || [];
      return items.slice(0, 20).map((it) => {
        const label = it.label || it.itemLabel || it.title || it.name || it.uri || 'Google Drive';
        const desc = it.description || it.subtitle || it.uri || '';
        return {
          kind: 'drive',
          label,
          desc,
          scopeItem: it.scopeItem && it.scopeItem.$typeName
            ? it.scopeItem
            : {
                $typeName: 'exa.codeium_common_pb.ContextScopeItem',
                scopeItem: {
                  case: 'dynamicContext',
                  value: {
                    $typeName: 'exa.codeium_common_pb.DynamicContextScopeItem',
                    providerLabel: 'drive',
                    itemLabel: label,
                    itemValue: it.value || it.itemValue || it.id || '',
                    uri: it.uri || it.url || ''
                  }
                }
              }
        };
      });
    } catch {
      return [];
    }
  }

  function renderPdMentionPopover() {
    const pop = document.getElementById('ag-pd-mention-popover');
    if (!pop) return;
    if (!pState.pdMentionState.open) {
      pop.setAttribute('data-open', 'false');
      pop.innerHTML = '';
      return;
    }
    pop.setAttribute('data-open', 'true');
    const items = pState.pdMentionState.items || [];
    if (pState.pdMentionState.activeIndex >= items.length) {
      pState.pdMentionState.activeIndex = Math.max(0, items.length - 1);
    }

    const catLabels = {
      files: L('项目文件', 'Project files'),
      rules: L('项目规则', 'Rules'),
      conversation: L('历史对话', 'Conversations'),
      drive: 'Google Drive'
    };

    let html = '';
    if (pState.pdMentionState.category) {
      html += `<div class="ag-pd-mention-sec-hdr">
        <button type="button" class="ag-pd-mention-back" data-ag-pd-m-back="true">← ${escapeHtml(L('返回分类', 'Back'))}</button>
        <span>${escapeHtml(catLabels[pState.pdMentionState.category] || pState.pdMentionState.category)}</span>
      </div>`;
    }

    if (!items.length) {
      const emptyMsg = pState.pdMentionState.loading
        ? L('正在加载选项…', 'Loading options…')
        : L('没有匹配的引用项', 'No matching items');
      html += `<div class="ag-pd-mention-empty">${escapeHtml(emptyMsg)}</div>`;
    } else {
      let lastSection = '';
      items.forEach((it, idx) => {
        if (it.section && it.section !== lastSection && !pState.pdMentionState.category) {
          lastSection = it.section;
          html += `<div class="ag-pd-mention-sec-hdr"><span>${escapeHtml(it.section)}</span></div>`;
        }
        const active = idx === pState.pdMentionState.activeIndex;
        const iconHtml = iconForMentionKind(it.kind, it.logo || '');
        html += `<button type="button" class="ag-pd-mention-row" role="option" aria-selected="${active ? 'true' : 'false'}" data-active="${active ? 'true' : 'false'}" data-ag-pd-m-idx="${idx}">
          <span class="ag-pd-mention-icon">${iconHtml}</span>
          <span class="ag-pd-mention-label">${escapeHtml(it.label)}</span>
          ${it.desc ? `<span class="ag-pd-mention-desc">${escapeHtml(it.desc)}</span>` : '<span class="ag-pd-mention-desc"></span>'}
          ${it.isCategory ? '<span class="ag-pd-mention-chev">›</span>' : ''}
        </button>`;
      });
    }

    pop.innerHTML = html;

    pop.querySelectorAll('img').forEach((img) => {
      img.addEventListener(
        'error',
        () => {
          if (img.parentElement) img.parentElement.innerHTML = SVG_PD_MENTION_PLUGIN;
        },
        { once: true }
      );
    });

    const backBtn = pop.querySelector('[data-ag-pd-m-back]');
    if (backBtn) {
      backBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        resetPdMentionToRoot();
      });
    }

    pop.querySelectorAll('[data-ag-pd-m-idx]').forEach((row) => {
      const idx = Number(row.getAttribute('data-ag-pd-m-idx'));
      row.addEventListener('mouseenter', () => {
        if (pState.pdMentionState.activeIndex !== idx) {
          pState.pdMentionState.activeIndex = idx;
          pop.querySelectorAll('[data-ag-pd-m-idx]').forEach((r2, i2) => {
            r2.setAttribute('data-active', i2 === idx ? 'true' : 'false');
            r2.setAttribute('aria-selected', i2 === idx ? 'true' : 'false');
          });
        }
      });
      row.addEventListener('mousedown', (e) => {
        /* mousedown + preventDefault keeps focus inside #ag-pd-composer-input cleanly */
        e.preventDefault();
        e.stopPropagation();
        applyPdMentionSelection(idx);
      });
    });

    const activeRow = pop.querySelector('.ag-pd-mention-row[data-active="true"]');
    if (activeRow && typeof activeRow.scrollIntoView === 'function') {
      try {
        activeRow.scrollIntoView({ block: 'nearest' });
      } catch {}
    }
  }

  function syncPdMentionPills(project, compInput) {
    const bar = document.getElementById('ag-pd-mention-pills');
    if (!bar || !project) return;
    const mMap = getProjectMentionMap(project.id, false);
    const val = String((compInput && compInput.value) || '');
    if (!mMap || !mMap.size || !val) {
      if (mMap && !val) mMap.clear();
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    const activeEntries = [];
    for (const [token, entry] of [...mMap.entries()]) {
      if (val.includes(token)) {
        activeEntries.push(entry);
      } else {
        mMap.delete(token);
      }
    }
    if (!activeEntries.length) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = activeEntries
      .map(
        (en) => `<span class="ag-pd-mention-pill" data-ag-pd-pill-tok="${escapeHtml(en.token)}">
          <span class="ag-pd-mention-pill-icon">${iconForMentionKind(en.kind, en.logo || '')}</span>
          <span class="ag-pd-mention-pill-lbl">${escapeHtml(en.label)}</span>
          <button type="button" class="ag-pd-mention-pill-rm" data-ag-pd-pill-rm="${escapeHtml(en.token)}" aria-label="${escapeHtml(L('移除引用', 'Remove mention'))}">×</button>
        </span>`
      )
      .join('');

    bar.querySelectorAll('[data-ag-pd-pill-rm]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tok = btn.getAttribute('data-ag-pd-pill-rm');
        if (!tok || !compInput) return;
        const nextVal = compInput.value
          .split(tok)
          .join('')
          .replace(/  +/g, ' ');
        compInput.value = nextVal;
        mMap.delete(tok);
        dispatchInputEvent(compInput);
        compInput.focus();
      });
    });
  }

  function dispatchInputEvent(el) {
    if (!el) return;
    const EvCtor = (typeof window !== 'undefined' && window.Event) || Event;
    el.dispatchEvent(new EvCtor('input', { bubbles: true }));
  }

  function getProjectMediaList(projectId, create = false) {
    if (!projectId) return null;
    let list = pState.projectComposerMedia.get(projectId);
    if (!list && create) {
      list = [];
      pState.projectComposerMedia.set(projectId, list);
    }
    return list || null;
  }

  function inferComposerImageMime(file) {
    const rawType = String((file && file.type) || '').trim().toLowerCase();
    if (rawType.startsWith('image/')) return rawType;
    const name = String((file && file.name) || '').trim().toLowerCase();
    if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
    if (/\.gif$/.test(name)) return 'image/gif';
    if (/\.webp$/.test(name)) return 'image/webp';
    if (/\.svg$/.test(name)) return 'image/svg+xml';
    if (/\.bmp$/.test(name)) return 'image/bmp';
    if (/\.avif$/.test(name)) return 'image/avif';
    if (/\.heic$/.test(name)) return 'image/heic';
    if (/\.tiff?$/.test(name)) return 'image/tiff';
    if (/\.png$/.test(name)) return 'image/png';
    return '';
  }

  function extractComposerImageFiles(dt) {
    if (!dt) return [];
    const out = [];
    if (dt.items && typeof dt.items.length === 'number') {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (!it || it.kind !== 'file' || typeof it.getAsFile !== 'function') continue;
        const f = it.getAsFile();
        if (f && inferComposerImageMime(f)) out.push(f);
      }
    }
    if (!out.length && dt.files && typeof dt.files.length === 'number') {
      for (let i = 0; i < dt.files.length; i++) {
        const f = dt.files[i];
        if (f && inferComposerImageMime(f)) out.push(f);
      }
    }
    return out;
  }

  function uint8ToBase64(bytes) {
    if (!bytes || !bytes.length) return '';
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return typeof btoa === 'function' ? btoa(bin) : '';
  }

  async function readBlobBytes(file) {
    if (!file) return new Uint8Array(0);
    if (typeof file.arrayBuffer === 'function') {
      const ab = await file.arrayBuffer();
      return new Uint8Array(ab);
    }
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result ? new Uint8Array(reader.result) : new Uint8Array(0));
        reader.onerror = () => resolve(new Uint8Array(0));
        reader.readAsArrayBuffer(file);
      });
    }
    return new Uint8Array(0);
  }

  async function stagePdComposerImageFiles(project, rawFiles, onUpdated) {
    if (!project || !project.id || !rawFiles || !rawFiles.length) return 0;
    const list = getProjectMediaList(project.id, true);
    const maxTotal = 10;
    const maxBytes = 20 * 1024 * 1024;
    let added = 0;
    for (const f of Array.from(rawFiles)) {
      if (list.length >= maxTotal) break;
      const mimeType = inferComposerImageMime(f);
      if (!mimeType) continue;
      if (typeof f.size === 'number' && f.size > maxBytes) continue;
      const bytes = await readBlobBytes(f);
      if (!bytes.length || bytes.length > maxBytes) continue;
      const id = `pdm-${++pState.pdMediaSeq}`;
      const ext = (mimeType.split('/')[1] || 'png').replace(/\+.*$/, '').replace('jpeg', 'jpg');
      const rawName = String(f.name || '').trim();
      const name = !rawName || /^image\.[a-z0-9]+$/i.test(rawName) ? `pasted-image-${pState.pdMediaSeq}.${ext}` : rawName;
      const normalizedFile =
        typeof File === 'function' ? new File([bytes], name, { type: mimeType }) : f;
      const dataUrl = `data:${mimeType};base64,${uint8ToBase64(bytes)}`;
      list.push({ id, file: normalizedFile, name, mimeType, dataUrl, bytes });
      added += 1;
    }
    if (added > 0 && typeof onUpdated === 'function') {
      onUpdated();
    }
    return added;
  }

  function syncPdMediaStrip(project, onMutated) {
    const strip = document.getElementById('ag-pd-media-strip');
    if (!strip || !project) return;
    const list = getProjectMediaList(project.id, false);
    const sig = list && list.length ? list.map((m) => m.id).join(',') : '';
    if (strip.dataset.agMediaSig === sig) return;
    strip.dataset.agMediaSig = sig;
    if (!list || !list.length) {
      strip.style.display = 'none';
      strip.innerHTML = '';
      return;
    }
    strip.style.display = 'flex';
    strip.innerHTML = list
      .map(
        (m) => `<div class="ag-pd-media-card" data-ag-pd-media-id="${escapeHtml(m.id)}" title="${escapeHtml(m.name)}">
          <img class="ag-pd-media-img" src="${escapeHtml(m.dataUrl)}" alt="${escapeHtml(m.name)}" />
          <button type="button" class="ag-pd-media-rm" data-ag-pd-media-rm="${escapeHtml(m.id)}" aria-label="${escapeHtml(L('移除图片', 'Remove image'))}">×</button>
        </div>`
      )
      .join('');
    strip.querySelectorAll('[data-ag-pd-media-rm]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mid = btn.getAttribute('data-ag-pd-media-rm');
        const cur = getProjectMediaList(project.id, false);
        if (!cur || !mid) return;
        const idx = cur.findIndex((x) => x.id === mid);
        if (idx >= 0) cur.splice(idx, 1);
        if (!cur.length) pState.projectComposerMedia.delete(project.id);
        syncPdMediaStrip(project, onMutated);
        if (typeof onMutated === 'function') onMutated();
      });
    });
  }

  function resetPdMentionToRoot() {
    const compInput = document.getElementById('ag-pd-composer-input');
    if (!compInput || !pState.pdMentionState.open) return;
    const val = compInput.value || '';
    const start = pState.pdMentionState.startIdx;
    const end = pState.pdMentionState.endIdx;
    if (start < 0 || end < start) return;
    const nextVal = `${val.slice(0, start)}@${val.slice(end)}`;
    compInput.value = nextVal;
    const nextCaret = start + 1;
    compInput.focus();
    try {
      compInput.setSelectionRange(nextCaret, nextCaret);
    } catch {}
    dispatchInputEvent(compInput);
  }

  function movePdMentionSelection(delta) {
    if (!pState.pdMentionState.open || !pState.pdMentionState.items.length) return;
    const len = pState.pdMentionState.items.length;
    pState.pdMentionState.activeIndex = (pState.pdMentionState.activeIndex + delta + len) % len;
    renderPdMentionPopover();
  }

  function getMentionScopeIdentity(scopeItem) {
    const inner = scopeItem && scopeItem.scopeItem;
    if (!inner || !inner.case) return '';
    const v = inner.value || {};
    if (inner.case === 'file' || inner.case === 'directory') return `${inner.case}:${v.absoluteUri || ''}`;
    if (inner.case === 'conversation') return `conversation:${v.id || ''}`;
    if (inner.case === 'dynamicContext') return `dyn:${v.providerLabel || ''}:${v.uri || v.itemValue || v.itemLabel || ''}`;
    if (inner.case === 'rule' || inner.case === 'skill' || inner.case === 'workflow') {
      return `${inner.case}:${v.uri || v.name || v.id || ''}`;
    }
    try {
      return `${inner.case}:${JSON.stringify(v)}`;
    } catch {
      return inner.case;
    }
  }

  function allocateUniqueMentionToken(mMap, rawLabel, item) {
    const cleanLabel = String(rawLabel || '').replace(/[\[\]\r\n]+/g, ' ').trim() || 'item';
    const identity = getMentionScopeIdentity(item && item.scopeItem);
    if (identity) {
      for (const [existingTok, existingEntry] of mMap.entries()) {
        if (getMentionScopeIdentity(existingEntry && existingEntry.scopeItem) === identity) {
          return { token: existingTok, label: existingEntry.label || cleanLabel };
        }
      }
    }
    const baseToken = `@[${cleanLabel}]`;
    if (!mMap.has(baseToken)) {
      return { token: baseToken, label: cleanLabel };
    }
    /* Disambiguate colliding display names (e.g. src/a/index.ts vs src/b/index.ts) using parent path or index */
    const rawDesc = String((item && item.desc) || '').replace(/[\[\]\r\n]+/g, ' ').trim();
    const absUri = item && item.scopeItem && item.scopeItem.scopeItem && item.scopeItem.scopeItem.value && item.scopeItem.scopeItem.value.absoluteUri;
    const hintPath = rawDesc || (absUri ? decodeFileUriToPath(absUri) : '');
    if (hintPath) {
      const segs = hintPath.split(/[\\/]/).filter(Boolean);
      for (let take = 2; take <= Math.min(segs.length, 4); take++) {
        const candidateLbl = segs.slice(-take).join('/');
        const candidateTok = `@[${candidateLbl}]`;
        if (!mMap.has(candidateTok)) {
          return { token: candidateTok, label: candidateLbl };
        }
      }
    }
    let n = 2;
    while (mMap.has(`@[${cleanLabel} (${n})]`)) n += 1;
    const numbered = `${cleanLabel} (${n})`;
    return { token: `@[${numbered}]`, label: numbered };
  }

  function applyPdMentionSelection(index) {
    if (!pState.pdMentionState.open) return;
    const item = pState.pdMentionState.items[index];
    const compInput = document.getElementById('ag-pd-composer-input');
    const allProjects = collectNativeProjects();
    const project = allProjects.find((p) => p.id === pState.pdMentionState.projectId);
    if (!item || !compInput || !project) return;

    const val = compInput.value || '';
    const start = pState.pdMentionState.startIdx;
    const end = pState.pdMentionState.endIdx;
    if (start < 0 || end < start) return;

    if (item.isCategory && item.categoryTrigger) {
      const replacement = `@${item.categoryTrigger}:`;
      compInput.value = `${val.slice(0, start)}${replacement}${val.slice(end)}`;
      const nextCaret = start + replacement.length;
      compInput.focus();
      try {
        compInput.setSelectionRange(nextCaret, nextCaret);
      } catch {}
      dispatchInputEvent(compInput);
      return;
    }

    const mMap = getProjectMentionMap(project.id, true);
    const { token, label: finalLabel } = allocateUniqueMentionToken(mMap, item.label, item);
    mMap.set(token, {
      token,
      label: finalLabel,
      kind: item.kind || 'plugin',
      logo: item.logo || '',
      scopeItem: item.scopeItem
    });
    const afterChar = val.slice(end, end + 1);
    const trailingSpace = afterChar && /\s/.test(afterChar) ? '' : ' ';
    const inserted = `${token}${trailingSpace}`;
    compInput.value = `${val.slice(0, start)}${inserted}${val.slice(end)}`;
    const nextCaret = start + inserted.length;
    closePdMentionMenu();
    compInput.focus();
    try {
      compInput.setSelectionRange(nextCaret, nextCaret);
    } catch {}
    dispatchInputEvent(compInput);
  }

  function appendDroppedMentionsToPdComposer(project, compInput, items) {
    if (!project || !compInput || !Array.isArray(items) || !items.length) return;
    const mMap = getProjectMentionMap(project.id, true);
    let curVal = compInput.value || '';
    for (const item of items) {
      if (!item || !item.scopeItem) continue;
      const { token, label: finalLabel } = allocateUniqueMentionToken(mMap, item.label, item);
      mMap.set(token, {
        token,
        label: finalLabel,
        kind: item.kind || 'conversation',
        logo: item.logo || '',
        scopeItem: item.scopeItem
      });
      if (!curVal.includes(token)) {
        const sep = curVal && !/\s$/.test(curVal) ? ' ' : '';
        curVal = `${curVal}${sep}${token} `;
      }
    }
    compInput.value = curVal;
    compInput.focus();
    try {
      compInput.setSelectionRange(curVal.length, curVal.length);
    } catch {}
    dispatchInputEvent(compInput);
  }

  const PD_INLINE_URL_RE = /(?<![\w./@-])(?:https?:\/\/|www\.)[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/g;
  function openUrlAtTextareaCaret(textarea) {
    if (!textarea || typeof textarea.selectionStart !== 'number') return false;
    const text = textarea.value || '';
    const pos = textarea.selectionStart;
    PD_INLINE_URL_RE.lastIndex = 0;
    let m;
    while ((m = PD_INLINE_URL_RE.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (pos >= start && pos <= end) {
        const url = m[0].startsWith('www.') ? `https://${m[0]}` : m[0];
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch {}
        return true;
      }
    }
    return false;
  }

  async function updatePdMentionMenuForInput(project, compInput) {
    if (!project || !compInput) {
      closePdMentionMenu();
      return;
    }
    const parsed = parsePdMentionTrigger(compInput.value || '', compInput.selectionStart);
    if (!parsed) {
      if (pState.pdMentionState.open) closePdMentionMenu();
      return;
    }

    const seq = ++pState.pdMentionState.reqSeq;
    const sameCategory = pState.pdMentionState.open && pState.pdMentionState.category === parsed.category && pState.pdMentionState.rawQuery === parsed.rawQuery;
    pState.pdMentionState.open = true;
    pState.pdMentionState.projectId = project.id;
    pState.pdMentionState.startIdx = parsed.startIdx;
    pState.pdMentionState.endIdx = parsed.endIdx;
    pState.pdMentionState.rawQuery = parsed.rawQuery;
    pState.pdMentionState.category = parsed.category;
    pState.pdMentionState.subQuery = parsed.subQuery;
    if (!sameCategory) pState.pdMentionState.activeIndex = 0;

    const wsUris = getProjectWorkspaceUris(project);
    const hasLocalFolder = wsUris.length > 0;
    const browseSecTitle = L('分类浏览', 'Browse');
    const pluginSecTitle = L('扩展插件', 'Plugins');

    const baseCategories = [
      ...(hasLocalFolder
        ? [
            {
              isCategory: true,
              categoryTrigger: 'files',
              kind: 'file',
              section: browseSecTitle,
              label: L('项目文件', 'Project files'),
              desc: L('浏览本项目文件夹中的文件与目录', 'Browse files & folders in project')
            }
          ]
        : []),
      {
        isCategory: true,
        categoryTrigger: 'rules',
        kind: 'rule',
        section: browseSecTitle,
        label: L('项目规则', 'Rules'),
        desc: L('浏览规则', 'Browse rules')
      },
      {
        isCategory: true,
        categoryTrigger: 'conversation',
        kind: 'conversation',
        section: browseSecTitle,
        label: L('历史对话', 'Conversations'),
        desc: L('搜索并引用任意对话（含项目外对话）', 'Search conversations')
      },
      {
        isCategory: true,
        categoryTrigger: 'drive',
        kind: 'drive',
        section: browseSecTitle,
        label: 'Google Drive',
        desc: L('搜索云端硬盘文档', 'Search Google Drive')
      }
    ];

    /* 1. Drilled into a specific category (`@files:`, `@rules:`, `@conversation:`, `@drive:`) */
    if (parsed.category === 'conversation') {
      pState.pdMentionState.loading = false;
      pState.pdMentionState.items = collectMentionConversationOptions(project, parsed.subQuery);
      renderPdMentionPopover();
      return;
    }

    if (parsed.category === 'rules') {
      pState.pdMentionState.loading = true;
      renderPdMentionPopover();
      const rules = await fetchPdMentionRules(wsUris);
      if (rtState.disposed || pState.pdMentionState.reqSeq !== seq) return;
      const q = parsed.subQuery.trim().toLowerCase();
      pState.pdMentionState.loading = false;
      pState.pdMentionState.items = q
        ? rules.filter((r) => r.label.toLowerCase().includes(q) || String(r.desc || '').toLowerCase().includes(q))
        : rules;
      renderPdMentionPopover();
      return;
    }

    if (parsed.category === 'files') {
      pState.pdMentionState.loading = true;
      renderPdMentionPopover();
      const files = await fetchPdMentionProjectFiles(project, parsed.subQuery, seq);
      if (rtState.disposed || pState.pdMentionState.reqSeq !== seq) return;
      pState.pdMentionState.loading = false;
      pState.pdMentionState.items = files;
      renderPdMentionPopover();
      return;
    }

    if (parsed.category === 'drive') {
      pState.pdMentionState.loading = true;
      renderPdMentionPopover();
      const driveItems = await fetchPdMentionDriveItems(parsed.subQuery);
      if (rtState.disposed || pState.pdMentionState.reqSeq !== seq) return;
      pState.pdMentionState.loading = false;
      pState.pdMentionState.items = driveItems;
      renderPdMentionPopover();
      return;
    }

    /* 2. Root `@` (`rawQuery === ""`) -> instant Browse categories + Plugins (matching native @ menu) */
    const q = parsed.subQuery.trim().toLowerCase();
    if (!q) {
      const cachedPlugins = pState.pdMentionCache.pluginsByKey.get(wsUris.join('|') || '__global__');
      pState.pdMentionState.loading = !cachedPlugins;
      pState.pdMentionState.items = [
        ...baseCategories,
        ...((cachedPlugins ? cachedPlugins.items : []).map((p) => Object.assign({}, p, { section: pluginSecTitle })))
      ];
      renderPdMentionPopover();
      const plugins = await fetchPdMentionPlugins(wsUris);
      if (rtState.disposed || pState.pdMentionState.reqSeq !== seq) return;
      pState.pdMentionState.loading = false;
      pState.pdMentionState.items = [
        ...baseCategories,
        ...plugins.map((p) => Object.assign({}, p, { section: pluginSecTitle }))
      ];
      renderPdMentionPopover();
      return;
    }

    /* 3. Direct filter `@<q>` -> search Categories + Conversations + Project Files + Rules + Plugins in parallel! */
    const catHits = baseCategories.filter(
      (c) =>
        c.categoryTrigger.startsWith(q) ||
        c.label.toLowerCase().includes(q) ||
        String(c.desc || '').toLowerCase().includes(q)
    );
    const convHits = collectMentionConversationOptions(project, q)
      .slice(0, 6)
      .map((c) => Object.assign({}, c, { section: L('历史对话', 'Conversations') }));

    pState.pdMentionState.loading = true;
    pState.pdMentionState.items = [...catHits, ...convHits];
    renderPdMentionPopover();

    const [fileHits, ruleAll, pluginAll] = await Promise.all([
      hasLocalFolder ? fetchPdMentionProjectFiles(project, q, seq) : Promise.resolve([]),
      fetchPdMentionRules(wsUris),
      fetchPdMentionPlugins(wsUris)
    ]);
    if (rtState.disposed || pState.pdMentionState.reqSeq !== seq) return;

    const ruleHits = ruleAll
      .filter((r) => r.label.toLowerCase().includes(q) || String(r.desc || '').toLowerCase().includes(q))
      .slice(0, 6)
      .map((r) => Object.assign({}, r, { section: L('项目规则', 'Rules') }));
    const pluginHits = pluginAll
      .filter((p) => p.label.toLowerCase().includes(q) || String(p.desc || '').toLowerCase().includes(q))
      .slice(0, 6)
      .map((p) => Object.assign({}, p, { section: pluginSecTitle }));
    const taggedFiles = fileHits.slice(0, 8).map((f) => Object.assign({}, f, { section: L('项目文件', 'Project files') }));

    pState.pdMentionState.loading = false;
    pState.pdMentionState.items = [...catHits, ...taggedFiles, ...convHits, ...ruleHits, ...pluginHits];
    renderPdMentionPopover();
  }

  function buildComposerSubmitChunks(rawPrompt, mentionEntries = []) {
    const prompt = String(rawPrompt || '');
    if (!prompt.trim()) return [];
    const valid = (Array.isArray(mentionEntries) ? mentionEntries : []).filter(
      (e) => e && e.token && e.scopeItem && prompt.includes(e.token)
    );
    if (!valid.length) {
      return [{ $typeName: 'exa.codeium_common_pb.TextOrScopeItem', chunk: { case: 'text', value: prompt } }];
    }
    /* Sort longest token first to prevent prefix collisions */
    const sorted = valid.slice().sort((a, b) => b.token.length - a.token.length);
    const chunks = [];
    let cursor = 0;
    while (cursor < prompt.length) {
      let bestIdx = -1;
      let bestEntry = null;
      for (const en of sorted) {
        const idx = prompt.indexOf(en.token, cursor);
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
          bestEntry = en;
        }
      }
      if (bestIdx === -1 || !bestEntry) {
        const tail = prompt.slice(cursor);
        if (tail) {
          chunks.push({ $typeName: 'exa.codeium_common_pb.TextOrScopeItem', chunk: { case: 'text', value: tail } });
        }
        break;
      }
      if (bestIdx > cursor) {
        chunks.push({
          $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
          chunk: { case: 'text', value: prompt.slice(cursor, bestIdx) }
        });
      }
      chunks.push({
        $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
        chunk: { case: 'item', value: bestEntry.scopeItem }
      });
      cursor = bestIdx + bestEntry.token.length;
    }
    return chunks;
  }

  return {
    encodePathToFileUri,
    resolveCascadeRpcService,
    getProjectMentionMap,
    closePdMentionMenu,
    parsePdMentionTrigger,
    renderPdMentionPopover,
    syncPdMentionPills,
    getProjectMediaList,
    extractComposerImageFiles,
    stagePdComposerImageFiles,
    syncPdMediaStrip,
    movePdMentionSelection,
    applyPdMentionSelection,
    appendDroppedMentionsToPdComposer,
    openUrlAtTextareaCaret,
    updatePdMentionMenuForInput,
    buildComposerSubmitChunks,
  };
}
