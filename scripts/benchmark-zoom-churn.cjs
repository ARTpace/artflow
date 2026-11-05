/**
 * benchmark-zoom-churn.cjs —— 量化"滚动缩放到底要付哪些代价"。
 *
 * 三件事，全部用纯函数与几何算出来（不依赖浏览器，可复现）：
 *   1. 换档规模：同一段缩放轨迹下，每一步有多少张图要换 href。
 *      对比"旧口径（按全局缩放级别）"与"按屏幕像素选档"。
 *   2. 挂载抖动：overscan 若依赖"手势中"标记，每次手势开始/结束会多挂/卸多少元素。
 *   3. 重绘规模：手势翻转时，旧设计（把手势标记交给每个元素）会让多少元素重绘，
 *      新设计（不让手势标记进入元素渲染依赖）会让多少元素重绘。
 *
 * 运行：node scripts/benchmark-zoom-churn.cjs
 *       ARTFLOW_BENCH_IMAGES=500 node scripts/benchmark-zoom-churn.cjs
 */
require('./register-typescript.cjs');

const {
  resolveImageLODTier,
  getImageDisplayLongestEdge,
} = require('../utils/imageProxy.ts');

const imageCount = Number.parseInt(process.env.ARTFLOW_BENCH_IMAGES || '300', 10);
if (!Number.isInteger(imageCount) || imageCount < 1) {
  throw new Error('ARTFLOW_BENCH_IMAGES must be a positive integer');
}

/** 画布上常见的图片世界尺寸。刻意取"多样"：真实画布上同尺寸图不会同批跨门槛。 */
const SIZE_POOL = [
  { width: 384, height: 384 },
  { width: 512, height: 512 },
  { width: 640, height: 480 },
  { width: 768, height: 1024 },
  { width: 900, height: 600 },
  { width: 1024, height: 768 },
  { width: 1200, height: 800 },
  { width: 1536, height: 1024 },
  { width: 1800, height: 1200 },
  { width: 2048, height: 1536 },
  { width: 2560, height: 1440 },
  { width: 3200, height: 2000 },
];

/** 确定性分配多档 href：真实项目里并非每张图都有缩略图/原图。 */
const elements = Array.from({ length: imageCount }, (_, index) => ({
  id: `image-${index}`,
  ...SIZE_POOL[index % SIZE_POOL.length],
  hasThumbnail: index % 3 !== 2,   // ≈67%
  hasOriginal: index % 5 !== 4,    // ≈80%
}));

const WHEEL_RATIO = 1.25;
const buildZoomTrace = (from, to) => {
  const trace = [];
  let zoom = from;
  if (from <= to) {
    while (zoom < to) {
      trace.push(zoom);
      zoom *= WHEEL_RATIO;
    }
  } else {
    while (zoom > to) {
      trace.push(zoom);
      zoom /= WHEEL_RATIO;
    }
  }
  trace.push(zoom);
  return trace;
};

// ---------------------------------------------------------------- 口径定义

/** 旧口径：整屏由全局缩放级别决定（zoom<0.25 全缩略图 / zoom>1 全原图）。 */
const legacyTier = ({ zoom, hasThumbnail, hasOriginal }) => {
  if (zoom < 0.25) return hasThumbnail ? 'thumbnail' : 'standard';
  if (zoom > 1.0 && hasOriginal) return 'original';
  return 'standard';
};

/** 新口径：每张图按"自己的屏幕像素需求"选档（纯函数，无历史状态）。 */
const pixelTier = ({ element, zoom }) => resolveImageLODTier({
  screenLongest: getImageDisplayLongestEdge(element.width, element.height, zoom),
  hasThumbnail: element.hasThumbnail,
  hasOriginal: element.hasOriginal,
  isHighResAdmitted: true,
});

const TIER_ORDER = { thumbnail: 0, standard: 1, original: 2 };

