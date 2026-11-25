/**
 * Conversation Overlay Scrollbar Track Clamp
 *
 * Clamps native `[data-testid="overlay-scrollbar-thumb"]` dimensions, translation,
 * and `ScrollTimeline` keyframes against the CSS-bounded track height so the
 * scrollbar thumb never overshoots its padded track bounds or leaves the viewport.
 * Runs under `MagaKernel` without spawning any extra MutationObserver.
 */

const TRANSLATE_Y_RE = /translate\(\s*0(?:px)?\s*,\s*(-?[\d.]+)px\s*\)/;

/**
 * Clamp a single vertical overlay scrollbar thumb and its active ScrollTimeline
 * keyframes within the actual rendered bounds of `track`.
 */
export function clampOverlayScrollbar(track, viewport, metrics = null) {
  const thumb = track?.querySelector?.('[data-testid="overlay-scrollbar-thumb"]');
  if (!thumb) return false;

  let trackH;
  if (metrics && Number.isFinite(metrics.trackH)) {
    trackH = metrics.trackH;
  } else {
    const rectH = typeof track.getBoundingClientRect === 'function' ? track.getBoundingClientRect().height : 0;
    trackH = Math.floor(track.clientHeight || rectH || 0);
  }
  if (trackH <= 0) return false;

  const ch = metrics && Number.isFinite(metrics.ch) ? metrics.ch : Number(viewport?.clientHeight) || 0;
  const sh = metrics && Number.isFinite(metrics.sh) ? metrics.sh : Number(viewport?.scrollHeight) || 0;
  const st = metrics && Number.isFinite(metrics.st) ? metrics.st : Number(viewport?.scrollTop) || 0;
  const scrollable = ch > 0 && sh > ch + 1;
  const minThumb = Math.min(28, trackH);

  let thumbH;
  if (scrollable) {
    thumbH = Math.min(trackH, Math.max(minThumb, Math.round((ch / sh) * trackH)));
  } else {
    const parsedH = Number.parseFloat(thumb.style?.height || '');
    thumbH = Number.isFinite(parsedH) && parsedH > 0 ? Math.min(trackH, Math.max(minThumb, Math.round(parsedH))) : trackH;
  }

  const maxOffset = Math.max(0, trackH - thumbH);
  const maxScroll = Math.max(1, sh - ch);
  const ratio = scrollable ? Math.min(1, Math.max(0, st / maxScroll)) : 0;
  const clampedY = Math.round(ratio * maxOffset);

  const nextHeight = `${thumbH}px`;
  const nextTransform = `translate(0px, ${clampedY}px)`;
  if (thumb.style.height !== nextHeight) thumb.style.height = nextHeight;
  if (thumb.style.transform !== nextTransform) thumb.style.transform = nextTransform;

  const anims = typeof thumb.getAnimations === 'function' ? thumb.getAnimations() : null;
  if (Array.isArray(anims) && anims.length > 0) {
    for (let i = 0; i < anims.length; i += 1) {
      const eff = anims[i]?.effect;
      if (!eff || typeof eff.getKeyframes !== 'function' || typeof eff.setKeyframes !== 'function') continue;
      const kfs = eff.getKeyframes();
      if (!Array.isArray(kfs) || kfs.length < 2) continue;
      const lastTf = String(kfs[kfs.length - 1]?.transform || '');
      const m = lastTf.match(TRANSLATE_Y_RE);
      if (!m) continue;
      const curMax = Number.parseFloat(m[1]);
      if (!Number.isFinite(curMax) || Math.abs(curMax - maxOffset) > 0.5) {
        eff.setKeyframes([
          { transform: 'translate(0px, 0px)' },
          { transform: `translate(0px, ${maxOffset}px)` },
        ]);
      }
    }
  }

  return true;
}

/**
 * Create the MagaKernel feature controller that keeps overlay scrollbars clamped
 * across scroll, pointer hover/drag, resize, and panel transitions.
 */
