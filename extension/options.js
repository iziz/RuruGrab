/* options.js */
'use strict';

// -------------------- messaging helpers (content script) --------------------
function sendRuntimeMessage(msg) {
  // MV3 chrome.runtime.sendMessage may or may not return a Promise depending on Chrome version.
  // Always use the callback form and wrap it.
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err);
        else resolve(resp);
      });
    } catch (e) {
      reject(e);
    }
  });
}


function sendTabMessage(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, () => resolve());
    } catch {
      resolve();
    }
  });
}

const DEFAULT_SETTINGS = UTH_CONSTANTS.DEFAULT_SETTINGS;

// Visibility defaults for watched UI on YouTube.
const FORCED_MARKING_SETTINGS = UTH_CONSTANTS.FORCED_MARKING_SETTINGS;

const DEFAULT_UI = UTH_CONSTANTS.DEFAULT_UI;

const DEFAULT_SQLITE_SYNC = UTH_CONSTANTS.DEFAULT_SQLITE_SYNC;


const $ = (id) => document.getElementById(id);

function _isBadgeDisplayEnabled() {
  return !!$('watchedBadgeEnabled')?.checked;
}

function _setBadgeControlsDisabled(disabled) {
  const ids = [
    'badgeText',
    'badgeBgColor', 'badgeBgAlpha',
    'badgeTextColor', 'badgeTextAlpha',
    'badgeBorderColor', 'badgeBorderAlpha',
  ];

  for (const id of ids) {
    const el = $(id);
    if (el) el.disabled = !!disabled;
  }

  $('previewDock')?.classList.toggle('isDisabled', !!disabled);
  $('badgePreview')?.classList.toggle('isDisabled', !!disabled);
}

function _syncBadgeOptionUI() {
  _setBadgeControlsDisabled(!_isBadgeDisplayEnabled());
}


// -------------------- badge color helpers --------------------
function _clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
function _toHex2(n) {
  const v = _clamp(Math.round(Number(n) || 0), 0, 255);
  return v.toString(16).padStart(2, '0');
}
function _rgbToHex(r, g, b) {
  return `#${_toHex2(r)}${_toHex2(g)}${_toHex2(b)}`;
}
function _hexToRgb(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  if (!s) return null;

  // #RGB / #RGBA
  if (s.length === 3 || s.length === 4) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    const a = (s.length === 4) ? parseInt(s[3] + s[3], 16) / 255 : 1;
    if ([r, g, b].some((x) => Number.isNaN(x))) return null;
    return { r, g, b, a };
  }

  // #RRGGBB / #RRGGBBAA
  if (s.length === 6 || s.length === 8) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    const a = (s.length === 8) ? parseInt(s.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some((x) => Number.isNaN(x))) return null;
    return { r, g, b, a };
  }

  return null;
}

// Accept: rgba(r,g,b,a), rgb(r,g,b), #RRGGBB, #RRGGBBAA, #RGB, #RGBA
function _parseCssColorToRgba(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  if (s.startsWith('#')) return _hexToRgb(s);

  // rgba() / rgb()
  const m = s.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)/i);
  if (m) {
    const r = _clamp(parseFloat(m[1]), 0, 255);
    const g = _clamp(parseFloat(m[2]), 0, 255);
    const b = _clamp(parseFloat(m[3]), 0, 255);
    const a = (m[4] == null) ? 1 : _clamp(parseFloat(m[4]), 0, 1);
    return { r, g, b, a };
  }

  // fallback: treat as hex without '#'
  const hx = _hexToRgb('#' + s);
  if (hx) return hx;

  return null;
}

function _formatColorForDisplay({ r, g, b, a }) {
  const hex = _rgbToHex(r, g, b).toUpperCase(); // #FFFF00 format
  const alphaPct = Math.round(a * 100);        // 100% format

  // Use a readable combo (e.g., #FFFF00 · 100%)
  return `${hex} · ${alphaPct}%`;
}

