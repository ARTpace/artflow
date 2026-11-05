// Run from the project root: node scripts/check-bulk-image-safety.cjs
// Memory guard, undo isolation, asset dedup, cache caps, and honest LoAF reports.
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MiB = 1024 * 1024;
const { assessImageImportBudget } = require('../utils/image-import-budget.ts');
const { createImportMasonry, shouldFlushImportBatch, IMPORT_BATCH_TARGET_BYTES } = require('../utils/batchImport.ts');
const fullDrop = Array.from({ length: 64 }, () => ({ size: 8 * MiB }));
assert.equal(assessImageImportBudget(fullDrop).allowed, true, '512 MB is not a fixed drop limit');
assert.equal(assessImageImportBudget([{ size: 300 * MiB }], { usedJSHeapSize: 512 * MiB, jsHeapSizeLimit: 4096 * MiB }).allowed, true,
  'a single large file is allowed if the actual heap has headroom');
assert.equal(assessImageImportBudget([{ size: 8 * MiB }], { usedJSHeapSize: 4000 * MiB, jsHeapSizeLimit: 4096 * MiB }).reason, 'low-heap');
assert.equal(assessImageImportBudget([{ size: 300 * 1024 }], { usedJSHeapSize: 4096 * MiB, jsHeapSizeLimit: 4096 * MiB }).reason, 'low-heap');
let filesInBatch = 0;
let batchBytes = 0;
let flushes = 0;
for (const file of fullDrop) {
  filesInBatch++;
  batchBytes += file.size;
  if (shouldFlushImportBatch(filesInBatch, batchBytes)) { flushes++; filesInBatch = 0; batchBytes = 0; }
}
assert.ok(flushes >= 16, 'large drop must be painted in bounded working batches');
assert.equal(shouldFlushImportBatch(1, IMPORT_BATCH_TARGET_BYTES + 1), true, 'oversized single file must be handled as its own batch, not refused');
const masonry = createImportMasonry(fullDrop.length, { x: 100, y: 200 });
const placed = fullDrop.map((_, index) => masonry.place({ type: 'image', width: 800, height: index % 2 ? 1200 : 600 }));
assert.equal(placed.length, 64);
for (const [index, left] of placed.entries()) {
  assert.ok(placed.slice(index + 1).every(right => left.x + left.w <= right.x || right.x + right.w <= left.x
    || left.y + left.h <= right.y || right.y + right.h <= left.y), 'streaming masonry must never overlap items');
}
console.log('PASS 512 MB drop partitions without a total cap, with per-file heap protection and stable incremental layout');

const { cloneElement, createCanvasOperation, applyCanvasOperation } = require('../utils/operationHistory.ts');
const original = {
  id: 'photo', type: 'image', x: 1, y: 2, width: 400, height: 300,
  href: 'data:image/jpeg;base64,standard',
  thumbnailHref: 'data:image/jpeg;base64,thumb',
  mediumHref: 'data:image/jpeg;base64,medium',
  originalHref: 'data:image/jpeg;base64,original',
  mimeType: 'image/jpeg', tags: ['alpha'],
};
const savedClone = global.structuredClone;
let metadataClones = 0;
try {
  global.structuredClone = value => {
    assert.equal(Object.prototype.hasOwnProperty.call(value, 'href'), false, 'must not structuredClone any image payload');
    assert.equal(Object.prototype.hasOwnProperty.call(value, 'originalHref'), false, 'must not clone an original data URL');
    metadataClones++;
    return savedClone(value);
  };
  const standalone = cloneElement(original);
  assert.deepEqual(standalone, original);
  assert.notEqual(standalone, original);
  const op = createCanvasOperation([], [original]);
  assert.equal(op.changes.length, 1);
  original.tags.push('later');
  assert.deepEqual(op.changes[0].after.tags, ['alpha'], 'mutable metadata must remain detached');
  const restored = applyCanvasOperation([], op, 'redo')[0];
  assert.equal(restored.originalHref, original.originalHref);
  assert.deepEqual(restored.tags, ['alpha']);
} finally {
  global.structuredClone = savedClone;
}
assert.ok(metadataClones >= 3);
console.log('PASS undo/redo snapshots clone mutable metadata but not multi-MB image strings');

