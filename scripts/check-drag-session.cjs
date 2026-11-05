// Run from project root: node scripts/check-drag-session.cjs
//
// 这一批（P1-B：拖动会话瞬时通道）的自检。覆盖三件事：
// 1) utils/drag-session-store 的会话语义：进入不发布、逐帧只写通道、结束只交一次、
//    id 集合与快照引用稳定（useSyncExternalStore 不能自激）。
// 2) utils/drag-offset 的几何：预览与提交共用同一实现，点集元素不会在松手时跳位置。
// 3) 源码保护：拖动热路径不得再写文档状态，呈现层必须走通道。
// 注意：这是逻辑与源码检查，不替代真机的拖动手感、吸附与跨 Frame 拖入测试。
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 渲染期间可能有模块读 localStorage（useSettings 等），给一个最小垫片。
const localStorageBacking = new Map();
globalThis.localStorage = {
  get length() { return localStorageBacking.size; },
  key: index => Array.from(localStorageBacking.keys())[index] ?? null,
  getItem: key => (localStorageBacking.has(String(key)) ? localStorageBacking.get(String(key)) : null),
  setItem: (key, value) => { localStorageBacking.set(String(key), String(value)); },
  removeItem: key => { localStorageBacking.delete(String(key)); },
  clear: () => { localStorageBacking.clear(); },
};
const {
  createCanvasDragSessionStore,
  hasElementDragMoved,
  DRAG_MOVED_MIN_SCREEN_PX,
  NO_DRAG_SESSION,
} = require('../utils/drag-session-store.ts');
const { applyDragOffset, applyDragPreview } = require('../utils/drag-offset.ts');
const { applyDragCommit } = require('../utils/drag-commit.ts');
const { resolveContainingFrame } = require('../utils/frame-parenting.ts');

const readSource = relative => fs.readFileSync(path.join(__dirname, relative), 'utf8');

/** 源码守卫只针对代码本身：注释里出现旧写法名不该让守卫误判。 */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const readCode = relative => stripComments(readSource(relative));

const runStoreChecks = () => {
  const store = createCanvasDragSessionStore();
  let publishes = 0;
  const unsubscribe = store.subscribe(() => { publishes += 1; });

  // 1. begin 不发布：会话起点的位移是 0，等同于静态呈现，此时通知只会白重绘一次。
  store.begin(['a', 'b']);
  assert.equal(store.isActive(), true);
  assert.equal(publishes, 0, '进入拖动会话不得触发重绘');
  assert.equal(store.getSnapshot(), NO_DRAG_SESSION, '会话起点的快照仍是空闲快照');

  // 2. 首次位移发布一次；数值没变时保持同一引用（useSyncExternalStore 靠这个避免自激）。
  store.setOffset({ x: 10, y: 0 });
  assert.equal(publishes, 1);
  const afterFirst = store.getSnapshot();
  assert.deepEqual([...afterFirst.elementIds].sort(), ['a', 'b']);
  assert.equal(afterFirst.offset.x, 10);
  store.setOffset({ x: 10, y: 0 });
  assert.equal(publishes, 1, '数值未变不得重复发布');
  assert.equal(store.getSnapshot(), afterFirst, '同值必须返回同一引用');

  // 3. 会话内 id 集合引用稳定：订阅者把它当 useMemo 依赖，每次重建会让裁剪白重算。
  const idsRef = store.getSnapshot().elementIds;
  store.setOffset({ x: 50, y: -20 });
  assert.equal(store.getSnapshot().elementIds, idsRef, '会话内 id 集合引用必须稳定');
  assert.equal(publishes, 2);

  // 4. 参考线：内容相同不发布，内容变化才发布。
  store.setGuides([{ type: 'v', position: 100, start: 0, end: 50 }]);
  assert.equal(publishes, 3);
  store.setGuides([{ type: 'v', position: 100, start: 0, end: 50 }]);
  assert.equal(publishes, 3, '相同参考线不得重复发布');
  store.setGuides([{ type: 'v', position: 101, start: 0, end: 50 }]);
  assert.equal(publishes, 4);

  // 5. end 返回最终会话（供一次性提交）并复位预览。
  const session = store.end();
  assert.deepEqual([...session.elementIds].sort(), ['a', 'b']);
  assert.deepEqual(session.offset, { x: 50, y: -20 });
  assert.equal(store.isActive(), false);
  assert.equal(store.getSnapshot(), NO_DRAG_SESSION, 'end 必须复位预览');
  assert.equal(store.end(), null, '无会话时 end 不得产生提交');

  // 6. 零位移会话仍然要交出去：点一下落在 Frame 内的元素需要走父级解析，这是既有行为。
  store.begin(['a']);
  const zeroSession = store.end();
  assert.deepEqual(zeroSession.offset, { x: 0, y: 0 });
  assert.deepEqual([...zeroSession.elementIds], ['a']);

  // 7. cancel 只复位，不产生任何待提交值（切画板/组件卸载时用）。
  store.begin(['a']);
  store.setOffset({ x: 5, y: 5 });
  store.cancel();
  assert.equal(store.isActive(), false);
  assert.equal(store.getSnapshot(), NO_DRAG_SESSION);

  // 8. 没有位移目标时参考线仍能独立存在（对齐提示不必须依附拖动会话）。
  store.setGuides([{ type: 'h', position: 20, start: 0, end: 10 }]);
  assert.equal(store.getSnapshot().guides.length, 1);
  assert.equal(store.getSnapshot().elementIds, null);
  store.setGuides([]);
  assert.equal(store.getSnapshot(), NO_DRAG_SESSION);

  // 9. 会话结束后的续拖不会继承上一次的位移。
  store.begin(['a']);
  assert.equal(store.getSnapshot(), NO_DRAG_SESSION);
  store.setOffset({ x: 7, y: 7 });
  assert.equal(store.getSnapshot().offset.x, 7);

  // 10. dispose 后不再通知任何订阅者。
  const beforeDispose = publishes;
  store.dispose();
  store.begin(['a']);
  store.setOffset({ x: 1, y: 1 });
  assert.equal(publishes, beforeDispose, 'dispose 后不得再通知');

  unsubscribe();
};

