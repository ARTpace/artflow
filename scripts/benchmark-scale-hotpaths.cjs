/**
 * benchmark-scale-hotpaths.cjs —— 量化"元素规模"维度的四条热点路径。
 *
 * 全部用真实模块 + 纯函数算出来（不依赖浏览器、可复现）：
 *   1. 裁剪失效：导入即全选 → 选中集整体进入裁剪白名单 → 屏幕外元素照样挂载。
 *   2. 选区边界：getSelectionBounds 的口径是"每个选中 id 做一次 allElements.find"，
 *      成本 = O(选中数 × 全量数)。
 *   3. 等宽导入布局：真实导入把列宽固定为 400，于是所有图共用同一个缩略图门槛，
 *      "逐图分散换档"的前提不成立，同一步缩放里能整屏同时换档。
 *   4. 滚轮增量覆盖：一帧内多个滚轮事件只保留最后一个 → 相对增量被丢弃。
 *
 * 运行：node scripts/benchmark-scale-hotpaths.cjs
 */

require('./register-typescript.cjs');

const { performance } = require('node:perf_hooks');
const { createViewportIndex } = require('../utils/viewport-index.ts');
const { resolveImageLODTier, getImageDisplayLongestEdge } = require('../utils/imageProxy.ts');
const { resolveWheelZoomFactor, normalizeWheelDelta } = require('../utils/wheel-input.ts');

// 与 hooks/useFileHandlers.ts 的瀑布流导入保持一致
const COLUMN_WIDTH = 400;
const GAP = 15;

/** 复刻导入布局：等宽瀑布流（真实路径）。 */
const buildMasonry = (count, aspect = 4 / 3) => {
  const colCount = Math.max(1, Math.ceil(Math.sqrt(count)));
  const colHeights = new Array(colCount).fill(0);
  const elements = [];
  for (let i = 0; i < count; i += 1) {
    let minHeight = Infinity;
    let colIdx = 0;
    for (let c = 0; c < colCount; c += 1) {
      if (colHeights[c] < minHeight) {
        minHeight = colHeights[c];
        colIdx = c;
      }
    }
    const height = COLUMN_WIDTH * aspect;
    elements.push({
      id: `image-${i}`,
      type: 'image',
      x: colIdx * (COLUMN_WIDTH + GAP),
      y: colHeights[colIdx],
      width: COLUMN_WIDTH,
      height,
      href: 'preview://fixture',
      mimeType: 'image/png',
      thumbnailHref: 'preview://thumb',
      originalHref: 'preview://original',
    });
    colHeights[colIdx] += height + GAP;
  }
  return elements;
};

console.log('\n================ 元素规模维度的四条热点路径 ================\n');

// ------------------------------------------------------------------ [1] 裁剪被全选绕过
console.log('[1] 视口裁剪：选中集是否绕过裁剪');
console.log('    视口 1440×900（世界单位），padding 取渲染态的恒定 overscan');
{
  const VIEWPORT = { x: 0, y: 0, width: 1440, height: 900 };
  const PADDING = 192; // RENDER_PUBLISH_MOVE_PX * 1.6 ≈ 192

  for (const count of [1000, 5000]) {
    const elements = buildMasonry(count);
    const index = createViewportIndex(elements);
    const allIds = new Set(elements.map(el => el.id));

    const noSelection = index.query(VIEWPORT, { padding: PADDING }).length;
    const fullSelection = index.query(VIEWPORT, {
      padding: PADDING,
      includeElementIds: allIds,
    }).length;

    console.log(`    ${String(count).padStart(4)} 张资产：不选中返回 ${String(noSelection).padStart(4)} 张 → 全选后返回 ${String(fullSelection).padStart(4)} 张`);
  }
  console.log('    判读：全选把裁剪完全抵消，屏幕外元素照样进入渲染层。\n');
}

// ------------------------------------------------------------------ [2] 选区边界查找
console.log('[2] 选区边界：getSelectionBounds 的查找成本');
{
  for (const total of [1000, 5000]) {
    const elements = buildMasonry(total);
    const selectedIds = elements.map(el => el.id); // 导入即全选

    // 现状口径：每个 id 一次 allElements.find
    let comparisons = 0;
    let found = 0;
    const startedAt = performance.now();
    for (const id of selectedIds) {
      for (let i = 0; i < elements.length; i += 1) {
        comparisons += 1;
        if (elements[i].id === id) {
          found += 1;
          break;
        }
      }
    }
    const findMs = performance.now() - startedAt;

    // 索引口径：先建一次 Map，再按 id 查
    const startedAtIndex = performance.now();
    const byId = new Map(elements.map(el => [el.id, el]));
    let indexedFound = 0;
    for (const id of selectedIds) if (byId.get(id)) indexedFound += 1;
    const indexMs = performance.now() - startedAtIndex;

    if (found !== indexedFound) throw new Error('口径不一致');
    console.log(`    ${String(total).padStart(4)} 张全选：find 口径比较 ${comparisons.toLocaleString().padStart(12)} 次（${findMs.toFixed(1)} ms） / Map 口径 ${indexMs.toFixed(2)} ms`);
  }
  console.log('    判读：find 口径是 O(选中 × 全量)，Map 口径 O(全量 + 选中)。\n');
}

