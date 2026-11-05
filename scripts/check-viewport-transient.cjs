// Run from project root: node scripts/check-viewport-transient.cjs
//
// 这一批（P1-B'：相机瞬时通道）的自检。覆盖两件事：
// 1) utils/viewport-store 的提交语义：手势中不写文档、结束只提交一次、渲染通道被节流。
// 2) 源码保护：热路径上不再出现"每个指针/滚轮事件都写文档状态"或"每帧强制布局"的旧写法。
// 注意：这是逻辑与源码检查，不替代实际帧率、GPU 状态与手势体验测试。
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createCanvasViewportStore,
  sameCanvasViewport,
} = require('../utils/viewport-store.ts');
const {
  createProjectChangeState,
  observeProjectBoards,
} = require('../utils/projectChangeTracker.ts');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const viewport = (x, zoom = 1) => ({ panOffset: { x, y: 0 }, zoom });

const readSource = relative => fs.readFileSync(path.join(__dirname, relative), 'utf8');

/** 源码守卫只针对代码本身：注释里出现旧写法名不该让守卫误判。 */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const readCode = relative => stripComments(readSource(relative));

const runStoreChecks = async () => {
  assert.equal(sameCanvasViewport(viewport(1, 2), viewport(1, 2)), true);
  assert.equal(sameCanvasViewport(viewport(1, 2), viewport(2, 2)), false);
  assert.equal(sameCanvasViewport(viewport(1, 2), viewport(1, 3)), false);

  const commits = [];
  // renderThrottleMs 取 200（时间上限），让 40ms 的节流下限与 120px 位移阈值成为主导，测试更确定。
  const store = createCanvasViewportStore({
    initial: viewport(0),
    onCommit: next => commits.push({ panOffset: { ...next.panOffset }, zoom: next.zoom }),
    renderThrottleMs: 200,
  });

  let renderPublishes = 0;
  let liveNotifies = 0;
  const unsubscribeRender = store.subscribeRender(() => { renderPublishes += 1; });
  const unsubscribeLive = store.subscribeLive(() => { liveNotifies += 1; });

  // 1. beginInteraction 只标记手势，不发布渲染态（否则 mousedown 瞬间会多挂载一圈卡片）。
  store.beginInteraction();
  assert.equal(store.isTransient(), true);
  assert.equal(renderPublishes, 0, '进入手势不得发布渲染态');
  assert.equal(commits.length, 0, '手势中不得提交文档状态');

  // 2. 小步位移（累计 30px < 120px 阈值）：不逐帧发布，由 40ms 节流下限兜底，只发布最终值。
  for (let frame = 1; frame <= 30; frame += 1) store.setTransient(viewport(frame));
  await delay(20);
  assert.equal(renderPublishes, 0, '节流下限内不应发布渲染态');
  await delay(40);
  assert.equal(renderPublishes, 1, '小步位移由节流下限兜底发布一次');
  assert.equal(store.getRenderState().panOffset.x, 30, '发布的是最新样本');
  assert.equal(store.getRenderState().transient, true);
  assert.equal(commits.length, 0);

  // 3. 位移超过 120px：立即发布，不等时间上限（否则快速平移会露出空白带）。
  await delay(50);
  const publishesBeforeJump = renderPublishes;
  store.setTransient(viewport(30 + 150));
  assert.equal(renderPublishes, publishesBeforeJump + 1, '位移越阈值必须立即发布');

  // 4. 方向感知 —— 放大可以迟钝：10% 的放大不重算裁剪（可见集只会变小，多挂着的卡片无害）。
  await delay(50);
  const publishesBeforeGrow = renderPublishes;
  store.setTransient({ panOffset: { x: 180, y: 0 }, zoom: 1.1 });
  assert.equal(renderPublishes, publishesBeforeGrow, '小幅放大不应重算裁剪');
  assert.equal(store.getRenderState().zoom, 1, '放大方向的渲染态保持滞后');

  // 5. 方向感知 —— 缩小阈值 = overscan 富余（RENDER_PUBLISH_ZOOM_SHRINK_RATIO=22%），
  //    且缩放手势受专用发布下限 RENDER_PUBLISH_ZOOM_MIN_MS=250ms 约束（比例阈值管不住
  //    连续缩放——平滑追随 40ms 内完成一格的 ~64%，旧值 6% 会顶着 40ms 下限每 40ms 顶格
  //    发布，每次 150 张卡全量 React 提交 = "滚动缩放卡顿"主因）。
  const publishesBeforeShrink = renderPublishes;
  store.setTransient({ panOffset: { x: 180, y: 0 }, zoom: 0.9 });
  assert.equal(renderPublishes, publishesBeforeShrink, '缩小 10%（overscan 富余内）不发布');
  store.setTransient({ panOffset: { x: 180, y: 0 }, zoom: 0.7 });
  assert.equal(renderPublishes, publishesBeforeShrink, '缩小越过 22% 也要等缩放专用下限，不立即发布');
  await delay(260);
  assert.equal(renderPublishes, publishesBeforeShrink + 1, '缩放专用下限到期后补一次发布');

  // 6. 节流下限：连续大位移也不能退化成逐帧渲染。
  store.setTransient(viewport(180));   // zoom 0.7→1 跨放大阈值，但在缩放专用下限窗口内 → 推迟
  assert.equal(renderPublishes, publishesBeforeShrink + 1, '下限窗口内的跨阈值由下限推迟');
  await delay(260);
  assert.equal(renderPublishes, publishesBeforeShrink + 2, '下限到期补发（zoom 回 1）');
  // burst：10 次同步大位移（每次间隔 <1ms，全部落在 40ms 下限窗口内）→ 至多 step1 立即
  // 发布一次 + 合并补发一次，不得退化成逐帧渲染。（不钉"恰好 0/1 次"——那依赖上一个
  // 发布距今多久，属于时序巧合；语义是"合并"而不是"免发布"。）
  const publishesBeforeBurst = renderPublishes;
  for (let step = 1; step <= 10; step += 1) store.setTransient(viewport(180 + step * 200));
  await delay(60);
  assert.ok(
    renderPublishes - publishesBeforeBurst <= 2,
    '节流下限内的大位移不得退化成逐帧渲染（10 次至多 2 次发布）',
  );
  assert.equal(store.getLive().panOffset.x, 2180);

  // 6. 即时通道：同一帧内多个样本只通知一次。
  const liveNotifiesBeforeBurst = liveNotifies;
  for (let step = 1; step <= 10; step += 1) store.setTransient(viewport(2000 + step));
  await delay(30);
  assert.equal(liveNotifies, liveNotifiesBeforeBurst + 1, '同一帧内多个样本只通知一次即时消费者');
  assert.equal(store.getLive().panOffset.x, 2010);

  // 6b. 缩放联动 pan 不是"位移"（2026-09-24 卡顿主因）：围绕视口中心连续缩放时
  //     pan 每格大幅变化（本例每步 600px，远超 120px 位移阈值），但那批内容只是
  //     换了比例 —— 只要 zoom 不跨阈值（本例累计 26.7% < 放大阈值 30%），就绝不发布。
  //     反证：去掉 scheduleRender 里的 zoomUnchanged 守卫后，40ms 兜底会让此断言失败。
  await delay(60);
  const publishesBeforeLinked = renderPublishes;
  for (let step = 1; step <= 8; step += 1) {
    const z = 1 * Math.pow(1.03, step);   // 每步 3% 放大，累计 26.7% < 30%
    store.setTransient({ panOffset: { x: 180 - 600 * step, y: 0 }, zoom: z });
  }
  assert.equal(renderPublishes, publishesBeforeLinked, '缩放联动 pan 不得触发位移发布');
  await delay(60);
  assert.equal(renderPublishes, publishesBeforeLinked, '联动期间也没有兜底发布到期');

  // 7. endInteraction：立即发布最终渲染态，且只提交一次。
  store.setTransient({ panOffset: { x: 99, y: 5 }, zoom: 2 });
  store.endInteraction();
  assert.equal(commits.length, 1, '手势结束只提交一次');
  assert.equal(commits[0].panOffset.x, 99);
  assert.equal(commits[0].zoom, 2);
  assert.equal(store.isTransient(), false);
  assert.equal(store.getRenderState().transient, false);
  assert.equal(store.getRenderState().panOffset.x, 99);

  // 8. 没有位移的手势不产生文档写入，也不发布渲染态。
  const publishesBeforeIdleGesture = renderPublishes;
  store.beginInteraction();
  store.endInteraction();
  assert.equal(commits.length, 1, '相机未变化时不应写入文档');
  assert.equal(renderPublishes, publishesBeforeIdleGesture, '无位移手势不应触发渲染发布');

  // 9. syncDocument：手势中忽略（不能覆盖未提交值），空闲时采纳。
  store.beginInteraction();
  store.setTransient(viewport(500));
  store.syncDocument(viewport(0));
  assert.equal(store.getLive().panOffset.x, 500, '手势中同步文档值必须被忽略');
  store.endInteraction();
  assert.equal(commits.length, 2);
  store.syncDocument({ panOffset: { x: 7, y: 7 }, zoom: 3 });
  assert.equal(store.getLive().zoom, 3);
  assert.equal(store.getLive().panOffset.x, 7);
  assert.equal(commits.length, 2, 'syncDocument 不是提交入口');
  const publishesBeforeSync = renderPublishes;
  store.syncDocument({ panOffset: { x: 7, y: 7 }, zoom: 3 });
  assert.equal(renderPublishes, publishesBeforeSync, '相同相机值不产生新的渲染发布');

  // 10. flush 只提交未提交的差值。
  store.flush();
  assert.equal(commits.length, 2, 'flush 在无差值时不得重复提交');
  store.setTransient(viewport(8));
  store.flush();
  assert.equal(commits.length, 3);
  assert.equal(commits[2].panOffset.x, 8);

  unsubscribeRender();
  unsubscribeLive();
  store.dispose();

  // 11. dispose 取消挂起的发布定时器，且不再向文档提交。
  const lateCommits = [];
  const lateStore = createCanvasViewportStore({
    initial: viewport(0),
    onCommit: next => lateCommits.push(next),
    renderThrottleMs: 200,
  });
  let latePublishes = 0;
  lateStore.subscribeRender(() => { latePublishes += 1; });
  lateStore.beginInteraction();
  lateStore.setTransient(viewport(10));
  lateStore.dispose();
  await delay(60);
  assert.equal(latePublishes, 0, 'dispose 必须取消挂起的发布');
  assert.equal(lateCommits.length, 0, 'dispose 后不得提交文档状态');
};

