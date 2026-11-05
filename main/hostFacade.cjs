/**
 * The `host` capability face — a controlled object graph for sandboxed plugins.
 *
 * Design rules (see docs/插件生态优化方案.md §3):
 *  1. **Facades, not references.** A plugin never receives `board.elements`, the
 *     storage repository or any internal object. It can only call the methods
 *     listed in HOST_NAMESPACES and read the plain JSON they return.
 *  2. **Permission first.** Every method maps to a permission string. A plugin
 *     that did not declare it in `permissions.host` is rejected before the
 *     implementation runs — the facade is the only path in, so enforcement is
 *     real (unlike Obsidian's "we cannot reliably restrict plugins" model).
 *  3. **Version gate.** Each namespace carries `since`; the same value is
 *     mirrored in `types/artflow-plugin.d.ts` and in the SDK guide.
 *  4. **Read first.** `assets.read` covers reads, `assets.write` covers writes.
 *
 * Plugin source is never evaluated here. Only structured JSON crosses this line.
 */

const hostEvents = require('./hostEvents.cjs');

const MAX_HOST_REQUEST_BYTES = 16 * 1024;
const MAX_ARG_COUNT = 4;
const MAX_LIST_LIMIT = 200;
const MAX_LIST_SCAN = 1000;
const MAX_RENAME_ITEMS = 40;
const MAX_ASSET_NAME = 180;

/** The authoritative catalogue. `since` is the host API version that introduced it. */
const HOST_NAMESPACES = Object.freeze({
  assets: Object.freeze({
    since: '1.0.0',
    methods: Object.freeze({
      list: Object.freeze({ permission: 'assets.read', arity: 1 }),
      get: Object.freeze({ permission: 'assets.read', arity: 1 }),
      rename: Object.freeze({ permission: 'assets.write', arity: 1 }),
    }),
  }),
  /**
   * Event subscriptions. The handler itself never crosses the process boundary —
   * see `hostEvents.cjs`. `subscribe` is the *only* way to receive host changes,
   * which is why it is the one permission that gates all three methods.
   */
  events: Object.freeze({
    since: '1.1.0',
    methods: Object.freeze({
      list: Object.freeze({ permission: 'events.subscribe', arity: 0 }),
      subscribe: Object.freeze({ permission: 'events.subscribe', arity: 1 }),
      unsubscribe: Object.freeze({ permission: 'events.subscribe', arity: 1 }),
    }),
  }),
});

const HOST_PERMISSIONS = Object.freeze([...new Set(
  Object.values(HOST_NAMESPACES).flatMap(namespace => Object.values(namespace.methods).map(entry => entry.permission)),
)].sort());

/** Namespaces the SDK already documents but the host does not serve yet. */
const HOST_PENDING_NAMESPACES = Object.freeze(['board', 'collections', 'ui']);

function fail(message) {
  throw new Error(message);
}

function normalizeArgs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('host arguments must be an array');
  if (value.length > MAX_ARG_COUNT) fail(`host calls take at most ${MAX_ARG_COUNT} arguments`);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('host arguments must be plain data'); }
  if (!encoded) fail('host arguments are invalid');
  if (encoded.length > MAX_HOST_REQUEST_BYTES) fail('host arguments are too large');
  return JSON.parse(encoded);
}

function clampInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

async function requireStorage(services) {
  const storage = services && services.storage;
  if (!storage) fail('asset storage is unavailable');
  return storage;
}

/** Strip internal entropy (`hashPrefix`, paths) — a plugin only gets what it can act on. */
function toAssetRef(item) {
  return {
    id: String(item.id),
    name: String(item.originalName ?? ''),
    kind: String(item.kind ?? ''),
    mimeType: String(item.mimeType ?? ''),
    byteSize: Number.isFinite(item.byteSize) ? item.byteSize : 0,
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
    usage: typeof item.usage === 'string' ? item.usage : 'none',
  };
}

async function scanInventory(storage, options) {
  const items = [];
  const limit = options.limit;
  for (let offset = 0; offset < MAX_LIST_SCAN; offset += MAX_LIST_LIMIT) {
    const page = await storage.listAssetInventory({ offset, limit: MAX_LIST_LIMIT, unreferencedOnly: options.unreferencedOnly });
    const batch = Array.isArray(page && page.items) ? page.items : [];
    items.push(...batch);
    if (batch.length < MAX_LIST_LIMIT) break;
    if (items.length >= MAX_LIST_SCAN) break;
  }
  return items.slice(options.offset, options.offset + limit);
}