/** 沿缩放轨迹统计每步的换档张数（升/降分开）。 */
const runTrace = (trace, tierAt) => {
  const current = new Map(elements.map(el => [el.id, null]));
  const steps = [];
  for (const zoom of trace) {
    let promoted = 0;
    let demoted = 0;
    for (const element of elements) {
      const next = tierAt(element, zoom);
      const prev = current.get(element.id);
      if (prev !== null && prev !== next) {
        if (TIER_ORDER[next] > TIER_ORDER[prev]) promoted += 1;
        else demoted += 1;
      }
      current.set(element.id, next);
    }
    steps.push({ zoom, promoted, demoted, changed: promoted + demoted });
  }
  return steps;
};

const summarize = steps => ({
  total: steps.reduce((sum, s) => sum + s.changed, 0),
  worst: steps.reduce((max, s) => Math.max(max, s.changed), 0),
  steps: steps.length,
});

console.log(`\n=== [1] 滚动中的换档规模（${imageCount} 张图，同一段缩放轨迹）===\n`);

for (const [label, from, to] of [
  ['放大 0.2 → 2.5', 0.2, 2.5],
  ['缩小 2.5 → 0.2', 2.5, 0.2],
]) {
  const trace = buildZoomTrace(from, to);
  const legacy = runTrace(trace, (element, zoom) => legacyTier({
    zoom,
    hasThumbnail: element.hasThumbnail,
    hasOriginal: element.hasOriginal,
  }));
  const pixel = runTrace(trace, (element, zoom) => pixelTier({ element, zoom }));

  console.log(`${label}（${trace.length} 格，单格倍率 ${WHEEL_RATIO}）`);
  for (let i = 0; i < trace.length; i += 1) {
    console.log(
      `    zoom ${trace[i].toFixed(3).padStart(6)}   `
      + `旧口径 ${String(legacy[i].changed).padStart(4)} 张  |  `
      + `按屏幕像素 ${String(pixel[i].changed).padStart(4)} 张`,
    );
  }
  const l = summarize(legacy);
  const p = summarize(pixel);
  console.log(`  合计：旧口径 ${l.total} 张 · 按屏幕像素 ${p.total} 张`);
  console.log(`  单格最坏：旧口径 ${l.worst} 张 · 按屏幕像素 ${p.worst} 张`);
  console.log(`  单格平均：旧口径 ${(l.total / l.steps).toFixed(1)} 张 · 按屏幕像素 ${(p.total / p.steps).toFixed(1)} 张\n`);
}

// ---------------------------------------------------------------- [2] 挂载抖动

const SCREEN = { width: 1440, height: 900 };
const CELL = 800; // 图片在图版上大致紧邻，平均 800 世界单位一格
const COLUMNS = Math.ceil(Math.sqrt(imageCount));
const layout = Array.from({ length: imageCount }, (_, index) => ({
  x: (index % COLUMNS) * CELL,
  y: Math.floor(index / COLUMNS) * CELL,
}));
const gridWidth = COLUMNS * CELL;
const gridHeight = Math.ceil(imageCount / COLUMNS) * CELL;
const center = { x: gridWidth / 2, y: gridHeight / 2 };

const countVisible = (zoom, paddingScreenPx) => {
  const halfW = SCREEN.width / 2 / zoom + paddingScreenPx / zoom;
  const halfH = SCREEN.height / 2 / zoom + paddingScreenPx / zoom;
  let count = 0;
  for (const item of layout) {
    if (item.x + CELL < center.x - halfW || item.x > center.x + halfW) continue;
    if (item.y + CELL < center.y - halfH || item.y > center.y + halfH) continue;
    count += 1;
  }
  return count;
};

const PADDING_LEGACY_PX = Math.min(SCREEN.width, SCREEN.height) * 0.3; // 改动前：屏幕短边 30%
const PADDING_CANDIDATE_PX = 150;                                     // 本批：发布阈值 120px × 1.25