export function createScrollbarClampRuntime() {
  let disposed = false;
  let resizeBound = false;
  const bound = new Map();

  function scheduleClamp(track) {
    const entry = bound.get(track);
    if (!entry || entry.scheduled || disposed) return;
    entry.scheduled = true;
    const run = () => {
      entry.scheduled = false;
      entry.rafId = null;
      if (disposed || !track.isConnected || bound.get(track) !== entry) return;
      clampOverlayScrollbar(track, entry.viewport);
    };
    const rafFn =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame.bind(window)
          : null;
    if (rafFn) {
      entry.rafId = rafFn(run);
    } else if (typeof queueMicrotask === 'function') {
      queueMicrotask(run);
    } else {
      Promise.resolve().then(run);
    }
  }

  function onWindowResize() {
    if (disposed) return;
    for (const [track] of bound) {
      if (track.isConnected) scheduleClamp(track);
    }
  }

  function ensureResizeBound() {
    if (resizeBound || disposed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('resize', onWindowResize, { passive: true });
    resizeBound = true;
  }

  function unbindTrack(track) {
    const entry = bound.get(track);
    if (!entry) return;
    if (entry.rafId !== null && entry.rafId !== undefined) {
      const cancelRaf =
        typeof cancelAnimationFrame === 'function'
          ? cancelAnimationFrame
          : typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
            ? window.cancelAnimationFrame.bind(window)
            : null;
      if (cancelRaf) cancelRaf(entry.rafId);
    }
    entry.rafId = null;
    entry.scheduled = false;
    entry.cleanup();
    bound.delete(track);
  }

  function bindPair(track, viewport) {
    if (!track || !viewport || disposed) return;
    const prev = bound.get(track);
    if (prev) {
      if (prev.viewport === viewport) return;
      unbindTrack(track);
    }
    const onEvent = () => scheduleClamp(track);
    const trackEvents = ['pointerenter', 'pointerdown', 'pointermove'];
    const vpEvents = ['scroll', 'pointerenter'];
    for (const ev of trackEvents) track.addEventListener?.(ev, onEvent, { passive: true });
    for (const ev of vpEvents) viewport.addEventListener?.(ev, onEvent, { passive: true });
    const cleanup = () => {
      for (const ev of trackEvents) track.removeEventListener?.(ev, onEvent);
      for (const ev of vpEvents) viewport.removeEventListener?.(ev, onEvent);
    };
    bound.set(track, { viewport, scheduled: false, rafId: null, cleanup });
    ensureResizeBound();
  }

  function read() {
    if (disposed || typeof document === 'undefined') return [];
    const tracks =
      document.querySelectorAll?.(
        '[data-autoscroll-overlay-host] > [data-testid="overlay-scrollbar"][data-orientation="vertical"]'
      ) || [];
    const pairs = [];
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      const viewport = track?.parentElement?.querySelector?.('[data-testid="autoscroll-viewport"]') || null;
      if (!track || !viewport) continue;
      const rectH = typeof track.getBoundingClientRect === 'function' ? track.getBoundingClientRect().height : 0;
      const trackH = Math.floor(track.clientHeight || rectH || 0);
      const ch = Number(viewport.clientHeight) || 0;
      const sh = Number(viewport.scrollHeight) || 0;
      const st = Number(viewport.scrollTop) || 0;
      pairs.push({ track, viewport, trackH, ch, sh, st });
    }
    return pairs;
  }

  function write(_snapshot, pairs = read()) {
    if (disposed) return;
    const activeSet = new Set();
    if (Array.isArray(pairs)) {
      for (let i = 0; i < pairs.length; i += 1) {
        const entry = pairs[i];
        const { track, viewport } = entry || {};
        if (!track || !viewport) continue;
        activeSet.add(track);
        bindPair(track, viewport);
        const metrics =
          Number.isFinite(entry.trackH) &&
          Number.isFinite(entry.ch) &&
          Number.isFinite(entry.sh) &&
          Number.isFinite(entry.st)
            ? { trackH: entry.trackH, ch: entry.ch, sh: entry.sh, st: entry.st }
            : null;
        clampOverlayScrollbar(track, viewport, metrics);
      }
    }
    for (const [track] of bound) {
      if (!activeSet.has(track) || !track.isConnected) unbindTrack(track);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [track] of Array.from(bound)) unbindTrack(track);
    bound.clear();
    if (resizeBound && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWindowResize);
    }
    resizeBound = false;
  }

  return {
    topics: ['stream', 'composer', 'overview', 'subagent', 'route', 'all'],
    read,
    write,
    sync: (snapshot) => write(snapshot, read()),
    dispose,
  };
}
