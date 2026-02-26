'use strict';
(() => {
  const CS = globalThis.UTH_CS;

  // videoId -> Set<HTMLElement(renderer)>
  const idToTargets = new Map();
  CS._idToTargets = idToTargets;

  let scanSeenContainers = new WeakSet();
  let scanQueued = false;

  // Retry when SW sleeps / transient errors
  const RETRY_MIN_MS = 800;
  const RETRY_MAX_MS = 15000;
  let retryBackoffMs = RETRY_MIN_MS;
  let retryTimer = null;
  const retryPendingIds = new Set();
  let lastSuccessfulApplyMs = 0;

  function unlinkTargetFromOldId(target, oldId) {
    if (!target || !oldId) return;
    const set = idToTargets.get(oldId);
    if (!set) return;
    set.delete(target);
    if (set.size === 0) idToTargets.delete(oldId);
  }

  function linkTargetToId(target, newId) {
    if (!target || !newId) return;
    let set = idToTargets.get(newId);
    if (!set) {
      set = new Set();
      idToTargets.set(newId, set);
    }
    set.add(target);
  }

  function getTargetBoundId(target) {
    return target?.dataset?.ytDlpVid || '';
  }

  function setTargetBoundId(target, id) {
    if (!target) return;
    target.dataset.ytDlpVid = id;
  }

  // visible-only marking (IntersectionObserver)
  const VISIBLE_ROOT_MARGIN = '900px 0px';
  const VISIBLE_PX_MARGIN = 900;

  const STATUS_TTL_MS = 5 * 60 * 1000;
  const STATUS_CACHE_MAX = 6000;

  const visibleRenderers = new Set();
  const pendingRenderers = new Set();
  let pendingQueued = false;

  const statusCache = new Map();
  const ioObserved = new WeakSet();

  CS.visibleRenderers = visibleRenderers;
  CS.pendingRenderers = pendingRenderers;

  function getCachedStatus(videoId) {
    if (!videoId) return null;
    const e = statusCache.get(videoId);
    if (!e) return null;
    if (Date.now() - e.ts > STATUS_TTL_MS) {
      statusCache.delete(videoId);
      return null;
    }
    return !!e.watched;
  }

  function setCachedStatus(videoId, watched) {
    if (!videoId) return;
    statusCache.set(videoId, { watched: !!watched, ts: Date.now() });

    if (statusCache.size <= STATUS_CACHE_MAX) return;

    const entries = Array.from(statusCache.entries());
    entries.sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
    const removeCount = Math.max(1, Math.ceil(STATUS_CACHE_MAX * 0.1));
    for (let i = 0; i < removeCount && i < entries.length; i++) {
      statusCache.delete(entries[i][0]);
    }
  }

  CS.setCachedStatus = setCachedStatus;

  function isElementInViewportWithMargin(el, marginPx) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect?.();
    if (!r) return false;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;

    return (
      r.bottom >= -marginPx &&
      r.right >= -marginPx &&
      r.top <= vh + marginPx &&
      r.left <= vw + marginPx
    );
  }

  function isRendererVisibleEnough(renderer) {
    if (!(renderer instanceof Element)) return false;
    if (visibleRenderers.has(renderer)) return true;
    return isElementInViewportWithMargin(renderer, VISIBLE_PX_MARGIN);
  }

  CS.isRendererVisibleEnough = isRendererVisibleEnough;

  let io = null;
  try {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const r = e.target;
        if (!(r instanceof Element)) continue;

        if (e.isIntersecting) {
          visibleRenderers.add(r);
          pendingRenderers.add(r);
          queueProcessPending();
        } else {
          visibleRenderers.delete(r);
          pendingRenderers.delete(r);

          const oldId = getTargetBoundId(r);
          if (oldId) unlinkTargetFromOldId(r, oldId);
          setTargetBoundId(r, '');
          CS.applyWatched(r, false);
        }
      }
    }, { root: null, rootMargin: VISIBLE_ROOT_MARGIN, threshold: 0.01 });
  } catch {
    io = null;
  }

  CS.io = io;

  function observeRenderer(renderer) {
    if (!io || !(renderer instanceof Element)) return;
    if (ioObserved.has(renderer)) return;
    ioObserved.add(renderer);
    try { io.observe(renderer); } catch {}
  }

  function unobserveRenderer(renderer) {
    if (!io || !(renderer instanceof Element)) return;
    try { io.unobserve(renderer); } catch {}
    // You must clean up ioObserved to enable re-observation when reusing the YouTube DOM.
    ioObserved.delete(renderer);

    visibleRenderers.delete(renderer);
    pendingRenderers.delete(renderer);

    const oldId = getTargetBoundId(renderer);
    if (oldId) unlinkTargetFromOldId(renderer, oldId);
    setTargetBoundId(renderer, '');
    CS.applyWatched(renderer, false);
  }

  function observeRendererTree(node) {
    if (!io) return;
    if (!(node instanceof Element)) return;

    if (node.matches?.(CS.VIDEO_RENDERER_SELECTOR)) observeRenderer(node);
    node.querySelectorAll?.(CS.VIDEO_RENDERER_SELECTOR)?.forEach((r) => observeRenderer(r));
  }

  function unobserveRendererTree(node) {
    if (!io) return;
    if (!(node instanceof Element)) return;

    if (node.matches?.(CS.VIDEO_RENDERER_SELECTOR)) unobserveRenderer(node);
    node.querySelectorAll?.(CS.VIDEO_RENDERER_SELECTOR)?.forEach((r) => unobserveRenderer(r));
  }

  CS.observeRendererTree = observeRendererTree;
  CS.unobserveRendererTree = unobserveRendererTree;
  CS.observeRenderer = observeRenderer;

  function extractIdFromRenderer(renderer) {
    if (!(renderer instanceof Element)) return null;

    const a =
      renderer.querySelector('a#thumbnail[href], a.yt-lockup-view-model-wiz__content-image[href], a.reel-item-endpoint[href]') ||
      renderer.querySelector('a[href*="watch?v="][href], a[href^="/shorts/"][href], a[href*="/shorts/"][href], a[href*="/embed/"][href]');

    const href = a?.getAttribute?.('href') || '';
    return CS.getYouTubeVideoIdFromUrl(href);
  }

  CS.extractIdFromRenderer = extractIdFromRenderer;

  function queueProcessPending() {
    if (!io) return;
    if (pendingQueued) return;
    pendingQueued = true;

    let fired = false;
    const run = () => {
      if (fired) return;
      fired = true;
      pendingQueued = false;
      processPendingVisible().catch(() => {});
    };

    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 300 });
    setTimeout(run, 120);
  }

  CS.queueProcessPending = queueProcessPending;

  async function processPendingVisible() {
    if (!io) return;
    if (!pendingRenderers.size) return;

    const idsToQuery = new Set();

    for (const r of Array.from(pendingRenderers)) {
      pendingRenderers.delete(r);
      if (!(r instanceof Element) || !r.isConnected) continue;
      if (!isRendererVisibleEnough(r)) continue;

      const id = extractIdFromRenderer(r);
      if (!id) continue;

      const prevId = getTargetBoundId(r);
      if (prevId && prevId !== id) {
        unlinkTargetFromOldId(r, prevId);
        CS.applyWatched(r, false);
      }

      setTargetBoundId(r, id);
      linkTargetToId(r, id);

      const cached = getCachedStatus(id);
      if (cached !== null) {
        CS.applyWatched(r, cached);
      } else {
        idsToQuery.add(id);
      }
    }

    if (idsToQuery.size) {
      await applyBatchStatus(Array.from(idsToQuery));
    }
  }

  CS.processPendingVisible = processPendingVisible;

  async function refreshVisibleOnly() {
    if (!io) {
      CS.queueScan();
      return;
    }

    await processPendingVisible();

    const idsToQuery = new Set();

    for (const r of Array.from(visibleRenderers)) {
      if (!(r instanceof Element) || !r.isConnected) {
        visibleRenderers.delete(r);
        continue;
      }

      let id = getTargetBoundId(r);
      if (!id) {
        id = extractIdFromRenderer(r);
        if (!id) continue;
        setTargetBoundId(r, id);
        linkTargetToId(r, id);
      }

      const cached = getCachedStatus(id);
      if (cached !== null) {
        CS.applyWatched(r, cached);
      } else {
        idsToQuery.add(id);
      }
    }

    if (idsToQuery.size) await applyBatchStatus(Array.from(idsToQuery));
  }

  CS.refreshVisibleOnly = refreshVisibleOnly;

  CS.refreshAllKnown = async function refreshAllKnown() {
    await refreshVisibleOnly();
  };

  CS.indexSpecificVideoId = function indexSpecificVideoId(videoId, watched) {
    if (!videoId) return false;

    const safe = CSS.escape(videoId);
    const selectors = [
      `a#video-title[href*="watch?v=${safe}"]`,
      `a#video-title-link[href*="watch?v=${safe}"]`,
      `a#thumbnail[href*="watch?v=${safe}"]`,
      `a[href*="watch?v=${safe}"]`,
      `a[href*="/shorts/${safe}"]`,
      `a[href^="/shorts/${safe}"]`,
      `a[href*="/embed/${safe}"]`
    ];

    const anchors = document.querySelectorAll(selectors.join(','));
    if (!anchors.length) return false;

    let any = false;
    for (const a of anchors) {
      if (!(a instanceof Element)) continue;

      const renderer = CS.getTargetContainer(a);
      if (!renderer) continue;
      if (io && !isRendererVisibleEnough(renderer)) continue;

      observeRenderer(renderer);

      const prevId = getTargetBoundId(renderer);
      if (prevId && prevId !== videoId) {
        unlinkTargetFromOldId(renderer, prevId);
        CS.applyWatched(renderer, false);
      }

      setTargetBoundId(renderer, videoId);
      linkTargetToId(renderer, videoId);
      CS.applyWatched(renderer, !!watched);
      any = true;
    }

    return any;
  };

  async function indexAndCheck(rootNode) {
    const anchors = (rootNode instanceof Element || rootNode instanceof Document)
      ? rootNode.querySelectorAll('a[href*="watch?v="], a[href^="/shorts/"], a[href*="/shorts/"]')
      : [];

    const batchIds = new Set();
    scanSeenContainers = new WeakSet();

    for (const a of anchors) {
      if (!(a instanceof HTMLAnchorElement)) continue;

      const href = a.getAttribute('href') || '';
      const id = CS.getYouTubeVideoIdFromUrl(href);
      if (!id) continue;

      const renderer = CS.getTargetContainer(a);
      if (!renderer) continue;
      if (io && !isRendererVisibleEnough(renderer)) continue;

      if (scanSeenContainers.has(renderer)) continue;
      scanSeenContainers.add(renderer);

      const prevId = getTargetBoundId(renderer);
      if (prevId && prevId !== id) {
        unlinkTargetFromOldId(renderer, prevId);
        CS.applyWatched(renderer, false);
      }

      setTargetBoundId(renderer, id);
      linkTargetToId(renderer, id);
      batchIds.add(id);
    }

    if (!batchIds.size) return;
    await applyBatchStatus(Array.from(batchIds));
  }

  CS.indexAndCheck = indexAndCheck;

  // legacy scan queue (only when IO is unavailable)
  CS.queueScan = function queueScan() {
    if (io) {
      queueProcessPending();
      return;
    }

    if (scanQueued) return;
    scanQueued = true;

    let fired = false;
    const doScan = () => {
      if (fired) return;
      fired = true;
      scanQueued = false;
      try { indexAndCheck(document); } catch {}
    };

    if ('requestIdleCallback' in window) {
      requestIdleCallback(doScan, { timeout: 900 });
    }
    setTimeout(doScan, 1200);
  };

  // batch status fetch + retry
  async function applyBatchStatus(videoIds) {
    if (!videoIds || !videoIds.length) return;

    // Wake SW lightly
    CS.sendRuntimeMessage({ type: 'PING_BG' }).catch(() => {});

    try {
      await applyBatchStatusCore(videoIds);
      lastSuccessfulApplyMs = Date.now();
      retryBackoffMs = RETRY_MIN_MS;
      for (const id of videoIds) retryPendingIds.delete(id);
    } catch {
      scheduleRetryApply(videoIds);
    }
  }

  function scheduleRetryApply(videoIds) {
    for (const id of (videoIds || [])) {
      if (id) retryPendingIds.add(id);
    }
    if (retryTimer) return;
    retryTimer = setTimeout(runRetryApply, retryBackoffMs);
  }

  async function runRetryApply() {
    retryTimer = null;

    const ids = Array.from(retryPendingIds);
    retryPendingIds.clear();
    if (!ids.length) return;

    try {
      await applyBatchStatusCore(ids);
      lastSuccessfulApplyMs = Date.now();
      retryBackoffMs = RETRY_MIN_MS;
    } catch {
      for (const id of ids) retryPendingIds.add(id);
      retryBackoffMs = Math.min(Math.max(RETRY_MIN_MS, retryBackoffMs * 2), RETRY_MAX_MS);
      scheduleRetryApply([]);
    }
  }

  async function applyBatchStatusCore(videoIds) {
    const resp = await CS.sendRuntimeMessage({ type: 'CHECK_WATCHED_BATCH', videoIds });
    if (!resp?.ok) throw new Error(resp?.error || 'CHECK_WATCHED_BATCH failed');

    const map = resp.data || {};
    for (const [id, isWatched] of Object.entries(map)) {
      setCachedStatus(id, !!isWatched);

      const targets = idToTargets.get(id);
      if (!targets) continue;

      for (const t of Array.from(targets)) {
        if (!t || !t.isConnected) {
          targets.delete(t);
          continue;
        }

        const bound = getTargetBoundId(t);
        if (bound && bound !== id) {
          targets.delete(t);
          continue;
        }

        CS.applyWatched(t, !!isWatched);
      }

      if (targets.size === 0) idToTargets.delete(id);
    }
  }

  // Expose internals needed by hooks
  CS._engine = {
    getTargetBoundId,
    setTargetBoundId,
    linkTargetToId,
    unlinkTargetFromOldId,
    statusCache,
    lastSuccessfulApplyMsRef: () => lastSuccessfulApplyMs,
    scheduleRetryApply,
    forceRetryLargeBatch: () => scheduleRetryApply(Array.from(idToTargets.keys()).slice(0, 2500))
  };

  // small helper used by click-fallback 
  CS.forceScanSoon = function forceScanSoon() {
    setTimeout(() => {
      try {
        observeRendererTree(document.documentElement);
        queueProcessPending();
        refreshVisibleOnly().catch(() => {});
      } catch {}
    }, 180);
  };

  // self-heal tick (invoked by hooks) 
  CS.selfHealTick = function selfHealTick() {
    try {
      if (document.visibilityState !== 'visible') return;

      CS.queueScan();
      if (io ? visibleRenderers.size : idToTargets.size) CS.refreshAllKnown().catch(() => {});

      if (Date.now() - lastSuccessfulApplyMs > 30000 && (io ? visibleRenderers.size : idToTargets.size) && idToTargets.size) {
        CS._engine.forceRetryLargeBatch();
        CS.forceScanSoon();
      }
    } catch {}
  };
})();
