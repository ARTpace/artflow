/**
 * 自检：元素规模维度的四条热点路径。
 *
 * 背景（实测，见 scripts/benchmark-scale-hotpaths.cjs）：
 * 1. 导入即全选 + "选中集进裁剪白名单" → 裁剪被完全抵消：
 *    视口只需 8 张时，全选 1000/5000 张就返回 1000/5000 张，屏幕外的整份内容照样挂载。
 * 2. getSelectionBounds 的旧口径是"每个选中 id 做一次 allElements.find"：
 *    全选 5000 张 = 12,502,500 次比较（约 40ms 一次），而它有 10 个调用点。
 * 3. memo 与 LOD hook 只共用"选档函数"还不够：准入条件（含 zoom > 1.0）与
 *    imageRendering 采样模式都不在选档结果里，于是"该申请原图/该换采样"的
 *    那次重绘会被 memo 拦掉。
 * 4. 滚轮 delta 是相对增量。一帧内多个事件互相覆盖会**丢弃输入**：
 *    实测每帧 3 个事件时最终只放大到应有值的 5.3%（丢失 94.7%）。
 *
 * 运行：node scripts/check-scale-hotpaths.cjs
 */
require('./register-typescript.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createViewportIndex } = require('../utils/viewport-index.ts');
const { getSelectionBounds } = require('../utils/canvasUtils.ts');
const {
  resolveImageRenderRequirement,
  isSameImageRenderRequirement,
  resolveImageLODTier,
  getImageDisplayLongestEdge,
} = require('../utils/imageProxy.ts');
const { resolveWheelZoomFactor } = require('../utils/wheel-input.ts');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const log = message => console.log(message);
log('checks: scale hotpaths');

// ---------------------------------------------------------------- 1. 裁剪白名单
{
  const mainCanvas = read('components/MainCanvas.tsx');
  const includeBlock = mainCanvas.match(/const interactionIncludeIds = useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/);
  assert.ok(includeBlock, '必须能定位到 interactionIncludeIds 的定义');

  const block = includeBlock[0];
  assert.match(block, /dragElementIds/, '拖动集必须放行（拖动中的新位置不在视口索引里）');
  assert.match(block, /editingElement/, '文本编辑中的元素必须放行（编辑 UI 挂在元素上）');
  // P1-1：白名单在进 memo 之前先把逐帧变化的对象折算成原始 id。对象引用每帧都换，
  // 直接进依赖等于把逐帧抖动带进可见集重算，正好抵消瞬时通道冻结索引的收益。
  assert.match(block, /croppingElementId/, '裁剪中的元素必须放行（折算后的 id 口径）');
  assert.match(block, /aiRotationElementId/, 'AI 旋转中的元素必须放行（折算后的 id 口径）');
  assert.match(block, /transformSessionElementId/, '变换预览中的元素必须放行（预览位置不在视口索引里）');
  assert.doesNotMatch(block, /croppingState\b/, '依赖里只能出现折算后的 id，不得直接引用逐帧变化的 croppingState 对象');
  assert.doesNotMatch(block, /aiRotationState\b/, '依赖里只能出现折算后的 id，不得直接引用逐帧变化的 aiRotationState 对象');
  assert.match(mainCanvas, /const croppingElementId = croppingState \? croppingState\.elementId : null;/, '必须先折算裁剪元素 id 再进白名单');
  assert.match(mainCanvas, /const aiRotationElementId = aiRotationState \? aiRotationState\.element\.id : null;/, '必须先折算旋转元素 id 再进白名单');

  // 硬要求：普通选中**不得**进入白名单。
  assert.doesNotMatch(
    block,
    /selectedElementIdSet/,
    '选中集不得进入裁剪白名单：选中一张屏幕外的卡片不等于要挂载它的完整内容',
  );
  assert.match(mainCanvas, /viewportIncludeIds/, '查询必须走可空的 viewportIncludeIds，空集时不传');

  // 行为断言：用真实索引证明"全选不再影响返回集"的前提 —— 白名单只含拖动/编辑/裁剪/旋转。
  const elements = Array.from({ length: 2000 }, (_, i) => ({
    id: `el-${i}`,
    type: 'image',
    x: (i % 45) * 415,
    y: Math.floor(i / 45) * 315,
    width: 400,
    height: 300,
    href: 'preview://fixture',
    mimeType: 'image/png',
  }));
  const index = createViewportIndex(elements);
  const viewport = { x: 0, y: 0, width: 1440, height: 900 };
  const culled = index.query(viewport, { padding: 150 }).length;
  const fullSelection = index.query(viewport, {
    padding: 150,
    includeElementIds: new Set(elements.map(el => el.id)),
  }).length;
  assert.ok(culled < 100, `裁剪本身必须有效（实测 ${culled} 张）`);
  assert.equal(fullSelection, elements.length, '把整个选中集塞进白名单会返回全部元素（这正是被修掉的行为）');
  log(`  ✓ 裁剪白名单只放行拖动/编辑/裁剪/旋转；2000 张全选不再把裁剪抵消（裁剪后 ${culled} 张）`);
}

// ---------------------------------------------------------------- 2. 选区边界
{
  const canvasUtils = read('utils/canvasUtils.ts');
  assert.doesNotMatch(
    canvasUtils,
    /allElements\.find\(el => el\.id === item\)/,
    '选区边界不得再用 find 口径（O(选中 × 全量)）',
  );
  assert.match(canvasUtils, /getElementIndex/, 'id → 元素 必须走索引');

  // 几何等价：与"逐个 find"的参考实现逐项对比。
  const referenceBounds = (ids, all) => {
    const picked = ids.map(id => all.find(el => el.id === id)).filter(Boolean);
    if (picked.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const xs = picked.map(el => el.x);
    const ys = picked.map(el => el.y);
    const x2 = picked.map(el => el.x + el.width);
    const y2 = picked.map(el => el.y + el.height);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...x2) - minX, height: Math.max(...y2) - minY };
  };

  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const elements = Array.from({ length: 300 }, (_, i) => ({
    id: `el-${i}`,
    type: 'image',
    x: Math.round(rand() * 4000),
    y: Math.round(rand() * 4000),
    width: 100 + Math.round(rand() * 300),
    height: 100 + Math.round(rand() * 300),
    href: 'preview://fixture',
    mimeType: 'image/png',
  }));

  for (let round = 0; round < 20; round += 1) {
    const ids = elements
      .filter(() => rand() < 0.4)
      .map(el => el.id);
    if (ids.length === 0) continue;
    // 每轮换一个新数组引用，避免命中缓存（这里要验的是"算得对"）
    const selection = [...ids];
    const actual = getSelectionBounds(selection, elements);
    const expected = referenceBounds(selection, elements);
    assert.deepEqual(actual, expected, `选区边界的几何结果必须与参考实现一致（round ${round}）`);
  }

  // 缓存：同一对引用必须命中（返回同一对象），任一引用变化必须重算。
  const a = [...elements.slice(0, 5).map(el => el.id)];
  const first = getSelectionBounds(a, elements);
  assert.equal(getSelectionBounds(a, elements), first, '同一对引用必须命中缓存（返回同一对象）');
  const shifted = elements.map(el => ({ ...el, x: el.x + 1000 }));
  const afterShift = getSelectionBounds(a, shifted);
  assert.notEqual(afterShift, first, 'elements 引用变化必须重算');
  assert.equal(afterShift.x, first.x + 1000, '重算必须反映新的几何');
  assert.equal(afterShift.width, first.width, '整体平移不改变包围盒宽度');
  const changedSelection = [...a];
  const afterSelection = getSelectionBounds(changedSelection, elements);
  assert.notEqual(afterSelection, first, '选中集引用变化必须重算');
  log('  ✓ 选区边界：几何与参考实现逐项一致；索引口径 + 引用缓存生效');
}

