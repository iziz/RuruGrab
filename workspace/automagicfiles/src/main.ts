import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return c;
    }
  });
}

function highlightRegex(pattern: string): string {
  if (!pattern) return '';
  let html = escapeHtml(pattern);

  // JS RegExp doesn't support (?i), so strip it for highlighting if we want, or just color it.
  // Using a simple tokenizer to avoid replacing inside already inserted <span> tags:
  const tokens: { type: string, val: string }[] = [];
  let i = 0;
  while (i < html.length) {
    if (html.slice(i, i + 5) === '&lt;') { tokens.push({ type: 'text', val: '&lt;' }); i += 4; }
    else if (html.slice(i, i + 4) === '&gt;') { tokens.push({ type: 'text', val: '&gt;' }); i += 4; }
    else if (html.slice(i, i + 5) === '&amp;') { tokens.push({ type: 'text', val: '&amp;' }); i += 5; }
    else if (html.slice(i, i + 6) === '&quot;') { tokens.push({ type: 'text', val: '&quot;' }); i += 6; }
    else if (html.slice(i, i + 6) === '&#039;') { tokens.push({ type: 'text', val: '&#039;' }); i += 6; }

    // Escapes: \. \d \s \( \)
    else if (html[i] === '\\' && i + 1 < html.length) {
      const next = html[i + 1];
      if (/[dswbDSWB]/.test(next)) {
        tokens.push({ type: 'rx-meta', val: '\\\\' + next });
      } else {
        tokens.push({ type: 'rx-esc', val: '\\\\' + next });
      }
      i += 2;
    }
    // Groups ()
    else if (html[i] === '(' || html[i] === ')') {
      tokens.push({ type: 'rx-group', val: html[i] });
      i++;
    }
    // Inline flags (?i) (?i:...) - Note: ( is caught above, so this catches ?i, ?m, etc if after (
    else if (html[i] === '?' && (html[i + 1] === 'i' || html[i + 1] === 'm' || html[i + 1] === 's') && (i === 0 || html[i - 1] === '(')) {
      tokens.push({ type: 'rx-meta', val: html[i] + html[i + 1] });
      i += 2;
      if (html[i] === ':') { tokens.push({ type: 'rx-meta', val: ':' }); i++; }
    }
    // Classes []
    else if (html[i] === '[' || html[i] === ']') {
      tokens.push({ type: 'rx-class', val: html[i] });
      i++;
    }
    // Quantifiers * + ? {}
    else if (/[*+?]/.test(html[i])) {
      tokens.push({ type: 'rx-quant', val: html[i] });
      i++;
    }
    // Bounds {} naively
    else if (html[i] === '{' || html[i] === '}') {
      tokens.push({ type: 'rx-quant', val: html[i] });
      i++;
    }
    // Anchors ^ $
    else if (html[i] === '^' || html[i] === '$') {
      tokens.push({ type: 'rx-meta', val: html[i] });
      i++;
    }
    else {
      tokens.push({ type: 'text', val: html[i] });
      i++;
    }
  }

  return tokens.map(t => t.type === 'text' ? t.val : `<span class="${t.type}">${t.val}</span>`).join('');
}

