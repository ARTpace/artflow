'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
require('./register-typescript.cjs');
const { createKernel } = require('../plugin-runtime/kernel.ts');
const { createCanvasDocumentState } = require('../utils/canvas-document-state.ts');
const { createDocumentSDK } = require('../plugin-runtime/document-sdk.ts');
const { applyCanvasOperation } = require('../utils/operationHistory.ts');
const { serializeProjectDocument, deserializeProjectDocument } = require('../utils/projectDocument.ts');
const frame = { id: 'frame', type: 'frame', x: 0, y: 0, width: 500, height: 500, name: 'Frame', backgroundColor: '#111111' };
const text = (id = 'text') => ({ id, text: 'Hello', x: 1, y: 2, width: 120, height: 40 });
function fixture(elements = []) {
  const store = createCanvasDocumentState([{ id: 'board', name: 'Board', elements, operationHistory: [], operationHistoryIndex: -1, zoom: 1, panOffset: { x: 0, y: 0 } }]);
  const removed = []; const signal = new AbortController().signal;
  const { document, operations } = createDocumentSDK(store, { selection: () => [], isBusy: () => false, onDeleted: (board, ids) => removed.push([board, [...ids]]) }).forConsumer('test.transactions', signal);
  let sequence = 0;
  const request = (ops) => { const t = document.getContext(); return { sessionId: t.sessionId, boardId: t.boardId, revision: t.revision, label: 'transaction', requestId: `request-${++sequence}`, operations: ops }; };
  const apply = ops => operations.apply(request(ops));
  const board = () => store.getSnapshot().boards[0];
  const undo = () => store.setBoards(boards => boards.map(b => ({ ...b, elements: applyCanvasOperation(b.elements, b.operationHistory[b.operationHistoryIndex], 'undo'), operationHistoryIndex: b.operationHistoryIndex - 1 })));
  const redo = () => store.setBoards(boards => boards.map(b => ({ ...b, elements: applyCanvasOperation(b.elements, b.operationHistory[b.operationHistoryIndex + 1], 'redo'), operationHistoryIndex: b.operationHistoryIndex + 1 })));
  return { store, request, apply, operations, document, board, undo, redo, removed };
}
const tests = []; const test = (name, fn) => tests.push([name, fn]);
test('live services follow replacement refs, cached functions, this binding and disposal identity', () => {
  const { provideLiveService } = require('../plugin-runtime/live-service.ts');
  const root = createKernel(); const ref = { current: { read() { return this.write(); }, write: () => 'board-a' } };
  const off = provideLiveService(root, 'test.live', ref); const facade = root.use('test.live'); const cached = facade.read;
  assert.equal(cached(), 'board-a'); ref.current = { read() { return this.write(); }, write: () => 'board-b' }; assert.equal(cached(), 'board-b');
  off(); assert.throws(cached, /disposed/); const next = provideLiveService(root, 'test.live', ref); off(); assert.equal(root.use('test.live').read(), 'board-b'); next();
  const source = fs.readFileSync(path.join(__dirname, '../App.tsx'), 'utf8');
  for (const name of ['CANVAS_EXPORT_SOURCE_SERVICE', 'CANVAS_MUTATION_SERVICE', 'CANVAS_VIEW_STATE_SERVICE']) assert.match(source, new RegExp(`provideLiveService\\(pluginKernel, ${name},`));
});
test('create text is detached, undoable and round-trips through real v2 persistence', () => {
  const f = fixture(); const input = text(); const request = f.request([{ kind: 'node.createText', node: input }]);
  assert.equal(f.operations.apply(request).status, 'applied'); input.text = 'mutated input'; assert.equal(f.board().elements[0].text, 'Hello');
  assert.equal(f.board().elements[0].fontColor, '#ffffff'); assert.equal(f.board().operationHistory.length, 1);
  const doc = serializeProjectDocument(f.store.getSnapshot().boards); const restored = deserializeProjectDocument(doc); assert.equal(restored[0].elements[0].text, 'Hello');
  f.undo(); assert.equal(f.board().elements.length, 0); f.redo(); assert.equal(f.board().elements[0].text, 'Hello');
});
test('mixed create/reparent/delete commits once and restores asset locators and order on undo', () => {
  const asset = { id: 'asset-node', type: 'image', x: 0, y: 0, width: 100, height: 100, href: 'data:image/png;base64,AA==', mimeType: 'image/png', assetId: 'asset-record' };
  const existing = { ...text('existing'), type: 'text', fontSize: 20, fontColor: '#ffffff' };
  const f = fixture([frame, existing, asset]);
  const result = f.apply([{ kind: 'node.createText', node: { ...text('new'), parentId: 'frame' } }, { kind: 'node.reparent', id: 'existing', parentId: 'frame' }, { kind: 'node.delete', id: 'asset-node' }]);
  assert.equal(result.status, 'applied'); assert.equal(f.board().operationHistory.length, 1); assert.deepEqual(f.removed, [['board', ['asset-node']]]);
  assert.equal(f.board().elements.find(n => n.id === 'existing').parentId, 'frame');
  assert.equal(f.document.query(f.document.getContext()).find(n => n.id === 'existing').parentId, 'frame');
  f.undo(); assert.deepEqual(f.board().elements.map(n => n.id), ['frame', 'existing', 'asset-node']); assert.deepEqual(f.board().elements[2], asset);
  f.redo(); assert.deepEqual(f.board().elements.map(n => n.id), ['frame', 'existing', 'new']);
});
test('orphaning, invalid parent, cycles and locked ancestors reject atomically', () => {
  const group = { ...frame, id: 'group', type: 'group', parentId: 'frame' }; const child = { ...text(), type: 'text', fontSize: 20, fontColor: '#ffffff', parentId: 'group' };
  const f = fixture([frame, group, child]); const before = f.store.getSnapshot();
  for (const ops of [[{ kind: 'node.delete', id: 'group' }], [{ kind: 'node.reparent', id: 'frame', parentId: 'group' }], [{ kind: 'node.reparent', id: 'group', parentId: 'text' }], [{ kind: 'node.reparent', id: 'text', parentId: 'missing' }]]) { assert.equal(f.apply(ops).status, 'rejected'); assert.equal(f.store.getSnapshot(), before); }
  assert.equal(f.apply([{ kind: 'node.reparent', id: 'text', parentId: null }, { kind: 'node.delete', id: 'group' }]).status, 'applied');
  const locked = fixture([{ ...frame, isLocked: true }, { ...child, parentId: 'frame' }]);
  assert.equal(locked.apply([{ kind: 'node.delete', id: 'text' }]).status, 'rejected');
  assert.equal(locked.apply([{ kind: 'node.createText', node: { ...text('new'), parentId: 'frame' } }]).status, 'rejected');
});
test('bad text schemas, duplicate ids, spoofed asset fields and mixed failure publish nothing', () => {
  const legacy = fixture([{ ...text('旧 节点'), type: 'text', fontSize: 20, fontColor: '#ffffff' }]);
  assert.equal(legacy.apply([{ kind: 'node.patchGeometry', id: '旧 节点', patch: { x: 9 } }]).status, 'applied');
  const f = fixture(); const before = f.store.getSnapshot();
  for (const node of [{ ...text(), fontColor: 'url(evil)' }, { ...text(), assetId: 'forged' }, { ...text(), text: 'x'.repeat(65537) }, { ...text(), width: NaN }]) assert.equal(f.apply([{ kind: 'node.createText', node }]).status, 'rejected');
  assert.equal(f.apply([{ kind: 'node.createText', node: text() }, { kind: 'node.delete', id: 'missing' }]).status, 'rejected');
  assert.equal(f.apply([{ kind: 'node.createText', node: text() }, { kind: 'node.createText', node: text() }]).status, 'rejected'); assert.equal(f.store.getSnapshot(), before);
});
test('structural retries are idempotent, preserve redo after noop, and obey conflict/session guards', () => {
  const f = fixture(); const request = f.request([{ kind: 'node.createText', node: text() }]);
  const first = f.operations.apply(request); assert.equal(first.status, 'applied'); assert.deepEqual(f.operations.apply(request), first); assert.equal(f.board().operationHistory.length, 1);
  f.undo(); assert.deepEqual(f.operations.apply(request), first); assert.equal(f.board().elements.length, 0); f.redo();
  assert.equal(f.apply([{ kind: 'node.reparent', id: 'text', parentId: null }]).status, 'noop'); assert.equal(f.board().operationHistory.length, 1);
  const stale = f.request([{ kind: 'node.delete', id: 'text' }]); f.apply([{ kind: 'node.createText', node: text('another') }]); assert.equal(f.operations.apply(stale).status, 'conflict');
  f.store.replaceProject([f.board()]); assert.equal(f.operations.apply(stale).code, 'SESSION_MISMATCH');
});

test('dedupe eviction keeps revision safety and new edits after undo drop only the old redo branch', () => {
  const f = fixture(); const first = f.request([{ kind: 'node.createText', node: text() }]); assert.equal(f.operations.apply(first).status, 'applied');
  for (let i = 0; i < 260; i++) assert.equal(f.apply([{ kind: 'node.patchGeometry', id: 'text', patch: { x: i + 10 } }]).status, 'applied');
  assert.equal(f.operations.apply(first).code, 'CONFLICT');
  f.undo(); const before = f.board().operationHistoryIndex;
  assert.equal(f.apply([{ kind: 'node.reparent', id: 'text', parentId: null }]).status, 'noop'); assert.equal(f.board().operationHistoryIndex, before);
  f.redo(); assert.equal(f.board().elements[0].x, 269);
  f.undo(); assert.equal(f.apply([{ kind: 'node.createText', node: text('branch') }]).status, 'applied'); assert.equal(f.board().operationHistoryIndex, f.board().operationHistory.length - 1);
});

(async () => { let failed = 0; for (const [name, run] of tests) { try { await run(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } } console.log(`plugin transactions: ${tests.length - failed}/${tests.length} passed`); if (failed) process.exitCode = 1; })();