// ---------------------------------------------------------------- 3. 渲染需求单一真相源
{
  const imageProxy = read('utils/imageProxy.ts');
  const canvasElement = read('components/CanvasElement.tsx');

  assert.match(imageProxy, /export const resolveImageRenderRequirement/, '必须导出统一的渲染需求判定');
  assert.match(
    imageProxy,
    /\.eligibleForOriginal;/,
    'useImageLOD 的准入条件必须取自同一个判定函数',
  );
  assert.match(
    canvasElement,
    /isSameImageRenderRequirement\(prevRequirement, nextRequirement\)/,
    'memo 必须比较整个渲染需求',
  );
  assert.match(
    canvasElement,
    /imageRendering: samplingMode/,
    'imageRendering 必须来自需求判定（就地写 zoom 比较会被 memo 漏掉）',
  );

  // 案例 A：1600×900，zoom 0.9 → 1.1。选档结果不变（都是 original），
  // 但"值得申请原图"从 false 变 true —— 旧口径会漏掉这次更新。
  const requirementAt = (width, height, zoom) => resolveImageRenderRequirement({
    width,
    height,
    zoom,
    hasThumbnail: true,
    hasOriginal: true,
  });
  const tierOnly = (width, height, zoom) => resolveImageLODTier({
    screenLongest: getImageDisplayLongestEdge(width, height, zoom),
    hasThumbnail: true,
    hasOriginal: true,
    isHighResAdmitted: true,
  });

  const a0 = requirementAt(1600, 900, 0.9);
  const a1 = requirementAt(1600, 900, 1.1);
  assert.equal(a0.desiredTier, a1.desiredTier, '案例 A：选档确实没变（这就是旧口径漏掉它的原因）');
  assert.equal(a0.eligibleForOriginal, false, '案例 A：zoom 0.9 不该申请原图（准入含 zoom > 1）');
  assert.equal(a1.eligibleForOriginal, true, '案例 A：zoom 1.1 且屏幕像素超预算 → 该申请原图');
  assert.equal(isSameImageRenderRequirement(a0, a1), false, '案例 A：需求变了，memo 必须放行重绘');
  assert.equal(tierOnly(1600, 900, 0.9), tierOnly(1600, 900, 1.1), '（反证）只看档位会判定"无变化"');

  // 案例 B：400×225，zoom 0.9 → 1.1。档位都是 standard，但采样模式该变。
  const b0 = requirementAt(400, 225, 0.9);
  const b1 = requirementAt(400, 225, 1.1);
  assert.equal(b0.desiredTier, 'standard');
  assert.equal(b1.desiredTier, 'standard');
  assert.equal(b0.samplingMode, 'optimizeQuality');
  assert.equal(b1.samplingMode, 'auto');
  assert.equal(isSameImageRenderRequirement(b0, b1), false, '案例 B：采样模式变了，memo 必须放行重绘');
  log('  ✓ 渲染需求单一真相源：两个"该重绘却被 memo 拦掉"的案例都被覆盖');
}

