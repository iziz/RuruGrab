use fancy_regex::Regex;
use serde::Serialize;
use std::{
  collections::BTreeMap,
  path::{Path, PathBuf},
};
use tauri::Emitter;

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
  pub name: String,
  pub from: String,
  pub to: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Group {
  pub prefix: String,
  pub files: Vec<PreviewItem>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
  pub total_files: u32,
  pub matched_files: u32,
  pub groups: Vec<Group>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoveProgress {
  pub done: u32,
  pub total: u32,
  pub filename: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoveFinished {
  pub moved: u32,
  pub skipped: u32,
  pub failed: u32,
  pub created_folders: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────
pub fn scan_folder_internal(folder: &Path, regex_str: &str) -> Result<ScanResult, String> {
  if !folder.exists() {
    return Err("Folder does not exist".into());
  }
  if !folder.is_dir() {
    return Err("Path is not a directory".into());
  }

  let re = Regex::new(regex_str).map_err(|e| e.to_string())?;

  let mut total: u32 = 0;
  let mut map: BTreeMap<String, Vec<PreviewItem>> = BTreeMap::new();

  let rd = std::fs::read_dir(folder).map_err(|e| e.to_string())?;
  for entry in rd {
    let entry = entry.map_err(|e| e.to_string())?;
    let path = entry.path();
    if path.is_file() {
      total += 1;

      let name = entry.file_name().to_string_lossy().to_string();

      if let Ok(Some(cap)) = re.captures(&name) {
        let prefix = cap.get(1).unwrap().as_str().to_string();
        let target = folder.join(&prefix).join(&name);

        map.entry(prefix).or_default().push(PreviewItem {
          name,
          from: path.to_string_lossy().to_string(),
          to: target.to_string_lossy().to_string(),
        });
      }
    }
  }

  let matched: u32 = map.values().map(|v| v.len() as u32).sum();
  let groups: Vec<Group> =
    map.into_iter().map(|(prefix, files)| Group { prefix, files }).collect();

  Ok(ScanResult { total_files: total, matched_files: matched, groups })
}

fn resolve_collision(dest: &Path) -> PathBuf {
  if !dest.exists() {
    return dest.to_path_buf();
  }
  let base = dest.file_stem().unwrap_or_default().to_string_lossy().to_string();
  let ext = dest.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
  let parent = dest.parent().unwrap_or_else(|| Path::new("."));
  let mut i = 1;
  loop {
    let candidate = if ext.is_empty() {
      parent.join(format!("{base} ({i})"))
    } else {
      parent.join(format!("{base} ({i}).{ext}"))
    };
    if !candidate.exists() {
      return candidate;
    }
    i += 1;
  }
}

fn emit_log(window: &tauri::WebviewWindow, message: impl Into<String>) {
  let _ = window.emit("organizer:log", serde_json::json!({ "message": message.into() }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────
#[tauri::command]
pub fn scan_folder(folder: String, regex_str: String) -> Result<ScanResult, String> {
  scan_folder_internal(Path::new(&folder), &regex_str)
}

#[tauri::command]
pub fn start_move(
  window: tauri::WebviewWindow,
  folder: String,
  collision: String,
  regex_str: String,
) -> Result<(), String> {
  let folder_path = PathBuf::from(folder);

  tauri::async_runtime::spawn_blocking(move || {
    let scan = match scan_folder_internal(&folder_path, &regex_str) {
      Ok(s) => s,
      Err(e) => {
        emit_log(&window, format!("scan error: {e}"));
        let _ = window.emit(
          "organizer:move_finished",
          MoveFinished { moved: 0, skipped: 0, failed: 1, created_folders: 0 },
        );
        return;
      }
    };

    let total_ops: u32 = scan.groups.iter().map(|g| g.files.len() as u32).sum();
    let mut done_ops: u32 = 0;
    let mut moved: u32 = 0;
    let mut skipped: u32 = 0;
    let mut failed: u32 = 0;
    let mut created_folders: u32 = 0;

    for g in &scan.groups {
      let target_dir = folder_path.join(&g.prefix);
      if !target_dir.exists() {
        created_folders += 1;
        if let Err(e) = std::fs::create_dir_all(&target_dir) {
          failed += g.files.len() as u32;
          emit_log(&window, format!("mkdir failed: {} ({})", target_dir.to_string_lossy(), e));
          continue;
        }
      }

      for f in &g.files {
        done_ops += 1;
        let _ = window.emit(
          "organizer:move_progress",
          MoveProgress { done: done_ops, total: total_ops, filename: f.name.clone() },
        );

        let mut dst = PathBuf::from(&f.to);
        if dst.exists() {
          if collision == "skip" {
            skipped += 1;
            continue;
          } else if collision == "suffix" {
            dst = resolve_collision(&dst);
          }
        }

        let src = PathBuf::from(&f.from);
        if let Some(parent) = dst.parent() {
          let _ = std::fs::create_dir_all(parent);
        }

        match std::fs::rename(&src, &dst) {
          Ok(_) => moved += 1,
          Err(e) => match std::fs::copy(&src, &dst) {
            Ok(_) => {
              let _ = std::fs::remove_file(&src);
              moved += 1;
            }
            Err(e2) => {
              failed += 1;
              emit_log(
                &window,
                format!(
                  "move failed: {} -> {} ({}, {})",
                  src.to_string_lossy(),
                  dst.to_string_lossy(),
                  e,
                  e2
                ),
              );
            }
          },
        }
      }
    }

    let _ = window.emit(
      "organizer:move_finished",
      MoveFinished { moved, skipped, failed, created_folders },
    );
  });

  Ok(())
}
