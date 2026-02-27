'use strict';
(() => {
  const BG = self.UTH_BG;

  // -------------------- Browser history scan --------------------
  function historySearchAllYouTube({ maxResults = 100000 } = {}) {
    return new Promise((resolve) => {
      chrome.history.search(
        { text: 'youtube.com', startTime: 0, maxResults: Math.max(1000, Number(maxResults) || 100000) },
        (items) => resolve(items || [])
      );
    });
  }

  BG.importFromBrowserHistoryAll = async function importFromBrowserHistoryAll({ maxResults = 100000, includeShorts = true } = {}) {
    const items = await historySearchAllYouTube({ maxResults });
    const ids = new Set();

    for (const it of items) {
      const url = it?.url || '';
      if (!url) continue;
      if (!url.includes('youtube.com')) continue;

      if (!includeShorts && url.includes('/shorts/')) continue;

      const id = BG.extractVideoId(url);
      if (!id) continue;
      ids.add(id);
    }

    const list = Array.from(ids);
    const res = await BG.markWatchedManySkipExisting(list, Date.now());
    return { scannedUrls: items.length, ...res };
  };

  // -------------------- YouTube History Page Import --------------------
  BG.importFromYouTubeHistoryPage = async function importFromYouTubeHistoryPage() {
    const tabs = await new Promise((resolve) => {
      chrome.tabs.query({ url: '*://www.youtube.com/feed/history*' }, (t) => resolve(t || []));
    });

    let targetTab;

    if (tabs.length > 0) {
      targetTab = tabs[0];
      await new Promise((resolve) => {
        chrome.tabs.update(targetTab.id, { active: true }, () => resolve());
      });
      await new Promise((resolve) => {
        chrome.tabs.reload(targetTab.id, {}, () => resolve());
      });
    } else {
      targetTab = await new Promise((resolve) => {
        chrome.tabs.create({ url: 'https://www.youtube.com/feed/history', active: true }, (tab) => resolve(tab));
      });
    }

    // Wait content script readiness (max 15s)
    let contentReady = false;
    let attempts = 0;
    const maxAttempts = 30;

    while (!contentReady && attempts < maxAttempts) {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 500));

      try {
        const pong = await BG.tabsSendMessage(targetTab.id, { type: 'PING_CONTENT' });
        if (pong?.ok) contentReady = true;
      } catch {
        // keep waiting
      }
    }

    if (!contentReady) {
      throw new Error('Content script did not load in time. Please refresh the page and try again.');
    }

    const response = await BG.tabsSendMessage(targetTab.id, { type: 'AUTO_SCROLL_HISTORY' });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'Content script did not respond properly');
    }

    return {
      ok: true,
      collected: response.videoIds?.length || 0,
      inserted: response.inserted || 0,
      scrollCount: response.scrollCount || 0,
      cancelled: response.cancelled || false,
    };
  };

  // -------------------- Google Takeout JSON Import (#10) --------------------
  // Parses YouTube watch-history.json from Google Takeout.
  // Format: Array of { "titleUrl": "https://www.youtube.com/watch?v=...", "time": "2024-01-15T..." }
  BG.importFromTakeoutJson = async function importFromTakeoutJson(jsonText) {
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }

    // Support both raw array and { watched: [...] } (our own export format)
    const entries = Array.isArray(data) ? data
      : Array.isArray(data?.watched) ? data.watched
      : null;

    if (!entries) throw new Error('Unrecognized format: expected an array or { watched: [...] }');

    const ids = new Map(); // videoId → ts

    for (const entry of entries) {
      // Google Takeout format
      const url = entry?.titleUrl || entry?.url || '';
      // Our export format
      const directId = entry?.id || '';

      let videoId = null;

      if (directId && directId.length === 11) {
        videoId = directId;
      } else if (url) {
        videoId = BG.extractVideoId(url);
      }

      if (!videoId) continue;

      // Parse timestamp
      let ts = Date.now();
      const timeStr = entry?.time || entry?.ts;
      if (timeStr) {
        const parsed = typeof timeStr === 'number' ? timeStr : new Date(timeStr).getTime();
        if (Number.isFinite(parsed) && parsed > 0) ts = parsed;
      }

      // Keep the latest timestamp per videoId
      if (!ids.has(videoId) || ids.get(videoId) < ts) {
        ids.set(videoId, ts);
      }
    }

    if (!ids.size) {
      return { ok: true, parsed: entries.length, found: 0, inserted: 0 };
    }

    const videoIds = Array.from(ids.keys());
    const res = await BG.markWatchedManySkipExisting(videoIds, Date.now());
    await BG.broadcastRefreshWatched().catch(() => {});

    return {
      ok: true,
      parsed: entries.length,
      found: ids.size,
      inserted: res?.inserted || 0,
    };
  };
})();
