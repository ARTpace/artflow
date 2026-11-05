const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createMcpServer, validateCatalog } = require('../main/mcpServer.cjs');
const { openCredentialStore } = require('../main/mcpCredentials.cjs');

const rpc = (url, { token, session, message, origin, host }) => new Promise((resolve, reject) => {
  const body = JSON.stringify(message);
  const target = new URL(url);
  const req = http.request({
    hostname: '127.0.0.1',
    port: target.port,
    path: '/mcp',
    method: 'POST',
    headers: {
      host: host ?? `127.0.0.1:${target.port}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
      ...(origin ? { origin } : {}),
    },
  }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve({
        status: response.statusCode,
        session: response.headers['mcp-session-id'],
        body: raw ? JSON.parse(raw) : null,
      });
    });
  });
  req.on('error', reject);
  req.end(body);
});

const main = async () => {
  assert.throws(() => validateCatalog([{ name: 'exec_tool', commandId: 'danger.exec', title: 'no' }]), /rejected MCP tool name/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-mcp-'));
  const store = openCredentialStore(path.join(dir, 'mcp-credentials.json'));
  const full = store.reveal(store.list()[0].id);
  const reader = store.create({ name: 'reader', mode: 'read-only' });
  const calls = [];
  const server = createMcpServer({
    verifyCredential: token => store.verify(token),
    onCall: async request => {
      calls.push(request.name);
      return { ok: true, commandId: request.commandId ?? null };
    },
  });
  const url = await server.listen();
  try {
    const denied = await rpc(url, { message: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    assert.equal(denied.status, 401);

    const foreign = await rpc(url, {
      token: full.token,
      origin: 'https://evil.example',
      message: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    assert.equal(foreign.status, 403);

    server.setCatalog([
      { name: 'workspace__fit-canvas', commandId: 'workspace.fit-canvas', title: 'Fit', description: 'Fit', impact: 'write', destructive: false },
      { name: 'danger__wipe', commandId: 'danger.wipe', title: 'Wipe', description: 'Wipe', impact: 'write', destructive: true },
    ]);

    const opened = await rpc(url, {
      token: full.token,
      message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'check', version: '0' } } },
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.result.serverInfo.name, 'artflow');
    assert.match(opened.body.result.instructions, /challengeId/);
    const session = opened.session;

    const listed = await rpc(url, {
      token: full.token,
      session,
      message: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    const names = listed.body.result.tools.map(tool => tool.name);
    assert.ok(names.includes('get_project_status'));
    assert.ok(names.includes('search_assets'));
    assert.ok(names.includes('workspace__fit-canvas'));
    assert.ok(names.includes('danger__wipe'));
    assert.equal(listed.body.result.tools.find(tool => tool.name === 'search_assets').annotations.openWorldHint, false);

    const readSession = await rpc(url, {
      token: reader.token,
      message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    const readList = await rpc(url, {
      token: reader.token,
      session: readSession.session,
      message: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    const readNames = readList.body.result.tools.map(tool => tool.name);
    assert.deepEqual(readNames, ['get_project_status', 'search_assets', 'list_commands']);

    const hidden = await rpc(url, {
      token: reader.token,
      session: readSession.session,
      message: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_command', arguments: { name: 'workspace__fit-canvas' } } },
    });
    assert.equal(hidden.body.result.isError, true);

    const blocked = await rpc(url, {
      token: full.token,
      session,
      message: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'danger__wipe', arguments: {} } },
    });
    assert.equal(calls.includes('danger__wipe'), false);
    const challenge = JSON.parse(blocked.body.result.content[0].text);
    assert.equal(typeof challenge.challengeId, 'string');

    const wrong = await rpc(url, {
      token: full.token,
      session,
      message: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'danger__wipe', arguments: { challengeId: challenge.challengeId, planHash: 'nope', acknowledged: true, idempotencyKey: 'idem-0001' } } },
    });
    assert.equal(calls.includes('danger__wipe'), false);
    assert.equal(wrong.body.result.content[0].text.includes('challengeId'), true);

    const first = JSON.parse(wrong.body.result.content[0].text);
    const ran = await rpc(url, {
      token: full.token,
      session,
      message: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'danger__wipe', arguments: { challengeId: first.challengeId, planHash: first.planHash, acknowledged: true, idempotencyKey: 'idem-0001' } } },
    });
    assert.equal(calls.filter(name => name === 'danger__wipe').length, 1);
    assert.match(ran.body.result.content[0].text, /danger\.wipe/);

    const headless = await fs.readFile(path.join(__dirname, '../builtin-plugins/headless/index.tsx'), 'utf8');
    const embedded = await fs.readFile(path.join(__dirname, '../main/embeddedMcp.cjs'), 'utf8');
    assert.doesNotMatch(headless, /artflowMcp|ipcRenderer|node:fs|listen\(/);
    assert.match(embedded, /listAssetInventory/);
    assert.match(embedded, /assertTrustedRenderer/);
    const registry = await fs.readFile(path.join(__dirname, '../builtin-plugins/index.ts'), 'utf8');
    assert.match(registry, /headlessPlugin/);
    assert.doesNotMatch(registry, /PROTECTED_BUILTIN_PLUGIN_IDS[\s\S]*builtin\.headless/);
    console.log('mcp checks: ok');
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
