use std::path::{Path, PathBuf};
use std::process::Command;

fn app_dir_from_file_macro() -> PathBuf {
    // When compiled from repo root, file!() is typically "app/scripts/<file>.rs"
    // → go up two levels to reach app/
    Path::new(file!())
        .parent()
        .and_then(|p| p.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Testing gallery-dl...");

    let app_dir = app_dir_from_file_macro();
    let bin = app_dir
        .join("src-tauri")
        .join("binaries")
        .join("gallery-dl-x86_64-pc-windows-msvc.exe");

    let output = Command::new(bin).args(["--version"]).output()?;
    println!("Version: {}", String::from_utf8_lossy(&output.stdout));

    Ok(())
}
