'use strict';
(() => {
  const BG = self.UTH_BG;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case 'PING_BG':
          return { ok: true, ts: Date.now() };

        case 'CHECK_WATCHED_BATCH': {
          const data = await BG.checkWatchedBatch(msg.videoIds || []);
          return { ok: true, data };
        }
        case 'MARK_WATCHED':
          await BG.markWatched(msg.videoId, msg.ts);
          return { ok: true };

        case 'MARK_WATCHED_MANY_SKIP': {
          const res = await BG.markWatchedManySkipExisting(msg.videoIds || [], msg.ts || Date.now());
          return { ok: true, ...res };
        }

        case 'UNMARK_WATCHED':
          await BG.unmarkWatched(msg.videoId);
          return { ok: true };

        case 'IMPORT_FROM_BROWSER_HISTORY_ALL': {
          const res = await BG.importFromBrowserHistoryAll(msg.params || {});
          await BG.broadcastRefreshWatched();
          return { ok: true, ...res };
        }

        case 'IMPORT_FROM_YOUTUBE_HISTORY_PAGE': {
          const res = await BG.importFromYouTubeHistoryPage();
          await BG.broadcastRefreshWatched();
          return res;
        }

        case 'SQLITE_APPLY_SETTINGS':
          await BG.reapplySqliteAlarms();
          return { ok: true };

        case 'SQLITE_SYNC_NOW': {
          try {
            const res = await BG.syncUnsyncedToSqlite();
            return { ok: true, ...res };
          } catch (e) {
            await BG.setSqliteStatus({ error: String(e) });
            return { ok: false, error: String(e) };
          }
        }

        case 'SQLITE_RESTORE': {
          try {
            const wipe = !!msg.wipe;
            const res = await BG.restoreFromSqlite({ wipe });
            return { ok: true, ...res };
          } catch (e) {
            await BG.setSqliteStatus({ error: String(e) });
            return { ok: false, error: String(e) };
          }
        }

        default:
          return { ok: false, error: 'Unknown message type' };
      }
    })()
      .then(sendResponse)
      .catch((err) => {
        console.error(err);
        sendResponse({ ok: false, error: String(err) });
      });

    return true;
  });
})();