const runOffsetChecks = () => {
  const image = { id: 'i1', type: 'image', x: 10, y: 20, width: 100, height: 50 };
  const moved = applyDragOffset(image, 30, -5);
  assert.notEqual(moved, image);
  assert.deepEqual([moved.x, moved.y], [40, 15]);
  assert.equal(image.x, 10, '不得就地修改输入元素');

  // 零位移必须返回原引用：呈现层靠引用相等跳过重绘。
  assert.equal(applyDragOffset(image, 0, 0), image);

  // 点集元素的位置在 points 里而不是 x/y 里。预览与提交共用这一实现，才不会在松手时跳位置。
  const line = {
    id: 'l1', type: 'line', x: 0, y: 0,
    points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    strokeColor: '#fff', strokeWidth: 1, rotation: 0,
  };
  assert.deepEqual(
    applyDragOffset(line, 10, 10).points,
    [{ x: 11, y: 12 }, { x: 13, y: 14 }],
  );
  const pathElement = {
    id: 'p1', type: 'path', x: 0, y: 0,
    points: [{ x: 0, y: 0 }, { x: 5, y: 5 }],
    strokeColor: '#fff', strokeWidth: 1, rotation: 0,
  };
  assert.deepEqual(
    applyDragOffset(pathElement, -1, -1).points,
    [{ x: -1, y: -1 }, { x: 4, y: 4 }],
  );

  // 没有 x/y 的类型保持原引用（不能被凭空造出坐标）。
  assert.equal(applyDragOffset({ id: 'u1', type: 'unknown' }, 5, 5).x, undefined);

  // 提交侧必须用"位移后"的列表解析父级：拖动前在 Frame 外、位移后被 Frame 完整包含。
  const frame = { id: 'f1', type: 'frame', x: 0, y: 0, width: 200, height: 200, name: 'F' };
  const outside = { id: 'i2', type: 'image', x: 300, y: 300, width: 40, height: 40 };
  assert.equal(resolveContainingFrame(outside, [frame, outside], null), null);
  const inside = applyDragOffset(outside, -300, -300);
  assert.equal(resolveContainingFrame(inside, [frame, inside], null)?.id, 'f1');
};

