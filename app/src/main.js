import { listen } from '@tauri-apps/api/event'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'

// Config / Environment
const isTauri =
  typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
  typeof window.__TAURI__ !== 'undefined' ||
  window.location.protocol.startsWith('tauri')

const API = isTauri
  ? 'http://127.0.0.1:5000'
  : (window.location.origin === 'http://localhost:5173'
    ? 'http://127.0.0.1:5000'
    : window.location.origin)

// Thumbnail cache
const thumbSrcCache = new Map() // key: raw string -> converted src

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

const dom = {
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

// null-safe setter
function setText(el, text) {
  if (!el) return
  el.textContent = text == null ? '' : String(text)
}
function setHtml(el, html) {
  if (!el) return
  el.innerHTML = html
}

// Security: HTML escape
function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Tauri: URL open
async function openPath(pathOrUrl) {
  try {
    await invoke('plugin:shell|open', { path: pathOrUrl })
  } catch (e) {
    appendGuiLog(`[GUI] open failed: ${String(e)}`)
  }
}

// Thumbnail src transform
function toThumbSrc(raw) {
  const r0 = String(raw ?? '').trim()
  if (!r0) return ''

  if (/^(data:|blob:|asset:)/i.test(r0)) return r0

  try {
    const u = new URL(r0, window.location.href)
    if (u.pathname.endsWith('/thumbnail_proxy') && u.searchParams.has('url')) {
      return u.toString()
    }
  } catch { /* ignore */ }

  if (/^https?:\/\//i.test(r0)) {
    return `${API}/thumbnail_proxy?url=${encodeURIComponent(r0)}`
  }

  if (!isTauri) return r0

  const key = r0
  const cached = thumbSrcCache.get(key)
  if (cached) return cached
  const converted = convertFileSrc(r0)
  thumbSrcCache.set(key, converted)
  return converted
}

// Logging (ring buffer)
const LOG_MAX_LINES = 1024
const logEntries = [] // { kind, html }
let activeLogTab = 'all'

function classifyLog(line) {
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

function renderSubTab(kind) {
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

function appendLog(line, kind) {
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

function appendGuiLog(msg) {
  const html = `<span class="log-gui">${escHtml(msg)}</span>`
  logEntries.push({ kind: 'gui', html })
  while (logEntries.length > LOG_MAX_LINES) logEntries.shift()

  appendToView(dom.logAll, html)
  trimAllView()
}

// API helpers
async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts)
  const text = await res.text()

  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (!res.ok) {
    const msg = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)
    throw new Error(`HTTP ${res.status}: ${msg}`)
  }
  return body
}

// Tabs
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
    activeLogTab = btn.dataset.log
    $(`#log-${activeLogTab}`)?.classList.add('active')
    if (activeLogTab !== 'all') renderSubTab(activeLogTab)
  })
})


// Status / Downloads rendering
let lastDownloadsSig = ''
let downloadsById = new Map() // id -> row
let dlNodeById = new Map() // id -> HTMLElement (DOM node cache)
let selectedTaskId = null

function humanBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '-'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let x = v
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${x.toFixed(1)} ${units[i]}`
}

function formatTime(secs) {
  const s = Number(secs)
  if (!Number.isFinite(s) || s <= 0) return ''
  if (s < 60) return `${Math.floor(s)}s`
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  if (m < 60) return `${m}m ${ss}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function normStatus(s) {
  const t = String(s ?? '').trim().toLowerCase()
  if (!t) return '-'
  if (['finished', 'complete', 'completed', 'done'].includes(t)) return 'done'
  if (['downloading', 'download', 'running', 'active'].includes(t)) return 'downloading'
  if (['error', 'failed', 'fail'].includes(t)) return 'error'
  if (['cancelled', 'canceled', 'cancel'].includes(t)) return 'cancelled'
  return t
}

// normalize for display persent
function normPercent(percent, downloadedBytes, totalBytes) {
  let p = Number(percent)
  if (Number.isFinite(p) && p > 0) {
    if (p <= 1) p *= 100
    return Math.min(100, Math.max(0, p))
  }

  const dl = Number(downloadedBytes)
  const tot = Number(totalBytes)
  if (Number.isFinite(dl) && Number.isFinite(tot) && dl > 0 && tot > 0) {
    return Math.min(100, Math.max(0, (dl / tot) * 100))
  }
  return 0
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (host === 'youtu.be') {
      const id = u.pathname.replace('/', '').trim()
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : ''
    }
    if (host.includes('youtube.com')) {
      const v = u.searchParams.get('v')
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v
      const m1 = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/)
      if (m1) return m1[1]
      const m2 = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/)
      if (m2) return m2[1]
    }
  } catch { /* ignore */ }
  return ''
}

function siteTagFromUrl(url) {
  const u = String(url ?? '').toLowerCase()
  if (!u) return null

  if (u.includes('youtube.com') || u.includes('youtu.be')) return { text: 'YouTube', cls: 'tag-youtube' }
  if (u.includes('instagram.com')) return { text: 'Instagram', cls: 'tag-instagram' }
  if (u.includes('twitter.com') || u.includes('x.com')) return { text: 'X', cls: 'tag-x' }
  if (u.includes('pinterest.com')) return { text: 'Pinterest', cls: 'tag-pinterest' }
  if (u.includes('tiktok.com')) return { text: 'TikTok', cls: 'tag-tiktok' }
  if (u.includes('pixiv.net')) return { text: 'Pixiv', cls: 'tag-other' }
  return { text: 'Other', cls: 'tag-other' }
}

function downloadSignature(items) {
  return JSON.stringify(
    items.map((r) => {
      const id = String(r?.id ?? '')
      const st = normStatus(r?.status)
      const total = r?.total_bytes || 0
      const pct = Math.round(normPercent(r?.percent, r?.downloaded_bytes, total) * 10) / 10
      return [
        id,
        st,
        pct,
        r?.downloaded_bytes || 0,
        total || 0,
        r?.eta || 0,
        r?.speed || 0,
        r?.downloaded_items || 0,
        r?.total_items || 0,
        r?.title || '',
        r?.url || '',
        r?.thumbnail || '',
        r?.video_id || '',
        r?.resolution || '',
      ]
    })
  )
}

