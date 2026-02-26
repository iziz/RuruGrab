'use strict';
/**
 * site-rules.js — The single source of truth for URL rules
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * To add new sites, modify URL patterns, or edit error messages, only edit this file.
 * utils.js and menus.js only reference the rules in this file.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ━━━━━━
 *
 * Each rule object field:
 *   id                — Site identifier string
 *   hostsEndsWith     — Matches if hostname ends with this value (includes subdomains)
 *   hostsExact        — Matches if hostname exactly matches
 *   source            — Source value to pass to enqueueDownload
 *   extractId(url)    — URL object → Unique ID string (null if none)
 *   toUrl(id)         — Unique ID → Canonical URL string for download
 *   isEligible(url)   — Whether icon-click download is allowed (takes URL object)
 *   isValidTarget(url)— Whether right-click context menu target URL is valid (takes URL object)
 *   contentScriptMsg  — Message type to send to content script if isValidTarget fails
 *                       (null means no content script fallback)
 *   toastSending      — Toast message displayed while sending download request
 *   ineligibleMsg     — Error message displayed on pages where icon clicks are disabled
 *   invalidTargetMsg  — Error message displayed when right-click target is invalid
 */

(() => {
  const BG = self.UTH_BG;

  // Detect internal browser URLs (e.g., chrome://, edge://, about://)
  BG.isInternalBrowserUrl = function isInternalBrowserUrl(url) {
    if (!url) return true;
    return /^(chrome|edge|about):\/\//i.test(String(url));
  };


  // 사이트 규칙 목록
  BG.SITE_RULES = [
    {
      id: 'youtube',
      source: 'youtube',
      hostsEndsWith: ['youtube.com'],   // m.youtube.com, www.youtube.com and so
      hostsExact: [],
      contentScriptMsg: null,           // Directly extractable from URL, no CS fallback

      //   https://www.youtube.com/watch?v=VIDEO_ID
      //   https://www.youtube.com/shorts/VIDEO_ID
      //   https://www.youtube.com/embed/VIDEO_ID
      extractId(url) {
        try {
          const u = new URL(url, 'https://www.youtube.com');
          const v = u.searchParams.get('v');
          if (v && v.length === 11) return v;
          const ms = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
          if (ms) return ms[1];
          const me = u.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/);
          if (me) return me[1];
        } catch {}
        return null;
      },

      toUrl(id) {
        return `https://www.youtube.com/watch?v=${id}`;
      },

      isEligible(url) {
        return Boolean(this.extractId(url));
      },

      isValidTarget(url) {
        return Boolean(this.extractId(url));
      },

      toastSending:     'Download request sent…',
      ineligibleMsg:    'Please run it from the video page (Watch/Shorts) or use the right-click menu on the thumbnail.',
      invalidTargetMsg: 'Right-click on the YouTube video/thumbnail and try again. (Blocked on Home/Search/Feed)',
    },

    // ── Twitter / X ───────────────────────────────────────────────
    {
      id: 'twitter',
      source: 'twitter',
      hostsEndsWith: [],
      hostsExact: ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'],
      contentScriptMsg: 'GET_RIGHT_CLICK_TWEET_URL',

      //   https://twitter.com/username/status/TWEET_ID
      //   https://x.com/i/status/TWEET_ID
      _RE: /\/(?:i\/)?status\/([0-9]+)/,

      extractId(url) {
        try {
          const m = url.pathname.match(this._RE);
          if (m) return 'twitter:' + m[1];
        } catch {}
        return null;
      },

      toUrl(id) {
        const tweetId = id.split(':')[1];
        return `https://twitter.com/i/status/${tweetId}`;
      },

      isEligible(url) {
        return Boolean(this.extractId(url));
      },

      isValidTarget(url) {
        return this._RE.test(url.pathname);
      },

      toastSending:     'Download request sent…',
      ineligibleMsg:    'You cannot download files directly from the timeline. Please download from the tweet details page (/status/...) or use the right-click menu on the media.',
      invalidTargetMsg: 'Right-click within the tweet (post) and try again. (Recommended: time link/details page)',
    },

    // ── Instagram ─────────────────────────────────────────────────
    {
      id: 'instagram',
      source: 'instagram',
      hostsEndsWith: [],
      hostsExact: ['instagram.com', 'www.instagram.com'],
      contentScriptMsg: 'GET_RIGHT_CLICK_INSTAGRAM_URL',
      //   https://www.instagram.com/p/CODE/
      //   https://www.instagram.com/reel/CODE/
      //   https://www.instagram.com/tv/CODE/
      _RE: /^\/(p|reel|tv)\//,

      // id = pathname (ex: '/p/ABC123/')
      extractId(url) {
        try {
          if (this._RE.test(url.pathname)) return url.pathname;
        } catch {}
        return null;
      },

      toUrl(id) {
        return `https://www.instagram.com${id}`;
      },

      isEligible(url) {
        return Boolean(this.extractId(url));
      },

      isValidTarget(url) {
        return this._RE.test(url.pathname);
      },

      toastSending:     'Download request sent…',
      ineligibleMsg:    'You cannot download the Instagram feed page. Please run it from the post screen (/p|/reel|/tv) or use the right-click menu on the media.',
      invalidTargetMsg: 'Right-click on an Instagram post or Reel and try again.',
    },

  ];

  BG.getSiteRule = function getSiteRule(url) {
    if (!url || BG.isInternalBrowserUrl(url)) return null;
    try {
      const h = new URL(url).hostname;
      for (const rule of BG.SITE_RULES) {
        if (rule.hostsExact.includes(h)) return rule;
        if (rule.hostsEndsWith.some((s) => h === s || h.endsWith('.' + s))) return rule;
      }
    } catch {}
    return null;
  };

  BG.getSiteType = function getSiteType(url) {
    return BG.getSiteRule(url)?.id ?? null;
  };

  BG.extractVideoId = function extractVideoId(url) {
    if (!url) return null;
    try {
      const rule = BG.getSiteRule(url);
      if (!rule) return null;
      return rule.extractId(new URL(url));
    } catch {}
    return null;
  };

  BG.canonicalVideoUrlFromId = function canonicalVideoUrlFromId(id) {
    if (!id) return null;
    if (id.startsWith('twitter:')) return BG.SITE_RULES.find((r) => r.id === 'twitter')?.toUrl(id) ?? null;
    if (id.startsWith('/'))        return BG.SITE_RULES.find((r) => r.id === 'instagram')?.toUrl(id) ?? null;
    return                                BG.SITE_RULES.find((r) => r.id === 'youtube')?.toUrl(id) ?? null;
  };

  BG.isActionEligible = function isActionEligible(url) {
    if (!url || BG.isInternalBrowserUrl(url)) return false;
    try {
      const rule = BG.getSiteRule(url);
      return rule ? rule.isEligible(new URL(url)) : false;
    } catch {}
    return false;
  };
})();
