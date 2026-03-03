pub mod helper;
pub mod meta;

use std::{ffi::OsString, sync::Arc, time::Duration};

use parking_lot::Mutex;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use crate::{
  api::models::{Cookie, DownloadItem, DownloadRequest, Progress},
  core::{
    io::{
      cleanup_cookie_file, delete_files, list_files_by_video_id, resolve_sidecar_program,
      write_netscape_cookie_file,
    },
    parse::decode_bytes,
    sources::{SourceHandler, StderrEvent, StdoutEvent},
    state::{AppState, DownloadTask},
  },
};

use super::STATUS_EMIT_INTERVAL;
use helper::{mark_done, mark_failed};
use meta::fetch_metadata_background;


fn apply_meta_to_state(
  state: &Arc<AppState>,
  id: i64,
  title: String,
  duration: String,
  uploader: String,
  resolution: String,
  fps: Option<f64>,
  tbr: Option<f64>,
) {
  let mut inner = state.inner.lock();
  inner.progress.title = Some(title.clone());
  inner.progress.duration = Some(duration.clone());
  inner.progress.uploader = Some(uploader.clone());
  inner.progress.resolution = Some(resolution.clone());
  inner.progress.fps = fps;
  inner.progress.tbr = tbr;

  if let Some(it) = inner.find_download_mut(id) {
    it.title = Some(title);
    it.duration = Some(duration);
    it.uploader = Some(uploader);
    it.resolution = Some(resolution);
    it.fps = fps;
    it.tbr = tbr;
  }
}

fn apply_progress_to_state(
  state: &Arc<AppState>,
  id: i64,
  percent: f64,
  total_bytes: Option<f64>,
  downloaded_bytes: Option<f64>,
  speed: Option<f64>,
  eta: Option<i64>,
) {
  let mut inner = state.inner.lock();
  inner.progress.status = Some("downloading".into());
  inner.progress.percent = Some(percent);
  inner.progress.total_bytes = total_bytes;
  inner.progress.downloaded_bytes = downloaded_bytes;
  inner.progress.speed = speed;
  inner.progress.eta = eta;

  if let Some(it) = inner.find_download_mut(id) {
    it.status = Some("downloading".into());
    it.percent = Some(percent);
    it.total_bytes = total_bytes;
    it.downloaded_bytes = downloaded_bytes;
    it.speed = speed;
    it.eta = eta;
  }
}

fn apply_destination_to_state(state: &Arc<AppState>, id: i64, dest: &str) {
  let mut inner = state.inner.lock();
  inner.progress.filename = Some(dest.to_string());
  inner.progress.status = Some("downloading".into());
  if let Some(it) = inner.find_download_mut(id) {
    it.filename = Some(dest.to_string());
    it.status = Some("downloading".into());
  }
}

fn update_gallery_item_count(state: &Arc<AppState>, id: i64, count: i64) {
  let mut inner = state.inner.lock();
  inner.progress.status = Some("downloading".into());
  inner.progress.downloaded_items = Some(count);
  if let Some(it) = inner.find_download_mut(id) {
    it.status = Some("downloading".into());
    it.downloaded_items = Some(count);
  }
}

fn transition_to_downloading(state: &Arc<AppState>, id: i64) {
  let mut inner = state.inner.lock();
  if inner.progress.status.as_deref() == Some("starting") {
    inner.progress.status = Some("downloading".into());
  }
  if let Some(it) = inner.find_download_mut(id) {
    if it.status.as_deref() == Some("starting") {
      it.status = Some("downloading".into());
    }
  }
}

fn configure_yt_dlp_env(
  mut cmd: tauri_plugin_shell::process::Command,
  ffmpeg_dir: Option<&std::path::PathBuf>,
) -> tauri_plugin_shell::process::Command {
  if let Some(dir) = ffmpeg_dir {
    cmd = cmd.current_dir(dir);
    let path_env = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = OsString::new();
    new_path.push(dir.as_os_str());
    new_path.push(if cfg!(windows) { ";" } else { ":" });
    new_path.push(path_env);
    cmd = cmd.env("PATH", new_path);
  }
  cmd
}

