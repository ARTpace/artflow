'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
require('./register-typescript.cjs');
const { createKernel } = require('../plugin-runtime/kernel.ts');
const { createCanvasDocumentState } = require('../utils/canvas-document-state.ts');
const { createDocumentSDK } = require('../plugin-runtime/document-sdk.ts');
const { applyCanvasOperation } = require('../utils/operationHistory.ts');
const { serializeProjectDocument, deserializeProjectDocument } = require('../utils/projectDocument.ts');
const {
  validateExtensionPackage, validateData, readInstalled, ExtensionNodeRegistry,
} = require('../plugin-runtime/extension-package.ts');
const { createExtensionRuntime } = require('../plugin-runtime/extension-registry.ts');
const { bindExtensionRuntime, extensionSchemaProvider, getExtensionNodeAvailability } = require('../plugin-runtime/extension-renderer.ts');
const { executeGuardedTool, validateToolArguments } = require('../plugin-runtime/guarded-tools.ts');
const { evaluateToolGuard, createOperationGuardHook } = require('../plugin-runtime/operation-guard.ts');
const { projectRegistryAsAgentTools } = require('../plugin-runtime/agent-orchestration.ts');

const memoryStorage = () => {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
};
const samplePath = path.join(__dirname, '../extensions/sample-inspector/package.json');
const SAMPLE = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

const tests = []; const test = (name, fn) => tests.push([name, fn]);
const freshRuntime = (pkg = SAMPLE) => { const storage = memoryStorage(); const runtime = createExtensionRuntime(storage); runtime.install(pkg); return { runtime, storage }; };

test('package validator accepts the out-of-tree sample and rejects executable/foreign shapes', () => {
  const pkg = validateExtensionPackage(SAMPLE);
  assert.equal(pkg.id, 'ext.sample-inspector');
  assert.ok(Object.isFrozen(pkg));
  for (const bad of [
    { ...SAMPLE, engine: 'javascript' },
    { ...SAMPLE, id: 'notext' },
    { ...SAMPLE, version: '2.0' },
    { ...SAMPLE, permissions: ['document.write', 'document.write'] },
    { ...SAMPLE, permissions: ['fs.read'] },
    { ...SAMPLE, runtime: { entry: './index.js' } },
    { ...SAMPLE, node: { ...SAMPLE.node, id: 'other.node' } },
    { ...SAMPLE, node: { ...SAMPLE.node, fields: {} } },
    { ...SAMPLE, formats: [{ extension: 'insp', recipe: 'eval' }, { extension: 'insp', recipe: 'json-lines' }] },
    { ...SAMPLE, tools: [{ ...SAMPLE.tools[0], field: 'missing' }] },
  ]) {
    const broken = JSON.parse(JSON.stringify(bad));
    assert.throws(() => validateExtensionPackage(broken), /extension|package|node|field|format|tool|Invalid|Only|Unknown|Unsupported|must|Duplicate|exceeds/i);
  }
  // data validation is schema-bound and rejects forged/oversized records
  assert.throws(() => validateData({ title: 'ok', __proto__: {} }, SAMPLE.node, true));
  assert.throws(() => validateData({ title: 'x'.repeat(8193) }, SAMPLE.node, true), /Invalid|exceeds/i);
});

test('registry lifecycle: install, enable/disable, dependencies, grants, version replacement', () => {
  const { runtime } = freshRuntime();
  bindExtensionRuntime(runtime);
  assert.equal(getExtensionNodeAvailability(SAMPLE.node.id), 'available');
  const nodeId = SAMPLE.node.id;
  runtime.setEnabled(SAMPLE.id, false);
  assert.equal(getExtensionNodeAvailability(nodeId), 'disabled');
  runtime.setEnabled(SAMPLE.id, true);
  assert.equal(getExtensionNodeAvailability(nodeId), 'available');
  // dependency gate
  const depPkg = JSON.parse(JSON.stringify(SAMPLE));
  depPkg.id = 'ext.dep-target'; depPkg.node.id = 'ext.dep-target.node'; depPkg.version = '1.0.0';
  depPkg.tools = depPkg.tools.map(tool => ({ ...tool, id: tool.id.replace('ext.sample-inspector.', 'ext.dep-target.') }));
  const consumer = JSON.parse(JSON.stringify(SAMPLE));
  consumer.id = 'ext.dep-consumer'; consumer.node.id = 'ext.dep-consumer.node'; consumer.version = '1.0.0'; consumer.requires = ['ext.dep-target'];
  consumer.tools = consumer.tools.map(tool => ({ ...tool, id: tool.id.replace('ext.sample-inspector.', 'ext.dep-consumer.') }));
  const { runtime: r2 } = freshRuntime();
  assert.throws(() => r2.install(consumer), /Dependency/);
  r2.install(depPkg);
  r2.install(consumer);
  assert.throws(() => r2.setEnabled('ext.dep-target', false), /depends on it/);
  // version replacement preserves the node definition but re-checks grants
  const upgraded = JSON.parse(JSON.stringify(SAMPLE));
  upgraded.version = '3.0.0';
  upgraded.permissions = ['document.read', 'imports.parse']; // drops document.write
  runtime.replaceVersion(SAMPLE.id, upgraded);
  const after = runtime.installed().find(e => e.package.id === SAMPLE.id);
  assert.equal(after.package.version, '3.0.0');
  assert.ok(after.previous);
  assert.ok(!after.grants.includes('document.write'));
  runtime.dispose();
});

