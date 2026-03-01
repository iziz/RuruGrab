export const template = `
<section id="tab-downloads" class="tab-panel">
  <div class="card">
    <div class="card-title">Add</div>
    <div class="dl-input-row">
      <input type="url" id="videoUrl" placeholder="YouTube URL" />
      <input type="text" id="dlTitle" placeholder="Optional title" />
      <button class="btn btn-primary" id="btnDownload">Grab</button>
    </div>
    <p class="text-xs text-muted" style="margin-top:6px;">Support URL : Youtube, X (Twitter), Instagram</p>
  </div>

  <div class="flex-row gap-16">
    <span class="fw-bold">Queue: <span id="dlQueueSize">0</span></span>
    <span class="text-muted text-sm">Worker: <span id="dlWorkerAlive">-</span></span>
  </div>

  <div class="dl-list flex-1" id="dlList">
    <div id="dlEmpty" class="text-muted" style="padding:20px;text-align:center;">No downloads</div>
  </div>
</section>
`
