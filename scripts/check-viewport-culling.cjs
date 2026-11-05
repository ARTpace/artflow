// DOM operation-count/legacy parity regression; no browser or timing claims.
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { captureViewportCullEntries, cullViewportEntries } = require('../utils/viewport-culling.ts');
let reads = 0, writes = 0, queries = 0;
const makeNode = (x, y, w = 20, h = 20, dx = 0, dy = 0) => {
  const raw = { cullX: String(x), cullY: String(y), cullW: String(w), cullH: String(h) };
  const styles = { display: '', opacity: '0.5', transition: 'opacity 100ms' };
  const proxy = data => new Proxy(data, {
    get(target, key) { reads++; return target[key]; },
    set(target, key, value) { writes++; target[key] = value; return true; },
    deleteProperty(target, key) { writes++; delete target[key]; return true; },
  });
  return {
    raw, styles, dx, dy,
    dataset: proxy(raw), style: proxy(styles),
    parentElement: { getAttribute(name) { reads++; return String(name.endsWith('-x') ? dx : dy); } },
    getBoundingClientRect() { throw new Error('layout read'); },
    getBBox() { throw new Error('SVG layout read'); },
  };
};
const nodes = Array.from({ length: 500 }, (_, n) => makeNode((n % 25) * 100 - 500, Math.floor(n / 25) * 100 - 500));
nodes.push(makeNode(5000, 0, 20, 20, -4900)); // Stable card translated into view.
nodes.push(makeNode(NaN, 0));
const group = { querySelectorAll(selector) { assert.equal(selector, '[data-cull-w]'); queries++; return nodes; } };
let entries = captureViewportCullEntries(group);
const hidden = nodes.map(() => false);
const legacyStep = (zoom, panX, panY, width, height) => {
  if (!(zoom > 0) || width <= 0 || height <= 0) return;
  nodes.forEach((node, n) => {
    const x = Number(node.raw.cullX) + node.dx, y = Number(node.raw.cullY) + node.dy;
    const w = Number(node.raw.cullW), h = Number(node.raw.cullH);
    if (![x, y, w, h].every(Number.isFinite)) return;
    const pad = (hidden[n] ? 96 : 240) / zoom;
    hidden[n] = x + w < -panX / zoom - pad || y + h < -panY / zoom - pad
      || x > (width - panX) / zoom + pad || y > (height - panY) / zoom + pad;
  });
};
const readsAfterCapture = reads;
for (let frame = 0; frame < 100; frame++) {
  const camera = [0.4 + (frame % 20) * 0.1, -frame * 13, frame * 3, 1000, 700];
  legacyStep(...camera);
  cullViewportEntries(entries, ...camera);
  nodes.forEach((node, n) => assert.equal(node.raw.cullState === 'out', hidden[n], `legacy parity node ${n} frame ${frame}`));
}
assert.equal(queries, 1, '100 live frames must not query card descendants again');
assert.equal(reads, readsAfterCapture, '100 live frames must not read DOM metadata/style/layout');
const writesBefore = writes;
cullViewportEntries(entries, 0.4 + 19 * 0.1, -1287, 297, 1000, 700); // Same as frame 99.
assert.equal(writes, writesBefore, 'unchanged cull state must not write DOM styles');
// A React commit changes geometry, drag offsets, mounts and removes nodes.
nodes.splice(0, 1);
nodes.push(makeNode(-900, 50, 20, 20, 1000));
entries = captureViewportCullEntries(group);
const readsAfterCommit = reads;
cullViewportEntries(entries, 1, 0, 0, 1000, 700);
assert.equal(nodes.at(-1).raw.cullState, undefined, 'new translated HTML card remains visible');
assert.equal(reads, readsAfterCommit);
const invalidWrites = writes;
cullViewportEntries(entries, 0, 0, 0, 1000, 700);
cullViewportEntries(entries, 1, 0, 0, 0, 700);
assert.equal(writes, invalidWrites, 'invalid viewport must not change culling');
const main = fs.readFileSync(require('node:path').join(__dirname, '../components/MainCanvas.tsx'), 'utf8');
assert.match(main, /cullEntriesRef\.current = captureViewportCullEntries\(viewportGroupRef\.current\)/);
assert.match(main, /cullViewportEntries\(\s*cullEntriesRef\.current/);
assert.match(main, /'video', 'audio', 'code', 'markdown', 'model3d', 'file', 'bookmark', 'plugin-node'/, 'preserve preexisting HTML-card translate path');
console.log('PASS viewport culling: 502 nodes x 100 live frames, one capture query, zero live DOM reads; legacy hysteresis parity, no redundant writes, commit refresh, HTML drag offset, invalid viewport guards');
