// Run from project root: node scripts/check-wheel-zoom.cjs
//
// 滚轮缩放手感（本批：倍率 + 平滑追随 + 不再降级图片 LOD）的自检。覆盖三件事：
// 1) 输入换算：一格滚轮的倍率、deltaMode 归一化、"触控板连续小 delta"与"整格"等价；
// 2) 平滑追随语义：渐进而非跳变、会收敛、**锚点不漂移**、未收敛时提交目标值、手势中不写文档；
// 3) 源码守卫：滚轮不得改写 isInteracting（那会让每张图降级并 release 高清原图）、
//    缩放必须基于目标累积并走平滑通道、滚轮平移必须保持 1:1 跟手。
// 注意：这是逻辑与源码检查，不替代真机手感、帧率与 GPU 状态测试。
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  WHEEL_NOTCH_DELTA_PX,
  WHEEL_ZOOM_RATIO_PER_NOTCH,
  normalizeWheelDelta,
  resolveWheelZoomFactor,
} = require('../utils/wheel-input.ts');
const { createCanvasViewportStore } = require('../utils/viewport-store.ts');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const viewport = (x, zoom = 1) => ({ panOffset: { x, y: 0 }, zoom });

const readSource = relative => fs.readFileSync(path.join(__dirname, relative), 'utf8');

/** 源码守卫只针对代码本身：注释里提到旧写法名不该让守卫误判。 */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const readCode = relative => stripComments(readSource(relative));

const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

const runInputChecks = () => {
  // 一格向上 = 放大 25%（原实现是 5%，这是"要滚 4~6 次"的直接原因）。
  assert.equal(WHEEL_NOTCH_DELTA_PX, 100);
  assert.ok(close(resolveWheelZoomFactor(-WHEEL_NOTCH_DELTA_PX), WHEEL_ZOOM_RATIO_PER_NOTCH));
  assert.ok(close(resolveWheelZoomFactor(-100), 1.25), '一格上滚必须放大 25%');
  assert.ok(close(resolveWheelZoomFactor(100), 0.8), '一格下滚必须缩小到 80%');
  assert.ok(close(resolveWheelZoomFactor(-200), 1.5625), '两格 = 1.25²');
  assert.ok(close(resolveWheelZoomFactor(0), 1), '没有 delta 就没有缩放');

  // 触控板（连续小 delta）与鼠标（整格）必须落在同一条曲线上：
  // 十次 -10 的累积倍率等于一次 -100，否则两种设备的缩放速度会不一致。
  const tenSmallSteps = Array.from({ length: 10 })
    .reduce(factor => factor * resolveWheelZoomFactor(-10), 1);
  assert.ok(close(tenSmallSteps, resolveWheelZoomFactor(-100), 1e-12), '触控板累积必须等价于整格');

  // 单调性：deltaY 越负（越向上）倍率越大。
  assert.ok(resolveWheelZoomFactor(-150) > resolveWheelZoomFactor(-50));
  assert.ok(resolveWheelZoomFactor(-50) > resolveWheelZoomFactor(50));

  // deltaMode 归一化：行模式不折算的话，一格（deltaY=3）只有 0.66% 的缩放，滚轮形同失效。
  assert.equal(normalizeWheelDelta(100, 0), 100, '像素模式原样');
  assert.equal(normalizeWheelDelta(3, 1), 48, '行模式按 16px/行折算');
  assert.equal(normalizeWheelDelta(1, 2), 100, '页模式保守按 100px');
  assert.ok(
    resolveWheelZoomFactor(-normalizeWheelDelta(3, 1)) > 1.1,
    '行模式下滚一格必须产生可感知的缩放（原实现只有 1.007）',
  );
};

