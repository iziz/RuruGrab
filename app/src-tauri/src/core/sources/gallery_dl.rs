use std::path::Path;

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::api::models::DownloadItem;

use super::StdoutEvent;

pub fn extract_twitter_id(url: &str) -> Option<String> {
  if url.contains("twitter.com") || url.contains("x.com") {
    if let Some(idx) = url.find("/status/") {
      let rest = &url[idx + 8..];
      let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
      if !digits.is_empty() {
        return Some(format!("twitter:{}", digits));
      }
    }
  }
  None
}

pub fn build_args(download_dir: &Path, cookie_path: Option<&Path>, url: &str) -> Vec<String> {
  let mut args: Vec<String> = Vec::new();
  args.push("-d".into());
  args.push(download_dir.to_string_lossy().to_string());
  if let Some(cp) = cookie_path {
    args.push("--cookies".into());
    args.push(cp.to_string_lossy().to_string());
  }
  args.push(url.to_string());
  args
}

pub fn build_meta_args(cookie_path: Option<&Path>, url: &str) -> Vec<String> {
  let mut args: Vec<String> = vec!["--dump-json".into()];
  if let Some(cp) = cookie_path {
    args.push("--cookies".into());
    args.push(cp.to_string_lossy().to_string());
  }
  args.push(url.to_string());
  args
}

pub fn parse_stdout(line: &str) -> StdoutEvent {
  if line.starts_with('#') {
    return StdoutEvent::Ignored;
  }

  let ext = std::path::Path::new(line)
    .extension()
    .and_then(|s| s.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();

  if matches!(
    ext.as_str(),
    "jpg" | "jpeg" | "png" | "webp" | "gif" | "mp4" | "mkv" | "webm" | "mov" | "mp3" | "m4a"
  ) {
    return StdoutEvent::GalleryFile(line.to_string());
  }

  StdoutEvent::Ignored
}

pub fn value_to_string(v: &Value) -> Option<String> {
  match v {
    Value::String(s) => Some(s.clone()),
    Value::Number(n) => Some(n.to_string()),
    _ => None,
  }
}

pub fn has_key_recursive(v: &Value, key: &str) -> bool {
  match v {
    Value::Object(m) => m.contains_key(key) || m.values().any(|c| has_key_recursive(c, key)),
    Value::Array(a) => a.iter().any(|c| has_key_recursive(c, key)),
    _ => false,
  }
}

pub fn find_str_recursive(v: &Value, keys: &[&str]) -> Option<String> {
  match v {
    Value::Object(m) => {
      for k in keys {
        if let Some(x) = m.get(*k) {
          if let Some(s) = value_to_string(x) {
            if !s.trim().is_empty() {
              return Some(s);
            }
          }
        }
      }
      for c in m.values() {
        if let Some(s) = find_str_recursive(c, keys) {
          return Some(s);
        }
      }
      None
    }
    Value::Array(a) => {
      for c in a {
        if let Some(s) = find_str_recursive(c, keys) {
          return Some(s);
        }
      }
      None
    }
    _ => None,
  }
}

pub fn score_meta_like(v: &Value) -> i32 {
  let mut s = 0;
  for k in ["description", "content", "caption", "title", "full_text", "text"] {
    if has_key_recursive(v, k) {
      s += 3;
    }
  }
  for k in ["display_url", "thumbnail", "thumbnail_url", "media_url_https", "media_url"] {
    if has_key_recursive(v, k) {
      s += 2;
    }
  }
  for k in ["username", "uploader", "author", "fullname", "full_name"] {
    if has_key_recursive(v, k) {
      s += 1;
    }
  }
  s
}

pub fn looks_like_gallerydl_dump_json(v: &Value) -> bool {
  let Some(arr) = v.as_array() else { return false };
  arr.iter().take(5).any(|e| {
    e.as_array().and_then(|t| t.get(0)).and_then(|x| x.as_i64()).is_some()
  })
}

pub fn is_image_url(u: &str) -> bool {
  let lower = u.to_ascii_lowercase();
  let ext = lower.rsplit('.').next().unwrap_or("").split('?').next().unwrap_or("");
  if matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "gif") {
    return true;
  }
  if lower.contains("pbs.twimg.com/media/") {
    if lower.contains("format=jpg")
      || lower.contains("format=jpeg")
      || lower.contains("format=png")
      || lower.contains("format=webp")
      || lower.contains("format=gif")
    {
      return true;
    }
  }
  false
}

