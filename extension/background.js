/* background.js (MV3 service worker) - bootstraps modular files */
'use strict';

self.UTH_BG = self.UTH_BG || {};

// Load constants FIRST, then all modules
importScripts(
  'constants.js',
  'db.js',
  'bg/site-rules.js',
  'bg/utils.js',
  'bg/watched.js',
  'bg/download.js',
  'bg/history_import.js',
  'bg/sqlite_sync.js',
  'bg/menus.js',
  'bg/newtab_mark.js',
  'bg/messages.js'
);

(() => {
  const BG = self.UTH_BG;

  BG.CM_ROOT = 'utubeholic_root';
  BG.CM_DOWNLOAD = 'utubeholic_download';
  BG.CM_MARK = 'utubeholic_mark_watched';
  BG.CM_UNMARK = 'utubeholic_unmark_watched';

  BG.SQLITE_ALARM_NAME = 'utubeholic_sqlite_sync';

  // From constants.js (loaded above)
  BG.DEFAULT_SQLITE_SYNC = UTH_CONSTANTS.DEFAULT_SQLITE_SYNC;

  // Watched cache
  BG.WATCHED_CACHE_MAX = 8000;
})();

(() => {
  const BG = self.UTH_BG;

  // -------------------- Action is always enabled --------------------
  BG.ensureActionEnabled = function ensureActionEnabled(tabId) {
    try {
      if (typeof tabId === 'number') {
        chrome.action.enable(tabId, () => void chrome.runtime.lastError);
        chrome.action.setTitle({ tabId, title: 'Send to Download Queue' }, () => void chrome.runtime.lastError);
      }
    } catch { /* ignore */ }
  };

  function enableGlobally() {
    try {
      chrome.action.enable(() => void chrome.runtime.lastError);
      chrome.action.setTitle({ title: 'Send to Download Queue' }, () => void chrome.runtime.lastError);
    } catch { /* ignore */ }
  }

  function enableAllTabs() {
    try {
      chrome.tabs.query({}, (tabs) => {
        void chrome.runtime.lastError;
        for (const t of tabs || []) BG.ensureActionEnabled(t.id);
      });
    } catch { /* ignore */ }
  }

  // Each time a tab switches or updates, enable is applied once more,
  // so tabs that were disabled in the previous version are also restored immediately.
  chrome.tabs.onActivated.addListener(({ tabId }) => BG.ensureActionEnabled(tabId));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url) BG.ensureActionEnabled(tabId);
  });

  // -------------------- lifecycle bootstrap --------------------
  function bootstrap() {
    try { BG.ensureContextMenus?.(); } catch { }
    try { BG.reapplySqliteAlarms?.(); } catch { }
    enableGlobally();
    enableAllTabs();
  }

  chrome.runtime.onInstalled.addListener(() => { bootstrap(); });
  chrome.runtime.onStartup?.addListener(() => { bootstrap(); });

  // Cold start (service worker restart)
  bootstrap();
})();