const runCommitChecks = () => {
  const frame = { id: 'f1', type: 'frame', x: 0, y: 0, width: 500, height: 500, name: 'F' };
  const image = { id: 'i1', type: 'image', x: 400, y: 10, width: 50, height: 50 };
  const other = { id: 'i2', type: 'image', x: 0, y: 0, width: 10, height: 10 };
  const elements = [frame, image, other];
  const session = { elementIds: new Set(['i1']), offset: { x: -100, y: 20 } };

  // 最要紧的一条：预览与提交必须是同一份几何，否则松手瞬间元素会跳位置。
  const preview = applyDragPreview(elements, session.elementIds, session.offset);
  const committed = applyDragCommit(elements, session, null);
  const previewImage = preview.find(el => el.id === 'i1');
  const committedImage = committed.find(el => el.id === 'i1');
  assert.deepEqual([previewImage.x, previewImage.y], [300, 30]);
  assert.deepEqual(
    [committedImage.x, committedImage.y],
    [previewImage.x, previewImage.y],
    '提交位置必须等于预览位置',
  );

  // 不在会话里的元素保持原引用（CanvasElement 的 memo 依赖这个）。
  assert.equal(preview.find(el => el.id === 'f1'), frame);
  assert.equal(preview.find(el => el.id === 'i2'), other);
  assert.equal(committed.find(el => el.id === 'i2'), other);
  assert.equal(image.x, 400, '不得就地修改输入元素');

  // 跨 Frame 拖入：位移后落在 Frame 内就建立父级。
  assert.equal(committedImage.parentId, 'f1');

  // 拖出 Frame：父级被清掉。
  const insideElement = { id: 'i3', type: 'image', x: 10, y: 10, width: 20, height: 20, parentId: 'f1' };
  const escaped = applyDragCommit(
    [frame, insideElement],
    { elementIds: new Set(['i3']), offset: { x: 1000, y: 0 } },
    null,
  );
  assert.equal(escaped.find(el => el.id === 'i3').parentId, undefined);

  // Frame 自身不参与父级解析：Frame 不能嵌套 Frame，但位置照样位移。
  const outer = { id: 'f2', type: 'frame', x: 0, y: 0, width: 900, height: 900, name: 'Outer' };
  const inner = { id: 'f3', type: 'frame', x: 10, y: 10, width: 100, height: 100, name: 'Inner' };
  const afterFrameDrag = applyDragCommit(
    [outer, inner],
    { elementIds: new Set(['f3']), offset: { x: 20, y: 20 } },
    null,
  );
  assert.equal(afterFrameDrag.find(el => el.id === 'f3').parentId, undefined);
  assert.equal(afterFrameDrag.find(el => el.id === 'f3').x, 30);

  // 零位移：位置不动，但父级解析照常执行——点一下落在 Frame 内的元素也要归属。
  const floating = { id: 'i4', type: 'image', x: 50, y: 50, width: 20, height: 20 };
  const zero = applyDragCommit(
    [frame, floating],
    { elementIds: new Set(['i4']), offset: { x: 0, y: 0 } },
    null,
  );
  assert.equal(zero.find(el => el.id === 'i4').parentId, 'f1');

  // 零位移预览返回同一引用，拖动开始那一帧不该产生任何重绘。
  assert.equal(applyDragPreview(elements, session.elementIds, { x: 0, y: 0 }), elements);
  assert.equal(applyDragPreview(elements, null, session.offset), elements);
  assert.equal(applyDragPreview(elements, new Set(), session.offset), elements);
};

/**
 * defs 的 clipPath 是绝对坐标。圆角图片被拖动时裁剪区必须一起动，
 * 否则图片会在新位置上被旧裁剪区裁掉（整张图看不见）。
 */
