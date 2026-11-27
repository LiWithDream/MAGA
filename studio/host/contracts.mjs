/**
 * Declarative Host Internal Coupling Registry (`studio/host/contracts.mjs`).
 *
 * Centralizes Antigravity Desktop 2.0 internal touchpoints (Invariant I10) across:
 *   - `read_dom_testid`   : DOM selectors / `data-testid` landmarks (fail-soft per feature)
 *   - `read_fiber_store`  : React `__reactFiber$` / Redux store inspection
 *   - `host_dispatch`     : Host-owned UI/store dispatch requiring precondition + state read-back
 *   - `hand_encoded_wire` : Connect HTTP+JSON / Protobuf wire surfaces (never probed via live writes)
 *   - `sqlite_schema`     : Read-only local SQLite tables & step payload invariants
 *
 * IMPORTANT: Keep this module out of `user/src/` so it never bloats the live `user/custom.js` bundle.
 */

export const HOST_CONTRACT_TIERS = Object.freeze([
  'read_dom_testid',
  'read_fiber_store',
  'host_dispatch',
  'hand_encoded_wire',
  'sqlite_schema',
]);

export const VERIFIED_HOST_BASELINES = Object.freeze({
  productName: 'antigravity',
  minVerifiedVersion: '2.33.0',
  latestVerifiedVersion: '2.35.2',
});