function _rgbaToCss({ r, g, b, a }) {
  const rr = _clamp(Math.round(r), 0, 255);
  const gg = _clamp(Math.round(g), 0, 255);
  const bb = _clamp(Math.round(b), 0, 255);
  const aa = _clamp(Number(a), 0, 1);
  // Keep a with at most 3 decimals for stable storage
  const aStr = (Math.round(aa * 1000) / 1000).toString();
  return `rgba(${rr}, ${gg}, ${bb}, ${aStr})`;
}

function _getCssColorFromControls(colorId, alphaId) {
  const colorEl = $(colorId);
  const alphaEl = $(alphaId);
  const hex = String(colorEl?.value || '#000000');
  const alphaPct = _clamp(alphaEl?.value, 0, 100);
  const rgb = _hexToRgb(hex) || { r: 0, g: 0, b: 0, a: 1 };
  return _rgbaToCss({ ...rgb, a: alphaPct / 100 });
}

function _setControlsFromCssColor(cssColor, { colorId, alphaId, labelId }) {
  const colorEl = $(colorId);
  const alphaEl = $(alphaId);
  const labelEl = $(labelId);

  const rgba = _parseCssColorToRgba(cssColor);
  const r = rgba?.r ?? 0;
  const g = rgba?.g ?? 0;
  const b = rgba?.b ?? 0;
  const a = rgba?.a ?? 1;

  if (colorEl) colorEl.value = _rgbToHex(r, g, b);
  if (alphaEl) alphaEl.value = String(Math.round(_clamp(a, 0, 1) * 100));
  if (labelEl) labelEl.textContent = _formatColorForDisplay({ r, g, b, a });
}

function _updateColorLabel({ colorId, alphaId, labelId }) {
  const labelEl = $(labelId);
  if (!labelEl) return;

  const colorEl = $(colorId);
  const alphaEl = $(alphaId);
  const rgb = _hexToRgb(colorEl.value);
  const a = (alphaEl.value / 100);

  labelEl.textContent = _formatColorForDisplay({ ...rgb, a });
}

function _updateBadgePreview() {
  const el = $('badgePreview');
  if (!el) return;

  const enabled = _isBadgeDisplayEnabled();
  const text = $('badgeText')?.value?.trim() || 'WATCHED';
  el.textContent = enabled ? text : 'HIDDEN';

  if (!enabled) {
    el.style.backgroundColor = '';
    el.style.color = '';
    el.style.borderColor = '';
    return;
  }

  const bg = _getCssColorFromControls('badgeBgColor', 'badgeBgAlpha');
  const fg = _getCssColorFromControls('badgeTextColor', 'badgeTextAlpha');
  const br = _getCssColorFromControls('badgeBorderColor', 'badgeBorderAlpha');

  el.style.backgroundColor = bg;
  el.style.color = fg;
  el.style.borderColor = br;
}


// ---- SQLite server availability gating (options UI) ----
// When the server (server.py) is down, disable Sync/Restore buttons
// so users don’t immediately see noisy errors like "Failed to fetch".
let _sqliteServerOk = false;
let _sqliteGateTimer = null;
let _sqliteGateInFlight = null;
let _sqliteSyncNowBtnLabel = null;
let _sqliteRestoreBtnLabel = null;


// Adaptive polling configuration
const SQLITE_GATE_CFG = {
  jitterRatio: 0.2,

  // UP (healthy): progressively slower
  upBaseMs: 10_000,
  upMaxMs: 300_000, // 5m
  upFactor: 1.6,

  // DOWN (unhealthy): backoff to prevent thrashing
  downBaseMs: 5_000,
  downMaxMs: 60_000,
  downFactor: 1.7,

  // fetch timeout
  timeoutMs: 1500,
};

let _sqliteGateStarted = false;
let _sqliteGateStatus = 'unknown'; // 'up' | 'down' | 'unknown'
let _sqliteGateDelayMs = SQLITE_GATE_CFG.downBaseMs;

// Health endpoint auto-detect
// null: try /healthz first; if 404, lock to watched_count
let _sqliteHealthMode = null; // null | 'healthz' | 'watched_count'

function _jitterDelay(ms) {
  const r = SQLITE_GATE_CFG.jitterRatio;
  const min = 1 - r;
  const max = 1 + r;
  return Math.floor(ms * (min + Math.random() * (max - min)));
}

