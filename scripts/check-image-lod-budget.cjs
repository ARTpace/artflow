/**
 * check-image-lod-budget.cjs —— 锁住"图片变多时的原图准入预算"语义。
 *
 * 背景（本次修复的病灶）：
 * 旧实现一边用 `zoom > 1` 把所有可见图片判为"需要原图"，一边在每次 request 时
 * 广播**全部订阅者**。图片数超过 LRU 容量（50）后，一次批量准入就是
 * O(图片数 × 订阅者数) 的调用 + 几百次独立 setState（= 几百次 React 重渲染）。
 * 300 张图实测 90,000 次调用、550 次重渲染。
 *
 * 本脚本断言三件事：
 *   A. 准入按"屏幕像素需求"判定，不再按缩放级别（小图放大也不抢配额）。
 *   B. 通知是定向的（每个 id 只被与自己相关的准入/驱逐唤醒），复杂度 O(1) 而非 O(N)。
 *   C. 源码接线正确（hook 走定向订阅；小地图不再逐帧订阅 live）。
 *
 * 运行：node scripts/check-image-lod-budget.cjs
 */
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  IMAGE_LOD_CONSTANTS,
  ImageLRUCache,
  shouldAdmitFullResolution,
  isFullResolutionWantedAtZoom,
  exceedsFullResolutionDisplayBudget,
  getImageDisplayLongestEdge,
} = require('../utils/imageProxy.ts');

const THRESHOLD = IMAGE_LOD_CONSTANTS.FULL_RES_DISPLAY_PX_THRESHOLD;
assert.equal(THRESHOLD, 1024, '原图准入门槛必须与标准代理长边（1024）一致');

// ---------------------------------------------------------------- A. 准入按屏幕像素
// 屏幕最长边 = max(世界宽, 世界高) × zoom
assert.equal(getImageDisplayLongestEdge(400, 300, 2), 800);
assert.equal(getImageDisplayLongestEdge(0, 300, 2), 600);
assert.equal(getImageDisplayLongestEdge(400, 300, 0), 0, '非法缩放应回落 0 而不是 NaN');

// 小图放大：屏幕 600px < 1024 → 不该去抢配额（旧实现会抢）
assert.equal(
  shouldAdmitFullResolution({ hasOriginal: true, width: 300, height: 200, zoom: 2 }),
  false,
  '小卡片放大到 600px 屏幕尺寸时不应该准入原图',
);
assert.equal(isFullResolutionWantedAtZoom(300, 200, 2), false);
assert.equal(exceedsFullResolutionDisplayBudget(300, 200, 2), false);

// 大图放大：屏幕 2000px > 1024 → 需要原图
assert.equal(
  shouldAdmitFullResolution({ hasOriginal: true, width: 1000, height: 800, zoom: 2 }),
  true,
  '屏幕尺寸超过代理分辨率时必须准入原图',
);
assert.equal(isFullResolutionWantedAtZoom(1000, 800, 2), true);

// 边界（细节档内做像素判定）：屏幕 1023px 够用，1024.5px 才需要原图
assert.equal(isFullResolutionWantedAtZoom(682, 512, 1.5), false, '屏幕 1023px：代理已经够用');
assert.equal(isFullResolutionWantedAtZoom(683, 512, 1.5), true, '屏幕 1024.5px：刚超过代理分辨率才需要原图');

// 细节档之前不论多大都不要原图（与 resolveImageLODSource 语义保持一致，避免占配额却用不上）
assert.equal(isFullResolutionWantedAtZoom(4000, 3000, 1), false, 'zoom=1 时不应准入（代理足够）');

// 交互中 / 没有原图 / 未启用 → 一律不准入
assert.equal(shouldAdmitFullResolution({ isInteracting: true, hasOriginal: true, width: 4000, height: 3000, zoom: 2 }), false);
assert.equal(shouldAdmitFullResolution({ hasOriginal: false, width: 4000, height: 3000, zoom: 2 }), false);
assert.equal(shouldAdmitFullResolution({ enabled: false, hasOriginal: true, width: 4000, height: 3000, zoom: 2 }), false);
assert.equal(shouldAdmitFullResolution({ hasOriginal: true, width: Number.NaN, height: 3000, zoom: 2 }), false);

// ---------------------------------------------------------------- B. 定向通知
// 精确性：只有"自己状态变了"的 id 才会被唤醒
{
  const cache = new ImageLRUCache(2);
  const hits = new Map();
  const ids = ['a', 'b', 'c'];
  for (const id of ids) {
    cache.subscribeAdmission(id, admitted => {
      hits.set(id, (hits.get(id) ?? 0) + 1);
    });
  }
  cache.request('a');
  cache.request('b');
  assert.equal(hits.get('a'), 1, 'a 准入时只该收到 1 次通知');
  assert.equal(hits.get('b'), 1);
  assert.equal(hits.get('c'), undefined, 'c 不该因为别人准入而被唤醒');

  cache.request('c'); // 容量 2 → 驱逐 a
  assert.equal(hits.get('c'), 1, 'c 自己准入：1 次');
  assert.equal(hits.get('a'), 2, 'a 被驱逐：追加 1 次');
  assert.equal(hits.get('b'), 1, 'b 没被影响，不该被唤醒');

  // 重复 request 已驻留的 id：状态没变 → 一次都不该通知
  const before = hits.get('b');
  cache.request('b');
  assert.equal(hits.get('b'), before, '已驻留的 id 再次 request 不该产生通知');

  // release 归还配额 → 只通知自己
  cache.release('c');
  assert.equal(hits.get('c'), 2);
  assert.equal(hits.get('b'), before, 'release 别的 id 不该吵醒 b');
}

