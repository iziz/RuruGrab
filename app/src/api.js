import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { isTauri, API } from './config.js'
import { appendGuiLog } from './logger.js'

// ─────────────────────────────────────────────────────────────────────────────
// Thumbnail cache
// ─────────────────────────────────────────────────────────────────────────────
const thumbSrcCache = new Map() // key: raw string -> converted src

export function toThumbSrc(raw) {
  const r0 = String(raw ?? '').trim()
  if (!r0) return ''

  if (/^(data:|blob:|asset:)/i.test(r0)) return r0

  try {
    const u = new URL(r0, window.location.href)
    if (u.pathname.endsWith('/thumbnail_proxy') && (u.searchParams.has('url') || u.searchParams.has('path'))) {
      return u.toString()
    }
  } catch { /* ignore */ }

  if (/^https?:\/\//i.test(r0)) {
    return `${API}/thumbnail_proxy?url=${encodeURIComponent(r0)}`
  }

  // Local absolute path (Windows: C:\... or C:/..., Unix: /...)
  // Route through the HTTP server to avoid Tauri asset-protocol scope issues.
  if (/^[a-zA-Z]:[/\\]/.test(r0) || r0.startsWith('/')) {
    return `${API}/thumbnail_proxy?path=${encodeURIComponent(r0)}`
  }

  if (!isTauri) return r0

  const key = r0
  const cached = thumbSrcCache.get(key)
  if (cached) return cached
  const converted = convertFileSrc(r0)
  thumbSrcCache.set(key, converted)
  return converted
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri: URL / path open
// ─────────────────────────────────────────────────────────────────────────────
export async function openPath(pathOrUrl) {
  try {
    await invoke('plugin:shell|open', { path: pathOrUrl })
  } catch (e) {
    appendGuiLog(`[GUI] open failed: ${String(e)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API fetch wrapper
// ─────────────────────────────────────────────────────────────────────────────
export async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts)
  const text = await res.text()

  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (!res.ok) {
    const msg = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)
    throw new Error(`HTTP ${res.status}: ${msg}`)
  }
  return body
}