function _scheduleSqliteGateNext(delayMs) {
  if (!_sqliteGateStarted) return;
  if (_sqliteGateTimer) clearTimeout(_sqliteGateTimer);
  _sqliteGateTimer = setTimeout(() => {
    _sqliteGateLoop().catch(() => { });
  }, Math.max(0, delayMs));
}

function _resetSqliteGateAdaptive(ok) {
  const next = ok ? 'up' : 'down';
  _sqliteGateStatus = next;
  _sqliteGateDelayMs = ok ? SQLITE_GATE_CFG.upBaseMs : SQLITE_GATE_CFG.downBaseMs;
  _scheduleSqliteGateNext(_jitterDelay(_sqliteGateDelayMs));
}

function _normalizeServerUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Remove trailing slashes
  return s.replace(/\/+$/, '');
}

async function _pingSqliteServer(serverUrl) {
  const base = _normalizeServerUrl(serverUrl);
  if (!base) return { ok: false, reason: 'Server URL is empty.' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SQLITE_GATE_CFG.timeoutMs);

  const fetchOpts = {
    method: 'GET',
    cache: 'no-store',
    signal: controller.signal,
    // Can be used as a hint when filtering access logs on the server (server.py) side.
    headers: { 'X-Healthcheck': '1' },
  };

  try {
    // 1) Try /healthz first (lighter: no DB COUNT if available)
    if (_sqliteHealthMode == null || _sqliteHealthMode === 'healthz') {
      const url = `${base}/healthz`;
      const r = await fetch(url, fetchOpts);

      // If 404, /healthz is not implemented → switch to watched_count
      if (r.status === 404) {
        _sqliteHealthMode = 'watched_count';
      } else {
        // If not 404, assume the endpoint exists and stay in healthz mode
        _sqliteHealthMode = 'healthz';
        if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
        return { ok: true };
      }
    }

    // 2) watched_count (backward compatibility)
    const url = `${base}/watched_count`;
    const r = await fetch(url, fetchOpts);
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true) return { ok: false, reason: 'invalid response' };
    return { ok: true };
  } catch (e) {
    // Normalize AbortError to "timeout"
    const msg = String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e));
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timeout);
  }
}

function _applySqliteGateUI({ ok, reason }) {
  _sqliteServerOk = !!ok;

  const syncBtn = $('sqliteSyncNowBtn');
  const restoreBtn = $('sqliteRestoreBtn');

  if (syncBtn) {
    if (_sqliteSyncNowBtnLabel == null) _sqliteSyncNowBtnLabel = syncBtn.textContent;
    syncBtn.disabled = !_sqliteServerOk;
    syncBtn.title = _sqliteServerOk ? '' : `Only available when the server (server.py) is running. (${reason || 'unreachable'})`;
    syncBtn.textContent = _sqliteSyncNowBtnLabel;
  }

  if (restoreBtn) {
    if (_sqliteRestoreBtnLabel == null) _sqliteRestoreBtnLabel = restoreBtn.textContent;
    restoreBtn.disabled = !_sqliteServerOk;
    restoreBtn.title = _sqliteServerOk ? '' : `Only available when the server (server.py) is running. (${reason || 'unreachable'})`;
    restoreBtn.textContent = _sqliteRestoreBtnLabel;
  }

  // Update status badge
  const statusVal = $('syncStatusValue');
  if (statusVal) {
    statusVal.classList.remove('sync-ok', 'sync-off', 'sync-err');
    if (_sqliteServerOk) {
      statusVal.textContent = 'Connected';
      statusVal.classList.add('sync-ok');
    } else {
      statusVal.textContent = reason || 'Offline';
      statusVal.classList.add('sync-err');
    }
  }
}

async function refreshSqliteServerAvailability({ force = false } = {}) {
  if (_sqliteGateInFlight && !force) return _sqliteGateInFlight;
  _sqliteGateInFlight = (async () => {
    const s = await chrome.storage.local.get(DEFAULT_SQLITE_SYNC);
    const serverUrl = s.sqliteServerUrl || 'http://127.0.0.1:5000';
    const res = await _pingSqliteServer(serverUrl);
    _applySqliteGateUI(res);

    // A forced check also resets adaptive polling state so the UI reflects quickly.
    if (force && _sqliteGateStarted) _resetSqliteGateAdaptive(!!res?.ok);

    return res;
  })().finally(() => {
    _sqliteGateInFlight = null;
  });
  return _sqliteGateInFlight;
}

