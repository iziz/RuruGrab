'use strict';
(() => {
    let lastRightClickedUrl = null;

    function findTweetUrl(target) {
        let current = target;
        while (current && current !== document) {
            if (current.tagName === 'A') {
                const href = current.href || current.getAttribute('href');
                if (href && href.includes('/status/')) {
                    return href;
                }
            }
            current = current.parentNode;
        }

        const article = target.closest('article');
        if (article) {
            const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));

            const tweetLink = links.find(a => {
                const url = new URL(a.href, location.href);
                return /\/status\/[0-9]+/.test(url.pathname);
            });

            if (tweetLink) {
                return tweetLink.href;
            }
        }

        return null;
    }

    document.addEventListener('contextmenu', (e) => {
        lastRightClickedUrl = findTweetUrl(e.target);
    }, true);

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type === 'GET_RIGHT_CLICK_TWEET_URL') {
            sendResponse({ url: lastRightClickedUrl });
            return true;
        }
        return false;
    });
})();
