use fancy_regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
  collections::HashSet,
  env,
  path::{Path, PathBuf},
  process::Command,
};

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenamerRule {
  pub name: String,
  pub pattern: String,
  pub replace: String,
  #[serde(default = "default_apply_to")]
  pub apply_to: String, // "stem" | "full"
  #[serde(default)]
  pub case: String, // "" | "upper" | "lower"
  #[serde(default)]
  pub when_contains: Vec<String>,
  #[serde(default)]
  pub contains_ignore_case: bool,
}

fn default_apply_to() -> String {
  "stem".to_string()
}

#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
  #[serde(default = "default_collision")]
  pub collision: String,
  #[serde(default = "default_organizer_regex")]
  pub organizer_regex: String,
  #[serde(default, rename = "renamerRules")]
  pub renamer_rules: Vec<RenamerRule>,
}

fn default_organizer_regex() -> String {
  "^([A-Za-z0-9]{2,8})-(.+)".to_string()
}

fn default_collision() -> String {
  "suffix".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadResponse {
  pub settings: GlobalSettings,
  pub loaded_from: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamerRowResult {
  pub index: usize,
  pub from: String,
  pub to: String,
  pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamerApplyResult {
  pub updated_paths: Vec<String>,
  pub results: Vec<RenamerRowResult>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
fn app_data_dir() -> PathBuf {
  if cfg!(target_os = "windows") {
    let base = env::var("LOCALAPPDATA")
      .or_else(|_| env::var("APPDATA"))
      .unwrap_or_else(|_| {
        let home = env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
        format!("{home}\\AppData\\Local")
      });
    let p = PathBuf::from(base).join("RuruGrab");
    let _ = std::fs::create_dir_all(&p);
    return p;
  }

  let base = env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{home}/.config")
  });
  let p = PathBuf::from(base).join("RuruGrab");
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
    v.push(ed.join("renamer.json"));
  }
  if let Ok(cd) = env::current_dir() {
    v.push(cd.join("settings.json"));
    v.push(cd.join("renamer.json"));
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

/// Python-style group references (\1, \2) → Rust style ($1, $2)
fn python_repl_to_rust(repl: &str) -> String {
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
  if let Some(pos) = name.rfind('.') {
    if pos > 0 && pos < name.len() - 1 {
      return (name[..pos].to_string(), name[pos..].to_string());
    }
  }
  (name.to_string(), "".to_string())
}

pub fn preview_name_for(path: &Path, rules: &[RenamerRule]) -> String {
  let original_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
  let mut name = original_name.clone();
  let (mut stem, mut suffix) = split_name(&name);

  for rule in rules {
    if !rule.when_contains.is_empty() {
      let needles: Vec<String> =
        rule.when_contains.iter().filter(|s| !s.trim().is_empty()).cloned().collect();
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
      Err(_) => continue,
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
    if suffix.is_empty() { "_".to_string() } else { format!("_{suffix}") }
  } else {
    name
  }
}

pub fn resolve_collision(dest: &Path) -> PathBuf {
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

pub fn load_settings_internal() -> (GlobalSettings, String) {
  for p in settings_search_paths() {
    if p.exists() {
      match std::fs::read_to_string(&p) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
          Ok(v) => {
            let mut settings = GlobalSettings::default();
            settings.collision =
              v.get("collision").and_then(|x| x.as_str()).unwrap_or("suffix").to_string();
            settings.organizer_regex = v
              .get("organizerRegex")
              .and_then(|x| x.as_str())
              .unwrap_or("^([A-Za-z0-9]{2,8})-(.+)")
              .to_string();

            let mut rules: Vec<RenamerRule> = Vec::new();
            let rules_val = v.get("renamerRules").or_else(|| v.get("rules"));
            if let Some(arr) = rules_val.and_then(|x| x.as_array()) {
              for r in arr {
                let name = r.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let pattern =
                  r.get("pattern").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let replace =
                  r.get("replace").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let apply_to =
                  r.get("apply_to").and_then(|x| x.as_str()).unwrap_or("stem").to_string();
                let case = r.get("case").and_then(|x| x.as_str()).unwrap_or("").to_string();

                let when_val = r
                  .get("when_contains")
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
          Err(_) => {
            return (
              GlobalSettings { renamer_rules: default_rules(), ..Default::default() },
              format!("{} (failed to parse; using defaults)", p.to_string_lossy()),
            )
          }
        },
        Err(_) => continue,
      }
    }
  }

  (
    GlobalSettings { renamer_rules: default_rules(), ..Default::default() },
    "default (no settings file found)".to_string(),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
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

#[tauri::command]
pub fn load_settings() -> Result<SettingsLoadResponse, String> {
  let (settings, loaded_from) = load_settings_internal();
  Ok(SettingsLoadResponse { settings, loaded_from })
}

#[tauri::command]
pub fn save_settings(settings: GlobalSettings) -> Result<String, String> {
  let p = app_data_dir().join("settings.json");
  let payload = serde_json::json!({
    "collision": settings.collision,
    "organizerRegex": settings.organizer_regex,
    "renamerRules": settings.renamer_rules,
  });
  std::fs::write(&p, serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?)
    .map_err(|e| e.to_string())?;
  Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn renamer_expand_inputs(inputs: Vec<String>) -> Result<Vec<String>, String> {
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
pub fn renamer_preview_names(
  paths: Vec<String>,
  rules: Vec<RenamerRule>,
) -> Result<Vec<String>, String> {
  let mut out: Vec<String> = Vec::with_capacity(paths.len());
  for p in paths {
    let pb = PathBuf::from(&p);
    let name = preview_name_for(&pb, &rules);
    out.push(name);
  }
  Ok(out)
}

#[tauri::command]
pub async fn renamer_apply_rename(
  paths: Vec<String>,
  rules: Vec<RenamerRule>,
  collision: String,
) -> Result<RenamerApplyResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let mut results: Vec<RenamerRowResult> = Vec::new();
    let mut updated_paths: Vec<String> = paths.clone();
    let mut reserved: HashSet<String> = HashSet::new();
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
        let (stem, suf) =
          split_name(dst.file_name().unwrap_or_default().to_string_lossy().as_ref());
        let bumped = if suf.is_empty() {
          format!("{stem} ({attempt})")
        } else {
          format!("{stem} ({attempt}){suf}")
        };
        dst = dst.with_file_name(bumped);
      }

      plan.push((idx, src, dst));
    }

    for (idx, src, dst) in plan {
      let from = src.to_string_lossy().to_string();
      let to = dst.to_string_lossy().to_string();

      match rename_one(&src, &dst) {
        Ok(()) => {
          updated_paths[idx] = to.clone();
          results.push(RenamerRowResult { index: idx, from, to, status: "OK".to_string() });
        }
        Err(e) => {
          results.push(RenamerRowResult {
            index: idx,
            from,
            to,
            status: format!("ERR: {e}"),
          });
        }
      }
    }

    Ok::<RenamerApplyResult, String>(RenamerApplyResult { updated_paths, results })
  })
  .await
  .map_err(|e| e.to_string())?
}
