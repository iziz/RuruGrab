export const renamerTab = `
<section id="tab-renamer" class="tab-panel renamer-panel">
  <div style="display:flex;flex-direction:row;gap:12px;flex:1;min-height:0;overflow:hidden;">
    <div style="flex:7;display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;">
      <div class="card" style="flex:7;display:flex;flex-direction:column;min-height:0;">
        <div class="card-title">Rules</div>
        <div class="status-row">
          <div class="status-indicator">
            <span id="renStatusDot" class="status-dot ready"></span>
            <span id="renStatusText">READY</span>
          </div>
        </div>
        <div id="renRulesWrap" class="sqlite-table-wrap mt-12">
          <table class="preview-table" style="table-layout:fixed;">
            <thead>
              <tr>
                <th style="width:44px;"></th>
                <th style="width:110px;">Name</th>
                <th>Pattern</th>
                <th style="width:90px;">Replace</th>
              </tr>
            </thead>
            <tbody id="renRulesBody">
              <tr>
                <td colspan="4" class="text-muted">Loading...</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="mt-12 flex-row gap-8">
          <button class="btn btn-default btn-sm" id="renRuleAdd">Add</button>
          <button class="btn btn-default btn-sm" id="renRuleEdit">Edit</button>
          <button class="btn btn-default btn-sm" id="renRuleRemove">Remove</button>
          <div class="ml-auto flex-row gap-8">
            <button class="btn btn-default btn-sm" id="renRuleUp">Up</button>
            <button class="btn btn-default btn-sm" id="renRuleDown">Down</button>
            <button class="btn btn-default btn-sm" id="btnRenSettingsSave">Save Settings</button>
          </div>
        </div>
      </div>

      <div class="card" style="flex:3;display:flex;flex-direction:column;min-height:0;">
        <div class="card-title">Tester</div>
        <div style="display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;">
          <div class="flex-col gap-4">
            <span style="font-weight:700;font-size:12px;color:var(--text-muted);">Test String</span>
            <input id="renGlobalTestStr" type="text" placeholder="Insert text..." />
          </div>
          <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-height:0;">
            <span style="font-weight:700;font-size:12px;color:var(--success);">Result</span>
            <div
              id="renGlobalTestRes"
              class="text-muted"
              style="flex:1;font-family:var(--font-mono,monospace);font-size:13px;padding:6px 10px;background:var(--bg-base);border-radius:4px;border:1px dashed var(--border);overflow-y:auto;word-break:break-all;"
            >
              When you enter text, the result will be displayed.
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="flex:3;display:flex;flex-direction:column;min-height:0;min-width:0;">
      <div class="card-title">Targets</div>
      <div class="sqlite-table-wrap" id="renDropZone" style="flex:1;min-height:60px;">
        <table class="preview-table">
          <thead>
            <tr>
              <th style="width:36px;"></th>
              <th>Current Name</th>
              <th style="width:14px;"></th>
            </tr>
          </thead>
          <tbody id="renTargetsBody">
            <tr>
              <td colspan="3" class="text-muted">Add files</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-12 flex-row gap-8" style="flex-wrap:wrap;row-gap:6px;">
        <button class="btn btn-default btn-sm" id="renAddFiles">Add files</button>
        <button class="btn btn-default btn-sm" id="renAddFolder">Add folder</button>
        <button class="btn btn-default btn-sm" id="renRemove">Remove</button>
        <button class="btn btn-default btn-sm" id="renClear">Clear</button>
        <button class="btn btn-primary btn-sm ml-auto" id="renRename">Rename</button>
      </div>
      <div class="mt-8 text-muted text-sm" id="renSummary">Idle</div>
    </div>
  </div>

  <div id="renRuleModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-backdrop" id="renRuleModalBackdrop"></div>
    <div class="modal-card">
      <div class="modal-title" id="renRuleModalTitle">Edit rule</div>
      <div class="modal-grid">
        <label class="field"><span>Name</span><input id="renRuleName" type="text" /></label>
        <label class="field">
          <span>Pattern (regex)</span>
          <input id="renRulePattern" type="text" />
          <div id="renRulePatternPreview" class="rx-preview-box mt-4"></div>
        </label>
        <label class="field">
          <span>Test String (optional)</span>
          <input id="renRuleTestStr" type="text" placeholder="Sample text..." />
          <div id="renRuleTestResult" class="rx-test-result mt-4 text-sm" style="min-height:20px;"></div>
        </label>
        <label class="field"><span>Replace</span><input id="renRuleReplace" type="text" /></label>
        <div class="field-row">
          <label class="field">
            <span>Apply to</span>
            <select id="renRuleApplyTo" class="select">
              <option value="stem">stem</option>
              <option value="full">full</option>
            </select>
          </label>
          <label class="field">
            <span>Case</span>
            <select id="renRuleCase" class="select">
              <option value=""></option>
              <option value="upper">upper</option>
              <option value="lower">lower</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>When contains (comma separated)</span>
          <input id="renRuleWhenContains" type="text" placeholder="optional" />
        </label>
        <label class="checkbox-row">
          <input id="renRuleContainsIcase" type="checkbox" />
          <span>Ignore case</span>
        </label>
      </div>
      <div class="mt-12 flex-row gap-8">
        <button class="btn btn-default btn-sm" id="renRuleCancel">Cancel</button>
        <div class="ml-auto"></div>
        <button class="btn btn-primary btn-sm" id="renRuleSave">Save</button>
      </div>
      <div class="mt-10 text-muted text-xs" id="renRuleModalHint">
        Note: Supports Python-style back-references (e.g. \\1-\\2).
      </div>
    </div>
  </div>
</section>
`
