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

    await chrome.storage.local.set({ syncInstanceId: _instanceId }).catch(() => {});
    return _instanceId;
  }

  //  Status persistence
  async function setSqliteStatus({ successMs = null, rowCount = null, error = null } = {}) {
    const patch = {};
    if (typeof successMs === 'number') patch.sqliteSyncLastSuccessMs = successMs;
    if (typeof rowCount === 'number') patch.sqliteSyncLastRowCount = rowCount;
    if (typeof error === 'string') patch.sqliteSyncLastError = error;
    if (Object.keys(patch).length) {
      await chrome.storage.local.set(patch).catch(() => {});
    }
  }

  BG.setSqliteStatus = setSqliteStatus;

  //  Pull finalization (shared by sync paths)
  async function finalizePull(resp, sinceSeq, totalPushed) {
    const remoteChanges = resp.remote_changes || [];
    let appliedCount = 0;

    if (remoteChanges.length) {
      const result = await YT_DLP_DB.applyRemoteChanges(remoteChanges);
      appliedCount = result?.applied || 0;

      for (const c of remoteChanges) {
        if (c.action === 'watch') BG.cacheWatched(c.id);
        else BG.uncacheWatched(c.id);
      }

      if (appliedCount > 0) BG.broadcastRefreshWatched().catch(() => {});
    }

    const newCursor = Number(resp.cursor) || sinceSeq;
    await chrome.storage.local.set({ syncCursor: newCursor }).catch(() => {});

    const serverCount = resp.server_count ?? null;
    await setSqliteStatus({ successMs: Date.now(), rowCount: serverCount, error: '' });
    await YT_DLP_DB.pruneChangelog({ keepCount: 1000 }).catch(() => {});

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

    // Bootstrap: watched(synced=0) → changelog
    const bootstrapDone = await chrome.storage.local.get({ syncBootstrapDone: false })
      .catch(() => ({ syncBootstrapDone: false }));

    if (!bootstrapDone.syncBootstrapDone) {
      const hasChangelog = await YT_DLP_DB.exportUnpushedChanges({ limit: 1 });
      if (!hasChangelog.length) {
        while (true) {
          const legacy = await YT_DLP_DB.exportUnsynced({ limit: CHUNK });
          if (!legacy.length) break;

          await YT_DLP_DB.appendChangeBatch(
            legacy.map((r) => ({ id: r.id, action: 'watch', ts: r.ts }))
          );
          await YT_DLP_DB.markSyncedMany(legacy);

          if (legacy.length < CHUNK) break;
        }
      }
      await chrome.storage.local.set({ syncBootstrapDone: true }).catch(() => {});
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

      let resp;
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
      totalPushed += changes.length;
      sinceSeq = Number(resp.cursor) || sinceSeq;

      if (unpushed.length < CHUNK) {
        return await finalizePull(resp, sinceSeq, totalPushed);
      }
    }

    // unpushed 0 — pull only
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

      return await finalizePull(resp, sinceSeq, totalPushed);
    } catch (e) {
      throw e;
    }
  }

  BG.syncChanges = syncChanges;

  //  syncChanges (messages.js)
  async function syncUnsyncedToSqlite() {
    const localCount = await YT_DLP_DB.count().catch(() => null);
    const result = await syncChanges();

    return {
      ok: result.ok,
      sent: result.pushed ?? 0,
      received: result.applied ?? 0,
      serverCountBefore: result.serverCount ?? null,
      serverCountAfter: result.serverCount ?? null,
      rowCount: result.serverCount ?? null,
      localCount: localCount,
      forcedFull: false,
      resetUpdated: 0,
      pulled: result.pulled ?? 0,
      cursor: result.cursor ?? 0,
    };
  }

  BG.syncUnsyncedToSqlite = syncUnsyncedToSqlite;

  //  Restore from server (full pull)
  async function restoreFromSqlite({ wipe = false } = {}) {
    const serverBase = await BG.getSqliteServerBaseUrl();

    if (wipe) await YT_DLP_DB.clearAll();

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
        restored += records.length;
        for (const r of records) BG.cacheWatched(r.id);
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
      }).catch(() => {});
    } catch {
      await chrome.storage.local.set({ syncCursor: 0 }).catch(() => {});
    }

    await setSqliteStatus({ successMs: Date.now(), rowCount: total, error: '' });
    await BG.broadcastRefreshWatched();

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
