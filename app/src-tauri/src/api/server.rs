use std::{
  net::SocketAddr,
  sync::Arc,
};

use axum::{
  extract::{Query, State},
  http::{HeaderValue, Method},
  response::{IntoResponse, Response},
  routing::{get, post},
  Json, Router,
};
use tower_http::cors::{Any, CorsLayer};

use crate::{
  api::models::{
    DownloadActionRequest, DownloadActionResponse, DownloadQueuedResponse, DownloadRequest,
    ErrorResponse, LogsResponse, RemoteChangeEntry, StatusResponse, SyncChangesRequest,
    SyncChangesResponse, WatchedCountResponse, WatchedExportResponse,
  },
  core::{downloader, state::AppState},
};

#[derive(serde::Deserialize)]
struct LogsQuery {
  lines: Option<usize>,
}

#[derive(serde::Deserialize)]
struct ThumbnailProxyQuery {
  url: String,
}

#[derive(serde::Deserialize)]
struct WatchedExportQuery {
  page: Option<i64>,
  page_size: Option<i64>,
}

pub async fn serve(state: Arc<AppState>, bind: SocketAddr) -> anyhow::Result<()> {
  let cors = CorsLayer::new()
    .allow_origin(Any)
    .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
    .allow_headers(Any);

  let router = Router::new()
    .route("/status", get(get_status))
    .route("/download", post(post_download))
    .route("/download_action", post(post_download_action))
    .route("/logs", get(get_logs))
    .route("/thumbnail_proxy", get(get_thumbnail_proxy))
    .route("/watched_export", get(get_watched_export))
    .route("/watched_count", get(get_watched_count))
    .route("/sync_changes", post(post_sync_changes))
    .with_state(state)
    .layer(cors);

  let listener = tokio::net::TcpListener::bind(bind).await?;
  axum::serve(listener, router).await?;
  Ok(())
}

//  NEW: POST /sync_changes — bidirectional push+pull
async fn post_sync_changes(
  State(state): State<Arc<AppState>>,
  Json(req): Json<SyncChangesRequest>,
) -> Response {
  let instance = req.instance.clone();
  let since_seq = req.since_seq;
  let change_count = req.changes.len();

  state.log_line(format!(
    "[sync_changes] instance={instance} push={change_count} since_seq={since_seq}"
  ));

  let db_changes: Vec<crate::core::db::ChangeRecord> = req
    .changes
    .into_iter()
    .map(|c| crate::core::db::ChangeRecord {
      id: c.id,
      action: c.action,
      ts: c.ts,
    })
    .collect();

  let db = state.db.clone();
  let inst = instance.clone();
  let result = tokio::task::spawn_blocking(move || {
    db.sync_changes(&db_changes, since_seq, &inst)
  })
  .await;

  match result {
    Ok(Ok((applied, remote, cursor))) => {
      let db2 = state.db.clone();
      let count = tokio::task::spawn_blocking(move || db2.watched_count().ok())
        .await
        .unwrap_or(None);

      state.log_line(format!(
        "[sync_changes] ok — applied={applied} pull={} cursor={cursor} total={}",
        remote.len(),
        count.unwrap_or(-1)
      ));

      let remote_changes: Vec<RemoteChangeEntry> = remote
        .into_iter()
        .map(|r| RemoteChangeEntry {
          id: r.id,
          action: r.action,
          ts: r.ts,
          seq: r.seq,
        })
        .collect();

      Json(SyncChangesResponse {
        ok: true,
        applied: applied as i64,
        remote_changes,
        cursor,
        server_count: count,
        sqlite_path: Some(state.cfg.sqlite_path.to_string_lossy().to_string()),
        extra: Default::default(),
      })
      .into_response()
    }
    Ok(Err(e)) => {
      state.log_line(format!("[sync_changes] error: {e}"));
      (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse { ok: false, error: e.to_string() }),
      )
        .into_response()
    }
    Err(e) => (
      axum::http::StatusCode::INTERNAL_SERVER_ERROR,
      Json(ErrorResponse { ok: false, error: format!("task panicked: {e}") }),
    )
      .into_response(),
  }
}

//  Existing handlers (unchanged)
async fn get_status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
  Json(state.status_snapshot())
}

async fn post_download(
  State(state): State<Arc<AppState>>,
  Json(req): Json<DownloadRequest>,
) -> Response {
  match downloader::queue_task(&state, req, None).await {
    Ok(id) => Json(DownloadQueuedResponse { ok: true, task_id: id }).into_response(),
    Err(e) => (axum::http::StatusCode::BAD_REQUEST, Json(ErrorResponse { ok: false, error: e.to_string() })).into_response(),
  }
}

async fn post_download_action(
  State(state): State<Arc<AppState>>,
  Json(req): Json<DownloadActionRequest>,
) -> Response {
  let delete_files = req.delete_files.unwrap_or(false);
  match req.action.as_str() {
    "cancel" => {
      let ok = downloader::cancel_task(&state, req.id, delete_files);
      Json(DownloadActionResponse { ok, deleted_paths: None, extra: Default::default() }).into_response()
    }
    "retry" => {
      let ok = downloader::retry_task(&state, req.id).await;
      Json(DownloadActionResponse { ok, deleted_paths: None, extra: Default::default() }).into_response()
    }
    "delete" => {
      let deleted = downloader::delete_task(&state, req.id, delete_files).await;
      Json(DownloadActionResponse { ok: true, deleted_paths: Some(deleted), extra: Default::default() }).into_response()
    }
    _ => (
      axum::http::StatusCode::BAD_REQUEST,
      Json(ErrorResponse { ok: false, error: "unknown action".into() }),
    )
      .into_response(),
  }
}