function buildMetaText(row) {
  const parts = []

  if (row.duration) {
    const raw = String(row.duration)
    const nums = raw.split(':').map((x) => Number(x))
    if (nums.every((x) => Number.isFinite(x))) {
      while (nums.length < 3) nums.unshift(0)
      parts.push(nums.map((n) => String(n).padStart(2, '0')).join(':'))
    } else {
      parts.push(raw)
    }
  }
  if (row.resolution && row.resolution !== 'NA') parts.push(String(row.resolution))
  if (row.fps) parts.push(`${row.fps}fps`)
  if (row.tbr) {
    const tbr = Number(row.tbr)
    if (Number.isFinite(tbr) && tbr > 0) {
      parts.push(tbr >= 1000 ? `${(tbr / 1000).toFixed(1)} Mbps` : `${Math.round(tbr)} Kbps`)
    }
  }
  if (row.uploader || row.channel) parts.push(String(row.uploader || row.channel))

  return parts.join(' · ')
}

function buildProgressText(row, st, pct, totalBytes, downloadedBytes) {
  const parts = []

  // status
  let stLabel = ''
  if (st === 'done') stLabel = 'download complete'
  else if (st === 'error') stLabel = 'error'
  else if (st === 'cancelled') stLabel = 'canceled'
  else if (pct > 0) stLabel = `${pct.toFixed(1)}% download`
  else stLabel = st === 'starting' ? 'preparing...' : (st === 'queued' ? 'ready' : st)

  parts.push(stLabel)

  // mult-item
  if (row.total_items && Number(row.total_items) > 1) {
    const total = Number(row.total_items) || 0
    const isDoneLike = (st === 'done' || st === 'error' || st === 'cancelled')
    const doneItems = isDoneLike ? total : (Number(row.downloaded_items) || 0)
    parts.push(`${total} / ${doneItems} done`)
  }

  // size
  const total = Number(totalBytes)
  const dl = Number(downloadedBytes)
  if (Number.isFinite(dl) && dl > 0 && Number.isFinite(total) && total > 0) {
    parts.push(`${humanBytes(dl)} of ${humanBytes(total)}`)
  } else if (Number.isFinite(total) && total > 0) {
    parts.push(humanBytes(total))
  }

  // ETA / speed
  if (row.eta) parts.push(`${formatTime(row.eta)} left`)
  if (typeof row.speed === 'number' && row.speed > 0) parts.push(`${humanBytes(row.speed)}/s`)

  return parts.filter(Boolean).join(' · ')
}

function setThumbWithPlaceholder(img, placeholder, thumbUrl) {
  if (!img || !placeholder) return

  const next = String(thumbUrl || '')
  const cur = String(img.dataset.src || '')
  const state = String(img.dataset.state || 'idle')
  const lastTry = Number(img.dataset.lastTry || 0)
  const now = Date.now()

  if (!next) {
    if (cur && state === 'loaded') return

    img.dataset.src = ''
    img.dataset.state = 'idle'
    img.dataset.pendingSrc = ''
    img.dataset.pendingN = '0'
    img.removeAttribute('src')
    img.style.display = 'none'
    placeholder.style.display = 'block'
    return
  }

  // same URL: don't thrash. If previous load failed, retry with backoff.
  if (cur === next) {
    if (state === 'error' && (now - lastTry) > 10_000) {
      img.dataset.lastTry = String(now)
      img.dataset.state = 'loading'
      placeholder.style.display = (cur && img.style.display !== 'none') ? 'none' : 'block'
      img.src = next
    }
    return
  }

  const CONFIRM_N = 2
  const pendingSrc = String(img.dataset.pendingSrc || '')
  const pendingN = Number(img.dataset.pendingN || 0)

  if (cur && state === 'loaded') {
    if (pendingSrc !== next) {
      img.dataset.pendingSrc = next
      img.dataset.pendingN = '1'
      return
    }
    const n2 = pendingN + 1
    img.dataset.pendingN = String(n2)
    if (n2 < CONFIRM_N) return
  }

  img.dataset.pendingSrc = ''
  img.dataset.pendingN = '0'

  const keepCurrentVisible = !!cur && state === 'loaded' && img.style.display !== 'none'
  const token = String((Number(img.dataset.swapToken || 0) + 1) % 1_000_000)
  img.dataset.swapToken = token
  img.dataset.lastTry = String(now)
  img.dataset.state = 'loading'

  if (!keepCurrentVisible) {
    placeholder.style.display = 'block'
    img.style.display = 'none'
  } else {
    placeholder.style.display = 'none'
    img.style.display = 'block'
  }

  const pre = new Image()
  pre.onload = () => {
    if (img.dataset.swapToken !== token) return
    img.dataset.src = next
    img.src = next
    if (img.complete && img.naturalWidth > 0) {
      img.dataset.state = 'loaded'
      placeholder.style.display = 'none'
      img.style.display = 'block'
    }
  }
  pre.onerror = () => {
    if (img.dataset.swapToken !== token) return
    img.dataset.state = 'error'
    if (!keepCurrentVisible) {
      img.style.display = 'none'
      placeholder.style.display = 'block'
    }
  }
  pre.src = next
}

function createDlItem(taskId) {
  const root = document.createElement('div')
  root.className = 'dl-item'
  if (taskId) root.dataset.taskId = taskId

  const thumbWrap = document.createElement('div')
  thumbWrap.className = 'dl-thumb'

  const img = document.createElement('img')
  img.className = 'dl-thumb-img'
  img.alt = ''
  img.style.display = 'none'
  img.dataset.state = 'idle'
  img.dataset.src = ''

  const placeholder = document.createElement('div')
  placeholder.className = 'dl-thumb-placeholder'
  placeholder.style.display = 'block'

  const duration = document.createElement('span')
  duration.className = 'dl-thumb-duration'
  duration.style.display = 'none'

  img.addEventListener('load', () => {
    img.dataset.state = 'loaded'
    placeholder.style.display = 'none'
    img.style.display = 'block'
  })
  img.addEventListener('error', () => {
    img.dataset.state = 'error'
    img.style.display = 'none'
    placeholder.style.display = 'block'
  })

  thumbWrap.appendChild(img)
  thumbWrap.appendChild(placeholder)
  thumbWrap.appendChild(duration)

  const body = document.createElement('div')
  body.className = 'dl-item-body'

  const titleRow = document.createElement('div')
  titleRow.className = 'dl-title-row'

  const siteTag = document.createElement('span')
  siteTag.className = 'site-tag tag-other'
  siteTag.style.display = 'none'

  const title = document.createElement('div')
  title.className = 'dl-title'
  title.title = ''

  titleRow.appendChild(siteTag)
  titleRow.appendChild(title)

  const meta2 = document.createElement('div')
  meta2.className = 'dl-meta2'
  meta2.style.display = 'none'

  const progressContainer = document.createElement('div')
  progressContainer.className = 'dl-progress-container'

  const barBg = document.createElement('div')
  barBg.className = 'dl-progress-bar-bg'

  const barFill = document.createElement('div')
  barFill.className = 'dl-progress-fill active-fill'
  barFill.style.width = '0%'

  barBg.appendChild(barFill)

  const progressText = document.createElement('div')
  progressText.className = 'dl-progress-text'

  progressContainer.appendChild(barBg)
  progressContainer.appendChild(progressText)

  body.appendChild(titleRow)
  body.appendChild(meta2)
  body.appendChild(progressContainer)

  const menuBtn = document.createElement('button')
  menuBtn.className = 'dl-menu-btn'
  menuBtn.title = 'Actions'
  menuBtn.textContent = '⋯'

  root.appendChild(thumbWrap)
  root.appendChild(body)
  root.appendChild(menuBtn)

  root._refs = { img, placeholder, duration, siteTag, title, meta2, barBg, barFill, progressText }

  return root
}