test('lazy schema migration upgrades stored v1 nodes in place without dropping data', () => {
  const { runtime } = freshRuntime();
  const reg = new ExtensionNodeRegistry();
  reg.register(SAMPLE.id, SAMPLE.node);
  const migrated = reg.normalize(SAMPLE.node.id, 1, { titleText: 'Legacy', count: 2, passed: false, notes: 'old' });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.data.title, 'Legacy');
  assert.equal(migrated.data.count, 2);
  assert.ok(!('titleText' in migrated.data));
  assert.throws(() => reg.normalize(SAMPLE.node.id, 1, { titleText: 'x', title: 'collision', count: 1 }), /collision/i);
  runtime.dispose();
});

function sdkFixture(runtime, elements = []) {
  const store = createCanvasDocumentState([{ id: 'board', name: 'Board', elements, operationHistory: [], operationHistoryIndex: -1, zoom: 1, panOffset: { x: 0, y: 0 } }]);
  const removed = []; const signal = new AbortController().signal;
  const sdk = createDocumentSDK(store, { selection: () => [], isBusy: () => false, onDeleted: (board, ids) => removed.push([board, [...ids]]) }, { schemas: extensionSchemaProvider });
  const { document, operations } = sdk.forConsumer('test.extensions', signal);
  let sequence = 0;
  const request = (ops) => { const t = document.getContext(); return { sessionId: t.sessionId, boardId: t.boardId, revision: t.revision, label: 'extension', requestId: `request-${++sequence}`, operations: ops }; };
  const apply = ops => operations.apply(request(ops));
  return { store, request, apply, operations, document, removed, board: () => store.getSnapshot().boards[0] };
}

test('extension nodes create with schema defaults, update, delete and undo cleanly', () => {
  const { runtime } = freshRuntime();
  bindExtensionRuntime(runtime);
  const fx = sdkFixture(runtime);
  const result = fx.apply([{ kind: 'extension.node.create', node: { id: 'node-a', typeId: SAMPLE.node.id, x: 10, y: 20, data: { title: 'Created', count: 1 } } }]);
  assert.equal(result.status, 'applied');
  const created = fx.board().elements.find(e => e.id === 'node-a');
  assert.equal(created.type, SAMPLE.node.id);
  assert.equal(created.width, SAMPLE.node.width);
  assert.equal(created.height, SAMPLE.node.height);
  assert.equal(created.extensionData.count, 1);
  assert.equal(created.extensionSchemaVersion, SAMPLE.node.version);
  // update
  assert.equal(fx.apply([{ kind: 'extension.node.update', id: 'node-a', data: { count: 5 } }]).status, 'applied');
  assert.equal(fx.board().elements.find(e => e.id === 'node-a').extensionData.count, 5);
  // schema-violating and foreign-field updates reject
  assert.equal(fx.apply([{ kind: 'extension.node.update', id: 'node-a', data: { count: 'not-a-number' } }]).status, 'rejected');
  assert.equal(fx.apply([{ kind: 'extension.node.update', id: 'node-a', data: { forged: true } }]).status, 'rejected');
  // delete + onDeleted
  assert.equal(fx.apply([{ kind: 'node.delete', id: 'node-a' }]).status, 'applied');
  assert.deepEqual(fx.removed, [['board', ['node-a']]]);
  assert.equal(fx.board().elements.length, 0);
  runtime.dispose();
});

