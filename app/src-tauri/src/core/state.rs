use std::{
  collections::HashMap,
  path::PathBuf,
  sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc,
  },
  time::{Duration, Instant},
};

use parking_lot::Mutex;
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
  api::models::{DownloadItem, Progress, StatusResponse},
  core::{config::Config, db::Db, log::LogBuffer},
};

#[derive(Clone, Debug)]
pub struct DownloadTask {
  pub id: i64,
  pub url: String,
  pub source: Option<String>,
  pub title: Option<String>,
  pub cookies: Vec<crate::api::models::Cookie>,
}

#[derive(Default)]
pub struct InnerState {
  pub next_id: i64,
  pub current_id: Option<i64>,
  pub downloads: Vec<DownloadItem>,
  pub progress: Progress,
  pub cancel: HashMap<i64, CancellationToken>,
  pub cancel_delete_files: HashMap<i64, bool>,
  pub cancel_retry: HashMap<i64, bool>,
}

pub struct AppState {
  pub cfg: Config,
  pub db: Arc<Db>,
  pub log: LogBuffer,

  pub inner: Mutex<InnerState>,
  pub queue_tx: mpsc::Sender<DownloadTask>,
  pub queue_size: AtomicI64,
  pub worker_alive: AtomicBool,
  pub quitting: AtomicBool,

  pub app_handle: Mutex<Option<tauri::AppHandle>>,
  last_status_emit: Mutex<Instant>,
}

impl AppState {
  pub fn new(cfg: Config) -> anyhow::Result<(Arc<Self>, mpsc::Receiver<DownloadTask>)> {
    std::fs::create_dir_all(&cfg.download_dir).ok();
    let db = Arc::new(Db::init(&cfg.sqlite_path)?);

    let (tx, rx) = mpsc::channel::<DownloadTask>(256);

    Ok((
      Arc::new(Self {
        cfg,
        db,
        log: LogBuffer::new(4000),
        inner: Mutex::new(InnerState { next_id: 1, ..Default::default() }),
        queue_tx: tx,
        queue_size: AtomicI64::new(0),
        worker_alive: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
        app_handle: Mutex::new(None),
        last_status_emit: Mutex::new(Instant::now() - Duration::from_secs(10)),
      }),
      rx,
    ))
  }

  pub fn set_app_handle(&self, handle: tauri::AppHandle) {
    *self.app_handle.lock() = Some(handle);
  }

  pub fn log_line(&self, line: impl Into<String>) {
    let line = line.into();
    self.log.push(line.clone());
    if let Some(h) = self.app_handle.lock().as_ref() {
      let _ = h.emit("rurugrab:log", line);
    }
  }

  pub fn status_snapshot(&self) -> StatusResponse {
    let inner = self.inner.lock();
    StatusResponse {
      ok: true,
      queue_size: Some(self.queue_size.load(Ordering::Relaxed)),
      progress: Some(inner.progress.clone()),
      downloads: Some(inner.downloads.clone()),
      sqlite_path: Some(self.cfg.sqlite_path.to_string_lossy().to_string()),
      download_dir: Some(self.cfg.download_dir.to_string_lossy().to_string()),
      worker_alive: Some(self.worker_alive.load(Ordering::Relaxed)),
      extra: Default::default(),
    }
  }

  pub fn emit_status_throttled(&self, min_interval: Duration) {
    let mut last = self.last_status_emit.lock();
    if last.elapsed() < min_interval {
      return;
    }
    *last = Instant::now();

    if let Some(h) = self.app_handle.lock().as_ref() {
      let st = self.status_snapshot();
      let _ = h.emit("rurugrab:status", st);
    }
  }

  pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
  }

  pub fn download_dir(&self) -> PathBuf {
    self.cfg.download_dir.clone()
  }
}

impl InnerState {
  pub fn find_download(&self, id: i64) -> Option<&DownloadItem> {
    self.downloads.iter().find(|d| d.id == Some(id))
  }

  pub fn find_download_mut(&mut self, id: i64) -> Option<&mut DownloadItem> {
    self.downloads.iter_mut().find(|d| d.id == Some(id))
  }
}

