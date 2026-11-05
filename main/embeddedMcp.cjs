/** Electron MCP transport is dormant until the resolved headless plugin is enabled. */
const path = require('node:path');
const { createMcpServer } = require('./mcpServer.cjs');
const { openCredentialStore } = require('./mcpCredentials.cjs');

const DISPATCH_CHANNEL = 'artflow-mcp:dispatch';
const RESULT_CHANNEL = 'artflow-mcp:dispatch-result';

const startEmbeddedMcp = async ({ userData, storageController, assertTrustedRenderer, electron = require('electron') }) => {
  const { BrowserWindow, ipcMain } = electron;
  const credentials = openCredentialStore(path.join(userData, 'mcp-credentials.json'));
  const pending = new Map();
  let server = null;
  let url = '';
  let enabled = false;
  let generation = 0;
  let disposed = false;
  let transition = Promise.resolve();
  const disabled = () => ({ isError: true, message: 'MCP is disabled' });
  const status = () => ({ enabled, url, credentials: credentials.list() });
  const clearPending = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(disabled());
    }
    pending.clear();
  };
  const setEnabled = value => {
    if (typeof value !== 'boolean') return Promise.reject(new Error('MCP enabled must be boolean'));
    // Immediately gate in-flight HTTP/dispatch; actual socket teardown is serialized.
    if (!value) {
      enabled = false;
      generation++;
      url = '';
      server?.setCatalog([]);
      clearPending();
    }
    transition = transition.catch(() => {}).then(async () => {
      if (!value || disposed) {
        enabled = false;
        generation++;
        url = '';
        clearPending();
        const previous = server;
        server = null;
        await previous?.close();
        return { enabled: false, url: '' };
      }
      if (server && enabled) return { enabled, url };
      const currentGeneration = ++generation;
      const next = createMcpServer({
        verifyCredential: token => enabled && generation === currentGeneration ? credentials.verify(token) : null,
        catalog: [],
        onCall: async request => {
          if (!enabled || generation !== currentGeneration) return disabled();
          if (request.name === 'get_project_status') return storageController.status();
          if (request.name === 'search_assets') {
            const args = request.arguments ?? {};
            try {
              return storageController.listAssetInventory({
                offset: Number.isInteger(args.offset) ? args.offset : 0,
                limit: Number.isInteger(args.limit) ? Math.min(args.limit, 50) : 20,
                unreferencedOnly: args.unreferencedOnly === true,
              });
            } catch (error) {
              return { isError: true, message: error.message };
            }
          }
          const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
          if (!window || !request.commandId) return { isError: true, message: 'Artflow window is not open' };
          const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          return new Promise(resolve => {
            const timer = setTimeout(() => {
              pending.delete(id);
              resolve({ isError: true, message: 'command timed out' });
            }, 15000);
            pending.set(id, { resolve, timer });
            window.webContents.send(DISPATCH_CHANNEL, { id, commandId: request.commandId });
          });
        },
      });
      const nextUrl = await next.listen();
      if (disposed || generation !== currentGeneration) {
        await next.close();
        return { enabled: false, url: '' };
      }
      server = next;
      url = nextUrl;
      enabled = true;
      return { enabled, url };
    });
    return transition;
  };

  const channels = [];
  const handle = (channel, callback) => {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedRenderer(event);
      return callback(...args);
    });
  };
  handle('artflow-mcp:set-enabled', setEnabled);
  handle('artflow-mcp:get-status', status);
  handle('artflow-mcp:create-credential', request => credentials.create(request ?? {}));
  handle('artflow-mcp:revoke-credential', id => { credentials.revoke(id); return status(); });
  handle('artflow-mcp:reveal-credential', id => {
    const revealed = credentials.reveal(id);
    if (!revealed) throw new Error('unknown credential');
    return { url, ...revealed };
  });
  handle('artflow-mcp:publish-catalog', entries => {
    if (!enabled || !server) throw new Error('MCP is disabled');
    // setCatalog owns validation; validating twice loses the raw title field.
    server.setCatalog(entries);
    return { count: entries.length };
  });
  const onResult = (event, payload) => {
    try { assertTrustedRenderer(event); } catch { return; }
    if (!enabled) return;
    const waiter = pending.get(payload?.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(payload.id);
    waiter.resolve(payload?.ok ? payload.result : { isError: true, message: payload?.message || 'command failed' });
  };
  ipcMain.on(RESULT_CHANNEL, onResult);
  return {
    get url() { return url; },
    setEnabled,
    close: () => {
      disposed = true;
      for (const channel of channels) ipcMain.removeHandler(channel);
      ipcMain.removeListener(RESULT_CHANNEL, onResult);
      return setEnabled(false);
    },
  };
};

module.exports = { startEmbeddedMcp };
