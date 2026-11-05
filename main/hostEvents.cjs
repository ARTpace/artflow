/**
 * The `host.events` capability face, main-process half.
 *
 * Plugins cannot hold a reference to a host object, so they cannot be called
 * back through one. Subscriptions are therefore **two-sided**:
 *
 *   - the sandbox keeps the handler function (it can never leave that window);
 *   - the main process keeps only `pluginId -> subscriptionId -> event names`.
 *
 * When the host changes something it calls `emit()`; subscriptions are matched
 * and one JSON message per match is pushed into the sandbox, where the handler
 * is looked up by `subscriptionId`.
 *
 * Design rules (same as the other host namespaces):
 *  1. Payloads are rebuilt from scratch, never forwarded. A busy internal row
 *     (`hashPrefix`, absolute paths, usage internals) has no way out.
 *  2. Unknown event names cannot be subscribed to, so a typo fails loudly at
 *     subscription time instead of silently never firing.
 *  3. Only `emit` (host side) and `subscribe`/`unsubscribe` (plugin side) exist.
 *     Plugins cannot forge an event — there is no `emit` on the plugin face.
 */

const EVENT_NAMES = Object.freeze([
  /** An asset entered the library (import finished). */
  'asset.added',
  /** An asset display name changed. */
  'asset.renamed',
  /** An unreferenced asset record was reclaimed and its blob freed. */
  'asset.removed',
]);
const EVENT_NAME_SET = new Set(EVENT_NAMES);

const MAX_SUBSCRIPTIONS_PER_PLUGIN = 16;
const MAX_NAMES_PER_SUBSCRIPTION = 2;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_SUBSCRIPTION_ID = 120;
const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9._:+#-]{1,120}$/;
const MAX_ASSET_ID = 120;
const MAX_NAME_CHARS = 180;
const MAX_KIND_CHARS = 40;
const MAX_MIME_CHARS = 120;

/** `pluginId -> Map<subscriptionId, Set<eventName>>` */
const subscriptions = new Map();
/** Injected by the sandbox host: `(pluginId, { subscriptionId, name, payload }) => void` */
let emitter = null;

function setEmitter(next) {
  emitter = typeof next === 'function' ? next : null;
}

/**
 * Unbind the emitter while keeping the subscription table.
 * Used when the sandbox window goes away: a destroyed window must not stay on
 * the push path (every `emit` would otherwise keep targeting a dead
 * webContents). The replacement window binds its own emitter in createHost().
 */
function clearEmitter() {
  emitter = null;
}

/**
 * Host-generation teardown: subscription table **and** emitter, in one step.
 *
 * A crash-rebuild of the sandbox host invalidates both halves at the same
 * instant. Clearing only the subscriptions would leave the emitter pointing at
 * the destroyed window; clearing only the emitter would leave subscriptions
 * whose handlers live in a window that no longer exists (the new window has no
 * idea those subscriptionIds ever existed). So the two always travel together
 * here, never from the activation path — by the time `activateInstalledPlugins`
 * runs, createHost() has already bound the emitter of the *new* window and
 * `reset()` (table only) is the correct call.
 */
function resetForNewHost() {
  const count = reset();
  emitter = null;
  return count;
}

function fail(message) {
  throw new Error(message);
}

/** Closed list check — a manifest/SDK name that is not served cannot be subscribed to. */
function normalizeNames(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_NAMES_PER_SUBSCRIPTION) return null;
  const names = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !EVENT_NAME_SET.has(entry)) return null;
    if (!names.includes(entry)) names.push(entry);
  }
  return names;
}

function subscriptionCount() {
  let total = 0;
  for (const owned of subscriptions.values()) total += owned.size;
  return total;
}

/** Register one subscription. Throws on anything a plugin author should fix in source. */
function subscribe(pluginId, subscriptionId, names) {
  if (typeof pluginId !== 'string' || pluginId.length === 0) fail('plugin is not installed');
  if (typeof subscriptionId !== 'string' || subscriptionId.length > MAX_SUBSCRIPTION_ID || !SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
    fail('subscription id is invalid');
  }
  const normalized = normalizeNames(names);
  if (!normalized) fail(`event names must be 1 to ${MAX_NAMES_PER_SUBSCRIPTION} of: ${EVENT_NAMES.join(', ')}`);
  let owned = subscriptions.get(pluginId);
  if (!owned) {
    owned = new Map();
    subscriptions.set(pluginId, owned);
  }
  if (!owned.has(subscriptionId) && owned.size >= MAX_SUBSCRIPTIONS_PER_PLUGIN) {
    fail(`a plugin may hold at most ${MAX_SUBSCRIPTIONS_PER_PLUGIN} subscriptions`);
  }
  owned.set(subscriptionId, new Set(normalized));
  return { subscriptionId, events: normalized, active: owned.size };
}

