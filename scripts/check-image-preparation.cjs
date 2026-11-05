// Deterministic behavior tests. No browser, actual images or wall-clock sleeps required.
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createImagePreparationQueue, prepareBrowserImage } = require('../utils/image-preparation-queue.ts');
const {
  rememberLastDisplayedSource,
  peekLastDisplayedSource,
} = require('../utils/usePreparedImageSource.ts');
const microtasks = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function harness(overrides = {}) {
  let nextFrame = 0;
  const frames = new Map(), loads = [], releases = [];
  const queue = createImagePreparationQueue({
    maxConcurrent: 2, maxCommitsPerFrame: 2, maxPrepared: 4,
    maxCacheBytes: 4096, maxCacheEntries: 3,
    requestFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id),
    load: (src, signal) => new Promise((resolve, reject) => loads.push({
      src, signal, done: false,
      resolve: (bytes = 1024) => resolve({ bytes, release: () => releases.push(src) }), reject,
    })),
    ...overrides,
  });
  return {
    queue, frames, loads, releases,
    async frame() {
      const before = queue.getStats().delivered;
      const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn());
      assert.ok(queue.getStats().delivered - before <= (overrides.maxCommitsPerFrame ?? 2), 'consumer notifications per frame are bounded');
      await microtasks();
    },
    async resolveLoads(bytes = 1024) {
      for (const load of loads) if (!load.done) { load.done = true; load.resolve(bytes); }
      await microtasks();
    },
    async drain() {
      for (let i = 0; i < 2000; i++) {
        await microtasks();
        assert.ok(queue.getStats().active <= 2, 'loader concurrency');
        assert.ok(queue.getStats().active + queue.getStats().ready <= 4, 'prepared-result backpressure');
        await this.resolveLoads(); await this.frame();
        if (!queue.getStats().waitingConsumers && !queue.getStats().active) return;
      }
      throw new Error('queue failed to settle');
    },
  };
}

