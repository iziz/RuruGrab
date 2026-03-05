export const template = `
<section id="tab-server" class="tab-panel">
  <div class="card">
    <div class="card-title">Server Status</div>
    <div class="status-row">
      <div class="status-indicator">
        <span id="statusDot" class="status-dot running"></span>
        <span id="statusText">RUNNING</span>
      </div>
      <span id="statusUrl" class="status-url">http://127.0.0.1:5000</span>
      <div class="ml-auto flex-row gap-8">
        <button class="btn btn-default btn-sm" id="btnOpenUrl">Open URL</button>
        <button class="btn btn-default btn-sm" id="btnCopyUrl">Copy URL</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Paths</div>
    <div class="path-grid">
      <span class="path-label">Data</span>
      <span class="path-value" id="pathSqlite">-</span>
      <button class="btn btn-default btn-sm" id="btnOpenSqlite">Open</button>

      <span class="path-label">Downloads</span>
      <span class="path-value" id="pathDownloads">-</span>
      <button class="btn btn-default btn-sm" id="btnOpenDownloads">Open</button>
    </div>
  </div>

  <div class="card flex-col flex-1" style="min-height:200px;">
    <div class="card-title">Logs</div>
    <div class="log-tabs">
      <button class="log-tab-btn active" data-log="all">All</button>
      <button class="log-tab-btn" data-log="access">Access</button>
      <button class="log-tab-btn" data-log="sync">Sync</button>
      <button class="log-tab-btn" data-log="download">Download</button>
      <button class="log-tab-btn" data-log="error">Error</button>
      <div class="ml-auto">
        <button class="btn btn-default btn-sm" id="btnClearLogs">Clear</button>
      </div>
    </div>
    <div class="log-container flex-1">
      <div id="log-all" class="log-view active"></div>
      <div id="log-access" class="log-view"></div>
      <div id="log-sync" class="log-view"></div>
      <div id="log-download" class="log-view"></div>
      <div id="log-error" class="log-view"></div>
    </div>
  </div>
</section>
`