async function _sqliteGateLoop() {
  if (!_sqliteGateStarted) return;

  let res;
  try {
    res = await refreshSqliteServerAvailability();
  } catch (e) {
    const msg = String(e?.message || e);
    res = { ok: false, reason: msg };
    _applySqliteGateUI(res);
  }

  const ok = !!res?.ok;
  const next = ok ? 'up' : 'down';

  // On state transition, reset to base; on steady state, back off.
  if (_sqliteGateStatus !== next) {
    _sqliteGateStatus = next;
    _sqliteGateDelayMs = ok ? SQLITE_GATE_CFG.upBaseMs : SQLITE_GATE_CFG.downBaseMs;
  } else {
    if (ok) {
      _sqliteGateDelayMs = Math.min(SQLITE_GATE_CFG.upMaxMs, Math.floor(_sqliteGateDelayMs * SQLITE_GATE_CFG.upFactor));
    } else {
      _sqliteGateDelayMs = Math.min(SQLITE_GATE_CFG.downMaxMs, Math.floor(_sqliteGateDelayMs * SQLITE_GATE_CFG.downFactor));
    }
  }

  _scheduleSqliteGateNext(_jitterDelay(_sqliteGateDelayMs));
  return res;
}

function startSqliteServerGate() {
  // Safe (re)start handling
  _sqliteGateStarted = true;
  _sqliteGateStatus = 'unknown';
  _sqliteGateDelayMs = SQLITE_GATE_CFG.downBaseMs;

  // Initially disable safely (prevent clicks before the server check).
  _applySqliteGateUI({ ok: false, reason: 'checking...' });

  if (_sqliteGateTimer) clearTimeout(_sqliteGateTimer);

  // Do one immediate check, then continue with adaptive polling.
  _scheduleSqliteGateNext(0);

  // Clean up the timer when the options page closes.
  window.addEventListener('beforeunload', () => {
    _sqliteGateStarted = false;
    if (_sqliteGateTimer) clearTimeout(_sqliteGateTimer);
    _sqliteGateTimer = null;
  }, { once: true });
}


function log(msg) {
  const el = $('log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + el.textContent;
}

function notifyYouTubeTabsRefresh() {
  chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://youtube.com/*'] }, (tabs) => {
    for (const t of (tabs || [])) {
      if (t.id) sendTabMessage(t.id, { type: 'REFRESH_WATCHED' });
    }
  });
}

async function refreshCount() {
  const c = await YT_DLP_DB.count();
  $('countVal').textContent = String(c);
}

function formatDateTime(ms) {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleString('en-US');
  } catch {
    return String(ms);
  }
}

function formatRowCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString('en-US');
}

async function refreshSqliteStatus() {
  let s;
  try {
    s = await chrome.storage.local.get(DEFAULT_SQLITE_SYNC);
  } catch (e) {
    if ($('sqliteLastSuccess')) $('sqliteLastSuccess').textContent = '-';
    if ($('sqliteLastError')) $('sqliteLastError').textContent = String(e);
    if ($('sqliteLastErrorRow')) $('sqliteLastErrorRow').style.display = '';
    return;
  }

  const lastMs = Number(s.sqliteSyncLastSuccessMs || 0);
  const rowCount = s.sqliteSyncLastRowCount;
  const err = (s.sqliteSyncLastError ?? '') || '';

  const lastText = lastMs
    ? `${formatDateTime(lastMs)} · sqlite rows: ${formatRowCount(rowCount)}`
    : '-';

  if ($('sqliteLastSuccess')) $('sqliteLastSuccess').textContent = lastText;
  if ($('sqliteLastError')) $('sqliteLastError').textContent = err ? String(err) : '-';
  // Show error row only when there's an actual error
  if ($('sqliteLastErrorRow')) {
    $('sqliteLastErrorRow').style.display = err ? '' : 'none';
  }
}

