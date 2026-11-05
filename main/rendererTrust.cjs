const path = require('node:path');
const { fileURLToPath } = require('node:url');

/** Restrict privileged IPC to the packaged renderer or the configured Vite development origin. */
function createTrustedRendererUrlChecker({ isDev, devOrigin, rendererRoot }) {
  const expectedDevOrigin = isDev ? new URL(devOrigin).origin : null;
  const trustedRendererRoot = path.resolve(rendererRoot);
  return candidate => {
    try {
      const url = new URL(candidate);
      if (isDev) return url.origin === expectedDevOrigin;
      if (url.protocol !== 'file:') return false;
      const filePath = path.resolve(fileURLToPath(url));
      return filePath === trustedRendererRoot || filePath.startsWith(`${trustedRendererRoot}${path.sep}`);
    } catch {
      return false;
    }
  };
}

module.exports = { createTrustedRendererUrlChecker };