test('creating against an unknown or disabled extension type is rejected, not fabricated', () => {
  const { runtime } = freshRuntime();
  bindExtensionRuntime(runtime);
  const fx = sdkFixture(runtime);
  assert.equal(fx.apply([{ kind: 'extension.node.create', node: { id: 'x1', typeId: 'ext.missing.node', data: { title: 'nope' } } }]).status, 'rejected');
  runtime.setEnabled(SAMPLE.id, false);
  assert.equal(fx.apply([{ kind: 'extension.node.create', node: { id: 'x2', typeId: SAMPLE.node.id, data: { title: 'nope' } } }]).code, 'NOT_FOUND');
  runtime.dispose();
});

test('import batch: entries parse, commit as one transaction, cancel and limits', () => {
  const { runtime } = freshRuntime();
  bindExtensionRuntime(runtime);
  const fx = sdkFixture(runtime);
  const boardId = fx.document.getContext().boardId;
  // Host-side commit: one document transaction per batch, same shape as App wiring.
  const commit = (batch) => (entries) => {
    const operations = entries.flatMap(entry => entry.records.map((record, i) => ({
      kind: 'extension.node.create',
      node: { id: `${entry.id}-${i}`, typeId: SAMPLE.node.id, x: 0, y: 0, data: record },
    })));
    const token = fx.document.getContext();
    const result = fx.operations.apply({
      sessionId: token.sessionId, boardId: token.boardId, revision: token.revision,
      label: 'import', requestId: `ext-import-${batch}`, operations,
    });
    if (result.status !== 'applied' && result.status !== 'noop') throw new Error(result.message ?? result.code);
  };
  const batchId = runtime.beginBatch(SAMPLE.id, boardId);
  runtime.addFileEntry(batchId, { id: 'file-1', name: 'a.insp' });
  runtime.updateBatchProgress(batchId, 'file-1', { stage: 'reading', done: 10, total: 100 });
  const records = [
    { title: 'One', count: 1, passed: false, notes: 'n1' },
    { title: 'Two', count: 2, passed: true, notes: 'n2' },
  ];
  runtime.completeFileEntry(batchId, 'file-1', records);
  runtime.addFileEntry(batchId, { id: 'file-2', name: 'b.insp' });
  runtime.markBatchEntryFailed(batchId, 'file-2', 'parse failed');
  runtime.commitBatch(batchId, boardId, commit(batchId));
  const batch = runtime.batches().find(b => b.id === batchId);
  assert.equal(batch.status, 'failed'); // one entry failed, parsed entry committed
  assert.equal(batch.entries.find(e => e.id === 'file-1').status, 'committed');
  const committed = fx.board().elements.filter(e => e.type === SAMPLE.node.id);
  assert.equal(committed.length, 2);
  assert.equal(committed[0].extensionData.title, 'One');
  assert.equal(fx.board().operationHistory.length, 1); // one transaction for the whole batch
  // a fresh fully-good batch completes
  const b2 = runtime.beginBatch(SAMPLE.id, boardId);
  runtime.addFileEntry(b2, { id: 'g1', name: 'good.insp' });
  runtime.completeFileEntry(b2, 'g1', [{ title: 'Good', count: 9, passed: true, notes: 'ok' }]);
  runtime.commitBatch(b2, boardId, commit(b2));
  assert.equal(runtime.batches().find(b => b.id === b2).status, 'completed');
  assert.equal(fx.board().elements.filter(e => e.type === SAMPLE.node.id).length, 3);
  // commit after terminal state is a safe no-op
  runtime.commitBatch(b2, boardId, commit(b2));
  // cancel a live batch
  const b3 = runtime.beginBatch(SAMPLE.id, boardId);
  runtime.addFileEntry(b3, { id: 'c1', name: 'c.insp' });
  runtime.cancelBatch(b3);
  assert.equal(runtime.batches().find(b => b.id === b3).status, 'cancelled');
  // record limit
  const b4 = runtime.beginBatch(SAMPLE.id, boardId);
  runtime.addFileEntry(b4, { id: 'big', name: 'big.insp' });
  assert.throws(() => runtime.completeFileEntry(b4, 'big', Array.from({ length: 1001 }, (_, i) => ({ title: `t${i}`, count: 0, passed: false, notes: 'x' }))), /1000/);
  runtime.dispose();
});