function basename(p: string) {
  const parts = p.split(/[/\\]+/);
  return parts[parts.length - 1] ?? p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────
const tabBtns = [$('#tabBtnOrganizer') as HTMLButtonElement, $('#tabBtnRenamer') as HTMLButtonElement];
const panels: Record<string, HTMLElement> = {
  organizer: $('#tab-organizer'),
  renamer: $('#tab-renamer'),
  settings: $('#tab-settings'),
};
const btnSettings = $('#btnSettings') as HTMLButtonElement;
const btnSettingsLoad = $('#btnSettingsLoad') as HTMLButtonElement;
const btnSettingsSave = $('#btnSettingsSave') as HTMLButtonElement;

function setActiveTab(tab: 'organizer' | 'renamer' | 'settings') {
  for (const b of tabBtns) {
    if (tab === 'settings') {
      b.classList.remove('active'); // Settings 활성화 시 메인 탭 비활성화
    } else {
      b.classList.toggle('active', b.dataset.tab === tab);
    }
  }
  for (const [k, el] of Object.entries(panels)) {
    el.classList.toggle('active', k === tab);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings Context
// ─────────────────────────────────────────────────────────────────────────────
function getSettingsCollision(): string {
  const el = document.querySelector<HTMLInputElement>('input[name="collision"]:checked');
  return el ? el.value : 'suffix';
}

function setSettingsCollision(val: string) {
  const el = document.querySelector<HTMLInputElement>(`input[name="collision"][value="${val}"]`);
  if (el) el.checked = true;
}

const settingsOrganizerRegex = $('#settingsOrganizerRegex') as HTMLInputElement;

function setSettingsDisabled(b: boolean) {
  document.querySelectorAll<HTMLInputElement>('input[name="collision"]').forEach(el => {
    el.disabled = b;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Organizer (existing tab)
// ─────────────────────────────────────────────────────────────────────────────
type PreviewItem = { name: string; from: string; to: string };
type Group = { prefix: string; files: PreviewItem[] };
type ScanResult = { totalFiles: number; matchedFiles: number; groups: Group[] };

type MoveProgress = { done: number; total: number; filename: string };
type MoveFinished = { moved: number; skipped: number; failed: number; createdFolders: number };

const org = {
  statusDot: $('#statusDot') as HTMLSpanElement,
  statusText: $('#statusText') as HTMLSpanElement,
  statusPath: $('#statusPath') as HTMLSpanElement,
  btnPickFolder: $('#btnPickFolder') as HTMLButtonElement,
  btnScan: $('#btnScan') as HTMLButtonElement,
  btnRun: $('#btnRun') as HTMLButtonElement,
  summary: $('#summary') as HTMLDivElement,
  progressFill: $('#progressFill') as HTMLDivElement,
  progressText: $('#progressText') as HTMLSpanElement,
  progressFile: $('#progressFile') as HTMLSpanElement,
  previewBody: $('#previewBody') as HTMLTableSectionElement,
};

let organizerFolder: string | null = null;

function orgSetStatus(mode: 'ready' | 'running' | 'done' | 'error', text: string) {
  org.statusText.textContent = text;
  org.statusDot.classList.remove('running', 'stopped', 'ready');
  if (mode === 'running' || mode === 'done') org.statusDot.classList.add('running');
  else if (mode === 'ready') org.statusDot.classList.add('ready');
  else org.statusDot.classList.add('stopped');
}

function orgSetBusy(b: boolean) {
  org.btnPickFolder.disabled = b;
  org.btnScan.disabled = b;
  org.btnRun.disabled = b;
  setSettingsDisabled(b);
  settingsOrganizerRegex.disabled = b;
}

function orgSetProgress(done: number, total: number, filename: string) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  org.progressFill.style.width = `${pct}%`;
  org.progressText.textContent = `${done} / ${total}`;
  org.progressFile.textContent = filename ? ` • ${filename}` : '';
}

function orgRenderPreview(result: ScanResult) {
  if (result.groups.length === 0) {
    org.previewBody.innerHTML = `<tr><td class="text-muted">매칭되는 파일이 없습니다.</td></tr>`;
    return;
  }

  const rows: string[] = [];
  for (const g of result.groups) {
    const destDir = g.files.length > 0
      ? g.files[0].to.replace(/[/\\][^/\\]+$/, '')
      : g.prefix;

    rows.push(`
      <tr class="group-header-row">
        <td>
          <span class="folder-icon">📁</span>
          <span class="dest-path">${escapeHtml(destDir)}</span>
          <span class="group-count">${g.files.length}개</span>
        </td>
      </tr>`);

    for (let i = 0; i < g.files.length; i++) {
      const f = g.files[i];
      const isLast = i === g.files.length - 1;
      rows.push(`
        <tr class="file-row">
          <td>
            <div class="file-entry${isLast ? ' is-last' : ''}">
              <span class="file-name">${escapeHtml(f.name)}</span>
            </div>
          </td>
        </tr>`);
    }
  }
  org.previewBody.innerHTML = rows.join('');
}

async function orgPickFolder() {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return;

  organizerFolder = selected;
  org.statusPath.textContent = selected;
  org.summary.textContent = '폴더 선택됨. Scan을 실행하세요.';
  orgSetStatus('ready', 'READY');

  org.previewBody.innerHTML = `<tr><td colspan="4" class="text-muted">Scan 결과가 여기에 표시됩니다.</td></tr>`;
  orgSetProgress(0, 0, '');
}

async function orgScan() {
  if (!organizerFolder) {
    org.summary.textContent = '폴더를 먼저 선택하세요.';
    orgSetStatus('error', 'ERROR');
    return;
  }

  orgSetBusy(true);
  orgSetStatus('running', 'SCANNING');
  org.summary.textContent = '스캔 중...';
  try {
    const result = await invoke<ScanResult>('scan_folder', {
      folder: organizerFolder,
      regexStr: settingsOrganizerRegex.value
    });
    orgRenderPreview(result);
    org.summary.textContent = `총 파일 ${result.totalFiles}개 / 매칭 ${result.matchedFiles}개 / 그룹 ${result.groups.length}개`;
    orgSetStatus('done', 'READY');
  } catch (e) {
    org.summary.textContent = `스캔 실패: ${String(e)}`;
    orgSetStatus('error', 'ERROR');
  } finally {
    orgSetBusy(false);
  }
}

async function orgRunMove() {
  if (!organizerFolder) {
    org.summary.textContent = '폴더를 먼저 선택하세요.';
    orgSetStatus('error', 'ERROR');
    return;
  }

  orgSetBusy(true);
  orgSetStatus('running', 'RUNNING');
  org.summary.textContent = '이동 실행 중...';
  orgSetProgress(0, 0, '');

  try {
    await invoke('start_move', {
      folder: organizerFolder,
      collision: getSettingsCollision(),
      regexStr: settingsOrganizerRegex.value
    });
  } catch (e) {
    org.summary.textContent = `실행 실패: ${String(e)}`;
    orgSetStatus('error', 'ERROR');
    orgSetBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ReNamer (new tab)
// ─────────────────────────────────────────────────────────────────────────────
type RenRule = {
  name: string;
  pattern: string;
  replace: string;
  applyTo: 'stem' | 'full';
  case: '' | 'upper' | 'lower';
  whenContains: string[];
  containsIgnoreCase: boolean;
};

type GlobalSettings = {
  collision: string;
  organizerRegex: string;
  renamerRules: RenRule[];
};

type SettingsLoadResponse = { settings: GlobalSettings; loadedFrom: string };
type RenApplyRow = { index: number; from: string; to: string; status: string };
type RenApplyResult = { updatedPaths: string[]; results: RenApplyRow[] };

const ren = {
  statusDot: $('#renStatusDot') as HTMLSpanElement,
  statusText: $('#renStatusText') as HTMLSpanElement,
  rulesBody: $('#renRulesBody') as HTMLTableSectionElement,
  targetsBody: $('#renTargetsBody') as HTMLTableSectionElement,
  btnRuleAdd: $('#renRuleAdd') as HTMLButtonElement,
  btnRuleEdit: $('#renRuleEdit') as HTMLButtonElement,
  btnRuleRemove: $('#renRuleRemove') as HTMLButtonElement,
  btnRuleUp: $('#renRuleUp') as HTMLButtonElement,
  btnRuleDown: $('#renRuleDown') as HTMLButtonElement,
  btnAddFiles: $('#renAddFiles') as HTMLButtonElement,
  btnAddFolder: $('#renAddFolder') as HTMLButtonElement,
  btnRemove: $('#renRemove') as HTMLButtonElement,
  btnClear: $('#renClear') as HTMLButtonElement,
  btnRename: $('#renRename') as HTMLButtonElement,
  summary: $('#renSummary') as HTMLDivElement,

  // global tester
  testStr: $('#renGlobalTestStr') as HTMLInputElement,
  testRes: $('#renGlobalTestRes') as HTMLDivElement,

  // modal
  modal: $('#renRuleModal') as HTMLDivElement,
  modalBackdrop: $('#renRuleModalBackdrop') as HTMLDivElement,
  modalTitle: $('#renRuleModalTitle') as HTMLDivElement,
  modalName: $('#renRuleName') as HTMLInputElement,
  modalPattern: $('#renRulePattern') as HTMLInputElement,
  modalReplace: $('#renRuleReplace') as HTMLInputElement,
  modalApplyTo: $('#renRuleApplyTo') as HTMLSelectElement,
  modalCase: $('#renRuleCase') as HTMLSelectElement,
  modalWhen: $('#renRuleWhenContains') as HTMLInputElement,
  modalIcase: $('#renRuleContainsIcase') as HTMLInputElement,
  modalTestStr: $('#renRuleTestStr') as HTMLInputElement,
  modalTestRes: $('#renRuleTestResult') as HTMLDivElement,
  modalPatternPreview: $('#renRulePatternPreview') as HTMLDivElement,
  modalCancel: $('#renRuleCancel') as HTMLButtonElement,
  modalSave: $('#renRuleSave') as HTMLButtonElement,
};

let renRules: RenRule[] = [];
let renTargets: string[] = [];
let renPreview: string[] = [];
let renResults: string[] = [];

let selectedRuleIndex: number | null = null;
let selectedTargetIdx = new Set<number>();

let modalMode: 'add' | 'edit' = 'add';

function renSetStatus(mode: 'ready' | 'running' | 'error', text: string) {
  ren.statusText.textContent = text;
  ren.statusDot.classList.remove('running', 'stopped', 'ready');
  if (mode === 'running') ren.statusDot.classList.add('running');
  else if (mode === 'ready') ren.statusDot.classList.add('ready');
  else ren.statusDot.classList.add('stopped');
}

function renSetBusy(b: boolean) {
  for (const el of [
    ren.btnRuleAdd, ren.btnRuleEdit, ren.btnRuleRemove, ren.btnRuleUp, ren.btnRuleDown,
    ren.btnAddFiles, ren.btnAddFolder, ren.btnRemove, ren.btnClear, ren.btnRename,
    btnSettingsLoad, btnSettingsSave
  ]) el.disabled = b;
  setSettingsDisabled(b);
  settingsOrganizerRegex.disabled = b;
}

function renRenderRules() {
  if (renRules.length === 0) {
    ren.rulesBody.innerHTML = `<tr><td colspan="4" class="text-muted">No rules.</td></tr>`;
    return;
  }

  const rows: string[] = [];
  for (let i = 0; i < renRules.length; i++) {
    const r = renRules[i];
    const checked = (selectedRuleIndex === i) ? 'checked' : '';
    const when = r.whenContains?.length ? r.whenContains.join(', ') : '';

    // Add meta badges
    let metaHtml = '';
    if (r.applyTo || r.case || when) {
      metaHtml += '<div class="rule-meta">';
      if (r.applyTo) metaHtml += `<span class="meta-badge">Apply: ${escapeHtml(r.applyTo)}</span>`;
      if (r.case) metaHtml += `<span class="meta-badge">Case: ${escapeHtml(r.case)}</span>`;
      if (when) metaHtml += `<span class="meta-badge">When: ${escapeHtml(when)}${r.containsIgnoreCase ? ' (i)' : ''}</span>`;
      metaHtml += '</div>';
    }

    rows.push(`<tr data-idx="${i}">
      <td><input type="radio" name="ruleSel" ${checked} /></td>
      <td>${escapeHtml(r.name)}</td>
      <td class="text-muted">
        <div class="rule-pattern-main">${highlightRegex(r.pattern)}</div>
        ${metaHtml}
      </td>
      <td class="text-muted">${escapeHtml(r.replace)}</td>
    </tr>`);
  }
  ren.rulesBody.innerHTML = rows.join('');

  // wire selection
  ren.rulesBody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      const idx = Number((tr as HTMLElement).dataset.idx);
      selectedRuleIndex = Number.isFinite(idx) ? idx : null;
      renRenderRules();
    });
  });

  // Evaluate global tester whenever rules change logically
  void evaluateGlobalTestStr();
}

function renRenderTargets() {
  if (renTargets.length === 0) {
    ren.targetsBody.innerHTML = `<tr><td colspan="4" class="text-muted">파일을 추가하세요.</td></tr>`;
    return;
  }

  const rows: string[] = [];
  for (let i = 0; i < renTargets.length; i++) {
    const p = renTargets[i];
    const cur = basename(p);
    const prev = renPreview[i] ?? '';
    const res = renResults[i] ?? '';
    let resHtml = '';
    if (res === 'OK') {
      resHtml = '<span style="color: var(--success); font-weight: bold;">✔</span>';
    } else if (res.startsWith('ERR')) {
      resHtml = `<span style="color: var(--danger); font-weight: bold;" title="${escapeHtml(res)}">❌</span>`;
    } else if (res) {
      resHtml = escapeHtml(res);
    }

    const checked = selectedTargetIdx.has(i) ? 'checked' : '';
    rows.push(`<tr data-idx="${i}">
      <td><input type="checkbox" ${checked} /></td>
      <td>${escapeHtml(cur)}</td>
      <td class="text-muted">${escapeHtml(prev)}</td>
      <td style="text-align: center;">${resHtml}</td>
    </tr>`);
  }
  ren.targetsBody.innerHTML = rows.join('');

  ren.targetsBody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', (ev) => {
      const idx = Number((tr as HTMLElement).dataset.idx);
      if (!Number.isFinite(idx)) return;

      const isCheckbox = (ev.target as HTMLElement)?.tagName?.toLowerCase() === 'input';
      if (isCheckbox) {
        // handled below via change
        return;
      }
      // toggle selection on row click
      if (selectedTargetIdx.has(idx)) selectedTargetIdx.delete(idx);
      else selectedTargetIdx.add(idx);
      renRenderTargets();
    });

    const cb = tr.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (cb) {
      cb.addEventListener('change', () => {
        const idx = Number((tr as HTMLElement).dataset.idx);
        if (!Number.isFinite(idx)) return;
        if (cb.checked) selectedTargetIdx.add(idx);
        else selectedTargetIdx.delete(idx);
      });
    }
  });
}

