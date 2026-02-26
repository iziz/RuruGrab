use std::{sync::Arc, time::Duration};

use serde_json::Value;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

use crate::{
  api::models::Cookie,
  core::{
    io::{cleanup_cookie_file, write_netscape_cookie_file},
    parse::decode_bytes,
    sources::{gallery_dl, youtube, SourceHandler},
    state::AppState,
  },
};

pub async fn fetch_metadata_background(
  app: &tauri::AppHandle,
  state: &Arc<AppState>,
  id: i64,
  url: &str,
  cookies: Vec<Cookie>,
) -> anyhow::Result<()> {
  let handler = SourceHandler::from_url(url);
  let cookie_path =
    state.download_dir().join(".tmp").join(format!("cookies_meta_{}.txt", id));
  let mut use_cookies = false;

  if !cookies.is_empty() {
    let cp = cookie_path.clone();
    match tokio::task::spawn_blocking(move || write_netscape_cookie_file(&cp, &cookies)).await {
      Ok(Ok(())) => use_cookies = true,
      Ok(Err(e)) => state.log_line(format!("[meta] cookie write failed: {e}")),
      Err(e) => state.log_line(format!("[meta] cookie write task panicked: {e}")),
    }
  }
  let cookie_arg = use_cookies.then_some(cookie_path.as_path());

  let args = handler.build_meta_args(cookie_arg, url);
  let (mut events, _child) = app
    .shell()
    .sidecar(handler.sidecar_name())?
    .env("PYTHONIOENCODING", "utf-8")
    .env("PYTHONUTF8", "1")
    .args(args)
    .spawn()?;

  let mut stdout_buf = Vec::new();
  while let Some(ev) = events.recv().await {
    match ev {
      CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
        stdout_buf.extend_from_slice(&bytes)
      }
      CommandEvent::Terminated(_) => break,
      _ => {}
    }
  }

  if use_cookies {
    cleanup_cookie_file(&cookie_path).await;
  }

  let json_str = decode_bytes(&stdout_buf);
  let trimmed = json_str.trim();
  if trimmed.is_empty() {
    return Ok(());
  }

  let payload = {
    let mut s = trimmed;
    if let Some(i) = s.find('[').or_else(|| s.find('{')) {
      s = &s[i..];
    }
    if let Some(j) = s.rfind(']').or_else(|| s.rfind('}')) {
      s = &s[..=j];
    }
    s
  };

  let mut parsed = Vec::new();
  if let Ok(v) = serde_json::from_str::<Value>(payload) {
    parsed.push(v);
  } else {
    for l in json_str.lines().map(|s| s.trim()).filter(|l| !l.is_empty()) {
      if let Ok(v) = serde_json::from_str::<Value>(l) {
        parsed.push(v);
      }
    }
  }

  if parsed.is_empty() {
    state.log_line(format!("[meta] json parse failed. url={url}"));
    return Ok(());
  }

  let best_val = if parsed.len() == 1 {
    &parsed[0]
  } else {
    parsed.iter().max_by_key(|v| gallery_dl::score_meta_like(v)).unwrap_or(&parsed[0])
  };

  let mut inner = state.inner.lock();
  if let Some(it) = inner.find_download_mut(id) {
    if handler.is_gallery_dl() {
      gallery_dl::apply_meta(best_val, parsed.len(), it);
    } else {
      youtube::apply_ytdlp_meta(best_val, it);
    }
  }
  drop(inner);
  state.emit_status_throttled(Duration::from_millis(0));
  Ok(())
}