const runDefsChecks = () => {
  const { hasSameRoundedImageGeometry } = require('../components/SVGDefs.tsx');

  const plain = { id: 'p', type: 'image', x: 0, y: 0, width: 10, height: 10 };
  const rounded = { id: 'r', type: 'image', x: 0, y: 0, width: 10, height: 10, borderRadius: 8 };

  assert.equal(hasSameRoundedImageGeometry([], []), true);
  assert.equal(hasSameRoundedImageGeometry([plain], [{ ...plain, x: 100 }]), true, '非圆角图片移动不该重建 defs');
  assert.equal(hasSameRoundedImageGeometry([rounded], [{ ...rounded, x: 100 }]), false, '圆角图片移动必须重建 defs');
  assert.equal(hasSameRoundedImageGeometry([rounded], [rounded]), true);
  assert.equal(hasSameRoundedImageGeometry([rounded], [{ ...rounded, borderRadius: 0 }]), false, '圆角被去掉必须重建');
  assert.equal(hasSameRoundedImageGeometry([rounded], [{ ...rounded, width: 20 }]), false, '尺寸变化必须重建');
  assert.equal(hasSameRoundedImageGeometry([rounded], []), false, '删除圆角图片必须重建');
  assert.equal(hasSameRoundedImageGeometry([plain, rounded], [rounded, plain]), true, '非圆角元素换位置不影响 defs');
  assert.equal(hasSameRoundedImageGeometry([plain, rounded], [{ ...plain, x: 5 }, rounded]), true);
  assert.equal(
    hasSameRoundedImageGeometry([{ ...rounded, id: 'a' }, { ...rounded, id: 'b' }], [{ ...rounded, id: 'b' }, { ...rounded, id: 'a' }]),
    false,
    '圆角图片之间的相对顺序变化必须重建',
  );
};

/**
 * 呈现层必须真的把位移写进 SVG，而不是只算出来。
 * 这里在 Node 里渲染一次 MainCanvas：SSR 下视口尺寸是 0×0，
 * 于是"元素能不能出现"只取决于裁剪白名单——顺带证明拖动集合真的被并进了白名单。
 */
