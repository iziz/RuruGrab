// Config / Environment
export const isTauri =
  typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
  typeof window.__TAURI__ !== 'undefined' ||
  window.location.protocol.startsWith('tauri')

export const API = isTauri
  ? 'http://127.0.0.1:5000'
  : (window.location.origin === 'http://localhost:5173'
    ? 'http://127.0.0.1:5000'
    : window.location.origin)
