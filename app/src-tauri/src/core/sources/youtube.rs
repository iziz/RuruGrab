use std::{path::{Path, PathBuf}, sync::LazyLock};

use regex::Regex;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::{
  api::models::DownloadItem,
  core::parse::parse_progress_line,
};

use super::{StderrEvent, StdoutEvent};

static RE_VIDEO_ID: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(r"(?x)(?:v=|youtu\.be/|/shorts/|/embed/)(?P<id>[A-Za-z0-9_-]{11})").unwrap()
});

pub fn extract_video_id(url: &str) -> Option<String> {
  RE_VIDEO_ID
    .captures(url)
    .and_then(|c| c.name("id"))
    .map(|m| m.as_str().to_string())
}

fn yt_dlp_remote_components() -> Vec<String> {
  if let Ok(v) = std::env::var("YT_DLP_REMOTE_COMPONENTS") {
    let items: Vec<String> = v
      .split(',')
      .map(|s| s.trim())
      .filter(|s| !s.is_empty())
      .map(|s| s.to_string())
      .collect();
    if !items.is_empty() {
      return items;
    }
  }
  vec!["ejs:github".into(), "ejs:npm".into()]
}

pub fn build_args(
  download_dir: &Path,
  ffmpeg_dir: Option<&PathBuf>,
  cookie_path: Option<&Path>,
  url: &str,
) -> Vec<String> {
  let outtmpl = download_dir
    .join("%(title).200s [%(id)s].%(ext)s")
    .to_string_lossy()
    .to_string();

  let mut args: Vec<String> = vec![
    "--newline".into(),
    "--progress".into(),
    "--no-color".into(),
    "--no-warnings".into(),
    "-f".into(),
    "bv*+ba/b".into(),
    "--format-sort".into(),
    "res,fps,hdr,codec,br,size".into(),
    "--format-sort-force".into(),
    "--merge-output-format".into(),
    "mkv".into(),
    "-o".into(),
    outtmpl,
    "--print".into(),
    "after_move:filepath".into(),
    "--print".into(),
    "before_dl:rurugrab_meta:%(title)s::%(duration_string)s::%(uploader)s::%(resolution)s::%(fps)s::%(tbr)s"
      .into(),
  ];

  for rc in yt_dlp_remote_components() {
    args.push("--remote-components".into());
    args.push(rc);
  }

  if let Some(dir) = ffmpeg_dir {
    args.push("--ffmpeg-location".into());
    args.push(dir.to_string_lossy().to_string());
  }

  if let Some(cp) = cookie_path {
    args.push("--cookies".into());
    args.push(cp.to_string_lossy().to_string());
  }

  args.push(url.to_string());
  args
}

pub fn build_meta_args(cookie_path: Option<&Path>, url: &str) -> Vec<String> {
  let mut args: Vec<String> =
    vec!["--dump-json".into(), "--no-playlist".into(), "--no-color".into()];
  if let Some(cp) = cookie_path {
    args.push("--cookies".into());
    args.push(cp.to_string_lossy().to_string());
  }
  args.push(url.to_string());
  args
}

pub fn parse_stdout(line: &str) -> StdoutEvent {
  // rurugrab_meta:title::duration::uploader::resolution::fps::tbr
  if let Some(meta) = line.strip_prefix("rurugrab_meta:") {
    let parts: Vec<&str> = meta.split("::").collect();
    if parts.len() >= 6 {
      let title: String = parts[0].nfc().collect();
      let duration = parts[1].to_string();
      let uploader: String = parts[2].nfc().collect();
      let resolution = parts[3].to_string();
      let fps: Option<f64> = parts[4].parse().ok();
      let tbr: Option<f64> = parts[5].parse().ok();
      return StdoutEvent::Meta { title, duration, uploader, resolution, fps, tbr };
    }
  }

    if let Some((pct, total, downloaded, speed, eta)) = parse_progress_line(line) {
    return StdoutEvent::Progress {
      percent: pct,
      total_bytes: total,
      downloaded_bytes: downloaded,
      speed,
      eta,
    };
  }

  if std::path::Path::new(line).is_absolute() || line.contains(std::path::MAIN_SEPARATOR) {
    return StdoutEvent::FilePath(line.to_string());
  }

  StdoutEvent::Ignored
}

pub fn parse_stderr(line: &str) -> StderrEvent {
  if let Some(dest) = line.strip_prefix("[download] Destination: ") {
    let dest = dest.trim().trim_matches('"');
    return StderrEvent::Destination(dest.to_string());
  }

  if let Some((pct, total, downloaded, speed, eta)) = parse_progress_line(line) {
    return StderrEvent::Progress {
      percent: pct,
      total_bytes: total,
      downloaded_bytes: downloaded,
      speed,
      eta,
    };
  }

  if line.starts_with("[download]") || line.starts_with("[Merger]") || line.starts_with("[ffmpeg]") {
    return StderrEvent::StatusTransition;
  }

  StderrEvent::Ignored
}

pub fn apply_ytdlp_meta(best_val: &Value, it: &mut DownloadItem) {
  if it.title.is_none() || it.title.as_deref() == Some("") {
    if let Some(t) = best_val.get("title").and_then(|v| v.as_str()) {
      it.title = Some(t.nfc().collect::<String>());
    }
  }

  if let Some(thumb) = best_val.get("thumbnail").and_then(|v| v.as_str()) {
    it.thumbnail = Some(thumb.to_string());
  } else if let Some(thumbs) = best_val.get("thumbnails").and_then(|v| v.as_array()) {
    let best_thumb = thumbs.iter().max_by_key(|t| {
      let w = t.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
      let h = t.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
      w * h
    });
    if let Some(url) =
      best_thumb.or_else(|| thumbs.last()).and_then(|t| t.get("url")).and_then(|v| v.as_str())
    {
      it.thumbnail = Some(url.to_string());
    }
  }

  if let Some(u) = best_val.get("uploader").and_then(|v| v.as_str()) {
    it.uploader = Some(u.nfc().collect::<String>());
  }
  if let Some(d) = best_val.get("duration_string").and_then(|v| v.as_str()) {
    it.duration = Some(d.to_string());
  }
  if let Some(r) = best_val.get("resolution").and_then(|v| v.as_str()) {
    it.resolution = Some(r.to_string());
  }
  if let Some(t) = best_val.get("tbr").and_then(|v| v.as_f64()) {
    it.tbr = Some(t);
  }
  if let Some(v_id) = best_val.get("id").and_then(|v| v.as_str()) {
    it.video_id = Some(v_id.to_string());
  }
}
