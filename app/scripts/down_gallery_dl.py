import urllib.request
import certifi
import ssl
from pathlib import Path

url = "https://github.com/mikf/gallery-dl/releases/latest/download/gallery-dl.exe"
app_dir = Path(__file__).resolve().parents[1]  # app/
dest = app_dir / "src-tauri" / "binaries" / "gallery-dl-x86_64-pc-windows-msvc.exe"
dest.parent.mkdir(parents=True, exist_ok=True)

context = ssl.create_default_context(cafile=certifi.where())
urllib.request.urlretrieve(url, str(dest), context=context)
print("Downloaded gallery-dl.exe successfully!")
