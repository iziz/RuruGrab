pub mod gallery_dl;
pub mod youtube;

use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum StdoutEvent {
  Meta {
    title: String,
    duration: String,
    uploader: String,
    resolution: String,
    fps: Option<f64>,
    tbr: Option<f64>,
  },
  Progress {
    percent: f64,
    total_bytes: Option<f64>,
    downloaded_bytes: Option<f64>,
    speed: Option<f64>,
    eta: Option<i64>,
  },
  FilePath(String),
  GalleryFile(String),
  Ignored,
}

#[derive(Debug)]
pub enum StderrEvent {
  Destination(String),
  StatusTransition,
  Progress {
    percent: f64,
    total_bytes: Option<f64>,
    downloaded_bytes: Option<f64>,
    speed: Option<f64>,
    eta: Option<i64>,
  },
  Ignored,
}

// ── SourceHandler ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceHandler {
  YouTube,
  TwitterX,
  Instagram,
  GalleryDlGeneric,
}

impl SourceHandler {
  pub fn from_url(url: &str) -> Self {
    let lower = url.to_ascii_lowercase();
    if lower.contains("youtube.com") || lower.contains("youtu.be") {
      return Self::YouTube;
    }
    if lower.contains("twitter.com") || lower.contains("x.com") {
      return Self::TwitterX;
    }
    if lower.contains("instagram.com") {
      return Self::Instagram;
    }
    if lower.contains("pinterest.com") || lower.contains("pixiv.net") {
      return Self::GalleryDlGeneric;
    }
    Self::YouTube
  }

  pub fn sidecar_name(&self) -> &'static str {
    match self {
      Self::YouTube => "yt-dlp",
      Self::TwitterX | Self::Instagram | Self::GalleryDlGeneric => "gallery-dl",
    }
  }

  pub fn is_gallery_dl(&self) -> bool {
    matches!(self, Self::TwitterX | Self::Instagram | Self::GalleryDlGeneric)
  }

  pub fn build_args(
    &self,
    download_dir: &Path,
    ffmpeg_dir: Option<&PathBuf>,
    cookie_path: Option<&Path>,
    url: &str,
  ) -> Vec<String> {
    if self.is_gallery_dl() {
      gallery_dl::build_args(download_dir, cookie_path, url)
    } else {
      youtube::build_args(download_dir, ffmpeg_dir, cookie_path, url)
    }
  }

  pub fn build_meta_args(&self, cookie_path: Option<&Path>, url: &str) -> Vec<String> {
    if self.is_gallery_dl() {
      gallery_dl::build_meta_args(cookie_path, url)
    } else {
      youtube::build_meta_args(cookie_path, url)
    }
  }

  pub fn parse_stdout(&self, line: &str) -> StdoutEvent {
    if self.is_gallery_dl() {
      gallery_dl::parse_stdout(line)
    } else {
      youtube::parse_stdout(line)
    }
  }

  pub fn parse_stderr(&self, line: &str) -> StderrEvent {
    if self.is_gallery_dl() {
      StderrEvent::Ignored
    } else {
      youtube::parse_stderr(line)
    }
  }

  pub fn extract_media_id(&self, url: &str) -> Option<String> {
    match self {
      Self::YouTube => youtube::extract_video_id(url),
      Self::TwitterX => gallery_dl::extract_twitter_id(url),
      _ => None,
    }
  }

  pub fn thumbnail_fallback(&self, media_id: &str) -> Option<String> {
    match self {
      Self::YouTube => {
        Some(format!("https://img.youtube.com/vi/{}/hqdefault.jpg", media_id))
      }
      _ => None,
    }
  }

  pub fn needs_recent_file_scan(&self) -> bool {
    self.is_gallery_dl()
  }

  pub fn log_prefix(&self) -> &'static str {
    match self {
      Self::YouTube => "[yt-dlp]",
      Self::TwitterX => "[twitter]",
      Self::Instagram => "[instagram]",
      Self::GalleryDlGeneric => "[gallery-dl]",
    }
  }
}
