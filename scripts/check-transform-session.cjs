// Run from project root: node scripts/check-transform-session.cjs
//
// 这一批（P1-1：缩放/旋转/裁剪/绘制的逐帧写文档问题）的自检。覆盖四件事：
// 1) utils/element-transform-session 的会话语义：逐帧只写通道、结束只交一次、
//    id 换人先复位、快照引用稳定（useSyncExternalStore 不能自激）。
// 2) utils/gesture-transform 的几何：预览与提交共用同一份实现，
//    点集元素（path / arrow / line）不会在松手时跳位置。
// 3) 预览即提交：applyGesturePreview 落进数组的就是通道里那一个对象引用。
// 4) 源码保护：变换热路径不得再写文档状态；视口索引与可见集在手势期间必须冻结；
//    裁剪/AI 旋转的白名单只认元素 id（不认逐帧在变的对象引用）。
// 注意：这是逻辑与源码检查，不替代真机的缩放/旋转/绘制手感与打断场景测试。
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  createElementTransformSessionStore,
  NO_ELEMENT_TRANSFORM_SESSION,
} = require('../utils/element-transform-session.ts');
const {
  resolveRotatedElement,
  resolveResizedElement,
  applyGesturePreview,
} = require('../utils/gesture-transform.ts');

const readSource = relative => fs.readFileSync(path.join(__dirname, relative), 'utf8');

/** 源码守卫只针对代码本身：注释里出现旧写法名不该让守卫误判。 */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const readCode = relative => stripComments(readSource(relative));

const image = (id, x, y, width, height, extra = {}) => ({
  id, type: 'image', href: 'blob:demo', width, height, x, y, mimeType: 'image/png', rotation: 0, ...extra,
});
const pathElement = (id, x, y, points) => ({
  id, type: 'path', x, y, points, strokeColor: '#111', strokeWidth: 2, rotation: 0,
});

const runStoreChecks = () => {
  const store = createElementTransformSessionStore();
  let publishes = 0;
  const seen = [];
  const unsubscribe = store.subscribe(() => {
    publishes += 1;
    seen.push(store.getSnapshot().element ? store.getSnapshot().element.id : null);
  });

  // 1. 空闲态：没有会话时必须是模块级稳定快照（引用相等 → 订阅者不白重绘）。
  assert.equal(store.isActive(), false);
  assert.equal(store.getSnapshot(), NO_ELEMENT_TRANSFORM_SESSION, '空闲快照必须是模块级常量');

  // 2. 逐帧写预览：只通知、不落文档；快照直接给出"要渲染的那一个元素"。
  const first = image('a', 0, 0, 100, 50);
  store.setPreview(first);
  assert.equal(publishes, 1);
  assert.equal(store.isActive(), true);
  assert.equal(store.getSnapshot().element, first, '快照必须给出预览对象本身');

  // 3. 同一帧重复写入（预览引用没变）不得重复发布。
  store.setPreview(first);
  assert.equal(publishes, 1, '预览引用未变不得重复发布');

  // 4. 会话内逐帧换几何：发布、且快照引用跟着换。
  const moved = image('a', 20, 10, 100, 50);
  store.setPreview(moved);
  assert.equal(publishes, 2);
  assert.equal(store.getSnapshot().element, moved);

  // 5. 会话内换元素 id = 换了手势对象：必须先复位上一段预览，再进入新元素。
  const other = image('b', 0, 0, 10, 10);
  store.setPreview(other);
  assert.ok(publishes > 2, '换元素 id 必须至少发布一次');
  assert.equal(store.getSnapshot().element, other);
  assert.deepEqual(seen.filter(id => id !== null).slice(-1), ['b'], '换人后的可见预览只能是新元素');

  // 6. end 把最终几何交给调用方，并复位预览（一次性提交的依据）。
  const finalElement = store.end();
  assert.equal(finalElement, other, 'end 必须返回最后那一个预览对象');
  assert.equal(store.isActive(), false);
  assert.equal(store.getSnapshot(), NO_ELEMENT_TRANSFORM_SESSION, 'end 必须复位预览');
  assert.equal(store.end(), null, '没有会话时 end 不得产生待提交值');

  // 7. cancel 是"放弃"：复位预览，但绝不产生待提交值。
  store.setPreview(image('c', 1, 1, 5, 5));
  store.cancel();
  assert.equal(store.isActive(), false);
  assert.equal(store.end(), null, 'cancel 之后 end 不得再交出一份几何');
  assert.equal(store.getSnapshot(), NO_ELEMENT_TRANSFORM_SESSION);

  // 8. 取消订阅后不再收到通知。
  const before = publishes;
  store.setPreview(image('d', 0, 0, 1, 1));
  assert.equal(publishes, before + 1);
  unsubscribe();
  store.setPreview(image('d', 2, 2, 1, 1));
  assert.equal(publishes, before + 1, '退订后不得再收到通知');

  // 9. dispose：清监听、复位快照（App 卸载时的收尾）。
  store.dispose();
  assert.equal(store.getSnapshot(), NO_ELEMENT_TRANSFORM_SESSION);
  assert.equal(store.isActive(), false);
  const afterDispose = publishes;
  store.setPreview(image('e', 0, 0, 1, 1));
  assert.equal(publishes, afterDispose, 'dispose 后监听已清空');

  // 10. 通道模块本体不许出现任何文档写入原语（职责边界：它只知道"一个元素现在长什么样"）。
  const storeSource = readCode('../utils/element-transform-session.ts');
  assert.doesNotMatch(storeSource, /setElements|commitAction|updateActiveBoard/,
    '变换通道不得持有或写入文档状态');
};

