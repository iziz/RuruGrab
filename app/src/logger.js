import { dom } from './dom.js'
import { escHtml } from './domUtils.js'

// ─────────────────────────────────────────────────────────────────────────────
// Logging (ring buffer)
// ─────────────────────────────────────────────────────────────────────────────
export const LOG_MAX_LINES = 1024
export const logEntries = [] // { kind, html }
export let activeLogTab = 'all'

export function setActiveLogTab(tab) {
  activeLogTab = tab
}

export function classifyLog(line) {
  const s = String(line ?? '').trim()
  const low = s.toLowerCase()

  if (low.includes('traceback') || low.includes('exception') || /\berror\b/.test(low)) return 'error'
  if (low.includes('[sync') || low.includes('sync_watched') || low.includes('watched_export') || low.includes('watched_count')) return 'sync'
  if (low.includes('[download') || low.includes('[작업') || s.includes('[큐') || low.includes('yt-dlp')) return 'download'
  if (/"?\b(GET|POST|PUT|PATCH|DELETE)\b\s+\//.test(s) || /\b(GET|POST|PUT|PATCH|DELETE)\b\s+\//.test(s)) return 'access'
  return 'other'
}

function appendToView(view, html) {
  if (!view) return
  const wasBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 30
  const el = document.createElement('div')
  el.innerHTML = html
  view.appendChild(el)
  if (wasBottom) view.scrollTop = view.scrollHeight
}

function trimAllView() {
  if (!dom.logAll) return
  while (dom.logAll.children.length > LOG_MAX_LINES) {
    dom.logAll.removeChild(dom.logAll.firstChild)
  }
}

export function renderSubTab(kind) {
  const viewMap = { access: dom.logAccess, sync: dom.logSync, download: dom.logDownload, error: dom.logError }
  const view = viewMap[kind]
  if (!view) return

  view.innerHTML = ''
  for (const e of logEntries) {
    if (e.kind === kind) {
      const el = document.createElement('div')
      el.innerHTML = e.html
      view.appendChild(el)
    }
  }
  view.scrollTop = view.scrollHeight
}

export function appendLog(line, kind) {
  const k = kind || classifyLog(line)
  const html = `<span class="log-${k}">${escHtml(line)}</span>`

  logEntries.push({ kind: k, html })
  while (logEntries.length > LOG_MAX_LINES) logEntries.shift()

  appendToView(dom.logAll, html)
  trimAllView()

  if (activeLogTab === k) {
    const viewMap = { access: dom.logAccess, sync: dom.logSync, download: dom.logDownload, error: dom.logError }
    if (viewMap[k]) appendToView(viewMap[k], html)
  }
}

export function appendGuiLog(msg) {
  const html = `<span class="log-gui">${escHtml(msg)}</span>`
  logEntries.push({ kind: 'gui', html })
  while (logEntries.length > LOG_MAX_LINES) logEntries.shift()

  appendToView(dom.logAll, html)
  trimAllView()
}