pub fn derive_twitter_video_thumb(video_url: &str) -> Option<String> {
  if !video_url.contains("video.twimg.com") {
    return None;
  }
  let no_q = video_url.split('?').next().unwrap_or(video_url);
  let parts: Vec<&str> = no_q.split('/').filter(|s| !s.is_empty()).collect();

  if let Some(i) = parts.iter().position(|p| *p == "ext_tw_video") {
    let id = parts.get(i + 1)?;
    let fname = parts.last()?;
    let base = fname.split('.').next().unwrap_or(fname);
    if !id.is_empty() && !base.is_empty() {
      return Some(format!(
        "https://pbs.twimg.com/ext_tw_video_thumb/{}/pu/img/{}.jpg",
        id, base
      ));
    }
  }

  if let Some(i) = parts.iter().position(|p| *p == "amplify_video") {
    let id = parts.get(i + 1)?;
    let fname = parts.last()?;
    let base = fname.split('.').next().unwrap_or(fname);
    if !id.is_empty() && !base.is_empty() {
      return Some(format!(
        "https://pbs.twimg.com/amplify_video_thumb/{}/img/{}.jpg",
        id, base
      ));
    }
  }
  None
}

pub fn clean_one_line(s: &str, max_chars: usize) -> String {
  let s = s.replace('\u{200B}', "").replace('\r', "");
  let line = s.lines().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("").to_string();
  let mut out = String::new();
  let mut prev_space = false;
  let mut n = 0usize;

  for ch in line.chars() {
    if ch.is_whitespace() {
      if !prev_space {
        out.push(' ');
        prev_space = true;
        n += 1;
      }
    } else {
      out.push(ch);
      prev_space = false;
      n += 1;
    }
    if n >= max_chars {
      break;
    }
  }
  out.trim().to_string()
}

pub fn pick_thumbnail_from_value(v: &Value) -> Option<String> {
  if let Some(u) = find_str_recursive(
    v,
    &[
      "display_url",
      "thumbnail",
      "thumbnail_url",
      "media_url_https",
      "media_url",
      "image",
      "image_url",
    ],
  ) {
    if is_image_url(&u) {
      return Some(u);
    }
  }
  if let Some(u) = find_str_recursive(
    v,
    &["profile_image_url_https", "profile_image_url", "profile_image"],
  ) {
    if is_image_url(&u) {
      return Some(u);
    }
  }
  if let Some(u) = find_str_recursive(v, &["url"]) {
    if is_image_url(&u) {
      return Some(u);
    }
  }
  None
}

#[derive(Default, Debug)]
pub struct MetaExtract {
  pub title: Option<String>,
  pub uploader: Option<String>,
  pub thumbnail: Option<String>,
  pub video_id: Option<String>,
  pub total_items: Option<i64>,
}

pub fn extract_from_object(v: &Value) -> MetaExtract {
  let mut out = MetaExtract::default();
  out.title = find_str_recursive(
    v,
    &["content", "description", "caption", "title", "full_text", "text"],
  )
  .map(|s| clean_one_line(&s, 120))
  .filter(|s| !s.is_empty());
  out.uploader = find_str_recursive(
    v,
    &["username", "screen_name", "uploader", "nick", "fullname", "full_name", "name", "author"],
  )
  .map(|s| clean_one_line(&s, 80).nfc().collect::<String>())
  .filter(|s| !s.is_empty());
  out.thumbnail = pick_thumbnail_from_value(v);
  out.video_id =
    find_str_recursive(v, &["post_id", "post_shortcode", "shortcode", "tweet_id", "id"]);
  out.total_items = v.get("count").and_then(|x| x.as_i64());
  out
}