// 复杂度：图片数远超容量时，通知量必须与图片数同阶（而不是平方）
{
  const imageCount = 300;
  const cache = new ImageLRUCache(IMAGE_LOD_CONSTANTS.FULL_RES_LRU_CAPACITY);
  let listenerCalls = 0;
  for (let index = 0; index < imageCount; index += 1) {
    cache.subscribeAdmission(`image-${index}`, () => { listenerCalls += 1; });
  }
  for (let index = 0; index < imageCount; index += 1) cache.request(`image-${index}`);

  // 旧实现：imageCount² = 90,000。新实现：≤ imageCount × 2（新准入 + 被驱逐）
  assert.ok(
    listenerCalls <= imageCount * 2,
    `通知量必须与图片数同阶，实测 ${listenerCalls}（上限 ${imageCount * 2}）`,
  );
  assert.ok(listenerCalls > 0, '准入必须通知到订阅者，否则卡片永远换不到原图');
  assert.equal(
    listenerCalls < (imageCount * imageCount) / 10,
    true,
    '不允许退化成平方级广播',
  );
}

// 无人订阅时不应产生任何代价
{
  const cache = new ImageLRUCache(4);
  for (let index = 0; index < 200; index += 1) cache.request(`quiet-${index}`);
  assert.equal(cache.size(), 4);
}

// 兼容通道仍然有效（旧的整体广播订阅者要能收到"谁被驱逐"）
{
  const cache = new ImageLRUCache(1);
  const events = [];
  cache.subscribe((evictedId, activeIds) => events.push([evictedId, activeIds.size]));
  cache.request('x');
  cache.request('y');
  assert.deepEqual(events[0], [null, 1]);
  assert.deepEqual(events[1], ['x', 1]);
}

// ---------------------------------------------------------------- C. 源码接线
const proxySource = fs.readFileSync(path.join(__dirname, '../utils/imageProxy.ts'), 'utf8');
assert.match(proxySource, /subscribeAdmission/, 'hook 必须走定向订阅');
assert.match(proxySource, /notifyAdmission\(id\)/, 'request 必须定向通知新驻留的 id');
assert.match(proxySource, /scheduleAdmission\(elementId, getImageDisplayLongestEdge/, '准入必须进批量队列，并按屏幕需求排优先级');
assert.match(proxySource, /b\[1\]\.priority - a\[1\]\.priority/, '字节预算批次必须按需求降序尝试，先保障最需要清晰度的图片');
assert.doesNotMatch(
  proxySource,
  /zoom > IMAGE_LOD_CONSTANTS\.DETAIL_ZOOM_THRESHOLD &&\s*originalHref/,
  '不再允许"仅凭缩放级别"就判定需要原图',
);

const canvasElementSource = fs.readFileSync(path.join(__dirname, '../components/CanvasElement.tsx'), 'utf8');
// P1-H：口径从"共用选档函数"升级为"共用整个渲染需求判定"（档位 + 准入条件 + 采样模式）。
// 只共用选档函数会漏掉"档位没变但该申请原图/该换采样"的情况（见 check-scale-hotpaths.cjs 的两个案例）。
assert.match(
  canvasElementSource,
  /isSameImageRenderRequirement\(prevRequirement, nextRequirement\)/,
  'memo 必须与渲染需求判定同源（避免"该重绘却被拦掉"）',
);
assert.match(
  canvasElementSource,
  /resolveImageRenderRequirement\(\{/,
  'memo 与采样模式都必须取用统一的渲染需求判定',
);
assert.match(canvasElementSource, /width: element\.width/, '必须把世界尺寸交给 LOD 层');
assert.doesNotMatch(
  canvasElementSource,
  /const prevTier = prev\.zoom < 0\.25/,
  '旧的"按 zoom 猜档位"写法必须已被替换',
);

const navigatorSource = fs.readFileSync(path.join(__dirname, '../components/CanvasNavigator.tsx'), 'utf8');
assert.doesNotMatch(
  navigatorSource,
  /useCanvasViewportLiveState/,
  '小地图不该再逐帧订阅 live（那会让整棵组件树逐帧重渲染）',
);
assert.match(navigatorSource, /subscribeLive/, '相机取景框仍需逐帧跟手');
assert.match(navigatorSource, /cameraRectRef/, '取景框必须由 imperative 层独占更新');
assert.match(navigatorSource, /useCanvasViewportRenderState/, '投影/marker 应基于节流后的渲染态');

console.log('image LOD budget checks: ok (admission by display budget, targeted admission notifications, navigator no longer live-subscribed)');
