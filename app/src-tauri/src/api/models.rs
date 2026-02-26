use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ErrorResponse {
  pub ok: bool,
  pub error: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Cookie {
  pub domain: Option<String>,
  pub name: Option<String>,
  pub value: Option<String>,
  pub path: Option<String>,
  pub secure: Option<bool>,
  #[serde(rename = "expirationDate")]
  pub expiration_date: Option<f64>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DownloadRequest {
  pub url: String,
  pub title: Option<String>,
  pub source: Option<String>,
  pub cookies: Option<Vec<Cookie>>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadQueuedResponse {
  pub ok: bool,
  pub task_id: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadActionRequest {
  pub id: i64,
  pub action: String, // cancel|retry|delete
  pub delete_files: Option<bool>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DownloadActionResponse {
  pub ok: bool,
  pub deleted_paths: Option<Vec<String>>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Progress {
  pub status: Option<String>,
  pub url: Option<String>,
  pub title: Option<String>,
  pub thumbnail: Option<String>,
  pub duration: Option<String>,
  pub uploader: Option<String>,
  pub resolution: Option<String>,
  pub fps: Option<f64>,
  pub tbr: Option<f64>,
  pub filename: Option<String>,
  pub percent: Option<f64>,
  pub speed: Option<f64>,
  pub eta: Option<i64>,
  pub downloaded_bytes: Option<f64>,
  pub total_bytes: Option<f64>,
  pub downloaded_items: Option<i64>,
  pub total_items: Option<i64>,
  pub error: Option<String>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DownloadItem {
  pub id: Option<i64>,
  pub status: Option<String>,
  pub source: Option<String>,
  pub url: Option<String>,
  pub title: Option<String>,
  pub thumbnail: Option<String>,
  pub duration: Option<String>,
  pub uploader: Option<String>,
  pub resolution: Option<String>,
  pub fps: Option<f64>,
  pub tbr: Option<f64>,
  pub filename: Option<String>,
  pub percent: Option<f64>,
  pub speed: Option<f64>,
  pub eta: Option<i64>,
  pub downloaded_bytes: Option<f64>,
  pub total_bytes: Option<f64>,
  pub downloaded_items: Option<i64>,
  pub total_items: Option<i64>,
  pub error: Option<String>,
  pub created_at: Option<i64>,
  pub started_at: Option<i64>,
  pub finished_at: Option<i64>,
  pub video_id: Option<String>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct StatusResponse {
  pub ok: bool,
  pub queue_size: Option<i64>,
  pub progress: Option<Progress>,
  pub downloads: Option<Vec<DownloadItem>>,
  pub sqlite_path: Option<String>,
  pub download_dir: Option<String>,
  pub worker_alive: Option<bool>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogsResponse {
  pub ok: bool,
  pub lines: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WatchedRecord {
  pub id: String,
  pub ts: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct WatchedCountResponse {
  pub ok: bool,
  pub count: i64,
  pub sqlite_path: Option<String>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct WatchedExportResponse {
  pub ok: bool,
  pub page: i64,
  pub page_size: i64,
  pub returned: i64,
  pub total: i64,
  pub has_more: bool,
  pub records: Vec<WatchedRecord>,
  pub sqlite_path: Option<String>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

// ════════════════════════════════════════════════════════════
//  NEW: Bidirectional sync models
// ════════════════════════════════════════════════════════════

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncChangeEntry {
  pub id: String,
  pub action: String, // "watch" | "unwatch"
  pub ts: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncChangesRequest {
  pub instance: String,
  pub changes: Vec<SyncChangeEntry>,
  pub since_seq: i64,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteChangeEntry {
  pub id: String,
  pub action: String,
  pub ts: i64,
  pub seq: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SyncChangesResponse {
  pub ok: bool,
  pub applied: i64,
  pub remote_changes: Vec<RemoteChangeEntry>,
  pub cursor: i64,
  pub server_count: Option<i64>,
  pub sqlite_path: Option<String>,

  #[serde(flatten)]
  pub extra: HashMap<String, serde_json::Value>,
}
