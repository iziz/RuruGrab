'use strict';
(() => {
  if (window.top !== window) return;
  
  if (globalThis.__UTH_TOAST_INIT) return;
  globalThis.__UTH_TOAST_INIT = true;
  
  function ensureRoot() {
    let root = document.getElementById('rurugrab-toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'rurugrab-toast-root';
      root.style.position = 'fixed';
      root.style.top = '12px';
      root.style.right = '12px';
      root.style.zIndex = '2147483647';
      root.style.display = 'flex';
      root.style.flexDirection = 'column';
      root.style.alignItems = 'flex-end';
      root.style.pointerEvents = 'none';
      document.documentElement.appendChild(root);
    }
    return root;
  }

  function showToast(text, kind) {
    try {
      const root = ensureRoot();
      const el = document.createElement('div');
      el.textContent = String(text || '');

      el.style.maxWidth = '80vw';
      el.style.whiteSpace = 'nowrap';
      el.style.overflow = 'hidden';
      el.style.textOverflow = 'ellipsis';
      el.style.fontSize = '13px';
      el.style.lineHeight = '18px';
      el.style.padding = '10px 14px';
      el.style.borderRadius = '999px';
      el.style.marginTop = '8px';
      el.style.boxShadow = '0 6px 24px rgba(0,0,0,0.35)';
      el.style.background = 'rgba(20,20,20,0.92)';
      el.style.color = '#fff';

      if (kind === 'error') el.style.background = 'rgba(140, 30, 30, 0.92)';
      else if (kind === 'ok') el.style.background = 'rgba(20, 110, 50, 0.92)';

      root.appendChild(el);

      try {
        el.animate([
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0px)' },
        ], { duration: 140, fill: 'forwards' });
      } catch { /* older browsers */ }

      setTimeout(() => {
        try {
          const anim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
          anim.onfinish = () => { try { el.remove(); } catch {} };
        } catch {
          try { el.remove(); } catch {}
        }
      }, 1800);
    } catch {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'RURUGRAB_TOAST' || msg?.type === 'UTUBEHOLIC_TOAST') {
      showToast(msg.text, msg.kind);
      sendResponse?.({ ok: true });
      return true;
    }
    return false;
  });
})();