function updateDlItem(el, row) {
  const refs = el?._refs
  if (!refs) return

  const st = normStatus(row?.status)
  const totalBytes = row?.total_bytes || row?.total_bytes_estimate || row?.filesize || 0
  const downloadedBytes = row?.downloaded_bytes || 0
  const pct = normPercent(row?.percent, downloadedBytes, totalBytes)

  const isDone = st === 'done'
  const isError = (st === 'error' || st === 'cancelled')
  const hideBar = isDone || isError
  const progressFillClass = isError ? 'error-fill' : (isDone ? 'done-fill' : 'active-fill')

  // thumb URL 
  let rawThumb = row?.thumbnail || ''
  const url = String(row?.url ?? '')
  const ytId = String(row?.video_id ?? '') || extractYouTubeId(url)
  if (!rawThumb && ytId) rawThumb = `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`
  const thumbUrl = toThumbSrc(rawThumb)

  setThumbWithPlaceholder(refs.img, refs.placeholder, thumbUrl)

  // duration badge
  if (row?.duration) {
    refs.duration.textContent = String(row.duration)
    refs.duration.style.display = ''
  } else {
    refs.duration.textContent = ''
    refs.duration.style.display = 'none'
  }

  // title + tooltip
  const titleRaw = String(row?.title ?? '').trim()
  const fallbackTitle = isDone ? (url || 'Unknown') : 'Loading metadata...'
  const displayTitle = titleRaw || fallbackTitle

  refs.title.textContent = displayTitle
  refs.title.title = titleRaw || url || ''

  // site tag
  const tag = siteTagFromUrl(url)
  if (tag) {
    refs.siteTag.textContent = tag.text
    refs.siteTag.className = `site-tag ${tag.cls}`
    refs.siteTag.style.display = ''
  } else {
    refs.siteTag.textContent = ''
    refs.siteTag.style.display = 'none'
  }

  // meta line
  const metaText = buildMetaText(row)
  if (metaText) {
    refs.meta2.textContent = metaText
    refs.meta2.style.display = ''
  } else {
    refs.meta2.textContent = ''
    refs.meta2.style.display = 'none'
  }

  // progress bar
  refs.barBg.classList.toggle('hidden', !!hideBar)
  refs.barFill.className = `dl-progress-fill ${progressFillClass}`
  refs.barFill.style.width = `${pct}%`

  // progress text
  const progressText = buildProgressText(row, st, pct, totalBytes, downloadedBytes) || url
  refs.progressText.textContent = progressText
  refs.progressText.classList.toggle('text-error', !!isError)
}

function updateDownloadList(itemsRaw) {
  const items = Array.isArray(itemsRaw) ? itemsRaw : []

  // state map (context menu)
  downloadsById = new Map()
  const ids = []
  for (const r of items) {
    const id = String(r?.id ?? '')
    if (!id) continue
    downloadsById.set(id, r)
    ids.push(id)
  }

  const sig = downloadSignature(items)
  if (sig === lastDownloadsSig) return
  lastDownloadsSig = sig

  if (!dom.dlList) return

  const EMPTY_ID = 'dlEmpty'
  if (!ids.length) {
    // empty-state
    dom.dlList.innerHTML =
      `<div id="${EMPTY_ID}" class="text-muted" style="padding:40px;text-align:center;font-size:14px;">Download list is empty</div>`
    dlNodeById.clear()
    return
  }

  // empty-state
  const emptyEl = dom.dlList.querySelector(`#${EMPTY_ID}`)
  if (emptyEl) {
    emptyEl.remove()
  } else {
    const legacy = Array.from(dom.dlList.children).find((el) =>
      (el?.textContent || '').includes('Download list is empty')
    )
    if (legacy) legacy.remove()
  }

  // remove missing nodes
  const live = new Set(ids)
  for (const [id, node] of dlNodeById.entries()) {
    if (!live.has(id)) {
      node.remove()
      dlNodeById.delete(id)
    }
  }

  // create/update + reorder in server order
  for (const id of ids) {
    const row = downloadsById.get(id) || {}
    let node = dlNodeById.get(id)
    if (!node) {
      node = createDlItem(id)
      dlNodeById.set(id, node)
    }
    updateDlItem(node, row)
    dom.dlList.appendChild(node) // existing node -> move only
  }
}

function updateStatusUI(stRaw) {
  const st = stRaw || {}
  const running = !!st.worker_alive

  if (dom.statusDot) dom.statusDot.className = `status-dot ${running ? 'running' : 'stopped'}`
  setText(dom.statusText, running ? 'RUNNING' : 'STOPPED')
  setText(dom.statusUrl, API)

  if (st.sqlite_path) setText(dom.pathSqlite, st.sqlite_path)
  if (st.download_dir) setText(dom.pathDownloads, st.download_dir)

  setText(dom.dlQueueSize, String(st.queue_size || 0))
  setText(dom.dlWorkerAlive, running ? 'alive' : 'stopped')

  updateDownloadList(st.downloads || [])
}