pub async fn start_worker(state: Arc<AppState>, mut rx: mpsc::Receiver<DownloadTask>) {
  state.worker_alive.store(true, std::sync::atomic::Ordering::Relaxed);
  state.log_line("[worker] started");

  while let Some(task) = rx.recv().await {
    state.queue_size.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);

    let cancel_token = {
      let mut inner = state.inner.lock();
      inner.current_id = Some(task.id);
      inner.progress = Progress {
        status: Some("starting".into()),
        url: Some(task.url.clone()),
        title: task.title.clone(),
        thumbnail: None,
        duration: None,
        uploader: None,
        resolution: None,
        fps: None,
        tbr: None,
        filename: None,
        percent: Some(0.0),
        speed: None,
        eta: None,
        downloaded_bytes: None,
        total_bytes: None,
        downloaded_items: None,
        total_items: inner.find_download(task.id).and_then(|it| it.total_items),
        error: None,
        extra: Default::default(),
      };

      if let Some(it) = inner.find_download_mut(task.id) {
        it.status = Some("starting".into());
        it.started_at = Some(AppState::now_ts());
        it.downloaded_items = Some(0);
      }

      inner.cancel.entry(task.id).or_insert_with(CancellationToken::new).clone()
    };

    // resolve sidecar paths
    let app = match state.app_handle.lock().clone() {
      Some(h) => h,
      None => {
        state.log_line("[worker] app handle missing");
        continue;
      }
    };

    let ffmpeg_prog = resolve_sidecar_program(&app, "ffmpeg").ok();
    let ffmpeg_dir = ffmpeg_prog.as_ref().and_then(|p| p.parent().map(|p| p.to_path_buf()));

    // cookie file
    let cookie_path =
      state.download_dir().join(".tmp").join(format!("cookies_{}.txt", task.id));
    let mut use_cookies = false;
    if !task.cookies.is_empty() {
      let cp = cookie_path.clone();
      let cookies = task.cookies.clone();
      match tokio::task::spawn_blocking(move || write_netscape_cookie_file(&cp, &cookies)).await {
        Ok(Ok(())) => {
          use_cookies = true;
        }
        Ok(Err(e)) => {
          state.log_line(format!("[worker] cookie write failed: {e}"));
        }
        Err(e) => {
          state.log_line(format!("[worker] cookie write task panicked: {e}"));
        }
      }
    }

    let handler = SourceHandler::from_url(&task.url);
    let cookie_arg = use_cookies.then_some(cookie_path.as_path());
    let args = handler.build_args(&state.download_dir(), ffmpeg_dir.as_ref(), cookie_arg, &task.url);

    let base_cmd = match app.shell().sidecar(handler.sidecar_name()) {
      Ok(c) => c.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1"),
      Err(e) => {
        mark_failed(
          &state,
          task.id,
          &format!("sidecar {} missing: {e}", handler.sidecar_name()),
        );
        continue;
      }
    };

    let cmd = if handler.is_gallery_dl() {
      base_cmd
    } else {
      configure_yt_dlp_env(base_cmd, ffmpeg_dir.as_ref())
    };

    let (mut events, child) = match cmd.args(args).spawn() {
      Ok(v) => v,
      Err(e) => {
        mark_failed(
          &state,
          task.id,
          &format!("spawn {} failed: {e}", handler.sidecar_name()),
        );
        continue;
      }
    };

    // we need a kill handle
    let child = Arc::new(Mutex::new(Some(child)));

    // monitor cancellation
    let cancel_state = state.clone();
    let cancel_child = child.clone();
    let cancel_token_ = cancel_token.clone();
    tauri::async_runtime::spawn(async move {
      cancel_token_.cancelled().await;
      cancel_state.log_line(format!("[worker] cancel requested for id={}", task.id));
      if let Some(ch) = cancel_child.lock().take() {
        let _ = ch.kill();
      }
    });

    let mut final_paths: Vec<String> = Vec::new();

    while let Some(ev) = events.recv().await {
      match ev {
        CommandEvent::Stdout(bytes) => {
          let line = decode_bytes(&bytes);
          let line = line.trim_end_matches(['\r', '\n']).to_string();
          if line.is_empty() {
            continue;
          }

          match handler.parse_stdout(&line) {
            StdoutEvent::Meta { title, duration, uploader, resolution, fps, tbr } => {
              apply_meta_to_state(
                &state, task.id, title, duration, uploader, resolution, fps, tbr,
              );
              state.emit_status_throttled(Duration::from_millis(0));
            }
            StdoutEvent::Progress { percent, total_bytes, downloaded_bytes, speed, eta } => {
              apply_progress_to_state(
                &state, task.id, percent, total_bytes, downloaded_bytes, speed, eta,
              );
              state.emit_status_throttled(STATUS_EMIT_INTERVAL);
            }
            StdoutEvent::FilePath(path) => {
              final_paths.push(path);
            }
            StdoutEvent::GalleryFile(path) => {
              final_paths.push(path.clone());
              let count = final_paths.len() as i64;
              update_gallery_item_count(&state, task.id, count);
              state.emit_status_throttled(STATUS_EMIT_INTERVAL);
              state.log_line(format!("{} Downloaded: {path}", handler.log_prefix()));
            }
            StdoutEvent::Ignored => {}
          }
          state.log_line(format!("{} {line}", handler.log_prefix()));
        }

        CommandEvent::Stderr(bytes) => {
          let s = decode_bytes(&bytes);
          for raw_line in s.lines() {
            let line = raw_line.trim_end();
            if line.is_empty() {
              continue;
            }

            match handler.parse_stderr(line) {
              StderrEvent::Destination(dest) => {
                apply_destination_to_state(&state, task.id, &dest);
                state.emit_status_throttled(Duration::from_millis(0));
              }
              StderrEvent::StatusTransition => {
                transition_to_downloading(&state, task.id);
                state.emit_status_throttled(Duration::from_millis(0));
              }
              StderrEvent::Progress { percent, total_bytes, downloaded_bytes, speed, eta } => {
                apply_progress_to_state(
                  &state, task.id, percent, total_bytes, downloaded_bytes, speed, eta,
                );
                state.emit_status_throttled(STATUS_EMIT_INTERVAL);
              }
              StderrEvent::Ignored => {}
            }
            state.log_line(format!("{} {line}", handler.log_prefix()));
          }
        }

        CommandEvent::Error(e) => {
          state.log_line(format!("{} ERROR: {e}", handler.log_prefix()));
        }

        CommandEvent::Terminated(payload) => {
          let code = payload.code.unwrap_or(-1);
          if cancel_token.is_cancelled() {
            let (delete_files_flag, cancelled_item) = {
              let mut inner = state.inner.lock();
              inner.current_id = None;
              inner.progress.status = Some("cancelled".into());
              inner.progress.error = Some("cancelled".into());

              if let Some(it) = inner.find_download_mut(task.id) {
                it.status = Some("cancelled".into());
                it.error = Some("cancelled".into());
                it.finished_at = Some(AppState::now_ts());
              }

              let dflag = inner.cancel_delete_files.remove(&task.id).unwrap_or(false);
              let snap = inner.find_download(task.id).cloned();
              (dflag, snap)
            };

            if let Some(item) = cancelled_item {
              if let Err(e) = state.db.upsert_download(&item) {
                state.log_line(format!("[db] upsert cancel failed: {e}"));
              }
            }

            if delete_files_flag {
              if let Some(vid) = handler.extract_media_id(&task.url) {
                let dl_dir = state.download_dir();
                let deleted = tokio::task::spawn_blocking(move || {
                  let files = list_files_by_video_id(&dl_dir, &vid);
                  delete_files(&files)
                })
                .await
                .unwrap_or_default();
                if !deleted.is_empty() {
                  state
                    .log_line(format!("[worker] deleted files: {}", deleted.join(", ")));
                }
              }
            }

            cleanup_cookie_file(&cookie_path).await;
            state.emit_status_throttled(Duration::from_millis(0));
            break;
          }

          if code == 0 {
            mark_done(&app, &state, task.id, &task.url, &final_paths, handler).await;
          } else {
            mark_failed(
              &state,
              task.id,
              &format!("{} exit code {code}", handler.sidecar_name()),
            );
          }

          cleanup_cookie_file(&cookie_path).await;
          state.emit_status_throttled(Duration::from_millis(0));
          break;
        }

        _ => { /* non_exhaustive */ }
      }
    }

    let should_retry = {
      let mut inner = state.inner.lock();
      inner.cancel_retry.remove(&task.id).unwrap_or(false)
    };
    if should_retry {
      state.log_line(format!("[worker] retrying id={}", task.id));
      {
        let mut inner = state.inner.lock();
        if let Some(it) = inner.find_download_mut(task.id) {
          it.status = Some("queued".into());
          it.error = None;
          it.percent = Some(0.0);
          it.speed = None;
          it.eta = None;
          it.downloaded_bytes = None;
          it.total_bytes = None;
          it.started_at = None;
          it.finished_at = None;
        }
      }

      let _ = queue_task(
        &state,
        DownloadRequest {
          url: task.url.clone(),
          title: task.title.clone(),
          source: task.source.clone(),
          cookies: Some(task.cookies.clone()),
          extra: Default::default(),
        },
        Some(task.id),
      )
      .await;
    }

    {
      let mut inner = state.inner.lock();
      inner.current_id = None;
    }
  }

  state.worker_alive.store(false, std::sync::atomic::Ordering::Relaxed);
  state.log_line("[worker] stopped");
}

