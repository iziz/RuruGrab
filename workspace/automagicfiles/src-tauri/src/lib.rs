#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use fancy_regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
  collections::{BTreeMap, HashSet},
  env,
  path::{Path, PathBuf},
  process::Command,
};

use tauri::Emitter;

// ─────────────────────────────────────────────────────────────────────────────
// Organizer engine (folder grouping + move)
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreviewItem {
  name: String,
  from: String,
  to: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Group {
  prefix: String,
  files: Vec<PreviewItem>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
  total_files: u32,
  matched_files: u32,
  groups: Vec<Group>,
}

fn scan_folder_internal(folder: &Path, regex_str: &str) -> Result<ScanResult, String> {
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

  let groups: Vec<Group> = map.into_iter().map(|(prefix, files)| Group { prefix, files }).collect();

  Ok(ScanResult {
    total_files: total,
    matched_files: matched,
    groups,
  })
}

#[tauri::command]
fn scan_folder(folder: String, regex_str: String) -> Result<ScanResult, String> {
  scan_folder_internal(Path::new(&folder), &regex_str)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MoveProgress {
  done: u32,
  total: u32,
  filename: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MoveFinished {
  moved: u32,
  skipped: u32,
  failed: u32,
  created_folders: u32,
}

fn emit_log(window: &tauri::WebviewWindow, message: impl Into<String>) {
  let _ = window.emit("log_line", serde_json::json!({ "message": message.into() }));
}

#[tauri::command]
fn start_move(window: tauri::WebviewWindow, folder: String, collision: String, regex_str: String) -> Result<(), String> {
  let folder_path = PathBuf::from(folder);

  tauri::async_runtime::spawn_blocking(move || {
    let scan = match scan_folder_internal(&folder_path, &regex_str) {
      Ok(s) => s,
      Err(e) => {
        emit_log(&window, format!("scan error: {e}"));
        let _ = window.emit(
          "move_finished",
          MoveFinished {
            moved: 0,
            skipped: 0,
            failed: 1,
            created_folders: 0,
          },
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
          "move_progress",
          MoveProgress {
            done: done_ops,
            total: total_ops,
            filename: f.name.clone(),
          },
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
          Err(e) => {
            match std::fs::copy(&src, &dst) {
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
            }
          }
        }
      }
    }

    let _ = window.emit(
      "move_finished",
      MoveFinished {
        moved,
        skipped,
        failed,
        created_folders,
      },
    );
  });

  Ok(())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
  let p = PathBuf::from(path);
  if !p.exists() {
    return Err("path does not exist".into());
  }

  #[cfg(target_os = "windows")]
  {
    Command::new("explorer").arg(p).spawn().map_err(|e| e.to_string())?;
    return Ok(());
  }

  #[cfg(target_os = "macos")]
  {
    Command::new("open").arg(p).spawn().map_err(|e| e.to_string())?;
    return Ok(());
  }

  #[cfg(target_os = "linux")]
  {
    Command::new("xdg-open").arg(p).spawn().map_err(|e| e.to_string())?;
    return Ok(());
  }

  #[allow(unreachable_code)]
  Err("open_path not supported on this platform".into())
}

// ─────────────────────────────────────────────────────────────────────────────
// ReNamer engine (rules + preview + apply)
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct RenamerRule {
  name: String,
  pattern: String,
  replace: String,
  #[serde(default = "default_apply_to")]
  apply_to: String, // "stem" | "full"
  #[serde(default)]
  case: String, // "" | "upper" | "lower"
  #[serde(default)]
  when_contains: Vec<String>,
  #[serde(default)]
  contains_ignore_case: bool,
}

fn default_apply_to() -> String {
  "stem".to_string()
}

#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GlobalSettings {
  #[serde(default = "default_collision")]
  collision: String, // "suffix" | "skip" ...
  #[serde(default = "default_organizer_regex")]
  organizer_regex: String,
  #[serde(default, rename = "renamerRules")]
  renamer_rules: Vec<RenamerRule>,
}

fn default_organizer_regex() -> String {
  "^([A-Za-z0-9]{2,8})-(.+)".to_string()
}

fn default_collision() -> String {
  "suffix".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsLoadResponse {
  settings: GlobalSettings,
  loaded_from: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenamerRowResult {
  index: usize,
  from: String,
  to: String,
  status: String, // OK | SKIP | ERR: ...
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenamerApplyResult {
  updated_paths: Vec<String>,
  results: Vec<RenamerRowResult>,
}

fn app_data_dir() -> PathBuf {
  if cfg!(target_os = "windows") {
    let base = env::var("LOCALAPPDATA")
      .or_else(|_| env::var("APPDATA"))
      .unwrap_or_else(|_| {
        let home = env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
        format!("{home}\\AppData\\Local")
      });
    let p = PathBuf::from(base).join("AutomagicFiles");
    let _ = std::fs::create_dir_all(&p);
    return p;
  }

  let base = env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{home}/.config")
  });
  let p = PathBuf::from(base).join("AutomagicFiles");
  let _ = std::fs::create_dir_all(&p);
  p
}

fn exe_dir() -> Option<PathBuf> {
  env::current_exe().ok().and_then(|p| p.parent().map(|x| x.to_path_buf()))
}

fn settings_search_paths() -> Vec<PathBuf> {
  let mut v = Vec::new();
  v.push(app_data_dir().join("settings.json"));
  if let Some(ed) = exe_dir() {
    v.push(ed.join("settings.json"));
    v.push(ed.join("rename_rules.json"));
    v.push(ed.join("renamer.json")); // fallback
  }
  if let Ok(cd) = env::current_dir() {
    v.push(cd.join("settings.json"));
    v.push(cd.join("renamer.json")); // fallback
  }
  v
}

fn default_rules() -> Vec<RenamerRule> {
  vec![
    RenamerRule {
      name: "normalize spaces".to_string(),
      pattern: r"\s+".to_string(),
      replace: " ".to_string(),
      apply_to: "stem".to_string(),
      case: "".to_string(),
      when_contains: vec![],
      contains_ignore_case: false,
    },
    RenamerRule {
      name: "spaces_to_underscore".to_string(),
      pattern: r" ".to_string(),
      replace: "_".to_string(),
      apply_to: "stem".to_string(),
      case: "".to_string(),
      when_contains: vec![],
      contains_ignore_case: false,
    },
  ]
}

// Convert python-style group references (\1, \2) into Rust regex style ($1, $2).
fn python_repl_to_rust(repl: &str) -> String {
  // Replace \1 .. \99 with $1 .. $99
  let mut out = String::with_capacity(repl.len());
  let mut chars = repl.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '\\' {
      let mut digits = String::new();
      while let Some(nc) = chars.peek() {
        if nc.is_ascii_digit() {
          digits.push(*nc);
          chars.next();
        } else {
          break;
        }
      }
      if !digits.is_empty() {
        out.push('$');
        out.push_str(&digits);
      } else {
        out.push('\\');
      }
    } else {
      out.push(c);
    }
  }
  out
}

fn apply_case(s: String, case_mode: &str) -> String {
  match case_mode {
    "upper" => s.to_uppercase(),
    "lower" => s.to_lowercase(),
    _ => s,
  }
}

fn split_name(name: &str) -> (String, String) {
  // returns (stem, suffix-with-dot or "")
  if let Some(pos) = name.rfind('.') {
    if pos > 0 && pos < name.len() - 1 {
      let stem = name[..pos].to_string();
      let suf = name[pos..].to_string();
      return (stem, suf);
    }
  }
  (name.to_string(), "".to_string())
}

fn preview_name_for(path: &Path, rules: &[RenamerRule]) -> String {
  let original_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
  let mut name = original_name.clone();
  let (mut stem, mut suffix) = split_name(&name);

  for rule in rules {
    // gating by original filename
    if !rule.when_contains.is_empty() {
      let needles: Vec<String> = rule.when_contains.iter().filter(|s| !s.trim().is_empty()).cloned().collect();
      if !needles.is_empty() {
        let ok = if rule.contains_ignore_case {
          let hay = original_name.to_lowercase();
          needles.iter().any(|n| hay.contains(&n.to_lowercase()))
        } else {
          needles.iter().any(|n| original_name.contains(n))
        };
        if !ok {
          continue;
        }
      }
    }

    let rx = match Regex::new(&rule.pattern) {
      Ok(r) => r,
      Err(_) => continue, // invalid regex -> skip
    };

    let repl = python_repl_to_rust(&rule.replace);

    if rule.apply_to == "full" {
      name = rx.replace_all(&name, repl.as_str()).to_string();
      name = apply_case(name, &rule.case);
      let parts = split_name(&name);
      stem = parts.0;
      suffix = parts.1;
    } else {
      stem = rx.replace_all(&stem, repl.as_str()).to_string();
      stem = apply_case(stem, &rule.case);
      name = format!("{stem}{suffix}");
    }
  }

  if stem.trim().is_empty() {
    if suffix.is_empty() {
      "_".to_string()
    } else {
      format!("_{suffix}")
    }
  } else {
    name
  }
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

fn is_file(p: &Path) -> bool {
  p.exists() && p.is_file()
}

#[tauri::command]
fn renamer_expand_inputs(inputs: Vec<String>) -> Result<Vec<String>, String> {
  let mut expanded: Vec<PathBuf> = Vec::new();

  for s in inputs {
    let p = PathBuf::from(s);
    if p.exists() && p.is_dir() {
      let rd = std::fs::read_dir(&p).map_err(|e| e.to_string())?;
      for e in rd {
        if let Ok(e) = e {
          let child = e.path();
          if is_file(&child) {
            expanded.push(child);
          }
        }
      }
    } else if is_file(&p) {
      expanded.push(p);
    }
  }

  // de-dup (case-insensitive on Windows)
  let mut seen: HashSet<String> = HashSet::new();
  let mut out: Vec<String> = Vec::new();
  for p in expanded {
    let key = if cfg!(target_os = "windows") {
      p.to_string_lossy().to_string().to_lowercase()
    } else {
      p.to_string_lossy().to_string()
    };
    if !seen.contains(&key) {
      seen.insert(key);
      out.push(p.to_string_lossy().to_string());
    }
  }
  Ok(out)
}

#[tauri::command]
fn renamer_preview_names(paths: Vec<String>, rules: Vec<RenamerRule>) -> Result<Vec<String>, String> {
  let mut out: Vec<String> = Vec::with_capacity(paths.len());
  for p in paths {
    let pb = PathBuf::from(&p);
    let name = preview_name_for(&pb, &rules);
    out.push(name);
  }
  Ok(out)
}

fn load_settings_internal() -> (GlobalSettings, String) {
  for p in settings_search_paths() {
    if p.exists() {
      match std::fs::read_to_string(&p) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
          Ok(v) => {
            // normalize like python: when_contains may be string or list
            let mut settings = GlobalSettings::default();
            settings.collision = v.get("collision").and_then(|x| x.as_str()).unwrap_or("suffix").to_string();
            settings.organizer_regex = v.get("organizerRegex").and_then(|x| x.as_str()).unwrap_or("^([A-Za-z0-9]{2,8})-(.+)").to_string();

            let mut rules: Vec<RenamerRule> = Vec::new();
            let rules_val = v.get("renamerRules").or_else(|| v.get("rules"));
            if let Some(arr) = rules_val.and_then(|x| x.as_array()) {
              for r in arr {
                let name = r.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let pattern = r.get("pattern").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let replace = r.get("replace").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let apply_to = r.get("apply_to").and_then(|x| x.as_str()).unwrap_or("stem").to_string();
                let case = r.get("case").and_then(|x| x.as_str()).unwrap_or("").to_string();

                let when_val = r.get("when_contains")
                  .or_else(|| r.get("filename_contains"))
                  .or_else(|| r.get("name_contains"));

                let mut when_contains: Vec<String> = Vec::new();
                if let Some(w) = when_val {
                  if let Some(s) = w.as_str() {
                    let s = s.trim();
                    if !s.is_empty() {
                      when_contains.push(s.to_string());
                    }
                  } else if let Some(a) = w.as_array() {
                    for x in a {
                      if let Some(ss) = x.as_str() {
                        let ss = ss.trim();
                        if !ss.is_empty() {
                          when_contains.push(ss.to_string());
                        }
                      }
                    }
                  } else {
                    let ss = w.to_string().trim().trim_matches('"').to_string();
                    if !ss.is_empty() {
                      when_contains.push(ss);
                    }
                  }
                }

                let contains_ignore_case = r
                  .get("contains_ignore_case")
                  .or_else(|| r.get("contains_icase"))
                  .and_then(|x| x.as_bool())
                  .unwrap_or(false);

                rules.push(RenamerRule {
                  name,
                  pattern,
                  replace,
                  apply_to,
                  case,
                  when_contains,
                  contains_ignore_case,
                });
              }
            }

            if rules.is_empty() {
              settings.renamer_rules = default_rules();
            } else {
              settings.renamer_rules = rules;
            }

            return (settings, p.to_string_lossy().to_string());
          }
          Err(_) => return (GlobalSettings { renamer_rules: default_rules(), ..Default::default() }, format!("{} (failed to parse; using defaults)", p.to_string_lossy())),
        },
        Err(_) => continue,
      }
    }
  }

  (
    GlobalSettings {
      renamer_rules: default_rules(),
      ..Default::default()
    },
    "default (no settings file found)".to_string(),
  )
}

#[tauri::command]
fn load_settings() -> Result<SettingsLoadResponse, String> {
  let (settings, loaded_from) = load_settings_internal();
  Ok(SettingsLoadResponse { settings, loaded_from })
}

#[tauri::command]
fn save_settings(settings: GlobalSettings) -> Result<String, String> {
  let p = app_data_dir().join("settings.json");
  let payload = serde_json::json!({
    "collision": settings.collision,
    "organizerRegex": settings.organizer_regex,
    "renamerRules": settings.renamer_rules,
  });
  std::fs::write(&p, serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  Ok(p.to_string_lossy().to_string())
}

fn rename_one(src: &Path, dst: &Path) -> std::io::Result<()> {
  match std::fs::rename(src, dst) {
    Ok(()) => Ok(()),
    Err(_) => {
      std::fs::copy(src, dst)?;
      std::fs::remove_file(src)?;
      Ok(())
    }
  }
}

#[tauri::command]
async fn renamer_apply_rename(
  paths: Vec<String>,
  rules: Vec<RenamerRule>,
  collision: String,
) -> Result<RenamerApplyResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let mut results: Vec<RenamerRowResult> = Vec::new();
    let mut updated_paths: Vec<String> = paths.clone();

    // Reserved destination paths (avoid collisions in-batch)
    let mut reserved: HashSet<String> = HashSet::new();

    // Precompute plan
    let mut plan: Vec<(usize, PathBuf, PathBuf)> = Vec::new();

    for (idx, s) in paths.iter().enumerate() {
      let src = PathBuf::from(s);
      if !src.exists() || !src.is_file() {
        results.push(RenamerRowResult {
          index: idx,
          from: s.clone(),
          to: s.clone(),
          status: "ERR: missing".to_string(),
        });
        continue;
      }

      let new_name = preview_name_for(&src, &rules);
      let cur_name = src.file_name().unwrap_or_default().to_string_lossy().to_string();
      if new_name == cur_name {
        results.push(RenamerRowResult {
          index: idx,
          from: s.clone(),
          to: s.clone(),
          status: "SKIP".to_string(),
        });
        continue;
      }

      let mut dst = src.with_file_name(new_name);

      // collision policy
      if collision == "skip" && dst.exists() {
        results.push(RenamerRowResult {
          index: idx,
          from: s.clone(),
          to: dst.to_string_lossy().to_string(),
          status: "SKIP (exists)".to_string(),
        });
        continue;
      }

      if collision == "suffix" {
        dst = resolve_collision(&dst);
      }

      // in-batch collision resolution (always suffix)
      let mut attempt = 0usize;
      loop {
        let key = if cfg!(target_os = "windows") {
          dst.to_string_lossy().to_string().to_lowercase()
        } else {
          dst.to_string_lossy().to_string()
        };

        if !reserved.contains(&key) && (!dst.exists() || dst == src) {
          reserved.insert(key);
          break;
        }

        attempt += 1;
        // bump suffix
        let (stem, suf) = split_name(dst.file_name().unwrap_or_default().to_string_lossy().as_ref());
        let bumped = if suf.is_empty() {
          format!("{stem} ({attempt})")
        } else {
          format!("{stem} ({attempt}){suf}")
        };
        dst = dst.with_file_name(bumped);
      }

      plan.push((idx, src, dst));
    }

    // Execute
    for (idx, src, dst) in plan {
      let from = src.to_string_lossy().to_string();
      let to = dst.to_string_lossy().to_string();

      match rename_one(&src, &dst) {
        Ok(()) => {
          updated_paths[idx] = to.clone();
          results.push(RenamerRowResult { index: idx, from, to, status: "OK".to_string() });
        }
        Err(e) => {
          results.push(RenamerRowResult { index: idx, from, to, status: format!("ERR: {e}") });
        }
      }
    }

    Ok::<RenamerApplyResult, String>(RenamerApplyResult { updated_paths, results })
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      scan_folder,
      start_move,
      open_path,
      load_settings,
      save_settings,
      renamer_expand_inputs,
      renamer_preview_names,
      renamer_apply_rename
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