async function renRecalcPreview() {
  if (renTargets.length === 0) {
    renPreview = [];
    renResults = [];
    renRenderTargets();
    return;
  }

  try {
    const previews = await invoke<string[]>('renamer_preview_names', { paths: renTargets, rules: renRules });
    renPreview = previews;
    if (renResults.length !== renTargets.length) renResults = new Array(renTargets.length).fill('');
    renRenderTargets();
  } catch (e) {
    ren.summary.textContent = `Preview 실패: ${String(e)}`;
  }
}

async function loadSettings() {
  renSetBusy(true);
  try {
    const resp = await invoke<SettingsLoadResponse>('load_settings');
    renRules = resp.settings.renamerRules ?? [];
    setSettingsCollision(resp.settings.collision || 'suffix');
    settingsOrganizerRegex.value = resp.settings.organizerRegex || '^([A-Za-z0-9]{2,8})-(.+)';

    selectedRuleIndex = null;
    renRenderRules();
    await renRecalcPreview();

    ren.summary.textContent = '설정을 불러왔습니다.';
  } catch (e) {
    ren.summary.textContent = `설정 로드 실패: ${String(e)}`;
  } finally {
    renSetBusy(false);
  }
}

async function saveSettings() {
  renSetBusy(true);
  try {
    const settings: GlobalSettings = {
      collision: getSettingsCollision(),
      organizerRegex: settingsOrganizerRegex.value,
      renamerRules: renRules,
    };
    await invoke('save_settings', { settings });
    ren.summary.textContent = '설정이 저장되었습니다.';
  } catch (e) {
    ren.summary.textContent = `설정 저장 실패: ${String(e)}`;
  } finally {
    renSetBusy(false);
  }
}

