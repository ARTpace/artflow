// Direct geometry/operation-count checks; no browser, timing thresholds or full suite.
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const { getElementBounds } = require('../utils/canvasUtils.ts');
const { createDragSnapGuideSnapshot } = require('../utils/drag-snap-guide-index.ts');
const { createContainingFrameResolver, resolveContainingFrame } = require('../utils/frame-parenting.ts');
const { applyDragCommit } = require('../utils/drag-commit.ts');
const image = (id, x, y, parentId) => ({ id, type: 'image', x, y, width: 10, height: 20, parentId });
const frame = (id, x, width, height) => ({ id, type: 'frame', x, y: 0, width, height });

// Group metadata intentionally differs from its nested children's real geometry.
const group = { id: 'g', type: 'group', x: -999, y: -999, width: 1, height: 1 };
const nested = { ...group, id: 'nested', parentId: 'g' };
const child = image('child', 40, 60, 'nested');
const line = { id: 'line', type: 'line', points: [{ x: 5, y: 6 }, { x: 30, y: 40 }] };
const path = { id: 'path', type: 'path', points: [{ x: -2, y: 8 }, { x: 90, y: -4 }, { x: 0, y: 0 }] };
const elements = [group, nested, child, line, path, image('static', 200, 200)];
const ids = new Set(['g', 'nested', 'child', 'line', 'path']);
let groupScans = 0;
elements.filter = function (...args) { groupScans += 1; return Array.prototype.filter.apply(this, args); };
const snap = createDragSnapGuideSnapshot(elements, ids);
assert.ok(snap);
for (const element of elements) {
  if (ids.has(element.id)) assert.deepEqual(snap.getMovingBounds(element.id), getElementBounds(element, elements));
}
assert.deepEqual(snap.getMovingBounds('g'), { x: 40, y: 60, width: 10, height: 20 });
const scansBefore = groupScans;
for (let move = 0; move < 100; move += 1) for (const id of ids) snap.getMovingBounds(id);
assert.equal(groupScans, scansBefore, 'cached pointer moves must not recursively scan group children');
assert.equal(snap.isCurrent(elements), true);
assert.equal(snap.isCurrent([...elements]), false, 'immutable external updates must fall back');
snap.invalidate();
assert.equal(snap.isCurrent(elements), false);
assert.equal(createDragSnapGuideSnapshot(elements, new Set(['child'])), null, 'partially moving static group remains unsupported');

// Preserve legacy ordering/comparator, exact containment and stale-index fallback.
const frames = [frame('wide-short', 0, 140, 40), frame('narrow-tall', 0, 100, 200), frame('tie', 0, 100, 100)];
const targets = Array.from({ length: 80 }, (_, n) => image(`target-${n}`, n * 3, n % 15));
const board = [...frames, ...targets];
const stale = { elements: [], index: { query() { throw new Error('stale index queried'); } } };
for (const snapshot of [null, stale]) {
  const resolve = createContainingFrameResolver(board, snapshot);
  for (const target of targets) assert.equal(resolve(target), resolveContainingFrame(target, board, snapshot));
}
const current = { elements: board, index: { query: () => [frames[1]] } };
assert.equal(createContainingFrameResolver(board, current)(targets[0]), frames[1], 'current index semantics retained');
let filters = 0;
board.filter = function (...args) { filters += 1; return Array.prototype.filter.apply(this, args); };
const resolve = createContainingFrameResolver(board, null);
for (const target of targets) resolve(target);
assert.equal(filters, 1, 'batch fallback must filter the document only once, not once per moving target');

// Post-offset frames and recursive group bounds, including simultaneous frame movement.
const movingFrame = frame('moving-frame', 0, 200, 200);
const movingGroup = { ...group, parentId: 'moving-frame' };
const movingChild = image('moving-child', 40, 60, 'g');
const source = [movingFrame, movingGroup, movingChild, image('outside', 500, 500)];
const session = { elementIds: new Set(['moving-frame', 'g', 'moving-child']), offset: { x: 300, y: 0 } };
const result = applyDragCommit(source, session, stale);
assert.equal(result[0].x, 300);
assert.equal(result[0].parentId, undefined);
assert.equal(result[1].parentId, 'moving-frame');
assert.equal(result[2].parentId, 'moving-frame'); // Existing commit flattens all contained moved targets.
assert.deepEqual(getElementBounds(result[1], result), { x: -699, y: -999, width: 1, height: 1 });
assert.equal(result[3], source[3]);
console.log('PASS drag hotpath: cached real group/point bounds; stale/current guard; comparator parity; one document frame scan for 80 targets; post-offset frame/group commit');
