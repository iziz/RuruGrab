/* db.js - IndexedDB helper (Extension pages + MV3 service worker) */
'use strict';

const YT_DLP_DB = (() => {
  const DB_NAME = 'yt_dlp_ctx';
  const DB_VERSION = 2; // bumped from 1 → 2 for changelog store
  const STORE_WATCHED = 'watched';
  const STORE_CHANGELOG = 'changelog'; // NEW

  let _dbPromise = null;

  function _reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function _txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
    });
  }

  function open() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;

        // v1: watched store
        if (!db.objectStoreNames.contains(STORE_WATCHED)) {
          db.createObjectStore(STORE_WATCHED, { keyPath: 'id' });
        }

        // v2: changelog store (autoIncrement key for ordering)
        if (!db.objectStoreNames.contains(STORE_CHANGELOG)) {
          const store = db.createObjectStore(STORE_CHANGELOG, {
            keyPath: 'key',
            autoIncrement: true,
          });
          store.createIndex('pushed', 'pushed', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    });

    return _dbPromise;
  }

  // ════════════════════════════════════════════════════════
  //  watched store (existing, unchanged)
  // ════════════════════════════════════════════════════════

  async function hasMany(videoIds) {
    const ids = Array.from(new Set((videoIds || []).filter(Boolean)));
    const out = Object.create(null);
    if (!ids.length) return out;

    const db = await open();
    const tx = db.transaction(STORE_WATCHED, 'readonly');
    const store = tx.objectStore(STORE_WATCHED);

    await Promise.all(ids.map(async (id) => {
      try {
        const key = await _reqToPromise(store.getKey(id));
        out[id] = (key !== undefined);
      } catch {
        out[id] = false;
      }
    }));

    await _txDone(tx);
    return out;
  }

  async function putMany(records, { chunkSize = 1000 } = {}) {
    const recs = (records || [])
      .map(r => {
        if (typeof r === 'string') return { id: r, ts: Date.now() };
        if (r && typeof r === 'object' && typeof r.id === 'string') {
          const ts = Number(r.ts) || Date.now();
          return { id: r.id, ts };
        }
        return null;
      })
      .filter(Boolean);

    if (!recs.length) return { inserted: 0 };

    const db = await open();
    let inserted = 0;

    for (let i = 0; i < recs.length; i += chunkSize) {
      const chunk = recs.slice(i, i + chunkSize);
      const tx = db.transaction(STORE_WATCHED, 'readwrite');
      const store = tx.objectStore(STORE_WATCHED);
      for (const r of chunk) store.put(r);
      await _txDone(tx);
      inserted += chunk.length;
    }

    return { inserted };
  }

  async function delMany(videoIds, { chunkSize = 2000 } = {}) {
    const ids = Array.from(new Set((videoIds || []).filter(Boolean)));
    if (!ids.length) return { deleted: 0 };

    const db = await open();
    let deleted = 0;

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const tx = db.transaction(STORE_WATCHED, 'readwrite');
      const store = tx.objectStore(STORE_WATCHED);
      for (const id of chunk) store.delete(id);
      await _txDone(tx);
      deleted += chunk.length;
    }

    return { deleted };
  }

  async function appendChangeBatch(entries, { pushed = 0 } = {}) {
    if (!entries || !entries.length) return;
    const db = await open();
    const CHUNK = 2000;
    const flag = pushed ? 1 : 0;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const tx = db.transaction(STORE_CHANGELOG, 'readwrite');
      const store = tx.objectStore(STORE_CHANGELOG);
      for (const e of chunk) {
        store.add({ id: e.id, action: e.action, ts: e.ts, pushed: flag });
      }
      await _txDone(tx);
    }
  }

  async function clearAll() {
    const db = await open();
    // Clear both watched and changelog atomically so that the bootstrap
    // guard (countChangelog === 0) triggers correctly on the next sync.
    const tx = db.transaction([STORE_WATCHED, STORE_CHANGELOG], 'readwrite');
    tx.objectStore(STORE_WATCHED).clear();
    tx.objectStore(STORE_CHANGELOG).clear();
    await _txDone(tx);
    return { cleared: true };
  }

  async function count() {
    const db = await open();
    const tx = db.transaction(STORE_WATCHED, 'readonly');
    const store = tx.objectStore(STORE_WATCHED);
    const c = await _reqToPromise(store.count());
    await _txDone(tx);
    return c;
  }

  /**
   * Count ALL changelog entries (pushed + unpushed).
   * Used by bootstrap guard: runs only when changelog is completely empty.
   */
  async function countChangelog() {
    const db = await open();
    const tx = db.transaction(STORE_CHANGELOG, 'readonly');
    const store = tx.objectStore(STORE_CHANGELOG);
    const c = await _reqToPromise(store.count());
    await _txDone(tx);
    return c;
  }

  async function exportAll({ limit = Infinity, offset = 0 } = {}) {
    const db = await open();
    const tx = db.transaction(STORE_WATCHED, 'readonly');
    const store = tx.objectStore(STORE_WATCHED);

    const out = [];
    let skipped = 0;
    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onerror = () => reject(req.error || new Error('Cursor failed'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }
        out.push(cursor.value);
        if (out.length >= limit) return resolve();
        cursor.continue();
      };
    });

    await _txDone(tx);
    return out;
  }


  // ════════════════════════════════════════════════════════
  //  changelog store (NEW — for bidirectional sync)
  // ════════════════════════════════════════════════════════

  /**
   * Append a change event to the changelog.
   * @param {string} videoId
   * @param {'watch'|'unwatch'} action
   * @param {number} ts - millisecond timestamp
   */
  async function appendChange(videoId, action, ts) {
    if (!videoId) return;
    const db = await open();
    const tx = db.transaction(STORE_CHANGELOG, 'readwrite');
    const store = tx.objectStore(STORE_CHANGELOG);
    store.add({
      id: videoId,
      action: action,  // 'watch' | 'unwatch'
      ts: ts || Date.now(),
      pushed: 0,       // 0 = not yet sent to server
    });
    await _txDone(tx);
  }

  /**
   * Export all unpushed changelog entries.
   * @param {number} limit
   * @returns {Array<{key, id, action, ts}>}
   */
  async function exportUnpushedChanges({ limit = 20000 } = {}) {
    const db = await open();
    const tx = db.transaction(STORE_CHANGELOG, 'readonly');
    const store = tx.objectStore(STORE_CHANGELOG);
    const idx = store.index('pushed');

    const out = [];
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(IDBKeyRange.only(0));
      req.onerror = () => reject(req.error || new Error('Cursor failed'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        out.push({
          key: cursor.value.key,
          id: cursor.value.id,
          action: cursor.value.action,
          ts: cursor.value.ts,
        });
        if (out.length >= limit) return resolve();
        cursor.continue();
      };
    });

    await _txDone(tx);
    return out;
  }

  /**
   * Mark changelog entries as pushed after successful server sync.
   * @param {number[]} keys - autoIncrement keys
   */
  async function markChangesPushed(keys) {
    if (!keys || !keys.length) return;

    const db = await open();
    const CHUNK = 2000;

    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const tx = db.transaction(STORE_CHANGELOG, 'readwrite');
      const store = tx.objectStore(STORE_CHANGELOG);

      for (const key of chunk) {
        const getReq = store.get(key);
        getReq.onsuccess = () => {
          const v = getReq.result;
          if (v) {
            v.pushed = 1;
            store.put(v);
          }
        };
      }

      await _txDone(tx);
    }
  }

  /**
   * Delete old pushed changelog entries to save space.
   * Keeps the most recent `keepCount` pushed entries.
   * Optimized: counts first, then deletes oldest via cursor without
   * loading all keys into memory.
   */
  async function pruneChangelog({ keepCount = 1000 } = {}) {
    const db = await open();

    // Step 1: Count total pushed entries
    const countTx = db.transaction(STORE_CHANGELOG, 'readonly');
    const countIdx = countTx.objectStore(STORE_CHANGELOG).index('pushed');
    const totalPushed = await _reqToPromise(countIdx.count(IDBKeyRange.only(1)));
    await _txDone(countTx);

    const deleteCount = totalPushed - keepCount;
    if (deleteCount <= 0) return;

    // Step 2: Delete oldest `deleteCount` pushed entries via cursor
    const delTx = db.transaction(STORE_CHANGELOG, 'readwrite');
    const delIdx = delTx.objectStore(STORE_CHANGELOG).index('pushed');
    let deleted = 0;

    await new Promise((resolve, reject) => {
      const req = delIdx.openCursor(IDBKeyRange.only(1));
      req.onerror = () => reject(req.error || new Error('Cursor failed'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || deleted >= deleteCount) return resolve();
        cursor.delete();
        deleted++;
        cursor.continue();
      };
    });

    await _txDone(delTx);
  }

  /**
   * Apply remote changes from server to the local watched store.
   * For each change:
   *   - 'watch'   → put into watched store
   *   - 'unwatch' → delete from watched store
   *
   * @param {Array<{id, action, ts}>} changes
   * @returns {{ applied: number }}
   */
  async function applyRemoteChanges(changes) {
    if (!changes || !changes.length) return { applied: 0 };

    const db = await open();
    let applied = 0;
    const CHUNK = 2000;

    for (let i = 0; i < changes.length; i += CHUNK) {
      const chunk = changes.slice(i, i + CHUNK);
      const tx = db.transaction(STORE_WATCHED, 'readwrite');
      const store = tx.objectStore(STORE_WATCHED);

      for (const c of chunk) {
        if (c.action === 'unwatch') {
          store.delete(c.id);
        } else {
          // 'watch': put without synced flag
          store.put({ id: c.id, ts: c.ts });
        }
        applied++;
      }

      await _txDone(tx);
    }

    return { applied };
  }

  /**
   * Compute watch statistics from the watched store (#11).
   * Returns daily counts for the last N days and monthly counts.
   */
  async function getWatchStats({ days = 30 } = {}) {
    const db = await open();
    const tx = db.transaction(STORE_WATCHED, 'readonly');
    const store = tx.objectStore(STORE_WATCHED);

    const dailyMap = Object.create(null);
    const monthlyMap = Object.create(null);
    let total = 0;

    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onerror = () => reject(req.error || new Error('Cursor failed'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        total++;
        const ts = Number(cursor.value?.ts);
        if (ts && ts > cutoff) {
          const d = new Date(ts);
          const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          dailyMap[dayKey] = (dailyMap[dayKey] || 0) + 1;
          monthlyMap[monthKey] = (monthlyMap[monthKey] || 0) + 1;
        }
        cursor.continue();
      };
    });

    await _txDone(tx);

    const daily = Object.entries(dailyMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const monthly = Object.entries(monthlyMap)
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return { daily, monthly, total };
  }

  return {
    open,
    // watched store
    hasMany,
    putMany,
    delMany,
    clearAll,
    count,
    exportAll,
    // changelog store
    appendChange,
    appendChangeBatch,
    countChangelog,
    exportUnpushedChanges,
    markChangesPushed,
    pruneChangelog,
    applyRemoteChanges,
    // stats
    getWatchStats,
  };
})();