async function renAddInputs(inputs: string[]) {
  if (!inputs.length) return;
  try {
    const expanded = await invoke<string[]>('renamer_expand_inputs', { inputs });
    const existing = new Set(renTargets.map((p) => p.toLowerCase()));
    for (const p of expanded) {
      const key = p.toLowerCase();
      if (!existing.has(key)) {
        existing.add(key);
        renTargets.push(p);
        renResults.push('');
      }
    }
    selectedTargetIdx.clear();
    await renRecalcPreview();
    ren.summary.textContent = `Targets: ${renTargets.length}개`;
  } catch (e) {
    ren.summary.textContent = `파일 추가 실패: ${String(e)}`;
  }
}

async function renPickFiles() {
  const selected = await open({ multiple: true, directory: false });
  if (!selected) return;
  const files = Array.isArray(selected) ? selected : [selected];
  await renAddInputs(files);
}

async function renPickFolder() {
  const selected = await open({ multiple: false, directory: true });
  if (!selected || Array.isArray(selected)) return;
  await renAddInputs([selected]);
}

function renRemoveSelectedTargets() {
  const idxs = Array.from(selectedTargetIdx).sort((a, b) => b - a);
  for (const i of idxs) {
    if (i >= 0 && i < renTargets.length) {
      renTargets.splice(i, 1);
      renPreview.splice(i, 1);
      renResults.splice(i, 1);
    }
  }
  selectedTargetIdx.clear();
  renRenderTargets();
  void renRecalcPreview();
}

