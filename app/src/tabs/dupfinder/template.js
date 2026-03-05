export const template = `
<section id="tab-dupfinder" class="tab-panel dupfinder-panel">
  <div class="dup-left">
    <!-- Folder Selection Card -->
    <div class="card">
      <div class="card-title">Scan Folders</div>
      <div class="dup-folder-list" id="dupFolderList">
        <div class="text-muted text-sm">No folders added yet.</div>
      </div>
      <div class="mt-8 flex-row gap-8">
        <button class="btn btn-default btn-sm" id="dupBtnAddFolder" style="flex:1;">📁 Add Folder</button>
      </div>
    </div>

    <!-- Search Options Card -->
    <div class="card mt-12">
      <div class="card-title">Search Options</div>

      <div class="mt-8">
        <span class="fw-bold" style="font-size:13px;display:block;margin-bottom:8px;">Comparison Method</span>
        <div class="flex-col gap-6">
          <label class="checkbox-row">
            <input type="radio" name="dupMethod" value="hash" checked /> SHA-256 Hash (most accurate)
          </label>
          <label class="checkbox-row">
            <input type="radio" name="dupMethod" value="name" /> File Name
          </label>
          <label class="checkbox-row">
            <input type="radio" name="dupMethod" value="size" /> File Size
          </label>
        </div>
      </div>

      <div class="field mt-12">
        <span>Min File Size (KB)</span>
        <input type="number" id="dupMinSize" class="input" value="0" min="0" />
      </div>

      <div class="field mt-8">
        <span>Max File Size (MB)</span>
        <input type="number" id="dupMaxSize" class="input" value="" placeholder="No limit" min="0" />
      </div>

      <div class="field mt-8">
        <span>Include Extensions (comma separated)</span>
        <input type="text" id="dupIncludeExt" class="input" placeholder="e.g. jpg,png,mp4" />
      </div>

      <div class="field mt-8">
        <span>Exclude Extensions (comma separated)</span>
        <input type="text" id="dupExcludeExt" class="input" placeholder="e.g. tmp,log" />
      </div>

      <div class="mt-12">
        <label class="checkbox-row">
          <input type="checkbox" id="dupRecursive" checked /> Include Subfolders
        </label>
      </div>

      <div class="mt-12">
        <button class="btn btn-primary btn-sm" id="dupBtnScan" style="width:100%;">🔍 Scan for Duplicates</button>
      </div>

      <div class="mt-8">
        <div class="progress-bar">
          <div id="dupProgressFill" class="progress-fill"></div>
        </div>
        <div class="mt-4 text-muted text-xs" id="dupProgressText">Ready</div>
      </div>
    </div>
  </div>

  <div class="dup-right">
    <div class="card dup-results-card">
      <div class="dup-results-header">
        <div class="card-title" style="margin-bottom:0;">Results</div>
        <span class="text-muted text-sm" id="dupSummary"></span>
        <div class="ml-auto flex-row gap-8">
          <button class="btn btn-default btn-sm" id="dupBtnSelectAll" disabled>☑ Select All Duplicates</button>
          <button class="btn btn-danger btn-sm" id="dupBtnDelete" disabled>🗑 Delete Selected</button>
        </div>
      </div>
      <div class="dup-results-body" id="dupResultsBody">
        <div class="dup-empty-state">
          <span class="dup-empty-icon">📂</span>
          <span>Add folders and scan to find duplicates</span>
        </div>
      </div>
    </div>
  </div>
</section>
`
