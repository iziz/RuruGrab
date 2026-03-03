import { dom } from '../../dom.js'
import { setText } from '../../domUtils.js'
import { appendGuiLog } from '../../logger.js'
import { apiFetch, toThumbSrc, openPath } from '../../api.js'
import { API } from '../../config.js'

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let lastDownloadsSig = ''
let downloadsById = new Map() // id -> row
let dlNodeById = new Map()    // id -> HTMLElement (DOM node cache)
let selectedTaskId = null

// ─────────────────────────────────────────────────────────────────────────────
// Pure utility helpers
// ─────────────────────────────────────────────────────────────────────────────
export function humanBytes(n) {
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

export function formatTime(secs) {
  const s = Number(secs)
  if (!Number.isFinite(s) || s <= 0) return ''
  if (s < 60) return `${Math.floor(s)}s`
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  if (m < 60) return `${m}m ${ss}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function normStatus(s) {
  const t = String(s ?? '').trim().toLowerCase()
  if (!t) return '-'
  if (['finished', 'complete', 'completed', 'done'].includes(t)) return 'done'
  if (['downloading', 'download', 'running', 'active'].includes(t)) return 'downloading'
  if (['error', 'failed', 'fail'].includes(t)) return 'error'
  if (['cancelled', 'canceled', 'cancel'].includes(t)) return 'cancelled'
  return t
}

export function normPercent(percent, downloadedBytes, totalBytes) {
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

export function extractYouTubeId(url) {
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

export function siteTagFromUrl(url) {
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
        id, st, pct,
        r?.downloaded_bytes || 0, total || 0,
        r?.eta || 0, r?.speed || 0,
        r?.downloaded_items || 0, r?.total_items || 0,
        r?.title || '', r?.url || '',
        r?.thumbnail || '', r?.video_id || '',
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

  let stLabel = ''
  if (st === 'done') stLabel = 'download complete'
  else if (st === 'error') stLabel = 'error'
  else if (st === 'cancelled') stLabel = 'canceled'
  else if (pct > 0) stLabel = `${pct.toFixed(1)}% download`
  else stLabel = st === 'starting' ? 'preparing...' : (st === 'queued' ? 'ready' : st)
  parts.push(stLabel)

  if (row.total_items && Number(row.total_items) > 1) {
    const total = Number(row.total_items) || 0
    const isDoneLike = (st === 'done' || st === 'error' || st === 'cancelled')
    const doneItems = isDoneLike ? total : (Number(row.downloaded_items) || 0)
    parts.push(`${total} / ${doneItems} done`)
  }

  const total = Number(totalBytes)
  const dl = Number(downloadedBytes)
  if (Number.isFinite(dl) && dl > 0 && Number.isFinite(total) && total > 0) {
    parts.push(`${humanBytes(dl)} of ${humanBytes(total)}`)
  } else if (Number.isFinite(total) && total > 0) {
    parts.push(humanBytes(total))
  }

  if (row.eta) parts.push(`${formatTime(row.eta)} left`)
  if (typeof row.speed === 'number' && row.speed > 0) parts.push(`${humanBytes(row.speed)}/s`)

  return parts.filter(Boolean).join(' · ')
}

// ─────────────────────────────────────────────────────────────────────────────
// Thumbnail loading with debounce / placeholder
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Download list item DOM creation / update
// ─────────────────────────────────────────────────────────────────────────────
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

  let rawThumb = row?.thumbnail || ''
  const url = String(row?.url ?? '')
  const ytId = String(row?.video_id ?? '') || extractYouTubeId(url)
  if (!rawThumb && ytId) rawThumb = `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`
  const thumbUrl = toThumbSrc(rawThumb)

  setThumbWithPlaceholder(refs.img, refs.placeholder, thumbUrl)

  if (row?.duration) {
    refs.duration.textContent = String(row.duration)
    refs.duration.style.display = ''
  } else {
    refs.duration.textContent = ''
    refs.duration.style.display = 'none'
  }

  const titleRaw = String(row?.title ?? '').trim()
  const fallbackTitle = isDone ? (url || 'Unknown') : 'Loading metadata...'
  const displayTitle = titleRaw || fallbackTitle
  refs.title.textContent = displayTitle
  refs.title.title = titleRaw || url || ''

  const tag = siteTagFromUrl(url)
  if (tag) {
    refs.siteTag.textContent = tag.text
    refs.siteTag.className = `site-tag ${tag.cls}`
    refs.siteTag.style.display = ''
  } else {
    refs.siteTag.textContent = ''
    refs.siteTag.style.display = 'none'
  }

  const metaText = buildMetaText(row)
  if (metaText) {
    refs.meta2.textContent = metaText
    refs.meta2.style.display = ''
  } else {
    refs.meta2.textContent = ''
    refs.meta2.style.display = 'none'
  }

  refs.barBg.classList.toggle('hidden', !!hideBar)
  refs.barFill.className = `dl-progress-fill ${progressFillClass}`
  refs.barFill.style.width = `${pct}%`

  const progressText = buildProgressText(row, st, pct, totalBytes, downloadedBytes) || url
  refs.progressText.textContent = progressText
  refs.progressText.classList.toggle('text-error', !!isError)
}

export function updateDownloadList(itemsRaw) {
  const items = Array.isArray(itemsRaw) ? itemsRaw : []

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
    const emptyHtml = '<div id="dlEmpty" class="text-muted" style="padding:20px;text-align:center;">No downloads</div>'
    if (dom.dlList.innerHTML !== emptyHtml) dom.dlList.innerHTML = emptyHtml
    dlNodeById.clear()
    return
  }

  const emptyEl = dom.dlList.querySelector(`#${EMPTY_ID}`)
  if (emptyEl) emptyEl.remove()

  const live = new Set(ids)
  for (const [id, node] of dlNodeById.entries()) {
    if (!live.has(id)) {
      node.remove()
      dlNodeById.delete(id)
    }
  }

  for (const id of ids) {
    const row = downloadsById.get(id) || {}
    let node = dlNodeById.get(id)
    if (!node) {
      node = createDlItem(id)
      dlNodeById.set(id, node)
    }
    updateDlItem(node, row)
    dom.dlList.appendChild(node)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status UI
// ─────────────────────────────────────────────────────────────────────────────
export function updateStatusUI(stRaw) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Context menu
// ─────────────────────────────────────────────────────────────────────────────
export function showCtxMenuForTask(taskId, x, y) {
  const menu = dom.ctxMenu
  if (!menu) return

  selectedTaskId = taskId

  menu.style.left = '-9999px'
  menu.style.top = '-9999px'
  menu.classList.add('visible')

  const rect = menu.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  let finalX = x
  let finalY = y
  if (x + rect.width > vw) finalX = Math.max(0, vw - rect.width - 8)
  if (y + rect.height > vh) finalY = Math.max(0, vh - rect.height - 8)

  menu.style.left = `${finalX}px`
  menu.style.top = `${finalY}px`

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

  const openFolderBtn = menu.querySelector('[data-action="open-folder"]')
  if (openFolderBtn) {
    const hasFile = !!row.filename
    openFolderBtn.style.opacity = hasFile ? '1' : '0.4'
    openFolderBtn.style.pointerEvents = hasFile ? 'auto' : 'none'
  }
}

export function hideCtxMenu() {
  if (!dom.ctxMenu) return
  dom.ctxMenu.classList.remove('visible')
  selectedTaskId = null
}

function normalizeCtxAction(actionRaw) {
  const a = String(actionRaw || '').trim().toLowerCase()
  if (!a) return ''
  if (a === 'remove' || a === 'remove-list' || a === 'remove-from-list') return 'delete'
  if (a === 'delete-list' || a === 'delete-from-list') return 'delete'
  if (a === 'canceled') return 'cancelled'
  return a
}

export async function callDownloadAction(taskId, action, deleteFiles) {
  try {
    const idNum = Number(taskId)
    const payload = {
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

export async function refreshStatus() {
  try {
    const json = await apiFetch('/status')
    updateStatusUI(json)
  } catch {
    if (dom.statusDot) dom.statusDot.className = 'status-dot stopped'
    setText(dom.statusText, 'OFFLINE')
  }
}

export async function queueDownload() {
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

// ─────────────────────────────────────────────────────────────────────────────
// Context menu event wiring
// ─────────────────────────────────────────────────────────────────────────────
export function initDownloadsEvents() {
  document.addEventListener('click', (e) => {
    if (!dom.ctxMenu) return
    if (!dom.ctxMenu.contains(e.target)) hideCtxMenu()
  })

  if (dom.ctxMenu) {
    dom.ctxMenu.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ctx-menu-item')
      if (!btn) return
      const action0 = normalizeCtxAction(btn.dataset.action)
      const taskId = selectedTaskId
      hideCtxMenu()
      if (!taskId) return
      if (action0 === 'open-folder') {
        const row = downloadsById.get(taskId) || {}
        const filename = String(row.filename || '')
        if (filename) {
          const dir = filename.replace(/[/\\][^/\\]*$/, '')
          if (dir) await openPath(dir)
        }
      } else if (action0 === 'delete-files') {
        if (!confirm('All related files will be deleted. Do you want to continue?')) return
        await callDownloadAction(taskId, 'delete', true)
      } else if (action0) {
        await callDownloadAction(taskId, action0, false)
      }
    })
  }

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

  if (dom.videoUrl) {
    dom.videoUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') queueDownload()
    })
  }
}