console.log('=== [2] 手势开始/结束时的挂载抖动（overscan 若依赖"手势中"标记，每滚一次付一遍）===\n');
console.log('  zoom    无 overscan   改动前 30%短边   本批 150px   改动前多挂   本批多挂');
const probeZooms = [0.2, 0.35, 0.6, 1.0, 1.6, 2.5];
const jitterLegacy = [];
const jitterCandidate = [];
for (const zoom of probeZooms) {
  const base = countVisible(zoom, 0);
  const legacy = countVisible(zoom, PADDING_LEGACY_PX);
  const candidate = countVisible(zoom, PADDING_CANDIDATE_PX);
  jitterLegacy.push(legacy - base);
  jitterCandidate.push(candidate - base);
  console.log(
    `  ${zoom.toFixed(2).padStart(4)}   ${String(base).padStart(10)}   `
    + `${String(legacy).padStart(14)}   ${String(candidate).padStart(11)}   `
    + `${String(legacy - base).padStart(10)}   ${String(candidate - base).padStart(8)}`,
  );
}
const avg = list => list.reduce((a, b) => a + b, 0) / list.length;
console.log(
  `\n  平均每次手势开始要多挂：改动前 ${avg(jitterLegacy).toFixed(0)} 张 → 本批 ${avg(jitterCandidate).toFixed(0)} 张`
  + `（停手时同样数量被卸载，下次滚动还要再挂回来）`,
);
console.log('  恒定 overscan 后这一列不再是"每滚一次付一遍"，而是恒定的稳态挂载量。\n');

// ---------------------------------------------------------------- [3] 重绘规模

console.log('=== [3] 手势翻转时的元素重绘规模（把手势标记交给每个元素的代价）===\n');

const redrawTrace = buildZoomTrace(0.25, 1.6);

/** 某一个 zoom 下，视口（含 overscan）内的元素索引 —— 只有这些元素在渲染树里。 */
const visibleIndicesAt = (zoom, paddingScreenPx) => {
  const halfW = SCREEN.width / 2 / zoom + paddingScreenPx / zoom;
  const halfH = SCREEN.height / 2 / zoom + paddingScreenPx / zoom;
  const result = [];
  for (let index = 0; index < layout.length; index += 1) {
    const item = layout[index];
    if (item.x + CELL < center.x - halfW || item.x > center.x + halfW) continue;
    if (item.y + CELL < center.y - halfH || item.y > center.y + halfH) continue;
    result.push(index);
  }
  return result;
};

let forcedRedraw = 0;
let neededRedraw = 0;
let previousTiers = new Map();
for (const zoom of redrawTrace) {
  const visible = visibleIndicesAt(zoom, PADDING_CANDIDATE_PX);
  // 旧设计：手势开始与结束各翻转一次标记 → 当时可见的元素全部重绘。
  forcedRedraw += visible.length * 2;

  // 新设计：只有"档位真的变了"的**可见**元素才重绘（不可见的元素不在渲染树里）。
  const nextTiers = new Map();
  for (const index of visible) {
    const element = elements[index];
    nextTiers.set(index, pixelTier({ element, zoom }));
  }
  for (const index of visible) {
    const prev = previousTiers.get(index);
    if (prev !== undefined && prev !== nextTiers.get(index)) neededRedraw += 1;
  }
  previousTiers = nextTiers;
}
console.log(`  一次"从 0.25 放大到 1.6"的手势（${redrawTrace.length} 格）：`);
console.log(`    旧设计（手势标记进元素）被迫重绘 : ${forcedRedraw} 次（可见元素数 × 每次手势翻转 2 次）`);
console.log(`    本批（标记不进元素）实际重绘     : ${neededRedraw} 次（只有档位真的变化的可见元素）`);
console.log(`    比值                             : ${(forcedRedraw / Math.max(1, neededRedraw)).toFixed(1)}×\n`);

console.log('判读要点：');
console.log('  · [1] 决定"滚动中会不会一批换 href"：旧口径是整屏同步，按屏幕像素是逐图分散。');
console.log('  · [2] 决定"每次滚动的固定开销"：只要 overscan 依赖手势标记，它就会每滚一次付一遍。');
console.log('  · [3] 决定"手势翻转时多少元素被迫重绘"：把手势标记当元素 props 会让它变成整屏级成本。\n');