const { commitCanvasOperation, commitGroupedCanvasOperation } = require('../utils/operationHistory.ts');
let elements = [];
let history = [];
let historyIndex = -1;
let group = null;
for (let index = 0; index < 64; index++) {
  const next = [...elements, { ...original, id: `photo-${index}`, x: index * 3 }];
  const committed = commitGroupedCanvasOperation(history, historyIndex, elements, next, group);
  ({ operationHistory: history, operationHistoryIndex: historyIndex, group } = committed);
  elements = next;
}
assert.equal(history.length, 1, 'all uncontested import chunks form a single undo operation');
assert.equal(history[0].changes.length, 64);
assert.equal(applyCanvasOperation(elements, history[0], 'undo').length, 0);
assert.equal(applyCanvasOperation([], history[0], 'redo').length, 64);
const edited = [...elements];
edited[0] = { ...edited[0], x: 999 };
({ operationHistory: history, operationHistoryIndex: historyIndex } = commitCanvasOperation(history, historyIndex, elements, edited));
const next = [...edited, { ...original, id: 'photo-65' }];
({ operationHistory: history, operationHistoryIndex: historyIndex, group } =
  commitGroupedCanvasOperation(history, historyIndex, edited, next, group));
assert.equal(history.length, 3, 'an interleaved user edit must remain its own undo step');
assert.equal(applyCanvasOperation(next, history[2], 'undo')[0].x, 999, 'undo next chunk must not undo the user edit');
console.log('PASS chunked import groups one undo/redo step unless the user edits in between');

let cloneCount = 0;
let benchmarkElements = [];
let benchmarkHistory = [];
let benchmarkIndex = -1;
let benchmarkGroup = null;
try {
  global.structuredClone = value => { cloneCount++; return savedClone(value); };
  for (let batch = 0; batch < 64; batch++) {
    const nextElements = [...benchmarkElements, ...Array.from({ length: 4 }, (_, index) => (
      { ...original, id: `fast-${batch * 4 + index}` }
    ))];
    const step = commitGroupedCanvasOperation(
      benchmarkHistory, benchmarkIndex, benchmarkElements, nextElements, benchmarkGroup,
    );
    benchmarkHistory = step.operationHistory;
    benchmarkIndex = step.operationHistoryIndex;
    benchmarkGroup = step.group;
    benchmarkElements = nextElements;
  }
} finally {
  global.structuredClone = savedClone;
}
assert.equal(benchmarkHistory.length, 1);
assert.equal(benchmarkHistory[0].changes.length, 256);
assert.ok(cloneCount <= 256, `import must only clone newly added metadata, not every prior chunk (${cloneCount} clones)`);
assert.equal(applyCanvasOperation(benchmarkElements, benchmarkHistory[0], 'undo').length, 0);
assert.equal(applyCanvasOperation([], benchmarkHistory[0], 'redo').length, 256);
console.log('PASS 256-image grouped history clones only the new batch, not all previous images');

const { serializeProjectDocument, deserializeProjectDocument } = require('../utils/projectDocument.ts');
const board = {
  id: 'photos', name: 'Photos', elements: [original, { ...original, id: 'photo-2' }],
  panOffset: { x: 0, y: 0 }, zoom: 1, canvasBackgroundColor: '#111827',
};
const stringify = JSON.stringify;
let documentV2;
try {
  JSON.stringify = (...args) => {
    const value = args[0];
    assert.equal(Boolean(value && typeof value === 'object' && 'previewRef' in value), false,
      'never stringify image locator just to deduplicate assets');
    return stringify(...args);
  };
  documentV2 = serializeProjectDocument([board]);
} finally {
  JSON.stringify = stringify;
}
assert.equal(documentV2.assets.length, 1, 'same sources share one asset, including in saved projects');
assert.equal(documentV2.nodes[0].assetId, documentV2.nodes[1].assetId);
assert.equal(deserializeProjectDocument(documentV2)[0].elements[0].mediumHref, original.mediumHref);
console.log('PASS project save deduplicates sources without copying/stringifying full locators');

