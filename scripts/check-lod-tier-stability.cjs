/**
 * 自检：图片档位（LOD）的稳定性。
 *
 * 背景（实测）：整屏换 LOD 档位 = 整屏换 href。真实 GPU 下换 300 张图要
 * 约 180ms 的解码停顿，而光栅化本身几乎免费（0.16ms/帧）。
 * 所以"滚动缩放卡"的真凶不是"画得多慢"，而是**换档的时机与规模**。
 *
 * 本脚本锁住四件事：
 * 1. 选档按"屏幕像素需求"（够用且最小），不再按全局缩放级别整屏换；
 * 2. 选档函数**无历史状态** —— 这是硬要求：memo 的比较函数与 LOD hook 必须
 *    各自独立算出同样的结果。任何"上一次的档位"这类记忆只有 hook 看得到，
 *    会让 memo 拿另一套口径拦掉 hook 真正需要的重绘（曾实测：滞回窗口内的
 *    升档被永久卡住，画面一直糊着不换）。
 * 3. 手势标记（transient）不得进入元素的渲染依赖，裁剪 overscan 也不得依赖它 ——
 *    否则每次滚动都会让整屏元素重绘 + 重新挂载一圈元素；
 * 4. 滚轮手势的收尾只有一处（交互层的空闲定时器），viewport-store 不抢。
 *
 * 运行：node scripts/check-lod-tier-stability.cjs
 */
require('./register-typescript.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveImageLODTier,
  resolveImageLODSource,
  getImageDisplayLongestEdge,
  IMAGE_LOD_CONSTANTS,
} = require('../utils/imageProxy.ts');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const { THUMBNAIL_MAX_DIMENSION: THUMB, STANDARD_PROXY_MAX_DIMENSION: PROXY } = IMAGE_LOD_CONSTANTS;

/** memo 口径：只拿"屏幕最长边"这一个数字。 */
const tierOf = screenLongest => resolveImageLODTier({
  screenLongest,
  hasThumbnail: true,
  hasOriginal: true,
  isHighResAdmitted: true,
});

// ---------------------------------------------------------------- 1. 按屏幕像素选档
console.log('\n[1] 选档依据是"屏幕像素需求"，不是全局缩放级别');

assert.equal(tierOf(200), 'thumbnail', '屏幕上只要 200px 就该用缩略图');
assert.equal(tierOf(400), 'standard', '超过缩略图档就该用代理');
assert.equal(tierOf(900), 'standard', '900px 还没超过代理能力，不该动原图');
assert.equal(tierOf(1100), 'original', `越过 ${PROXY} 就该换原图`);
assert.equal(tierOf(THUMB), 'thumbnail', `正好 ${THUMB}px 仍用缩略图（门槛是"超过才升"）`);
assert.equal(tierOf(PROXY), 'original', `正好 ${PROXY}px 换原图`);

// 同一张卡片：世界尺寸不同 → 同一 zoom 下档位应当不同（旧口径会给出相同档位）
const smallCardEdge = getImageDisplayLongestEdge(320, 240, 2.5);   // 800px
const largeCardEdge = getImageDisplayLongestEdge(1600, 1200, 2.5); // 4000px
assert.equal(tierOf(smallCardEdge), 'standard', '小卡片放到 2.5× 也只需要 800px，不该抢原图配额');
assert.equal(tierOf(largeCardEdge), 'original', '大卡片放到 2.5× 确实需要原图');
console.log('    小卡片 800px → standard；大卡片 4000px → original（同一 zoom 下档位不同 ✓）');

// 缺图源时安全回退，绝不返回不存在的 href
assert.equal(resolveImageLODTier({ screenLongest: 100, hasThumbnail: false, hasOriginal: false, isHighResAdmitted: false }), 'standard', '没有缩略图就不要选缩略图档');
assert.equal(resolveImageLODTier({ screenLongest: 5000, hasThumbnail: true, hasOriginal: false, isHighResAdmitted: false }), 'standard', '没有原图就不要选原图档');
assert.equal(resolveImageLODTier({ screenLongest: 0, hasThumbnail: true, hasOriginal: false, isHighResAdmitted: false }), 'thumbnail', '尺寸未知时退回可用档');
assert.equal(resolveImageLODTier({ screenLongest: 5000, hasThumbnail: true, hasOriginal: true, isHighResAdmitted: true, isInteracting: true }), 'standard', '交互中不升原图');

