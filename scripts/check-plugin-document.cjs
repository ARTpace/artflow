'use strict';
const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const { createCanvasDocumentState } = require('../utils/canvas-document-state.ts');
const { createDocumentSDK, DOCUMENT_SERVICE, OPERATIONS_SERVICE, DOCUMENT_PROVIDER } = require('../plugin-runtime/document-sdk.ts');
const { createServiceDirectory, resolveServiceBindings, SERVICE_DIRECTORY, usePluginService } = require('../plugin-runtime/service-directory.ts');
const { createKernel } = require('../plugin-runtime/kernel.ts');
const { loadBuiltinPlugin } = require('../plugin-runtime/loader.ts');
const { applyCanvasOperation } = require('../utils/operationHistory.ts');
const { resolvePluginProfile } = require('../plugin-runtime/profile.ts');
const node = (id, x = 0) => ({ id, type: 'image', x, y: 0, width: 100, height: 100, rotation: 0, src: 'private-asset', custom: { nested: true } });
const board = (id = 'board-a') => ({ id, name: id, elements: [node('one', 0), node('two', 30), node('three', 300)], operationHistory: [], operationHistoryIndex: -1, zoom: 1, panOffset: { x: 0, y: 0 } });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function fixture() {
  const store = createCanvasDocumentState([board(), board('board-b')]); const controller = new AbortController();
  let busy = false; const sdk = createDocumentSDK(store, { selection: () => ['one', 'two', 'three'], isBusy: () => busy });
  const consumer = sdk.forConsumer('test.actor', controller.signal);
  const request = (id, x = 42) => { const t = consumer.document.getContext(); return { sessionId: t.sessionId, boardId: t.boardId, revision: t.revision, requestId: id, label: 'test geometry', operations: [{ kind: 'node.patchGeometry', id: 'one', patch: { x } }] }; };
  return { store, controller, sdk, ...consumer, request, busy: value => { busy = value; } };
}
test('bounded immutable geometry snapshots do not expose assets or mutate shared state', () => {
  const f = fixture(); const token = f.document.getContext(); const page = f.document.query(token, { limit: 1 });
  assert.equal(page.length, 1); assert.equal(page[0].src, undefined); assert.equal(page[0].custom, undefined);
  assert.throws(() => { page[0].geometry.x = 999; }, TypeError); assert.throws(() => { token.selectionIds.push('forged'); }, TypeError);
  assert.equal(f.store.getSnapshot().boards[0].elements[0].x, 0);
  assert.throws(() => f.document.query(token, { limit: 501 }), /1..500/);
});
test('atomic batch is one existing undo entry, undo/redo update revisions without asset changes', () => {
  const f = fixture(); const req = f.request('first'); req.operations.push({ kind: 'node.patchGeometry', id: 'two', patch: { y: 20 } });
  const result = f.operations.apply(req); assert.equal(result.status, 'applied'); assert.equal(result.actor, 'test.actor');
  assert.deepEqual(result.affectedIds, ['one', 'two']);
  const b = f.store.getSnapshot().boards[0]; assert.equal(b.operationHistory.length, 1); assert.equal(b.elements[0].src, 'private-asset');
  f.store.setBoards(boards => boards.map(current => current.id === b.id ? { ...current, elements: applyCanvasOperation(current.elements, current.operationHistory[0], 'undo'), operationHistoryIndex: -1 } : current));
  assert.equal(f.store.getSnapshot().boards[0].elements[0].x, 0); assert.equal(f.store.revision(b.id), 2);
  f.store.setBoards(boards => boards.map(current => current.id === b.id ? { ...current, elements: applyCanvasOperation(current.elements, current.operationHistory[0], 'redo'), operationHistoryIndex: 0 } : current));
  assert.equal(f.store.getSnapshot().boards[0].elements[0].x, 42); assert.equal(f.store.revision(b.id), 3);
});
test('same tick stale revisions cannot overwrite edits; duplicate retries remain idempotent', () => {
  const f = fixture(); const first = f.request('one'); const stale = f.request('two', 99);
  const result = f.operations.apply(first); assert.equal(f.operations.apply(stale).code, 'CONFLICT');
  assert.deepEqual(f.operations.apply(first), result); assert.equal(f.store.getSnapshot().boards[0].operationHistory.length, 1);
  assert.equal(f.operations.apply({ ...first, operations: [{ kind: 'node.patchGeometry', id: 'one', patch: { x: 55 } }] }).code, 'REQUEST_ID_REUSED');
});
test('board switching, project reload with reused IDs and deleted/recreated board reject stale work', () => {
  const f = fixture(); const request = f.request('stale');
  f.store.setActiveBoardId('board-b'); assert.equal(f.operations.apply(request).code, 'BOARD_MISMATCH');
  f.store.replaceProject([board()]); assert.equal(f.operations.apply(request).code, 'SESSION_MISMATCH');
  const next = f.request('recreated'); f.store.setBoards([]); f.store.setBoards([board()]);
  assert.equal(f.operations.apply(next).code, 'CONFLICT');
});
test('invalid mixed batch, locator/id edits, NaN, forged actor and busy/aborted requests leave state intact', () => {
  const f = fixture(); const original = f.store.getSnapshot();
  const mixed = f.request('mixed'); mixed.operations.push({ kind: 'node.patchGeometry', id: 'missing', patch: { x: 1 } });
  assert.equal(f.operations.apply(mixed).code, 'NOT_FOUND'); assert.equal(f.store.getSnapshot(), original);
  for (const patch of [{ src: 'evil' }, { id: 'evil' }, { width: 0 }, { x: NaN }, { unknown: 1 }]) {
    const req = f.request('invalid'); req.operations[0].patch = patch; assert.equal(f.operations.apply(req).code, 'INVALID_REQUEST');
  }
  assert.equal(f.operations.apply({ ...f.request('actor'), actor: 'core' }).code, 'INVALID_REQUEST');
  f.busy(true); assert.equal(f.operations.apply(f.request('busy')).code, 'BUSY'); f.busy(false);
  const req = f.request('abort'); f.controller.abort(); assert.equal(f.operations.apply(req).code, 'ABORTED'); assert.equal(f.store.getSnapshot(), original);
});
test('subscription observes committed revisions, ignores camera, survives listener error, stops on abort', () => {
  const f = fixture(); const revisions = [];
  f.document.subscribe(() => revisions.push(f.document.getContext().revision));
  f.store.setBoards(boards => boards.map(b => ({ ...b, zoom: 2 }))); assert.deepEqual(revisions, []);
  f.operations.apply(f.request('changed')); assert.deepEqual(revisions, [1]);
  f.controller.abort(); f.store.replaceProject([board()]); assert.deepEqual(revisions, [1]);
});
test('service directory checks bindings/major/duplicates; profile binds only supported core provider', () => {
  assert.throws(() => resolveServiceBindings([{ serviceBindings: { 'canvas.document': 'untrusted.provider' } }]), /Unsupported/);
  const profile = resolvePluginProfile([], [{ id: 'base', source: 'base', serviceBindings: { 'canvas.document': DOCUMENT_PROVIDER } }]);
  assert.equal(profile.serviceBindings['canvas.document'], DOCUMENT_PROVIDER);
  const directory = createServiceDirectory(profile.serviceBindings);
  assert.throws(() => directory.provide(DOCUMENT_SERVICE, 2, DOCUMENT_PROVIDER, () => ({})), /mismatch/);
  const old = directory.provide(DOCUMENT_SERVICE, 1, DOCUMENT_PROVIDER, () => ({}));
  assert.throws(() => directory.provide(DOCUMENT_SERVICE, 1, DOCUMENT_PROVIDER, () => ({})), /already/);
  old(); const fresh = directory.provide(DOCUMENT_SERVICE, 1, DOCUMENT_PROVIDER, () => ({})); old();
  assert.equal(directory.list().find(entry => entry.id === DOCUMENT_SERVICE).available, true); fresh();
});
test('real builtin plugin uses scoped actor, current board SDK and existing reversible journal', () => {
  const f = fixture(); const root = createKernel(); const directory = createServiceDirectory(); root.provide(SERVICE_DIRECTORY, directory);
  let actor; directory.provide(DOCUMENT_SERVICE, 1, DOCUMENT_PROVIDER, ctx => f.sdk.forConsumer(ctx.pluginId, ctx.signal).document);
  directory.provide(OPERATIONS_SERVICE, 1, DOCUMENT_PROVIDER, ctx => { actor = ctx.pluginId; return f.sdk.forConsumer(ctx.pluginId, ctx.signal).operations; });
  const { toolsCanvasPlugin } = require('../builtin-plugins/tools-canvas/index.tsx'); const loaded = loadBuiltinPlugin(root, toolsCanvasPlugin);
  const command = root.contributions.get('commands', 'arrange.distribute-h').value;
  assert.equal(command.isEnabled(root), true); command.run(root);
  assert.equal(actor, 'builtin.tools-canvas'); assert.equal(f.store.getSnapshot().boards[0].elements[1].x, 150);
  assert.equal(f.store.getSnapshot().boards[0].operationHistory.length, 1);
  f.store.setActiveBoardId('board-b'); command.run(root); assert.equal(f.store.getSnapshot().boards[1].elements[1].x, 150);
  loaded.dispose(); assert.throws(() => command.run(root), /scope/);
});

