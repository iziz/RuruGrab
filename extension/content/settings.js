'use strict';
(() => {
  const CS = globalThis.UTH_CS;

  CS.DEFAULT_SETTINGS = {
    badgeText: 'WATCHED',
    badgeBgColor: 'rgba(249, 255, 22, 0.7)',
    badgeTextColor: 'rgba(0, 0, 0, 0.9)',
    badgeBorderColor: 'rgba(255, 255, 255, 0.6)',
  };

  // Options UI removed toggles -> force ON
  CS.FORCED_MARKING_SETTINGS = {
    watchedEnabled: true,
    badgeEnabled: true,
  };

  CS.settings = { ...CS.FORCED_MARKING_SETTINGS, ...CS.DEFAULT_SETTINGS };

  CS.loadSettings = async function loadSettings() {
    try { await chrome.storage.local.set({ ...CS.FORCED_MARKING_SETTINGS }); } catch {}
    const s = await chrome.storage.local.get(CS.DEFAULT_SETTINGS).catch(() => ({}));
    CS.settings = { ...CS.FORCED_MARKING_SETTINGS, ...CS.DEFAULT_SETTINGS, ...s };
  };

  function applySettingsPatch(changes) {
    for (const [k, v] of Object.entries(changes || {})) {
      if (k === 'badgeText') CS.settings.badgeText = v.newValue;
      if (k === 'badgeBgColor') CS.settings.badgeBgColor = v.newValue;
      if (k === 'badgeTextColor') CS.settings.badgeTextColor = v.newValue;
      if (k === 'badgeBorderColor') CS.settings.badgeBorderColor = v.newValue;
    }
    CS.settings.watchedEnabled = true;
    CS.settings.badgeEnabled = true;
  }

  CS.setupSettingsListener = function setupSettingsListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      applySettingsPatch(changes);

      // If badge styling changed, re-apply on visible watched renderers.
      try {
        if ((changes.badgeText || changes.badgeBgColor || changes.badgeTextColor || changes.badgeBorderColor) && CS.io) {
          for (const r of CS.visibleRenderers) {
            if (r?.classList?.contains('yt-dlp-watched')) CS.ensureBadge?.(r, CS.settings.badgeText);
          }
        }
      } catch {}

      try { CS.queueScan?.(); } catch {}
      try { CS.refreshAllKnown?.().catch(() => {}); } catch {}
    });
  };
})();