const runSmoothFollowChecks = async () => {
  const commits = [];
  const store = createCanvasViewportStore({
    initial: viewport(0),
    onCommit: next => commits.push({ panOffset: { ...next.panOffset }, zoom: next.zoom }),
  });
  store.beginInteraction();
  assert.equal(store.getTarget().zoom, 1, '空闲时目标与 live 同值');

  // 1. 设目标不会立刻跳变：第一帧之前 live 仍是旧值（离散滚轮事件 → 连续运动的起点）。
  store.setSmoothTarget({ panOffset: { x: -100, y: -75 }, zoom: 1.25 });
  assert.equal(store.getLive().zoom, 1, '设目标的同一 tick 不应直接跳到位');
  assert.equal(commits.length, 0, '平滑追随期间不得写文档');

  // 2. 逐帧渐进：中间态落在两端之间、单调、不越过目标。
  const samples = [];
  for (let step = 0; step < 8; step += 1) {
    await delay(20);
    samples.push(store.getLive().zoom);
  }
  assert.ok(samples[0] > 1 && samples[0] < 1.25, `追随必须是渐进的，实际 ${samples[0]}`);
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index] >= samples[index - 1], '追随过程必须单调不回落');
    assert.ok(samples[index] <= 1.25 + 1e-12, '追随不得越过目标（避免过冲抖动）');
  }

  // 3. **锚点不漂移**：滚轮缩放的目标值由"鼠标下的世界点不动"定出（pan 是 zoom 的仿射函数）。
  //    zoom 与 pan 用同一系数插值时，中间帧的世界点必须与起点一致 ——
  //    否则追随期间画面会在光标下缓慢平移，比不平滑更难用。
  const mouseX = 400;
  const p1 = { x: mouseX - mouseX * 1.25, y: 0 };
  const anchorStore = createCanvasViewportStore({
    initial: viewport(0),
    onCommit: () => {},
  });
  anchorStore.beginInteraction();
  anchorStore.setSmoothTarget({ panOffset: p1, zoom: 1.25 });
  for (let step = 0; step < 8; step += 1) {
    await delay(20);
    const live = anchorStore.getLive();
    const worldX = (mouseX - live.panOffset.x) / live.zoom;
    assert.ok(
      Math.abs(worldX - mouseX) < 0.01,
      `追随期间锚点漂移：鼠标下世界点 ${worldX.toFixed(4)}，期望 ${mouseX}`,
    );
  }
  anchorStore.dispose();

  // 4. 收敛：跟随到位后 live 与目标完全相等，且不再有 rAF 挂着（用"再等一段也无变化"验证）。
  await delay(300);
  assert.equal(store.getLive().zoom, 1.25, '必须收敛到目标值');
  assert.ok(close(store.getLive().panOffset.x, -100), '收敛时 pan 也要到位');
  assert.equal(commits.length, 0, '收敛本身不是提交时机（手势结束才提交）');

  // 5. 未收敛就结束手势：提交的必须是用户滚到的**目标**，而不是中途某一帧。
  const midCommits = [];
  const midStore = createCanvasViewportStore({ initial: viewport(0), onCommit: next => midCommits.push(next) });
  midStore.beginInteraction();
  midStore.setSmoothTarget({ panOffset: { x: 60, y: 0 }, zoom: 2 });
  await delay(20); // 只走一帧，仍在追随中
  assert.ok(midStore.getLive().zoom < 2, '前置条件：此时应尚未收敛');
  midStore.endInteraction();
  assert.equal(midCommits.length, 1, '结束手势只提交一次');
  assert.equal(midCommits[0].zoom, 2, '未收敛时必须提交目标值（否则视图会停在半路）');
  assert.equal(midStore.getLive().zoom, 2, '提交后 live 必须对齐目标');

  // 6. 目标必须跟随 1:1 跟手通道：平移把相机移到别处后，下一次滚轮不该从过期目标起算。
  const followStore = createCanvasViewportStore({ initial: viewport(0), onCommit: () => {} });
  followStore.beginInteraction();
  followStore.setTransient(viewport(500, 3));
  assert.deepEqual(
    { zoom: followStore.getTarget().zoom, x: followStore.getTarget().panOffset.x },
    { zoom: 3, x: 500 },
    'setTransient 后目标必须与 live 对齐',
  );
  followStore.dispose();

  store.dispose();
};

