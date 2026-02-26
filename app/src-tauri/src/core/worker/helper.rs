use std::{
  path::{Path, PathBuf},
  sync::Arc,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use unicode_normalization::UnicodeNormalization;

use crate::core::{io::list_files_by_video_id, sources::SourceHandler, state::AppState};

pub fn mark_failed(state: &Arc<AppState>, id: i64, error: &str) {
  {
    let mut inner = state.inner.lock();
    inner.progress.status = Some("failed".into());
    inner.progress.error = Some(error.to_string());

    if let Some(it) = inner.find_download_mut(id) {
      it.status = Some("failed".into());
      it.error = Some(error.to_string());
      it.finished_at = Some(AppState::now_ts());
    }
  }
  state.log_line(format!("[worker] failed id={id}: {error}"));
}

pub async fn mark_done(
  app: &tauri::AppHandle,
  state: &Arc<AppState>,
  id: i64,
  url: &str,
  final_paths: &[String],
  handler: SourceHandler,
) {
  let started_at_ts = {
    let inner = state.inner.lock();
    inner.find_download(id).and_then(|it| it.started_at).unwrap_or_else(AppState::now_ts)
  };

  let mut filename = final_paths.first().cloned().or_else(|| {
    handler.extract_media_id(url).and_then(|vid| {
      list_files_by_video_id(&state.download_dir(), &vid)
        .first()
        .map(|p| p.to_string_lossy().to_string())
    })
  });

  let mut local_thumb: Option<String> = None;
  let prefer_local_thumb = matches!(handler, SourceHandler::Instagram);
  let mut existing_thumb = {
    let inner = state.inner.lock();
    inner
      .find_download(id)
      .and_then(|it| it.thumbnail.clone())
      .filter(|t| !t.trim().is_empty())
  };

  if existing_thumb.is_none() || prefer_local_thumb {
    if let Some(media_id) = handler.extract_media_id(url) {
      existing_thumb = handler.thumbnail_fallback(&media_id);
    }
  }

  if handler.needs_recent_file_scan() {
    let since = started_at_ts.saturating_sub(2);
    let recent = list_recent_files_recursive(&state.download_dir(), since);

    let needs_fix = filename.as_deref().map(|f| !Path::new(f).exists()).unwrap_or(true);
    if needs_fix {
      filename = recent.first().map(|p| p.to_string_lossy().to_string());
    }

    if existing_thumb.is_none() {
      local_thumb =
        recent.iter().find(|p| is_image_path(p)).map(|p| p.to_string_lossy().to_string());
    }
  }

  if local_thumb.is_none() && existing_thumb.is_none() || prefer_local_thumb {
    if let Some(f) = filename.as_deref() {
      let p = Path::new(f);
      if is_image_path(p) {
        local_thumb = Some(f.to_string());
      }
    }
  }

  if local_thumb.is_none() && existing_thumb.is_none() || prefer_local_thumb {
    if let Some(f) = filename.as_deref() {
      let p = Path::new(f);
      if is_video_path(p) {
        let out = make_video_thumb_path(p, id);
        if try_generate_video_thumbnail_sidecar(app, p, &out).await {
          state
            .log_line(format!("[thumb] ffmpeg sidecar generated: {}", out.to_string_lossy()));
          local_thumb = Some(out.to_string_lossy().to_string());
        } else {
          state
            .log_line(format!("[thumb] ffmpeg sidecar failed for: {}", p.to_string_lossy()));
        }
      }
    }
  }

  if let Some(f) = &filename {
    let p = Path::new(f);
    if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
      let nfc_name = name.nfc().collect::<String>();
      if name != nfc_name {
        let new_path = p.with_file_name(nfc_name);
        if std::fs::rename(p, &new_path).is_ok() {
          filename = Some(new_path.to_string_lossy().to_string());
        }
      }
    }
  }

  {
    let mut inner = state.inner.lock();
    inner.progress.status = Some("done".into());
    inner.progress.error = None;
    inner.progress.percent = Some(100.0);
    if let Some(f) = &filename {
      inner.progress.filename = Some(f.clone());
    }

    if let Some(t) = &local_thumb {
      inner.progress.thumbnail = Some(t.clone());
    } else if let Some(t) = &existing_thumb {
      inner.progress.thumbnail = Some(t.clone());
    }

    if let Some(it) = inner.find_download_mut(id) {
      it.status = Some("done".into());
      it.error = None;
      it.percent = Some(100.0);
      it.finished_at = Some(AppState::now_ts());
      if let Some(f) = filename {
        it.filename = Some(f);
      }
      if let Some(t) = local_thumb {
        it.thumbnail = Some(t);
      }
    }
  }
  state.log_line(format!("[worker] done id={id}"));
}

