require('./register-typescript.cjs');

const { performance } = require('node:perf_hooks');
const { flattenLayerElements, getVirtualRowWindow } = require('../utils/layerPanelModel.ts');

const count = Number.parseInt(process.env.ARTFLOW_BENCH_NODES || '10000', 10);
if (!Number.isInteger(count) || count < 100) throw new Error('ARTFLOW_BENCH_NODES must be an integer >= 100');

const rootCount = Math.max(1, Math.floor(Math.sqrt(count)));
const elements = [];
for (let rootIndex = 0; rootIndex < rootCount && elements.length < count; rootIndex += 1) {
  const rootId = `root-${rootIndex}`;
  elements.push({ id: rootId, type: 'frame', name: rootId, x: 0, y: 0, width: 100, height: 100 });
  const remainingRoots = rootCount - rootIndex - 1;
  const childBudget = Math.max(0, Math.floor((count - elements.length - remainingRoots) / (rootCount - rootIndex)));
  for (let childIndex = 0; childIndex < childBudget && elements.length < count; childIndex += 1) {
    const id = `child-${rootIndex}-${childIndex}`;
    elements.push({ id, parentId: rootId, type: 'image', name: id, x: 0, y: 0, width: 40, height: 40, href: 'fixture://image' });
  }
}
while (elements.length < count) {
  const id = `tail-${elements.length}`;
  elements.push({ id, type: 'image', name: id, x: 0, y: 0, width: 40, height: 40, href: 'fixture://image' });
}

const legacyFlatten = (allElements, level = 0, parentId = undefined, rows = []) => {
  const siblings = allElements.filter(element => element.parentId === parentId);
  for (const element of siblings) {
    rows.push({ element, level });
    legacyFlatten(allElements, level + 1, element.id, rows);
  }
  return rows;
};

const legacyStart = performance.now();
const legacyRows = legacyFlatten([...elements].reverse());
const legacyMs = performance.now() - legacyStart;
const linearStart = performance.now();
const linearRows = flattenLayerElements(elements);
const linearMs = performance.now() - linearStart;

const legacySignature = legacyRows.map(row => `${row.element.id}:${row.level}`).join('|');
const linearSignature = linearRows.map(row => `${row.element.id}:${row.level}`).join('|');
if (legacySignature !== linearSignature) throw new Error('layer flatten result mismatch');

const viewportHeight = 768;
const rowHeight = 34;
const overscan = 8;
const window = getVirtualRowWindow(linearRows.length, Math.floor(linearRows.length * rowHeight * 0.5), viewportHeight, rowHeight, overscan);
const mountedRows = window.end - window.start;
const mountedRowBudget = Math.ceil(viewportHeight / rowHeight) + overscan * 2 + 1;
if (mountedRows > mountedRowBudget) throw new Error(`virtual window exceeded budget: ${mountedRows} > ${mountedRowBudget}`);

console.log(JSON.stringify({
  nodes: count,
  rows: linearRows.length,
  exactResultEqual: true,
  legacyRecursiveScanMs: Number(legacyMs.toFixed(2)),
  linearFlattenMs: Number(linearMs.toFixed(2)),
  observedFlattenSpeedup: Number((legacyMs / Math.max(linearMs, 0.001)).toFixed(2)),
  viewportHeight,
  rowHeight,
  overscan,
  mountedRows,
  mountedRowBudget,
  domReduction: Number((1 - mountedRows / linearRows.length).toFixed(4)),
}, null, 2));
