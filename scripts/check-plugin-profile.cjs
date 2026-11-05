const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const { resolvePluginProfile, BASE_PROFILE, readStoredUserProfileLayer } = require('../plugin-runtime/profile.ts');
const { createPluginProfileManager, resolveStartupPluginProfile } = require('../plugin-runtime/plugin-profile-manager.ts');
const manifest = (id, requires = []) => ({ manifestVersion: 1, id, version: '1.0.0', name: id, author: 'test', license: 'MIT', host: 'renderer', runtime: { mode: 'builtin', entry: './index.ts' }, requires, optionalRequires: [], capabilities: ['command'] });
const manifests = [manifest('test.base'), manifest('test.child', ['test.base']), manifest('test.leaf', ['test.child'])];
const values = new Map();
const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
const make = (active = resolvePluginProfile(manifests, [BASE_PROFILE])) => createPluginProfileManager({ manifests, activeProfile: active, storage, reload() {} });
let manager = make();
assert.deepEqual(manager.getDisableDependents('test.base'), ['test.child', 'test.leaf']);
assert.equal(manager.setPluginEnabled('test.base', false).ok, false);
assert.equal(values.size, 0, 'no implicit disable persisted');
assert.equal(manager.setPluginEnabled('test.base', false, { confirmedDependentIds: ['test.child'] }).ok, false);
assert.equal(manager.setPluginEnabled('test.base', false, { confirmedDependentIds: ['test.child', 'test.leaf', 'unshown'] }).ok, false);
assert.equal(manager.setPluginEnabled('test.leaf', false).ok, true);
assert.equal(manager.setPluginEnabled('test.child', false).ok, true, 'pending disabled leaf must not block child');
assert.equal(manager.setPluginEnabled('test.base', false).ok, true, 'pending disabled child must not block base');
assert.deepEqual(manager.getSnapshot().activeProfile.enabledPluginIds, manifests.map(item => item.id));
values.clear();
manager = make();
assert.equal(manager.setPluginEnabled('test.base', false, { confirmedDependentIds: ['test.child', 'test.leaf'] }).ok, true);
assert.deepEqual(manager.getSnapshot().pendingProfile.enabledPluginIds, []);
assert.equal(manager.setPluginEnabled('test.leaf', true).ok, false, 'missing dependency must reject enabling');
assert.equal(manager.setPluginEnabled('test.base', true).ok, true);
assert.equal(manager.setPluginEnabled('test.child', true).ok, true);
assert.equal(manager.setPluginEnabled('test.leaf', true).ok, true);
assert.deepEqual(manager.getDisableDependents('test.base'), ['test.child', 'test.leaf']);
// Newly pending-enabled plugins also require confirmation, even if inactive at startup.
values.clear();
manager = make(resolvePluginProfile(manifests, [BASE_PROFILE, { id: 'user', source: 'user', patches: [{ id: 'test.leaf', enabled: false }] }]));
assert.equal(manager.setPluginEnabled('test.leaf', true).ok, true);
assert.equal(manager.setPluginEnabled('test.base', false, { confirmedDependentIds: ['test.child'] }).ok, false);
values.set('artflow.profile.patch.v1', JSON.stringify({ patches: [{ id: 'builtin.ui-shell', enabled: false, config: { obsolete: true } }, { id: 'test.leaf', enabled: false }] }));
const startup = resolveStartupPluginProfile(manifests, storage, [], ['builtin.ui-shell']);
assert.equal(startup.warning, null);
assert.equal(startup.profile.rejected.length, 0);
manager = createPluginProfileManager({ manifests, activeProfile: startup.profile, storage, reload() {}, hostModuleIds: ['builtin.ui-shell'] });
assert.equal(manager.setPluginEnabled('test.leaf', true).ok, true);
assert.ok(!values.get('artflow.profile.patch.v1').includes('builtin.ui-shell'));
values.set('artflow.profile.patch.v1', JSON.stringify({ patches: [{ id: 'builtin.cards', enabled: false, config: { legacy: true } }, { id: 'builtin.cards-media', enabled: true }] }));
assert.deepEqual(readStoredUserProfileLayer(storage).patches, [
  { id: 'builtin.cards-files', enabled: false, config: { legacy: true } },
  { id: 'builtin.cards-reader', enabled: false, config: { legacy: true } },
  { id: 'builtin.cards-media', enabled: true, config: undefined },
]);
console.log('Plugin profile: pending dependencies, exact confirmed cascade, host migration and split-card preferences passed.');