const { rememberLastDisplayedSource, peekLastDisplayedSource } = require('../utils/usePreparedImageSource.ts');
rememberLastDisplayedSource('full', original.href, { src: original.originalHref, tier: 'original' });
assert.equal(peekLastDisplayedSource('full', original.href), null, 'full original is not pinned by remount hints');
rememberLastDisplayedSource('medium', original.href, { src: original.mediumHref, tier: 'medium' });
assert.equal(peekLastDisplayedSource('medium', original.href)?.tier, 'medium');
console.log('PASS remount hint retains medium, not the full original');

const { warmImageSources, isImageSourceReady } = require('../utils/imageWarmCache.ts');
let imageCreates = 0;
const OldImage = global.Image;
try {
  global.Image = class {
    constructor() { imageCreates++; this.complete = true; this.naturalWidth = 100; }
    removeAttribute() {}
  };
  warmImageSources(['data:image/png;base64,' + 'a'.repeat(512 * 1024 + 1)]);
  assert.equal(imageCreates, 0, 'large data URL must not be decoded/pinned by warm cache');
  assert.equal(isImageSourceReady('data:image/png;base64,' + 'a'.repeat(512 * 1024 + 1)), false);
  assert.equal(imageCreates, 0);
  warmImageSources(['data:image/png;base64,thumbnail']);
  assert.equal(imageCreates, 1);
} finally {
  global.Image = OldImage;
}
console.log('PASS warm cache refuses large source and accepts thumbnails');

const { clearPerfTelemetry, recordLongFrame, formatPerfLog, describeLongFrame } = require('../utils/perfTelemetry.ts');
clearPerfTelemetry();
recordLongFrame({ ts: Date.now(), durationMs: 1385, blockingMs: 1200, scriptMs: 1200, renderMs: 400,
  scripts: [{ url: '/hooks/useCanvasInteractions.ts', fn: 'dispatchDiscreteEvent', ms: 1200 }],
});
const report = formatPerfLog({ devReactTimings: true });
assert.match(report, /已归因脚本合计 1200ms/);
assert.match(report, /不能据此断言/);
assert.ok(!report.includes('渲染管线占大头'), 'do not infer GPU bottleneck from overlapping stages');
assert.ok(!describeLongFrame({ ts: 0, durationMs: 500, blockingMs: 450, scripts: [], renderMs: 350 }).includes('渲染管线瓶颈'));
clearPerfTelemetry();
console.log('PASS LoAF report does not invent 0ms script/style/layout or misdiagnose GPU');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const fileHandlers = read('hooks/useFileHandlers.ts');
assert.match(fileHandlers, /assessImageImportBudget\(\[file\], heap\)/, 'memory guard must check each next image, not the whole drop');
assert.ok(fileHandlers.indexOf('assessImageImportBudget([file], heap)') > fileHandlers.indexOf('for (const [fileIndex, file] of validFiles.entries())'),
  'each file must be checked against live heap when its turn starts');
