import { serverTab } from './tabs/serverTab'
import { downloadsTab } from './tabs/downloadsTab'
import { sqliteTab } from './tabs/sqliteTab'
import { organizerTab } from './tabs/organizerTab'
import { renamerTab } from './tabs/renamerTab'

export function renderApp(root) {
  root.innerHTML = `
    <header class="app-header">
      <h1>UtubeHolic</h1>
      <span class="version">1.0.0</span>
    </header>

    <nav class="tab-bar">
      <button class="tab-btn active" data-tab="server">Environment</button>
      <button class="tab-btn" data-tab="downloads">Downloads</button>
      <button class="tab-btn" data-tab="sqlite">YouTube DB</button>
      <button class="tab-btn" data-tab="organizer">Organizer</button>
      <button class="tab-btn" data-tab="renamer">ReNamer</button>
    </nav>

    ${serverTab}
    ${downloadsTab}
    ${sqliteTab}
    ${organizerTab}
    ${renamerTab}

    <div id="ctxMenu" class="ctx-menu">
      <button class="ctx-menu-item" data-action="cancel">Cancel</button>
      <button class="ctx-menu-item" data-action="retry">Retry</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" data-action="delete">Delete(from list)</button>
      <button class="ctx-menu-item danger" data-action="delete-files">Delete(with Files)</button>
    </div>
  `
}