// Context menu
function showCtxMenuForTask(taskId, x, y) {
  const menu = dom.ctxMenu
  if (!menu) return

  selectedTaskId = taskId

  // render off-screen first to measure size
  menu.style.left = '-9999px'
  menu.style.top = '-9999px'
  menu.classList.add('visible')

  const rect = menu.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  // clamp so the menu stays within the viewport
  let finalX = x
  let finalY = y
  if (x + rect.width > vw) finalX = Math.max(0, vw - rect.width - 8)
  if (y + rect.height > vh) finalY = Math.max(0, vh - rect.height - 8)

  menu.style.left = `${finalX}px`
  menu.style.top = `${finalY}px`

  // disable cancel if already done/error/cancelled
  const row = downloadsById.get(taskId) || {}
  const st = normStatus(row.status)
  const cancelBtn = menu.querySelector('[data-action="cancel"]')
  if (cancelBtn) {
    if (['done', 'error', 'cancelled', '-'].includes(st)) {
      cancelBtn.style.opacity = '0.4'
      cancelBtn.style.pointerEvents = 'none'
    } else {
      cancelBtn.style.opacity = '1'
      cancelBtn.style.pointerEvents = 'auto'
    }
  }
}

function hideCtxMenu() {
  if (!dom.ctxMenu) return
  dom.ctxMenu.classList.remove('visible')
  selectedTaskId = null
}

document.addEventListener('click', (e) => {
  if (!dom.ctxMenu) return
  if (!dom.ctxMenu.contains(e.target)) hideCtxMenu()
})

// ctx menu: event delegation
function normalizeCtxAction(actionRaw) {
  const a = String(actionRaw || '').trim().toLowerCase()
  if (!a) return ''
  // normalize
  if (a === 'remove' || a === 'remove-list' || a === 'remove-from-list') return 'delete'
  if (a === 'delete-list' || a === 'delete-from-list') return 'delete'
  if (a === 'canceled') return 'cancelled'
  return a
}

if (dom.ctxMenu) {
  dom.ctxMenu.addEventListener('click', async (e) => {
    const btn = e.target.closest('.ctx-menu-item')
    if (!btn) return

    const action0 = normalizeCtxAction(btn.dataset.action)
    const taskId = selectedTaskId
    hideCtxMenu()
    if (!taskId) return

    if (action0 === 'delete-files') {
      if (!confirm('All related files will be deleted. Do you want to continue?')) return
      await callDownloadAction(taskId, 'delete', true)
    } else if (action0) {
      await callDownloadAction(taskId, action0, false)
    }
  })
}

// downloads list: event delegation
if (dom.dlList) {
  dom.dlList.addEventListener('click', (e) => {
    const btn = e.target.closest('.dl-menu-btn')
    if (!btn) return
    const item = btn.closest('.dl-item')
    const taskId = item?.dataset?.taskId
    if (!taskId) return
    e.stopPropagation()
    showCtxMenuForTask(taskId, e.clientX, e.clientY)
  })

  dom.dlList.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.dl-item')
    const taskId = item?.dataset?.taskId
    if (!taskId) return
    e.preventDefault()
    showCtxMenuForTask(taskId, e.clientX, e.clientY)
  })
}

async function callDownloadAction(taskId, action, deleteFiles) {
  try {
    const idNum = Number(taskId)
    const payload = {
      // Since the backend often expects i64, send it as a number,
      // but fall back to the original value if parsing fails.
      id: Number.isFinite(idNum) ? idNum : taskId,
      action,
      delete_files: !!deleteFiles,
    }

    const res = await apiFetch('/download_action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    appendGuiLog(`[GUI] download_action id=${payload.id} action=${action} delete_files=${payload.delete_files} → ${JSON.stringify(res)}`)
    await refreshStatus()
  } catch (e) {
    appendGuiLog(`[GUI] download_action failed: ${String(e)}`)
  }
}

// Refresh status / queue download
async function refreshStatus() {
  try {
    const json = await apiFetch('/status')
    updateStatusUI(json)
  } catch {
    if (dom.statusDot) dom.statusDot.className = 'status-dot stopped'
    setText(dom.statusText, 'OFFLINE')
  }
}

async function queueDownload() {
  const url = String(dom.videoUrl?.value ?? '').trim()
  const title = String(dom.dlTitle?.value ?? '').trim()
  if (!url) return

  try {
    const json = await apiFetch('/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title: title || undefined, cookies: [] }),
    })
    appendGuiLog(`[GUI] /download → ${JSON.stringify(json)}`)
    if (dom.videoUrl) dom.videoUrl.value = ''
    if (dom.dlTitle) dom.dlTitle.value = ''
    await refreshStatus()
  } catch (e) {
    appendGuiLog(`[GUI] /download failed: ${String(e)}`)
  }
}

// Logs from server buffer
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

// SQLite viewer
let sqliteDebounce = null

async function refreshSqlite() {
  const filter = String(dom.sqliteFilter?.value ?? '').trim()

  try {
    const countJson = await apiFetch('/watched_count')
    const total = countJson?.count || 0

    const exportJson = await apiFetch(`/watched_export?page=0&page_size=100`)
    let rows = exportJson?.records || []

    if (filter) {
      const lf = filter.toLowerCase()
      rows = rows.filter((r) => String(r?.id ?? '').toLowerCase().includes(lf))
    }

    setText(dom.sqliteCount, `Rows: ${total} (showing ${rows.length})`)

    if (dom.sqliteBody) {
      dom.sqliteBody.innerHTML = ''
      for (const r of rows) {
        const tr = document.createElement('tr')
        tr.innerHTML = `<td>${escHtml(r?.id)}</td><td>${escHtml(r?.ts)}</td><td>${escHtml(r?.updated_at || '-')}</td>`
        dom.sqliteBody.appendChild(tr)
      }
    }
  } catch (e) {
    setText(dom.sqliteCount, 'Error')
    appendGuiLog(`[GUI] sqlite refresh failed: ${String(e)}`)
  }
}

if (dom.sqliteFilter) {
  dom.sqliteFilter.addEventListener('input', () => {
    clearTimeout(sqliteDebounce)
    sqliteDebounce = setTimeout(refreshSqlite, 250)
  })
}

// Buttons / UI events
$('#btnDownload')?.addEventListener('click', queueDownload)
$('#btnClearLogs')?.addEventListener('click', () => {
  logEntries.length = 0
  $$('.log-view').forEach((v) => { v.innerHTML = '' })
})

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

// Enter key on URL input
if (dom.videoUrl) {
  dom.videoUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') queueDownload()
  })
}

// Tauri event listeners
; (async () => {
  try {
    await listen('utubeholic:log', (e) => {
      if (typeof e.payload === 'string') appendLog(e.payload)
    })
    await listen('utubeholic:status', (e) => {
      updateStatusUI(e.payload || {})
    })
  } catch (e) {
    appendGuiLog(`[GUI] tauri listen unavailable: ${String(e)}`)
  }
})()

// Polling fallback
setInterval(() => {
  refreshStatus().catch(() => { })
}, 2000)

// Initial load
loadLogs(2000)
refreshStatus()

