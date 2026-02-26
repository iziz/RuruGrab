'use strict';
(() => {
  if (globalThis.__UTH_CS_INIT) return;
  globalThis.__UTH_CS_INIT = true;

  const CS = globalThis.UTH_CS;

  (async () => {
    await CS.loadSettings();
    CS.setupSettingsListener();
    CS.initHooks();
  })().catch(() => { });
})();
