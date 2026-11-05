const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('./register-typescript.cjs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createKernel } = require('../plugin-runtime/kernel.ts');
const { loadBuiltinPlugin } = require('../plugin-runtime/loader.ts');
const { CARD_PLUGINS } = require('../builtin-plugins/cards/index.tsx');
const { materializeRendererContributions, getMaterializedCardComponent } = require('../plugin-runtime/renderer-materialization.ts');
const { CanvasElement } = require('../components/CanvasElement.tsx');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const groups = {
  'builtin.cards-files': ['bookmark', 'code', 'font', 'markdown', 'model3d', 'file'],
  'builtin.cards-media': ['video', 'audio'],
  'builtin.cards-reader': ['comic', 'reader'],
};
assert.deepEqual(CARD_PLUGINS.map(plugin => plugin.manifest.id).sort(), Object.keys(groups).sort());

// Every default card remains registered; unloading any group leaves the others intact.
for (const disabledId of Object.keys(groups)) {
  const kernel = createKernel();
  const loaded = CARD_PLUGINS.map(plugin => loadBuiltinPlugin(kernel, plugin));
  materializeRendererContributions(kernel);
  for (const type of Object.values(groups).flat()) assert.ok(getMaterializedCardComponent(type), type);
  loaded.find(plugin => plugin.manifest.id === disabledId).dispose();
  materializeRendererContributions(kernel);
  for (const [id, types] of Object.entries(groups)) {
    for (const type of types) assert.equal(Boolean(getMaterializedCardComponent(type)), id !== disabledId, `${disabledId}: ${type}`);
  }
  for (const plugin of loaded) plugin.dispose();
}

// Both external JSON and editable inline manifests must depend only on their own group.
for (const [id, dependency] of [['builtin.media', 'builtin.cards-media'], ['builtin.formats-files', 'builtin.cards-files'], ['builtin.formats-reader', 'builtin.cards-reader']]) {
  const manifest = JSON.parse(read(`plugins/${id}/manifest.json`));
  assert.deepEqual(manifest.requires, [dependency]);
  let definition;
  vm.runInNewContext(read(`plugins/${id}/plugin.js`), { Artflow: { definePlugin(value) { definition = value; } } });
  if (definition.manifest.requires) assert.deepEqual(Array.from(definition.manifest.requires), [dependency]);
  const kernel = createKernel();
  const renderer = loadBuiltinPlugin(kernel, CARD_PLUGINS.find(plugin => plugin.manifest.id === dependency));
  const parser = loadBuiltinPlugin(kernel, { manifest });
  parser.dispose();
  renderer.dispose();
}

// Exercise host fallback with frozen builtin and third-party data, without loading any card chunks.
materializeRendererContributions(createKernel());
for (const extra of [{ type: 'video' }, { type: 'plugin-node', nodeType: 'third.party', pluginData: { secret: 'DO_NOT_RENDER' } }]) {
  const element = Object.freeze({ id: 'missing', x: 10, y: 20, width: 240, height: 140, rotation: 0, ...extra });
  const before = JSON.stringify(element);
  const markup = renderToStaticMarkup(React.createElement('svg', null, React.createElement(CanvasElement, {
    element, elements: [element], selectedElementIds: ['missing'], zoom: 1,
    editingElement: null, croppingState: null, aiRotationState: null, setEditingElement() {},
  })));
  assert.ok(markup.includes(`data-card-missing="${extra.nodeType || extra.type}"`));
  assert.ok(markup.includes('数据已保留'));
  assert.ok(markup.includes('width="240"'));
  assert.ok(!markup.includes('DO_NOT_RENDER'));
  assert.equal(JSON.stringify(element), before);
}
// Previously seeded on-disk manifests keep custom requirements and source intact.
const { normalizeCardCapabilityManifest } = require('../plugin-runtime/card-capability-compat.ts');
const { evaluateEditableSource } = require('../plugin-runtime/editable-loader.ts');
for (const [id, dependency] of [['builtin.media', 'builtin.cards-media'], ['builtin.formats-files', 'builtin.cards-files'], ['builtin.formats-reader', 'builtin.cards-reader']]) {
  const disk = Object.freeze({ ...JSON.parse(read(`plugins/${id}/manifest.json`)), requires: Object.freeze(['builtin.cards', 'local.custom', dependency]) });
  const before = JSON.stringify(disk);
  const discovery = normalizeCardCapabilityManifest(disk);
  const actual = evaluateEditableSource({ id, manifest: disk, source: 'Artflow.definePlugin({ manifest: {}, activate() {} });' });
  assert.deepEqual(discovery.requires, [dependency, 'local.custom']);
  assert.deepEqual(actual.manifest, discovery);
  assert.equal(JSON.stringify(disk), before);
}
const unrelated = { id: 'local.third-party', requires: ['builtin.cards'] };
assert.equal(normalizeCardCapabilityManifest(unrelated), unrelated);
for (const malformed of [null, [], 'bad', { id: 'builtin.media', requires: 'builtin.cards' }]) {
  assert.equal(normalizeCardCapabilityManifest(malformed), malformed);
}
assert.match(read('index.tsx'), /readEditableManifestsSync[\s\S]*?map\(normalizeCardCapabilityManifest\)/);
console.log('Card capability checks passed: default coverage, independent teardown, parser dependencies, immutable missing-card fallback, seeded manifest compatibility.');
