'use strict';
(() => {
  const CS = globalThis.UTH_CS;

  let historySyncQueued = false;
  const historySyncedIds = new Set();

  CS.queueHistorySync = function queueHistorySync(rootNode = document) {
    if (!CS.isHistoryPage()) return;
    if (historySyncQueued) return;
    historySyncQueued = true;

    const run = () => {
      historySyncQueued = false;
      scanHistoryPageAndPersist(rootNode).catch(() => {});
    };

    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 120);
  };

  async function scanHistoryPageAndPersist(rootNode) {
    if (!CS.isHistoryPage()) return;

    const anchors = (rootNode instanceof Element || rootNode instanceof Document)
      ? rootNode.querySelectorAll('a#video-title[href*="watch?v="], a#thumbnail[href*="watch?v="], a[href*="watch?v="]')
      : [];

    const ids = new Set();
    for (const a of anchors) {
      if (!(a instanceof HTMLAnchorElement)) continue;
      const href = a.getAttribute('href') || '';
      const id = CS.getYouTubeVideoIdFromUrl(href);
      if (!id) continue;
      if (historySyncedIds.has(id)) continue;
      ids.add(id);
    }

    if (!ids.size) return;

    const list = Array.from(ids);
    const resp = await CS.sendRuntimeMessage({ type: 'MARK_WATCHED_MANY_SKIP', videoIds: list, ts: Date.now() });
    if (resp?.ok) {
      for (const id of list) historySyncedIds.add(id);
      CS.refreshVisibleOnly?.().catch(() => {});
    }
  }

  // -------------------- full history import (auto-scroll) --------------------
  // Used by background.js (IMPORT_FROM_YOUTUBE_HISTORY_PAGE)

  let _autoScrollAborted = false;

  CS.cancelAutoScroll = function cancelAutoScroll() {
    _autoScrollAborted = true;
  };

  CS.autoScrollAndCollectHistory = async function autoScrollAndCollectHistory({ maxScrolls = 1200 } = {}) {
    if (!CS.isHistoryPage()) {
      return { ok: false, error: 'Not on /feed/history' };
    }

    _autoScrollAborted = false;

    const seen = new Set();
    let lastHeight = 0;
    let stagnant = 0;
    let scrollCount = 0;

    const collectVisibleIds = () => {
      const anchors = document.querySelectorAll('a[href*="watch?v="]');
      for (const a of anchors) {
        if (!(a instanceof HTMLAnchorElement)) continue;
        const id = CS.getYouTubeVideoIdFromUrl(a.getAttribute('href') || '');
        if (id) seen.add(id);
      }
    };

    collectVisibleIds();

    for (let i = 0; i < maxScrolls; i++) {
      // Check cancellation (#7)
      if (_autoScrollAborted) {
        const videoIds = Array.from(seen);
        const resp = await CS.sendRuntimeMessage({ type: 'MARK_WATCHED_MANY_SKIP', videoIds, ts: Date.now() }).catch(() => null);
        return {
          ok: true,
          videoIds,
          inserted: resp?.inserted || 0,
          scrollCount,
          cancelled: true,
        };
      }

      window.scrollTo(0, document.documentElement.scrollHeight);
      scrollCount++;

      await new Promise((r) => setTimeout(r, 350));
      collectVisibleIds();

      const h = document.documentElement.scrollHeight;
      if (h <= lastHeight + 10) stagnant++;
      else stagnant = 0;
      lastHeight = h;

      if (stagnant >= 10) break; // likely end
    }

    const videoIds = Array.from(seen);
    const resp = await CS.sendRuntimeMessage({ type: 'MARK_WATCHED_MANY_SKIP', videoIds, ts: Date.now() }).catch(() => null);

    return {
      ok: true,
      videoIds,
      inserted: resp?.inserted || 0,
      scrollCount,
      cancelled: false,
    };
  };
})();