// ─────────────────────────────────────────────────────────────────────────────
// Organizer
// ─────────────────────────────────────────────────────────────────────────────
const org = {
  statusDot: $('#orgStatusDot'),
  statusText: $('#orgStatusText'),
  statusPath: $('#orgStatusPath'),
  btnPickFolder: $('#orgBtnPickFolder'),
  btnScan: $('#orgBtnScan'),
  btnRun: $('#orgBtnRun'),
  summary: $('#orgSummary'),
  progressFill: $('#orgProgressFill'),
  progressText: $('#orgProgressText'),
  progressFile: $('#orgProgressFile'),
  previewBody: $('#orgPreviewBody'),
  regex: $('#orgRegex'),
}

let organizerFolder = null

function orgGetCollision() {
  const el = document.querySelector('input[name="orgCollision"]:checked')
  return el ? el.value : 'suffix'
}

function orgSetStatus(mode, text) {
  if (org.statusText) org.statusText.textContent = text
  if (!org.statusDot) return
  org.statusDot.classList.remove('running', 'stopped', 'ready')
  if (mode === 'running' || mode === 'done') org.statusDot.classList.add('running')
  else if (mode === 'ready') org.statusDot.classList.add('ready')
  else org.statusDot.classList.add('stopped')
}

function orgSetBusy(b) {
  for (const el of [org.btnPickFolder, org.btnScan, org.btnRun]) {
    if (el) el.disabled = b
  }
}

function orgSetProgress(done, total, filename) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  if (org.progressFill) org.progressFill.style.width = `${pct}%`
  if (org.progressText) org.progressText.textContent = `${done} / ${total}`
  if (org.progressFile) org.progressFile.textContent = filename ? ` • ${filename}` : ''
}

function orgEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c] || c
  })
}

function orgRenderPreview(result) {
  if (!org.previewBody) return
  if (!result.groups || result.groups.length === 0) {
    org.previewBody.innerHTML = `<tr><td class="text-muted">No matching files found.</td></tr>`
    return
  }
  const rows = []
  for (const g of result.groups) {
    const destDir = g.files.length > 0 ? g.files[0].to.replace(/[/\\][^/\\]+$/, '') : g.prefix
    rows.push(`<tr class="group-header-row"><td>
      <span class="folder-icon">📁</span>
      <span class="dest-path">${orgEscapeHtml(destDir)}</span>
      <span class="group-count">${g.files.length} items</span>
    </td></tr>`)
    for (let i = 0; i < g.files.length; i++) {
      const f = g.files[i]
      const isLast = i === g.files.length - 1
      rows.push(`<tr class="file-row"><td>
        <div class="file-entry${isLast ? ' is-last' : ''}">
          <span class="file-name">${orgEscapeHtml(f.name)}</span>
        </div>
      </td></tr>`)
    }
  }
  org.previewBody.innerHTML = rows.join('')
}

async function orgPickFolder() {
  const selected = await openFileDialog({ directory: true, multiple: false })
  if (!selected || Array.isArray(selected)) return
  organizerFolder = selected
  if (org.statusPath) org.statusPath.textContent = selected
  if (org.previewBody) org.previewBody.innerHTML = `<tr><td class="text-muted">Scanning...</td></tr>`
  orgSetProgress(0, 0, '')
  await orgScan()
}

async function orgScan() {
  if (!organizerFolder) {
    if (org.summary) org.summary.textContent = 'Please select a folder first.'
    orgSetStatus('error', 'ERROR')
    return
  }
  orgSetBusy(true)
  orgSetStatus('running', 'SCANNING')
  if (org.summary) org.summary.textContent = 'Scanning...'
  try {
    const result = await invoke('scan_folder', {
      folder: organizerFolder,
      regexStr: org.regex ? org.regex.value : '^([A-Za-z0-9]{2,8})-(.+)'
    })
    orgRenderPreview(result)
    if (org.summary) org.summary.textContent = `Total: ${result.totalFiles} files / Matched: ${result.matchedFiles} / Groups: ${result.groups.length}`
    orgSetStatus('done', 'READY')
  } catch (e) {
    if (org.summary) org.summary.textContent = `Scan failed: ${String(e)}`
    orgSetStatus('error', 'ERROR')
  } finally {
    orgSetBusy(false)
  }
}

async function orgRunMove() {
  if (!organizerFolder) {
    if (org.summary) org.summary.textContent = 'Please select a folder first.'
    orgSetStatus('error', 'ERROR')
    return
  }
  orgSetBusy(true)
  orgSetStatus('running', 'RUNNING')
  if (org.summary) org.summary.textContent = 'Running...'
  orgSetProgress(0, 0, '')
  try {
    await invoke('start_move', {
      folder: organizerFolder,
      collision: orgGetCollision(),
      regexStr: org.regex ? org.regex.value : '^([A-Za-z0-9]{2,8})-(.+)'
    })
  } catch (e) {
    if (org.summary) org.summary.textContent = `Execution failed: ${String(e)}`
    orgSetStatus('error', 'ERROR')
    orgSetBusy(false)
  }
}

org.btnPickFolder?.addEventListener('click', () => void orgPickFolder())
org.btnScan?.addEventListener('click', () => void orgScan())
org.btnRun?.addEventListener('click', () => void orgRunMove())

await listen('organizer:move_progress', (event) => {
  const p = event.payload
  orgSetProgress(p.done, p.total, p.filename)
})
await listen('organizer:move_finished', (event) => {
  const r = event.payload
  if (org.summary) org.summary.textContent = `Done: moved=${r.moved}, skipped=${r.skipped}, failed=${r.failed}, folders=${r.createdFolders}`
  orgSetStatus(r.failed > 0 ? 'error' : 'done', 'READY')
  orgSetBusy(false)
})
await listen('organizer:log', (event) => {
  if (org.summary) org.summary.textContent = event.payload.message
})

orgSetStatus('ready', 'READY')