function renClearTargets() {
  renTargets = [];
  renPreview = [];
  renResults = [];
  selectedTargetIdx.clear();
  renRenderTargets();
  ren.summary.textContent = 'Targets cleared';
}

function openRuleModal(mode: 'add' | 'edit', rule?: RenRule) {
  modalMode = mode;
  ren.modalTitle.textContent = mode === 'add' ? 'Add rule' : 'Edit rule';
  ren.modalName.value = rule?.name ?? '';
  ren.modalPattern.value = rule?.pattern ?? '';
  ren.modalReplace.value = rule?.replace ?? '';
  ren.modalApplyTo.value = rule?.applyTo ?? 'stem';
  ren.modalCase.value = rule?.case ?? '';
  ren.modalWhen.value = (rule?.whenContains ?? []).join(', ');
  ren.modalIcase.checked = !!rule?.containsIgnoreCase;
  ren.modalTestStr.value = '';

  ren.modal.classList.remove('hidden');
  ren.modalName.focus();
  updateRegexPreviewAndTest();
}

function closeRuleModal() {
  ren.modal.classList.add('hidden');
}

function readRuleFromModal(): RenRule | null {
  const name = ren.modalName.value.trim() || '(rule)';
  const pattern = ren.modalPattern.value.trim();
  if (!pattern) {
    ren.summary.textContent = 'Pattern이 비어 있습니다.';
    return null;
  }
  const replace = ren.modalReplace.value ?? '';
  const applyTo = (ren.modalApplyTo.value === 'full') ? 'full' : 'stem';
  const cas = (ren.modalCase.value as any) ?? '';
  const when = ren.modalWhen.value
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  const icase = ren.modalIcase.checked;

  return { name, pattern, replace, applyTo, case: cas, whenContains: when, containsIgnoreCase: icase };
}

