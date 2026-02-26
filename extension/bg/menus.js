'use strict';
(() => {
  const BG = self.UTH_BG;

  if (BG.__menusInitialized) return;
  BG.__menusInitialized = true;

  const DL_CONTEXTS = ['page', 'link', 'video', 'image'];
  const DL_PATTERNS = [
    '*://*.youtube.com/*', '*://youtube.com/*',
    '*://*.twitter.com/*', '*://twitter.com/*',
    '*://*.x.com/*', '*://x.com/*',
    '*://*.instagram.com/*', '*://instagram.com/*',
  ];

  const YT_CONTEXTS = ['page', 'link', 'video'];
  const YT_PATTERNS = ['*://*.youtube.com/*', '*://youtube.com/*'];

  BG.ensureContextMenus = function ensureContextMenus() {
    try {
      chrome.contextMenus.removeAll(() => {
        const parentId = chrome.contextMenus.create({
          id: BG.CM_ROOT,
          title: 'UtubeHolic',
          contexts: DL_CONTEXTS,
          documentUrlPatterns: DL_PATTERNS,
        });

        chrome.contextMenus.create({
          id: BG.CM_DOWNLOAD,
          parentId,
          title: '⤓ Grab',
          contexts: DL_CONTEXTS,
          documentUrlPatterns: DL_PATTERNS,
        });

        chrome.contextMenus.create({
          id: BG.CM_MARK,
          parentId,
          title: '✓ Watch',
          contexts: YT_CONTEXTS,
          documentUrlPatterns: YT_PATTERNS,
        });

        chrome.contextMenus.create({
          id: BG.CM_UNMARK,
          parentId,
          title: '⍻ Un-watch',
          contexts: YT_CONTEXTS,
          documentUrlPatterns: YT_PATTERNS,
        });
      });
    } catch (e) {
      console.error('ensureContextMenus failed', e);
    }
  };

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    (async () => {
      const tabId = tab?.id;
      const tabUrl = tab?.url || '';

      switch (info.menuItemId) {

        case BG.CM_DOWNLOAD: {
          const rawUrl = info.linkUrl || info.srcUrl || info.pageUrl || tabUrl || '';

          const rule = BG.getSiteRule(tabUrl);
          if (!rule) throw new Error('This page is not supported.');

          let finalId  = BG.extractVideoId(rawUrl) || BG.extractVideoId(tabUrl);
          let finalUrl = finalId ? BG.canonicalVideoUrlFromId(finalId) : rawUrl;

          if (rule.id === 'youtube' && !finalId) {
            throw new Error(rule.invalidTargetMsg);
          }

          if (rule.id !== 'youtube') {
            let parsedFinal;
            try { parsedFinal = new URL(finalUrl); } catch { parsedFinal = null; }

            if (!parsedFinal || !rule.isValidTarget(parsedFinal)) {
              const resp = await BG.safeTabsSendMessage(tabId, { type: rule.contentScriptMsg });
              if (resp?.url) {
                const recovered = BG.extractVideoId(resp.url);
                if (recovered) {
                  finalId  = recovered;
                  finalUrl = BG.canonicalVideoUrlFromId(recovered);
                } else {
                  finalUrl = resp.url;
                }
              }

              try {
                if (!rule.isValidTarget(new URL(finalUrl))) throw new Error(rule.invalidTargetMsg);
              } catch (e) {
                if (e.message === rule.invalidTargetMsg) throw e;
                throw new Error(rule.invalidTargetMsg);
              }
            }
          }

          if (!finalUrl) throw new Error('No URL to download');

          await BG.toastOrBadge(tabId, rule.toastSending, 'info');
          await BG.enqueueDownload(finalUrl, { source: rule.source });
          await BG.toastOrBadge(tabId, 'Added to download queue', 'ok');
          return;
        }

        case BG.CM_MARK: {
          const baseUrl = info.linkUrl || info.pageUrl || tabUrl || '';
          const id = BG.extractVideoId(baseUrl);
          if (!id) throw new Error('No videoId found');
          await BG.markWatched(id, Date.now());
          await BG.toastOrBadge(tabId, 'Marked as watched', 'ok');
          return;
        }

        case BG.CM_UNMARK: {
          const baseUrl = info.linkUrl || info.pageUrl || tabUrl || '';
          const id = BG.extractVideoId(baseUrl);
          if (!id) throw new Error('No videoId found');
          await BG.unmarkWatched(id);
          await BG.toastOrBadge(tabId, 'Unchecked', 'ok');
          return;
        }

        default:
          return;
      }
    })().catch(async (err) => {
      console.error(err);
      const msg = String(err?.message || err || 'unknown');
      await BG.toastOrBadge(tab?.id, `Request failed: ${msg}`, 'error');
    });
  });

    chrome.action.onClicked.addListener((tab) => {
    (async () => {
      const tabId  = tab?.id;
      const tabUrl = tab?.url || '';

      if (!tabUrl || BG.isInternalBrowserUrl(tabUrl)) {
        throw new Error('The download feature is not available on this page.');
      }

      const rule = BG.getSiteRule(tabUrl);
      if (!rule) throw new Error('This page is not supported.');

      const u = new URL(tabUrl);
      if (!rule.isEligible(u)) throw new Error(rule.ineligibleMsg);

      const id       = rule.extractId(u);
      const finalUrl = id ? rule.toUrl(id) : tabUrl;

      await BG.toastOrBadge(tabId, rule.toastSending, 'info');
      await BG.enqueueDownload(finalUrl, { source: rule.source });
      await BG.toastOrBadge(tabId, 'Added to download queue', 'ok');
    })().catch(async (err) => {
      const msg = String(err?.message || err || 'unknown');
      await BG.toastOrBadge(tab?.id, `Request failed: ${msg}`, 'error');
    });
  });
})();
