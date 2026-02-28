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