async function loadSqliteUI() {
  const s = await chrome.storage.local.get(DEFAULT_SQLITE_SYNC);
  if ($('sqliteSyncEnabled')) $('sqliteSyncEnabled').checked = !!s.sqliteSyncEnabled;
  if ($('sqliteServerUrl')) $('sqliteServerUrl').value = String(s.sqliteServerUrl || 'http://127.0.0.1:5000');
  if ($('sqliteSyncIntervalMin')) $('sqliteSyncIntervalMin').value = String(Number(s.sqliteSyncIntervalMin || 10));

  await refreshSqliteStatus();
}

async function saveSqliteUI() {
  const enabled = !!$('sqliteSyncEnabled')?.checked;
  const serverUrl = String($('sqliteServerUrl')?.value || 'http://127.0.0.1:5000').trim();
  const intervalMin = Math.max(1, Number($('sqliteSyncIntervalMin')?.value || 10));

  await chrome.storage.local.set({
    sqliteSyncEnabled: enabled,
    sqliteServerUrl: serverUrl,
    sqliteSyncIntervalMin: intervalMin,
  });

  // Notify the background (service worker) to reconfigure alarms.
  await sendRuntimeMessage({ type: 'SQLITE_APPLY_SETTINGS' }).catch(() => { });
}


async function loadUI() {
  const s = await chrome.storage.local.get({ ...FORCED_MARKING_SETTINGS, ...DEFAULT_SETTINGS });

  $('watchedBadgeEnabled').checked = !!(s.watchedEnabled && s.badgeEnabled);
  $('badgeText').value = String(s.badgeText ?? 'WATCHED');

  // Badge style controls
  _setControlsFromCssColor(s.badgeBgColor ?? DEFAULT_SETTINGS.badgeBgColor, { colorId: 'badgeBgColor', alphaId: 'badgeBgAlpha', labelId: 'badgeBgRgba' });
  _setControlsFromCssColor(s.badgeTextColor ?? DEFAULT_SETTINGS.badgeTextColor, { colorId: 'badgeTextColor', alphaId: 'badgeTextAlpha', labelId: 'badgeTextRgba' });
  _setControlsFromCssColor(s.badgeBorderColor ?? DEFAULT_SETTINGS.badgeBorderColor, { colorId: 'badgeBorderColor', alphaId: 'badgeBorderAlpha', labelId: 'badgeBorderRgba' });

  _syncBadgeOptionUI();
  _updateBadgePreview();

  const ui = await chrome.storage.local.get(DEFAULT_UI);
  $('historyIncludeShorts').checked = (ui.historyIncludeShorts ?? true) === true;

  await loadSqliteUI();
}


function wireBadgeStyleUI() {
  const bindings = [
    { colorId: 'badgeBgColor', alphaId: 'badgeBgAlpha', labelId: 'badgeBgRgba' },
    { colorId: 'badgeTextColor', alphaId: 'badgeTextAlpha', labelId: 'badgeTextRgba' },
    { colorId: 'badgeBorderColor', alphaId: 'badgeBorderAlpha', labelId: 'badgeBorderRgba' },
  ];

  for (const b of bindings) {
    const c = $(b.colorId);
    const a = $(b.alphaId);
    c?.addEventListener('input', () => { _updateColorLabel(b); _updateBadgePreview(); });
    a?.addEventListener('input', () => { _updateColorLabel(b); _updateBadgePreview(); });
  }

  $('watchedBadgeEnabled')?.addEventListener('change', () => {
    _syncBadgeOptionUI();
    _updateBadgePreview();
  });

  $('badgeText')?.addEventListener('input', () => _updateBadgePreview());
}

async function saveSettings() {
  const badgeVisible = _isBadgeDisplayEnabled();

  await chrome.storage.local.set({
    watchedEnabled: badgeVisible,
    badgeEnabled: badgeVisible,
    badgeText: $('badgeText').value?.trim() || 'WATCHED',

    // Badge style
    badgeBgColor: _getCssColorFromControls('badgeBgColor', 'badgeBgAlpha'),
    badgeTextColor: _getCssColorFromControls('badgeTextColor', 'badgeTextAlpha'),
    badgeBorderColor: _getCssColorFromControls('badgeBorderColor', 'badgeBorderAlpha'),
  });

  _syncBadgeOptionUI();
  _updateBadgePreview();

  await chrome.storage.local.set({
    historyIncludeShorts: $('historyIncludeShorts').checked,
  });

  $('saveStatus').textContent = 'Saved';
  setTimeout(() => $('saveStatus').textContent = '', 1200);
  notifyYouTubeTabsRefresh();
}