const runPreviewRenderChecks = () => {
  const { MainCanvas } = require('../components/MainCanvas.tsx');
  const { createCanvasDragSessionStore } = require('../utils/drag-session-store.ts');

  const frame = { id: 'f1', type: 'frame', x: 0, y: 0, width: 500, height: 500, name: 'F' };
  // 刻意放到远视口之外：这样"元素有没有被渲染出来"只取决于拖动白名单，
  // 而不是默认视口 + padding 恰好把元素兜进去了。
  const image = { id: 'i1', type: 'image', x: 8000, y: 8000, width: 50, height: 50, href: 'asset://a.png' };
  const rounded = { id: 'i2', type: 'image', x: 8000, y: 8100, width: 60, height: 60, href: 'asset://b.png', borderRadius: 12 };
  const elements = [frame, image, rounded];

  const store = createCanvasDragSessionStore();
  store.begin(['i1', 'i2']);
  store.setOffset({ x: -100, y: 20 });

  const noop = () => {};
  const isElementVisible = (element, all) => {
    if (element.isVisible === false) return false;
    if (element.parentId) {
      const parent = all.find(candidate => candidate.id === element.parentId);
      if (parent) return isElementVisible(parent, all);
    }
    return true;
  };

  const previewProps = {
    svgRef: { current: null },
    elements,
    selectedElementIds: [],
    panOffset: { x: 0, y: 0 },
    zoom: 1,
    cursor: 'default',
    handleMouseDown: noop,
    handleMouseMove: noop,
    handleMouseUp: noop,
    handleWheel: noop,
    handleContextMenu: noop,
    editingElement: null,
    croppingState: null,
    aiRotationState: null,
    lassoPath: null,
    alignmentGuides: [],
    selectionBox: null,
    interactionMode: null,
    rotateStartInfo: null,
    rotateDialPoint: null,
    isElementVisible,
    setEditingElement: noop,
    handleStopEditing: noop,
    setElements: noop,
    singleSelectedElement: null,
    handleCopySelection: noop,
    handleGroup: noop,
    handleRasterizeSelection: noop,
    handleSelectionPropertyChange: noop,
    handleAlignSelection: noop,
    handleMasonryLayout: noop,
    handleCopyElement: noop,
    handleFrameAspectRatioChange: noop,
    handleUngroup: noop,
    handleMergeGroup: noop,
    handleDownloadImage: noop,
    handleStartCrop: noop,
    handlePropertyChange: noop,
    handleDeleteElement: noop,
    isActivePresentation: false,
    t: key => key,
    isInteracting: true,
    dragSessionStore: store,
  };
  const html = renderToStaticMarkup(React.createElement(MainCanvas, previewProps)).replace(/\s+/g, '');

  // 元素既不在视口里（SSR 视口 0×0）、也不在选中集里，能出现只可能是拖动白名单生效。
  assert.match(html, /data-element-id="i1"/, '拖动中的元素被裁剪掉了：裁剪白名单没有合并拖动集合');
  assert.match(html, /x="7900"y="8020"/, '拖动中的元素没有按位移后的位置呈现');
  // 圆角图片的裁剪区是绝对坐标，必须一起位移；不动的话图片会在新位置上被裁没。
  assert.match(html, /id="clip-i2"><rectx="7900"y="8120"/, '圆角图片的 clipPath 没有跟着拖动位移');

  // 拖动中周边控件让位（用户需求）。手柄只在单选时出现，这里用同一份拖动会话单测一次：
  // 拖动中不得再渲染手柄，松手后必须回来（见下方 afterCommit 断言）。
  const singleDragHtml = renderToStaticMarkup(React.createElement(MainCanvas,
    { ...previewProps, selectedElementIds: ['i1'] })).replace(/\s+/g, '');
  assert.doesNotMatch(singleDragHtml, /data-handle/,
    '拖动中图片周边不得残留缩放手柄/旋转手柄');

  // The flat image-batch fast path keeps each image's props and its base x/y
  // unchanged until commit, translating its SVG wrapper instead. The selection
  // outline still uses the moved preview geometry.
  const fastProps = { ...previewProps, elements: [frame, image, { ...rounded, borderRadius: 0 }], selectedElementIds: ['i1', 'i2'] };
  const fastHtml = renderToStaticMarkup(React.createElement(MainCanvas, fastProps)).replace(/\s+/g, '');
  assert.equal((fastHtml.match(/transform="translate\(-10020\)"/g) || []).length, 2, 'both selected images move as wrappers');
  assert.match(fastHtml, /data-bp-drag-x="-100"data-bp-drag-y="20"/, 'imperative viewport culling can account for drag offset');
  assert.match(fastHtml, /x="8000"y="8000"/, 'image data and intrinsic geometry stay unchanged during drag');
  assert.match(fastHtml, /x="7900"y="8020"/, 'selection bounds still follow the moved image batch');
  assert.doesNotMatch(fastHtml, /id="clip-i2"/, 'non-rounded images do not need clip paths');

  const roundedBatchHtml = renderToStaticMarkup(React.createElement(MainCanvas,
    { ...previewProps, selectedElementIds: ['i1', 'i2'] })).replace(/\s+/g, '');
  assert.doesNotMatch(roundedBatchHtml, /data-bp-drag-x="-100"/,
    'rounded images must keep geometric preview so their absolute clip paths stay aligned');
  assert.match(roundedBatchHtml, /id="clip-i2"><rectx="7900"y="8120"/);

  store.end();

  // Single images, single videos and mixed media must use stable card geometry
  // too. A frame-by-frame x/y rewrite defeats CanvasElement's reference memo.
  const video = { id: 'v1', type: 'video', x: 8200, y: 8000, width: 80, height: 60, href: 'asset://v.mp4', mimeType: 'video/mp4' };
  const htmlCards = ['code', 'markdown', 'model3d', 'audio', 'file', 'bookmark', 'plugin-node'].map(type => ({
    ...video, id: `html-${type}`, type, content: '', url: 'https://example.com', nodeType: 'test.missing', data: {},
  }));
  for (const media of [[image], [video], [image, video], ...htmlCards.map(card => [card]), [video, ...htmlCards]]) {
    const mediaIds = media.map(element => element.id);
    store.begin(mediaIds);
    store.setOffset({ x: -100, y: 20 });
    const mediaHtml = renderToStaticMarkup(React.createElement(MainCanvas, {
      ...previewProps, elements: media, selectedElementIds: mediaIds,
    })).replace(/\s+/g, '');
    assert.equal((mediaHtml.match(/data-bp-drag-x="-100"data-bp-drag-y="20"/g) || []).length,
      media.length, 'single and mixed media move via wrappers');
    for (const element of media) {
      assert.match(mediaHtml, new RegExp(`data-id="${element.id}"data-cull-x="${element.x}"data-cull-y="${element.y}"`),
        'media card geometry remains at the stable document position');
    }
    store.end();
  }

  // 会话结束后同一份输入必须回到文档位置（预览不残留）。
  const afterCommit = renderToStaticMarkup(React.createElement(MainCanvas, {
    svgRef: { current: null },
    elements,
    selectedElementIds: ['i1'],
    panOffset: { x: 0, y: 0 },
    zoom: 1,
    cursor: 'default',
    handleMouseDown: noop,
    handleMouseMove: noop,
    handleMouseUp: noop,
    handleWheel: noop,
    handleContextMenu: noop,
    editingElement: null,
    croppingState: null,
    aiRotationState: null,
    lassoPath: null,
    alignmentGuides: [],
    selectionBox: null,
    interactionMode: null,
    rotateStartInfo: null,
    rotateDialPoint: null,
    isElementVisible,
    setEditingElement: noop,
    handleStopEditing: noop,
    setElements: noop,
    singleSelectedElement: image,
    handleCopySelection: noop,
    handleGroup: noop,
    handleRasterizeSelection: noop,
    handleSelectionPropertyChange: noop,
    handleAlignSelection: noop,
    handleMasonryLayout: noop,
    handleCopyElement: noop,
    handleFrameAspectRatioChange: noop,
    handleUngroup: noop,
    handleMergeGroup: noop,
    handleDownloadImage: noop,
    handleStartCrop: noop,
    handlePropertyChange: noop,
    handleDeleteElement: noop,
    isActivePresentation: false,
    t: key => key,
    isInteracting: false,
    dragSessionStore: store,
  })).replace(/\s+/g, '');

  assert.match(afterCommit, /x="8000"y="8000"/, '会话结束后预览必须复位，元素回到文档位置');
  assert.match(afterCommit, /data-handle="rotate"/,
    '松手（会话结束）后缩放手柄/旋转手柄必须回来，不能在非拖动状态下也隐藏');
};

