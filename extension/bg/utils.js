'use strict';
(() => {
  const BG = self.UTH_BG;

  // -------------------- debug logging (#5) --------------------
  BG.DEBUG = false;
  BG.dbg = function dbg(...args) {
    if (BG.DEBUG) console.debug('[UTH:BG]', ...args);
  };

  // -------------------- Promise-safe messaging --------------------
  BG.tabsSendMessage = function tabsSendMessage(tabId, message, options) {
    return new Promise((resolve, reject) => {
      try {
        const cb = (resp) => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve(resp);
        };

        if (options) chrome.tabs.sendMessage(tabId, message, options, cb);
        else chrome.tabs.sendMessage(tabId, message, cb);
      } catch (e) {
        reject(e);
      }
    });
  };

  BG.safeTabsSendMessage = function safeTabsSendMessage(tabId, message) {
    return BG.tabsSendMessage(tabId, message).catch(() => undefined);
  };

  // URL (getSiteType, extractVideoId, canonicalVideoUrlFromId,
  // isActionEligible, isInternalBrowserUrl) to bg/site-rules.js

  BG.getSqliteServerBaseUrl = async function getSqliteServerBaseUrl() {
    const s = await chrome.storage.local.get(BG.DEFAULT_SQLITE_SYNC).catch(() => ({}));
    const raw = String(s.sqliteServerUrl || BG.DEFAULT_SQLITE_SYNC.sqliteServerUrl).trim();
    const base = raw.replace(/\/+$/, '');
    return base || BG.DEFAULT_SQLITE_SYNC.sqliteServerUrl;
  };

  // -------------------- UI toast helper --------------------
  BG.toastToTab = async function toastToTab(tabId, text, kind = 'info') {
    if (!tabId) return false;
    try {
      await BG.tabsSendMessage(
        tabId,
        { type: 'UTUBEHOLIC_TOAST', text: String(text || ''), kind },
        { frameId: 0 } // ✅ top frame
      );
      return true;
    } catch {
      return false;
    }
  };

  BG.setTempBadge = function setTempBadge(text, { color = '#444', durationMs = 1800 } = {}) {
    try {
      if (!chrome.action?.setBadgeText) return;
      chrome.action.setBadgeText({ text: String(text || '').slice(0, 4) });
      chrome.action.setBadgeBackgroundColor?.({ color });
      setTimeout(() => {
        try { chrome.action.setBadgeText({ text: '' }); } catch { }
      }, durationMs);
    } catch { }
  };

  BG.toastOrBadge = async function toastOrBadge(tabId, text, kind = 'info') {
    const ok = await BG.toastToTab(tabId, text, kind);
    if (ok) return true;

    if (kind === 'error') BG.setTempBadge('!', { color: '#b00020' });
    else if (kind === 'ok') BG.setTempBadge('OK', { color: '#1b5e20' });
    else BG.setTempBadge('...', { color: '#444' });

    return false;
  };

  // -------------------- fetch helpers --------------------
  BG.fetchJsonWithTimeout = async function fetchJsonWithTimeout(url, { timeoutMs = 2000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: 'GET', cache: 'no-store', signal: controller.signal });
      if (!r.ok) return { ok: false, status: r.status };
      const j = await r.json().catch(() => null);
      return { ok: true, json: j };
    } catch (e) {
      const msg = String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e));
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timeout);
    }
  };

  // -------------------- sqlite response parsing --------------------
  BG.parseCountFromJson = function parseCountFromJson(j) {
    const candidates = [j?.count, j?.rowCount, j?.rows, j?.total, j?.watched_count, j?.watchedCount];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  BG.parseSqlitePathFromJson = function parseSqlitePathFromJson(j) {
    const p1 = j?.sqlite_path;
    if (typeof p1 === 'string' && p1) return p1;
    const p2 = j?.sqlitePath;
    if (typeof p2 === 'string' && p2) return p2;
    return null;
  };

  // -------------------- tab discovery --------------------
  BG.queryYouTubeTabs = function queryYouTubeTabs() {
    return new Promise((resolve) => {
      chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://youtube.com/*'] }, (tabs) => resolve(tabs || []));
    });
  };
})();