$('saveBtn').addEventListener('click', saveSettings);

// SQLite sync UI
$('sqliteSyncEnabled')?.addEventListener('change', async () => { await saveSqliteUI(); await refreshSqliteStatus(); });
$('sqliteServerUrl')?.addEventListener('change', async () => { await saveSqliteUI(); await refreshSqliteStatus(); await refreshSqliteServerAvailability({ force: true }); });
$('sqliteSyncIntervalMin')?.addEventListener('change', async () => { await saveSqliteUI(); await refreshSqliteStatus(); });

$('sqliteSyncNowBtn')?.addEventListener('click', async () => {
  const gate = await refreshSqliteServerAvailability({ force: true }).catch(() => ({ ok: false, reason: 'unreachable' }));
  if (!gate?.ok) {
    log(`Failed: you can sync only when the server (server.py) is running. (${gate?.reason || 'unreachable'})`);
    await refreshSqliteStatus();
    return;
  }

  const syncBtn = $('sqliteSyncNowBtn');
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.textContent = '싱크 중...';
  }

  log('Starting sync...');
  const resp = await sendRuntimeMessage({ type: 'SQLITE_SYNC_NOW' }).catch((e) => ({ ok: false, error: String(e) }));

  if (syncBtn) {
    syncBtn.disabled = false;
    syncBtn.textContent = '싱크하기';
  }
  // Clear progress
  const progressEl = $('syncProgress');
  if (progressEl) progressEl.textContent = '';

  if (!resp?.ok) {
    log(`Failed: ${resp?.error || 'unknown error'}`);
    await refreshSqliteStatus();
    return;
  }

  const fmt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : '?';
  };

  const parts = [];
  if (resp.forcedFull) parts.push('auto-restored from server');
  if (resp.sent > 0) parts.push(`↑ sent ${fmt(resp.sent)}`);
  if (resp.pulled > 0) parts.push(`↓ received ${fmt(resp.pulled)}`);
  if (!resp.sent && !resp.pulled && !resp.forcedFull) parts.push('Already up to date');
  parts.push(`server: ${fmt(resp.rowCount)} rows`);
  parts.push(`local: ${fmt(resp.localCount)} rows`);

  log(`Done: ${parts.join(' · ')}`);

  await refreshSqliteStatus();
  await refreshCount();
  await refreshStats();
  if (resp.pulled > 0 || resp.forcedFull) notifyYouTubeTabsRefresh();
});


// Restore from server (full download)
$('sqliteRestoreBtn')?.addEventListener('click', async () => {
  const gate = await refreshSqliteServerAvailability({ force: true }).catch(() => ({ ok: false, reason: 'unreachable' }));
  if (!gate?.ok) {
    log(`Failed: server is not running. (${gate?.reason || 'unreachable'})`);
    return;
  }

  const ok = confirm(
    '서버에서 전체 데이터를 새로 받습니다.\n'
    + '로컬 DB를 초기화하고 서버 데이터로 덮어씁니다.\n\n'
    + '계속하시겠습니까?'
  );
  if (!ok) return;

  const restoreBtn = $('sqliteRestoreBtn');
  const syncBtn = $('sqliteSyncNowBtn');
  if (restoreBtn) { restoreBtn.disabled = true; restoreBtn.textContent = '받는 중...'; }
  if (syncBtn) syncBtn.disabled = true;

  log('Restoring from server (full download)...');
  const resp = await sendRuntimeMessage({ type: 'SQLITE_RESTORE', wipe: true })
    .catch((e) => ({ ok: false, error: String(e) }));

  if (restoreBtn) { restoreBtn.disabled = false; restoreBtn.textContent = '서버에서 새로 받기'; }
  if (syncBtn) syncBtn.disabled = false;

  const progressEl = $('syncProgress');
  if (progressEl) progressEl.textContent = '';

  if (!resp?.ok) {
    log(`Restore failed: ${resp?.error || 'unknown error'}`);
    await refreshSqliteStatus();
    return;
  }

  log(`Restore complete: ${(resp.restored ?? 0).toLocaleString()} items downloaded from server`);
  await refreshSqliteStatus();
  await refreshCount();
  await refreshStats();
  notifyYouTubeTabsRefresh();
});


