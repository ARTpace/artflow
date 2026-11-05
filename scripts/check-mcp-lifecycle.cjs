const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { startEmbeddedMcp } = require('../main/embeddedMcp.cjs');
const post = (url, token, message, session) => new Promise((resolve, reject) => {
  const body = JSON.stringify(message);
  const req = http.request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(session ? { 'mcp-session-id': session } : {}) } }, response => {
    let text = '';
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, session: response.headers['mcp-session-id'], body: JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end(body);
});
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-mcp-lifecycle-'));
  const handlers = new Map();
  const ipc = new EventEmitter();
  ipc.handle = (channel, callback) => handlers.set(channel, callback);
  ipc.removeHandler = channel => handlers.delete(channel);
  let dispatchResolve;
  let dispatches = 0;
  const electron = { ipcMain: ipc, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_channel, request) => { dispatches++; dispatchResolve?.(request); } } }] } };
  const controller = await startEmbeddedMcp({ userData: dir, electron, storageController: { status: () => ({ open: true }) }, assertTrustedRenderer: event => { assert.equal(event.trusted, true); } });
  const invoke = (channel, ...args) => handlers.get(`artflow-mcp:${channel}`)({ trusted: true }, ...args);
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  const catalog = [{ name: 'workspace__fit', commandId: 'workspace.fit', title: 'Fit', impact: 'write', destructive: false }];
  try {
    assert.equal(controller.url, '', 'startup must not listen before profile resolution');
    assert.equal(invoke('get-status').enabled, false);
    assert.throws(() => invoke('publish-catalog', catalog), /MCP is disabled/);
    assert.throws(() => handlers.get('artflow-mcp:set-enabled')({ trusted: false }, true));
    const credential = invoke('create-credential', { name: 'lifecycle', mode: 'full-access' });
    await invoke('set-enabled', true);
    const firstUrl = controller.url;
    invoke('publish-catalog', catalog);
    const initialized = await post(firstUrl, credential.token, init);
    assert.equal(initialized.status, 200);
    const session = initialized.session;
    const listed = await post(firstUrl, credential.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
    assert.ok(listed.body.result.tools.some(tool => tool.name === 'workspace__fit'));
    const dispatched = new Promise(resolve => { dispatchResolve = resolve; });
    const call = post(firstUrl, credential.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace__fit', arguments: {} } }, session).catch(error => ({ interrupted: error.code }));
    const request = await dispatched;
    await invoke('set-enabled', false);
    await call;
    assert.equal(controller.url, '');
    assert.throws(() => invoke('publish-catalog', catalog), /MCP is disabled/);
    ipc.emit('artflow-mcp:dispatch-result', { trusted: true }, { id: request.id, ok: true, result: 'late' });
    await assert.rejects(post(firstUrl, credential.token, init), /ECONNREFUSED|ECONNRESET|socket hang up/);
    assert.equal(dispatches, 1);
    await invoke('set-enabled', true);
    const restarted = await post(controller.url, credential.token, init);
    const freshList = await post(controller.url, credential.token, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, restarted.session);
    assert.ok(!freshList.body.result.tools.some(tool => tool.name === 'workspace__fit'), 'old catalog cannot survive disable');
    invoke('publish-catalog', catalog);
    const restored = await post(controller.url, credential.token, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, restarted.session);
    assert.ok(restored.body.result.tools.some(tool => tool.name === 'workspace__fit'));
    // Concurrent activation followed by disable may never leave a listener behind.
    await invoke('set-enabled', false);
    await Promise.all([invoke('set-enabled', true), invoke('set-enabled', false)]);
    assert.equal(invoke('get-status').enabled, false);
    assert.equal(controller.url, '');
  } finally {
    await controller.close();
    assert.equal(handlers.size, 0);
    assert.equal(ipc.listenerCount('artflow-mcp:dispatch-result'), 0);
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log('MCP lifecycle: dormant startup, trusted activation, HTTP shutdown, catalog/dispatch invalidation and restart passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
