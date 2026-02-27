'use strict';
(() => {
  const BG = self.UTH_BG;

  // LRU-ish cache for hot ids
  const watchedCache = new Map(); // id -> true

  BG.cacheWatched = function cacheWatched(id) {
    if (!id) return;
    if (watchedCache.has(id)) watchedCache.delete(id);
    watchedCache.set(id, true);
    if (watchedCache.size > BG.WATCHED_CACHE_MAX) {
      const firstKey = watchedCache.keys().next().value;
      watchedCache.delete(firstKey);
    }
  };

  BG.uncacheWatched = function uncacheWatched(id) {
    watchedCache.delete(id);
  };

  BG.checkWatchedBatch = async function checkWatchedBatch(videoIds) {
    const ids = Array.from(new Set((videoIds || []).filter(Boolean)));
    const result = Object.create(null);

    const unknown = [];
    for (const id of ids) {
      if (watchedCache.has(id)) result[id] = true;
      else unknown.push(id);
    }

    if (unknown.length) {
      const dbResult = await YT_DLP_DB.hasMany(unknown);
      for (const [id, isWatched] of Object.entries(dbResult)) {
        result[id] = !!isWatched;
        if (isWatched) BG.cacheWatched(id);
      }
    }

    return result;
  };

  BG.broadcastWatchChanged = async function broadcastWatchChanged(videoId, watched) {
    if (!videoId) return;
    const tabs = await BG.queryYouTubeTabs();
    for (const t of tabs) {
      if (!t?.id) continue;
      BG.safeTabsSendMessage(t.id, { type: 'WATCH_STATUS_CHANGED', videoId, watched: !!watched });
    }
  };

  BG.broadcastRefreshWatched = async function broadcastRefreshWatched() {
    const tabs = await BG.queryYouTubeTabs();
    for (const t of tabs) {
      if (!t?.id) continue;
      BG.safeTabsSendMessage(t.id, { type: 'REFRESH_WATCHED' });
    }
  };

  BG.markWatched = async function markWatched(videoId, ts = Date.now()) {
    if (!videoId) return;
    await YT_DLP_DB.putMany([{ id: videoId, ts }], { chunkSize: 1500 });
    await YT_DLP_DB.appendChange(videoId, 'watch', ts);      // ← NEW: changelog
    BG.cacheWatched(videoId);
    BG.broadcastWatchChanged(videoId, true).catch(() => {});
  };

  BG.markWatchedManySkipExisting = async function markWatchedManySkipExisting(videoIds, ts = Date.now()) {
    const ids = Array.from(new Set((videoIds || []).filter(Boolean)));
    if (!ids.length) return { found: 0, inserted: 0 };

    let inserted = 0;
    const CHUNK = 2500;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const existsMap = await YT_DLP_DB.hasMany(chunk);
      const toInsert = chunk.filter((id) => !existsMap[id]);
      if (toInsert.length) {
        const records = toInsert.map((id) => ({ id, ts }));
        const res = await YT_DLP_DB.putMany(records, { chunkSize: 2000 });
        inserted += (res?.inserted || 0);
        // Changelog: batch-record all new watches (#1 — was individual, now batched)
        await YT_DLP_DB.appendChangeBatch(
          toInsert.map((id) => ({ id, action: 'watch', ts }))
        );
        for (const id of toInsert) BG.cacheWatched(id);
      }
    }

    return { found: ids.length, inserted };
  };

  BG.unmarkWatched = async function unmarkWatched(videoId) {
    if (!videoId) return;
    const ts = Date.now();
    await YT_DLP_DB.delMany([videoId]);
    await YT_DLP_DB.appendChange(videoId, 'unwatch', ts);    // ← NEW: changelog
    BG.uncacheWatched(videoId);
    BG.broadcastWatchChanged(videoId, false).catch(() => {});
  };
})();
