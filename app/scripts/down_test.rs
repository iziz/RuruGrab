use std::process::Command;

fn main() {
    let url = "https://www.instagram.com/reel/C2b4w_0x6E4/";
    let output = Command::new("yt-dlp")
        .args(["--dump-json", "--no-playlist", url])
        .output()
        .expect("Failed to execute yt-dlp");

    if output.status.success() {
        let json_str = String::from_utf8_lossy(&output.stdout);
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
            println!("thumbnail: {:?}", val.get("thumbnail"));
            println!("thumbnails: {:?}", val.get("thumbnails"));
        } else {
            println!("Failed to parse JSON");
        }
    } else {
        println!("yt-dlp error: {}", String::from_utf8_lossy(&output.stderr));
    }
}