$('importHistoryAllBtn').addEventListener('click', async () => {
  const includeShorts = $('historyIncludeShorts').checked;
  const { historyMaxResults } = await chrome.storage.local.get(DEFAULT_UI);

  log(`Scanning entire browser history... (maxResults=${historyMaxResults || 100000})`);
  const resp = await sendRuntimeMessage({
    type: 'IMPORT_FROM_BROWSER_HISTORY_ALL',
    params: { maxResults: historyMaxResults || 100000, includeShorts }
  }).catch((e) => ({ ok: false, error: String(e) }));

  if (!resp?.ok) {
    log(`Failed: ${resp?.error || 'unknown error'}`);
    return;
  }

  log(`Done: scanned ${resp.scannedUrls?.toLocaleString?.() ?? resp.scannedUrls} URLs → found ${resp.found?.toLocaleString?.() ?? resp.found} videoIds → added ${resp.inserted?.toLocaleString?.() ?? resp.inserted} (including skips)`);
  await refreshCount();
  await refreshStats();
  notifyYouTubeTabsRefresh();
});

// Import from the YouTube Watch History page (with cancel support #7)
$('importYouTubeHistoryBtn')?.addEventListener('click', async () => {
  const btn = $('importYouTubeHistoryBtn');
  const cancelBtn = $('cancelYouTubeHistoryBtn');
  if (!btn) return;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Working...';
  if (cancelBtn) cancelBtn.style.display = '';

  log('Opening the YouTube Watch History page...');

  const resp = await sendRuntimeMessage({
    type: 'IMPORT_FROM_YOUTUBE_HISTORY_PAGE'
  }).catch((e) => ({ ok: false, error: String(e) }));

  btn.disabled = false;
  btn.textContent = originalText;
  if (cancelBtn) cancelBtn.style.display = 'none';

  if (!resp?.ok) {
    log(`Failed: ${resp?.error || 'unknown error'}`);
    return;
  }

  if (resp.cancelled) {
    log('Cancelled by user.');
    return;
  }

  log(`Done: collected ${resp.collected?.toLocaleString?.() ?? resp.collected} → inserted ${resp.inserted?.toLocaleString?.() ?? resp.inserted} (scrolled ${resp.scrollCount || 0} times)`);
  await refreshCount();
  await refreshStats();
  notifyYouTubeTabsRefresh();
});

$('cancelYouTubeHistoryBtn')?.addEventListener('click', () => {
  sendRuntimeMessage({ type: 'CANCEL_YOUTUBE_HISTORY_SCROLL' }).catch(() => { });
  log('Cancel requested...');
});


// Progress messages from background

// JSON import (Google Takeout or RuruGrab export)
$('importJsonBtn')?.addEventListener('click', () => {
  $('importJsonFile')?.click();
});

$('importJsonFile')?.addEventListener('change', async (e) => {
  const file = e.target?.files?.[0];
  if (!file) return;
  e.target.value = '';

  log(`Reading JSON file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`);

  try {
    const text = await file.text();
    const resp = await sendRuntimeMessage({ type: 'IMPORT_TAKEOUT', jsonText: text })
      .catch((err) => ({ ok: false, error: String(err) }));

    if (!resp?.ok) {
      log(`Failed: ${resp?.error || 'unknown error'}`);
    } else {
      log(`Done: parsed ${resp.parsed?.toLocaleString()} entries → found ${resp.found?.toLocaleString()} videoIds → added ${resp.inserted?.toLocaleString()}`);
    }
  } catch (err) {
    log(`Failed: ${err.message || err}`);
  }

  await refreshCount();
  await refreshStats();
  notifyYouTubeTabsRefresh();
});
$('exportBtn').addEventListener('click', async () => {
  log('Export: reading...');
  const all = await YT_DLP_DB.exportAll();
  const payload = {
    exportedAt: new Date().toISOString(),
    count: all.length,
    watched: all,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `rurugrab-watched-export-${Date.now()}.json`;
  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 1500);
  log(`Export: downloaded ${all.length.toLocaleString()} items`);
});

