/**
 * MAGA Studio Browser Entry (ESM, bundled to zero-dep browser IIFE via esbuild).
 * Boots StudioPrefs, MagaKernel single-observer scheduler, and all 6 Feature plugins.
 */
/* global __STUDIO_DEFAULT_PREFS__, __STUDIO_PREFS__, __STUDIO_LABELS__, __PICKER_SHADOW_CSS__, ctx */
import { createDomFlagsFeature } from './core/dom-flags.mjs';
import { createMagaKernel } from './core/kernel.mjs';
import { createCapsulePickerRuntime, shortenEffortBadge, shortenModelName } from './modules/capsule-picker.mjs';
import { createFooterUnifiedRuntime } from './modules/footer-unified.mjs';
import { createOverviewUsageRuntime } from './modules/overview-usage.mjs';
import { createOpusGatePillRuntime } from './modules/opus-gate-pill.mjs';
import { createProjectUsageRuntime } from './modules/project-usage.mjs';
import { createResumeBannerRuntime } from './modules/resume-banner.mjs';
import { createScrollbarClampRuntime } from './modules/scrollbar-clamp.mjs';
import { createStudioPrefsRuntime } from './modules/studio-prefs.mjs';
import { createStudioSettingsRuntime } from './modules/studio-settings.mjs';
import { createSubagentFooterRuntime } from './modules/subagent-footer.mjs';
import { effortEffects, mountEffortBar, mountOrchestratorSwitch } from '../vendor/agy-capsule/effort_bar.mjs';
import { syncModelPicker } from '../vendor/agy-capsule/model_picker.mjs';
import { motionThemes } from '../vendor/agy-capsule/motion_themes.mjs';

(function bootAgyStudio() {
  if (typeof window !== 'undefined' && typeof window.__agyStudioDispose === 'function') {
    try {
      window.__agyStudioDispose();
    } catch {}
  }
  if (typeof window !== 'undefined' && typeof window.__agyCapsulePickerDispose === 'function') {
    try {
      window.__agyCapsulePickerDispose();
    } catch {}
  }

  const STUDIO_DEFAULT_PREFS = __STUDIO_DEFAULT_PREFS__;
  const STUDIO_PREFS = __STUDIO_PREFS__;
  const INITIAL_STUDIO_PREFS =
    typeof ctx !== 'undefined' && ctx && ctx.studioPrefs && typeof ctx.studioPrefs === 'object'
      ? ctx.studioPrefs
      : STUDIO_PREFS;
  const STUDIO_LABELS = __STUDIO_LABELS__;
  const PICKER_SHADOW_CSS = __PICKER_SHADOW_CSS__;
  const CFG_MODS =
    (typeof ctx !== 'undefined' && ctx && (ctx.modules || (ctx.config && ctx.config.modules))) || {};

  const studioPrefs = createStudioPrefsRuntime({
    initialPrefs: INITIAL_STUDIO_PREFS,
    defaultPrefs: STUDIO_DEFAULT_PREFS,
    effortEffects,
    cfgMods: CFG_MODS,
  });

  const kernel = createMagaKernel();

  const picker = createCapsulePickerRuntime({
    prefs: STUDIO_PREFS,
    studioPrefs,
    labelsByLang: STUDIO_LABELS,
    shadowCss: PICKER_SHADOW_CSS,
    syncModelPicker,
    effortEffects,
    motionThemes,
    shortenModelName,
    shortenEffortBadge,
  });

  const footer = createFooterUnifiedRuntime({
    onTierChange: () => kernel.markDirty(['composer', 'subagent'], true),
    kernel,
  });

  const usage = createOverviewUsageRuntime({ motionThemes, studioPrefs });
  const projectUsage = createProjectUsageRuntime({ motionThemes, studioPrefs });
  const resumeBanner = createResumeBannerRuntime({ studioPrefs });
  const opusGatePill = createOpusGatePillRuntime({ studioPrefs });
  const scrollbarClamp = createScrollbarClampRuntime();
  const subagentFooter = createSubagentFooterRuntime({ motionThemes, shortenModelName, shortenEffortBadge, studioPrefs });
  const studioSettings = createStudioSettingsRuntime({
    studioPrefs,
    mountEffortBar,
    mountOrchestratorSwitch,
    motionThemes,
    shadowCss: PICKER_SHADOW_CSS,
    labelsByLang: STUDIO_LABELS,
  });

  const domFlags = createDomFlagsFeature();

  kernel.register({ id: 'dom-flags', ...domFlags });

  const customHooks = typeof window !== 'undefined' ? window.__agClaudeUxKernelHooks : null;
  let offCustomImmediate = null;
  if (customHooks && typeof customHooks.attachKernel === 'function') {
    customHooks.attachKernel(kernel);
    if (typeof customHooks.handleImmediateMutation === 'function') {
      offCustomImmediate = kernel.registerImmediateMutationHandler(customHooks.handleImmediateMutation);
    }
    kernel.register({
      id: 'custom-ux',
      topics: ['all'],
      write: (snapshot) => customHooks.syncByTopics(snapshot.topics),
      dispose: () => {
        offCustomImmediate?.();
        offCustomImmediate = null;
        customHooks.detachKernel?.();
      },
    });
  }

  kernel.register({ id: 'subagent-footer', ...subagentFooter });
  kernel.register({ id: 'resume-banner', ...resumeBanner });
  kernel.register({ id: 'opus-gate-pill', ...opusGatePill });
  kernel.register({ id: 'scrollbar-clamp', ...scrollbarClamp });
  kernel.register({
    id: 'capsule-picker',
    topics: picker.topics,
    read: picker.read,
    write: (snapshot, plan) => picker.write(snapshot, plan, () => kernel.markDirty('composer', true)),
    dispose: picker.dispose,
  });
  kernel.register({ id: 'footer-unified', ...footer });
  kernel.register({ id: 'overview-usage', ...usage });
  kernel.register({ id: 'project-usage', ...projectUsage });
  kernel.register({ id: 'studio-settings', ...studioSettings });

  const offPrefsSync = studioPrefs.subscribe((_, reason) => {
    if (reason === 'base-module' || reason === 'reset-all' || reason === 'import' || reason === 'daemon-hydrate') {
      kernel.markDirty(['all'], true);
    }
  });

  kernel.start();

  function dispose() {
    offPrefsSync?.();
    kernel.dispose();
    studioPrefs.dispose();
    if (typeof window !== 'undefined' && window.__agyStudioDispose === dispose) {
      window.__agyStudioDispose = null;
    }
  }

  if (typeof window !== 'undefined') {
    window.__agyStudioDispose = dispose;
  }
  if (typeof ctx !== 'undefined' && ctx && typeof ctx.onCleanup === 'function') {
    ctx.onCleanup(dispose);
  }
})();
