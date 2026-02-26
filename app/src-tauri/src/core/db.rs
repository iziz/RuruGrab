use std::path::{Path, PathBuf};

use anyhow::Context;
use parking_lot::Mutex;
use rusqlite::{params, Connection};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct WatchedRecord {
  pub id: String,
  pub ts: i64,
}

/// A change record for bidirectional sync.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ChangeRecord {
  pub id: String,
  pub action: String, // "watch" | "unwatch"
  pub ts: i64,
}

/// A change record returned to the client, including the server-assigned seq.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RemoteChange {
  pub id: String,
  pub action: String,
  pub ts: i64,
  pub seq: i64,
}

pub struct Db {
  conn: Mutex<Connection>,
  #[allow(dead_code)]
  path: PathBuf,
}

impl Db {
  pub fn init(path: &Path) -> anyhow::Result<Self> {
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(path).context("open sqlite")?;

    // ── schema v1 (original) ──────────────────────────────
    conn.execute_batch(
      "CREATE TABLE IF NOT EXISTS watched(\
         video_id TEXT PRIMARY KEY,\
         ts INTEGER NOT NULL,\
         updated_at INTEGER NOT NULL\
       );\
       CREATE INDEX IF NOT EXISTS idx_watched_ts ON watched(ts DESC);"
    )?;

    // ── schema v2 (multi-instance sync) ───────────────────
    // Add columns to existing watched table (safe to call repeatedly).
    Self::migrate_add_column(&conn, "watched", "deleted",  "INTEGER NOT NULL DEFAULT 0");
    Self::migrate_add_column(&conn, "watched", "instance", "TEXT NOT NULL DEFAULT ''");
    Self::migrate_add_column(&conn, "watched", "seq",      "INTEGER NOT NULL DEFAULT 0");

    conn.execute_batch(
      "CREATE INDEX IF NOT EXISTS idx_watched_seq ON watched(seq);\
       CREATE INDEX IF NOT EXISTS idx_watched_deleted ON watched(deleted);"
    )?;

    // Global monotonic sequence counter.
    conn.execute_batch(
      "CREATE TABLE IF NOT EXISTS sync_meta(\
         key TEXT PRIMARY KEY,\
         value INTEGER NOT NULL DEFAULT 0\
       );\
       INSERT OR IGNORE INTO sync_meta(key, value) VALUES('seq', 0);"
    )?;

    Ok(Self { conn: Mutex::new(conn), path: path.to_path_buf() })
  }

  /// Safely add a column if it doesn't already exist.
  fn migrate_add_column(conn: &Connection, table: &str, col: &str, col_type: &str) {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {col} {col_type}");
    // SQLite returns error if column already exists; just ignore it.
    let _ = conn.execute_batch(&sql);
  }

  /// Atomically get-and-increment the global sequence counter.
  fn next_seq(conn: &Connection) -> anyhow::Result<i64> {
    conn.execute(
      "UPDATE sync_meta SET value = value + 1 WHERE key = 'seq'",
      [],
    )?;
    let seq: i64 = conn.query_row(
      "SELECT value FROM sync_meta WHERE key = 'seq'",
      [],
      |row| row.get(0),
    )?;
    Ok(seq)
  }

  // ────────────────────────────────────────────────────────
  //  sync_changes: bidirectional push+pull in one call
  // ────────────────────────────────────────────────────────

