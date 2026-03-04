import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { $ } from '../../domUtils.js'

// ─────────────────────────────────────────────────────────────────────────────
// Organizer DOM references
// ─────────────────────────────────────────────────────────────────────────────
export const org = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
export function orgGetCollision() {
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

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring + Tauri listeners
// ─────────────────────────────────────────────────────────────────────────────
export async function initOrganizerEvents() {
  org.btnPickFolder?.addEventListener('click', () => void orgPickFolder())
  org.btnScan?.addEventListener('click', () => void orgScan())
  org.btnRun?.addEventListener('click', () => void orgRunMove())

  await listen('organizer:move_progress', (event) => {
    const p = event.payload
    orgSetProgress(p.done, p.total, p.filename)
  })
  await listen('organizer:move_finished', async (event) => {
    const r = event.payload
    if (org.summary) org.summary.textContent = `Done: moved=${r.moved}, skipped=${r.skipped}, failed=${r.failed}, folders=${r.createdFolders}`
    orgSetStatus(r.failed > 0 ? 'error' : 'done', 'READY')
    orgSetBusy(false)
    // Re-scan to reflect the updated folder state
    if (organizerFolder) await orgScan()
  })
  await listen('organizer:log', (event) => {
    if (org.summary) org.summary.textContent = event.payload.message
  })

  orgSetStatus('ready', 'READY')
}
