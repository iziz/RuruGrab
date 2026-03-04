'use strict';
(() => {
  const BG = self.UTH_BG;

  //  Instance ID: unique per browser profile
  let _instanceId = null;

  async function getInstanceId() {
    if (_instanceId) return _instanceId;

    const stored = await chrome.storage.local.get({ syncInstanceId: '' }).catch(() => ({}));
    if (stored.syncInstanceId) {
      _instanceId = stored.syncInstanceId;
      return _instanceId;
    }

    // Generate: browser-randomhex (e.g. "chrome-a1b2c3d4e5f6")
    const browser = /Edg\//i.test(navigator.userAgent) ? 'edge'
      : /OPR\//i.test(navigator.userAgent) ? 'opera' : 'chrome';
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    _instanceId = `${browser}-${hex}`;

    await chrome.storage.local.set({ syncInstanceId: _instanceId }).catch(() => { });
    return _instanceId;
  }

  //  Status persistence
  async function setSqliteStatus({ successMs = null, rowCount = null, error = null } = {}) {
    const patch = {};
    if (typeof successMs === 'number') patch.sqliteSyncLastSuccessMs = successMs;
    if (typeof rowCount === 'number') patch.sqliteSyncLastRowCount = rowCount;
    if (typeof error === 'string') patch.sqliteSyncLastError = error;
    if (Object.keys(patch).length) {
      await chrome.storage.local.set(patch).catch(() => { });
    }
  }

  BG.setSqliteStatus = setSqliteStatus;

  //  Progress broadcasting (#9)
  //  Options page listens for SQLITE_SYNC_PROGRESS messages.
  function broadcastSyncProgress(message) {
    try {
      chrome.runtime.sendMessage({ type: 'SQLITE_SYNC_PROGRESS', message }).catch(() => { });
    } catch { /* options page may not be open */ }
  }

  BG.broadcastSyncProgress = broadcastSyncProgress;

  //  Pull finalization (shared by sync paths)
  async function finalizePull(resp, sinceSeq, totalPushed, pushedActions) {
    const remoteChanges = resp.remote_changes || [];
    let appliedCount = 0;

    if (remoteChanges.length) {
      // Skip echo-back: only skip when the server returns the SAME action
      // we pushed.  If actions differ (e.g. we pushed unwatch but server
      // kept watch because our ts was older), we must apply the server's version.
      const skip = pushedActions || new Map();
      const toApply = skip.size
        ? remoteChanges.filter((c) => skip.get(c.id) !== c.action)
        : remoteChanges;

      if (toApply.length) {
        broadcastSyncProgress(`↓ Applying ${toApply.length} remote changes...`);
        const result = await YT_DLP_DB.applyRemoteChanges(toApply);
        appliedCount = result?.applied || 0;
      }

      for (const c of toApply) {
        if (c.action === 'watch') BG.cacheWatched(c.id);
        else BG.uncacheWatched(c.id);
      }

      if (appliedCount > 0) BG.broadcastRefreshWatched().catch(() => { });
    }

    const newCursor = Number(resp.cursor) || sinceSeq;
    await chrome.storage.local.set({ syncCursor: newCursor }).catch(() => { });

    const serverCount = resp.server_count ?? null;
    await setSqliteStatus({ successMs: Date.now(), rowCount: serverCount, error: '' });
    await YT_DLP_DB.pruneChangelog({ keepCount: 1000 }).catch(() => { });

    return {
      ok: true,
      pushed: totalPushed,
      applied: resp.applied || 0,
      pulled: appliedCount,
      cursor: newCursor,
      serverCount,
    };
  }


  // Bidirectional sync via /sync_changes (chunked)
  async function syncChanges() {
    const serverBase = await BG.getSqliteServerBaseUrl();
    const endpoint = `${serverBase}/sync_changes`;
    const instance = await getInstanceId();

    const stored = await chrome.storage.local.get({ syncCursor: 0 }).catch(() => ({ syncCursor: 0 }));
    let sinceSeq = Number(stored.syncCursor) || 0;

    const CHUNK = 5000;
    let totalPushed = 0;
    const pushedActions = new Map(); // id → last pushed action

    // Bootstrap: ensure ALL local records are in changelog.
    // Runs ONLY when changelog is completely empty (first setup or after full wipe).
    // Guard: countChangelog() checks both pushed=0 and pushed=1 entries,
    // so already-synced installs do NOT re-trigger bootstrap on every sync.
    {
      const changelogTotal = await YT_DLP_DB.countChangelog().catch(() => -1);
      if (changelogTotal === 0) {
        const localCount = await YT_DLP_DB.count().catch(() => 0);
        if (localCount > 0) {
          broadcastSyncProgress(`Bootstrap: migrating ${localCount.toLocaleString()} local records to changelog...`);
          let offset = 0;
          while (true) {
            const batch = await YT_DLP_DB.exportAll({ limit: CHUNK, offset });
            if (!batch.length) break;
            await YT_DLP_DB.appendChangeBatch(
              batch.map((r) => ({ id: r.id, action: 'watch', ts: r.ts }))
            );
            offset += batch.length;
            if (batch.length < CHUNK) break;
          }
        }
      }
    }

    // Push loop: changelog → server
    while (true) {
      const unpushed = await YT_DLP_DB.exportUnpushedChanges({ limit: CHUNK });
      if (!unpushed.length) break;

      const changes = unpushed.map((c) => ({
        id: c.id,
        action: c.action,
        ts: c.ts,
      }));

      broadcastSyncProgress(`↑ Pushing ${totalPushed + changes.length} changes...`);

      let resp;
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // sinceSeq is intentionally kept at the ORIGINAL saved cursor throughout
          // all push chunks. This ensures the final finalizePull receives ALL
          // remote_changes from other instances since our last sync — not just
          // changes after the last chunk's cursor.
          body: JSON.stringify({ instance, changes, since_seq: sinceSeq }),
        });

        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`sync_changes failed: ${r.status} ${text}`.trim());
        }

        resp = await r.json();
        if (!resp?.ok) throw new Error(resp?.error || 'sync_changes returned not ok');
      } catch (e) {
        throw e;
      }

      const keys = unpushed.map((c) => c.key);
      await YT_DLP_DB.markChangesPushed(keys);
      for (const c of changes) pushedActions.set(c.id, c.action);
      totalPushed += changes.length;
      // NOTE: sinceSeq is NOT updated here — see comment above.

      if (unpushed.length < CHUNK) {
        return await finalizePull(resp, sinceSeq, totalPushed, pushedActions);
      }
    }

    // unpushed 0 — pull only
    broadcastSyncProgress('↓ Checking for remote changes...');
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance, changes: [], since_seq: sinceSeq }),
      });

      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`sync_changes failed: ${r.status} ${text}`.trim());
      }

      const resp = await r.json();
      if (!resp?.ok) throw new Error(resp?.error || 'sync_changes returned not ok');

      return await finalizePull(resp, sinceSeq, totalPushed, pushedActions);
    } catch (e) {
      throw e;
    }
  }

  BG.syncChanges = syncChanges;


  //  Get server watched count (used for auto-restore detection)
  async function getServerWatchedCount() {
    const serverBase = await BG.getSqliteServerBaseUrl();
    try {
      const r = await fetch(`${serverBase}/watched_count`, {
        method: 'GET', cache: 'no-store',
      });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return BG.parseCountFromJson(j);
    } catch {
      return null;
    }
  }


  //  Smart sync entry point (#2 — auto Full Restore for new browsers)
  //  If local DB is nearly empty but server has significant data,
  //  automatically runs Full Restore instead of incremental sync.
  async function syncUnsyncedToSqlite() {
    const localCount = await YT_DLP_DB.count().catch(() => 0);

    // Auto-restore threshold: local has < 100 items, server has > 500
    const AUTO_RESTORE_LOCAL_MAX = 100;
    const AUTO_RESTORE_SERVER_MIN = 500;

    if (localCount < AUTO_RESTORE_LOCAL_MAX) {
      broadcastSyncProgress('Checking server for existing data...');
      const serverCount = await getServerWatchedCount();

      if (serverCount !== null && serverCount >= AUTO_RESTORE_SERVER_MIN) {
        broadcastSyncProgress(`Auto-restore: server has ${serverCount.toLocaleString()} items, downloading...`);

        const result = await restoreFromSqlite({ wipe: false });
        const newLocalCount = await YT_DLP_DB.count().catch(() => null);

        return {
          ok: true,
          sent: 0,
          received: result.restored ?? 0,
          serverCountBefore: serverCount,
          serverCountAfter: result.rowCount ?? null,
          rowCount: result.rowCount ?? null,
          localCount: newLocalCount,
          forcedFull: true,
          resetUpdated: 0,
          pulled: result.restored ?? 0,
          cursor: 0,
        };
      }
    }

    // Normal incremental sync
    const result = await syncChanges();
    const localCountAfter = await YT_DLP_DB.count().catch(() => localCount);

    return {
      ok: result.ok,
      sent: result.pushed ?? 0,
      received: result.applied ?? 0,
      serverCountBefore: result.serverCount ?? null,
      serverCountAfter: result.serverCount ?? null,
      rowCount: result.serverCount ?? null,
      localCount: localCountAfter,
      forcedFull: false,
      resetUpdated: 0,
      pulled: result.pulled ?? 0,
      cursor: result.cursor ?? 0,
    };
  }

  BG.syncUnsyncedToSqlite = syncUnsyncedToSqlite;

  //  Restore from server (full pull) — with progress reporting (#9)
  async function restoreFromSqlite({ wipe = false } = {}) {
    const serverBase = await BG.getSqliteServerBaseUrl();

    if (wipe) {
      broadcastSyncProgress('Wiping local DB...');
      await YT_DLP_DB.clearAll();
    }

    let page = 0;
    const pageSize = 5000;
    let restored = 0;
    let total = 0;

    while (true) {
      const url = `${serverBase}/watched_export?page=${page}&page_size=${pageSize}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`watched_export failed: ${resp.status} ${text}`.trim());
      }
      const data = await resp.json().catch(() => null);
      if (!data?.ok) throw new Error(data?.error || 'watched_export returned not ok');

      const records = (data.records || []).map((r) => ({ id: r.id, ts: Number(r.ts) || Date.now(), synced: 1 }));
      total = Number(data.total) || total;

      if (records.length) {
        await YT_DLP_DB.putMany(records, { chunkSize: 2000 });
        // Mark as already-pushed in changelog so bootstrap won't re-push
        await YT_DLP_DB.appendChangeBatch(
          records.map((r) => ({ id: r.id, action: 'watch', ts: r.ts })),
          { pushed: 1 },
        );
        restored += records.length;
        for (const r of records) BG.cacheWatched(r.id);
      }

      // Progress reporting (#9)
      if (total > 0) {
        const pct = Math.min(100, Math.round((restored / total) * 100));
        broadcastSyncProgress(`↓ Restoring: ${restored.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
      } else {
        broadcastSyncProgress(`↓ Restoring: ${restored.toLocaleString()} items...`);
      }

      if (!data.has_more) break;
      page += 1;
      if (page > 100000) break;
    }

    try {
      const instance = await getInstanceId();
      const r = await fetch(`${serverBase}/sync_changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance, changes: [], since_seq: 0 }),
      });
      const cursorResp = await r.json();
      await chrome.storage.local.set({
        syncCursor: Number(cursorResp?.cursor) || 0,
      }).catch(() => { });
    } catch {
      await chrome.storage.local.set({ syncCursor: 0 }).catch(() => { });
    }

    await setSqliteStatus({ successMs: Date.now(), rowCount: total, error: '' });
    await BG.broadcastRefreshWatched();

    broadcastSyncProgress('');  // clear progress

    return { ok: true, restored, rowCount: total };
  }

  BG.restoreFromSqlite = restoreFromSqlite;

  //  Alarm-based periodic sync
  BG.reapplySqliteAlarms = async function reapplySqliteAlarms() {
    const s = await chrome.storage.local.get(BG.DEFAULT_SQLITE_SYNC).catch(() => BG.DEFAULT_SQLITE_SYNC);
    const enabled = !!s.sqliteSyncEnabled;
    const intervalMin = Math.max(1, Number(s.sqliteSyncIntervalMin || BG.DEFAULT_SQLITE_SYNC.sqliteSyncIntervalMin));

    await new Promise((resolve) => chrome.alarms.clear(BG.SQLITE_ALARM_NAME, () => resolve()));

    if (!enabled) return;

    chrome.alarms.create(BG.SQLITE_ALARM_NAME, { periodInMinutes: intervalMin });
  };

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== BG.SQLITE_ALARM_NAME) return;
    (async () => {
      try {
        await syncChanges();
      } catch (e) {
        await setSqliteStatus({ error: String(e) });
      }
    })();
  });
})();
