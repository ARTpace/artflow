require('./register-typescript.cjs');

const { performance } = require('node:perf_hooks');
const { createViewportIndex } = require('../utils/viewport-index.ts');
const { getElementBounds } = require('../utils/canvasUtils.ts');
const { resolveContainingFrame } = require('../utils/frame-parenting.ts');

const count = Number.parseInt(process.env.ARTFLOW_BENCH_NODES || '10000', 10);
const queries = Number.parseInt(process.env.ARTFLOW_BENCH_QUERIES || '1000', 10);
if (!Number.isInteger(count) || count < 2 || !Number.isInteger(queries) || queries < 1) {
  throw new Error('ARTFLOW_BENCH_NODES must be >= 2 and ARTFLOW_BENCH_QUERIES must be positive integers');
}

const columns = Math.ceil(Math.sqrt(count - 1));
const moving = {
  id: 'moving-node', type: 'image', x: 0, y: 0, width: 20, height: 20,
  href: 'preview://fixture', mimeType: 'image/png',
};
const frames = Array.from({ length: count - 1 }, (_, index) => ({
  id: `frame-${index}`,
  type: 'frame',
  name: `Frame ${index}`,
  x: (index % columns) * 160,
  y: Math.floor(index / columns) * 120,
  width: 120,
  height: 80,
}));
const elements = [moving, ...frames];
const snapshot = { elements, index: createViewportIndex(elements) };
const targets = Array.from({ length: queries }, (_, index) => {
  const frame = frames[(index * 97) % frames.length];
  return { ...moving, x: frame.x + 20, y: frame.y + 20 };
});
const legacyResolve = element => {
  const bounds = getElementBounds(element, elements);
  return elements
    .filter(candidate => candidate.type === 'frame')
    .filter(frame => (
      bounds.x >= frame.x
      && bounds.y >= frame.y
      && bounds.x + bounds.width <= frame.x + frame.width
      && bounds.y + bounds.height <= frame.y + frame.height
    ))
    .sort((a, b) => (a.width * a.height) - (b.width * a.height))[0] ?? null;
};

let legacyFound = 0;
const legacyStart = performance.now();
for (const target of targets) legacyFound += Number(Boolean(legacyResolve(target)));
const legacyResolveMs = performance.now() - legacyStart;
let indexedFound = 0;
let candidateFrameCount = 0;
const indexedStart = performance.now();
for (const target of targets) {
  const bounds = getElementBounds(target, elements);
  const candidateFrames = snapshot.index.query(bounds).filter(candidate => candidate.type === 'frame');
  candidateFrameCount += candidateFrames.length;
  const indexed = resolveContainingFrame(target, elements, snapshot);
  const legacy = legacyResolve(target);
  if (indexed?.id !== legacy?.id) throw new Error(`frame parent mismatch: indexed=${indexed?.id}, legacy=${legacy?.id}`);
  indexedFound += Number(Boolean(indexed));
}
const indexedWithOracleMs = performance.now() - indexedStart;
const indexedOnlyStart = performance.now();
for (const target of targets) resolveContainingFrame(target, elements, snapshot);
const indexedResolveMs = performance.now() - indexedOnlyStart;
if (legacyFound !== indexedFound) throw new Error(`frame parent match count mismatch: legacy=${legacyFound}, indexed=${indexedFound}`);
console.log(JSON.stringify({
  nodes: count,
  queries,
  exactResultEqual: true,
  legacyResolveMs: Number(legacyResolveMs.toFixed(2)),
  indexedWithOracleMs: Number(indexedWithOracleMs.toFixed(2)),
  indexedResolveMs: Number(indexedResolveMs.toFixed(2)),
  observedCommitCandidatePhaseRatio: Number((legacyResolveMs / Math.max(indexedResolveMs, 0.001)).toFixed(2)),
  found: indexedFound,
  averageFrameCandidates: Number((candidateFrameCount / queries).toFixed(2)),
  indexDiagnostics: snapshot.index.diagnostics(),
}, null, 2));
