import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { $, showStatus } from '../../domUtils.js'
import { org, orgGetCollision } from '../organizer/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// ReNamer DOM references
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

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let renRules = []
let renTargets = []
let renPreview = []
let renResults = []
let selectedRuleIndex = null
let selectedTargetIdx = new Set()
let modalMode = 'add'

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
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
    const sameName = cur === prev
    const toLabel = sameName ? 'SAME' : 'TO'
    const toStateClass = sameName ? ' is-same' : ''
    rows.push(`<tr data-idx="${i}">
      <td><input type="checkbox" ${checked} /></td>
      <td>
        <div class="ren-target-block ren-target-from">
          <span class="ren-target-label">FROM</span>
          <div class="ren-target-name">${renEscapeHtml(cur)}</div>
        </div>
        <div class="ren-target-arrow" aria-hidden="true">↓</div>
        <div class="ren-target-block ren-target-to${toStateClass}">
          <span class="ren-target-label">${toLabel}</span>
          <div class="ren-target-name">${renEscapeHtml(prev)}</div>
        </div>
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

// ─────────────────────────────────────────────────────────────────────────────
// Preview / invoke
// ─────────────────────────────────────────────────────────────────────────────
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

export async function renLoadSettings() {
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
    showStatus('Settings saved', 'success')
  } catch (e) {
    if (ren.summary) ren.summary.textContent = `Settings save failed: ${String(e)}`
    showStatus(`Settings save failed: ${String(e)}`, 'error')
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

// ─────────────────────────────────────────────────────────────────────────────
// Rule modal
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Rename execution
// ─────────────────────────────────────────────────────────────────────────────
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
    showStatus(`Rename done: ${ok} OK / ${err} ERR`, err > 0 ? 'error' : 'success')
    renSetStatus('ready', 'READY')
  } catch (e) {
    if (ren.summary) ren.summary.textContent = `Rename failed: ${String(e)}`
    showStatus(`Rename failed: ${String(e)}`, 'error')
    renSetStatus('error', 'ERROR')
  } finally {
    renSetBusy(false)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test string / regex preview
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring + Tauri drag-drop
// ─────────────────────────────────────────────────────────────────────────────
export async function initRenamerEvents() {
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
}
