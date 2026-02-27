'use strict';
// Global namespace for content-script modules (loaded in-order via manifest)
globalThis.UTH_CS = globalThis.UTH_CS || {};

// Debug logging (#5)
globalThis.UTH_CS.DEBUG = false;
globalThis.UTH_CS.dbg = function dbg(...args) {
  if (globalThis.UTH_CS.DEBUG) console.debug('[UTH:CS]', ...args);
};
