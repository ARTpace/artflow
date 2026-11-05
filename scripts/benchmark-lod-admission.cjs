/**
 * benchmark-lod-admission.cjs —— 量化高清图准入（LRU）在"图片变多"时的行为。
 *
 * 背景：useImageLOD 在 zoom 跨过 DETAIL_ZOOM_THRESHOLD 时会一次性把**所有可见图片**
 * 设为 eligible，180ms 后逐个 request 准入。capacity 只有 50，
 * 于是图片数 > 50 时必然出现"准入 → 驱逐 → 再准入"的连锁。
 *
 * 本脚本用真实的 ImageLRUCache 测量两件事：
 *   1. listener 调用总次数（当前实现是"每次 request 广播全部订阅者"）。
 *   2. 真实状态翻转次数（= 需要 React 重渲染的次数）。
 *
 * 运行：node scripts/benchmark-lod-admission.cjs
 *       ARTFLOW_BENCH_IMAGES=500 node scripts/benchmark-lod-admission.cjs
 */
require('./register-typescript.cjs');

const { performance } = require('node:perf_hooks');
const { ImageLRUCache, IMAGE_LOD_CONSTANTS, shouldAdmitFullResolution } = require('../utils/imageProxy.ts');

const imageCount = Number.parseInt(process.env.ARTFLOW_BENCH_IMAGES || '300', 10);
if (!Number.isInteger(imageCount) || imageCount < 1) {
  throw new Error('ARTFLOW_BENCH_IMAGES must be a positive integer');
}
const capacity = IMAGE_LOD_CONSTANTS.FULL_RES_LRU_CAPACITY;

/**
 * 旧链路：每个图片元素订阅整体广播，每次 request 都会把全部订阅者叫醒一遍。
 * 保留在此仅作对照基线（生产代码已不再走这条通道）。
 */
const measureBroadcast = (cache, ids) => {
  const admitted = new Map(ids.map(id => [id, false]));
  let listenerCalls = 0;
  let realStateChanges = 0;
  const unsubscribes = ids.map(id => cache.subscribe((_evictedId, activeIds) => {
    listenerCalls += 1;
    const next = activeIds.has(id);
    if (next !== admitted.get(id)) {
      admitted.set(id, next);
      realStateChanges += 1; // 这一步在组件里等价于一次 setState
    }
  }));

  const startedAt = performance.now();
  for (const id of ids) cache.request(id);
  const elapsedMs = performance.now() - startedAt;

  for (const unsubscribe of unsubscribes) unsubscribe();
  return { listenerCalls, realStateChanges, elapsedMs, retained: cache.size() };
};

/** 新链路：每个元素只订阅自己的 id，只有自身准入状态变化才会被唤醒。 */
const measureTargeted = (cache, ids) => {
  const admitted = new Map(ids.map(id => [id, false]));
  let listenerCalls = 0;
  let realStateChanges = 0;
  const unsubscribes = ids.map(id => cache.subscribeAdmission(id, next => {
    listenerCalls += 1;
    if (next !== admitted.get(id)) {
      admitted.set(id, next);
      realStateChanges += 1;
    }
  }));

  const startedAt = performance.now();
  for (const id of ids) cache.request(id);
  const elapsedMs = performance.now() - startedAt;

  for (const unsubscribe of unsubscribes) unsubscribe();
  return { listenerCalls, realStateChanges, elapsedMs, retained: cache.size() };
};

const ids = Array.from({ length: imageCount }, (_, index) => `image-${index}`);

const before = measureBroadcast(new ImageLRUCache(capacity), ids);
const after = measureTargeted(new ImageLRUCache(capacity), ids);

console.log('\n=== 高清图准入：一次批量准入（跨过阈值时） ===\n');
console.log(`图片数 ${imageCount}，LRU 容量 ${capacity}\n`);
console.log('                      listener 调用      真实状态变化(≈重渲染)   耗时');
console.log(`  [改前] 广播全体   ${String(before.listenerCalls).padStart(12)}   ${String(before.realStateChanges).padStart(16)}   ${before.elapsedMs.toFixed(1).padStart(6)} ms`);
console.log(`  [改后] 定向通知   ${String(after.listenerCalls).padStart(12)}   ${String(after.realStateChanges).padStart(16)}   ${after.elapsedMs.toFixed(1).padStart(6)} ms`);
console.log('');
console.log(`  调用量降低        ${(before.listenerCalls / Math.max(1, after.listenerCalls)).toFixed(0)}×`);
console.log(`  增长量级          O(图片数²) = ${(imageCount * imageCount).toLocaleString()}  →  O(图片数) ≤ ${(imageCount * 2).toLocaleString()}`);

// ---- 准入数量：按"屏幕像素"过滤后，真正需要原图的图片有多少
console.log('\n=== 准入范围：按缩放级别 vs 按屏幕像素 ===\n');
const scene = Array.from({ length: imageCount }, (_, index) => (
  index % 10 < 3
    ? { width: 1200, height: 900 }   // 大图
    : { width: 300, height: 200 }    // 小卡片
));
for (const zoom of [1.5, 2, 4]) {
  const byZoom = scene.length; // 旧语义：zoom>1 即全部 eligible
  const byPixels = scene.filter(size => shouldAdmitFullResolution({
    hasOriginal: true, width: size.width, height: size.height, zoom,
  })).length;
  console.log(`  zoom=${String(zoom).padEnd(4)} 按缩放级别 ${String(byZoom).padStart(4)} 张  →  按屏幕像素 ${String(byPixels).padStart(4)} 张  (容量 ${capacity})`);
}

// 增长趋势：改后通知量与图片数同阶
console.log('\n=== 改后增长趋势（定向通知）===');
for (const n of [50, 100, 200, 400, 800]) {
  const list = Array.from({ length: n }, (_, i) => `t-${i}`);
  const beforeRun = measureBroadcast(new ImageLRUCache(capacity), list);
  const afterRun = measureTargeted(new ImageLRUCache(capacity), list);
  console.log(`  ${String(n).padStart(4)} 张 : 改前 ${String(beforeRun.listenerCalls).padStart(10)} 次 → 改后 ${String(afterRun.listenerCalls).padStart(6)} 次调用, ${String(afterRun.realStateChanges).padStart(4)} 次状态变化`);
}
console.log('');

const improved = after.listenerCalls <= imageCount * 2 && before.listenerCalls > imageCount * 2;
console.log(improved
  ? '结论: 定向通知把一次批量准入从平方级广播降到线性，且同一批变化只提交一轮。\n'
  : '结论: 未观测到预期的改善，请检查实现。\n');
