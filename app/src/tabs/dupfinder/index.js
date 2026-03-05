import { invoke } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { $, $$ } from '../../domUtils.js'
import { escHtml } from '../../domUtils.js'

// ─────────────────────────────────────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────────────────────────────────────
const dup = {
    folderList: () => $('#dupFolderList'),
    btnAddFolder: () => $('#dupBtnAddFolder'),
    btnScan: () => $('#dupBtnScan'),
    btnSelectAll: () => $('#dupBtnSelectAll'),
    btnDelete: () => $('#dupBtnDelete'),
    progressFill: () => $('#dupProgressFill'),
    progressText: () => $('#dupProgressText'),
    resultsBody: () => $('#dupResultsBody'),
    summary: () => $('#dupSummary'),
}

const MAX_FOLDERS = 10
let folders = []
let scanResult = null
let scanning = false

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function renderFolderList() {
    const el = dup.folderList()
    if (!el) return
    if (folders.length === 0) {
        el.innerHTML = '<div class="text-muted text-sm">No folders added yet.</div>'
        return
    }
    el.innerHTML = folders
        .map(
            (f, i) => `
    <div class="dup-folder-item">
      <span class="dup-folder-path" title="${escHtml(f)}">${escHtml(f)}</span>
      <button class="dup-folder-remove" data-idx="${i}" title="Remove">✕</button>
    </div>`
        )
        .join('')

    // Bind remove buttons
    el.querySelectorAll('.dup-folder-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx)
            folders.splice(idx, 1)
            renderFolderList()
        })
    })
}

function getOptions() {
    const method = document.querySelector('input[name="dupMethod"]:checked')?.value || 'hash'
    const minSizeKB = parseInt($('#dupMinSize')?.value || '0') || 0
    const maxSizeMB = parseInt($('#dupMaxSize')?.value || '0') || 0
    return {
        folders,
        method,
        minSize: minSizeKB > 0 ? minSizeKB * 1024 : null,
        maxSize: maxSizeMB > 0 ? maxSizeMB * 1024 * 1024 : null,
        includeExt: $('#dupIncludeExt')?.value || '',
        excludeExt: $('#dupExcludeExt')?.value || '',
        recursive: $('#dupRecursive')?.checked ?? true,
    }
}

function setBusy(b) {
    scanning = b
    const btns = [dup.btnAddFolder(), dup.btnScan()]
    btns.forEach((el) => {
        if (el) el.disabled = b
    })
    if (dup.btnScan()) {
        dup.btnScan().textContent = b ? '⏳ Scanning...' : '🔍 Scan for Duplicates'
    }
}

