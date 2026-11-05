require('./register-typescript.cjs');

const { performance } = require('node:perf_hooks');
const { createViewportIndex, createViewportIndexCache, DEFAULT_VIEWPORT_PADDING } = require('../utils/viewport-index.ts');

const count = Number.parseInt(process.env.ARTFLOW_BENCH_NODES || '10000', 10);
const queries = Number.parseInt(process.env.ARTFLOW_BENCH_QUERIES || '100', 10);
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(queries) || queries < 1) {
  throw new Error('ARTFLOW_BENCH_NODES and ARTFLOW_BENCH_QUERIES must be positive integers');
}

const columns = Math.ceil(Math.sqrt(count));
const elements = Array.from({ length: count }, (_, index) => ({
  id: `fixture-${index}`,
  type: 'image',
  x: (index % columns) * 160,
  y: Math.floor(index / columns) * 120,
  width: 120,
  height: 80,
  href: 'preview://fixture',
  mimeType: 'image/png',
}));
const viewports = Array.from({ length: queries }, (_, query) => ({
  x: ((query * 251) % columns) * 160,
  y: ((query * 149) % Math.ceil(count / columns)) * 120,
  width: 1280,
  height: 720,
}));
const intersectsPaddedViewport = (element, viewport) => {
  const padding = DEFAULT_VIEWPORT_PADDING;
  return !(
    element.x + element.width < viewport.x - padding ||
    element.x > viewport.x + viewport.width + padding ||
    element.y + element.height < viewport.y - padding ||
    element.y > viewport.y + viewport.height + padding
  );
};

const buildStart = performance.now();
const index = createViewportIndex(elements);
const buildMs = performance.now() - buildStart;
let naiveReturned = 0;
const naiveStart = performance.now();
for (const viewport of viewports) {
  naiveReturned += elements.filter(element => intersectsPaddedViewport(element, viewport)).length;
}
const naiveQueryMs = performance.now() - naiveStart;
let indexedReturned = 0;
const indexedStart = performance.now();
for (const viewport of viewports) indexedReturned += index.query(viewport).length;
const indexedQueryMs = performance.now() - indexedStart;
if (naiveReturned !== indexedReturned) {
  throw new Error(`benchmark query mismatch: naive=${naiveReturned}, indexed=${indexedReturned}`);
}

// R14 mirrors box-selection: a padded index query supplies candidates, then the existing strict AABB test decides selection.
const boxSelectionRegion = {
  x: Math.floor(columns / 2) * 160,
  y: Math.floor(Math.ceil(count / columns) / 2) * 120,
  width: 640,
  height: 480,
};
const strictlyOverlapsBox = (element, box) => (
  box.x < element.x + element.width
  && box.x + box.width > element.x
  && box.y < element.y + element.height
  && box.y + box.height > element.y
);
const boxNaiveStart = performance.now();
const naiveBoxSelected = elements.filter(element => strictlyOverlapsBox(element, boxSelectionRegion));
const naiveBoxSelectionMs = performance.now() - boxNaiveStart;
const boxIndexedStart = performance.now();
const boxCandidates = index.query(boxSelectionRegion);
const indexedBoxSelected = boxCandidates.filter(element => strictlyOverlapsBox(element, boxSelectionRegion));
const indexedBoxSelectionMs = performance.now() - boxIndexedStart;
if (naiveBoxSelected.map(element => element.id).join(',') !== indexedBoxSelected.map(element => element.id).join(',')) {
  throw new Error('box selection exact-result mismatch');
}

// Mirror a typical immutable drag update: one new element object inside a new array.
const sparseUpdates = Math.min(queries, 100);
const nextSparseUpdate = (source, step) => {
  const target = step % count;
  return source.map((element, index) => index === target
    ? { ...element, x: element.x + 7 + (step % 3), y: element.y + 5 }
    : element);
};
let freshElements = elements;
let freshSparseReturned = 0;
const freshSparseStart = performance.now();
for (let step = 0; step < sparseUpdates; step += 1) {
  freshElements = nextSparseUpdate(freshElements, step);
  freshSparseReturned += createViewportIndex(freshElements).query(viewports[step % viewports.length]).length;
}
const freshSparseRebuildMs = performance.now() - freshSparseStart;
let cachedElements = elements;
const cache = createViewportIndexCache();
cache.update(cachedElements);
let cachedSparseReturned = 0;
const cachedSparseStart = performance.now();
for (let step = 0; step < sparseUpdates; step += 1) {
  cachedElements = nextSparseUpdate(cachedElements, step);
  cachedSparseReturned += cache.update(cachedElements).query(viewports[step % viewports.length]).length;
}
const cachedSparseUpdateMs = performance.now() - cachedSparseStart;
if (freshSparseReturned !== cachedSparseReturned) {
  throw new Error(`sparse update query mismatch: fresh=${freshSparseReturned}, cached=${cachedSparseReturned}`);
}

