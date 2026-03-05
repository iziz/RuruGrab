import { listen } from '@tauri-apps/api/event'

import { $, $$ } from './domUtils.js'
import { appendLog, appendGuiLog, renderSubTab, setActiveLogTab, logEntries } from './logger.js'
import { apiFetch, openPath } from './api.js'
import { API } from './config.js'
import { dom } from './dom.js'

import { refreshStatus, queueDownload, updateStatusUI, initDownloadsEvents } from './tabs/downloads/index.js'
import { refreshSqlite, initSqliteEvents } from './tabs/sqlite/index.js'
import { initOrganizerEvents } from './tabs/organizer/index.js'
import { initRenamerEvents, renLoadSettings } from './tabs/renamer/index.js'
import { initDupFinderEvents } from './tabs/dupfinder/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────────────────────────────────────
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'))
    $$('.tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    $(`#tab-${btn.dataset.tab}`)?.classList.add('active')
    if (btn.dataset.tab === 'sqlite') refreshSqlite()
  })
})

$$('.log-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.log-tab-btn').forEach((b) => b.classList.remove('active'))
    $$('.log-view').forEach((v) => v.classList.remove('active'))
    btn.classList.add('active')
    setActiveLogTab(btn.dataset.log)
    $(`#log-${btn.dataset.log}`)?.classList.add('active')
    if (btn.dataset.log !== 'all') renderSubTab(btn.dataset.log)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Server tab button wiring
// ─────────────────────────────────────────────────────────────────────────────
$('#btnOpenUrl')?.addEventListener('click', () => openPath(API))
$('#btnCopyUrl')?.addEventListener('click', () => {
  navigator.clipboard.writeText(API).catch(() => { })
  appendGuiLog('[GUI] URL copied to clipboard')
})
$('#btnOpenSqlite')?.addEventListener('click', () => {
  const p = String(dom.pathSqlite?.textContent ?? '').trim()
  if (p && p !== '-') openPath(p)
})
$('#btnOpenDownloads')?.addEventListener('click', () => {
  const p = String(dom.pathDownloads?.textContent ?? '').trim()
  if (p && p !== '-') openPath(p)
})
$('#btnDownload')?.addEventListener('click', queueDownload)
$('#btnClearLogs')?.addEventListener('click', () => {
  logEntries.length = 0
  $$('.log-view').forEach((v) => { v.innerHTML = '' })
})

// ─────────────────────────────────────────────────────────────────────────────
// Logs from server buffer
// ─────────────────────────────────────────────────────────────────────────────
async function loadLogs(maxLines = 2000) {
  try {
    const json = await apiFetch(`/logs?lines=${maxLines}`)
    const lines = Array.isArray(json?.lines) ? json.lines : []
    lines.forEach((line) => appendLog(line))
    if (!lines.length) appendGuiLog('[GUI] (no logs yet)')
  } catch (e) {
    appendGuiLog(`[GUI] logs fetch failed: ${String(e)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri event listeners
// ─────────────────────────────────────────────────────────────────────────────
; (async () => {
  try {
    await listen('rurugrab:log', (e) => {
      if (typeof e.payload === 'string') appendLog(e.payload)
    })
    await listen('rurugrab:status', (e) => {
      updateStatusUI(e.payload || {})
    })
  } catch (e) {
    appendGuiLog(`[GUI] tauri listen unavailable: ${String(e)}`)
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// Polling fallback
// ─────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  refreshStatus().catch(() => { })
}, 2000)

// ─────────────────────────────────────────────────────────────────────────────
// Initialize all tab modules
// ─────────────────────────────────────────────────────────────────────────────
initDownloadsEvents()
initSqliteEvents()
await initOrganizerEvents()
await initRenamerEvents()
await initDupFinderEvents()
void renLoadSettings()

// Initial data load
loadLogs(2000)
refreshStatus()