  /// Apply incoming changes from a client, then return changes from other
  /// instances since `since_seq`.
  ///
  /// Returns `(applied_count, remote_changes, new_cursor)`.
  pub fn sync_changes(
    &self,
    changes: &[ChangeRecord],
    since_seq: i64,
    instance: &str,
  ) -> anyhow::Result<(usize, Vec<RemoteChange>, i64)> {
    let conn = self.conn.lock();

    // ── Phase 1: Apply incoming changes (push) ────────────
    let mut applied = 0usize;

    if !changes.is_empty() {
      conn.execute_batch("BEGIN")?;

      let commit_result = (|| -> anyhow::Result<()> {
        for c in changes {
          let existing: Option<(i64, i64)> = conn
            .query_row(
              "SELECT ts, deleted FROM watched WHERE video_id = ?1",
              [&c.id],
              |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

          let dominated = match existing {
            Some((old_ts, _old_del)) => c.ts <= old_ts,
            None => false,
          };

          if dominated {
            continue;
          }

          let seq = Self::next_seq(&conn)?;
          let is_delete: i64 = if c.action == "unwatch" { 1 } else { 0 };
          let now = chrono::Utc::now().timestamp();

          match existing {
            None => {
              conn.execute(
                "INSERT INTO watched(video_id, ts, updated_at, deleted, instance, seq) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![c.id, c.ts, now, is_delete, instance, seq],
              )?;
            }
            Some(_) => {
              conn.execute(
                "UPDATE watched SET ts = ?2, updated_at = ?3, deleted = ?4, instance = ?5, seq = ?6 \
                 WHERE video_id = ?1",
                params![c.id, c.ts, now, is_delete, instance, seq],
              )?;
            }
          }
          applied += 1;
        }
        Ok(())
      })();

      match commit_result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
          let _ = conn.execute_batch("ROLLBACK");
          return Err(e);
        }
      }
    }

    // ── Phase 2: Return remote changes (pull) ─────────────
    let mut stmt = conn.prepare(
      "SELECT video_id, ts, deleted, seq FROM watched \
       WHERE seq > ?1 AND instance != ?2 \
       ORDER BY seq ASC \
       LIMIT 50000",
    )?;

    let mut remote: Vec<RemoteChange> = Vec::new();
    let mut rows = stmt.query(params![since_seq, instance])?;
    while let Some(r) = rows.next()? {
      let deleted: i64 = r.get(2)?;
      remote.push(RemoteChange {
        id: r.get(0)?,
        ts: r.get(1)?,
        action: if deleted == 1 { "unwatch".into() } else { "watch".into() },
        seq: r.get(3)?,
      });
    }

    // ── Cursor: max seq in the entire table ───────────────
    let cursor: i64 = conn
      .query_row("SELECT value FROM sync_meta WHERE key = 'seq'", [], |row| row.get(0))
      .unwrap_or(0);

    Ok((applied, remote, cursor))
  }

  /// Count only non-deleted watched records.
  pub fn watched_count(&self) -> anyhow::Result<i64> {
    let conn = self.conn.lock();
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM watched WHERE deleted = 0")?;
    let count: i64 = stmt.query_row([], |row| row.get(0))?;
    Ok(count)
  }

  /// Export non-deleted watched records (for legacy restore).
  /// page 0-indexed (0 = first page).
  pub fn watched_export(&self, page: i64, page_size: i64) -> anyhow::Result<(Vec<WatchedRecord>, i64)> {
    let page = page.max(0);
    let page_size = page_size.clamp(1, 20000);
    let offset = page * page_size;

    let conn = self.conn.lock();

    let mut stmt_total = conn.prepare("SELECT COUNT(*) FROM watched WHERE deleted = 0")?;
    let total: i64 = stmt_total.query_row([], |row| row.get(0))?;

    let mut stmt = conn.prepare(
      "SELECT video_id, ts FROM watched WHERE deleted = 0 ORDER BY ts DESC LIMIT ?1 OFFSET ?2",
    )?;

    let mut rows = stmt.query(params![page_size, offset])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
      out.push(WatchedRecord { id: r.get(0)?, ts: r.get(1)? });
    }
    Ok((out, total))
  }

  #[allow(dead_code)]
  pub fn path(&self) -> &Path {
    &self.path
  }
}

trait OptionalRow<T> {
  fn optional(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalRow<T> for rusqlite::Result<T> {
  fn optional(self) -> rusqlite::Result<Option<T>> {
    match self {
      Ok(v) => Ok(Some(v)),
      Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
      Err(e) => Err(e),
    }
  }
}