const runRotationChecks = () => {
  const original = image('a', 10, 20, 100, 50, { rotation: 0 });

  // 1. 角度没变（点了手柄没动）必须返回同一引用：调用方据此跳过发布与降档。
  assert.equal(resolveRotatedElement(original, 0), original);

  // 2. 角度变了：返回新对象、原对象零污染。
  const rotated = resolveRotatedElement(original, 45);
  assert.notEqual(rotated, original);
  assert.equal(rotated.rotation, 45);
  assert.equal(original.rotation, 0, '预览不得修改原元素');
  // 其它字段原样带过去：旋转一次不该丢 href / 尺寸。
  assert.equal(rotated.href, original.href);
  assert.equal(rotated.width, original.width);
  assert.equal(rotated.id, original.id);

  // 3. 没有 rotation 字段的元素类型（如 frame 之外的插件卡片）按 0 起步。
  const noRotation = { id: 'f', type: 'frame', name: 'F', x: 0, y: 0, width: 10, height: 10 };
  assert.equal(resolveRotatedElement(noRotation, 0), noRotation);
  assert.equal(resolveRotatedElement(noRotation, 90).rotation, 90);
};

const runResizeChecks = () => {
  // 1. 盒模型（image / shape / text / frame）：直接换外框，尺寸真的改了。
  const box = image('a', 10, 20, 100, 50);
  const resized = resolveResizedElement(box, {
    bounds: { x: 10, y: 20, width: 100, height: 50 },
    x: 10, y: 20, width: 200, height: 100, scaleX: 2, scaleY: 2,
  });
  assert.notEqual(resized, box);
  assert.deepEqual(
    { x: resized.x, y: resized.y, width: resized.width, height: resized.height },
    { x: 10, y: 20, width: 200, height: 100 },
  );
  assert.deepEqual(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    { x: 10, y: 20, width: 100, height: 50 },
    '预览不得修改原元素',
  );

  // 2. 从左上角拉（x/y 一起动）：外框整体跟着走。
  const draggedFromTopLeft = resolveResizedElement(box, {
    bounds: { x: 10, y: 20, width: 100, height: 50 },
    x: 0, y: 10, width: 110, height: 60, scaleX: 1.1, scaleY: 1.2,
  });
  assert.deepEqual(
    { x: draggedFromTopLeft.x, y: draggedFromTopLeft.y, width: draggedFromTopLeft.width, height: draggedFromTopLeft.height },
    { x: 0, y: 10, width: 110, height: 60 },
  );

  // 3. path：按起始 bounds 折算每个点（笔迹不能被"换外框"糊掉）。
  const stroke = pathElement('p', 0, 0, [{ x: 0, y: 0 }, { x: 50, y: 100 }]);
  const scaledStroke = resolveResizedElement(stroke, {
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    x: 10, y: 20, width: 200, height: 200, scaleX: 2, scaleY: 2,
  });
  assert.deepEqual(scaledStroke.points, [{ x: 10, y: 20 }, { x: 110, y: 220 }]);
  assert.deepEqual(stroke.points, [{ x: 0, y: 0 }, { x: 50, y: 100 }], '预览不得修改原元素');
  assert.notEqual(scaledStroke.points, stroke.points);

  // 4. arrow / line：两个端点同样折算，且仍是二元组。
  for (const type of ['arrow', 'line']) {
    const segment = {
      id: `${type}-1`, type, x: 0, y: 0,
      points: [{ x: 0, y: 0 }, { x: 100, y: 50 }],
      strokeColor: '#111', strokeWidth: 2, rotation: 0,
    };
    const next = resolveResizedElement(segment, {
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      x: 0, y: 0, width: 300, height: 100, scaleX: 3, scaleY: 2,
    });
    assert.equal(next.points.length, 2);
    assert.deepEqual(next.points, [{ x: 0, y: 0 }, { x: 300, y: 100 }]);
    assert.deepEqual(segment.points, [{ x: 0, y: 0 }, { x: 100, y: 50 }]);
  }

  // 5. group：与旧代码一致地跳过（组靠子元素各自缩放）。
  const group = { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100, rotation: 0 };
  assert.equal(resolveResizedElement(group, {
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    x: 0, y: 0, width: 200, height: 200, scaleX: 2, scaleY: 2,
  }), group);

  // 6. 没有盒模型信息的卡片（插件注册类型）：原样返回，不得凭空造尺寸。
  const noBox = { id: 'nb', type: 'shape', x: 5, y: 5, strokeColor: '#111', strokeWidth: 1, fillColor: 'none' };
  assert.equal(resolveResizedElement(noBox, {
    bounds: { x: 5, y: 5, width: 10, height: 10 },
    x: 5, y: 5, width: 20, height: 20, scaleX: 2, scaleY: 2,
  }), noBox);
};

