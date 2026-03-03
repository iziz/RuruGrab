import { template as serverTemplate } from '../tabs/server/template.js'
import { template as downloadsTemplate } from '../tabs/downloads/template.js'
import { template as sqliteTemplate } from '../tabs/sqlite/template.js'
import { template as organizerTemplate } from '../tabs/organizer/template.js'
import { template as renamerTemplate } from '../tabs/renamer/template.js'

export function renderApp(root) {
  root.innerHTML = `
    <header class="app-header">
      <div class="app-brand">
        <img class="app-icon" src="/app-icon.png" alt="RuruGrab app icon" />
        <h1>RuruGrab</h1>
      </div>
      <span class="version">1.0.0</span>
    </header>

    <nav class="tab-bar">
      <button class="tab-btn active" data-tab="server">Environment</button>
      <button class="tab-btn" data-tab="downloads">Downloads</button>
      <button class="tab-btn" data-tab="sqlite">YouTube DB</button>
      <button class="tab-btn" data-tab="organizer">Organizer</button>
      <button class="tab-btn" data-tab="renamer">ReNamer</button>
    </nav>

    ${serverTemplate}
    ${downloadsTemplate}
    ${sqliteTemplate}
    ${organizerTemplate}
    ${renamerTemplate}

    <div id="ctxMenu" class="ctx-menu">
      <button class="ctx-menu-item" data-action="cancel">Cancel</button>
      <button class="ctx-menu-item" data-action="retry">Retry</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" data-action="open-folder">Oepn Folder</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" data-action="delete">Delete(from list)</button>
      <button class="ctx-menu-item danger" data-action="delete-files">Delete(with Files)</button>
    </div>
  `
}