pub async fn queue_task(
  state: &Arc<AppState>,
  req: DownloadRequest,
  fixed_id: Option<i64>,
) -> anyhow::Result<i64> {
  // ── URL dedup: skip if URL already exists in DB (new downloads only) ──
  if fixed_id.is_none() && state.db.url_exists_in_queue(&req.url).unwrap_or(false) {
    anyhow::bail!("already in queue");
  }

  let handler = SourceHandler::from_url(&req.url);

  let id = {
    let mut inner = state.inner.lock();
    let id = fixed_id.unwrap_or_else(|| {
      let id = inner.next_id;
      inner.next_id += 1;
      id
    });

    let item = DownloadItem {
      id: Some(id),
      status: Some("queued".into()),
      source: req.source.clone(),
      url: Some(req.url.clone()),
      title: req.title.clone(),
      thumbnail: None,
      duration: None,
      uploader: None,
      resolution: None,
      fps: None,
      tbr: None,
      filename: None,
      percent: Some(0.0),
      speed: None,
      eta: None,
      downloaded_bytes: None,
      total_bytes: None,
      downloaded_items: None,
      total_items: None,
      error: None,
      created_at: Some(AppState::now_ts()),
      started_at: None,
      finished_at: None,
      video_id: handler.extract_media_id(&req.url),
      extra: Default::default(),
    };

    if let Some(existing) = inner.downloads.iter_mut().find(|d| d.id == Some(id)) {
      *existing = item;
    } else {
      inner.downloads.insert(0, item);
      if inner.downloads.len() > 300 {
        inner.downloads.truncate(300);
      }
    }

    inner.cancel.entry(id).or_insert_with(CancellationToken::new);
    id
  };

  // ── Persist to DB ────────────────────────────────────────────────────
  let item_snap = { state.inner.lock().find_download(id).cloned() };
  if let Some(item) = item_snap {
    if let Err(e) = state.db.upsert_download(&item) {
      state.log_line(format!("[db] upsert_download(queue) failed: {e}"));
    }
  }

  let task = DownloadTask {
    id,
    url: req.url,
    source: req.source,
    title: req.title,
    cookies: req.cookies.unwrap_or_default(),
  };
  let url_clone = task.url.clone();
  let cookies_clone = task.cookies.clone();

  state.queue_size.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
  if let Err(e) = state.queue_tx.send(task).await {
    state.queue_size.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    state.log_line(format!("[queue] send failed (channel closed): {e}"));
    anyhow::bail!("download queue channel closed");
  }

  let app_handle = state.app_handle.lock().clone();
  let state_clone = state.clone();
  let id_clone = id;
  tokio::spawn(async move {
    if let Some(app) = app_handle {
      let _ =
        fetch_metadata_background(&app, &state_clone, id_clone, &url_clone, cookies_clone).await;
    }
  });

  state.emit_status_throttled(Duration::from_millis(0));
  Ok(id)
}

