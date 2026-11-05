const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./register-typescript.cjs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const {
  captureStartupDisabledExternalPluginIds,
  readStartupDisabledExternalPluginIds,
  readDisabledExternalPluginIds,
  setExternalPluginEnabled,
} = require('../plugin-runtime/external-plugin-prefs.ts');
const {
  filterPluginCatalog, isEditableMode, isInfrastructureBuiltin, needsPluginReload, sourceBucketOf,
} = require('../builtin-plugins/ui-plugin-manager/catalog.ts');
const { createKernel } = require('../plugin-runtime/kernel.ts');
const { loadBuiltinPlugin } = require('../plugin-runtime/loader.ts');
const { resolvePluginProfile, BASE_PROFILE } = require('../plugin-runtime/profile.ts');
const { createPluginProfileManager, PLUGIN_PROFILE_MANAGER_SERVICE } = require('../plugin-runtime/plugin-profile-manager.ts');
const { HOST_PLATFORM_SERVICE, createHostPlatformService } = require('../plugin-runtime/host-platform.ts');
const { EXTENSION_RUNTIME_SERVICE } = require('../plugin-runtime/extension-service.ts');
const { listPanelContributions } = require('../plugin-runtime/panel-contributions.ts');
const { activatePluginManager } = require('../builtin-plugins/ui-plugin-manager/index.tsx');
// core-extensions 已迁 editable channel：编排在 plugins 播种源，经受信任执行产出模块。
const { readEditablePlugins } = require('../main/editablePlugins.cjs');
const { evaluateEditableSource } = require('../plugin-runtime/editable-loader.ts');
const coreExtensionsPlugin = evaluateEditableSource(
  readEditablePlugins(path.join(__dirname, '../plugins')).plugins
    .find(plugin => plugin.id === 'builtin.core-extensions'),
);

const values = new Map([['artflow.external-plugins.disabled', '["local.before"]']]);
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
};
global.localStorage = storage;

// Changing a third-party preference must not make a freshly mounted Settings section
// mistake that preference for the active startup state (the original regression).
const startup = captureStartupDisabledExternalPluginIds(storage);
assert.deepEqual(startup, ['local.before']);
assert.ok(Object.isFrozen(startup));
setExternalPluginEnabled(storage, 'local.new', false);
assert.deepEqual(readDisabledExternalPluginIds(storage), ['local.before', 'local.new']);
assert.deepEqual(readStartupDisabledExternalPluginIds(), ['local.before']);
assert.equal(captureStartupDisabledExternalPluginIds(storage), startup);
assert.ok(needsPluginReload({ source: 'external', id: 'local.new', name: 'New', startupEnabled: true, enabled: false }));

const entries = [
  { id: 'builtin.format', source: 'builtin', name: 'Image reader', description: 'Open JPEG', startupEnabled: true, enabled: false },
  { id: 'builtin.core-extensions', source: 'editable', name: 'Extension host', startupEnabled: true, enabled: true },
  { id: 'local.new', source: 'external', name: 'Local tool', startupEnabled: true, enabled: false },
  { id: 'ext.first', source: 'package', name: 'JSON palette', enabled: true },
  { id: 'ext.off', source: 'package', name: 'Offline JSON', enabled: false },
];
const filter = (options = {}) => filterPluginCatalog(entries, { query: '', source: 'all', status: 'all', ...options });
assert.equal(filter().length, 5);
// 2026-10-11 产品决定：来源只分两档 —— 内置（编译进本体）/ 外部（其余全部合并）。
assert.equal(sourceBucketOf('builtin'), 'builtin');
assert.equal(sourceBucketOf('editable'), 'external');
assert.equal(sourceBucketOf('external'), 'external');
assert.equal(sourceBucketOf('package'), 'external');
assert.deepEqual(filter({ source: 'builtin' }).map(entry => entry.id), ['builtin.format']);
assert.deepEqual(filter({ source: 'external' }).map(entry => entry.id),
  ['builtin.core-extensions', 'local.new', 'ext.first', 'ext.off']);
assert.deepEqual(filter({ status: 'pending' }).map(entry => entry.id), ['builtin.format', 'local.new']);
assert.deepEqual(filter({ source: 'external', status: 'disabled' }).map(entry => entry.id), ['local.new', 'ext.off']);
assert.deepEqual(filter({ query: 'jPeG' }).map(entry => entry.id), ['builtin.format']);
// JSON 包没有 startupEnabled 概念 → 永远不「待重载」（按 source 取，别跟着数组下标走）。
assert.equal(needsPluginReload(entries.find(entry => entry.source === 'package')), false);
assert.equal(isInfrastructureBuiltin('builtin.core-settings'), false);
assert.equal(isInfrastructureBuiltin('builtin.formats-image-doc'), false);
// core-extensions 已外置为可编辑包，不再算「编译进本体的基础设施」；它走 editable 档。
assert.equal(isInfrastructureBuiltin('builtin.core-extensions'), false);
// 判定依据是插件 manifest 自报的 runtime.mode，不是主进程注入的 sourceDir 句柄。
assert.equal(isEditableMode('editable'), true);
assert.equal(isEditableMode('builtin'), false);
assert.equal(isEditableMode(undefined), false);