// ---------------------------------------------------------------- 2. 抖动波及面
console.log('\n[2] 门槛附近抖动：旧口径整屏换档，按像素口径只波及"正停在门槛上"的图');

// 20 张世界最长边正好 1024（zoom≈0.25 时屏幕约 256px，卡在缩略图门槛上）+ 280 张尺寸各异
const jitterImages = [
  ...Array.from({ length: 20 }, () => ({ width: 1024, height: 768 })),
  ...Array.from({ length: 280 }, (_, i) => ({ width: 800 + (i % 7) * 400, height: 600 + (i % 5) * 300 })),
];
const legacyTierAt = zoom => resolveImageLODSource({
  zoom,
  href: 'standard',
  thumbnailHref: 'thumb',
  originalHref: 'original',
  isHighResAdmitted: true,
});
const pixelTierAt = (image, zoom) => tierOf(getImageDisplayLongestEdge(image.width, image.height, zoom));

const countJitterSwitches = (rule) => jitterImages.reduce(
  (acc, image) => (rule(image, 0.245) === rule(image, 0.255) ? acc : acc + 1),
  0,
);

// 旧口径只看全局 zoom：0.245 → 0.255 跨过 0.25，于是**每一张图**都换档。
const legacyJitter = legacyTierAt(0.245).tier !== legacyTierAt(0.255).tier ? jitterImages.length : 0;
const pixelJitter = countJitterSwitches((image, zoom) => pixelTierAt(image, zoom));

assert.equal(legacyJitter, jitterImages.length, `旧口径下 zoom 跨 0.25 时整屏 ${jitterImages.length} 张全部换档`);
assert.ok(
  pixelJitter > 0,
  '按像素口径下，正好卡在门槛上的那批图仍然会换档（这是应当发生的：它们确实跨过了自己的门槛）',
);
assert.ok(
  pixelJitter <= jitterImages.length * 0.1,
  `按像素口径下抖动只波及少数图（实测 ${pixelJitter} / ${jitterImages.length}）`,
);
console.log(`    zoom 0.245 → 0.255：旧口径换档 ${legacyJitter} 张 → 按像素口径 ${pixelJitter} 张`);

// ---------------------------------------------------------------- 3. memo 与 hook 同源
console.log('\n[3] memo 口径与 hook 口径必须逐点一致（否则 memo 会拦掉 hook 需要的重绘）');

const sampleImages = Array.from({ length: 60 }, (_, i) => ({
  width: 320 + (i % 11) * 280,
  height: 240 + (i % 7) * 210,
}));
const sampleZooms = [0.12, 0.2, 0.25, 0.26, 0.4, 0.6, 0.8, 1, 1.2, 1.6, 2.2, 3.4];

let mismatches = 0;
for (const image of sampleImages) {
  for (const zoom of sampleZooms) {
    const fromHook = resolveImageLODSource({
      zoom,
      width: image.width,
      height: image.height,
      href: 'standard',
      thumbnailHref: 'thumb',
      originalHref: 'original',
      isHighResAdmitted: true,
    }).tier;
    const fromMemo = tierOf(getImageDisplayLongestEdge(image.width, image.height, zoom));
    if (fromHook !== fromMemo) mismatches += 1;
  }
}
assert.equal(
  mismatches,
  0,
  `memo 与 hook 的档位判定必须逐点一致（实测 ${mismatches} 处不一致）—— 两边口径不同源会让"该换档却没重绘"`,
);
console.log(`    ${sampleImages.length} 张图 × ${sampleZooms.length} 个缩放级别 = ${sampleImages.length * sampleZooms.length} 个采样点，判定全部一致 ✓`);