const runSourceGuards = () => {
  const interactionCode = readCode('../hooks/useCanvasInteractions.ts');
  const wheelHandler = interactionCode.match(/const handleWheel = [\s\S]*?const handleTouchStart/);
  assert.ok(wheelHandler, '必须能定位到 handleWheel');
  const wheelBody = wheelHandler[0];

  // 本批的核心修复：滚轮不得改写 isInteracting。
  // isInteracting 是图片 LOD 的降级开关（会 release 掉高清原图），滚轮一进一出
  // 等于让所有图片降级再重新解码 —— 那是"掉帧感"的直接来源。
  assert.doesNotMatch(
    wheelBody,
    /setIsInteracting/,
    '滚轮不得改写 isInteracting（会让所有图片降级并 release 高清原图）',
  );
  assert.match(wheelBody, /setIsViewportGesture\(true\)/, '滚轮仍要标记相机手势');
  assert.match(
    wheelBody,
    /normalizeWheelDelta\(e\.deltaX, e\.deltaMode\)/,
    'deltaX 必须归一化',
  );
  assert.match(
    wheelBody,
    /normalizeWheelDelta\(e\.deltaY, e\.deltaMode\)/,
    'deltaY 必须归一化',
  );

  // 缩放基于"平滑目标"累积（拿 live 当基准会让滚得越快越黏），且必须走平滑通道；
  // 滚轮平移是触控板两指滑动，必须保持 1:1 跟手。
  assert.match(
    interactionCode,
    /const zoomBase = viewportStore \? viewportStore\.getTarget\(\) : liveBase;/,
    '缩放必须基于目标累积',
  );
  assert.match(
    interactionCode,
    /viewportStore\.setSmoothTarget\(\{ zoom: nextZoom, panOffset: nextPan \}\)/,
    '缩放必须走平滑通道',
  );
  assert.match(
    interactionCode,
    /viewportStore\.setTransient\(\{ zoom: liveBase\.zoom, panOffset: nextPan \}\)/,
    '滚轮平移必须保持 1:1 跟手（不加平滑）',
  );
  assert.match(
    interactionCode,
    /Math\.min\(zoomBase\.zoom \* resolveWheelZoomFactor\(pending\.deltaY\), MAX_CANVAS_ZOOM\)/,
    '缩放算式必须使用抽出来的换算函数',
  );

  // 手感常数只能有一处定义（utils/wheel-input），否则改一处漏一处。
  assert.doesNotMatch(interactionCode, /WHEEL_ZOOM_EXPONENT_PER_DELTA/);
  assert.doesNotMatch(interactionCode, /WHEEL_ZOOM_RATIO_PER_NOTCH/);

  // 滚轮期间悬浮工具条必须隐藏（否则每次渲染通道发布都要读一次布局并 setState）。
  assert.match(
    interactionCode,
    /if \(isInteracting \|\| isViewportGesture\) \{/,
    '工具条冻结条件必须覆盖相机手势（含滚轮）',
  );

  const storeCode = readCode('../utils/viewport-store.ts');
  // 方向感知：缩小敏感（否则边缘露白），放大迟钝（可见集只会变小）。
  assert.match(storeCode, /const shrinking = live\.zoom < renderState\.zoom;/);
  assert.match(storeCode, /shrinking \? RENDER_PUBLISH_ZOOM_SHRINK_RATIO : RENDER_PUBLISH_ZOOM_GROW_RATIO/);
  assert.ok(
    /RENDER_PUBLISH_ZOOM_SHRINK_RATIO = 0\.22/.test(storeCode)
      && /RENDER_PUBLISH_ZOOM_GROW_RATIO = 0\.3/.test(storeCode),
    '缩放发布阈值必须按方向分离（缩小阈值 = overscan 富余，2026-09-24 从 0.06 上调）',
  );
  // 缩放手势专用发布下限：比例阈值管不住连续缩放（平滑追随 40ms 内完成一格的 ~64%），
  // 必须用时间下限把 React 提交频率钉在 ~4 次/秒，否则"图片一多滚动缩放就卡"。
  assert.match(storeCode, /RENDER_PUBLISH_ZOOM_MIN_MS = 250/);
  assert.match(storeCode, /const zooming = live\.zoom !== renderState\.zoom;/);
  assert.match(storeCode, /const minMs = zooming \? RENDER_PUBLISH_ZOOM_MIN_MS : RENDER_PUBLISH_MIN_MS;/);
  // 位移判据不得被缩放联动 pan 触发（pan 随缩放变化不是新内容）。
  assert.match(storeCode, /const zoomUnchanged = live\.zoom === renderState\.zoom;/);
  assert.match(storeCode, /const movedEnough = zoomUnchanged && \(/);
};

const main = async () => {
  runInputChecks();
  await runSmoothFollowChecks();
  runSourceGuards();
  console.log('wheel zoom checks: ok (notch ratio, deltaMode, smooth follow, anchor stability, source guards)');
};

void main();
