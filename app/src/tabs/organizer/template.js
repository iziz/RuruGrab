export const template = `
<section id="tab-organizer" class="tab-panel organizer-panel">
  <div class="org-left">
    <div class="card">
      <div class="card-title">Organizer Status</div>
      <div class="status-row">
        <div class="status-indicator">
          <span id="orgStatusDot" class="status-dot stopped"></span>
          <span id="orgStatusText">READY</span>
        </div>
      </div>

      <div class="mt-12 flex-col gap-8">
        <span id="orgStatusPath" class="status-url">Select the folder to organize</span>
        <button class="btn btn-default btn-sm" id="orgBtnPickFolder">📁 Select</button>
      </div>

      <div class="mt-12 flex-row gap-8">
        <button class="btn btn-default btn-sm" id="orgBtnScan" style="flex:3;">Rescan</button>
        <button class="btn btn-primary btn-sm" id="orgBtnRun" style="flex:7;">Run</button>
      </div>

      <div class="mt-12">
        <div class="progress-bar">
          <div id="orgProgressFill" class="progress-fill"></div>
        </div>
        <div class="mt-8 text-muted text-xs nowrap" style="display:flex;">
          <span id="orgProgressText">0 / 0</span>
          <span class="ml-auto" id="orgProgressFile"></span>
        </div>
        <div class="mt-4 text-muted text-sm" id="orgSummary">Ready</div>
      </div>

      <div class="field mt-24">
        <span class="fw-bold mb-8" style="font-size:13px;">Organizer Regex</span>
        <input
          type="text"
          id="orgRegex"
          class="input"
          value="^([A-Za-z0-9]{2,8})-(.+)"
          style="font-family:var(--font-mono,monospace);"
        />
      </div>

      <div class="mt-12">
        <span class="fw-bold" style="font-size:13px;display:block;margin-bottom:8px;">Duplicate Name Handling</span>
        <div class="flex-col gap-6">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
            <input type="radio" name="orgCollision" value="suffix" checked /> suffix (numbered)
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
            <input type="radio" name="orgCollision" value="skip" /> skip (skip duplicates)
          </label>
        </div>
      </div>
    </div>
  </div>

  <div class="org-right">
    <div class="card preview-container">
      <div class="card-title">Preview</div>
      <div class="sqlite-table-wrap">
        <table class="preview-table">
          <thead>
            <tr>
              <th>Destination → Files</th>
            </tr>
          </thead>
          <tbody id="orgPreviewBody">
            <tr>
              <td class="text-muted">Scan results.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</section>
`