export const HOST_CONTRACTS = Object.freeze([
  // 1. DOM Landmarks (`read_dom_testid`)
  {
    id: 'dom.composer_input_box',
    tier: 'read_dom_testid',
    criticality: 'critical',
    selector: '#antigravity\\.agentSidePanelInputBox, [id="antigravity.agentSidePanelInputBox"]',
    modulePaths: ['studio/core/dom.mjs', 'user/src/entry.mjs'],
    fallbackBehavior: 'Composer capsules and model/effort picker stay unmounted without blanking host chat.',
  },
  {
    id: 'dom.conversation_list_sidebar',
    tier: 'read_dom_testid',
    criticality: 'degradable',
    selector: '[data-testid="conversation-list-sidebar"], .bg-sidebar',
    modulePaths: ['user/src/modules/projects/chrome-geometry.mjs', 'user/src/modules/sidebar-recents.mjs'],
    fallbackBehavior: 'Projects overlay & Unified Recents fall back to stock Antigravity sidebar.',
  },
  {
    id: 'dom.overview_panel_controls',
    tier: 'read_dom_testid',
    criticality: 'degradable',
    selector: 'button[data-testid="toggle-overview-panel"], [data-testid="overview-panel-host"]',
    modulePaths: ['user/src/modules/overview-panel.mjs', 'studio/modules/studio-settings.mjs'],
    fallbackBehavior: 'Settings drawer falls back to viewport top inset; Overview extensions stay dormant.',
  },
  {
    id: 'dom.aux_sidebar_toggle',
    tier: 'read_dom_testid',
    criticality: 'degradable',
    selector: 'button[data-testid="toggle-aux-sidebar"]',
    modulePaths: ['studio/modules/subagent/panel-handoff.mjs', 'studio/modules/studio-settings.mjs'],
    fallbackBehavior: 'Aux-to-Overview handoff animation skips gracefully.',
  },
  {
    id: 'dom.sidebar_project_anchors',
    tier: 'read_dom_testid',
    criticality: 'degradable',
    selector: '[data-testid="automations-button"], [data-testid="project-header"], #ag-claude-projects-nav-btn',
    modulePaths: ['user/src/modules/projects/chrome-geometry.mjs', 'user/src/modules/projects/index.mjs'],
    fallbackBehavior: 'Left sidebar geometry resolver falls back to bounding-box heuristic.',
  },

  // 2. React Fiber & Redux Store (`read_fiber_store`)
  {
    id: 'fiber.react_root_attachment',
    tier: 'read_fiber_store',
    criticality: 'critical',
    probeKey: 'hasReactFiber',
    modulePaths: ['user/src/core/model-api.mjs', 'user/src/modules/projects/native-store.mjs'],
    fallbackBehavior: 'Model picker and native project store fall back to passive DOM observation.',
  },
  {
    id: 'fiber.redux_store_shape',
    tier: 'read_fiber_store',
    criticality: 'degradable',
    probeKey: 'hasReduxStore',
    modulePaths: ['user/src/core/model-api.mjs', 'user/src/modules/projects/native-store.mjs'],
    fallbackBehavior: 'Scheduled-task model list and Redux project creation degrade to DOM fallback.',
  },

  // 3. Host-Owned Dispatch (`host_dispatch`)
  {
    id: 'dispatch.model_effort_selection',
    tier: 'host_dispatch',
    criticality: 'degradable',
    writePolicy: 'never_probed_live',
    precondition: 'Redux store or model selector fiber action present with matching model enum/tier.',
    postcondition: 'Read back active model ID and effort tier within 1 tick; abort without blind retry on mismatch.',
    modulePaths: ['user/src/core/model-api.mjs', 'vendor/agy-capsule/model_picker.mjs'],
    fallbackBehavior: 'Leaves native host model selector active.',
  },
  {
    id: 'dispatch.pinned_drag_drop_cascade',
    tier: 'host_dispatch',
    criticality: 'degradable',
    writePolicy: 'never_probed_live',
    precondition: 'Redux dispatch available and dragged row carries valid conversationId.',
    postcondition: 'layout/setDragOverChatCascadeId cleared on dragend/drop.',
    modulePaths: ['user/src/modules/sidebar-recents.mjs'],
    fallbackBehavior: 'Falls back to native HTML5 drag-and-drop payload.',
  },

  // 4. Hand-Encoded Wire / Connect-JSON (`hand_encoded_wire`)
  {
    id: 'wire.conversation_service_connect_json',
    tier: 'hand_encoded_wire',
    criticality: 'degradable',
    writePolicy: 'never_probed_live',
    wireSpec: 'POST http://$ANTIGRAVITY_LS_ADDRESS/product.v1.ConversationService/{ListConversations,GetConversation,CreateConversation,UpdateConversation} with Connect-Protocol-Version: 1 & x-antigravity-csrf-token.',
    precondition: 'Valid ANTIGRAVITY_LS_ADDRESS & ANTIGRAVITY_CSRF_TOKEN; explicit user click for CreateConversation.',
    postcondition: 'HTTP 200 JSON containing conversation.id matching UUID/CID pattern; never auto-retry on 4xx/5xx.',
    modulePaths: ['studio/daemon/anchors-service.mjs'],
    fallbackBehavior: 'Displays copyable handoff prompt if Connect endpoint is unavailable.',
  },
  {
    id: 'wire.slash_command_scope_item',
    tier: 'hand_encoded_wire',
    criticality: 'degradable',
    writePolicy: 'never_probed_live',
    wireSpec: 'SlashCommandScopeItem chunk encoding for Remote /compact and slash invocations.',
    precondition: 'Active conversation idle or accepting user turn; cascade-lock held.',
    postcondition: 'Verify new step or compaction checkpoint appears; release cascade-lock on timeout.',
    modulePaths: ['user/src/modules/remote-tap.mjs', 'user/src/modules/remote-tap-helpers.mjs'],
    fallbackBehavior: 'Returns structured RPC error to Remote PWA without corrupting composer.',
  },
  {
    id: 'wire.remote_permission_approval_cas',
    tier: 'hand_encoded_wire',
    criticality: 'critical',
    writePolicy: 'never_probed_live',
    wireSpec: 'Remote convo.approve with PermissionScope.ONCE and waitingStepHash CAS.',
    precondition: 'Operator role verified + live waitingStepHash matches client CAS token.',
    postcondition: 'Step transitions out of waiting state; audit log entry recorded.',
    modulePaths: ['core/daemon/remote-bridge.mjs', 'user/src/modules/remote-tap.mjs'],
    fallbackBehavior: 'Fails closed (rejects approval) on any hash mismatch or missing step.',
  },

  // 5. Local SQLite Read-Only Contracts (`sqlite_schema`)
  {
    id: 'sqlite.conversation_steps_table',
    tier: 'sqlite_schema',
    criticality: 'critical',
    sqlTable: 'steps',
    requiredColumns: ['idx', 'step_type', 'status', 'step_payload'],
    verifiedFacts: [
      'step_type=15 m20.3 thinking is stripped on older rows; full CoT lives in brain/<cid>/.system_generated/logs/transcript_full.jsonl',
      'step_type=23 stores compaction checkpoints (summary in field 30.5)',
      'step_type=132 stores schedule tool waits',
    ],
    modulePaths: [
      'studio/plugin/maga-auto-compact/hooks/compact-check.mjs',
      'studio/daemon/usage-service.mjs',
    ],
    fallbackBehavior: 'Opens strictly readOnly; returns 0/empty metrics on schema drift without throwing.',
  },
]);

/**
 * Builds a strictly read-only CDP expression that checks live DOM selectors,
 * React Fiber attachment, Redux store shape, and `window.__APP_CONFIG__.appVersion`.
 * Zero clicks, zero dispatches, zero mutations.
 */
