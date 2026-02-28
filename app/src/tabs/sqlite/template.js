export const template = `
<section id="tab-sqlite" class="tab-panel">
  <div class="card">
    <div class="card-title">Filter & Stats</div>
    <div class="sqlite-toolbar">
      <input type="text" id="sqliteFilter" placeholder="Filter by video id (LIKE)" />
      <span class="sqlite-count" id="sqliteCount">Rows: -</span>
    </div>
  </div>

  <div class="card flex-col flex-1" style="min-height:200px;">
    <div class="card-title">Watched Videos</div>
    <div class="sqlite-table-wrap flex-1">
      <table class="sqlite-table">
        <thead>
          <tr>
            <th>id</th>
            <th>ts (ms)</th>
            <th>updated_at (ms)</th>
          </tr>
        </thead>
        <tbody id="sqliteBody"></tbody>
      </table>
    </div>
  </div>
</section>
`
