'use strict';
(() => {
  const CS = globalThis.UTH_CS;

  CS.DEFAULT_SETTINGS = {
    badgeText: 'WATCHED',
    badgeBgColor: 'rgba(249, 255, 22, 0.7)',
    badgeTextColor: 'rgba(0, 0, 0, 0.9)',
    badgeBorderColor: 'rgba(255, 255, 255, 0.6)',
  };

  CS.FORCED_MARKING_SETTINGS = {
    watchedEnabled: true,
    badgeEnabled: true,
  };

  CS.settings = { ...CS.FORCED_MARKING_SETTINGS, ...CS.DEFAULT_SETTINGS };

  CS.loadSettings = async function loadSettings() {
    const s = await chrome.storage.local
      .get({ ...CS.FORCED_MARKING_SETTINGS, ...CS.DEFAULT_SETTINGS })
      .catch(() => ({}));
    CS.settings = { ...CS.FORCED_MARKING_SETTINGS, ...CS.DEFAULT_SETTINGS, ...s };
  };

  function applySettingsPatch(changes) {
    for (const [k, v] of Object.entries(changes || {})) {
      if (k === 'watchedEnabled') CS.settings.watchedEnabled = !!v.newValue;
      if (k === 'badgeEnabled') CS.settings.badgeEnabled = !!v.newValue;
      if (k === 'badgeText') CS.settings.badgeText = v.newValue;
      if (k === 'badgeBgColor') CS.settings.badgeBgColor = v.newValue;
      if (k === 'badgeTextColor') CS.settings.badgeTextColor = v.newValue;
      if (k === 'badgeBorderColor') CS.settings.badgeBorderColor = v.newValue;
    }
  }

  CS.setupSettingsListener = function setupSettingsListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      applySettingsPatch(changes);

      // If watched UI visibility or styling changed, re-apply immediately on visible renderers.
      try {
        if (
          changes.watchedEnabled ||
          changes.badgeEnabled ||
          changes.badgeText ||
          changes.badgeBgColor ||
          changes.badgeTextColor ||
          changes.badgeBorderColor
        ) {
          for (const r of CS.visibleRenderers || []) {
            if (!(r instanceof Element) || !r.isConnected) continue;

            if (!CS.settings.watchedEnabled) {
              CS.applyWatched?.(r, false);
              continue;
            }

            if (r.classList?.contains('yt-dlp-watched')) {
              CS.applyWatched?.(r, true);
            }
          }
        }
      } catch {}

      try { CS.queueScan?.(); } catch {}
      try { CS.refreshAllKnown?.().catch(() => {}); } catch {}
    });
  };
})();