export function buildReadOnlyCdpContractProbeExpression() {
  const domChecks = HOST_CONTRACTS.filter((c) => c.tier === 'read_dom_testid').map((c) => ({
    id: c.id,
    selector: c.selector,
  }));
  return `(() => {
    const appCfg = window.__APP_CONFIG__ && typeof window.__APP_CONFIG__ === 'object' ? window.__APP_CONFIG__ : {};
    const dom = {};
    for (const item of ${JSON.stringify(domChecks)}) {
      try {
        dom[item.id] = Boolean(document.querySelector(item.selector));
      } catch {
        dom[item.id] = false;
      }
    }
    let hasReactFiber = false;
    let hasReduxStore = false;
    const rootEl = document.getElementById('root') || document.body;
    const scanNodes = [
      document.querySelector('[data-testid="conversation-list-sidebar"]'),
      document.querySelector('[data-testid="conversation-row-sidebar"]'),
      document.getElementById('antigravity.agentSidePanelInputBox'),
      rootEl,
    ].filter(Boolean);
    for (const node of scanNodes) {
      for (const k of Object.keys(node)) {
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')) {
          hasReactFiber = true;
          let cur = node[k];
          for (let depth = 0; depth < 40 && cur; depth += 1, cur = cur.return) {
            const directStore = cur.memoizedProps?.store || cur.memoizedProps?.value?.store || cur.stateNode?.store;
            if (directStore && typeof directStore.getState === 'function' && typeof directStore.dispatch === 'function') {
              hasReduxStore = true;
              break;
            }
            for (let dep = cur.dependencies && cur.dependencies.firstContext; dep; dep = dep.next) {
              const mv = dep.memoizedValue;
              if (mv && mv.store && typeof mv.store.getState === 'function' && typeof mv.store.dispatch === 'function') {
                hasReduxStore = true;
                break;
              }
            }
            if (hasReduxStore) break;
          }
        }
        if (hasReduxStore) break;
      }
      if (hasReduxStore) break;
    }
    return {
      hostVersion: typeof appCfg.appVersion === 'string' ? appCfg.appVersion.trim() : '',
      productName: typeof appCfg.productName === 'string' ? appCfg.productName.trim() : '',
      dom,
      fiber: {
        hasReactFiber,
        hasReduxStore,
      },
    };
  })()`;
}

export function evaluateHostContractReport({
  hostVersion = 'unknown',
  cdpSnapshot = null,
  sqliteReport = null,
  requireLiveCdp = false,
} = {}) {
  const results = [];
  let criticalFailures = 0;
  let degradedCount = 0;

  for (const contract of HOST_CONTRACTS) {
    if (contract.tier === 'read_dom_testid') {
      if (!cdpSnapshot) {
        if (requireLiveCdp && contract.criticality === 'critical') criticalFailures += 1;
        results.push({ id: contract.id, tier: contract.tier, criticality: contract.criticality, status: requireLiveCdp ? 'missing_cdp' : 'skipped_offline' });
      } else {
        const matched = Boolean(cdpSnapshot.dom?.[contract.id]);
        if (!matched) {
          if (contract.criticality === 'critical') criticalFailures += 1;
          else degradedCount += 1;
        }
        results.push({ id: contract.id, tier: contract.tier, criticality: contract.criticality, status: matched ? 'pass' : 'fail' });
      }
      continue;
    }

    if (contract.tier === 'read_fiber_store') {
      if (!cdpSnapshot) {
        if (requireLiveCdp && contract.criticality === 'critical') criticalFailures += 1;
        results.push({ id: contract.id, tier: contract.tier, criticality: contract.criticality, status: requireLiveCdp ? 'missing_cdp' : 'skipped_offline' });
      } else {
        const matched = Boolean(cdpSnapshot.fiber?.[contract.probeKey]);
        if (!matched) {
          if (contract.criticality === 'critical') criticalFailures += 1;
          else degradedCount += 1;
        }
        results.push({ id: contract.id, tier: contract.tier, criticality: contract.criticality, status: matched ? 'pass' : 'fail' });
      }
      continue;
    }

    if (contract.tier === 'sqlite_schema') {
      if (!sqliteReport || sqliteReport.status === 'no_db' || sqliteReport.status === 'sqlite_unavailable') {
        results.push({ id: contract.id, tier: contract.tier, criticality: contract.criticality, status: sqliteReport?.status || 'skipped_no_db' });
      } else {
        const matched = sqliteReport.status === 'pass';
        if (!matched) {
          if (contract.criticality === 'critical') criticalFailures += 1;
          else degradedCount += 1;
        }
        results.push({
          id: contract.id,
          tier: contract.tier,
          criticality: contract.criticality,
          status: matched ? 'pass' : 'fail',
          ...(sqliteReport.missingColumns?.length ? { missingColumns: sqliteReport.missingColumns } : {}),
        });
      }
      continue;
    }

    // host_dispatch & hand_encoded_wire are statically specified (never probed via live writes)
    const staticOk = Boolean(contract.precondition && contract.postcondition && contract.writePolicy === 'never_probed_live');
    if (!staticOk) criticalFailures += 1;
    results.push({
      id: contract.id,
      tier: contract.tier,
      criticality: contract.criticality,
      status: staticOk ? 'static_verified' : 'invalid_spec',
    });
  }

  const status = criticalFailures > 0 ? 'broken' : degradedCount > 0 ? 'degraded' : 'verified';
  return {
    ok: criticalFailures === 0,
    status,
    hostVersion: hostVersion || cdpSnapshot?.hostVersion || 'unknown',
    verifiedBaseline: VERIFIED_HOST_BASELINES,
    summary: {
      total: HOST_CONTRACTS.length,
      criticalFailures,
      degradedCount,
      cdpEvaluated: Boolean(cdpSnapshot),
      sqliteStatus: sqliteReport?.status || 'skipped',
    },
    results,
  };
}
