'use strict';
(() => {
  const BG = self.UTH_BG;

  // -------------------- cookies for yt-dlp --------------------
  function getAllCookiesForUrl(url) {
    return new Promise((resolve) => {
      chrome.cookies.getAll({ url }, (cookies) => resolve(cookies || []));
    });
  }

  function dedupeCookies(cookies) {
    const map = new Map();
    for (const c of cookies || []) {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (!map.has(key)) map.set(key, c);
    }
    return Array.from(map.values());
  }

  async function collectDownloadCookies() {
    // Pass cookies to yt-dlp for sites requiring login/authorization
    // (Maintain host URLs at minimum units only, remove duplicate domains)
    const cookieUrls = [
      'https://www.youtube.com',
      'https://accounts.google.com',
      'https://www.google.com',
      'https://twitter.com',
      'https://x.com',
      'https://instagram.com',
      'https://www.instagram.com',
    ];

    const lists = await Promise.all(
      cookieUrls.map((u) => getAllCookiesForUrl(u).catch(() => []))
    );

    const all = lists.flat();
    return dedupeCookies(all);
  }

  // -------------------- yt-dlp download --------------------
  BG.enqueueDownload = async function enqueueDownload(url, opts = {}) {
    const serverBase = await BG.getSqliteServerBaseUrl();
    const endpoint = `${serverBase}/download`;

    const cookies = await collectDownloadCookies();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, cookies, source: opts.source }),
        signal: controller.signal,
      });
    } catch (e) {
      const msg = String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e));
      throw new Error(`download fetch failed (${endpoint}): ${msg}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`download server error (${endpoint}): ${resp.status} ${text}`.trim());
    }

    return true;
  };
})();
