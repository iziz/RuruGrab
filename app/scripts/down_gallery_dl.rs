use std::fs::File;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn app_dir_from_file_macro() -> PathBuf {
    Path::new(file!())
        .parent()
        .and_then(|p| p.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = "https://github.com/mikf/gallery-dl/releases/latest/download/gallery-dl.exe";
    let resp = reqwest::blocking::get(url)?;

    let app_dir = app_dir_from_file_macro();
    let dest = app_dir
        .join("src-tauri")
        .join("binaries")
        .join("gallery-dl-x86_64-pc-windows-msvc.exe");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut out = File::create(dest)?;
    let bytes = resp.bytes()?;
    out.write_all(&bytes)?;
    println!("Downloaded successfully!");
    Ok(())
}