// ------------------------------------------------------------------ [3] 等宽布局的换档同步性
console.log('[3] 换档同步性：等宽导入布局 vs 尺寸分散');
{
  const WHEEL_RATIO = 1.25;
  const buildTrace = (from, to) => {
    const trace = [];
    let zoom = from;
    while (zoom < to) {
      trace.push(zoom);
      zoom *= WHEEL_RATIO;
    }
    trace.push(zoom);
    return trace;
  };
  const trace = buildTrace(0.25, 1.6);

  const tierOf = (el, zoom) => resolveImageLODTier({
    screenLongest: getImageDisplayLongestEdge(el.width, el.height, zoom),
    hasThumbnail: true,
    hasOriginal: true,
    isHighResAdmitted: true,
  });

  // 真实导入布局：300 张等宽 400
  const uniform = buildMasonry(300);
  // 对照：尺寸高度分散（旧基准用的那种）
  const SIZE_POOL = [
    [384, 384], [512, 512], [640, 480], [768, 1024], [900, 600], [1024, 768],
    [1200, 800], [1536, 1024], [1800, 1200], [2048, 1536], [2560, 1440], [3200, 2000],
  ];
  const mixed = Array.from({ length: 300 }, (_, i) => ({
    id: `mixed-${i}`,
    width: SIZE_POOL[i % SIZE_POOL.length][0],
    height: SIZE_POOL[i % SIZE_POOL.length][1],
    thumbnailHref: 'preview://thumb',
    originalHref: 'preview://original',
  }));

  const churn = elements => {
    const steps = [];
    for (let i = 1; i < trace.length; i += 1) {
      let changed = 0;
      for (const el of elements) if (tierOf(el, trace[i]) !== tierOf(el, trace[i - 1])) changed += 1;
      if (changed > 0) steps.push({ zoom: trace[i], changed });
    }
    const worst = steps.reduce((acc, s) => Math.max(acc, s.changed), 0);
    const total = steps.reduce((acc, s) => acc + s.changed, 0);
    return { steps, worst, total, changingSteps: steps.length };
  };

  const u = churn(uniform);
  const m = churn(mixed);
  console.log(`    轨迹：zoom ${trace[0].toFixed(2)} → ${trace[trace.length - 1].toFixed(2)}（${trace.length} 档）`);
  console.log(`    等宽 400×300 布局 : 换档步数 ${String(u.changingSteps).padStart(2)}，最坏单步 ${String(u.worst).padStart(4)} 张，合计 ${u.total} 张`);
  console.log(`    尺寸分散布局      : 换档步数 ${String(m.changingSteps).padStart(2)}，最坏单步 ${String(m.worst).padStart(4)} 张，合计 ${m.total} 张`);
  console.log(`    等宽布局最坏单步 / 分散布局 = ${(u.worst / Math.max(1, m.worst)).toFixed(1)}×`);
  console.log('    判读：等宽布局下"逐图分散"的前提不成立，同一步会整批换档。\n');
}

