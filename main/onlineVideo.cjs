const https = require('node:https');

const MAX_REDIRECTS = 4;
const TOTAL_TIMEOUT_MS = 8000;
// Exact hosts only: this capability must never become an arbitrary HTTP proxy.
const VIDEO_HOSTS = new Set(['b23.tv', 'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'player.bilibili.com']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateVideoResolveUrl(value, base) {
  if (typeof value !== 'string' || !value || /[\s\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid video URL');
  }
  if ((!base && !/^https:\/\//i.test(value)) || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https:\/\//i.test(value))) {
    throw new Error('Video URL must use explicit HTTPS');
  }
  // URL normalizes explicit :443 away; inspect the original authority as well.
  const authority = value.match(/^(?:https:)?\/\/([^/?#]*)/i)?.[1];
  if (authority !== undefined && /[:@]/.test(authority)) throw new Error('Video URL credentials and ports are forbidden');
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !VIDEO_HOSTS.has(url.hostname)) {
    throw new Error('Video URL host or scheme is not allowed');
  }
  url.hash = '';
  return url;
}

function validateExternalVideoUrl(value) {
  if (typeof value !== 'string' || !value || /[\s\\\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid external video URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /@/.test(value.match(/^https?:\/\/([^/?#]*)/i)?.[1] || '')) {
    throw new Error('External video URL must be HTTP(S) without credentials');
  }
  return url.href;
}

function createVideoShortUrlResolver({ request = https.request, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return function resolveVideoShortUrl(value) {
    return new Promise((resolve, reject) => {
      let current;
      try {
        current = validateVideoResolveUrl(value);
        if (current.hostname !== 'b23.tv') throw new Error('Only b23.tv short URLs can be resolved');
      } catch (error) {
        reject(error);
        return;
      }
      let activeRequest;
      let settled = false;
      const timer = setTimer(() => finish(new Error('Video short URL resolution timed out')), TOTAL_TIMEOUT_MS);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        activeRequest?.destroy();
        if (error) reject(error);
        else resolve(result);
      }
      function visit(url, redirects) {
        if (settled) return;
        try {
          activeRequest = request(url, {
            method: 'GET',
            agent: false,
            maxHeaderSize: 16384,
            headers: { 'User-Agent': 'Artflow/online-video' },
          }, response => {
            // Inspect headers only. No data listeners, body reads, cookies or cookie jar.
            response.on('error', error => finish(error));
            response.destroy();
            if (settled) return;
            try {
              if (REDIRECT_STATUSES.has(response.statusCode)) {
                if (redirects >= MAX_REDIRECTS) throw new Error('Too many video URL redirects');
                const next = validateVideoResolveUrl(response.headers.location, url);
                visit(next, redirects + 1);
              } else if (response.statusCode >= 200 && response.statusCode < 300 && url.hostname !== 'b23.tv') {
                finish(null, url.href);
              } else {
                throw new Error(`Video short URL did not resolve (${response.statusCode})`);
              }
            } catch (error) {
              finish(error);
            }
          });
          activeRequest.on('error', error => finish(error));
          activeRequest.end();
        } catch (error) {
          finish(error);
        }
      }
      visit(current, 0);
    });
  };
}

module.exports = { validateVideoResolveUrl, validateExternalVideoUrl, createVideoShortUrlResolver };