// ─────────────────────────────────────────────────────────────────────────────
// ReNamer
// ─────────────────────────────────────────────────────────────────────────────
const ren = {
  statusDot: $('#renStatusDot'),
  statusText: $('#renStatusText'),
  rulesBody: $('#renRulesBody'),
  targetsBody: $('#renTargetsBody'),
  btnRuleAdd: $('#renRuleAdd'),
  btnRuleEdit: $('#renRuleEdit'),
  btnRuleRemove: $('#renRuleRemove'),
  btnRuleUp: $('#renRuleUp'),
  btnRuleDown: $('#renRuleDown'),
  btnAddFiles: $('#renAddFiles'),
  btnAddFolder: $('#renAddFolder'),
  btnRemove: $('#renRemove'),
  btnClear: $('#renClear'),
  btnRename: $('#renRename'),
  btnSettingsSave: $('#btnRenSettingsSave'),
  summary: $('#renSummary'),
  testStr: $('#renGlobalTestStr'),
  testRes: $('#renGlobalTestRes'),
  modal: $('#renRuleModal'),
  modalBackdrop: $('#renRuleModalBackdrop'),
  modalTitle: $('#renRuleModalTitle'),
  modalName: $('#renRuleName'),
  modalPattern: $('#renRulePattern'),
  modalReplace: $('#renRuleReplace'),
  modalApplyTo: $('#renRuleApplyTo'),
  modalCase: $('#renRuleCase'),
  modalWhen: $('#renRuleWhenContains'),
  modalIcase: $('#renRuleContainsIcase'),
  modalTestStr: $('#renRuleTestStr'),
  modalTestRes: $('#renRuleTestResult'),
  modalPatternPreview: $('#renRulePatternPreview'),
  modalCancel: $('#renRuleCancel'),
  modalSave: $('#renRuleSave'),
}

let renRules = []
let renTargets = []
let renPreview = []
let renResults = []
let selectedRuleIndex = null
let selectedTargetIdx = new Set()
let modalMode = 'add'

function renEscapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c] || c
  })
}

function renHighlightRegex(pattern) {
  if (!pattern) return ''
  const html = renEscapeHtml(pattern)
  return html
    .replace(/\\[dswbDSWB]/g, (m) => `<span class="rx-meta">${m}</span>`)
    .replace(/\\./g, (m) => `<span class="rx-esc">${m}</span>`)
    .replace(/[()]/g, (m) => `<span class="rx-group">${m}</span>`)
    .replace(/[\[\]]/g, (m) => `<span class="rx-class">${m}</span>`)
    .replace(/[*+?{}]/g, (m) => `<span class="rx-quant">${m}</span>`)
    .replace(/[\^$]/g, (m) => `<span class="rx-meta">${m}</span>`)
}

function renBasename(p) {
  const parts = String(p ?? '').split(/[/\\]+/)
  return parts[parts.length - 1] ?? p
}

function renSetStatus(mode, text) {
  if (ren.statusText) ren.statusText.textContent = text
  if (!ren.statusDot) return
  ren.statusDot.classList.remove('running', 'stopped', 'ready')
  if (mode === 'running') ren.statusDot.classList.add('running')
  else if (mode === 'ready') ren.statusDot.classList.add('ready')
  else ren.statusDot.classList.add('stopped')
}

function renSetBusy(b) {
  for (const el of [
    ren.btnRuleAdd, ren.btnRuleEdit, ren.btnRuleRemove, ren.btnRuleUp, ren.btnRuleDown,
    ren.btnAddFiles, ren.btnAddFolder, ren.btnRemove, ren.btnClear, ren.btnRename,
    ren.btnSettingsSave,
  ]) { if (el) el.disabled = b }
}

function renRenderRules() {
  if (!ren.rulesBody) return
  if (renRules.length === 0) {
    ren.rulesBody.innerHTML = `<tr><td colspan="4" class="text-muted">No rules.</td></tr>`
  } else {
    const rows = []
    for (let i = 0; i < renRules.length; i++) {
      const r = renRules[i]
      const checked = selectedRuleIndex === i ? 'checked' : ''
      const when = r.whenContains?.length ? r.whenContains.join(', ') : ''
      let metaHtml = ''
      if (r.applyTo || r.case || when) {
        metaHtml = '<div class="rule-meta">'
        if (r.applyTo) metaHtml += `<span class="meta-badge">Apply: ${renEscapeHtml(r.applyTo)}</span>`
        if (r.case) metaHtml += `<span class="meta-badge">Case: ${renEscapeHtml(r.case)}</span>`
        if (when) metaHtml += `<span class="meta-badge">When: ${renEscapeHtml(when)}${r.containsIgnoreCase ? ' (i)' : ''}</span>`
        metaHtml += '</div>'
      }
      rows.push(`<tr data-idx="${i}">
        <td><input type="radio" name="ruleSel" ${checked} /></td>
        <td>${renEscapeHtml(r.name)}</td>
        <td class="text-muted">
          <div class="rule-pattern-main">${renHighlightRegex(r.pattern)}</div>${metaHtml}
        </td>
        <td class="text-muted">${renEscapeHtml(r.replace)}</td>
      </tr>`)
    }
    ren.rulesBody.innerHTML = rows.join('')
    ren.rulesBody.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        const idx = Number(tr.dataset.idx)
        selectedRuleIndex = Number.isFinite(idx) ? idx : null
        renRenderRules()
      })
    })
  }
  void renEvaluateGlobalTestStr()
}

function renRenderTargets() {
  if (!ren.targetsBody) return
  if (renTargets.length === 0) {
    ren.targetsBody.innerHTML = `<tr><td colspan="3" class="text-muted">Add files to get started.</td></tr>`
    return
  }
  const rows = []
  for (let i = 0; i < renTargets.length; i++) {
    const p = renTargets[i]
    const cur = renBasename(p)
    const prev = renPreview[i] ?? ''
    const res = renResults[i] ?? ''
    let resHtml = ''
    if (res === 'OK') resHtml = '<span style="color:var(--success);font-weight:bold;">✔</span>'
    else if (res.startsWith('ERR')) resHtml = `<span style="color:var(--danger);font-weight:bold;" title="${renEscapeHtml(res)}">❌</span>`
    else if (res) resHtml = renEscapeHtml(res)
    const checked = selectedTargetIdx.has(i) ? 'checked' : ''
    rows.push(`<tr data-idx="${i}">
      <td><input type="checkbox" ${checked} /></td>
      <td>
        <div class="ren-target-name ren-target-current">${renEscapeHtml(cur)}</div>
        <div class="ren-target-name ren-target-preview text-muted">${renEscapeHtml(prev)}</div>
      </td>
      <td style="text-align:center;">${resHtml}</td>
    </tr>`)
  }
  ren.targetsBody.innerHTML = rows.join('')
  ren.targetsBody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', (ev) => {
      const idx = Number(tr.dataset.idx)
      if (!Number.isFinite(idx)) return
      if (ev.target?.tagName?.toLowerCase() === 'input') return
      if (selectedTargetIdx.has(idx)) selectedTargetIdx.delete(idx)
      else selectedTargetIdx.add(idx)
      renRenderTargets()
    })
    const cb = tr.querySelector('input[type="checkbox"]')
    if (cb) {
      cb.addEventListener('change', () => {
        const idx = Number(tr.dataset.idx)
        if (!Number.isFinite(idx)) return
        if (cb.checked) selectedTargetIdx.add(idx)
        else selectedTargetIdx.delete(idx)
      })
    }
  })
}