// ------------------------------------------------------------------ [4] 修复后的选区边界
console.log('[4] 选区边界：修复后的真实实现 vs 旧口径');
{
  const { getSelectionBounds } = require('../utils/canvasUtils.ts');

  for (const total of [1000, 5000]) {
    const elements = buildMasonry(total);
    const ids = elements.map(el => el.id); // 导入即全选

    // 旧口径参考实现（每 id 一次 find）
    const findReference = (selection, all) => {
      const picked = selection.map(id => all.find(el => el.id === id)).filter(Boolean);
      if (picked.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const el of picked) {
        minX = Math.min(minX, el.x);
        minY = Math.min(minY, el.y);
        maxX = Math.max(maxX, el.x + el.width);
        maxY = Math.max(maxY, el.y + el.height);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    };

    let t = performance.now();
    const reference = findReference([...ids], elements);
    const referenceMs = performance.now() - t;

    t = performance.now();
    const cold = getSelectionBounds([...ids], elements); // 引用不同 → 冷算
    const coldMs = performance.now() - t;

    t = performance.now();
    for (let i = 0; i < 50; i += 1) getSelectionBounds(ids, elements);
    const warmMs = (performance.now() - t) / 50;

    const same = JSON.stringify(cold) === JSON.stringify(reference);
    if (!same) throw new Error('修复后的结果必须与旧口径几何一致');
    console.log(`    ${String(total).padStart(4)} 张全选：旧口径 ${referenceMs.toFixed(1)} ms → 修复后冷算 ${coldMs.toFixed(2)} ms / 命中缓存 ${warmMs.toFixed(3)} ms（几何一致 ✓）`);
  }
  console.log('    判读：冷算已经是线性，命中缓存后基本免费。相机渲染态更新时重复调用的代价被消掉。\n');
}

// ------------------------------------------------------------------ [6] 裁剪对换档规模的收敛
console.log('[5] 等宽布局下的换档规模：全量 vs 视口内');
{
  const WHEEL_RATIO = 1.25;
  const tierOf = (el, zoom) => resolveImageLODTier({
    screenLongest: getImageDisplayLongestEdge(el.width, el.height, zoom),
    hasThumbnail: true,
    hasOriginal: true,
    isHighResAdmitted: true,
  });

  const elements = buildMasonry(1000);
  const index = createViewportIndex(elements);

  const trace = [];
  for (let z = 0.25; z < 1.8; z *= WHEEL_RATIO) trace.push(z);
  trace.push(1.8);

  let worstAll = 0;
  let worstVisible = 0;
  for (let i = 1; i < trace.length; i += 1) {
    const zoom = trace[i];
    const previous = trace[i - 1];
    // 视口（世界单位）随 zoom 反比收缩：屏幕 1440×900
    const viewport = { x: 0, y: 0, width: 1440 / zoom, height: 900 / zoom };
    const visibleIds = new Set(index.query(viewport, { padding: 150 / zoom }).map(el => el.id));

    let changedAll = 0;
    let changedVisible = 0;
    for (const el of elements) {
      if (tierOf(el, zoom) !== tierOf(el, previous)) {
        changedAll += 1;
        if (visibleIds.has(el.id)) changedVisible += 1;
      }
    }
    worstAll = Math.max(worstAll, changedAll);
    worstVisible = Math.max(worstVisible, changedVisible);
  }

  console.log(`    1000 张等宽 400×300，zoom 0.25 → 1.8（${trace.length} 档，视口 1440×900）`);
  console.log(`    最坏单步换档：全量 ${String(worstAll).padStart(4)} 张 → 裁剪后（视口内）${String(worstVisible).padStart(3)} 张`);
  console.log(`    收敛倍数    : ${(worstAll / Math.max(1, worstVisible)).toFixed(1)}×`);
  console.log('    判读：等宽布局确实会让同尺寸图同步换档，但裁剪修好后换档集合被收敛到视口内，');
  console.log('          所以"有界预解码 + 分批换源"的优先级低于"让裁剪真正生效"。\n');
}

console.log('[6] 滚轮增量：一帧内多事件被覆盖 vs 累加');
{
  const frameCount = 20;
  const eventsPerFrame = 3;
  const delta = -33; // 触控板/高频滚轮的典型单次增量

  // 现状：pendingWheelRef.current = {...} 覆盖，一帧只用最后一个
  let overwriteZoom = 1;
  for (let f = 0; f < frameCount; f += 1) {
    let pendingDeltaY = null;
    for (let e = 0; e < eventsPerFrame; e += 1) pendingDeltaY = normalizeWheelDelta(delta, 0);
    overwriteZoom *= resolveWheelZoomFactor(pendingDeltaY);
  }

  // 累加：同一帧内把归一化增量求和
  let accumulateZoom = 1;
  for (let f = 0; f < frameCount; f += 1) {
    let pendingDeltaY = 0;
    for (let e = 0; e < eventsPerFrame; e += 1) pendingDeltaY += normalizeWheelDelta(delta, 0);
    accumulateZoom *= resolveWheelZoomFactor(pendingDeltaY);
  }

  const expected = 1; // 期望：总输入量决定总缩放（与帧分组无关）
  const idealZoom = Math.pow(resolveWheelZoomFactor(delta), frameCount * eventsPerFrame);
  console.log(`    ${frameCount} 帧 × 每帧 ${eventsPerFrame} 个事件，每个 deltaY=${delta}`);
  console.log(`    覆盖口径（现状）: 最终 zoom = ${overwriteZoom.toFixed(4)}`);
  console.log(`    累加口径（修正）: 最终 zoom = ${accumulateZoom.toFixed(4)}`);
  console.log(`    按总输入应有的值: 最终 zoom = ${idealZoom.toFixed(4)}`);
  console.log(`    丢失比例        : ${(100 * (1 - overwriteZoom / idealZoom)).toFixed(1)}%`);
  console.log('    判读：指数模型下"累加再应用一次"与"逐个应用"数学等价，累加是精确修复。\n');

  // 顺带验证：无论怎么分组，累加口径的结果一致
  for (const grouping of [1, 2, 5, 10, 60]) {
    let zoom = 1;
    const totalEvents = frameCount * eventsPerFrame;
    for (let f = 0; f < Math.ceil(totalEvents / grouping); f += 1) {
      let sum = 0;
      for (let e = 0; e < grouping; e += 1) sum += delta;
      zoom *= resolveWheelZoomFactor(sum);
    }
    if (Math.abs(zoom - idealZoom) > 1e-9) throw new Error(`分组 ${grouping} 结果不一致`);
  }
  console.log('    交叉验证：按 1/2/5/10/60 分组，累加口径结果完全一致。\n');
}