test('guarded tools: guard denial is final, phases run, timeout and re-authorize abort', async () => {
  const kernel = createKernel();
  const { runtime } = freshRuntime();
  bindExtensionRuntime(runtime);
  const guard = createOperationGuardHook({
    isPackageActive: id => runtime.installed().some(e => e.package.id === id && e.enabled),
    packagePermissions: id => runtime.installed().find(e => e.package.id === id)?.grants ?? [],
  });
  const order = [];
  kernel.contributions.register('hooks', { id: 'test.guard', pluginId: 'builtin.core-extensions', value: guard });
  kernel.contributions.register('hooks', {
    id: 'test.before', pluginId: 'builtin.core-extensions',
    value: { phase: 'before', run: () => { order.push('before'); } },
  });
  kernel.contributions.register('hooks', {
    id: 'test.after', pluginId: 'builtin.core-extensions',
    value: { phase: 'after', run: () => { order.push('after'); } },
  });
  kernel.contributions.register('hooks', {
    id: 'test.wrap', pluginId: 'builtin.core-extensions',
    value: { phase: 'wrap', wrap: async (call, next) => { order.push('wrap'); return next(); } },
  });
  const base = { id: `${SAMPLE.id}.${SAMPLE.tools[0].id}`, actor: 'agent', args: { packageId: SAMPLE.id, toolId: SAMPLE.tools[0].id, surface: 'agent', operationKinds: ['extension.node.update'], value: 1 } };
  await executeGuardedTool(kernel, base, async () => { order.push('exec'); return 'ok'; }, { authorize: () => {}, timeoutMs: 2000 });
  assert.deepEqual(order, ['before', 'wrap', 'exec', 'after']);
  // disabled package → guard denies and execute never runs
  order.length = 0;
  runtime.setEnabled(SAMPLE.id, false);
  await assert.rejects(
    () => executeGuardedTool(kernel, base, async () => { order.push('exec'); return 'ok'; }, { authorize: () => {}, timeoutMs: 2000 }),
    /not active/,
  );
  assert.equal(order.includes('exec'), false);
  runtime.setEnabled(SAMPLE.id, true);
  // timeout aborts execution
  let timeoutError = null;
  try {
    await executeGuardedTool(kernel, base, (signal) => new Promise((resolve) => { const t = setTimeout(() => resolve('late'), 500); signal.addEventListener('abort', () => { clearTimeout(t); }); }), { authorize: () => {}, timeoutMs: 50 });
  } catch (error) { timeoutError = error; }
  assert.ok(timeoutError, 'timeout should reject');
  assert.match(timeoutError.message, /cancelled|timed out/i);
  // re-authorize before execution: a failing authorize aborts even after the guard passed
  let executed = false;
  await assert.rejects(
    () => executeGuardedTool(kernel, { ...base, args: { ...base.args } }, async () => { executed = true; return 'should-not-run'; }, {
      authorize: () => { throw new Error('no longer active'); },
      timeoutMs: 2000,
    }), /no longer active/);
  assert.equal(executed, false);
  runtime.dispose();
});

test('agent tool projection exposes guarded extension tools and enforces surface', async () => {
  const kernel = createKernel();
  const { runtime } = freshRuntime();
  bindExtensionRuntime(runtime);
  const invoke = async (packageId, toolId, value) => {
    const entry = runtime.installed().find(e => e.package.id === packageId);
    const tool = entry.package.tools.find(t => t.id === toolId);
    return { ok: true, applied: { packageId, toolId, field: tool.field, value } };
  };
  const context = {
    extensions: () => runtime.installed().filter(e => e.enabled).map(e => ({
      packageId: e.package.id,
      toolId: '',
      title: '',
      field: '',
      parameter: 'value',
      parameterType: 'number',
      operationKinds: ['extension.node.update'],
      active: e.enabled,
      permissions: e.grants,
    })),
    invoke,
  };
  // The projection iterates each tool; build a per-tool view.
  const tools = projectRegistryAsAgentTools(kernel, {
    ...context,
    extensions: () => runtime.installed().filter(e => e.enabled).flatMap(e => e.package.tools.map(tool => ({
      packageId: e.package.id,
      toolId: tool.id,
      title: tool.title,
      field: tool.field,
      parameter: tool.parameter,
      parameterType: SAMPLE.node.fields[tool.field].type,
      operationKinds: ['extension.node.update'],
      active: e.enabled,
      permissions: e.grants,
    }))),
  });
  const bump = tools.find(t => t.name === 'extension_ext_sample_inspector_bump_count');
  assert.ok(bump, 'extension tool projected');
  assert.equal(bump.parameters.required[0], 'value');
  const result = await bump.handler({ value: 4 }, kernel);
  assert.equal(result.ok, true);
  assert.equal(result.applied.value, 4);
  // disabling the extension removes the tool from the projection
  runtime.setEnabled(SAMPLE.id, false);
  const after = projectRegistryAsAgentTools(kernel, {
    ...context,
    extensions: () => runtime.installed().filter(e => e.enabled).flatMap(e => e.package.tools.map(tool => ({
      packageId: e.package.id, toolId: tool.id, title: tool.title, field: tool.field, parameter: tool.parameter,
      parameterType: SAMPLE.node.fields[tool.field].type, operationKinds: ['extension.node.update'], active: e.enabled, permissions: e.grants,
    }))),
  });
  assert.ok(!after.find(t => t.name === 'extension_ext_sample_inspector_bump_count'));
  runtime.dispose();
});