pub fn cancel_task(state: &Arc<AppState>, id: i64, delete_files: bool) -> bool {
  let mut ok = false;
  let mut cancelled_non_running = false;
  {
    let mut inner = state.inner.lock();
    if let Some(tok) = inner.cancel.get(&id).cloned() {
      inner.cancel_delete_files.insert(id, delete_files);
      tok.cancel();
      if inner.current_id != Some(id) {
        if let Some(it) = inner.find_download_mut(id) {
          it.status = Some("cancelled".into());
          it.error = Some("cancelled".into());
          it.finished_at = Some(AppState::now_ts());
        }
        cancelled_non_running = true;
      }
      ok = true;
    }
  }
  if cancelled_non_running {
    let item_snap = { state.inner.lock().find_download(id).cloned() };
    if let Some(item) = item_snap {
      if let Err(e) = state.db.upsert_download(&item) {
        state.log_line(format!("[db] upsert cancel(non-running) failed: {e}"));
      }
    }
  }
  if ok {
    state.emit_status_throttled(Duration::from_millis(0));
  }
  ok
}

pub async fn retry_task(state: &Arc<AppState>, id: i64) -> bool {
  {
    let mut inner = state.inner.lock();
    if inner.current_id == Some(id) {
      inner.cancel_retry.insert(id, true);
      if let Some(tok) = inner.cancel.get(&id) {
        tok.cancel();
      }
      return true;
    }
  }

  let (url, source, title, cookies) = {
    let inner = state.inner.lock();
    let Some(it) = inner.downloads.iter().find(|d| d.id == Some(id)) else {
      return false;
    };
    (
      it.url.clone().unwrap_or_default(),
      it.source.clone(),
      it.title.clone(),
      Vec::<Cookie>::new(),
    )
  };

  let _ = queue_task(
    state,
    DownloadRequest {
      url,
      title,
      source,
      cookies: Some(cookies),
      extra: Default::default(),
    },
    Some(id),
  )
  .await;
  true
}

