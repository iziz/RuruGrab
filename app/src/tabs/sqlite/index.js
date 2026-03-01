import { dom } from '../../dom.js'
import { setText, escHtml } from '../../domUtils.js'
import { appendGuiLog } from '../../logger.js'
import { apiFetch } from '../../api.js'

// ─────────────────────────────────────────────────────────────────────────────
// SQLite viewer
// ─────────────────────────────────────────────────────────────────────────────
let sqliteDebounce = null

export async function refreshSqlite() {
  const filter = String(dom.sqliteFilter?.value ?? '').trim()

  try {
    const exportJson = await apiFetch(`/watched_export?page=0&page_size=100`)
    const total = exportJson?.total ?? 0
    let rows = exportJson?.records || []

    if (filter) {
      const lf = filter.toLowerCase()
      rows = rows.filter((r) => String(r?.id ?? '').toLowerCase().includes(lf))
    }

    setText(dom.sqliteCount, `Rows: ${total} (showing ${rows.length})`)

    if (dom.sqliteBody) {
      dom.sqliteBody.innerHTML = ''
      for (const r of rows) {
        const tr = document.createElement('tr')
        tr.innerHTML = `<td>${escHtml(r?.id)}</td><td>${escHtml(r?.ts)}</td><td>${escHtml(r?.updated_at || '-')}</td>`
        dom.sqliteBody.appendChild(tr)
      }
    }
  } catch (e) {
    setText(dom.sqliteCount, 'Error')
    appendGuiLog(`[GUI] sqlite refresh failed: ${String(e)}`)
  }
}

export function initSqliteEvents() {
  if (dom.sqliteFilter) {
    dom.sqliteFilter.addEventListener('input', () => {
      clearTimeout(sqliteDebounce)
      sqliteDebounce = setTimeout(refreshSqlite, 250)
    })
  }
}