test('extension node round-trips through real v2 persistence and survives plugin absence', () => {
  const { runtime } = freshRuntime();
  bindExtensionRuntime(runtime);
  const fx = sdkFixture(runtime);
  fx.apply([{ kind: 'extension.node.create', node: { id: 'persist-1', typeId: SAMPLE.node.id, x: 0, y: 0, data: { title: 'Persist', count: 12, passed: true, notes: 'keep' } } }]);
  const doc = serializeProjectDocument(fx.store.getSnapshot().boards);
  const node = doc.nodes.find(n => n.id === 'persist-1');
  assert.equal(node.nodeType, SAMPLE.node.id);
  assert.equal(node.properties.extensionData.count, 12);
  assert.equal(node.properties.extensionSchemaVersion, SAMPLE.node.version);
  const restored = deserializeProjectDocument(doc);
  const el = restored[0].elements.find(e => e.id === 'persist-1');
  assert.equal(el.type, SAMPLE.node.id);
  assert.equal(el.extensionData.count, 12);
  assert.equal(el.extensionData.passed, true);
  // uninstall the package: node data is preserved, availability flips to unknown
  runtime.uninstall(SAMPLE.id);
  const doc2 = serializeProjectDocument(fx.store.getSnapshot().boards);
  const restored2 = deserializeProjectDocument(doc2);
  const el2 = restored2[0].elements.find(e => e.id === 'persist-1');
  assert.equal(el2.extensionData.title, 'Persist');
  assert.equal(getExtensionNodeAvailability(SAMPLE.node.id), 'unknown');
  runtime.dispose();
});

test('guard verdict matrix: actor, surface, grants and read-only kinds', () => {
  const context = { isPackageActive: id => id === 'ext.ok', packagePermissions: id => (id === 'ext.ok' ? ['document.write', 'agent.invoke'] : []) };
  const g = (call) => evaluateToolGuard(call, context);
  assert.equal(g({ actor: 'agent', surface: 'agent', packageId: 'ext.ok', operationKinds: ['extension.node.update'] }).allow, true);
  assert.equal(g({ actor: 'agent', surface: 'agent', packageId: 'ext.off', operationKinds: ['extension.node.update'] }).allow, false);
  assert.equal(g({ actor: 'agent', surface: 'agent', operationKinds: ['node.patchGeometry'] }).allow, true); // read-only, no package
  assert.equal(g({ actor: 'command', surface: 'command', packageId: 'ext.ok', operationKinds: ['extension.node.update'] }).allow, true);
  assert.equal(g({ actor: '', surface: 'agent', operationKinds: [] }).allow, false);
  assert.equal(g({ actor: 'agent', surface: 'agent', packageId: 'ext.noperm', operationKinds: ['extension.node.update'] }).allow, false);
  const hook = createOperationGuardHook(context);
  assert.equal(hook.phase, 'guard');
  assert.equal(hook.run({ actor: 'agent', args: { surface: 'agent', packageId: 'ext.off', operationKinds: ['extension.node.update'] } }).allow, false);
  assert.equal(hook.run({ actor: 'agent', args: { surface: 'agent', packageId: 'ext.ok', operationKinds: ['extension.node.update'] } }).allow, true);
});

test('tool argument validation rejects unknown, missing and non-finite inputs', () => {
  const props = { value: { type: 'number' } };
  assert.deepEqual(validateToolArguments({ value: 3 }, props, ['value']), { value: 3 });
  assert.throws(() => validateToolArguments({ value: NaN }, props, ['value']), /finite/i);
  assert.throws(() => validateToolArguments({ value: 1, extra: 2 }, props, ['value']), /Unknown|missing/i);
  assert.throws(() => validateToolArguments({}, props, ['value']), /Unknown|missing/i);
  assert.throws(() => validateToolArguments({ value: 'str' }, props, ['value']), /type/i);
});

(async () => {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    const [name, fn] = tests[i];
    try {
      await fn();
      console.log(`  ok ${i + 1} - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${i + 1} - ${name}\n    ${error && error.stack || error}`);
    }
  }
  console.log(`\nplugin-extensions: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