/**
 * 拖动中周边控件让位（用户需求：拖动图片时隐藏选区工具条 / 缩放手柄 / 智能工具条）。
 * 判据必须是"位移已经可见"而不是"会话已开始"，否则纯点击（mousedown 未移动）会让控件闪一下。
 */
const runDragChromeChecks = () => {
  const session = (x, y) => ({
    elementIds: new Set(['a']),
    offset: { x, y },
    guides: [],
  });

  assert.equal(hasElementDragMoved(NO_DRAG_SESSION, 1), false, '无会话不得判为拖动中');
  assert.equal(hasElementDragMoved(session(0, 0), 1), false, '零位移（纯点击）不得让周边控件闪一下');
  assert.equal(hasElementDragMoved(session(1, 0), 1), false, '1px 手抖仍按未移动处理');
  assert.equal(hasElementDragMoved(session(DRAG_MOVED_MIN_SCREEN_PX, 0), 1), true, '位移可见即让位');
  assert.equal(
    hasElementDragMoved(session(DRAG_MOVED_MIN_SCREEN_PX, 0), 0.1),
    false,
    '阈值按屏幕像素算：缩放到 10% 时 2 画布像素只有 0.2 屏幕像素',
  );
};

const runSourceGuards = () => {
  const interactionSource = readCode('../hooks/useCanvasInteractions.ts');

  // 进入会话 + 逐帧只写通道。
  assert.match(interactionSource, /dragSessionStore\?\.begin\(idsToDrag\)/);
  assert.match(interactionSource, /dragSessionStore\.setOffset\(\{ x: finalDx, y: finalDy \}\)/);

  // 拖动快路径里不得出现任何文档写入，且必须在落到旧路径之前就 break。
  const fastPath = interactionSource.match(
    /if \(dragSessionStore\) \{\s*dragSessionStore\.setOffset\(\{ x: finalDx, y: finalDy \}\);\s*break;\s*\}/,
  );
  assert.ok(fastPath, '拖动快路径必须存在，且只能"写通道 + 提前结束"');
  assert.doesNotMatch(fastPath[0], /setElements|commitAction|updateActiveBoard/, '拖动快路径不得写文档状态');

  // 对齐参考线在热路径上不许再直接 setState（每帧拉起整棵 App）。
  assert.doesNotMatch(interactionSource, /setAlignmentGuides\(activeGuides\)/, '参考线热路径必须走通道/去重');
  assert.match(interactionSource, /publishAlignmentGuides\(activeGuides\)/);
  assert.match(interactionSource, /dragSessionStore\.setGuides\(guides\)/);

  // 结束会话后一次性提交：位移与父级解析都走同一个入口，且候选索引显式放弃（位置已过期的快照）。
  assert.match(interactionSource, /const dragSession = dragSessionStore \? dragSessionStore\.end\(\) : null/);
  assert.match(interactionSource, /commitAction\(els => applyDragCommit\(els, dragSession, null\)\)/);

  // 旧路径（无通道）必须原样保留：位置逐帧已写文档，这里只补父级，便于按文件回滚。
  assert.match(interactionSource, /resolveContainingFrame\(el, els, interactionViewportIndexRef\?\.current \?\? null\)/);
  assert.match(interactionSource, /setElements\(prev => \{/);
  assert.match(interactionSource, /dragSnapGuideSnapshot\.advance\(nextElements\)/);
  assert.match(interactionSource, /createDragSnapGuideSnapshot\(elements, idsToDrag\)/);

  const commitSource = readCode('../utils/drag-commit.ts');
  assert.match(commitSource, /const movedElements = isZeroDragOffset\(offset\)/);
  assert.match(commitSource, /createContainingFrameResolver\(movedElements, frameCandidateSnapshot\)/);
  assert.match(commitSource, /const containingFrame = resolveFrame\(element\)/);
  assert.match(commitSource, /element\.type === 'frame'/, 'Frame 自身不参与父级解析');
  assert.doesNotMatch(commitSource, /interactionViewportIndexRef|setElements|commitAction/, '提交层不得自己碰索引端口或文档写入');

  // Leaving the SVG while a card is held must not commit it at the edge.
  // A window-level mouseup (outside SVG) flushes the final move once; focus
  // loss / missed mouseup roll back the transient preview instead.
  assert.match(interactionSource, /owner\.addEventListener\('mousemove', onMove, true\)/);
  assert.match(interactionSource, /owner\.addEventListener\('mouseup', onUp, true\)/);
  assert.match(interactionSource, /owner\.addEventListener\('blur', onBlur\)/);
  assert.match(interactionSource, /const cancelMouseDrag = \(\) =>/);
  assert.match(interactionSource, /dragSessionStore\.cancel\(\)/);
  assert.match(interactionSource, /!dragSessionStore\.isActive\(\)/);
  const mainCanvasSource = readCode('../components/MainCanvas.tsx');
  assert.doesNotMatch(mainCanvasSource, /onMouseLeave=\{handleMouseUp\}/, 'SVG leave must not end an active drag');
  // 边界收尾改由 handleCanvasMouseLeave 集中裁决：拖动（dragElements）/ 平移（pan）/
  // 框选与套索（selectBox・lasso）一律放行，由窗口级监听等到真正的 mouseup。
  assert.match(mainCanvasSource, /onMouseLeave=\{handleMouseLeave\}/, 'SVG leave must route through the boundary-aware handler');
  assert.match(interactionSource, /const handleCanvasMouseLeave = \(\) =>/, 'the canvas-leave verdict must live next to the gesture state machine');
  assert.match(interactionSource, /if \(mode === 'pan' \|\| isSelectionBoxGesture\(mode\)\) return;/, 'SVG leave must keep element drag, pan AND marquee/lasso alive until global mouseup');
  assert.match(interactionSource, /if \(mode === 'dragElements' && dragSessionStore\?\.isActive\(\)\) return;/, 'SVG leave must keep element drag alive until global mouseup');
  assert.match(mainCanvasSource, /useCanvasDragSessionSnapshot\(dragSessionStore\)/);
  assert.match(mainCanvasSource, /const presentElements = useMemo/);
  assert.match(mainCanvasSource, /applyDragPreview\(elements, dragElementIds, dragOffset\)/);
  assert.match(mainCanvasSource, /const visiblePresentElements = useMemo/);
  assert.match(mainCanvasSource, /const interactionIncludeIds = useMemo/);
  // 白名单语义变了（P1-H）：不再并入整个选中集，只放行"必须驻留"的交互对象。
  // 这里守的仍然是同一条要求 —— 拖动集必须在白名单里，否则被拖动的 Frame 后代一出视口就掉块。
  // 完整的白名单口径断言在 scripts/check-scale-hotpaths.cjs。
  assert.match(mainCanvasSource, /dragElementIds\.forEach\(id => ids\.add\(id\)\)/);
  assert.ok(
    (mainCanvasSource.match(/includeElementIds: viewportIncludeIds/g) || []).length === 1,
    '裁剪白名单必须合并拖动集合，否则被拖动的 Frame 后代一出视口就掉块',
  );
  assert.ok(
    (mainCanvasSource.match(/elements=\{presentElements\}/g) || []).length >= 2,
    '绝对坐标的 defs 和选择手柄仍须拿位移后的列表',
  );
  // React 19 dev deep-diffs changed props. A full moving element array passed to
  // each card multiplied the cost of the original image URLs on every drag frame.
  assert.match(mainCanvasSource, /elements=\{el\.type === 'group' \? presentElements : elements\}/);
  assert.match(mainCanvasSource, /const translateImageBatch = useMemo/);
  assert.match(mainCanvasSource, /transform=\{movesByTransform \? `translate\(/,
    'flat image batches should move wrappers rather than re-render each image');
  assert.match(mainCanvasSource, /data-bp-drag-x=\{movesByTransform/);
  assert.match(mainCanvasSource, /visiblePresentElements\.map\(el =>/);
  assert.match(
    mainCanvasSource,
    /<SVGDefs elements=\{presentElements\} \/>/,
    'defs 的 clipPath 是绝对坐标，必须拿呈现层',
  );

  const appSource = readCode('../App.tsx');
  assert.match(appSource, /createCanvasDragSessionStore/);
  assert.match(appSource, /dragSessionStore: canvasDragSessionStore/);
  assert.match(appSource, /dragSessionStore=\{canvasDragSessionStore\}/);
  assert.match(appSource, /canvasDragSessionStore\.cancel\(\)/);

  // 拖动中周边控件让位：状态只从通道派生一次，三个消费点都不得各自判断。
  assert.match(
    interactionSource,
    /const isDraggingElements = useElementDragMoved\(dragSessionStore, zoom\)/,
    '让位状态必须从拖动通道订阅，不得用 isInteracting 之类的手势状态顶替',
  );
  assert.match(
    interactionSource,
    /if \(isDraggingElements\) \{\s*setSmartToolbarState\(prev => \(prev\.show \? \{ \.\.\.prev, show: false \} : prev\)\);\s*return;\s*\}/,
    '拖动中必须隐藏智能工具条（它贴在选区右侧，会跟着图片一起走）',
  );
  assert.match(mainCanvasSource, /const isDraggingElements = hasElementDragMoved\(dragSession, viewportZoom\)/);
  assert.match(mainCanvasSource, /toolbarKernel && !isDraggingElements && \(/, '拖动中必须卸掉选区工具条');
  assert.match(mainCanvasSource, /isDragging=\{isDraggingElements\}/, '拖动中必须把让位状态传给 SelectionHandles');

  const handlesSource = readCode('../components/SelectionHandles.tsx');
  assert.match(handlesSource, /\{!isDragging && \(/, '拖动中必须隐藏缩放手柄与旋转手柄');
  assert.match(handlesSource, /isDragging = false/, '让位开关必须有默认值：不传的调用方行为不变');
};

const main = () => {
  runStoreChecks();
  runOffsetChecks();
  runCommitChecks();
  runDefsChecks();
  runPreviewRenderChecks();
  runDragChromeChecks();
  runSourceGuards();
  console.log('drag session checks: ok (session semantics, preview/commit geometry, defs clipPath, rendered preview, drag chrome visibility, hot-path source guards)');
};

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
