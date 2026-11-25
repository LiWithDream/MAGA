/**
 * Live Zero-Reload UI Localization Engine (i18n) & native macOS Context Menu localization.
 */
export function createI18nModule(rt) {
  const { FEAT, state: rtState, cancelLater, docRoot } = rt;

  /* ==========================================================================
   * 8b. Live Zero-Reload UI Localization Engine (`i18n`, off / English by default)
   *     - Reuses upstream `ctx.dict` / `window.__ag_i18n_dict` and `window.__ag_orig_text_map`
   *     - Toggling `i18n` in Settings immediately translates or restores all native Antigravity
   *       text nodes & title/placeholder/aria-label attributes with zero page reload.
   * ========================================================================== */
  const UX_I18N_BASE_EXCLUDE =
    'code, pre, kbd, samp, textarea, input, style, script, noscript, [contenteditable="true"], [data-markdown-root], [data-testid="user-message-content"], .agy-user-bubble, [data-testid="skill-scope-item-pill"], bdi.context-scope-mention, .monaco-editor, .monaco-diff-editor, .xterm, [class*="onyx-key"], .prose, .markdown, [class*="chat-message"], [class*="group/file-title"], [data-testid="conversation-row-sidebar"] a[href^="/c/"], [data-testid="conversation-row-sidebar"] span.truncate, [data-testid="conversation-navigator-turn"], .msg-body, #raw, #swarm-title, #ag-live-metrics-pill, #ag-live-metrics-tooltip, [data-ag-i18n-ignore="1"], #ag-claude-quota-popover, #ag-claude-ux-settings-nav, #ag-claude-ux-settings-panel, #ag-claude-recent-section, #ag-recent-row-menu, #ag-project-action-menu, [data-testid="model-selector-trigger"], [data-testid="permissions-selector-trigger"]';
  const UX_I18N_ATTR_EXCLUDE =
    'code, pre, kbd, samp, style, script, noscript, [data-markdown-root], [data-testid="user-message-content"], .agy-user-bubble, [data-testid="skill-scope-item-pill"], bdi.context-scope-mention, .monaco-editor, .monaco-diff-editor, .xterm, #ag-live-metrics-pill, #ag-live-metrics-tooltip, [data-ag-i18n-ignore="1"], #ag-claude-quota-popover, #ag-claude-ux-settings-nav, #ag-claude-ux-settings-panel, #ag-claude-recent-section, #ag-recent-row-menu, #ag-project-action-menu, [data-testid="model-selector-trigger"], [data-testid="permissions-selector-trigger"]';
  let uxI18nObserver = null;
  let uxI18nFlushTimer = 0;
  let uxI18nDirtyRoots = new Set();
  let uxI18nDictRef = null;
  let uxI18nDictCi = null;

  function getUxI18nExcludeSelector() {
    const extra =
      typeof ctx !== 'undefined' && ctx && ctx.config && ctx.config.selectors && ctx.config.selectors.excludeI18n
        ? String(ctx.config.selectors.excludeI18n).trim()
        : '';
    return extra ? `${UX_I18N_BASE_EXCLUDE}, ${extra}` : UX_I18N_BASE_EXCLUDE;
  }

  function getUxI18nDict() {
    const d =
      (typeof ctx !== 'undefined' && ctx && ctx.dict && typeof ctx.dict === 'object' ? ctx.dict : null) ||
      (window.__ag_i18n_dict && typeof window.__ag_i18n_dict === 'object' ? window.__ag_i18n_dict : null);
    if (!d) return null;
    if (d !== uxI18nDictRef) {
      uxI18nDictRef = d;
      uxI18nDictCi = Object.create(null);
      for (const k of Object.keys(d)) {
        const v = d[k];
        if (typeof v === 'string') uxI18nDictCi[k.toLowerCase()] = v;
      }
    }
    return d;
  }

  function getOrigTextMap() {
    if (!window.__ag_orig_text_map) {
      window.__ag_orig_text_map = new WeakMap();
    }
    return window.__ag_orig_text_map;
  }

  const UX_RE_EPHEMERAL_SUMMARY =
    /^(Explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|Ran\s+(?:\d+\s+)?commands?|Edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?)(?:,\s*(explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|ran\s+(?:\d+\s+)?commands?|edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?))*$/i;
  const UX_EPHEMERAL_CLAUSE_MAP = {
    explored: '已探索',
    'explored file': '已探索文件',
    'explored files': '已探索文件',
    'explored artifact': '已探索 Artifact',
    'explored artifacts': '已探索 Artifact',
    'explored file and artifact': '已探索文件与 Artifact',
    'explored files and artifact': '已探索文件与 Artifact',
    'explored file and artifacts': '已探索文件与 Artifact',
    'explored files and artifacts': '已探索文件与 Artifact',
    'ran command': '已运行命令',
    'ran commands': '已运行命令',
    edited: '已编辑',
    'edited file': '已编辑文件',
    'edited files': '已编辑文件',
    'edited artifact': '已编辑 Artifact',
    'edited artifacts': '已编辑 Artifact',
    'edited file and artifact': '已编辑文件与 Artifact',
    'edited files and artifact': '已编辑文件与 Artifact',
    'edited file and artifacts': '已编辑文件与 Artifact',
    'edited files and artifacts': '已编辑文件与 Artifact'
  };
  const UX_RE_EPHEMERAL_COUNT = /^(explored|edited|ran)\s+(\d+)\s+(files?|artifacts?|commands?)$/i;
  const UX_RE_EPHEMERAL_ACTIVE = /^(Editing|Reading|Listing|Searching)\s+(.+)$/;
  const UX_EPHEMERAL_VERB_MAP = { Editing: '正在编辑', Reading: '正在读取', Listing: '正在列出', Searching: '正在搜索' };
  const UX_EPHEMERAL_NOUN_MAP = {
    file: '文件',
    files: '文件',
    artifact: 'Artifact',
    artifacts: 'Artifact',
    'file and artifact': '文件与 Artifact',
    'files and artifact': '文件与 Artifact',
    'file and artifacts': '文件与 Artifact',
    'files and artifacts': '文件与 Artifact'
  };
  const UX_RE_RUNNING_FOR = /^Running\s+for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
  const UX_RE_RUNNING_CMD = /^Running\s+(?!commands?\b|processes\b|for\b|\(Dev\b)(.+)$/;

  function translateUxEphemeralClause(clause) {
    const low = clause.trim().toLowerCase();
    if (UX_EPHEMERAL_CLAUSE_MAP[low]) return UX_EPHEMERAL_CLAUSE_MAP[low];
    const mCount = low.match(UX_RE_EPHEMERAL_COUNT);
    if (mCount) {
      const vMap = { explored: '已探索', edited: '已编辑', ran: '已运行' };
      const nMap = { file: '个文件', files: '个文件', artifact: '个 Artifact', artifacts: '个 Artifact', command: '条命令', commands: '条命令' };
      return `${vMap[mCount[1]]} ${mCount[2]} ${nMap[mCount[3]]}`;
    }
    return clause.trim();
  }

  function translateUxQuotaWindow(rawWin) {
    const w = String(rawWin || '').trim();
    const low = w.toLowerCase();
    if (low === 'weekly' || low === '7-day' || low === '7d') return '每周';
    if (low === 'daily' || low === '24-hour' || low === '24h') return '每日';
    if (low === 'hourly' || low === '1-hour' || low === '1h') return '每小时';
    if (low === 'monthly' || low === '30-day' || low === '30d') return '每月';
    const mHr = low.match(/^(\d+)\s*-?\s*hours?$/i) || low.match(/^(\d+)h$/i);
    if (mHr) return `${mHr[1]} 小时`;
    const mDay = low.match(/^(\d+)\s*-?\s*days?$/i) || low.match(/^(\d+)d$/i);
    if (mDay) return `${mDay[1]} 天`;
    return w;
  }

  function translateUxDurationPhrase(rawDur) {
    let s = String(rawDur || '').trim().replace(/\.$/, '');
    if (!s) return '';
    if (/^(?:<1m|less than a minute|under a minute)$/i.test(s)) return '不到 1 分钟';
    s = s
      .replace(/(\d+)\s*days?\b/gi, '$1 天')
      .replace(/(\d+)\s*hours?\b/gi, '$1 小时')
      .replace(/(\d+)\s*minutes?\b/gi, '$1 分钟')
      .replace(/(\d+)\s*mins?\b/gi, '$1 分钟')
      .replace(/(\d+)\s*seconds?\b/gi, '$1 秒')
      .replace(/\b(\d+)d\b/gi, '$1 天')
      .replace(/\b(\d+)h\b/gi, '$1 小时')
      .replace(/\b(\d+)m\b/gi, '$1 分钟')
      .replace(/\b(\d+)s\b/gi, '$1 秒')
      .replace(/\s*,\s*(?:and\s+)?/gi, ' ')
      .replace(/\s+and\s+/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return s;
  }

  function uxI18nLookup(trimmed, contextEl) {
    const dict = getUxI18nDict();
    if (!dict || !trimmed) return null;
    if (typeof dict[trimmed] === 'string') return dict[trimmed];
    if (uxI18nDictCi && typeof uxI18nDictCi[trimmed.toLowerCase()] === 'string') {
      return uxI18nDictCi[trimmed.toLowerCase()];
    }
    if (trimmed.endsWith('.')) {
      const base = trimmed.slice(0, -1);
      const hit =
        (typeof dict[base] === 'string' && dict[base]) ||
        (uxI18nDictCi && typeof uxI18nDictCi[base.toLowerCase()] === 'string' && uxI18nDictCi[base.toLowerCase()]);
      if (hit) return hit.endsWith('。') ? hit : `${hit}。`;
    }
    /* High-frequency dynamic Antigravity UI strings when runtime.js i18n is disabled */
    if (!/[A-Za-z]/.test(trimmed) || trimmed.length > 340) return null;
    let m;
    if (UX_RE_EPHEMERAL_SUMMARY.test(trimmed)) {
      return trimmed.split(/,\s*/).map((part) => translateUxEphemeralClause(part)).join('、');
    }
    const inHdr = Boolean(contextEl && contextEl.closest && contextEl.closest('header, [data-testid="breadcrumb-segment"]'));
    if (!inHdr && (m = trimmed.match(UX_RE_EPHEMERAL_ACTIVE))) {
      const noun = UX_EPHEMERAL_NOUN_MAP[m[2].toLowerCase()];
      const verbZh = UX_EPHEMERAL_VERB_MAP[m[1]];
      return noun ? (/^[A-Za-z0-9]/.test(noun) ? `${verbZh} ${noun}` : `${verbZh}${noun}`) : `${verbZh} ${m[2]}`;
    }
    if ((m = trimmed.match(UX_RE_RUNNING_FOR))) return `已运行 ${m[1]}`;
    if (!inHdr && (m = trimmed.match(UX_RE_RUNNING_CMD))) return `正在运行 ${m[1]}`;
    if ((m = trimmed.match(/^(\d+)\s+files?\s+changed$/i))) return `${m[1]} 个文件变更`;
    if ((m = trimmed.match(/^(\d+)\s+tools?$/i))) return `${m[1]} 个工具`;
    if ((m = trimmed.match(/^(\d+)\s+updates?$/i))) return `${m[1]} 条进展`;
    if ((m = trimmed.match(/^Worked\s+for\s+(.+)$/i))) return `已工作 ${m[1]}`;
    if ((m = trimmed.match(/^Working\s+for\s+(.+)$/i))) return `正在工作 ${m[1]}`;
    if ((m = trimmed.match(/^Thought\s+for\s+(.+)$/i))) return `已思考 ${m[1]}`;
    if ((m = trimmed.match(/^Thinking\s+for\s+(.+)$/i))) return `正在思考 ${m[1]}`;
    if ((m = trimmed.match(/^(\d+)\s+(seconds?|minutes?|hours?|days?)\s+ago$/i))) {
      const unitMap = { second: '秒', seconds: '秒', minute: '分钟', minutes: '分钟', hour: '小时', hours: '小时', day: '天', days: '天' };
      return `${m[1]} ${unitMap[m[2].toLowerCase()] || m[2]}前`;
    }
    if ((m = trimmed.match(/^(\d+(?:\.\d+)?)%\s+left$/i))) return `${m[1]}% 剩余`;
    if ((m = trimmed.match(/^Your Plan:\s*(.+)$/i))) return `当前方案：${m[1]}`;
    if ((m = trimmed.match(/^You can upgrade to a higher\s+(.+?)\s+plan to receive the highest rate limits\.?$/i))) {
      return `您可以升级到更高的 ${m[1]} 方案以获取最高速率配额。`;
    }
    const padWinZh = (raw) => {
      const w = translateUxQuotaWindow(raw);
      return /^[0-9A-Za-z]/.test(w) ? ` ${w}` : w;
    };
    if (
      (m = trimmed.match(
        /^You have used (some|all|most|\d+(?:\.\d+)?%?) of your (.+?) limit,\s*it will (?:(fully)\s+)?refresh in (.+?)\.?$/i
      ))
    ) {
      const amt = m[1].toLowerCase();
      const winZh = padWinZh(m[2]);
      const fullZh = m[3] ? '完全' : '';
      const durZh = translateUxDurationPhrase(m[4]);
      if (amt === 'all') return `您的${winZh}额度已用尽，将在 ${durZh}后${fullZh}恢复。`;
      if (amt === 'some') return `您已使用部分${winZh}额度，将在 ${durZh}后${fullZh}恢复。`;
      if (amt === 'most') return `您已使用大部分${winZh}额度，将在 ${durZh}后${fullZh}恢复。`;
      return `您已使用 ${m[1]} 的${winZh}额度，将在 ${durZh}后${fullZh}恢复。`;
    }
    if ((m = trimmed.match(/^You (?:haven't|have not) used any of your (.+?) limit(?:\s+yet)?\.?$/i))) {
      return `您尚未消耗${padWinZh(m[1])}额度。`;
    }
    if ((m = trimmed.match(/^You have reached your (.+?) limit(?:,\s*it will (?:(fully)\s+)?refresh in (.+?))?\.?$/i))) {
      const winZh = padWinZh(m[1]);
      if (m[3]) {
        return `您已达到${winZh}额度上限，将在 ${translateUxDurationPhrase(m[3])}后${m[2] ? '完全' : ''}恢复。`;
      }
      return `您已达到${winZh}额度上限。`;
    }
    if ((m = trimmed.match(/^Your (.+?) limit (?:will )?(?:(fully)\s+)?refresh(?:es)? in (.+?)\.?$/i))) {
      return `您的${padWinZh(m[1])}额度将在 ${translateUxDurationPhrase(m[3])}后${m[2] ? '完全' : ''}恢复。`;
    }
    if ((m = trimmed.match(/^Your (.+?) limit starts when you send your first message\.?$/i))) {
      return `您的${padWinZh(m[1])}额度将从发送第一条消息时起算。`;
    }
    if ((m = trimmed.match(/^Resets in\s+(.+)$/i))) {
      return `${translateUxDurationPhrase(m[1])}后重置`;
    }
    if ((m = trimmed.match(/^(?:Quota is )?shared across\s+(.+?)\.?$/i))) {
      return `由 ${m[1].replace(/,\s*and\s+/gi, '、').replace(/\s+and\s+/gi, ' 与 ')} 共享额度。`;
    }
    if ((m = trimmed.match(/^Show\s+(\d+)\s+breakdowns?$/i))) return `展开 ${m[1]} 项明细`;
    if ((m = trimmed.match(/^Hide\s+(?:\d+\s+)?breakdowns?$/i))) return '收起明细';
    if ((m = trimmed.match(/^Send feedback as\s+(.+)$/i))) return `以 ${m[1]} 身份发送反馈`;
    if (
      (m = trimmed.match(
        /^You have (a|\d+) conversations? in progress\.\s*Updating will (interrupt|cancel) (?:it|them),\s*and (.+?)\.?$/i
      ))
    ) {
      const cnt = m[1].toLowerCase() === 'a' ? '1' : m[1];
      if (m[2].toLowerCase() === 'interrupt') {
        return `当前有 ${cnt} 个对话正在运行。更新将暂时中断对话，并在更新完成后自动恢复。`;
      }
      return `当前有 ${cnt} 个对话正在运行。更新将取消这些对话，更新后需手动重新发起。`;
    }
    return null;
  }

  function uxRestoreAllTranslations(root) {
    const scope = root || document.body;
    if (!scope) return;
    const origMap = getOrigTextMap();
    try {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const rec = origMap.get(node);
        if (rec) {
          if (node.nodeValue === rec.lastVal) {
            node.nodeValue = rec.origRaw;
          }
          origMap.delete(node);
        }
      }
      const attrNames = ['title', 'placeholder', 'aria-label'];
      const els = scope.querySelectorAll
        ? scope.querySelectorAll(
            '[data-ag-orig-title], [data-ag-orig-title-last], [data-ag-orig-placeholder], [data-ag-orig-placeholder-last], [data-ag-orig-aria-label], [data-ag-orig-aria-label-last]'
          )
        : [];
      for (const el of els) {
        for (const attr of attrNames) {
          const origAttr = `data-ag-orig-${attr}`;
          const lastAttr = `${origAttr}-last`;
          if (el.hasAttribute(origAttr) || el.hasAttribute(lastAttr)) {
            const savedOrig = el.getAttribute(origAttr);
            const savedLast = el.getAttribute(lastAttr);
            const cur = el.getAttribute(attr);
            if (savedOrig !== null && (savedLast === null || cur === savedLast)) {
              el.setAttribute(attr, savedOrig);
            }
            el.removeAttribute(origAttr);
            el.removeAttribute(lastAttr);
          }
        }
      }
    } catch {}
  }

  function uxTranslateSubtree(root) {
    if (!root || !FEAT.i18n || rtState.disposed) return;
    if (!getUxI18nDict()) return;
    const exclSel = getUxI18nExcludeSelector();
    const origMap = getOrigTextMap();
    const isExcluded = (el) => {
      if (!el || el.nodeType !== 1) return true;
      try {
        return Boolean(el.closest(exclSel));
      } catch {
        return Boolean(el.closest(UX_I18N_BASE_EXCLUDE));
      }
    };
    try {
      const translateText = (node) => {
        if (!node || node.nodeType !== 3) return;
        const p = node.parentElement;
        if (!p || isExcluded(p)) return;
        const cur = node.nodeValue;
        if (!cur) return;
        const rec = origMap.get(node);
        if (rec && rec.lastVal === cur) return;
        const origRaw = rec && rec.lastVal === cur ? rec.origRaw : cur;
        const trimmed = origRaw.trim();
        if (!trimmed) return;
        const hit = uxI18nLookup(trimmed, p);
        if (typeof hit === 'string' && hit !== trimmed) {
          const next = origRaw.replace(trimmed, () => hit);
          origMap.set(node, { origRaw, lastVal: next, ver: 'ux' });
          if (node.nodeValue !== next) node.nodeValue = next;
        }
      };

      if (root.nodeType === 3) {
        translateText(root);
        return;
      }
      if (root.nodeType === 1 && isExcluded(root)) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) translateText(node);

      const attrTargets = [];
      if (root.nodeType === 1 && root.matches && root.matches('[title], [placeholder], [aria-label]')) {
        attrTargets.push(root);
      }
      if (root.querySelectorAll) {
        root.querySelectorAll('[title], [placeholder], [aria-label]').forEach((el) => attrTargets.push(el));
      }
      for (const el of attrTargets) {
        try {
          if (el.closest(UX_I18N_ATTR_EXCLUDE)) continue;
        } catch {}
        for (const attr of ['title', 'placeholder', 'aria-label']) {
          const cur = el.getAttribute(attr);
          if (!cur) continue;
          const origAttr = `data-ag-orig-${attr}`;
          const lastAttr = `${origAttr}-last`;
          const savedOrig = el.getAttribute(origAttr);
          const savedLast = el.getAttribute(lastAttr);
          if (savedOrig !== null && savedLast === cur) continue;
          const origVal = savedOrig !== null && savedLast === cur ? savedOrig : cur;
          const hit = uxI18nLookup(origVal.trim(), el);
          if (typeof hit === 'string' && hit !== origVal.trim()) {
            const nextVal = origVal.replace(origVal.trim(), () => hit);
            if (savedOrig !== origVal) el.setAttribute(origAttr, origVal);
            el.setAttribute(lastAttr, nextVal);
            if (cur !== nextVal) el.setAttribute(attr, nextVal);
          }
        }
      }
    } catch {}
  }

  function stopUxI18nObserver() {
    if (uxI18nObserver) {
      try {
        uxI18nObserver.disconnect();
      } catch {}
      uxI18nObserver = null;
    }
    if (uxI18nFlushTimer) {
      cancelLater(uxI18nFlushTimer);
      uxI18nFlushTimer = 0;
    }
    uxI18nDirtyRoots.clear();
  }

  function applyUiI18nState(enabled) {
    if (docRoot) {
      docRoot.setAttribute('data-ag-ux-lang', enabled ? 'zh' : 'en');
    }
    if (!enabled) {
      stopUxI18nObserver();
      if (window.__ag_i18n_observer) {
        try {
          window.__ag_i18n_observer.disconnect();
        } catch {}
        window.__ag_i18n_observer = null;
      }
      if (document.body) uxRestoreAllTranslations(document.body);
      return;
    }
    if (document.body) {
      uxTranslateSubtree(document.body);
      if (!uxI18nObserver && typeof MutationObserver !== 'undefined') {
        uxI18nObserver = new MutationObserver((mutations) => {
          if (rtState.disposed || !FEAT.i18n) return;
          const roots = new Set();
          for (const m of mutations) {
            if (m.type === 'characterData' && m.target) {
              roots.add(m.target);
            } else if (m.type === 'childList') {
              for (const n of m.addedNodes) {
                if (n.nodeType === 1 || n.nodeType === 3) roots.add(n);
              }
            } else if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
              roots.add(m.target);
            }
          }
          if (!roots.size) return;
          for (const r of roots) {
            if (!r || !r.isConnected) continue;
            let covered = false;
            let p = r.parentElement;
            while (p && p !== document.body) {
              if (roots.has(p)) {
                covered = true;
                break;
              }
              p = p.parentElement;
            }
            if (!covered) uxTranslateSubtree(r);
          }
          if (uxI18nObserver) uxI18nObserver.takeRecords();
        });
        uxI18nObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['title', 'placeholder', 'aria-label']
        });
      }
    }
  }

  /* ---- Native Electron NSMenu Context Menu Localization (e.g., Pinned Conversations) ---- */
  function normalizeNativeMenuAccelerator(acc) {
    if (typeof acc !== 'string' || !acc) return undefined;
    return acc
      .replace(/\u2303/g, 'Control+')
      .replace(/\u2325/g, 'Alt+')
      .replace(/\u21e7/g, 'Shift+')
      .replace(/\u2318/g, 'CmdOrCtrl+')
      .replace(/\u23ce/g, 'Enter');
  }

  function translateNativeMenuLabel(rawLabel) {
    if (typeof rawLabel !== 'string' || !rawLabel) return rawLabel;
    const trimmed = rawLabel.trim();
    if (!trimmed) return rawLabel;
    const hit = uxI18nLookup(trimmed, null);
    if (typeof hit === 'string' && hit) return hit;
    const mGroup = trimmed.match(/^Move to Group:\s*(.+)$/i);
    if (mGroup) return `移至分组：${mGroup[1]}`;
    return rawLabel;
  }

  function resolveNativeContextMenuFromTarget(targetEl, nativeEv) {
    const startEl = targetEl && targetEl.nodeType === 1 ? targetEl : targetEl && targetEl.parentElement;
    if (!startEl) return null;
    let cur = startEl;
    let startFiber = null;
    for (let up = 0; up < 8 && cur && !startFiber; up++, cur = cur.parentElement) {
      const fk = Object.keys(cur).find((k) => k.startsWith('__reactFiber$'));
      if (fk && cur[fk]) startFiber = cur[fk];
    }
    if (!startFiber) return null;
    let f = startFiber;
    for (let depth = 0; depth < 16 && f; depth++, f = f.return) {
      const p = f.memoizedProps;
      if (!p || p.disabled) continue;
      if (typeof p.items !== 'function' && !Array.isArray(p.items)) continue;
      const childHasCtx = Boolean(
        f.child && f.child.memoizedProps && typeof f.child.memoizedProps.onContextMenu === 'function'
      );
      if (!childHasCtx) continue;
      let rawItems;
      try {
        rawItems = typeof p.items === 'function' ? p.items(nativeEv) : p.items;
      } catch {
        return null;
      }
      if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
      const valid = rawItems.some(
        (it) =>
          it &&
          (it.type === 'separator' ||
            (typeof it.label === 'string' &&
              (typeof it.onClick === 'function' || typeof it.click === 'function' || Array.isArray(it.items))))
      );
      if (!valid) continue;
      return {
        items: rawItems,
        onOpenChange: typeof p.onOpenChange === 'function' ? p.onOpenChange : null
      };
    }
    return null;
  }

  function buildLocalizedNativeMenuPayload(items, cbMap, prefix = 'cmi') {
    const out = [];
    for (let idx = 0; idx < items.length; idx++) {
      const d = items[idx];
      if (!d) continue;
      const id = d.id || `${prefix}-${idx}`;
      const handler = typeof d.onClick === 'function' ? d.onClick : typeof d.click === 'function' ? d.click : null;
      if (handler) cbMap.set(id, handler);
      const disabled =
        d.type === 'label'
          ? true
          : d.disabled !== undefined
            ? Boolean(d.disabled)
            : d.enabled !== undefined
              ? !d.enabled
              : false;
      const entry = {
        id,
        label: typeof d.label === 'string' ? translateNativeMenuLabel(d.label) : d.label,
        type: d.type && d.type !== 'item' && d.type !== 'label' ? d.type : 'normal',
        checked: d.checked,
        disabled,
        accelerator: normalizeNativeMenuAccelerator(d.accelerator)
      };
      if (Array.isArray(d.items) && d.items.length > 0) {
        entry.submenu = buildLocalizedNativeMenuPayload(d.items, cbMap, `${id}-sub`);
      }
      out.push(entry);
    }
    return out;
  }

  const onNativeContextMenuCapture = (e) => {
    if (rtState.disposed || !FEAT.i18n || e.altKey) return;
    if (typeof window.electronNative?.showContextMenu !== 'function') return;
    const t = e.target;
    const el = t && t.nodeType === 1 ? t : t && t.parentElement;
    if (!el || !el.closest) return;
    if (
      el.closest(
        'input, textarea, [contenteditable="true"], .monaco-editor, .monaco-diff-editor, .xterm, #ag-recent-row-menu, #ag-project-action-menu'
      )
    ) {
      return;
    }
    if (el.closest('.prose, .markdown, [data-markdown-root], [data-testid="user-message-content"]')) {
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && String(sel).trim()) return;
      } catch {}
    }
    const resolved = resolveNativeContextMenuFromTarget(el, e);
    if (!resolved) return;
    const cbMap = new Map();
    const payload = buildLocalizedNativeMenuPayload(resolved.items, cbMap);
    if (!payload.length) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    try {
      if (resolved.onOpenChange) resolved.onOpenChange(true);
    } catch {}
    try {
      Promise.resolve(window.electronNative.showContextMenu(payload))
        .then((chosenId) => {
          if (chosenId && cbMap.has(chosenId)) {
            try {
              cbMap.get(chosenId)();
            } catch {}
          }
        })
        .catch(() => {})
        .finally(() => {
          try {
            if (resolved.onOpenChange) resolved.onOpenChange(false);
          } catch {}
        });
    } catch {
      try {
        if (resolved.onOpenChange) resolved.onOpenChange(false);
      } catch {}
    }
  };
  document.addEventListener('contextmenu', onNativeContextMenuCapture, true);


  function dispose() {
    stopUxI18nObserver();
    document.removeEventListener('contextmenu', onNativeContextMenuCapture, true);
    if (docRoot && docRoot.getAttribute('lang') === 'zh-CN') {
      if (rt.hadDocLang && rt.origDocLang !== null) docRoot.setAttribute('lang', rt.origDocLang);
      else docRoot.removeAttribute('lang');
    }
    if (docRoot) {
      docRoot.removeAttribute('data-ag-ux-lang');
      docRoot.removeAttribute('data-ag-cjk-scale');
    }
  }

  return {
    uxTranslateSubtree,
    applyUiI18nState,
    stopUxI18nObserver,
    dispose,
  };
}