// ---------------------------------------------------------------- 4. 滚轮增量累加
{
  const interactions = read('hooks/useCanvasInteractions.ts');
  assert.match(interactions, /existing\.deltaX \+= nextDeltaX/, '同一帧内 deltaX 必须累加');
  assert.match(interactions, /existing\.deltaY \+= nextDeltaY/, '同一帧内 deltaY 必须累加');
  assert.match(interactions, /existing\.clientX = e\.clientX/, '锚点是绝对量，保留最新样本');
  assert.match(
    interactions,
    /if \(existing\) applyPendingWheel\(\);/,
    '同帧切换操作模式时必须先结清旧样本，否则被覆盖',
  );

  // 数学断言：总输入决定总缩放，与"怎么分组"无关。
  const delta = -33;
  const events = 60;
  const ideal = Math.pow(resolveWheelZoomFactor(delta), events);
  for (const grouping of [1, 2, 3, 5, 10, 20, 60]) {
    let zoom = 1;
    for (let f = 0; f < Math.ceil(events / grouping); f += 1) {
      let sum = 0;
      for (let e = 0; e < grouping; e += 1) sum += delta;
      zoom *= resolveWheelZoomFactor(sum);
    }
    assert.ok(Math.abs(zoom - ideal) < 1e-9, `分组 ${grouping} 的累加结果必须与总量一致`);
  }

  // 反证：覆盖口径必然丢输入（每帧 3 个事件时只剩 1/3 的输入量）。
  let overwrite = 1;
  for (let f = 0; f < 20; f += 1) overwrite *= resolveWheelZoomFactor(delta);
  const expectedTotal = Math.pow(resolveWheelZoomFactor(delta), 60);
  assert.ok(
    overwrite < expectedTotal * 0.1,
    `（反证）覆盖口径必须明显丢输入：${overwrite.toFixed(3)} vs ${expectedTotal.toFixed(3)}`,
  );
  log(`  ✓ 滚轮增量累加：各种分组结果一致；覆盖口径只剩 ${(100 * overwrite / expectedTotal).toFixed(1)}% 的输入`);
}

log('checks: ok (scale hotpaths)');