// Exactly one settings section after both builtin plugins are activated: the extension
// runtime keeps its hooks/commands but not a competing second management page.
const kernel = createKernel();
const fixtureManifest = {
  ...coreExtensionsPlugin.manifest, id: 'builtin.format-fixture', name: 'Format fixture',
  nameI18n: { zho: '格式示例' }, category: 'format', requires: [], runtime: { mode: 'builtin', entry: 'index.tsx' },
};
const manifests = [coreExtensionsPlugin.manifest, fixtureManifest];
kernel.provide(PLUGIN_PROFILE_MANAGER_SERVICE, createPluginProfileManager({
  manifests,
  activeProfile: resolvePluginProfile(manifests, [BASE_PROFILE]),
  storage,
  reload: () => {},
}));
assert.equal(createHostPlatformService().confirm('disable?'), false, 'missing confirmation bridge fails closed');
let confirmationMessage;
const confirmationHost = createHostPlatformService({ confirm: message => { confirmationMessage = message; return true; } });
assert.equal(confirmationHost.confirm('dependent list'), true);
assert.equal(confirmationMessage, 'dependent list');
kernel.provide(HOST_PLATFORM_SERVICE, createHostPlatformService());
const installed = [{ package: {
  id: 'ext.first', name: 'JSON palette', version: '1.0.0', permissions: [],
  node: { id: 'ext.first.node' }, formats: [], tools: [],
}, enabled: true, grants: [] }];
kernel.provide(EXTENSION_RUNTIME_SERVICE, {
  runtime: { installed: () => installed, subscribe: () => () => {} },
  invokeTool: async () => {}, updateNode: () => ({ ok: false }),
});
const disposeCore = loadBuiltinPlugin(kernel, coreExtensionsPlugin);
const disposeManager = activatePluginManager(kernel);
const panels = listPanelContributions(kernel);
assert.deepEqual(panels.map(panel => panel.id), ['builtin.panel-plugin-manager']);
// Management UI is a draggable non-modal floating window (product decision 2026-10),
// sized a step wider than the default theme-studio float but below the modal settings.
assert.equal(panels[0].value.presentation, 'floating');
assert.equal(panels[0].value.floatingWidth, 'lg');
assert.equal(panels[0].value.title('zho'), '插件与扩展');
const Component = panels[0].value.component;
const html = renderToStaticMarkup(React.createElement(Component, { kernel, onClose: () => {} }));
assert.match(html, /插件与扩展/);
assert.match(html, /外部插件/);
assert.match(html, /JSON 扩展包/);
const sourceSelect = html.slice(html.indexOf('aria-label="按来源筛选"'));
const sourceBlock = sourceSelect.slice(0, sourceSelect.indexOf('</select>') + 9);
assert.match(sourceBlock, /<option value="builtin"[^>]*>内置插件 · \d+/, 'the source dropdown offers builtin plugins with a count');
assert.match(sourceBlock, /<option value="external"[^>]*>外部插件 · \d+/);
// 2026-10-11 产品决定：只保留两档；editable / package 折叠进「外部插件」，不再各占一个 option。
assert.equal((sourceBlock.match(/<option /g) || []).length, 2, 'exactly two source buckets in the dropdown');
assert.doesNotMatch(sourceBlock, /<option value="(editable|package)"/);
assert.doesNotMatch(sourceBlock, /<option value="all"/, 'no mixed “All” view: sources are never listed side by side');
assert.doesNotMatch(sourceBlock, /<option value="(local|ext)\./, 'third-party and package rows never leak into the source dropdown');
assert.doesNotMatch(html, /data-bp-plugin-row="ext\.first/, 'the default builtin view does not render package rows together with builtins');
assert.doesNotMatch(html, /data-bp-plugin-row="local\.new/, 'the default builtin view does not render third-party rows together with builtins');
// the list body carries no caption rows at all: one flat list per source, categories live in hover help
assert.doesNotMatch(html, /<h3\b/, 'per-category caption rows are gone');
assert.match(html, /aria-label="按来源筛选"/);
assert.match(html, /aria-label="状态筛选"/);
assert.match(html, /data-bp-plugin-manager/);
// Header chrome is ONE toolbar row (product decision 2026-10): title+help, source tabs,
// search, status filter, pending pill and install menu share a single row; no stacked caption rows.
assert.match(html, /data-bp-plugin-toolbar/);
assert.doesNotMatch(html, /data-bp-plugin-toolbar[\s\S]*rounded-lg bg-white\/\[0\.04\] p-1/, 'source segments must live inside the single toolbar row, not a second row');
assert.match(html, /aria-label="悬停查看插件管理说明"/);
assert.doesNotMatch(html, /开关和设置即时保存。/, 'guidance must appear only on hover/focus');
const builtinRow = html.match(/<li data-bp-plugin-row="builtin.format-fixture"[^>]*>([\s\S]*?)<\/li>/)?.[1];
assert.ok(builtinRow, 'builtin plugins list in one compact row each');
assert.doesNotMatch(builtinRow, /<p(?:\s|>)|<dl(?:\s|>)|<div(?:\s|>)/, 'one plugin cannot add a second row or inline details');
assert.match(builtinRow, /role="switch"/);
assert.match(builtinRow, /查看详情与设置|详情与操作/, 'each row exposes a hover help button');
assert.doesNotMatch(builtinRow, /本次启动/, 'startup state belongs in hover help, not another line');
// third-party and JSON rows reuse the same one-line component even though only one source renders per view
assert.match(fs.readFileSync(path.join(__dirname, '..', 'builtin-plugins/ui-plugin-manager/extension-packages.tsx'), 'utf8'), /CompactPluginRow/);
disposeManager();
disposeCore.dispose();
assert.deepEqual(listPanelContributions(kernel), []);

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
assert.match(read('components/TopBar.tsx'), /data-bp-plugin-entry/);
assert.doesNotMatch(read('components/TopBar.tsx'), /disabled=\{pluginPanelCount === 0\}/);
// The old violet shortcut that deep-linked into Settings is gone: the manager is
// contributed as a floating ui_panels entry, reachable from the extension directory.
assert.doesNotMatch(read('plugin-runtime/panel-host.tsx'), /data-bp-plugin-manager-shortcut|onOpenPluginManager/);
assert.match(read('plugin-runtime/panel-host.tsx'), /floatingWidth/);
assert.match(read('builtin-plugins/ui-plugin-manager/index.tsx'), /'ui_panels'/);
assert.match(read('builtin-plugins/ui-plugin-manager/index.tsx'), /presentation: 'floating'/);
// 插件管理有「悬浮面板」与「设置页 section」两个入口，但共用同一内容组件 —— 不是两个独立页面。
assert.match(read('builtin-plugins/ui-plugin-manager/index.tsx'), /'settings_sections'/);
assert.match(read('builtin-plugins/ui-plugin-manager/index.tsx'), /component: PluginManagerSettingsSection/);
assert.match(read('builtin-plugins/ui-plugin-manager/index.tsx'), /component: PluginManagerFloatingPanel/);
assert.doesNotMatch(read('App.tsx'), /settings-plugin-manager/);
assert.match(read('App.tsx'), /requestedSectionId=\{requestedSettingsSectionId\}/);
assert.match(read('components/CanvasSettings.tsx'), /data-bp-ui-scrim="" className="fixed inset-0 z-50/);
assert.match(read('index.tsx'), /readStartupDisabledExternalPluginIds\(\)/);
// 扩展宿主（已外置为可编辑包）不得再注册一个竞争的设置页。
assert.doesNotMatch(read('plugins/builtin.core-extensions/plugin.js'), /settings_sections/);
assert.match(read('builtin-plugins/ui-plugin-manager/compact-row.tsx'), /data-bp-plugin-row/);
assert.match(read('builtin-plugins/ui-plugin-manager/compact-row.tsx'), /role="tooltip"/);
// Details are an inline accordion row now (product decision 2026-10): expanding a plugin
// must not open a modal overlay; the row list itself stays one line per plugin.
assert.match(read('builtin-plugins/ui-plugin-manager/details-dialog.tsx'), /data-bp-plugin-details/);
assert.match(read('builtin-plugins/ui-plugin-manager/details-dialog.tsx'), /<li/);
assert.doesNotMatch(read('builtin-plugins/ui-plugin-manager/details-dialog.tsx'), /createPortal|aria-modal/);
assert.match(read('builtin-plugins/ui-plugin-manager/index.tsx'), /InlinePluginDetails/);
assert.doesNotMatch(read('builtin-plugins/ui-plugin-manager/index.tsx'), /PluginDetailsDialog/);
console.log('Plugin manager: one entry, one-line rows, hover hints, preserved details and three-source state passed.');