const runPreviewApplicationChecks = () => {
  const elements = [image('a', 0, 0, 100, 50), image('b', 500, 500, 10, 10)];

  // 1. 没有预览 / 预览不在这个数组里：必须返回**入参同一引用**
  //    —— 上层（presentElements / visiblePresentElements）靠引用相等做零成本判断。
  assert.equal(applyGesturePreview(elements, null), elements);
  assert.equal(applyGesturePreview(elements, image('missing', 0, 0, 1, 1)), elements);

  // 2. 命中：整条替换那一个元素，其余元素引用不动，且不改入参数组。
  const preview = resolveResizedElement(elements[0], {
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    x: 0, y: 0, width: 400, height: 50, scaleX: 4, scaleY: 1,
  });
  const presented = applyGesturePreview(elements, preview);
  assert.notEqual(presented, elements);
  assert.equal(presented[0], preview, '呈现层拿到的必须是通道里那一个对象');
  assert.equal(presented[1], elements[1], '其余元素引用必须保持不动');
  assert.equal(elements[0].width, 100, '入参数组不得被就地改写');

  // 3. 已经在数组里的预览（重复应用）不得白造新数组。
  assert.equal(applyGesturePreview(presented, preview), presented);

  // 4. 预览即提交：松手时提交的几何与屏幕上最后一帧是**同一个对象**，
  //    所以"拿手柄松手跳一下"这件事在结构上不可能发生。
  const committed = applyGesturePreview(elements, preview).find(el => el.id === preview.id);
  assert.equal(committed, preview);
  assert.deepEqual(
    { x: committed.x, y: committed.y, width: committed.width, height: committed.height },
    { x: 0, y: 0, width: 400, height: 50 },
  );

  // 5. 几何模块本身也不许碰文档写入原语。
  const geometrySource = readCode('../utils/gesture-transform.ts');
  assert.doesNotMatch(geometrySource, /setElements|commitAction/);
};