function renRuleAdd() {
  openRuleModal('add');
}

function renRuleEdit() {
  if (selectedRuleIndex == null || selectedRuleIndex < 0 || selectedRuleIndex >= renRules.length) {
    ren.summary.textContent = 'Edit할 Rule을 선택하세요.';
    return;
  }
  openRuleModal('edit', renRules[selectedRuleIndex]);
}

function renRuleRemove() {
  if (selectedRuleIndex == null) {
    ren.summary.textContent = 'Remove할 Rule을 선택하세요.';
    return;
  }
  renRules.splice(selectedRuleIndex, 1);
  selectedRuleIndex = null;
  renRenderRules();
  void renRecalcPreview();
}

function renRuleMove(delta: -1 | 1) {
  if (selectedRuleIndex == null) {
    ren.summary.textContent = '이동할 Rule을 선택하세요.';
    return;
  }
  const from = selectedRuleIndex;
  const to = from + delta;
  if (to < 0 || to >= renRules.length) return;
  const tmp = renRules[from];
  renRules[from] = renRules[to];
  renRules[to] = tmp;
  selectedRuleIndex = to;
  renRenderRules();
  void renRecalcPreview();
}

async function renRename() {
  if (renTargets.length === 0) {
    ren.summary.textContent = 'Targets가 없습니다.';
    return;
  }

  // Confirm batch (simple)
  const sample: string[] = [];
  for (let i = 0; i < Math.min(50, renTargets.length); i++) {
    const cur = basename(renTargets[i]);
    const prev = renPreview[i] ?? '';
    if (prev && prev !== cur) sample.push(`${cur} -> ${prev}`);
  }
  const more = sample.length > 50 ? `\n… and more` : '';
  const msg = `Rename will be applied (${sample.length} changes).\n\n` + sample.slice(0, 50).join('\n') + more;

  renSetBusy(true);
  renSetStatus('running', 'RUNNING');
  ren.summary.textContent = 'Renaming...';

  try {
    const result = await invoke<RenApplyResult>('renamer_apply_rename', {
      paths: renTargets,
      rules: renRules,
      collision: getSettingsCollision()
    });

    // apply results
    const newResults = new Array(renTargets.length).fill('');
    for (const r of result.results) {
      newResults[r.index] = r.status;
    }
    renResults = newResults;
    renTargets = result.updatedPaths;
    await renRecalcPreview();

    ren.summary.textContent = `완료: ${result.results.filter(r => r.status === 'OK').length} OK / ${result.results.filter(r => r.status.startsWith('ERR')).length} ERR`;
    renSetStatus('ready', 'READY');
  } catch (e) {
    ren.summary.textContent = `Rename 실패: ${String(e)}`;
    renSetStatus('error', 'ERROR');
  } finally {
    renSetBusy(false);
  }
}

