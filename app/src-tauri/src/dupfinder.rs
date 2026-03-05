use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::Emitter;

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    pub folders: Vec<String>,
    pub method: String,            // "name" | "size" | "hash"
    pub min_size: Option<u64>,     // bytes
    pub max_size: Option<u64>,     // bytes
    pub include_ext: String,       // comma separated, empty = all
    pub exclude_ext: String,       // comma separated
    pub recursive: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub key: String,
    pub files: Vec<DupFile>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupScanResult {
    pub total_scanned: u32,
    pub total_groups: u32,
    pub total_duplicates: u32,
    pub groups: Vec<DupGroup>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupProgress {
    pub scanned: u32,
    pub phase: String, // "collecting" | "comparing"
    pub current_file: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupDeleteResult {
    pub deleted: u32,
    pub failed: u32,
    pub errors: Vec<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

fn collect_files(
    dir: &Path,
    recursive: bool,
    min_size: Option<u64>,
    max_size: Option<u64>,
    include_ext: &[String],
    exclude_ext: &[String],
    out: &mut Vec<PathBuf>,
) {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };

    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recursive {
                collect_files(&path, recursive, min_size, max_size, include_ext, exclude_ext, out);
            }
            continue;
        }
        if !path.is_file() {
            continue;
        }

        // Extension filter
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        if !include_ext.is_empty() && !include_ext.contains(&ext) {
            continue;
        }
        if exclude_ext.contains(&ext) {
            continue;
        }

        // Size filter
        if let Ok(meta) = fs::metadata(&path) {
            let sz = meta.len();
            if let Some(min) = min_size {
                if sz < min {
                    continue;
                }
            }
            if let Some(max) = max_size {
                if sz > max {
                    continue;
                }
            }
            out.push(path);
        }
    }
}

fn parse_ext_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_lowercase().trim_start_matches('.').to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn to_dup_file(path: &Path) -> DupFile {
    DupFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        size: file_size(path),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn dupfinder_scan(
    window: tauri::WebviewWindow,
    options: ScanOptions,
) -> Result<DupScanResult, String> {
    let include_ext = parse_ext_list(&options.include_ext);
    let exclude_ext = parse_ext_list(&options.exclude_ext);

    // Phase 1: collect files
    let mut all_files: Vec<PathBuf> = Vec::new();
    for folder in &options.folders {
        let p = Path::new(folder);
        if !p.exists() || !p.is_dir() {
            continue;
        }
        collect_files(
            p,
            options.recursive,
            options.min_size,
            options.max_size,
            &include_ext,
            &exclude_ext,
            &mut all_files,
        );
    }

    let total = all_files.len() as u32;

    // Phase 2: group by key
    let mut groups_map: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for (i, path) in all_files.iter().enumerate() {
        let _ = window.emit(
            "dupfinder:progress",
            DupProgress {
                scanned: (i + 1) as u32,
                phase: "comparing".to_string(),
                current_file: path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
            },
        );

        let key = match options.method.as_str() {
            "name" => path
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default(),
            "size" => format!("{}", file_size(path)),
            _ => {
                // "hash" — first group by size, then hash only size-duplicates
                // For simplicity in initial pass, just hash everything
                match file_hash(path) {
                    Ok(h) => h,
                    Err(_) => continue,
                }
            }
        };

        groups_map.entry(key).or_default().push(path.clone());
    }

    // Filter to only groups with 2+ files
    let mut groups: Vec<DupGroup> = groups_map
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .map(|(key, files)| {
            let dup_files: Vec<DupFile> = files.iter().map(|p| to_dup_file(p)).collect();
            DupGroup {
                key,
                files: dup_files,
            }
        })
        .collect();

    // Sort groups by number of files (descending)
    groups.sort_by(|a, b| b.files.len().cmp(&a.files.len()));

    let total_groups = groups.len() as u32;
    let total_duplicates: u32 = groups.iter().map(|g| g.files.len() as u32 - 1).sum();

    Ok(DupScanResult {
        total_scanned: total,
        total_groups,
        total_duplicates,
        groups,
    })
}

#[tauri::command]
pub fn dupfinder_delete(files: Vec<String>) -> Result<DupDeleteResult, String> {
    let mut deleted: u32 = 0;
    let mut failed: u32 = 0;
    let mut errors: Vec<String> = Vec::new();

    for file_path in &files {
        let p = Path::new(file_path);
        match fs::remove_file(p) {
            Ok(_) => deleted += 1,
            Err(e) => {
                failed += 1;
                errors.push(format!("{}: {}", file_path, e));
            }
        }
    }

    Ok(DupDeleteResult {
        deleted,
        failed,
        errors,
    })
}
