const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./register-typescript.cjs');
const { createKernel } = require('../plugin-runtime/kernel.ts');
const { loadBuiltinPlugins } = require('../plugin-runtime/loader.ts');
const { activateCoreModules, CORE_MODULE_IDS } = require('../core-modules/index.ts');
const { BUILTIN_PLUGINS } = require('../builtin-plugins/index.ts');
const { resolveStartupPluginProfile, createPluginProfileManager, PLUGIN_PROFILE_MANAGER_SERVICE } = require('../plugin-runtime/plugin-profile-manager.ts');

const manifests = BUILTIN_PLUGINS.map(plugin => plugin.manifest);
assert.equal(CORE_MODULE_IDS.length, 4);
assert.ok(manifests.every(manifest => !CORE_MODULE_IDS.includes(manifest.id)));
// Exercise the old user preference shape with every optional capability disabled.
const patch = { patches: [
  ...manifests.map(manifest => ({ id: manifest.id, enabled: false })),
  ...CORE_MODULE_IDS.map(id => ({ id, enabled: false, config: { legacy: true } })),
] };
const storage = { getItem: () => JSON.stringify(patch), setItem: () => {}, removeItem: () => {} };
const { profile } = resolveStartupPluginProfile(manifests, storage, [], CORE_MODULE_IDS);
assert.deepEqual(profile.enabledPluginIds, []);
assert.ok(profile.plugins.every(plugin => !CORE_MODULE_IDS.includes(plugin.id)));
assert.ok(!profile.rejected.some(item => CORE_MODULE_IDS.includes(item.id)));
const kernel = createKernel();
kernel.provide(PLUGIN_PROFILE_MANAGER_SERVICE, createPluginProfileManager({
  manifests, activeProfile: profile, storage, reload() {}, hostModuleIds: CORE_MODULE_IDS,
}));
let activatedPlugins = 0;
kernel.on('plugin:activated', () => activatedPlugins++);
const dispose = activateCoreModules(kernel);
loadBuiltinPlugins(kernel, []);
assert.equal(activatedPlugins, 0, 'host modules must not enter the optional loader lifecycle');
const sections = kernel.contributions.list('settings_sections').map(item => item.id);
for (const id of ['builtin.settings-plugins', 'builtin.core-settings.general', 'builtin.core-settings.appearance', 'builtin.core-settings.canvas', 'builtin.core-settings.hotkeys', 'builtin.config-manager.presets', 'builtin.config-manager.storage']) {
  assert.ok(sections.includes(id), `missing host recovery section: ${id}`);
}
assert.ok(kernel.contributions.get('canvas_widgets', 'builtin.ui-shell.topbar'));
assert.ok(kernel.contributions.get('ui_panels', 'builtin.panel-plugin-manager'));
const startup = fs.readFileSync(path.join(__dirname, '../index.tsx'), 'utf8');
assert.ok(startup.indexOf('activateCoreModules(kernel)') < startup.indexOf('loadBuiltinPlugins(kernel,'));
assert.match(startup, /hostModuleIds: CORE_MODULE_IDS/);
dispose();
dispose();
assert.equal(kernel.contributions.list('settings_sections').length, 0);
assert.equal(kernel.contributions.list('canvas_widgets').length, 0);
console.log('core-modules: optional profile empty; host settings, preset recovery and shell remain registered');
