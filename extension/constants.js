/* constants.js — shared defaults (background + options page) */
// var ensures global scope in both service worker and regular page contexts
// (const/let are block-scoped and don't register on globalThis)
var UTH_CONSTANTS = {
  DEFAULT_SETTINGS: {
    badgeText: 'WATCHED',
    badgeBgColor: 'rgba(249, 255, 22, 0.7)',
    badgeTextColor: 'rgba(0, 0, 0, 0.9)',
    badgeBorderColor: 'rgba(255, 255, 255, 0.6)',
  },

  FORCED_MARKING_SETTINGS: {
    watchedEnabled: true,
    badgeEnabled: true,
  },

  DEFAULT_UI: {
    historyIncludeShorts: true,
    historyMaxResults: 100000,
  },

  DEFAULT_SQLITE_SYNC: {
    sqliteSyncEnabled: false,
    sqliteServerUrl: 'http://127.0.0.1:5000',
    sqliteSyncIntervalMin: 10,
    sqliteSyncLastSuccessMs: 0,
    sqliteSyncLastRowCount: 0,
    sqliteSyncLastError: '',
  },
};
