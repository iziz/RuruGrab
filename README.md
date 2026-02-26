# RuruGrab (UtubeHolic)

RuruGrab is a **Chrome / Edge** solution for:
- **Media downloading** (YouTube / Instagram / X)
- **YouTube watch-history tracking & visual watch marks**
- Optional **cross-browser history sync** via local/SQLite mechanisms

It is composed of:
- a **Browser Extension (MV3)** that captures pages, shows UI, and manages history
- a **Local Core App (Tauri v2)** that provides stable background processing and tooling

> Repo structure: `extension/` (browser extension) + `app/` (Tauri core app).  
> The shipped product name is currently **UtubeHolic**. :contentReference[oaicite:1]{index=1}

---

## Features

### Media Downloader
- Download **images and videos** from:
  - **YouTube**
  - **Instagram**
  - **X (Twitter)**
- Send the current page/media to a **download queue** via extension actions / context menus. :contentReference[oaicite:2]{index=2}

### Smart YouTube Watch History & Marks
- Track YouTube viewing activity and store it locally.
- Display a **WATCHED** badge/mark on thumbnails so you can identify watched items at a glance. :contentReference[oaicite:3]{index=3}

### Sync (Optional)
- **SQLite Sync**: sync between extension local IndexedDB and a **server-side SQLite** store (requires a compatible server endpoint). :contentReference[oaicite:4]{index=4}
- Cross-browser consistency is a project goal (Chrome ↔ Edge) and is referenced in the repository description. :contentReference[oaicite:5]{index=5}

---

## Architecture

### 1) Browser Extension (MV3)
- Manifest V3, service worker background (`background.js`)
- Content scripts for:
  - YouTube, X(Twitter), Instagram
- Options UI (`options.html`) for:
  - Badge styling (text/colors)
  - Import/export/reset watch DB
  - SQLite sync configuration (server URL, interval) :contentReference[oaicite:6]{index=6}

### 2) Core App (Tauri v2 + Vite + Rust)
- Frontend: **Vite** (dev/build/preview)
- Backend: **Tauri v2**
  - tray icon enabled
  - single-instance, shell, dialog plugins
  - Rust stack includes Axum/Tokio/Reqwest/Rusqlite, etc. :contentReference[oaicite:7]{index=7}
- Bundled external tools configured in Tauri:
  - `yt-dlp`, `ffmpeg`, `ffprobe`, `gallery-dl` :contentReference[oaicite:8]{index=8}

---

## Quick Start (Developer Install)

### A) Run the Core App (Tauri)
```bash
cd app
npm install
npm run dev
npm run tauri dev