pub fn extract_from_dump_json(v: &Value) -> MetaExtract {
  let mut out = MetaExtract::default();
  let Some(arr) = v.as_array() else { return out };

  let mut post_meta: Option<&Value> = None;
  let mut first_media_obj: Option<&Value> = None;
  let mut first_media_url: Option<String> = None;
  let mut thumb_candidate: Option<String> = None;
  let mut media_count = 0i64;

  for e in arr {
    let Some(t) = e.as_array() else { continue };
    let code = t.get(0).and_then(|x| x.as_i64()).unwrap_or(-1);

    match code {
      2 => {
        if post_meta.is_none() {
          if let Some(obj) = t.get(1).filter(|o| o.is_object()) {
            post_meta = Some(obj);
          }
        }
      }
      3 => {
        media_count += 1;
        let url = t.get(1).and_then(|x| x.as_str()).map(|s| s.to_string());
        if first_media_url.is_none() {
          first_media_url = url.clone();
        }
        let obj = t.get(2).filter(|o| o.is_object());
        if first_media_obj.is_none() {
          first_media_obj = obj;
        }

        if thumb_candidate.is_none() {
          if let Some(o) = obj {
            if let Some(u) = find_str_recursive(
              o,
              &[
                "display_url",
                "thumbnail",
                "thumbnail_url",
                "media_url_https",
                "media_url",
              ],
            ) {
              if is_image_url(&u) {
                thumb_candidate = Some(u);
              }
            }
          }
        }
        if thumb_candidate.is_none() {
          if let Some(u) = url {
            if is_image_url(&u) {
              thumb_candidate = Some(u);
            }
          }
        }
      }
      _ => {}
    }
  }

  if thumb_candidate.is_none() {
    if let Some(u) = first_media_url.as_deref() {
      thumb_candidate = derive_twitter_video_thumb(u);
    }
  }

  out.total_items = post_meta
    .and_then(|m| m.get("count").and_then(|x| x.as_i64()))
    .or_else(|| if media_count > 0 { Some(media_count) } else { None });

  if let Some(m) = post_meta.or(first_media_obj) {
    out.title = find_str_recursive(
      m,
      &["content", "description", "caption", "title", "full_text", "text"],
    )
    .map(|s| clean_one_line(&s, 120))
    .filter(|s| !s.is_empty());
    out.uploader = find_str_recursive(
      m,
      &["username", "screen_name", "uploader", "nick", "fullname", "full_name", "name"],
    )
    .map(|s| clean_one_line(&s, 80).nfc().collect::<String>())
    .filter(|s| !s.is_empty());
  }

  out.thumbnail = thumb_candidate
    .or_else(|| post_meta.and_then(|m| pick_thumbnail_from_value(m)))
    .or_else(|| first_media_obj.and_then(|m| pick_thumbnail_from_value(m)));

  if let Some(m) = post_meta {
    out.video_id =
      find_str_recursive(m, &["post_id", "post_shortcode", "shortcode", "tweet_id", "id"]);
  }
  out
}

pub fn extract_best_meta(best_val: &Value, parsed_len: usize) -> MetaExtract {
  if looks_like_gallerydl_dump_json(best_val) {
    extract_from_dump_json(best_val)
  } else if let Some(a) = best_val.as_array() {
    let best_inner = a.iter().max_by_key(|v| score_meta_like(v)).unwrap_or(best_val);
    if looks_like_gallerydl_dump_json(best_inner) {
      extract_from_dump_json(best_inner)
    } else {
      extract_from_object(best_inner)
    }
  } else {
    let mut meta = extract_from_object(best_val);
    if meta.total_items.is_none() && parsed_len > 1 {
      meta.total_items = Some(parsed_len as i64);
    }
    meta
  }
}

pub fn apply_meta(best_val: &Value, parsed_len: usize, it: &mut DownloadItem) {
  let extracted = extract_best_meta(best_val, parsed_len);

  if it.total_items.is_none() {
    it.total_items = extracted
      .total_items
      .or_else(|| if parsed_len > 1 { Some(parsed_len as i64) } else { None });
  }
  if (it.title.is_none() || it.title.as_deref() == Some("")) && extracted.title.is_some() {
    it.title = extracted.title;
  }
  if it.uploader.is_none() {
    it.uploader = extracted.uploader;
  }
  if it.thumbnail.is_none() {
    it.thumbnail = extracted.thumbnail;
  }
  if it.video_id.is_none() {
    it.video_id = extracted.video_id;
  }

  if it.title.is_none() {
    let category =
      find_str_recursive(best_val, &["category"]).unwrap_or_else(|| "unknown".into());
    let post_id = find_str_recursive(
      best_val,
      &["post_id", "post_shortcode", "shortcode", "tweet_id", "id"],
    )
    .unwrap_or_else(|| "unknown".into());
    it.title = Some(format!("{} - {}", category, post_id));
  }
}
