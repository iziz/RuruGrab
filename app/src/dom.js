import { $ } from './domUtils.js'

// Centralized DOM element references
export const dom = {
  // server tab
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
  statusUrl: $('#statusUrl'),
  pathSqlite: $('#pathSqlite'),
  pathDownloads: $('#pathDownloads'),

  // logs
  logAll: $('#log-all'),
  logAccess: $('#log-access'),
  logSync: $('#log-sync'),
  logDownload: $('#log-download'),
  logError: $('#log-error'),

  // downloads tab
  videoUrl: $('#videoUrl'),
  dlTitle: $('#dlTitle'),
  dlList: $('#dlList'),
  dlQueueSize: $('#dlQueueSize'),
  dlWorkerAlive: $('#dlWorkerAlive'),

  // sqlite tab
  sqliteFilter: $('#sqliteFilter'),
  sqliteCount: $('#sqliteCount'),
  sqliteBody: $('#sqliteBody'),

  // context menu
  ctxMenu: $('#ctxMenu'),
}