async function renRecalcPreview() {
  if (renTargets.length === 0) {
    renPreview = []
    renResults = []
    renRenderTargets()
    return
  }
  try {
    const previews = await invoke('renamer_preview_names', { paths: renTargets, rules: renRules })
    renPreview = previews
    if (renResults.length !== renTargets.length) renResults = new Array(renTargets.length).fill('')
    renRenderTargets()
  } catch (e) {
    if (ren.summary) ren.summary.textContent = `Preview failed: ${String(e)}`
  }
}

async function renLoadSettings() {
  renSetBusy(true)
  try {
    const resp = await invoke('load_settings')
    renRules = resp.settings.renamerRules ?? []
    if (org.regex && resp.settings.organizerRegex) org.regex.value = resp.settings.organizerRegex
    selectedRuleIndex = null
    renRenderRules()
    await renRecalcPreview()
    if (ren.summary) ren.summary.textContent = 'Settings loaded.'
  } catch (e) {
    if (ren.summary) ren.summary.textContent = `Settings load failed: ${String(e)}`
  } finally {
    renSetBusy(false)
  }
}

async function renSaveSettings() {
  renSetBusy(true)
  try {
    const settings = {
      collision: orgGetCollision(),
      organizerRegex: org.regex ? org.regex.value : '^([A-Za-z0-9]{2,8})-(.+)',
      renamerRules: renRules,
    }
    await invoke('save_settings', { settings })
    if (ren.summary) ren.summary.textContent = 'Settings saved.'
  } catch (e) {
    if (ren.summary) ren.summary.textContent = `Settings save failed: ${String(e)}`
  } finally {
    renSetBusy(false)
  }
}

async function renAddInputs(inputs) {
  if (!inputs.length) return
  try {
    const expanded = await invoke('renamer_expand_inputs', { inputs })
    const existing = new Set(renTargets.map((p) => p.toLowerCase()))
    for (const p of expanded) {
      const key = p.toLowerCase()
      if (!existing.has(key)) { existing.add(key); renTargets.push(p); renResults.push('') }
    }
    selectedTargetIdx.clear()
    await renRecalcPreview()
    if (ren.summary) ren.summary.textContent = `Targets: ${renTargets.length} files`
  } catch (e) {
    if (ren.summary) ren.summary.textContent = `Failed to add files: ${String(e)}`
  }
}

async function renPickFiles() {
  const selected = await openFileDialog({ multiple: true, directory: false })
  if (!selected) return
  await renAddInputs(Array.isArray(selected) ? selected : [selected])
}

async function renPickFolder() {
  const selected = await openFileDialog({ multiple: false, directory: true })
  if (!selected || Array.isArray(selected)) return
  await renAddInputs([selected])
}

function renRemoveSelected() {
  const idxs = Array.from(selectedTargetIdx).sort((a, b) => b - a)
  for (const i of idxs) {
    if (i >= 0 && i < renTargets.length) {
      renTargets.splice(i, 1); renPreview.splice(i, 1); renResults.splice(i, 1)
    }
  }
  selectedTargetIdx.clear()
  renRenderTargets()
  void renRecalcPreview()
}

function renClear() {
  renTargets = []; renPreview = []; renResults = []
  selectedTargetIdx.clear()
  renRenderTargets()
  if (ren.summary) ren.summary.textContent = 'Targets cleared'
}

function openRuleModal(mode, rule) {
  modalMode = mode
  if (ren.modalTitle) ren.modalTitle.textContent = mode === 'add' ? 'Add rule' : 'Edit rule'
  if (ren.modalName) ren.modalName.value = rule?.name ?? ''
  if (ren.modalPattern) ren.modalPattern.value = rule?.pattern ?? ''
  if (ren.modalReplace) ren.modalReplace.value = rule?.replace ?? ''
  if (ren.modalApplyTo) ren.modalApplyTo.value = rule?.applyTo ?? 'stem'
  if (ren.modalCase) ren.modalCase.value = rule?.case ?? ''
  if (ren.modalWhen) ren.modalWhen.value = (rule?.whenContains ?? []).join(', ')
  if (ren.modalIcase) ren.modalIcase.checked = !!rule?.containsIgnoreCase
  if (ren.modalTestStr) ren.modalTestStr.value = ''
  ren.modal?.classList.remove('hidden')
  ren.modalName?.focus()
  renUpdateRegexPreview()
}

function closeRuleModal() { ren.modal?.classList.add('hidden') }

