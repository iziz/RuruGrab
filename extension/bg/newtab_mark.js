'use strict';
(() => {
  const BG = self.UTH_BG;

  // When a YouTube video is opened in a new tab/window from an existing YouTube tab,
  // mark it watched immediately so the source tab can render the badge right away.
  // This covers cases where there is no click event (context-menu "open in new tab", etc.).

  const seenByTab = new Map(); // tabId -> { id, ts }
  const SEEN_TTL_MS = 60 * 1000;

  function remember(tabId, videoId) {
    seenByTab.set(tabId, { id: videoId, ts: Date.now() });
  }

  function alreadySeen(tabId, videoId) {
    const e = seenByTab.get(tabId);
    if (!e) return false;
    if (Date.now() - e.ts > SEEN_TTL_MS) {
      seenByTab.delete(tabId);
      return false;
    }
    return e.id === videoId;
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    seenByTab.delete(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url || tab?.pendingUrl || tab?.url;
    if (!url) return;

    const videoId = BG.extractVideoId(url);
    if (!videoId) return;

    const openerTabId = tab?.openerTabId;
    if (!openerTabId) return;

    if (alreadySeen(tabId, videoId)) return;
    remember(tabId, videoId);

    (async () => {
      // Restrict to: opened from a YouTube tab
      const openerTab = await new Promise((resolve) => {
        chrome.tabs.get(openerTabId, (t) => resolve(t || null));
      });

      const openerUrl = openerTab?.url || openerTab?.pendingUrl || '';
      if (!openerUrl.includes('youtube.com')) return;

      await BG.markWatched(videoId, Date.now());
    })().catch(() => {});
  });
})();
