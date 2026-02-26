'use strict';
(() => {
  const CS = globalThis.UTH_CS;

  CS.getYouTubeVideoIdFromUrl = function getYouTubeVideoIdFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const v = u.searchParams.get('v');
      if (v && v.length === 11) return v;
      const m = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    } catch {}
    return null;
  };

  CS.isHistoryPage = function isHistoryPage() {
    return location.pathname.startsWith('/feed/history');
  };

  CS.VIDEO_RENDERER_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-rich-grid-media',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',

    'ytd-compact-video-renderer',
    'ytd-compact-playlist-renderer',
    'ytd-compact-radio-renderer',
    'ytd-compact-movie-renderer',
    'ytd-compact-station-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-playlist-video-renderer',

    'ytd-reel-item-renderer',

    'yt-shorts-lockup-view-model',
    'yt-shorts-lockup-view-model-v2',
    'yt-shorts-lockup-view-model-v3',
    'ytd-shorts-lockup-view-model',
    'ytd-shorts-lockup-view-model-v2',
    'ytd-shorts-lockup-view-model-v3',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
    'ytm-shorts-lockup-view-model-v3',

    'yt-lockup-view-model',
    'ytd-lockup-view-model'
  ].join(',');

  CS.findVideoRenderer = function findVideoRenderer(el) {
    if (!(el instanceof Element)) return null;
    return el.closest(CS.VIDEO_RENDERER_SELECTOR);
  };

  CS.isDisplayContents = function isDisplayContents(el) {
    try {
      if (!(el instanceof Element)) return false;
      const cs = getComputedStyle(el);
      return !!cs && cs.display === 'contents';
    } catch {
      return false;
    }
  };

  CS.getTargetContainer = function getTargetContainer(el) {
    const renderer = CS.findVideoRenderer(el);
    if (!renderer) return null;
    return renderer;
  };
})();