// ---------------------------------------------------------------- 4. 无尺寸时的兜底口径不回归
console.log('\n[4] 未提供尺寸信息时保持原有按缩放级别的语义（兼容既有调用点）');

assert.equal(
  resolveImageLODSource({ zoom: 0.1, href: 'standard', thumbnailHref: 'thumb' }).tier,
  'thumbnail',
  'zoom<0.25 且无尺寸信息 → 缩略图（旧语义）',
);
assert.equal(
  resolveImageLODSource({ zoom: 2, href: 'standard', originalHref: 'original', isHighResAdmitted: true }).tier,
  'original',
  'zoom>1 且已准入、无尺寸信息 → 原图（旧语义）',
);
assert.equal(
  resolveImageLODSource({ zoom: 0.5, href: 'standard', thumbnailHref: 'thumb', originalHref: 'original' }).tier,
  'standard',
  '中间区间 → 代理（旧语义）',
);

// ---------------------------------------------------------------- 5. 源码守卫
console.log('\n[5] 源码守卫：手势标记不进元素渲染依赖，状态收尾只在一处');

const proxySource = read('utils/imageProxy.ts');
assert.doesNotMatch(proxySource, /LOD_HYSTERESIS_BAND/, '选档不得有滞回带（memo 看不到 hook 的历史，会把升档卡死）');
assert.doesNotMatch(proxySource, /previousTier/, '选档函数必须无历史状态');
assert.doesNotMatch(proxySource, /frozen/, 'LOD 层不得有"手势中冻结档位"这类开关');

const elementSource = read('components/CanvasElement.tsx');
assert.doesNotMatch(elementSource, /lodFrozen/, 'CanvasElement 不得接收手势标记（否则每次手势翻转都让整屏元素重绘）');
assert.match(
  elementSource,
  /isSameImageRenderRequirement\(prevRequirement, nextRequirement\)/,
  'memo 必须与渲染需求判定同源（P1-H 起口径从"只比档位"扩到"档位 + 准入 + 采样"）',
);

const canvasSource = read('components/MainCanvas.tsx');
assert.doesNotMatch(canvasSource, /lodFrozen=/, 'MainCanvas 不得把"视口手势中"接到元素渲染依赖上');
assert.doesNotMatch(
  canvasSource,
  /if \(!viewport\.transient\) return undefined/,
  '裁剪白名单/overscan 不得依赖手势标记（否则每次滚动都要重挂一圈元素）',
);
assert.match(
  canvasSource,
  /viewport\.transient \? elementZoomRef\.current : viewportZoom/,
  '手势中元素缩放必须保持手势开始时的值，避免中途换图片档打脏相机层',
);
assert.match(
  canvasSource,
  /RENDER_PUBLISH_MOVE_PX \* 1\.6/,
  'overscan 必须由发布阈值推导（恒定，1.6 倍 = 兜住缩小时两次发布间的可见半径扩大），而不是由手势标记开关',
);

const interactionSource = read('hooks/useCanvasInteractions.ts');
assert.match(interactionSource, /WHEEL_GESTURE_IDLE_MS/, '滚轮手势必须有空闲收尾超时（否则手势标记永不归位）');
assert.match(
  interactionSource,
  /const endWheelGesture = \(\) => \{[\s\S]{0,400}?viewportStore\?\.endInteraction\(\)/,
  '空闲收尾必须调用 endInteraction（提交 + 复位手势标记）',
);

const storeSource = read('utils/viewport-store.ts');
assert.doesNotMatch(
  storeSource,
  /if \(settled\) \{[\s\S]{0,400}?transient = false/,
  '平滑追随收敛时不得抢手势收尾（真正的收尾点是交互层的空闲定时器）',
);
assert.doesNotMatch(
  storeSource,
  /if \(settled\) \{[\s\S]{0,400}?commit\(\)/,
  '收敛不应引入新的提交点（落盘时机仍是显式 endInteraction / flush）',
);

console.log('\nchecks: lod-tier-stability ok\n');