const runChangeTrackerChecks = () => {
  const baseBoards = [{ id: 'board-1', name: 'Board 1', elements: [], panOffset: { x: 0, y: 0 }, zoom: 1 }];
  const state = createProjectChangeState(baseBoards);
  assert.equal(observeProjectBoards(state, baseBoards).isDirty, false);
  // 相机字段变化不算内容变化：平移/缩放提交后项目不该变脏，更不该触发自动保存。
  assert.equal(observeProjectBoards(state, [{ ...baseBoards[0], panOffset: { x: 40, y: 12 }, zoom: 1.5 }]).isDirty, false);
  // 其它任何字段变化仍然是内容变化。
  assert.equal(observeProjectBoards(state, [{ ...baseBoards[0], elements: [{ id: 'e1' }] }]).isDirty, true);
  assert.equal(observeProjectBoards(state, [{ ...baseBoards[0], name: 'Renamed' }]).isDirty, true);
  assert.equal(observeProjectBoards(state, [{ ...baseBoards[0], operationHistoryIndex: 0 }]).isDirty, true);
  assert.equal(observeProjectBoards(state, [...baseBoards, { id: 'board-2', elements: [] }]).isDirty, true);
  assert.equal(observeProjectBoards(state, [{ id: 'board-1', name: 'Board 1', elements: [], zoom: 1 }]).isDirty, true);
};

