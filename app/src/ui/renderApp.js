import { template as serverTemplate } from '../tabs/server/template.js'
import { template as downloadsTemplate } from '../tabs/downloads/template.js'
import { template as sqliteTemplate } from '../tabs/sqlite/template.js'
import { template as organizerTemplate } from '../tabs/organizer/template.js'
import { template as renamerTemplate } from '../tabs/renamer/template.js'
import { template as dupfinderTemplate } from '../tabs/dupfinder/template.js'

export function renderApp(root) {
  root.innerHTML = `
    <header class="app-header">
      <div class="app-brand">
        <img class="app-icon" src="/app-icon.png" alt="RuruGrab app icon" />
        <h1>RuruGrab</h1>
      </div>
    </header>

    <div class="app-body">
      <nav class="sidebar">
        <div class="sidebar-group">📥 Grab</div>
        <button class="sidebar-item active" data-tab="downloads">Download</button>

        <div class="sidebar-group">🔧 Tools</div>
        <button class="sidebar-item" data-tab="organizer">Organize</button>
        <button class="sidebar-item" data-tab="renamer">Rename</button>
        <button class="sidebar-item" data-tab="dupfinder">Dedup</button>

        <div class="sidebar-group">⚙ System</div>
        <button class="sidebar-item" data-tab="server">Status</button>
        <button class="sidebar-item" data-tab="sqlite">DB</button>

        <div class="sidebar-spacer"></div>
        <span class="sidebar-version">v1.0.0</span>
      </nav>

      <div class="content-area">
        ${downloadsTemplate}
        ${serverTemplate}
        ${sqliteTemplate}
        ${organizerTemplate}
        ${renamerTemplate}
        ${dupfinderTemplate}
      </div>
    </div>

    <footer id="statusBar" class="status-bar">
      <span id="statusBarMsg" class="status-bar-msg"></span>
      <span id="statusBarTime" class="status-bar-time"></span>
    </footer>

    <div id="ctxMenu" class="ctx-menu">
      <button class="ctx-menu-item" data-action="cancel">Cancel</button>
      <button class="ctx-menu-item" data-action="retry">Retry</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" data-action="open-folder">Open Folder</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" data-action="delete">Delete(from list)</button>
      <button class="ctx-menu-item danger" data-action="delete-files">Delete(with Files)</button>
    </div>
  `
}
