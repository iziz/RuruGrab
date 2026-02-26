'use strict';
(() => {
  let lastRightClickedUrl = null;

  function normalizeInstagramPermalink(url) {
    try {
      const u = new URL(url, location.href);
      return `${u.origin}${u.pathname}`;
    } catch {
      return null;
    }
  }

  function findInstagramPostUrl(target) {
    if (/^\/(p|reel|tv)\//.test(location.pathname)) {
      return `${location.origin}${location.pathname}`;
    }

    let cur = target;
    while (cur && cur !== document) {
      if (cur.tagName === 'A') {
        const href = cur.href || cur.getAttribute('href');
        if (href && /\/(p|reel|tv)\//.test(href)) return normalizeInstagramPermalink(href);
      }
      cur = cur.parentNode;
    }

    const article = target.closest?.('article');
    if (article) {
      const a = article.querySelector('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
      if (a?.href) return normalizeInstagramPermalink(a.href);
    }

    return null;
  }

  document.addEventListener('contextmenu', (e) => {
    lastRightClickedUrl = findInstagramPostUrl(e.target);
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_RIGHT_CLICK_INSTAGRAM_URL') {
      sendResponse({ url: lastRightClickedUrl });
      return true;
    }
    return false;
  });
})();