use std::sync::LazyLock;

use regex::Regex;

static RE_SIZE_BYTES: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(r"(?i)^(?P<n>[0-9]+(?:\.[0-9]+)?)\s*(?P<u>KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)$").unwrap()
});

static RE_PROGRESS_LINE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(r"(?x)
    ^\[download\]\s+
    (?:
      (?P<pct>[0-9]+(?:\.[0-9]+)?)%\s+of\s+(?:~)?(?P<total>[0-9\.]+\s*(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB|B))
      |
      (?P<dl_only>[0-9\.]+\s*(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB|B))\s+at\s+
    )
    (?:.*?\s+at\s+(?P<speed>[0-9\.]+\s*(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)/s))?
    (?:\s+ETA\s+(?P<eta>[0-9:]+))?
  ").unwrap()
});

/// Convert yt-dlp stdout/stderr bytes to a String.
/// Use as-is if UTF-8, otherwise attempt to decode to EUC-KR (CP949).
/// The PyInstaller-bundled yt-dlp.exe may output to the Windows system code page (CP949)
/// despite the PYTHONIOENCODING setting.

pub fn decode_bytes(bytes: &[u8]) -> String {
  match std::str::from_utf8(bytes) {
    Ok(s) => s.to_string(),
    Err(_) => {
      let (decoded, _, _) = encoding_rs::EUC_KR.decode(bytes);
      decoded.into_owned()
    }
  }
}

pub fn parse_size_bytes(token: &str) -> Option<f64> {
  let caps = RE_SIZE_BYTES.captures(token.trim())?;
  let n: f64 = caps.name("n")?.as_str().parse().ok()?;
  let u = caps.name("u")?.as_str().to_ascii_lowercase();
  let mul = match u.as_str() {
    "b" => 1.0,
    "kib" => 1024.0,
    "mib" => 1024.0 * 1024.0,
    "gib" => 1024.0 * 1024.0 * 1024.0,
    "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
    "kb" => 1000.0,
    "mb" => 1000.0 * 1000.0,
    "gb" => 1000.0 * 1000.0 * 1000.0,
    "tb" => 1000.0 * 1000.0 * 1000.0 * 1000.0,
    _ => return None,
  };
  Some(n * mul)
}

pub fn parse_eta_seconds(token: &str) -> Option<i64> {
  // supports HH:MM:SS or MM:SS
  let parts: Vec<&str> = token.trim().split(':').collect();
  if parts.len() == 2 {
    let m: i64 = parts[0].parse().ok()?;
    let s: i64 = parts[1].parse().ok()?;
    return Some(m * 60 + s);
  }
  if parts.len() == 3 {
    let h: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let s: i64 = parts[2].parse().ok()?;
    return Some(h * 3600 + m * 60 + s);
  }
  None
}

pub fn parse_progress_line(line: &str) -> Option<(f64, Option<f64>, Option<f64>, Option<f64>, Option<i64>)> {
  let caps = RE_PROGRESS_LINE.captures(line.trim())?;

  let mut pct: f64 = 0.0;
  let mut total: Option<f64> = None;
  let mut downloaded: Option<f64> = None;

  if let Some(p) = caps.name("pct") {
    pct = p.as_str().parse().unwrap_or(0.0);
    total = parse_size_bytes(caps.name("total")?.as_str());
    if let Some(t) = total {
      downloaded = Some(t * (pct / 100.0));
    }
  } else if let Some(dl) = caps.name("dl_only") {
    downloaded = parse_size_bytes(dl.as_str());
  }

  let speed = caps
    .name("speed")
    .and_then(|m| m.as_str().strip_suffix("/s"))
    .and_then(parse_size_bytes);
  let eta = caps.name("eta").and_then(|m| parse_eta_seconds(m.as_str()));

  Some((pct, total, downloaded, speed, eta))
}
