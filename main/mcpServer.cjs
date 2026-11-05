/**
 * 本机 MCP Streamable HTTP。只绑 127.0.0.1。
 * 插件不能把传输层换掉；这里只接收已经投影好的工具目录，并执行调用方给出的 onCall。
 */

const http = require('node:http');
const crypto = require('node:crypto');

const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SESSIONS = 64;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 60 * 1000;
const OUTPUT_LIMIT = 16000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const UNSAFE_TOOL_NAME = /eval|shell|sql|fs|exec|net|process/i;

const INSTRUCTIONS = [
  'Artflow MCP tools are projected from the in-app command registry.',
  'A destructive tool does not run on the first call. It returns challengeId and planHash.',
  'Run it only by repeating the same arguments with challengeId, planHash, acknowledged:true and a non-empty idempotencyKey.',
  'There is no implicit focused board. openWorldHint is false.',
].join(' ');

const builtinTools = () => [
  {
    name: 'get_project_status',
    description: 'Read whether a managed project is open, and its folder name.',
    impact: 'read',
    destructive: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_assets',
    description: 'Read a page of managed asset records. Does not return file paths or full hashes.',
    impact: 'read',
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        unreferencedOnly: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_commands',
    description: 'List commands the current credential is allowed to see.',
    impact: 'read',
    destructive: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_command',
    description: 'Run one exported command by its MCP tool name. Write access required.',
    impact: 'write',
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        challengeId: { type: 'string' },
        planHash: { type: 'string' },
        acknowledged: { type: 'boolean' },
        idempotencyKey: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

const toolDescriptor = tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: {
    readOnlyHint: tool.impact === 'read',
    destructiveHint: Boolean(tool.destructive),
    openWorldHint: false,
  },
});

const planHashFor = (name, args) => crypto.createHash('sha256').update(JSON.stringify({
  name,
  arguments: args,
})).digest('hex');

const challengeArgs = args => {
  const rest = { ...args };
  delete rest.challengeId;
  delete rest.planHash;
  delete rest.acknowledged;
  delete rest.idempotencyKey;
  return rest;
};

