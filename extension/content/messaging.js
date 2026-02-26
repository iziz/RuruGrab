'use strict';
(() => {
  const CS = globalThis.UTH_CS;

  CS.sendRuntimeMessage = function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  };
})();