$('clearBtn').addEventListener('click', async () => {
  const ok = confirm('Delete all watch history?');
  if (!ok) return;
  await YT_DLP_DB.clearAll();
  log('Deleted all.');
  await refreshCount();
  notifyYouTubeTabsRefresh();
});

// Stats functions (#11)
async function refreshStats() {
  try {
    const stats = await YT_DLP_DB.getWatchStats({ days: 30 });

    // Total all time
    if ($('statsTotalAll')) $('statsTotalAll').textContent = stats.total.toLocaleString();

    // Last 7 days
    const now = new Date();
    const last7 = stats.daily
      .filter((d) => {
        const diff = (now - new Date(d.date)) / (24 * 60 * 60 * 1000);
        return diff <= 7;
      })
      .reduce((sum, d) => sum + d.count, 0);
    if ($('statsLast7')) $('statsLast7').textContent = last7.toLocaleString();

    // Last 30 days
    const last30 = stats.daily.reduce((sum, d) => sum + d.count, 0);
    if ($('statsLast30')) $('statsLast30').textContent = last30.toLocaleString();

    // Peak day
    if (stats.daily.length) {
      const peak = stats.daily.reduce((a, b) => (a.count >= b.count ? a : b));
      if ($('statsPeakDay')) $('statsPeakDay').textContent = peak.count.toLocaleString();
      if ($('statsPeakDayDate')) $('statsPeakDayDate').textContent = peak.date;
    } else {
      if ($('statsPeakDay')) $('statsPeakDay').textContent = '—';
      if ($('statsPeakDayDate')) $('statsPeakDayDate').textContent = '';
    }

    // Bar chart — last 14 days
    renderBarChart(stats.daily, 14);
  } catch (e) {
    console.error('Stats error:', e);
  }
}

function renderBarChart(dailyData, dayCount) {
  const chart = $('statsBarChart');
  if (!chart) return;
  chart.innerHTML = '';

  // Fill in missing days
  const days = [];
  const now = new Date();
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const found = dailyData.find((e) => e.date === key);
    days.push({
      date: key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      count: found?.count || 0,
    });
  }

  const maxCount = Math.max(1, ...days.map((d) => d.count));

  for (const day of days) {
    const bar = document.createElement('div');
    bar.className = 'statsBar';
    const heightPct = Math.max(2, (day.count / maxCount) * 100);
    bar.style.height = `${heightPct}%`;
    bar.dataset.label = day.label;
    if (day.count > 0) bar.dataset.count = String(day.count);
    bar.title = `${day.date}: ${day.count}`;
    chart.appendChild(bar);
  }
}

// Sync progress listener (#9)
chrome.runtime.onMessage?.addListener((msg) => {
  if (msg?.type === 'SQLITE_SYNC_PROGRESS') {
    const el = $('syncProgress');
    if (el) el.textContent = msg.message || '';
  }
});

(async () => {
  await loadUI();
  wireBadgeStyleUI();
  await refreshCount();
  startSqliteServerGate();
  refreshStats();

  // Advanced sync panel toggle
  $('advancedSyncToggle')?.addEventListener('click', () => {
    const panel = $('advancedSyncPanel');
    const btn = $('advancedSyncToggle');
    if (!panel || !btn) return;
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? '' : 'none';
    btn.textContent = hidden ? 'Advanced ▾' : 'Advanced ▸';
  });
})();

/* saveStatus animation patch */
const _origSaveSettings = typeof saveSettings !== 'undefined' ? saveSettings : null;
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('saveStatus');
  if (!statusEl) return;
  const observer = new MutationObserver(() => {
    if (statusEl.textContent.trim()) {
      statusEl.classList.add('visible');
    } else {
      statusEl.classList.remove('visible');
    }
  });
  observer.observe(statusEl, { childList: true, characterData: true, subtree: true });
});