function setProgress(scanned, text) {
    if (dup.progressText()) dup.progressText().textContent = text
    // We don't know total ahead of time, so just animate
    if (dup.progressFill()) {
        if (scanning) {
            dup.progressFill().style.width = '100%'
            dup.progressFill().style.transition = 'none'
            dup.progressFill().style.background = 'var(--accent)'
            dup.progressFill().style.animation = 'dup-pulse 1.5s ease-in-out infinite'
        } else {
            dup.progressFill().style.animation = 'none'
            dup.progressFill().style.width = scanned > 0 ? '100%' : '0%'
            dup.progressFill().style.transition = 'width 0.3s ease'
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result rendering
// ─────────────────────────────────────────────────────────────────────────────
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function renderResults() {
    const body = dup.resultsBody()
    if (!body || !scanResult) return

    if (scanResult.groups.length === 0) {
        body.innerHTML = `
      <div class="dup-empty-state">
        <span class="dup-empty-icon">✅</span>
        <span>No duplicates found!</span>
      </div>`
        return
    }

    const html = scanResult.groups
        .map((group, gi) => {
            const filesHtml = group.files
                .map(
                    (f, fi) => `
        <div class="dup-file-row">
          <label class="dup-file-label">
            <input type="checkbox" class="dup-file-check" data-group="${gi}" data-file="${fi}" />
            <div class="dup-file-info">
              <span class="dup-file-name">${escHtml(f.name)}</span>
              <span class="dup-file-path-small">${escHtml(f.path)}</span>
            </div>
            <span class="dup-file-size">${formatSize(f.size)}</span>
          </label>
        </div>`
                )
                .join('')

            const groupSize = formatSize(group.files[0]?.size || 0)
            return `
      <div class="dup-group" data-group="${gi}">
        <div class="dup-group-header">
          <span class="dup-group-badge">${group.files.length} files</span>
          <span class="dup-group-key" title="${escHtml(group.key)}">${truncateKey(group.key)}</span>
          <span class="dup-group-size">${groupSize}</span>
        </div>
        <div class="dup-group-files">${filesHtml}</div>
      </div>`
        })
        .join('')

    body.innerHTML = html
    updateDeleteBtnState()
}

function truncateKey(key) {
    if (key.length > 20) return key.substring(0, 8) + '…' + key.substring(key.length - 8)
    return key
}

function getCheckedFiles() {
    const checks = $$('.dup-file-check:checked')
    const paths = []
    for (const cb of checks) {
        const gi = parseInt(cb.dataset.group)
        const fi = parseInt(cb.dataset.file)
        if (scanResult?.groups?.[gi]?.files?.[fi]) {
            paths.push(scanResult.groups[gi].files[fi].path)
        }
    }
    return paths
}

function updateDeleteBtnState() {
    const checked = $$('.dup-file-check:checked').length
    if (dup.btnDelete()) dup.btnDelete().disabled = checked === 0
    if (dup.btnSelectAll()) dup.btnSelectAll().disabled = !scanResult || scanResult.groups.length === 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────
async function addFolder() {
    if (folders.length >= MAX_FOLDERS) {
        alert(`Maximum ${MAX_FOLDERS} folders allowed.`)
        return
    }
    const selected = await openFileDialog({ directory: true, multiple: false })
    if (!selected || Array.isArray(selected)) return
    if (folders.includes(selected)) return
    folders.push(selected)
    renderFolderList()
}

async function startScan() {
    if (folders.length === 0) {
        if (dup.progressText()) dup.progressText().textContent = 'Please add at least one folder.'
        return
    }
    setBusy(true)
    setProgress(0, 'Scanning...')
    scanResult = null
    renderEmptyResults()

    try {
        const options = getOptions()
        const result = await invoke('dupfinder_scan', { options })
        scanResult = result
        renderResults()
        if (dup.summary()) {
            dup.summary().textContent = `Scanned: ${result.totalScanned} files | Groups: ${result.totalGroups} | Duplicates: ${result.totalDuplicates}`
        }
        setProgress(result.totalScanned, `Done — ${result.totalGroups} duplicate groups found`)
    } catch (e) {
        setProgress(0, `Scan failed: ${String(e)}`)
    } finally {
        setBusy(false)
    }
}

function renderEmptyResults() {
    const body = dup.resultsBody()
    if (!body) return
    body.innerHTML = `
    <div class="dup-empty-state">
      <span class="dup-empty-icon">📂</span>
      <span>Add folders and scan to find duplicates</span>
    </div>`
}

function selectAllDuplicates() {
    if (!scanResult) return
    // For each group, select all except the first file
    scanResult.groups.forEach((_, gi) => {
        const checks = $$(`input.dup-file-check[data-group="${gi}"]`)
        checks.forEach((cb, fi) => {
            cb.checked = fi > 0
        })
    })
    updateDeleteBtnState()
}

async function deleteSelected() {
    const files = getCheckedFiles()
    if (files.length === 0) return
    if (!confirm(`Are you sure you want to permanently delete ${files.length} file(s)?`)) return

    try {
        const result = await invoke('dupfinder_delete', { files })
        let msg = `Deleted: ${result.deleted}`
        if (result.failed > 0) msg += `, Failed: ${result.failed}`
        if (dup.progressText()) dup.progressText().textContent = msg

        // Re-scan to refresh results
        if (folders.length > 0) {
            await startScan()
        }
    } catch (e) {
        if (dup.progressText()) dup.progressText().textContent = `Delete failed: ${String(e)}`
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────────────────────
export async function initDupFinderEvents() {
    dup.btnAddFolder()?.addEventListener('click', () => void addFolder())
    dup.btnScan()?.addEventListener('click', () => void startScan())
    dup.btnSelectAll()?.addEventListener('click', () => selectAllDuplicates())
    dup.btnDelete()?.addEventListener('click', () => void deleteSelected())

    // Delegate checkbox changes for updating delete button state
    dup.resultsBody()?.addEventListener('change', (e) => {
        if (e.target.classList.contains('dup-file-check')) {
            updateDeleteBtnState()
        }
    })

    // Listen for progress events
    await listen('dupfinder:progress', (event) => {
        const p = event.payload
        setProgress(p.scanned, `${p.phase}: ${p.currentFile} (${p.scanned} files)`)
    })

    renderFolderList()
}
