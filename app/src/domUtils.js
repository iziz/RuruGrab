// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────
export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

// null-safe setter
export function setText(el, text) {
  if (!el) return
  el.textContent = text == null ? '' : String(text)
}

export function setHtml(el, html) {
  if (!el) return
  el.innerHTML = html
}

// Security: HTML escape
export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar — single-line message at the bottom of the app
// ─────────────────────────────────────────────────────────────────────────────
let _statusTimer = null

/**
 * Show a message in the bottom status bar.
 * @param {string} msg   - Text to display
 * @param {'info'|'success'|'error'} [type='info'] - Message type (affects colour)
 * @param {number} [duration=5000] - Auto-fade after ms (0 = sticky)
 */
export function showStatus(msg, type = 'info', duration = 5000) {
  const el = document.getElementById('statusBarMsg')
  const timeEl = document.getElementById('statusBarTime')
  if (!el) return

  if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null }

  el.classList.remove('fade-out', 'is-error', 'is-success')
  if (type === 'error') el.classList.add('is-error')
  else if (type === 'success') el.classList.add('is-success')
  el.textContent = msg
  el.style.opacity = ''

  if (timeEl) {
    const now = new Date()
    timeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  }

  if (duration > 0) {
    _statusTimer = setTimeout(() => {
      el.classList.add('fade-out')
      _statusTimer = null
    }, duration)
  }
}