const runSourceGuards = () => {
  const interactionSource = readCode('../hooks/useCanvasInteractions.ts');

  // 变换手势的判定面：缩放/旋转/绘制四类（含 shape/frame/arrow/line）。
  assert.match(interactionSource, /const isTransformGesture = \(mode: string \| null\): boolean => Boolean\(mode\) && \(/);
  for (const mode of ['resize-', 'rotate', 'draw', 'drawShape', 'drawFrame', 'drawArrow', 'drawLine']) {
    assert.ok(interactionSource.slice(
      interactionSource.indexOf('const isTransformGesture'),
      interactionSource.indexOf('const isTransformGesture') + 400,
    ).includes(mode), `isTransformGesture 必须覆盖 ${mode}`);
  }

  // 发布入口：有通道只写通道；没有通道才回落到旧的逐帧写文档（向后兼容路径）。
  assert.match(
    interactionSource,
    /if \(!transformSessionStore\) \{\s*setElements\(prev => prev\.map\(element => \(element\.id === preview\.id \? preview : element\)\), false\);\s*return;\s*\}\s*transformSessionStore\.setPreview\(preview\);/,
    '发布入口必须"有通道只写通道"',
  );

  // 六处逐帧发布（旋转 / 缩放 / 绘制五路）都必须走通道。
  assert.equal(
    (interactionSource.match(/publishGesturePreview\(/g) || []).length,
    6,
    '旋转 + 缩放 + 绘制五路 = 六处逐帧发布，任何一路漏掉都会退回逐帧写文档',
  );
  assert.match(interactionSource, /const preview = resolveRotatedElement\(originalElement, newRotation\);/);
  assert.match(interactionSource, /if \(preview === originalElement\) return;/, '角度没变不得发预览');
  assert.match(interactionSource, /publishGesturePreview\(resolveResizedElement\(originalElement, \{/);
  assert.match(
    interactionSource,
    /if \(scaleX === 1 && scaleY === 1\) return;/,
    '手柄没动不得发预览（旧代码这里会白写一帧文档）',
  );
  // 绘制类要在自己上一帧的预览上继续累积：读的是通道快照，不是文档。
  assert.match(interactionSource, /const readLiveElement = \(id: string\): Element \| null => \{/);
  assert.equal(
    (interactionSource.match(/readLiveElement\(/g) || []).length,
    4,
    '绘制四路（path / shape / arrow / line）必须在通道快照上累积',
  );
  assert.match(interactionSource, /const active = transformSessionStore\?\.getSnapshot\(\)\.element;/);
  assert.match(interactionSource, /return active && active\.id === id \? active : null;|if \(active && active\.id === id\) return active;/,
    '预览中元素优先取通道快照');
  assert.match(interactionSource, /return elements\.find\(element => element\.id === id\) \?\? null;/,
    '没有预览时回落到文档元素');

  // 结账：从通道取回最终几何，一次性走 commitAction（一条撤销记录）。
  assert.match(interactionSource, /const commitGestureSession = \(commitAction: \(updater: \(prev: Element\[\]\) => Element\[\]\) => void\) => \{/);
  assert.match(interactionSource, /const preview = transformSessionStore\?\.end\(\) \?\? null;/);
  assert.match(interactionSource, /commitAction\(els => els\.map\(element => \(element\.id === preview\.id \? preview : element\)\)\)/);
  assert.match(interactionSource, /commitAction\(els => els\)/, '通道为空时必须保持旧的一次性提交语义');

  // 兜底结账：丢焦点 / 切画板 / 紧接着的下一次按下都要先把通道里的几何落盘。
  assert.match(interactionSource, /const flushOrphanTransformSession = \(\): boolean => \{/);
  assert.equal(
    (interactionSource.match(/flushOrphanTransformSession\(\)/g) || []).length,
    2,
    '兜底结账必须挂在"下一次按下"与"丢焦点/切画板"两条打断路径上',
  );
  const mousedownRegion = interactionSource.slice(
    interactionSource.indexOf('const handleMouseDown'),
    interactionSource.indexOf('const handleMouseUp'),
  );
  assert.match(mousedownRegion, /flushOrphanTransformSession\(\);\s*windowDragCleanupRef\.current\?\.\(\);\s*startCanvasGesture\(e\);/,
    '新的按下开始前必须先结上一位的账');
  const cancelRegion = interactionSource.slice(interactionSource.indexOf('const cancelMouseDrag = () => {'));
  assert.match(cancelRegion.slice(0, 400), /flushOrphanTransformSession\(\);/,
    '丢焦点 / 切画板时必须先结账再丢弃手势');

  // 窗口级跟踪：指针滑出 SVG 不能就地结账，也不能丢 mouseup。
  assert.match(interactionSource, /const beginGlobalTransformGesture = \(\) => \{/);
  assert.match(
    interactionSource,
    /isTransformGesture\(interactionMode\.current\)\) \{[\s\S]{0,400}?beginGlobalTransformGesture\(\);/,
    '变换手势必须装上窗口级跟踪',
  );
  assert.match(interactionSource, /if \(isTransformGesture\(mode\)\) return;/, '滑出画布不得结束变换手势');
  const trackRegion = interactionSource.slice(interactionSource.indexOf('const beginGlobalTransformGesture'));
  assert.match(trackRegion, /owner\.addEventListener\('mousemove', onMove, true\)/);
  assert.match(trackRegion, /owner\.addEventListener\('mouseup', onUp, true\)/);
  assert.match(trackRegion, /owner\.addEventListener\('blur', onBlur\)/);
  assert.match(trackRegion, /liveWindowDragHandlersRef\.current\?\.finish\(\)/);

  // 逐行白名单：文件里剩下的 setElements 只允许这几种身份，变换热路径一帧都不许有。
  const allowedSetElements = [
    /setElements\(prev => prev\.map\(element => \(element\.id === preview\.id \? preview : element\)\), false\)/, // 无通道回落
    /setElements\(prev => \[\.\.\.prev, new(Path|Shape|Arrow|Line)\], false\)/, // 绘制起手创建（每手势一次）
    /setElements\(prev => \[newFrame, \.\.\.prev\], false\)/, // Frame 起手创建（每手势一次）
    /setElements\(prev => prev\.filter\(el => !idsToDelete\.has\(el\.id\)\), false\)/, // 橡皮擦（非变换手势，本批不在范围内）
    /setElements\(prev => \{/, // 无拖动通道的旧拖动路径（非变换手势）
  ];
  const setElementsLines = interactionSource
    .split('\n')
    .filter(line => line.includes('setElements('));
  assert.equal(setElementsLines.length, 8, 'setElements 的落点数量变了：逐帧写文档可能被重新引入');
  for (const line of setElementsLines) {
    assert.ok(
      allowedSetElements.some(pattern => pattern.test(line.trim())),
      `出现了不在白名单里的文档写入：${line.trim()}`,
    );
  }
  // 身份拆分：五处"起手创建"（每手势一次）+ 一处无通道回落 + 一处橡皮擦 + 一处旧拖动。
  assert.equal(setElementsLines.filter(line => /new(Path|Shape|Arrow|Line)|newFrame/.test(line)).length, 5,
    '绘制起手创建必须仍是"每手势一次"');
  assert.equal(setElementsLines.filter(line => /element\.id === preview\.id \? preview : element/.test(line)).length, 1,
    '无通道回落的逐帧写入只允许出现在 publishGesturePreview 里');
  assert.equal(setElementsLines.filter(line => /idsToDelete/.test(line)).length, 1, '橡皮擦路径（本批不在范围）');
  assert.equal(setElementsLines.filter(line => /prev => \{/.test(line)).length, 1, '无拖动通道的旧拖动路径（非变换手势）');
  // 各变换分支体内一个字节的文档写入都不能有（分支边界用真实源码标记切）。
  const sliceBetween = (from, to) => {
    const start = interactionSource.indexOf(from);
    const end = interactionSource.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `分支切片失败：${from} → ${to}`);
    return interactionSource.slice(start, end);
  };
  const rotateRegion = sliceBetween("if (interactionMode.current === 'rotate') {", "if (interactionMode.current === 'erase') {");
  assert.doesNotMatch(rotateRegion, /setElements|commitAction/, '旋转热路径不得写文档');
  assert.match(rotateRegion, /publishGesturePreview\(preview\);/);
  const resizeRegion = sliceBetween("interactionMode.current.startsWith('resize-')", "interactionMode.current.startsWith('crop-')");
  assert.doesNotMatch(resizeRegion, /setElements|commitAction/, '缩放热路径不得写文档');
  assert.match(resizeRegion, /publishGesturePreview\(resolveResizedElement\(originalElement, \{/);
  // 裁剪：不动文档状态，只是 UI 上的裁剪框（对象在 mouseup 时一次性裁剪）。
  const cropRegion = sliceBetween("interactionMode.current.startsWith('crop-')", 'switch(interactionMode.current) {');
  assert.doesNotMatch(cropRegion, /setElements|commitAction/, '裁剪热路径不得写文档');
  assert.match(cropRegion, /setCroppingState\(\(currentCroppingState: any\) => \{/, '裁剪只更新裁剪框状态');
  // 绘制五路：只有"起手创建那一次"（在 mousedown）允许写文档，逐帧只能发预览。
  const drawRegion = sliceBetween("case 'draw': {", "case 'dragElements': {");
  assert.equal((drawRegion.match(/setElements\(/g) || []).length, 0, '绘制热路径不得写文档');
  assert.equal((drawRegion.match(/publishGesturePreview\(/g) || []).length, 4, '绘制四路各自逐帧发预览');
  assert.equal((drawRegion.match(/readLiveElement\(/g) || []).length, 4, '绘制四路都在通道快照上累积');

  const mainCanvasSource = readCode('../components/MainCanvas.tsx');

  // 视口索引：只认 elements —— 手势期间 elements 不变，索引就重建不了。
  assert.match(
    mainCanvasSource,
    /const viewportIndex = useMemo\(\(\) => viewportIndexCacheRef\.current!\.update\(elements\), \[elements\]\)/,
    '空间索引必须只由 elements 驱动（手势期间冻结）',
  );
  assert.match(mainCanvasSource, /const transformPreview = useElementTransformSessionSnapshot\(transformSessionStore\)\.element;/);

  // 可见集：拿索引查出来的候选，不得掺入任何逐帧预览量。
  const visibleRegion = mainCanvasSource.slice(
    mainCanvasSource.indexOf('const visibleElements = useMemo'),
    mainCanvasSource.indexOf('const visiblePresentElements = useMemo'),
  );
  assert.ok(visibleRegion.length > 0);
  assert.match(visibleRegion, /viewportIndex\.query\(viewportRect, \{/);
  assert.doesNotMatch(visibleRegion, /transformPreview/, '可见集必须与变换预览无关（否则等于每帧重算）');
  assert.doesNotMatch(visibleRegion, /dragOffset|dragElementIds/, '可见集必须与拖动位移无关（拖动走呈现层）');

  // 呈现层：拖动通道 + 变换通道叠在可见子集上，两处都要用同一个替换函数。
  assert.match(
    mainCanvasSource,
    /const presentElements = useMemo\(\s*\(\) => applyGesturePreview\(applyDragPreview\(elements, dragElementIds, dragOffset\), transformPreview\)/,
  );
  assert.match(mainCanvasSource, /return applyGesturePreview\(base, transformPreview\);/);

  // 白名单与"索引快照"都必须只认 id / elements：逐帧对象引用不能进来。
  assert.match(
    mainCanvasSource,
    /\}, \[dragElementIds, editingElement, croppingElementId, aiRotationElementId, transformSessionElementId\]\);/,
    '白名单依赖必须折算成 id：croppingState / aiRotationState 的对象引用逐帧在变',
  );
  assert.match(mainCanvasSource, /const croppingElementId = croppingState \? croppingState\.elementId : null;/);
  assert.match(mainCanvasSource, /const aiRotationElementId = aiRotationState \? aiRotationState\.element\.id : null;/);
  assert.match(mainCanvasSource, /const transformSessionElementId = transformPreview \? transformPreview\.id : null;/);
  assert.match(mainCanvasSource, /if \(transformSessionElementId\) ids\.add\(transformSessionElementId\);/,
    '变换中的元素必须驻留：视口索引还是手势前的位置，不放行会在旧包围盒外掉块');
  assert.match(
    mainCanvasSource,
    /const snapshot: InteractionViewportIndexSnapshot = \{ elements, index: viewportIndex \};/,
    '交给交互层的索引快照只能由 elements 组成',
  );

  const appSource = readCode('../App.tsx');
  assert.match(appSource, /const canvasTransformSessionStore = useMemo<ElementTransformSessionStore>\(\(\) => createElementTransformSessionStore\(\), \[\]\);/);
  assert.match(appSource, /canvasTransformSessionStore\.dispose\(\)/);
  assert.match(appSource, /canvasTransformSessionStore\.cancel\(\)/, '切画板必须丢弃未结账的变换会话');
  assert.match(appSource, /canvasTransformSessionStore\.isActive\(\)/, '忙状态必须把变换会话算进去（导入/保存不得插进手势中间）');
  assert.match(appSource, /transformSessionStore: canvasTransformSessionStore/);
  assert.match(appSource, /transformSessionStore=\{canvasTransformSessionStore\}/);
};

const main = () => {
  runStoreChecks();
  runRotationChecks();
  runResizeChecks();
  runPreviewApplicationChecks();
  runSourceGuards();
  console.log('transform session checks: ok (session semantics, preview/commit geometry, frozen viewport index, hot-path source guards)');
};

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