async fn get_logs(
  State(state): State<Arc<AppState>>,
  Query(q): Query<LogsQuery>,
) -> Json<LogsResponse> {
  let n = q.lines.unwrap_or(2000).clamp(1, 5000);
  let lines = state.log.tail(n);
  Json(LogsResponse { ok: true, lines })
}

async fn get_thumbnail_proxy(Query(q): Query<ThumbnailProxyQuery>) -> Response {
  let url = q.url;
  if !url.starts_with("http://") && !url.starts_with("https://") {
     return (axum::http::StatusCode::BAD_REQUEST, "Invalid URL").into_response();
  }

  let client = match reqwest::Client::builder()
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
    .redirect(reqwest::redirect::Policy::limited(5))
    .timeout(std::time::Duration::from_secs(15))
    .build()
  {
    Ok(c) => c,
    Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
  };

  let is_instagram_like = url.contains("instagram") || url.contains("fbcdn") || url.contains("cdninstagram");
  let mut req = client
    .get(&url)
    .header(reqwest::header::ACCEPT, "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
    .header(reqwest::header::ACCEPT_LANGUAGE, "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
  if is_instagram_like {
    req = req.header(reqwest::header::REFERER, "https://www.instagram.com/");
  }

  match req.send().await {
    Ok(resp) => {
      if resp.status().is_success() {
        let content_type = resp
          .headers()
          .get(axum::http::header::CONTENT_TYPE)
          .and_then(|h| h.to_str().ok())
          .unwrap_or("image/jpeg")
          .to_string();

        match resp.bytes().await {
          Ok(bytes) => {
            let mut builder = Response::builder().status(axum::http::StatusCode::OK);
            if let Ok(hv) = HeaderValue::from_str(&content_type) {
              builder = builder.header(axum::http::header::CONTENT_TYPE, hv);
            }
            builder = builder.header(axum::http::header::CACHE_CONTROL, "public, max-age=86400");

            match builder.body(axum::body::Body::from(bytes)) {
              Ok(res) => res,
              Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
            }
          }
          Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read bytes: {}", e)).into_response(),
        }
      } else {
        (axum::http::StatusCode::BAD_GATEWAY, format!("Upstream returned: {}", resp.status())).into_response()
      }
    }
    Err(e) => (axum::http::StatusCode::BAD_GATEWAY, format!("Failed to fetch: {}", e)).into_response(),
  }
}

async fn get_watched_count(State(state): State<Arc<AppState>>) -> Response {
  let db = state.db.clone();
  let result = tokio::task::spawn_blocking(move || db.watched_count()).await;

  match result {
    Ok(Ok(count)) => {
      state.log_line(format!("[watched_count] count={count}"));
      Json(WatchedCountResponse {
        ok: true,
        count,
        sqlite_path: Some(state.cfg.sqlite_path.to_string_lossy().to_string()),
        extra: Default::default(),
      })
      .into_response()
    }
    Ok(Err(e)) => (
      axum::http::StatusCode::INTERNAL_SERVER_ERROR,
      Json(ErrorResponse { ok: false, error: e.to_string() }),
    )
      .into_response(),
    Err(e) => (
      axum::http::StatusCode::INTERNAL_SERVER_ERROR,
      Json(ErrorResponse { ok: false, error: format!("task panicked: {e}") }),
    )
      .into_response(),
  }
}

async fn get_watched_export(
  State(state): State<Arc<AppState>>,
  Query(q): Query<WatchedExportQuery>,
) -> Response {
  let page = q.page.unwrap_or(0); // 0-indexed
  let page_size = q.page_size.unwrap_or(500);

  let db = state.db.clone();
  let result = tokio::task::spawn_blocking(move || db.watched_export(page, page_size)).await;

  match result {
    Ok(Ok((rows, total))) => {
      let returned = rows.len() as i64;
      let has_more = (page + 1) * page_size < total;
      state.log_line(format!("[watched_export] page={page} size={page_size} returned={returned} total={total}"));
      let records = rows
        .into_iter()
        .map(|r| crate::api::models::WatchedRecord { id: r.id, ts: r.ts })
        .collect();

      Json(WatchedExportResponse {
        ok: true,
        page,
        page_size,
        returned,
        total,
        has_more,
        records,
        sqlite_path: Some(state.cfg.sqlite_path.to_string_lossy().to_string()),
        extra: Default::default(),
      })
      .into_response()
    }
    Ok(Err(e)) => (
      axum::http::StatusCode::INTERNAL_SERVER_ERROR,
      Json(ErrorResponse { ok: false, error: e.to_string() }),
    )
      .into_response(),
    Err(e) => (
      axum::http::StatusCode::INTERNAL_SERVER_ERROR,
      Json(ErrorResponse { ok: false, error: format!("task panicked: {e}") }),
    )
      .into_response(),
  }
}