const ASSETS_IMPLEMENTATION = Object.freeze({
  async list(_plugin, services, args) {
    const raw = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {};
    const storage = await requireStorage(services);
    const items = await scanInventory(storage, {
      offset: clampInteger(raw.offset, 0, 0, MAX_LIST_SCAN),
      limit: clampInteger(raw.limit, 50, 1, MAX_LIST_LIMIT),
      unreferencedOnly: raw.unreferencedOnly === true,
    });
    return { assets: items.map(toAssetRef) };
  },
  async get(_plugin, services, args) {
    const id = args[0];
    if (typeof id !== 'string' || id.length === 0 || id.length > 120) fail('asset id is invalid');
    const storage = await requireStorage(services);
    const items = await scanInventory(storage, { offset: 0, limit: MAX_LIST_SCAN, unreferencedOnly: false });
    const found = items.find(item => item.id === id);
    return { asset: found ? toAssetRef(found) : null };
  },
  async rename(_plugin, services, args) {
    const input = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {};
    const changes = input.changes;
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_RENAME_ITEMS) {
      fail(`rename requires 1 to ${MAX_RENAME_ITEMS} assets`);
    }
    const normalized = changes.map(change => {
      if (!change || typeof change !== 'object') fail('rename entries must be objects');
      const id = change.id;
      const name = typeof change.name === 'string' ? change.name.trim() : '';
      if (typeof id !== 'string' || id.length === 0 || id.length > 120) fail('asset id is invalid');
      if (name.length === 0 || name.length > MAX_ASSET_NAME) fail(`asset name must be 1 to ${MAX_ASSET_NAME} characters`);
      return { id, name };
    });
    const storage = await requireStorage(services);
    const result = await storage.renameAssetNames({ changes: normalized });
    return {
      renamed: Array.isArray(result && result.renamed) ? result.renamed : [],
      missing: Array.isArray(result && result.missing) ? result.missing : [],
    };
  },
});

const IMPLEMENTATIONS = Object.freeze({
  assets: ASSETS_IMPLEMENTATION,
  /**
   * The subscription table lives in `hostEvents.cjs`, not in the sandbox window:
   * a handler stays in the sandbox, the host keeps only the subscription id.
   * `plugin.id` is the identity used for the table (a plugin cannot subscribe
   * on another plugin's behalf).
   */
  events: Object.freeze({
    async list() {
      return { events: hostEvents.listEventNames() };
    },
    async subscribe(plugin, _services, args) {
      const raw = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {};
      return hostEvents.subscribe(plugin.id, raw.subscriptionId, raw.names);
    },
    async unsubscribe(plugin, _services, args) {
      const raw = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {};
      return hostEvents.unsubscribe(plugin.id, raw.subscriptionId);
    },
  }),
});

/**
 * Dispatch one `host` call from the sandbox.
 *
 * `plugin` is the installed package description produced by `listSandboxedPackages`
 * (it carries the parsed `permissions`). `services` is injected by the main process.
 */
async function performHostCall(plugin, services, request) {
  if (!request || typeof request !== 'object') return { ok: false, message: 'host request is invalid' };
  const namespace = request.namespace;
  const namespaceSpec = typeof namespace === 'string' && Object.prototype.hasOwnProperty.call(HOST_NAMESPACES, namespace)
    ? HOST_NAMESPACES[namespace]
    : undefined;
  if (!namespaceSpec) {
    if (typeof namespace === 'string' && HOST_PENDING_NAMESPACES.includes(namespace)) {
      return { ok: false, message: `host namespace "${namespace}" is not available yet` };
    }
    return { ok: false, message: `unknown host namespace: ${String(namespace)}` };
  }
  const method = request.method;
  const entry = typeof method === 'string' && Object.prototype.hasOwnProperty.call(namespaceSpec.methods, method)
    ? namespaceSpec.methods[method]
    : undefined;
  if (!entry) return { ok: false, message: `unknown host method: ${String(namespace)}.${String(method)}` };

  const granted = Array.isArray(plugin && plugin.permissions && plugin.permissions.host) ? plugin.permissions.host : [];
  if (!granted.includes(entry.permission)) {
    return { ok: false, message: `permission denied: ${entry.permission} must be declared in manifest permissions.host` };
  }
  let args;
  try {
    args = normalizeArgs(request.args);
    if (args.length > entry.arity) fail(`host method ${namespace}.${method} takes at most ${entry.arity} argument(s)`);
  } catch (error) {
    return { ok: false, message: error.message };
  }
  try {
    return { ok: true, result: await IMPLEMENTATIONS[namespace][method](plugin, services, args) };
  } catch (error) {
    return { ok: false, message: error?.message || 'host call failed' };
  }
}

module.exports = {
  performHostCall,
  HOST_NAMESPACES,
  HOST_PERMISSIONS,
  HOST_PENDING_NAMESPACES,
  MAX_RENAME_ITEMS,
};
