// Direct original-admission budget checks. No browser or real image decoding.
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const { ImageLRUCache, IMAGE_LOD_CONSTANTS, estimateOriginalDecodedBytes, resolveImageLODSource } = require('../utils/imageProxy.ts');
const MiB = 1024 * 1024;
assert.equal(IMAGE_LOD_CONSTANTS.FULL_RES_DECODED_BYTE_BUDGET, 128 * MiB);
assert.equal(estimateOriginalDecodedBytes(6000, 4000), 96000000);
for (const dims of [[0, 10], [-1, 10], [NaN, 10], [Infinity, 10], [1.5, 2], [Number.MAX_SAFE_INTEGER, 10]]) {
  assert.equal(estimateOriginalDecodedBytes(...dims), Infinity);
}
{
  const cache = new ImageLRUCache();
  assert.equal(cache.getCapacity(), 50);
  assert.equal(cache.getByteBudget(), 128 * MiB);
  assert.equal(cache.request('large', 96 * MiB, true), true);
  assert.equal(cache.request('oversize', 129 * MiB, true), false);
  assert.equal(cache.request('unknown', Infinity, true), false);
  assert.equal(cache.request('second', 40 * MiB, true), false);
  assert.deepEqual(cache.keys(), ['large'], 'rejection cannot evict current visible demand');
  assert.equal(cache.getEstimatedBytes(), 96 * MiB);
  assert.equal(resolveImageLODSource({ width: 2000, height: 1000, zoom: 2, href: 'proxy', originalHref: 'oversize', isHighResAdmitted: cache.has('oversize') }).src, 'proxy');
  assert.equal(cache.release('large'), true);
  assert.equal(cache.release('large'), false, 'double release cannot underflow bytes');
  assert.equal(cache.getEstimatedBytes(), 0);
  assert.equal(cache.request('second', 40 * MiB, true), true);
  cache.clear(); assert.equal(cache.getEstimatedBytes(), 0);
  assert.equal(cache.request('second', 128 * MiB, true), true, 'exact budget boundary');
  cache.evict('second'); assert.equal(cache.getEstimatedBytes(), 0);
}
{
  const cache = new ImageLRUCache(50, 100);
  const notifications = [];
  cache.subscribeAdmission('a', value => notifications.push(['a', value]));
  cache.subscribeAdmission('b', value => notifications.push(['b', value]));
  cache.request('a', 30); cache.request('b', 30); cache.request('c', 30);
  cache.request('a'); // legacy touch must preserve byte accounting and LRU order
  assert.equal(cache.getEstimatedBytes(), 90);
  cache.request('d', 65);
  assert.deepEqual(cache.keys(), ['a', 'd'], 'byte pressure can evict multiple oldest entries');
  assert.equal(cache.getEstimatedBytes(), 95);
  assert.deepEqual(notifications, [['a', true], ['b', true], ['b', false]]);
  assert.equal(cache.request('a', 200), false, 'invalid replacement is atomic');
  assert.equal(cache.getEstimatedBytes(), 95);
  assert.equal(cache.request('a', 10), true);
  assert.equal(cache.getEstimatedBytes(), 75, 'same-id charge update must not double count');
}
{
  const cache = new ImageLRUCache(2, 100);
  cache.request('a', 40, true); cache.request('b', 40, true);
  let changes = 0;
  for (const id of ['a', 'b', 'c']) cache.subscribeAdmission(id, () => changes++);
  for (let i = 0; i < 300; i++) {
    assert.equal(cache.request('c', 20, true), false, 'count cap also protects current leases');
    cache.request('a', 40, true); cache.request('b', 40, true);
  }
  assert.equal(changes, 0, 'stable visible demand must not enter admission/eviction loop');
  assert.equal(cache.request('a', 70, true), false, 'failed growth cannot evict b or alter a charge');
  assert.equal(cache.getEstimatedBytes(), 80);
  cache.release('a'); assert.equal(cache.request('c', 20, true), true);
  cache.clear(); assert.equal(cache.request('a', 100, true), true);
}
(async () => {
  // Execute the real hook/scheduler with deterministic React effects, timers and Image.
  // No test-only production exports and no wall-clock waits.
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  const effects = [], states = [], timers = new Map(), probes = [];
  let cursor = 0, timerId = 0, current;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect(fn, deps) {
      const i = cursor++, previous = effects[i];
      if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
        if (previous?.cleanup) previous.cleanup();
        effects[i] = { deps, fn, pending: true };
      }
    },
    useMemo(fn) { cursor++; return fn(); },
  };
  const sandbox = {
    exports: {}, require: name => { assert.equal(name, 'react'); return react; }, AbortController, console,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    Image: class {
      constructor() { probes.push(this); }
      removeAttribute() { this.released = true; }
    },
  };
  const source = fs.readFileSync(require.resolve('../utils/imageProxy.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  const api = sandbox.exports;
  const render = (src = 'first', extra = {}) => {
    cursor = 0;
    current = api.useImageLOD('hook-image', { width: 2000, height: 1000, zoom: 2, href: 'proxy', originalHref: src, originalPixelWidth: 6000, originalPixelHeight: 4000, ...extra });
    for (const effect of effects) if (effect?.pending) { effect.pending = false; effect.cleanup = effect.fn(); }
    return current;
  };
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const flush = () => {
    for (const [id, timer] of timers) if (timer.ms === IMAGE_LOD_CONSTANTS.HIGH_RES_IDLE_DELAY_MS) {
      timers.delete(id); timer.fn();
    }
  };
  assert.equal(render().src, 'proxy'); flush();
  assert.equal(probes.length, 0, 'budget admission must not decode or probe originals');
  assert.equal(render().src, 'first');
  assert.equal(api.globalImageLRUCache.getEstimatedBytes(), 96000000);
  assert.equal(render('replacement').src, 'proxy', 'old source admission cannot authorize replacement during render');
  assert.equal(api.globalImageLRUCache.getEstimatedBytes(), 0, 'replacement releases old charge');
  render('replacement', { originalPixelWidth: 10000, originalPixelHeight: 10000 }); flush();
  assert.equal(render('replacement', { originalPixelWidth: 10000, originalPixelHeight: 10000 }).src, 'proxy', 'oversized original remains proxy');
  render('legacy', { originalPixelWidth: undefined, originalPixelHeight: undefined }); flush();
  assert.equal(render('legacy', { originalPixelWidth: undefined, originalPixelHeight: undefined }).src, 'proxy', 'unknown dimensions must not trigger speculative original load');
  assert.equal(probes.length, 0);
  render('cancelled');
  for (const effect of effects) effect?.cleanup?.();
  await tick();
  assert.equal(api.globalImageLRUCache.size(), 0); assert.equal(timers.size, 0);
  console.log('original image budget checks: ok (128MiB + count, natural dimensions, retained demand, atomic rejection, release, zero speculative loads, real hook replacement/cancellation)');
})().catch(error => { console.error(error); process.exitCode = 1; });