// R33 grouped sparse fixture: stable parent relations should update the child and its Group ancestors only.
const groupCount = Math.max(1, Math.floor(Math.sqrt(count)));
const groupedChildCount = Math.max(1, count - groupCount);
const groupedChildrenPerGroup = Math.ceil(groupedChildCount / groupCount);
const groupedElements = [
  ...Array.from({ length: groupCount }, (_, index) => ({
    id: `group-${index}`,
    type: 'group',
    name: `Group ${index}`,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
  })),
  ...Array.from({ length: groupedChildCount }, (_, index) => {
    const source = elements[index % elements.length];
    return {
      ...source,
      id: `group-child-${index}`,
      parentId: `group-${Math.min(groupCount - 1, Math.floor(index / groupedChildrenPerGroup))}`,
    };
  }),
];
const nextGroupedSparseUpdate = (source, step) => {
  const target = groupCount + (step % groupedChildCount);
  return source.map((element, index) => index === target
    ? { ...element, x: element.x + 11 + (step % 5), y: element.y + 9 }
    : element);
};
let freshGroupedElements = groupedElements;
let freshGroupedReturned = 0;
const freshGroupedStart = performance.now();
for (let step = 0; step < sparseUpdates; step += 1) {
  freshGroupedElements = nextGroupedSparseUpdate(freshGroupedElements, step);
  freshGroupedReturned += createViewportIndex(freshGroupedElements).query(viewports[step % viewports.length]).length;
}
const freshGroupedRebuildMs = performance.now() - freshGroupedStart;
let cachedGroupedElements = groupedElements;
const groupedCache = createViewportIndexCache();
groupedCache.update(cachedGroupedElements);
let cachedGroupedReturned = 0;
const cachedGroupedStart = performance.now();
for (let step = 0; step < sparseUpdates; step += 1) {
  cachedGroupedElements = nextGroupedSparseUpdate(cachedGroupedElements, step);
  cachedGroupedReturned += groupedCache.update(cachedGroupedElements).query(viewports[step % viewports.length]).length;
}
const cachedGroupedUpdateMs = performance.now() - cachedGroupedStart;
if (freshGroupedReturned !== cachedGroupedReturned) {
  throw new Error(`grouped sparse update mismatch: fresh=${freshGroupedReturned}, cached=${cachedGroupedReturned}`);
}

console.log(JSON.stringify({
  nodes: count,
  queries,
  buildMs: Number(buildMs.toFixed(2)),
  naiveQueryMs: Number(naiveQueryMs.toFixed(2)),
  indexedQueryMs: Number(indexedQueryMs.toFixed(2)),
  averageIndexedQueryMs: Number((indexedQueryMs / queries).toFixed(3)),
  cameraQuerySpeedup: Number((naiveQueryMs / Math.max(indexedQueryMs, 0.001)).toFixed(2)),
  boxSelection: {
    exactResultEqual: true,
    selected: indexedBoxSelected.length,
    candidates: boxCandidates.length,
    naiveMs: Number(naiveBoxSelectionMs.toFixed(2)),
    indexedCandidateAndExactMs: Number(indexedBoxSelectionMs.toFixed(2)),
  },
  sparseUpdates,
  freshSparseRebuildMs: Number(freshSparseRebuildMs.toFixed(2)),
  cachedSparseUpdateMs: Number(cachedSparseUpdateMs.toFixed(2)),
  sparseUpdateSpeedup: Number((freshSparseRebuildMs / Math.max(cachedSparseUpdateMs, 0.001)).toFixed(2)),
  sparseReturned: cachedSparseReturned,
  cacheDiagnostics: cache.diagnostics(),
  groupedSparse: {
    groups: groupCount,
    exactResultEqual: true,
    freshRebuildMs: Number(freshGroupedRebuildMs.toFixed(2)),
    cachedUpdateMs: Number(cachedGroupedUpdateMs.toFixed(2)),
    speedup: Number((freshGroupedRebuildMs / Math.max(cachedGroupedUpdateMs, 0.001)).toFixed(2)),
    returned: cachedGroupedReturned,
    cacheDiagnostics: groupedCache.diagnostics(),
  },
  returned: indexedReturned,
  diagnostics: index.diagnostics(),
}, null, 2));