(async () => {
  // Equal-width fixture: all 300 consumers request a new source simultaneously.
  {
    const h = harness(); const delivered = [];
    for (let i = 0; i < 300; i++) h.queue.request({ src: 'image-' + i, tier: 'standard' }, result => { assert.ok(result.ok); delivered.push(i); });
    await microtasks(); assert.equal(h.loads.length, 2);
    await h.drain();
    assert.equal(delivered.length, 300);
    assert.equal(new Set(delivered).size, 300);
    assert.ok(h.queue.getStats().cacheBytes <= 4096);
    assert.ok(h.queue.getStats().cached <= 3);
    h.queue.dispose(); assert.equal(h.releases.length, 300);
  }
  // Dedupe loaders, but not the per-consumer notification budget (including cache hits).
  {
    const h = harness(); let calls = 0;
    for (let i = 0; i < 20; i++) h.queue.request({ src: 'shared', tier: 'standard' }, () => calls++);
    await h.drain(); assert.equal(calls, 20); assert.equal(h.loads.length, 1);
    h.queue.request({ src: 'shared', tier: 'standard' }, () => calls++);
    assert.equal(calls, 20, 'cache hit must not bypass the frame queue');
    await h.frame(); assert.equal(calls, 21); assert.equal(h.loads.length, 1);
    assert.equal(h.queue.getStats().cacheHits, 1); h.queue.dispose();
  }
  // Last subscriber cancels: pending work disappears; active permits remain until settlement.
  {
    const h = harness(); let stale = 0;
    const cancels = Array.from({ length: 6 }, (_, i) => h.queue.request({ src: 'cancel-' + i, tier: 'standard' }, () => stale++));
    await microtasks(); cancels.forEach(cancel => { cancel(); cancel(); });
    assert.equal(h.queue.getStats().waitingConsumers, 0);
    assert.equal(h.queue.getStats().active, 2);
    assert.ok(h.loads.every(load => load.signal.aborted));
    await h.resolveLoads(); await h.frame();
    assert.equal(stale, 0); assert.equal(h.loads.length, 2); assert.equal(h.releases.length, 2);
    assert.equal(h.queue.getStats().reservedBytes, 0); h.queue.dispose();
  }
  // Cancelling one of several subscribers does not abort the shared loader.
  {
    const h = harness(); let calls = 0;
    const cancel = h.queue.request({ src: 'shared', tier: 'standard' }, () => { throw new Error('cancelled subscriber called'); });
    h.queue.request({ src: 'shared', tier: 'standard' }, () => calls++);
    await microtasks(); cancel(); assert.equal(h.loads[0].signal.aborted, false);
    await h.drain(); assert.equal(calls, 1); h.queue.dispose();
  }
  // Same URL re-requested while an old cancelled load completes must retain the new job.
  {
    const h = harness(); let old = 0, current = 0;
    const cancel = h.queue.request({ src: 'same', tier: 'original' }, () => old++);
    await microtasks(); cancel();
    h.queue.request({ src: 'same', tier: 'original' }, () => current++);
    await h.drain(); assert.equal(old, 0); assert.equal(current, 1); assert.equal(h.loads.length, 2);
    h.queue.dispose(); assert.equal(h.releases.length, 2);
  }
  // Error settles exactly once; other jobs proceed; one bad observer cannot stall delivery.
  {
    const h = harness(); const results = [];
    h.queue.request({ src: 'bad', tier: 'standard' }, r => results.push(r));
    h.queue.request({ src: 'good', tier: 'standard' }, () => { throw new Error('observer'); });
    h.queue.request({ src: 'after', tier: 'standard' }, r => results.push(r));
    await microtasks(); h.loads[0].done = true; h.loads[0].reject(new Error('bad source'));
    await h.drain(); assert.equal(results.length, 2); assert.equal(results[0].ok, false); assert.equal(results[1].ok, true);
    assert.equal(h.queue.getStats().failed, 1); h.queue.dispose();
  }
  // Estimated byte permits cap large requests even when count slots are available.
  {
    const h = harness({ maxEstimatedWorkingBytes: 32 * 1024 * 1024 });
    h.queue.request({ src: 'large-a', tier: 'original' }, () => {});
    h.queue.request({ src: 'large-b', tier: 'original' }, () => {});
    await microtasks(); assert.equal(h.loads.length, 1); await h.drain(); h.queue.dispose();
  }
  // Stop decoding ahead when a shared URL has many waiting consumers.
  {
    const h = harness();
    for (let i = 0; i < 20; i++) h.queue.request({ src: 'shared', tier: 'standard' }, () => {});
    for (let i = 0; i < 20; i++) h.queue.request({ src: 'unique-' + i, tier: 'standard' }, () => {});
    for (let i = 0; i < 5; i++) { await microtasks(); await h.resolveLoads(); }
    assert.ok(h.loads.length <= 4, 'decoded results are bounded before the UI drains them');
    await h.drain(); h.queue.dispose();
  }
  // ready-before-frame cancellation suppresses notifications; dispose also suppresses late loaders.
  {
    const h = harness(); let calls = 0;
    const cancel = h.queue.request({ src: 'ready', tier: 'standard' }, () => calls++);
    await microtasks(); await h.resolveLoads(); cancel(); await h.frame(); assert.equal(calls, 0);
    h.queue.request({ src: 'late', tier: 'standard' }, () => calls++);
    await microtasks(); h.queue.dispose(); h.queue.dispose(); await h.resolveLoads(); await h.frame();
    assert.equal(calls, 0); assert.equal(h.queue.getStats().active, 0); assert.equal(h.queue.getStats().cacheBytes, 0);
  }
  // Browser loader lifetime checks with a fake Image and a controllable timeout.
  {
    const originalImage = globalThis.Image, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    const images = [], timers = new Map(); let timerId = 0;
    class FakeImage {
      naturalWidth = 32; naturalHeight = 16; src = ''; onload = null; onerror = null;
      constructor() { images.push(this); }
      decode() { return Promise.resolve(); }
      removeAttribute(name) { if (name === 'src') this.src = ''; }
    }
    globalThis.Image = FakeImage;
    globalThis.setTimeout = fn => { const id = ++timerId; timers.set(id, fn); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    try {
      const controller = new AbortController();
      const p = prepareBrowserImage('real', controller.signal); images.at(-1).onload();
      const resource = await p; assert.equal(resource.bytes, 32 * 16 * 4); assert.equal(timers.size, 0);
      resource.release(); assert.equal(images.at(-1).src, '');
      const c = new AbortController(); const aborted = prepareBrowserImage('abort', c.signal); c.abort();
      await assert.rejects(aborted); assert.equal(timers.size, 0);
      const timeout = prepareBrowserImage('timeout', new AbortController().signal);
      [...timers.values()][0](); await assert.rejects(timeout); assert.equal(timers.size, 0);
      const error = prepareBrowserImage('error', new AbortController().signal); images.at(-1).onerror();
      await assert.rejects(error); assert.equal(timers.size, 0);
      const decodeError = prepareBrowserImage('decode-error', new AbortController().signal);
      images.at(-1).decode = () => Promise.reject(new Error('decode')); images.at(-1).onload();
      await assert.rejects(decodeError); assert.equal(timers.size, 0);
    } finally {
      globalThis.Image = originalImage; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
    }
  }
  // 裁剪重挂记忆：卸载前显示什么，重挂必须从什么开始（否则边缘闪低清/空窗）。
  {
    rememberLastDisplayedSource('m-1', 'asset-1', { src: 'std-1', tier: 'standard' });
    assert.deepEqual(peekLastDisplayedSource('m-1', 'asset-1'), { src: 'std-1', tier: 'standard' });
    // 资产被替换必须作废旧记忆。
    assert.equal(peekLastDisplayedSource('m-1', 'asset-2'), null);
    // 刷新 recency：覆盖写后读到的必须是新值。
    rememberLastDisplayedSource('m-1', 'asset-1', { src: 'med-1', tier: 'medium' });
    assert.deepEqual(peekLastDisplayedSource('m-1', 'asset-1'), { src: 'med-1', tier: 'medium' });
    // 容量有界：超出后最旧条目被淘汰。
    const capacityProbe = 'm-cap-' + Math.random();
    rememberLastDisplayedSource(capacityProbe, 'a', { src: 'x', tier: 'thumbnail' });
    for (let i = 0; i < 2100; i++) rememberLastDisplayedSource('m-flood-' + i, 'a', { src: 'y', tier: 'thumbnail' });
    assert.equal(peekLastDisplayedSource(capacityProbe, 'a'), null, '最旧条目必须被淘汰');
    assert.ok(peekLastDisplayedSource('m-flood-2099', 'a'), '最新条目必须存活');
  }
  // hook 源码契约：初始化读记忆、成功提交写记忆（缺一处重挂就会退回 fallback）。
  {
    const hookSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'usePreparedImageSource.ts'), 'utf8');
    assert.match(hookSource, /useState<SourceState>\(\(\) => \{[\s\S]*peekLastDisplayedSource/,
      '初始 state 必须优先读取"最后显示源"记忆');
    assert.match(hookSource, /result\.ok[\s\S]{0,200}rememberLastDisplayedSource/,
      '成功提交必须写回"最后显示源"记忆');
    assert.match(hookSource, /cached\.baseSrc === baseSrc/,
      '记忆读取必须校验资产身份，禁止把旧资产像素交给新资产');
  }
  console.log('image preparation checks: ok (300 simultaneous targets, bounded concurrency/backpressure/notifications/cache, dedupe, cancellation, stale completion, errors, timeout, cleanup, remount memory)');
})().catch(error => { console.error(error); process.exitCode = 1; });