const limitText = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n…truncated`;
};

const json = (response, status, body, headers = {}) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const rpcResult = (id, result, extraHeaders) => ({
  status: 200,
  body: { jsonrpc: '2.0', id, result },
  headers: extraHeaders,
});

const rpcError = (id, code, message) => ({
  status: code === -32600 ? 400 : 200,
  body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
});

const validateCatalog = entries => {
  if (!Array.isArray(entries) || entries.length > 100) {
    throw new Error('MCP catalog must be an array of at most 100 tools');
  }
  const names = new Set(builtinTools().map(tool => tool.name));
  const clean = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('MCP catalog entry must be an object');
    if (typeof entry.name !== 'string' || !TOOL_NAME.test(entry.name) || UNSAFE_TOOL_NAME.test(entry.name)) {
      throw new Error(`rejected MCP tool name: ${String(entry.name)}`);
    }
    if (names.has(entry.name)) throw new Error(`duplicate MCP tool name: ${entry.name}`);
    if (typeof entry.commandId !== 'string' || typeof entry.title !== 'string') {
      throw new Error(`MCP tool ${entry.name} is missing commandId or title`);
    }
    const impact = entry.impact === 'read' ? 'read' : 'write';
    names.add(entry.name);
    clean.push({
      name: entry.name,
      commandId: entry.commandId,
      description: typeof entry.description === 'string' ? entry.description : entry.title,
      impact,
      destructive: entry.destructive === true,
      inputSchema: entry.destructive === true ? {
        type: 'object',
        properties: {
          challengeId: { type: 'string' },
          planHash: { type: 'string' },
          acknowledged: { type: 'boolean' },
          idempotencyKey: { type: 'string' },
        },
        additionalProperties: false,
      } : { type: 'object', properties: {}, additionalProperties: false },
    });
  }
  return clean;
};

const createMcpServer = ({ verifyCredential, onCall, catalog }) => {
  let tools = validateCatalog(catalog ?? []);
  const sessions = new Map();
  const challenges = new Map();
  const idempotency = new Map();

  const sweep = now => {
    for (const [id, session] of sessions) {
      if (now - session.seen > SESSION_IDLE_MS) sessions.delete(id);
    }
    for (const [id, challenge] of challenges) {
      if (challenge.expires <= now) challenges.delete(id);
    }
  };

  const visibleTools = mode => {
    const all = [...builtinTools(), ...tools];
    return mode === 'read-only' ? all.filter(tool => tool.impact === 'read') : all;
  };

  const issueChallenge = (sessionId, name, args) => {
    const challengeId = crypto.randomUUID();
    const planHash = planHashFor(name, args);
    challenges.set(challengeId, { sessionId, name, planHash, expires: Date.now() + CHALLENGE_TTL_MS });
    return { challengeId, planHash, message: 'not executed; repeat the call with this challenge' };
  };

  const consumeChallenge = (sessionId, name, args, fields) => {
    const row = challenges.get(fields.challengeId);
    if (!row || row.sessionId !== sessionId || row.name !== name || row.planHash !== fields.planHash) return false;
    if (row.expires <= Date.now() || fields.acknowledged !== true) return false;
    if (typeof fields.idempotencyKey !== 'string' || fields.idempotencyKey.length < 8 || fields.idempotencyKey.length > 128) return false;
    if (planHashFor(name, args) !== fields.planHash) return false;
    challenges.delete(fields.challengeId);
    return true;
  };

  const finishCall = async (session, tool, bare, idempotencyKey) => {
    const payload = await onCall({
      name: tool.name,
      commandId: tool.commandId,
      arguments: bare,
      mode: session.mode,
    });
    const result = {
      content: [{ type: 'text', text: limitText(payload) }],
      ...(payload && payload.isError ? { isError: true } : {}),
    };
    if (tool.destructive && idempotencyKey) idempotency.set(`${session.id}:${idempotencyKey}`, result);
    return result;
  };

  const guardedCall = async (session, tool, bare, fields) => {
    if (!tool.destructive) return finishCall(session, tool, bare, '');
    const key = `${session.id}:${fields.idempotencyKey ?? ''}`;
    if (typeof fields.idempotencyKey === 'string' && idempotency.has(key)) return idempotency.get(key);
    if (!consumeChallenge(session.id, tool.name, bare, fields)) {
      return { content: [{ type: 'text', text: limitText(issueChallenge(session.id, tool.name, bare)) }] };
    }
    return finishCall(session, tool, bare, fields.idempotencyKey);
  };

  const callTool = async (session, name, args) => {
    const tool = visibleTools(session.mode).find(item => item.name === name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown or hidden tool: ${name}` }] };
    if (name === 'list_commands') {
      const page = visibleTools(session.mode).map(item => ({
        name: item.name,
        impact: item.impact,
        destructive: Boolean(item.destructive),
      }));
      return { content: [{ type: 'text', text: limitText(page) }] };
    }
    if (name === 'run_command') {
      const target = visibleTools(session.mode).find(item => item.name === args.name && item.commandId);
      if (!target) return { isError: true, content: [{ type: 'text', text: `unknown command: ${String(args.name)}` }] };
      return guardedCall(session, target, {}, args);
    }
    return guardedCall(session, tool, challengeArgs(args), args);
  };

  const handleRpc = async (session, message, responseHeaders) => {
    const id = message.id;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(id, -32600, 'invalid request');
    if (id === undefined) return { status: 202, body: null, headers: responseHeaders };
    if (message.method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'artflow', version: '0.0.0' },
        instructions: INSTRUCTIONS,
      }, responseHeaders);
    }
    if (message.method === 'ping') return rpcResult(id, {}, responseHeaders);
    if (message.method === 'tools/list') {
      return rpcResult(id, { tools: visibleTools(session.mode).map(toolDescriptor) }, responseHeaders);
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
        return rpcError(id, -32602, 'tools/call requires name and arguments');
      }
      try {
        return rpcResult(id, await callTool(session, name, args), responseHeaders);
      } catch (error) {
        return rpcResult(id, { isError: true, content: [{ type: 'text', text: error.message || 'tool failed' }] }, responseHeaders);
      }
    }
    return rpcError(id, -32601, `method not found: ${message.method}`);
  };

  const readBody = request => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });

  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? '';
      const origin = request.headers.origin;
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        json(response, 403, { error: 'host is not local' });
        return;
      }
      if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        json(response, 403, { error: 'origin is not local' });
        return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/mcp') {
        json(response, 404, { error: 'not found' });
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(405, { allow: 'POST, DELETE' });
        response.end();
        return;
      }
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const credential = token ? verifyCredential(token) : null;
      if (!credential) {
        json(response, 401, { error: 'bearer credential required' });
        return;
      }
      sweep(Date.now());
      if (request.method === 'DELETE') {
        const sessionId = request.headers['mcp-session-id'];
        if (typeof sessionId === 'string') sessions.delete(sessionId);
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST, DELETE' });
        response.end();
        return;
      }
      const raw = await readBody(request);
      let message;
      try {
        message = JSON.parse(raw.toString('utf8') || 'null');
      } catch {
        json(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
      }
      let sessionId = typeof request.headers['mcp-session-id'] === 'string' ? request.headers['mcp-session-id'] : '';
      if (message.method === 'initialize') {
        if (sessions.size >= MAX_SESSIONS) {
          json(response, 429, { error: 'too many sessions' });
          return;
        }
        sessionId = crypto.randomUUID();
        sessions.set(sessionId, { id: sessionId, mode: credential.mode, credentialId: credential.id, seen: Date.now() });
      }
      const session = sessions.get(sessionId);
      if (!session || session.credentialId !== credential.id) {
        json(response, 404, { error: 'session not found' });
        return;
      }
      session.seen = Date.now();
      const outcome = await handleRpc(session, message, { 'mcp-session-id': sessionId });
      if (outcome.status === 202) {
        response.writeHead(202, outcome.headers);
        response.end();
        return;
      }
      json(response, outcome.status, outcome.body, outcome.headers);
    } catch (error) {
      const status = error.status || 500;
      if (!response.headersSent) json(response, status, { error: error.message || 'mcp failed' });
    }
  });

  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });

  return {
    listen,
    close: () => new Promise(resolve => {
      tools = [];
      sessions.clear();
      challenges.clear();
      idempotency.clear();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
    setCatalog: entries => {
      tools = validateCatalog(entries);
    },
  };
};

module.exports = {
  OUTPUT_LIMIT,
  createMcpServer,
  validateCatalog,
};
