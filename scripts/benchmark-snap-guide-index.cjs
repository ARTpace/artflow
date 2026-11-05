require('./register-typescript.cjs');

const { performance } = require('node:perf_hooks');
const { createDragSnapGuideSnapshot } = require('../utils/drag-snap-guide-index.ts');

const count = Number.parseInt(process.env.ARTFLOW_BENCH_NODES || '10000', 10);
const queries = Number.parseInt(process.env.ARTFLOW_BENCH_QUERIES || '1000', 10);
if (!Number.isInteger(count) || count < 2 || !Number.isInteger(queries) || queries < 1) {
  throw new Error('ARTFLOW_BENCH_NODES must be >= 2 and ARTFLOW_BENCH_QUERIES must be positive integers');
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
const movingIds = new Set(['fixture-0']);
const threshold = 10;
const targets = Array.from({ length: queries }, (_, index) => ({
  x: ((index * 137) % columns) * 160 + 117,
  y: ((index * 89) % Math.ceil(count / columns)) * 120 + 73,
}));

// Mirrors the legacy pointermove build: both axes are filled in one static-elements pass.
const legacyGuideSets = () => {
  const vertical = new Set();
  const horizontal = new Set();
  elements.forEach(element => {
    if (movingIds.has(element.id)) return;
    vertical.add(element.x);
    vertical.add(element.x + element.width / 2);
    vertical.add(element.x + element.width);
    horizontal.add(element.y);
    horizontal.add(element.y + element.height / 2);
    horizontal.add(element.y + element.height);
  });
  return { vertical, horizontal };
};
const legacyNearest = (values, target) => {
  let best = null;
  let rank = 0;
  for (const value of values) {
    const distance = Math.abs(target - value);
    if (distance < threshold && (!best || distance < best.distance)) best = { value, distance, rank };
    rank += 1;
  }
  return best;
};

const buildStart = performance.now();
const snapshot = createDragSnapGuideSnapshot(elements, movingIds);
const buildMs = performance.now() - buildStart;
if (!snapshot) throw new Error('flat fixture unexpectedly did not create a snap snapshot');
let legacyMatches = 0;
const legacyStart = performance.now();
for (const target of targets) {
  const guides = legacyGuideSets();
  const vertical = legacyNearest(guides.vertical, target.x);
  const horizontal = legacyNearest(guides.horizontal, target.y);
  legacyMatches += Number(Boolean(vertical)) + Number(Boolean(horizontal));
}
const legacyBuildAndQueryMs = performance.now() - legacyStart;
let indexedMatches = 0;
const indexedStart = performance.now();
for (const target of targets) {
  const guides = legacyGuideSets();
  const legacyVertical = legacyNearest(guides.vertical, target.x);
  const legacyHorizontal = legacyNearest(guides.horizontal, target.y);
  const indexedVertical = snapshot.vertical.findNearest(target.x, threshold);
  const indexedHorizontal = snapshot.horizontal.findNearest(target.y, threshold);
  if (JSON.stringify(indexedVertical) !== JSON.stringify(legacyVertical) || JSON.stringify(indexedHorizontal) !== JSON.stringify(legacyHorizontal)) {
    throw new Error('snap guide exact-result mismatch');
  }
  indexedMatches += Number(Boolean(indexedVertical)) + Number(Boolean(indexedHorizontal));
}
const indexedQueryWithOracleMs = performance.now() - indexedStart;
// Measure the practical indexed query path separately after the exactness oracle above.
const indexedOnlyStart = performance.now();
for (const target of targets) {
  snapshot.vertical.findNearest(target.x, threshold);
  snapshot.horizontal.findNearest(target.y, threshold);
}
const indexedQueryMs = performance.now() - indexedOnlyStart;
if (legacyMatches !== indexedMatches) throw new Error(`snap match count mismatch: legacy=${legacyMatches}, indexed=${indexedMatches}`);
console.log(JSON.stringify({
  nodes: count,
  queries,
  threshold,
  exactResultEqual: true,
  buildMs: Number(buildMs.toFixed(2)),
  legacyStaticGuideBuildAndQueryMs: Number(legacyBuildAndQueryMs.toFixed(2)),
  indexedQueryWithOracleMs: Number(indexedQueryWithOracleMs.toFixed(2)),
  indexedRangeQueryMs: Number(indexedQueryMs.toFixed(2)),
  observedStaticGuidePhaseRatio: Number((legacyBuildAndQueryMs / Math.max(indexedQueryMs, 0.001)).toFixed(2)),
  matchedAxes: indexedMatches,
  diagnostics: snapshot.diagnostics(),
}, null, 2));