test('idempotency survives node deletion; noops preserve history; geometry points are detached', () => {
  const f = fixture(); const request = f.request('replay'); const applied = f.operations.apply(request);
  f.store.setBoards(boards => boards.map(b => ({ ...b, elements: b.elements.filter(e => e.id !== 'one') })));
  assert.deepEqual(f.operations.apply(request), applied);
  const g = fixture(); assert.equal(g.operations.apply(g.request('noop', 0)).status, 'noop'); assert.equal(g.store.revision('board-a'), 0);
  g.store.setBoards(boards => boards.map(b => ({ ...b, elements: [{ id: 'path', type: 'path', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], strokeWidth: 1 }] })));
  const token = g.document.getContext(); const snapshot = g.document.query(token);
  assert.throws(() => { snapshot[0].geometry.points[0].x = 99; }, TypeError);
  const r = g.request('points'); const points = [{ x: 2, y: 2 }, { x: 12, y: 12 }]; r.operations = [{ kind: 'node.patchGeometry', id: 'path', patch: { points } }];
  assert.equal(g.operations.apply(r).status, 'applied'); points[0].x = 900; assert.equal(g.store.getSnapshot().boards[0].elements[0].points[0].x, 2);
});
test('subscriber reentrancy sees committed state; exceptions cannot undo a successful transaction', () => {
  const f = fixture(); let result; let once = false;
  f.document.subscribe(() => { if (once) return; once = true; result = f.operations.apply(f.request('nested', 90)); });
  const off = f.document.subscribe(() => { throw new Error('expected subscriber error'); });
  assert.equal(f.operations.apply(f.request('outer')).status, 'applied'); assert.equal(result.status, 'applied');
  assert.equal(f.store.getSnapshot().boards[0].elements[0].x, 90); assert.equal(f.store.revision('board-a'), 2); off();
});


test('locked nodes and unsupported group transforms reject the whole transaction', () => {
  const f = fixture(); f.store.setBoards(boards => boards.map(b => ({ ...b, elements: b.elements.map(e => e.id === 'two' ? { ...e, isLocked: true } : e) })));
  const request = f.request('locked'); request.operations.push({ kind: 'node.patchGeometry', id: 'two', patch: { x: 90 } });
  const before = f.store.getSnapshot(); assert.equal(f.operations.apply(request).code, 'INVALID_REQUEST'); assert.equal(f.store.getSnapshot(), before);
  f.store.setBoards(boards => boards.map(b => ({ ...b, elements: b.elements.map(e => e.id === 'one' ? { ...e, type: 'group' } : e) })));
  assert.equal(f.operations.apply(f.request('group')).code, 'INVALID_REQUEST');
});

(async () => { let failed = 0; for (const [name, run] of tests) { try { await run(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } } console.log(`plugin document SDK: ${tests.length - failed}/${tests.length} passed`); if (failed) process.exitCode = 1; })();