/** Drop one subscription. Returns whether it existed (so `off()` is idempotent). */
function unsubscribe(pluginId, subscriptionId) {
  if (typeof subscriptionId !== 'string' || subscriptionId.length > MAX_SUBSCRIPTION_ID) fail('subscription id is invalid');
  const owned = subscriptions.get(pluginId);
  if (!owned || !owned.delete(subscriptionId)) return { subscriptionId, removed: false };
  if (owned.size === 0) subscriptions.delete(pluginId);
  return { subscriptionId, removed: true };
}

/** Drop every subscription of one plugin (uninstall / re-activation). */
function removePlugin(pluginId) {
  return subscriptions.delete(pluginId);
}

/** Drop everything — a new activation pass starts from an empty table. */
function reset() {
  const count = subscriptionCount();
  subscriptions.clear();
  return count;
}

function listEventNames() {
  return [...EVENT_NAMES];
}

/** Debug/admin view. Never exposed to plugins. */
function describeSubscriptions() {
  const rows = [];
  for (const [pluginId, owned] of subscriptions) {
    for (const [subscriptionId, names] of owned) rows.push({ pluginId, subscriptionId, events: [...names] });
  }
  return rows;
}

function sanitizeAssetRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'string' && value.id.length > 0 && value.id.length <= MAX_ASSET_ID ? value.id : null;
  if (!id) return null;
  const ref = { id };
  if (typeof value.name === 'string') ref.name = value.name.slice(0, MAX_NAME_CHARS);
  if (typeof value.kind === 'string') ref.kind = value.kind.slice(0, MAX_KIND_CHARS);
  if (typeof value.mimeType === 'string') ref.mimeType = value.mimeType.slice(0, MAX_MIME_CHARS);
  if (Number.isFinite(value.byteSize)) ref.byteSize = value.byteSize;
  return ref;
}

/** Rebuild the outgoing payload field by field — nothing is forwarded as-is. */
function sanitizePayload(name, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const asset = sanitizeAssetRef(source.asset);
  if (!asset) return null;
  const event = {
    type: name,
    asset,
    at: Number.isFinite(source.at) ? source.at : Date.now(),
  };
  if (name === 'asset.renamed' && typeof source.previousName === 'string') {
    event.previousName = source.previousName.slice(0, MAX_NAME_CHARS);
  }
  if (name === 'asset.removed' && Number.isFinite(source.freedBytes)) {
    event.freedBytes = source.freedBytes;
  }
  return event;
}

/**
 * Host side: announce a change. Returns how many subscriptions were notified
 * (0 means "nothing is listening", which is the common case).
 */
function emit(name, payload) {
  if (!EVENT_NAME_SET.has(name)) return 0;
  if (subscriptions.size === 0) return 0;
  const sanitized = sanitizePayload(name, payload);
  if (!sanitized) return 0;
  let encoded;
  try { encoded = JSON.stringify(sanitized); } catch { return 0; }
  if (!encoded || encoded.length > MAX_PAYLOAD_BYTES) return 0;
  let delivered = 0;
  for (const [pluginId, owned] of subscriptions) {
    for (const [subscriptionId, names] of owned) {
      if (!names.has(name)) continue;
      delivered += 1;
      try { emitter?.(pluginId, { subscriptionId, name, payload: sanitized }); } catch { /* a dead window must not break the host */ }
    }
  }
  return delivered;
}

module.exports = {
  setEmitter,
  clearEmitter,
  resetForNewHost,
  subscribe,
  unsubscribe,
  removePlugin,
  reset,
  emit,
  listEventNames,
  describeSubscriptions,
  EVENT_NAMES,
  MAX_SUBSCRIPTIONS_PER_PLUGIN,
  MAX_NAMES_PER_SUBSCRIPTION,
};
