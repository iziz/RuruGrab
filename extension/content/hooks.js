'use strict';
(() => {
  const CS = globalThis.UTH_CS;

  function markCurrentAsWatched() {
    const id = CS.getYouTubeVideoIdFromUrl(location.href);
    if (!id) return;
    CS.sendRuntimeMessage({ type: 'MARK_WATCHED', videoId: id, ts: Date.now() }).catch(() => {});
  }

  function setupEarlyMarkOnClick() {
    const findAnchorFromEvent = (ev) => {
      // YouTube frequently uses shadow DOM; closest() won't cross it.
      const path = (typeof ev.composedPath === 'function') ? ev.composedPath() : [];
      for (const n of path) {
        if (n instanceof HTMLAnchorElement && n.href) return n;
      }
      const a = ev.target?.closest?.('a[href]');
      return a || null;
    };

    const handler = (ev) => {
      try {
        const a = findAnchorFromEvent(ev);
        if (!a) return;
        const id = CS.getYouTubeVideoIdFromUrl(a.href);
        if (!id) return;

        const isNewTab =
          (ev.type === 'auxclick' && ev.button === 1) ||
          (ev.type === 'click' && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) ||
          (a.target && String(a.target).toLowerCase() === '_blank');

        if (!isNewTab) return;

        let ok = false;

        const renderer = CS.getTargetContainer(a);
        if (renderer && (!CS.io || CS.isRendererVisibleEnough(renderer))) {
          CS.observeRenderer?.(renderer);
          if (CS.io) CS.visibleRenderers.add(renderer);

          const prevId = CS._engine.getTargetBoundId(renderer);
          if (prevId && prevId !== id) {
            CS._engine.unlinkTargetFromOldId(renderer, prevId);
            CS.applyWatched(renderer, false);
          }

          CS._engine.setTargetBoundId(renderer, id);
          CS._engine.linkTargetToId(renderer, id);

          CS.setCachedStatus(id, true);
          CS.applyWatched(renderer, true);
          ok = true;
        } else {
          ok = CS.indexSpecificVideoId(id, true);
        }

        if (!ok) CS.forceScanSoon();

        // Persist in background and let broadcast update other tabs.
        CS.sendRuntimeMessage({ type: 'MARK_WATCHED', videoId: id, ts: Date.now() })
          .then((resp) => {
            if (!resp?.ok) throw new Error(resp?.error || 'not ok');
          })
          .catch(() => {
            CS.setCachedStatus(id, false);
            const targets = CS._idToTargets.get(id);
            if (targets) {
              for (const t of Array.from(targets)) {
                if (t?.isConnected) CS.applyWatched(t, false);
              }
            }
          });

        setTimeout(() => {
          try {
            const cached = CS._engine.statusCache.get(id);
            const isWatched = cached ? !!cached.watched : false;
            CS.indexSpecificVideoId(id, isWatched);
          } catch {}
          CS.refreshVisibleOnly?.().catch(() => {});
        }, 100);
      } catch {}
    };

    document.addEventListener('auxclick', handler, true);
    document.addEventListener('click', handler, true);
  }

  function setupMutationObserver() {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'href') {
          const el = m.target;
          if (el instanceof Element) {
            const r = CS.findVideoRenderer(el);
            if (r) {
              CS.observeRenderer?.(r);
              if (CS.isRendererVisibleEnough(r)) {
                CS.pendingRenderers.add(r);
                CS.queueProcessPending();
              }
            }
          }
          continue;
        }

        if (m.type !== 'childList') continue;

        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          CS.observeRendererTree(node);
          if (CS.isHistoryPage()) CS.queueHistorySync(node);
        }

        for (const node of m.removedNodes) {
          if (!(node instanceof Element)) continue;
          CS.unobserveRendererTree(node);
        }
      }
    });

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });
  }

  function setupSpaNavigationHook() {
    window.addEventListener('yt-navigate-finish', () => {
      CS.observeRendererTree(document.documentElement);
      CS.queueProcessPending();
      setTimeout(() => { CS.refreshVisibleOnly?.().catch(() => {}); }, 250);

      markCurrentAsWatched();

      if (CS.isHistoryPage()) CS.queueHistorySync(document);
    }, true);
  }

  function setupSelfHeal() {
    setInterval(() => CS.selfHealTick?.(), 20000);

    const kick = () => {
      try {
        CS.queueScan?.();
        CS.refreshAllKnown?.().catch(() => {});
      } catch {}
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    }, true);

    window.addEventListener('focus', kick, true);
    window.addEventListener('pageshow', kick, true);
  }

  function setupRuntimeMessageListener() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'PING_CONTENT') {
        sendResponse({ ok: true });
        return true;
      }

      if (msg?.type === 'AUTO_SCROLL_HISTORY') {
        CS.autoScrollAndCollectHistory({}).then(sendResponse).catch((e) => {
          sendResponse({ ok: false, error: String(e?.message || e) });
        });
        return true;
      }

      if (msg?.type === 'WATCH_STATUS_CHANGED' && msg.videoId) {
        CS.setCachedStatus(msg.videoId, !!msg.watched);

        const targets = CS._idToTargets.get(msg.videoId);
        if (targets && targets.size) {
          for (const t of Array.from(targets)) {
            if (!t || !t.isConnected) { targets.delete(t); continue; }
            const bound = CS._engine.getTargetBoundId(t);
            if (bound && bound !== msg.videoId) { targets.delete(t); continue; }
            CS.applyWatched(t, !!msg.watched);
          }
          if (targets.size === 0) CS._idToTargets.delete(msg.videoId);
          return;
        }

        if (CS.io && CS.visibleRenderers.size) {
          for (const r of Array.from(CS.visibleRenderers)) {
            if (!(r instanceof Element) || !r.isConnected) continue;
            const id = CS._engine.getTargetBoundId(r) || CS.extractIdFromRenderer(r);
            if (!id || id !== msg.videoId) continue;

            CS.observeRenderer?.(r);
            CS._engine.setTargetBoundId(r, id);
            CS._engine.linkTargetToId(r, id);
            CS.applyWatched(r, !!msg.watched);
            return;
          }
        }

        const ok = CS.indexSpecificVideoId(msg.videoId, !!msg.watched);
        if (!ok) CS.forceScanSoon();
        return;
      }

      if (msg?.type === 'REFRESH_WATCHED') {
        CS.queueScan?.();
        CS.refreshAllKnown?.().catch(() => {});
        return;
      }

      return false;
    });
  }

  // init (called from main.js)
  CS.initHooks = function initHooks() {
    setupMutationObserver();
    setupSpaNavigationHook();
    setupEarlyMarkOnClick();
    setupSelfHeal();
    setupRuntimeMessageListener();

    CS.observeRendererTree(document.documentElement);
    CS.queueScan();
    CS.refreshVisibleOnly?.().catch(() => {});
    markCurrentAsWatched();

    if (CS.isHistoryPage()) CS.queueHistorySync(document);
  };
})();