async function evaluateGlobalTestStr() {
  const testVal = ren.testStr.value;
  if (!testVal) {
    ren.testRes.textContent = '테스트할 문자열을 입력하면 전체 규칙이 적용된 결과가 표시됩니다.';
    ren.testRes.style.color = 'var(--text-muted)';
    return;
  }

  if (renRules.length === 0) {
    ren.testRes.textContent = testVal;
    ren.testRes.style.color = 'var(--text)';
    return;
  }

  try {
    let dummyPath = `C:\\FakeFolder\\${testVal}`;
    let addedFakeExt = false;

    // 일반적인 확장자가 아니면(즉 확장자가 없는 텍스트 덩어리일 경우)
    // 중간에 있는 마침표(예: .com)를 확장자로 오인하지 않도록 가짜 .mp4를 강제 삽입합니다.
    const hasMediaExt = /\.[a-zA-Z0-9]{2,5}$/i.test(testVal);
    if (!hasMediaExt) {
      dummyPath += '.mp4';
      addedFakeExt = true;
    }

    const previews = await invoke<string[]>('renamer_preview_names', {
      paths: [dummyPath],
      rules: renRules
    });

    if (previews && previews.length > 0) {
      let res = basename(previews[0]);
      // 가짜로 붙였던 .mp4를 결과 시연 시에만 절삭
      if (addedFakeExt && res.toLowerCase().endsWith('.mp4')) {
        res = res.substring(0, res.length - 4);
      }
      ren.testRes.textContent = res;
      ren.testRes.style.color = '#fff';
    }
  } catch (e) {
    ren.testRes.textContent = `오류: ${e}`;
    ren.testRes.style.color = 'var(--danger)';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire up
// ─────────────────────────────────────────────────────────────────────────────
tabBtns.forEach((b) => {
  b.addEventListener('click', () => setActiveTab((b.dataset.tab as any) ?? 'organizer'));
});

// Settings button
btnSettings.addEventListener('click', () => setActiveTab('settings'));

// Drag & Drop for renamer
const renDropZone = $('#renDropZone') as HTMLDivElement;
renDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  renDropZone.classList.add('drag-over');
});
renDropZone.addEventListener('dragleave', () => {
  renDropZone.classList.remove('drag-over');
});
listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
  // Only process if the renamer tab is active
  if (panels.renamer.classList.contains('active')) {
    renDropZone.classList.remove('drag-over');
    if (event.payload && event.payload.paths) {
      await renAddInputs(event.payload.paths);
    }
  }
});

org.btnPickFolder.addEventListener('click', () => void orgPickFolder());
org.btnScan.addEventListener('click', () => void orgScan());
org.btnRun.addEventListener('click', () => void orgRunMove());

btnSettingsLoad.addEventListener('click', () => void loadSettings());
btnSettingsSave.addEventListener('click', () => void saveSettings());

ren.btnAddFiles.addEventListener('click', () => void renPickFiles());
ren.btnAddFolder.addEventListener('click', () => void renPickFolder());
ren.btnRemove.addEventListener('click', () => renRemoveSelectedTargets());
ren.btnClear.addEventListener('click', () => renClearTargets());
ren.btnRename.addEventListener('click', () => void renRename());