assert.match(fileHandlers, /await flushPending\(\)/, 'image data must be committed and released in bounded batches');
assert.match(fileHandlers, /requestAnimationFrame/, 'long drops should yield a paint opportunity between batches');
const fileUtils = read('utils/fileUtils.ts');
assert.match(fileUtils, /tryGenerateImageProxiesInWorker\(file/, 'standard JPG/PNG should generate LOD proxies off the main thread');
assert.match(fileUtils, /URL\.createObjectURL\(file\)/, 'fallback image decoder must still work');
assert.match(fileUtils, /URL\.revokeObjectURL\(sourceUrl\)/, 'fallback temporary Blob URL must be released');
const workerSource = read('workers/image-import.worker.ts');
assert.match(workerSource, /createImageBitmap\(file\)/);
assert.match(workerSource, /new OffscreenCanvas/);
assert.match(workerSource, /convertToBlob/);
assert.match(workerSource, /bitmap\.close\(\)/);
assert.doesNotMatch(workerSource, /readAsDataURL\(file\)/, 'do not copy originals over the worker boundary');
assert.match(fileHandlers, /waitForImportCommit\(importCanvasBusy\)/, 'chunk commits must respect active canvas gestures');
const canvasElement = read('components/CanvasElement.tsx');
assert.match(canvasElement, /willChange: isSelected && selectedElementIds\.length === 1/,
  'bulk-select must not create a compositor layer for every selected image');
assert.match(canvasElement, /wasSelected && isSelected && .*selectedElementIds\.length === 1/,
  'memo must update the compositor hint when changing between single and batch selection');
console.log('PASS per-image live guard, off-main-thread proxy worker, idle canvas commits and safe Blob fallback');
// Run the actual async drop hook without a DOM by substituting only React's
// hook bookkeeping and the image decoder. Each synthetic File reports 8 MiB;
// no 512 MiB payload is allocated just to exercise the import scheduler.
(async () => {
  const react = require('react');
  const fileUtils = require('../utils/fileUtils.ts');
  const previousCallback = react.useCallback;
  const previousRef = react.useRef;
  const previousMemo = react.useMemo;
  const previousSyncStore = react.useSyncExternalStore;
  const previousDecode = fileUtils.readAndCompressImage;
  const previousPerformance = global.performance;
  const previousConsoleError = console.error;
  console.error = (...args) => {
    if (args[0] instanceof Error && /^(Browser memory is nearly full|The project or destination board changed)/.test(args[0].message)) return;
    previousConsoleError(...args);
  };
  const { useFileHandlers } = require('../hooks/useFileHandlers.ts');
  const { setKernel, tryKernel } = require('../plugin-runtime/instance.ts');
  const previousKernel = tryKernel();
  const registeredImageHandler = {
    id: 'test.image', extensions: ['png'], outputKind: 'image', category: 'image',
    parse: async file => ({ kind: 'image', name: file.name, ...await fileUtils.readAndCompressImage(file) }),
  };
  const images = Array.from({ length: 64 }, (_, index) => ({ name: `sample-${index}.png`, type: 'image/png', size: 8 * MiB }));
  let decoded = 0;
  let currentMemory = { usedJSHeapSize: 512 * MiB, jsHeapSizeLimit: 4096 * MiB };
  react.useCallback = value => value;
  react.useRef = current => ({ current });
  react.useMemo = calculate => calculate();
  react.useSyncExternalStore = (_subscribe, read) => read();
  const canvas = require('../hooks/useCanvasState.ts').useCanvasState();
  const photo = index => ({ ...original, id: `real-${index}`, x: index });
  canvas.addElementsWithParenting([photo(1)], true, 'one-drop');
  canvas.addElementsWithParenting([photo(2)], true, 'one-drop');
  const getBoard = () => canvas.documentState.getSnapshot().boards[0];
  assert.equal(getBoard().operationHistory.length, 1, 'real canvas state merges painted chunks');
  canvas.commitAction(previous => previous.map(item => item.id === 'real-1' ? { ...item, x: 55 } : item));
  canvas.addElementsWithParenting([photo(3)], true, 'one-drop');
  assert.equal(getBoard().operationHistory.length, 3, 'interleaved edit separates import history');
  canvas.handleUndo();
  assert.equal(getBoard().elements.length, 2);
  assert.equal(getBoard().elements[0].x, 55, 'first undo removes only the last import chunk');
  canvas.handleUndo();
  assert.equal(getBoard().elements[0].x, 1, 'second undo restores the user edit');
  canvas.handleUndo();
  assert.equal(getBoard().elements.length, 0, 'third undo removes the original import group');
  canvas.handleRedo();
  assert.equal(getBoard().elements.length, 2);
  canvas.endImportHistoryGroup('one-drop');
  console.log('PASS real canvas state groups chunk history and keeps intervening edits independently undoable');
  fileUtils.readAndCompressImage = async file => {
    decoded++;
    return {
      dataUrl: `data:image/png;base64,${file.name}`,
      originalDataUrl: `data:image/png;base64,original-${file.name}`,
      width: 800, height: 600, mimeType: 'image/png',
    };
  };
  const regularDecode = fileUtils.readAndCompressImage;
  Object.defineProperty(global, 'performance', { configurable: true, value: { get memory() { return currentMemory; } } });
  const makeHarness = (options = {}) => {
    const writes = [];
    const selection = [];
    const tools = [];
    const errors = [];
    const progress = [];
    const loading = [];
    const endedGroups = [];
    let snapshot = { sessionId: 'project-1', activeBoardId: 'board-1', boards: [{ id: 'board-1' }] };
    const replaceDocument = () => { snapshot = { ...snapshot, sessionId: 'another-project' }; };
    const { handleAddFiles } = useFileHandlers({
      getCanvasPoint: (x, y) => ({ x, y }),
      addElementsWithParenting: (items, commit, groupId) => {
        writes.push({ items, commit, groupId });
        options.onWrite?.(items);
      },
      endImportHistoryGroup: id => endedGroups.push(id),
      documentState: { getSnapshot: () => snapshot },
      isCanvasBusy: options.isCanvasBusy,
      setSelectedElementIds: ids => selection.push(ids),
      setActiveTool: tool => tools.push(tool),
      setError: error => errors.push(error),
      svgRef: { current: {} },
      updateActiveBoard: () => {},
      setIsLoading: value => loading.push(value),
      setProgressMessage: value => progress.push(value),
    });
    return { handleAddFiles, writes, selection, tools, errors, progress, loading, endedGroups, replaceDocument };
  };
  try {
    const { waitForImportCommit } = require('../utils/importScheduling.ts');
    let activeGesture = true;
    setTimeout(() => { activeGesture = false; }, 125);
    const waitStarted = Date.now();
    await waitForImportCommit(() => activeGesture);
    assert.ok(Date.now() - waitStarted >= 115, 'idle scheduler must not publish during a live gesture');
    console.log('PASS canvas import scheduler waits for an active gesture to end');

    // The app normally uses the registered builtin image handler rather than
    // the legacy fallback. Exercise that dispatch branch for the large drop.
    setKernel({ contributions: { list: slot => slot === 'format_handlers'
      ? [{ id: 'test.image', value: registeredImageHandler }] : [] } });
    const full = makeHarness();
    await full.handleAddFiles(images, { x: 0, y: 0 });
    assert.equal(decoded, 64, 'every image in a single 512 MiB drop should be processed');
    assert.equal(full.writes.flatMap(write => write.items).length, 64);
    assert.ok(full.writes.length > 16, 'batch commits must happen before the last file is decoded');
    assert.ok(full.writes.every(write => write.commit && write.items.length <= 8));
    assert.equal(new Set(full.writes.map(write => write.groupId)).size, 1, 'all chunks share an undo group');
    assert.equal(full.endedGroups.length, 1, 'release the group baseline when done');
    assert.equal(full.selection.at(-1)?.length, 64);
    assert.deepEqual(full.loading.slice(-1), [false]);
    assert.equal(full.errors.at(-1), null);
    assert.ok(full.progress.some(text => text.includes('Imported 64/64 files')));
    console.log('PASS registered image handler places a synthetic 512 MB drop in many small commits with one undo group');
    setKernel(previousKernel);

    decoded = 0;
    let dragging = false;
    fileUtils.readAndCompressImage = async file => {
      decoded++;
      if (decoded === 1) dragging = true;
      return { dataUrl: `data:image/png;base64,${file.name}`, width: 800, height: 600, mimeType: 'image/png' };
    };
    const gesturing = makeHarness({ isCanvasBusy: () => dragging });
    const draggingImport = gesturing.handleAddFiles(images.slice(0, 16).map(file => ({ ...file, size: 24 * MiB })), { x: 0, y: 0 });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(decoded, 1, 'import must not read more files during an active gesture');
    assert.equal(gesturing.writes.length, 0, 'import must not paint a chunk over an active gesture');
    dragging = false;
    await draggingImport;
    assert.equal(decoded, 16);
    assert.equal(gesturing.writes.flatMap(entry => entry.items).length, 16);
    fileUtils.readAndCompressImage = regularDecode;
    console.log('PASS ongoing image import pauses writes during a drag, then resumes without losing files');

    const previousWindow = global.window;
    const listeners = new Map();
    global.window = {
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    };
    try {
      const working = makeHarness();
      const workImport = working.handleAddFiles(images.slice(0, 16), { x: 0, y: 0 });
      listeners.get('pointerdown')();
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(working.writes.length, 0, 'pointer held down must defer commits');
      listeners.get('pointerup')();
      await workImport;
      assert.equal(working.writes.flatMap(entry => entry.items).length, 16);
      assert.equal(working.selection.length, 0, 'import must not steal selection after user input');
      assert.equal(working.tools.length, 0, 'import must not switch tools after user input');
      assert.equal(listeners.size, 0, 'temporary input listeners are cleaned up');
      console.log('PASS import does not steal focus or select images after the user interacts');
    } finally {
      if (previousWindow === undefined) delete global.window;
      else global.window = previousWindow;
    }

    const single = makeHarness();
    await single.handleAddFiles([{ ...images[0], size: 300 * MiB }], { x: 0, y: 0 });
    assert.equal(single.writes.length, 1, 'a single big image still imports if memory permits');
    assert.equal(single.writes[0].groupId, undefined, 'single-file import keeps its original undo path');
    assert.equal(single.writes[0].items[0].y, -150, 'single-file import remains vertically centered');
    assert.equal(single.errors.at(-1), null);
    console.log('PASS one large image has no fixed file-size cap and retains its original centered layout');

    decoded = 0;
    const partial = makeHarness();
    fileUtils.readAndCompressImage = async file => {
      decoded++;
      if (decoded >= 10) currentMemory = { usedJSHeapSize: 4020 * MiB, jsHeapSizeLimit: 4096 * MiB };
      return { dataUrl: `data:image/png;base64,${file.name}`, width: 800, height: 600, mimeType: 'image/png' };
    };
    await partial.handleAddFiles(images, { x: 0, y: 0 });
    assert.equal(decoded, 10, 'low memory stops before attempting the next image');
    assert.equal(partial.writes.flatMap(write => write.items).length, 10, 'working batch is committed before stopping');
    assert.match(partial.errors.at(-1), /Imported 10\/64 files .*54 files were not imported.*memory is nearly full/);
    assert.equal(partial.selection.at(-1)?.length, 10);
    assert.equal(partial.endedGroups.length, 1);
    assert.deepEqual(partial.loading.slice(-1), [false]);
    console.log('PASS live heap exhaustion preserves committed and pending images, and reports the skipped count');

    decoded = 0;
    currentMemory = { usedJSHeapSize: 512 * MiB, jsHeapSizeLimit: 4096 * MiB };
    const switched = makeHarness();
    fileUtils.readAndCompressImage = async file => {
      decoded++;
      if (decoded === 3) switched.replaceDocument();
      return { dataUrl: `data:image/png;base64,${file.name}`, width: 800, height: 600, mimeType: 'image/png' };
    };
    await switched.handleAddFiles(images, { x: 0, y: 0 });
    assert.equal(decoded, 3, 'do not read another image after the destination project changes');
    assert.equal(switched.writes.length, 0, 'do not write into the newly opened project');
    assert.match(switched.errors.at(-1), /destination project or board changed/);
    assert.equal(switched.endedGroups.length, 1);
    console.log('PASS replacing the project mid-import cannot paint stale batches into the new project');

    decoded = 0;
    const concurrent = makeHarness();
    const first = concurrent.handleAddFiles(images, { x: 0, y: 0 });
    await concurrent.handleAddFiles(images.slice(0, 1), { x: 0, y: 0 });
    await first;
    assert.equal(decoded, 64, 'a second drop cannot start another concurrent decoder');
    assert.ok(concurrent.errors.some(text => /already running/.test(text || '')));
    assert.equal(concurrent.errors.at(-1), null, 'successful first drop clears the temporary busy warning');
    console.log('PASS concurrent drops are gated without aborting the running batch');
  } finally {
    react.useCallback = previousCallback;
    react.useRef = previousRef;
    react.useMemo = previousMemo;
    react.useSyncExternalStore = previousSyncStore;
    fileUtils.readAndCompressImage = previousDecode;
    setKernel(previousKernel);
    console.error = previousConsoleError;
    Object.defineProperty(global, 'performance', { configurable: true, value: previousPerformance });
  }
  console.log('checks: bulk-image-safety ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