const runSourceGuards = () => {
  const interactionSource = readCode('../hooks/useCanvasInteractions.ts');
  // 滚轮必须按 rAF 合并，禁止"每个滚轮事件写一次文档状态 + 量一次布局"。
  assert.match(interactionSource, /wheelFrameRef\.current = requestAnimationFrame\(applyPendingWheel\)/);
  assert.doesNotMatch(interactionSource, /const zoomFactor = 1\.05/, '旧的内联滚轮缩放必须移除');
  assert.doesNotMatch(
    interactionSource,
    /const rect = svgRef\.current\.getBoundingClientRect\(\);/,
    '滚轮热路径不得每个事件都强制量布局',
  );
  // 平移逐帧只写瞬时相机，手势结束才提交。
  assert.match(interactionSource, /viewportStore\.setTransient\(\{/);
  assert.match(interactionSource, /viewportStore\?\.endInteraction\(\)/);
  assert.match(interactionSource, /panGestureRef\.current/);
  // 悬浮工具条不得在交互期间做布局计算 + setState。
  // 条件必须同时覆盖 isInteracting（拖动/绘制）与 isViewportGesture（平移/滚轮）：
  // 滚轮不再置 isInteracting（那会降级所有图片的 LOD），若不覆盖相机手势，
  // 每次渲染通道发布都会重算一次工具条位置 —— 变成"缩放时每格多一次布局读取 + setState"。
  assert.match(interactionSource, /if \(isInteracting \|\| isViewportGesture\) \{[\s\S]{0,240}return;/);
  // 既有约束不能被这一批改掉。
  assert.match(interactionSource, /pointerMoveFrameRef\.current = requestAnimationFrame/);
  assert.match(interactionSource, /flushPendingPointerMove\(\)/);
  assert.match(interactionSource, /createDragSnapGuideSnapshot\(elements, idsToDrag\)/);

  const mainCanvasSource = readCode('../components/MainCanvas.tsx');
  assert.match(mainCanvasSource, /viewportGroupRef/);
  assert.match(mainCanvasSource, /viewportStore\.subscribeLive\(scheduleTransform\)/);
  assert.match(mainCanvasSource, /useCanvasViewportRenderState\(viewportStore, fallbackViewport\)/);
  assert.match(mainCanvasSource, /viewportQueryPadding/);
  assert.equal(
    (mainCanvasSource.match(/getBoundingClientRect/g) || []).length,
    1,
    'MainCanvas 只允许在尺寸测量处量一次布局',
  );
  // 既有约束：索引缓存所有权与 R14 快照端口不能被这一批改掉。
  assert.match(mainCanvasSource, /viewportIndexCacheRef\.current!\.update\(elements\)/);
  assert.match(mainCanvasSource, /interactionViewportIndexRef\?: React\.MutableRefObject/);
  assert.doesNotMatch(mainCanvasSource, /createViewportIndex\(elements\)/);

  const appSource = readCode('../App.tsx');
  assert.match(appSource, /createCanvasViewportStore/);
  assert.match(appSource, /canvasViewportStore\.syncDocument\(\{ panOffset, zoom \}\)/);
  assert.match(appSource, /const readCanvasRect = useCallback/);
  assert.match(appSource, /viewportStore=\{canvasViewportStore\}/);
  assert.match(appSource, /viewportStore: canvasViewportStore/);
  assert.match(appSource, /const handleSetActiveBoardId = useCallback/);

  const backgroundSource = readCode('../components/CanvasBackground.tsx');
  assert.doesNotMatch(
    backgroundSource,
    /panOffset|zoom/,
    '背景点阵组件不能读相机值：跟手位置由 MainCanvas 的 live 通道直接写样式',
  );
  assert.match(backgroundSource, /data-canvas-backdrop/, '点阵必须是视口 CSS 层');
  assert.doesNotMatch(readCode('../components/MainCanvas.tsx'), /400000/, '相机层不得再画 40 万像素的底板或网格');

  const presentationSource = readCode('../hooks/usePresentation.ts');
  assert.match(presentationSource, /viewportStore\.setTransient\(/);
  assert.match(presentationSource, /viewportStore\?\.endInteraction\(\)/);
};

const main = async () => {
  await runStoreChecks();
  runChangeTrackerChecks();
  runSourceGuards();
  console.log('viewport transient checks: ok (store commit semantics, camera-only dirty, hot-path source guards)');
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