ren.btnRuleAdd.addEventListener('click', () => renRuleAdd());
ren.btnRuleEdit.addEventListener('click', () => renRuleEdit());
ren.btnRuleRemove.addEventListener('click', () => renRuleRemove());
ren.btnRuleUp.addEventListener('click', () => renRuleMove(-1));
ren.btnRuleDown.addEventListener('click', () => renRuleMove(1));

ren.modalBackdrop.addEventListener('click', () => closeRuleModal());
ren.modalCancel.addEventListener('click', () => closeRuleModal());
ren.modalSave.addEventListener('click', () => {
  const rule = readRuleFromModal();
  if (!rule) return;

  if (modalMode === 'add') {
    renRules.push(rule);
    selectedRuleIndex = renRules.length - 1;
  } else {
    if (selectedRuleIndex == null) return;
    renRules[selectedRuleIndex] = rule;
  }
  closeRuleModal();
  renRenderRules();
  void renRecalcPreview();
});

function updateRegexPreviewAndTest() {
  const pattern = ren.modalPattern.value;
  const replace = ren.modalReplace.value;
  const testStr = ren.modalTestStr.value;
  const icase = ren.modalIcase.checked;

  ren.modalPatternPreview.innerHTML = highlightRegex(pattern);

  try {
    if (!pattern) {
      ren.modalTestRes.innerHTML = '<span class="text-muted">패턴을 입력하세요.</span>';
      return;
    }

    // JS RegExp doesn't support inline flags like (?i) or (?m).
    // We strip them out globally for the live tester to avoid syntax errors.
    let testPattern = pattern;
    let autoIcase = false;

    testPattern = testPattern.replace(/\(\?([a-zA-Z]+)\)/g, (match, flagsStr) => {
      if (flagsStr.includes('i')) autoIcase = true;
      return '';
    });

    // Also strip non-capturing group inline flags like (?i:...) -> (?:...)
    testPattern = testPattern.replace(/\(\?[a-zA-Z]+:/g, '(?:');

    const flags = (icase || autoIcase) ? 'gi' : 'g';
    const regex = new RegExp(testPattern, flags);

    if (testStr) {
      const replaced = testStr.replace(regex, replace);
      ren.modalTestRes.innerHTML = `<span style="color:var(--success); font-weight:700;">결과: </span> ${escapeHtml(replaced)}`;
    } else {
      ren.modalTestRes.innerHTML = '';
    }
  } catch (e: any) {
    ren.modalTestRes.innerHTML = `<span style="color:var(--danger); font-weight:700;">정규식 문법 오류: ${escapeHtml(e.message || String(e))}</span>`;
  }
}

ren.modalPattern.addEventListener('input', updateRegexPreviewAndTest);
ren.modalReplace.addEventListener('input', updateRegexPreviewAndTest);
ren.modalTestStr.addEventListener('input', updateRegexPreviewAndTest);
ren.modalIcase.addEventListener('change', updateRegexPreviewAndTest);

ren.testStr.addEventListener('input', () => void evaluateGlobalTestStr());

// Organizer events
await listen<MoveProgress>('move_progress', (event) => {
  const p = event.payload;
  orgSetProgress(p.done, p.total, p.filename);
});

await listen<MoveFinished>('move_finished', (event) => {
  const r = event.payload;
  const mode = 'RUN';
  org.summary.textContent = `완료(${mode}): moved=${r.moved}, skipped=${r.skipped}, failed=${r.failed}, folders=${r.createdFolders}`;
  orgSetStatus(r.failed > 0 ? 'error' : 'done', 'READY');
  orgSetBusy(false);
});

await listen<{ message: string }>('log_line', (event) => {
  // shared log -> show in organizer summary only (to avoid mixing)
  org.summary.textContent = event.payload.message;
});

// Initial
setActiveTab('organizer');

orgSetStatus('ready', 'READY');
org.statusPath.textContent = '폴더를 선택하세요';
org.summary.textContent = '대기 중';
orgSetProgress(0, 0, '');

renSetStatus('ready', 'READY');
ren.summary.textContent = '대기 중';
renRenderRules();
renRenderTargets();
void loadSettings();