function readRuleFromModal() {
  const name = ren.modalName?.value.trim() || '(rule)'
  const pattern = ren.modalPattern?.value.trim() || ''
  if (!pattern) { if (ren.summary) ren.summary.textContent = 'Pattern is empty.'; return null }
  const replace = ren.modalReplace?.value ?? ''
  const applyTo = ren.modalApplyTo?.value === 'full' ? 'full' : 'stem'
  const cas = ren.modalCase?.value ?? ''
  const when = (ren.modalWhen?.value ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter((x) => x.length > 0)
  const icase = !!ren.modalIcase?.checked
  return { name, pattern, replace, applyTo, case: cas, whenContains: when, containsIgnoreCase: icase }
}

async function renDoRename() {
  if (renTargets.length === 0) {
    if (ren.summary) ren.summary.textContent = 'No targets added.'
    return
  }
  renSetBusy(true)
  renSetStatus('running', 'RUNNING')
  if (ren.summary) ren.summary.textContent = 'Renaming...'
  try {
    const result = await invoke('renamer_apply_rename', {
      paths: renTargets,
      rules: renRules,
      collision: orgGetCollision(),
    })
    const newResults = new Array(renTargets.length).fill('')
    for (const r of result.results) newResults[r.index] = r.status
    renResults = newResults
    renTargets = result.updatedPaths
    await renRecalcPreview()
    const ok = result.results.filter((r) => r.status === 'OK').length
    const err = result.results.filter((r) => r.status.startsWith('ERR')).length
    if (ren.summary) ren.summary.textContent = `Done: ${ok} OK / ${err} ERR`
    renSetStatus('ready', 'READY')
  } catch (e) {
    if (ren.summary) ren.summary.textContent = `Rename failed: ${String(e)}`
    renSetStatus('error', 'ERROR')
  } finally {
    renSetBusy(false)
  }
}

async function renEvaluateGlobalTestStr() {
  const testVal = ren.testStr?.value
  if (!testVal) {
    if (ren.testRes) { ren.testRes.textContent = 'Enter text above to preview results with all rules applied.'; ren.testRes.style.color = 'var(--text-muted)' }
    return
  }
  if (renRules.length === 0) {
    if (ren.testRes) { ren.testRes.textContent = testVal; ren.testRes.style.color = 'var(--text)' }
    return
  }
  try {
    let dummyPath = `C:\\FakeFolder\\${testVal}`
    let addedFakeExt = false
    if (!/\.[a-zA-Z0-9]{2,5}$/i.test(testVal)) { dummyPath += '.mp4'; addedFakeExt = true }
    const previews = await invoke('renamer_preview_names', { paths: [dummyPath], rules: renRules })
    if (previews && previews.length > 0) {
      let res = renBasename(previews[0])
      if (addedFakeExt && res.toLowerCase().endsWith('.mp4')) res = res.substring(0, res.length - 4)
      if (ren.testRes) { ren.testRes.textContent = res; ren.testRes.style.color = '#fff' }
    }
  } catch (e) {
    if (ren.testRes) { ren.testRes.textContent = `Error: ${e}`; ren.testRes.style.color = 'var(--danger)' }
  }
}

function renUpdateRegexPreview() {
  const pattern = ren.modalPattern?.value ?? ''
  const replace = ren.modalReplace?.value ?? ''
  const testStr = ren.modalTestStr?.value ?? ''
  const icase = !!ren.modalIcase?.checked
  if (ren.modalPatternPreview) ren.modalPatternPreview.innerHTML = renHighlightRegex(pattern)
  try {
    if (!pattern) { if (ren.modalTestRes) ren.modalTestRes.innerHTML = '<span class="text-muted">Enter a pattern.</span>'; return }
    let testPat = pattern; let autoIcase = false
    testPat = testPat.replace(/\(\?([a-zA-Z]+)\)/g, (_, f) => { if (f.includes('i')) autoIcase = true; return '' })
    testPat = testPat.replace(/\(\?[a-zA-Z]+:/g, '(?:')
    const flags = (icase || autoIcase) ? 'gi' : 'g'
    const regex = new RegExp(testPat, flags)
    if (testStr) {
      const replaced = testStr.replace(regex, replace)
      if (ren.modalTestRes) ren.modalTestRes.innerHTML = `<span style="color:var(--success);font-weight:700;">Result: </span> ${renEscapeHtml(replaced)}`
    } else {
      if (ren.modalTestRes) ren.modalTestRes.innerHTML = ''
    }
  } catch (e) {
    if (ren.modalTestRes) ren.modalTestRes.innerHTML = `<span style="color:var(--danger);font-weight:700;">Regex error: ${renEscapeHtml(String(e?.message ?? e))}</span>`
  }
}

// ReNamer drag & drop
const renDropZone = $('#renDropZone')
renDropZone?.addEventListener('dragover', (e) => { e.preventDefault(); renDropZone.classList.add('drag-over') })
renDropZone?.addEventListener('dragleave', () => renDropZone.classList.remove('drag-over'))
await listen('tauri://drag-drop', async (event) => {
  const panel = $('#tab-renamer')
  if (panel?.classList.contains('active')) {
    renDropZone?.classList.remove('drag-over')
    if (event.payload?.paths) await renAddInputs(event.payload.paths)
  }
})

// ReNamer button wiring
ren.btnAddFiles?.addEventListener('click', () => void renPickFiles())
ren.btnAddFolder?.addEventListener('click', () => void renPickFolder())
ren.btnRemove?.addEventListener('click', () => renRemoveSelected())
ren.btnClear?.addEventListener('click', () => renClear())
ren.btnRename?.addEventListener('click', () => void renDoRename())
ren.btnRuleAdd?.addEventListener('click', () => openRuleModal('add'))
ren.btnRuleEdit?.addEventListener('click', () => {
  if (selectedRuleIndex == null || selectedRuleIndex < 0 || selectedRuleIndex >= renRules.length) {
    if (ren.summary) ren.summary.textContent = 'Select a rule to edit.'; return
  }
  openRuleModal('edit', renRules[selectedRuleIndex])
})
ren.btnRuleRemove?.addEventListener('click', () => {
  if (selectedRuleIndex == null) { if (ren.summary) ren.summary.textContent = 'Select a rule to remove.'; return }
  renRules.splice(selectedRuleIndex, 1); selectedRuleIndex = null
  renRenderRules(); void renRecalcPreview()
})
ren.btnRuleUp?.addEventListener('click', () => {
  if (selectedRuleIndex == null) return
  const to = selectedRuleIndex - 1
  if (to < 0) return
    ;[renRules[selectedRuleIndex], renRules[to]] = [renRules[to], renRules[selectedRuleIndex]]
  selectedRuleIndex = to; renRenderRules(); void renRecalcPreview()
})
ren.btnRuleDown?.addEventListener('click', () => {
  if (selectedRuleIndex == null) return
  const to = selectedRuleIndex + 1
  if (to >= renRules.length) return
    ;[renRules[selectedRuleIndex], renRules[to]] = [renRules[to], renRules[selectedRuleIndex]]
  selectedRuleIndex = to; renRenderRules(); void renRecalcPreview()
})
ren.btnSettingsSave?.addEventListener('click', () => void renSaveSettings())
ren.modalBackdrop?.addEventListener('click', closeRuleModal)
ren.modalCancel?.addEventListener('click', closeRuleModal)
ren.modalSave?.addEventListener('click', () => {
  const rule = readRuleFromModal()
  if (!rule) return
  if (modalMode === 'add') { renRules.push(rule); selectedRuleIndex = renRules.length - 1 }
  else { if (selectedRuleIndex == null) return; renRules[selectedRuleIndex] = rule }
  closeRuleModal(); renRenderRules(); void renRecalcPreview()
})
ren.modalPattern?.addEventListener('input', renUpdateRegexPreview)
ren.modalReplace?.addEventListener('input', renUpdateRegexPreview)
ren.modalTestStr?.addEventListener('input', renUpdateRegexPreview)
ren.modalIcase?.addEventListener('change', renUpdateRegexPreview)
ren.testStr?.addEventListener('input', () => void renEvaluateGlobalTestStr())

renSetStatus('ready', 'READY')
renRenderRules()
renRenderTargets()
void renLoadSettings()
