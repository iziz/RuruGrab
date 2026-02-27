'use strict';
(() => {
  const CS = globalThis.UTH_CS;

  function applyInlineBadgeStyles(badge) {
    if (!(badge instanceof HTMLElement)) return;
    // Base styles are now in content.css (#8) — only dynamic colors here
    badge.style.backgroundColor = String(CS.settings.badgeBgColor || CS.DEFAULT_SETTINGS.badgeBgColor);
    badge.style.color = String(CS.settings.badgeTextColor || CS.DEFAULT_SETTINGS.badgeTextColor);
    badge.style.borderStyle = 'solid';
    badge.style.borderWidth = '1px';
    badge.style.borderColor = String(CS.settings.badgeBorderColor || CS.DEFAULT_SETTINGS.badgeBorderColor);
  }

  function findBadgeHost(renderer) {
    if (!(renderer instanceof Element)) return null;

    // Elements with `display: contents` cannot be used as badge position anchors.
    const isUsable = (el) => {
      if (!(el instanceof Element)) return false;
      if (CS.isDisplayContents(el)) return false;
      return true;
    };

    // Since getBoundingClientRect may return 0 before thumbnail image loading,
    // size checking is replaced with a “positioned candidates first” strategy.
    // If a candidate exists even if small, it is used as a fallback.
    const candidates = [
      renderer.querySelector('.shortsLockupViewModelHostThumbnailParentContainerRounded'),
      renderer.querySelector('.shortsLockupViewModelHostThumbnailParentContainer'),
      renderer.querySelector('a.reel-item-endpoint'),
      renderer.querySelector('a.shortsLockupViewModelHostEndpoint.reel-item-endpoint'),

      renderer.querySelector('a#thumbnail #overlays, #thumbnail #overlays'),
      renderer.querySelector('ytd-thumbnail #overlays'),
      renderer.querySelector('yt-thumbnail-view-model #overlays'),

      renderer.querySelector('ytd-thumbnail'),
      renderer.querySelector('yt-thumbnail-view-model'),

      renderer.querySelector('a#thumbnail'),
      renderer.querySelector('a.yt-lockup-view-model-wiz__content-image'),
      renderer.querySelector('.yt-lockup-view-model-wiz__content-image'),
      renderer.querySelector('#thumbnail')
    ].filter(Boolean);

    // Priority 1: Usable elements that are already positioned
    for (const el of candidates) {
      if (!isUsable(el)) continue;
      try {
        if (getComputedStyle(el).position !== 'static') return el;
      } catch {}
    }

    // 2nd priority: The first usable element (patch by setting position to relative)
    for (const el of candidates) {
      if (isUsable(el)) return el;
    }

    return null;
  }

  CS.ensureBadge = function ensureBadge(renderer, input) {
    const host = findBadgeHost(renderer);
    if (!host) {
      return;
    }

    try {
      const pos = getComputedStyle(host).position;
      if (!pos || pos === 'static') {
        if (host.dataset.ytDlpPosPatched !== '1') {
          host.dataset.ytDlpPrevPos = host.style.position || '';
          host.dataset.ytDlpPosPatched = '1';
          host.style.position = 'relative';
        }
      }
    } catch {}

    let badge = host.querySelector(':scope > .yt-dlp-watched-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'yt-dlp-watched-badge';
      badge.setAttribute('aria-hidden', 'true');
      host.appendChild(badge);
    }

    applyInlineBadgeStyles(badge);

    /*
    TODO: Later, when you want to add an image to the Watch mark, you can use this code including the option.

    input = chrome.runtime.getURL("images/check.png");

    const isImageUrl = typeof input === 'string' && /^(https?|data|chrome-extension):\/\//.test(input);
    if (isImageUrl) {
      if (badge.textContent !== '') badge.textContent = '';

      let img = badge.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        badge.appendChild(img);
      }
      img.src = input;
      
      img.style.display = 'block';
      img.style.maxWidth = '12px';
      img.style.maxHeight = '12px';
      img.style.objectFit = 'contain';

      //badge.style.backgroundColor = 'transparent'
      //badge.style.padding = '0'; 
      //badge.style.border = 'none';
    } else {
      badge.innerHTML = '';
      badge.textContent = input || 'WATCHED';
    }

    */ 
    badge.textContent = input || '✔';
  };

  CS.removeBadge = function removeBadge(renderer) {
    if (!(renderer instanceof Element)) return;
    const badges = renderer.querySelectorAll('.yt-dlp-watched-badge');
    for (const b of badges) {
      const host = b.parentElement;
      b.remove();
      try {
        if (host && host.dataset?.ytDlpPosPatched === '1') {
          host.style.position = host.dataset.ytDlpPrevPos || '';
          delete host.dataset.ytDlpPrevPos;
          delete host.dataset.ytDlpPosPatched;
        }
      } catch {}
    }
  };

  CS.applyWatched = function applyWatched(renderer, watched) {
    if (!renderer) return;
    if (watched) {
      renderer.classList.add('yt-dlp-watched');
      CS.ensureBadge(renderer, CS.settings.badgeText);
    } else {
      renderer.classList.remove('yt-dlp-watched');
      CS.removeBadge(renderer);
    }
  };
})();
