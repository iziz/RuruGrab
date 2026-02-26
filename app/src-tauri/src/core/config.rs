use std::{
  env,
  net::SocketAddr,
  path::PathBuf,
};

#[derive(Clone, Debug)]
pub struct Config {
  pub bind: SocketAddr,
  pub download_dir: PathBuf,
  pub sqlite_path: PathBuf,
}

impl Config {
  pub fn from_env() -> anyhow::Result<Self> {
    let bind = env::var("UTUBEHOLIC_BIND").unwrap_or_else(|_| "127.0.0.1:5000".to_string());
    let bind: SocketAddr = bind.parse()?;

    let download_dir = env::var("UTUBEHOLIC_DOWNLOAD_DIR")
      .map(PathBuf::from)
      .unwrap_or_else(|_| {
        // default: <home>/Downloads/UtubeHolic
        let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
        home.join("Downloads").join("UtubeHolic")
      });

    let sqlite_path = env::var("UTUBEHOLIC_SQLITE_PATH")
      .map(PathBuf::from)
      .unwrap_or_else(|_| {
        let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
        home.join(".utubeholic").join("watched.sqlite3")
      });

    Ok(Self { bind, download_dir, sqlite_path })
  }
}