pub async fn delete_task(
  state: &Arc<AppState>,
  id: i64,
  delete_files_flag: bool,
) -> Vec<String> {
  {
    let inner = state.inner.lock();
    if inner.current_id == Some(id) {
      drop(inner);
      cancel_task(state, id, delete_files_flag);
      return vec![];
    }
  }

  let (video_id, url) = {
    let mut inner = state.inner.lock();
    let mut video_id = None;
    let mut url = None;
    inner.downloads.retain(|it| {
      if it.id == Some(id) {
        video_id = it.video_id.clone();
        url = it.url.clone();
        false
      } else {
        true
      }
    });
    (video_id, url)
  };

  let mut deleted = Vec::new();
  if delete_files_flag {
    let vid = video_id.or_else(|| {
      url.as_deref().and_then(|u| SourceHandler::from_url(u).extract_media_id(u))
    });
    if let Some(vid) = vid {
      let dl_dir = state.download_dir();
      deleted = tokio::task::spawn_blocking(move || {
        let files = list_files_by_video_id(&dl_dir, &vid);
        delete_files(&files)
      })
      .await
      .unwrap_or_default();
    }
  }

  if let Err(e) = state.db.delete_download(id) {
    state.log_line(format!("[db] delete_download failed: {e}"));
  }

  state.emit_status_throttled(Duration::from_millis(0));
  deleted
}