pub fn is_image_path(p: &Path) -> bool {
  let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
  matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif")
}

pub fn is_video_path(p: &Path) -> bool {
  let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
  matches!(ext.as_str(), "mp4" | "mkv" | "webm" | "mov" | "m4v" | "avi")
}

pub fn make_video_thumb_path(video_path: &Path, id: i64) -> PathBuf {
  let dir = video_path.parent().unwrap_or_else(|| Path::new("."));
  let stem = video_path.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
  dir.join(format!("{stem}_thumb_{id}.jpg"))
}

pub async fn try_generate_video_thumbnail_sidecar(
  app: &tauri::AppHandle,
  video_path: &Path,
  out_path: &Path,
) -> bool {
  if run_ffmpeg_thumb_sidecar(app, video_path, out_path, Some("0.1")).await {
    return true;
  }
  run_ffmpeg_thumb_sidecar(app, video_path, out_path, None).await
}

pub async fn run_ffmpeg_thumb_sidecar(
  app: &tauri::AppHandle,
  video_path: &Path,
  out_path: &Path,
  seek_sec: Option<&str>,
) -> bool {
  let mut args: Vec<String> = vec![
    "-y".into(),
    "-hide_banner".into(),
    "-loglevel".into(),
    "error".into(),
  ];
  if let Some(ss) = seek_sec {
    args.push("-ss".into());
    args.push(ss.into());
  }
  args.push("-i".into());
  args.push(video_path.to_string_lossy().to_string());
  args.push("-frames:v".into());
  args.push("1".into());
  args.push("-q:v".into());
  args.push("4".into());
  args.push(out_path.to_string_lossy().to_string());

  let cmd = match app.shell().sidecar("ffmpeg") {
    Ok(c) => c,
    Err(_) => return false,
  };

  let (mut events, _child) = match cmd.args(args).spawn() {
    Ok(v) => v,
    Err(_) => return false,
  };

  let mut exit_ok = false;
  while let Some(ev) = events.recv().await {
    if let CommandEvent::Terminated(payload) = ev {
      exit_ok = payload.code == Some(0);
      break;
    }
  }
  exit_ok && out_path.exists()
}

pub fn list_recent_files_recursive(base: &Path, since_ts: i64) -> Vec<PathBuf> {
  let since = if since_ts > 0 {
    UNIX_EPOCH + Duration::from_secs(since_ts as u64)
  } else {
    UNIX_EPOCH
  };
  let mut stack: Vec<PathBuf> = vec![base.to_path_buf()];
  let mut picked: Vec<(SystemTime, PathBuf)> = Vec::new();

  while let Some(dir) = stack.pop() {
    if dir.file_name().and_then(|s| s.to_str()) == Some(".tmp") {
      continue;
    }
    let Ok(rd) = std::fs::read_dir(&dir) else { continue };
    for ent in rd.flatten() {
      let p = ent.path();
      if p.is_dir() {
        stack.push(p);
        continue;
      }
      if !p.is_file() {
        continue;
      }
      let Ok(md) = ent.metadata() else { continue };
      let Ok(mtime) = md.modified() else { continue };
      if mtime < since {
        continue;
      }
      picked.push((mtime, p));
    }
  }
  picked.sort_by_key(|(t, _)| *t);
  picked.into_iter().map(|(_, p)| p).collect()
}
