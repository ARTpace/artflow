require('./register-typescript.cjs');

const { createCanvasOperation } = require('../utils/operationHistory.ts');

const nodes = Number.parseInt(process.env.ARTFLOW_HISTORY_BENCH_NODES || '1000', 10);
const steps = Number.parseInt(process.env.ARTFLOW_HISTORY_BENCH_STEPS || '100', 10);
if (!Number.isInteger(nodes) || nodes < 1 || !Number.isInteger(steps) || steps < 1) {
  throw new Error('ARTFLOW_HISTORY_BENCH_NODES and ARTFLOW_HISTORY_BENCH_STEPS must be positive integers');
}
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const initial = Array.from({ length: nodes }, (_, index) => ({
  id: `node-${index}`,
  type: 'image',
  x: index * 16,
  y: 0,
  width: 12,
  height: 12,
  href: 'preview://fixture',
  mimeType: 'image/png',
}));
let current = initial;
const legacyHistory = [current];
const operationHistory = [];
for (let step = 0; step < steps; step += 1) {
  const target = step % nodes;
  const next = current.map((element, index) => index === target ? { ...element, x: element.x + 1 } : element);
  const operation = createCanvasOperation(current, next);
  if (operation) operationHistory.push(operation);
  legacyHistory.push(next);
  current = next;
}
const legacyBytes = bytes(legacyHistory);
const operationBytes = bytes(operationHistory);
console.log(JSON.stringify({
  nodes,
  steps,
  legacySnapshotBytes: legacyBytes,
  operationJournalBytes: operationBytes,
  byteReduction: Number((1 - operationBytes / legacyBytes).toFixed(4)),
  operationCount: operationHistory.length,
  propertyOnlyOperationsWithOrderArrays: operationHistory.filter(operation => operation.beforeOrder || operation.afterOrder).length,
}, null, 2));
