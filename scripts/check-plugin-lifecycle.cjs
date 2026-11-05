const assert = require('node:assert/strict');
const path = require('node:path');
require('./register-typescript.cjs');
const { createKernel } = require('../plugin-runtime/kernel.ts');
const { loadBuiltinPlugin, loadBuiltinPlugins, loadBuiltinPluginAsync } = require('../plugin-runtime/loader.ts');
const manifest = (id, extra = {}) => ({ manifestVersion: 1, id, version: '1.0.0', name: id, author: 'test', license: 'MIT', host: 'renderer', runtime: { mode: 'builtin', entry: './index.ts' }, requires: [], optionalRequires: [], capabilities: ['command'], ...extra });
const plugin = (id, activate, extra) => ({ manifest: manifest(id, extra), activate });
const item = (id, pluginId = 'test.owner') => ({ id, pluginId, value: {} });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('old contribution/service disposer cannot remove replacements', () => {
  const root = createKernel();
  const entry = item('test.command');
  const undo = root.contributions.register('commands', entry); undo();
  root.contributions.register('commands', entry); undo();
  assert.ok(root.contributions.get('commands', entry.id));
  const old = root.provide('test.service', 1); old(); root.provide('test.service', 2); old();
  assert.equal(root.use('test.service'), 2);
});
test('replace() hands ownership to the newest registration without throwing', () => {
  const root = createKernel();
  let disposed = 0;
  const first = root.replace('workspace.ui-bridge', { mount: 1 }, () => disposed++);
  assert.equal(root.use('workspace.ui-bridge').mount, 1);
  // 重挂载（HMR / 受控刷新）：同名再登记不再抛 "service already provided"，旧登记被释放。
  const second = root.replace('workspace.ui-bridge', { mount: 2 }, () => disposed++);
  assert.equal(root.use('workspace.ui-bridge').mount, 2);
  assert.equal(disposed, 1);
  first(); // 旧 disposer 不得摘掉新登记
  assert.equal(root.use('workspace.ui-bridge').mount, 2);
  second();
  assert.equal(root.has('workspace.ui-bridge'), false);
});
test('render-phase host services use replace(), never a component-local ref guard', () => {
  // 内核是跨挂载存活的单例（引导只在 index.tsx 跑一次），而 HMR 会重挂载组件并重置局部 ref。
  // 这两处服务在渲染期登记：若用 ref 守卫，重挂载时二次 provide 抛错 → 整树卸载 → 白屏。
  const fs = require('node:fs');
  const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const app = read('App.tsx');
  assert.match(app, /pluginKernel\.replace\(\s*WORKSPACE_UI_BRIDGE_SERVICE/);
  assert.doesNotMatch(app, /uiBridgeProvidedRef/);
  const settings = read('components/CanvasSettings.tsx');
  assert.match(settings, /kernel\.replace\(\s*SETTINGS_UI_BRIDGE_SERVICE/);
  assert.doesNotMatch(settings, /bridgeProvidedRef/);
});
test('duplicate subscriptions have independent ownership and suppress late snapshot delivery', () => {
  const root = createKernel(); let calls = 0;
  const callback = () => calls++;
  const off = root.on('event', callback); root.on('event', callback); off(); root.emit('event'); assert.equal(calls, 1);
  let late = 0; let remove;
  root.on('late', () => remove()); remove = root.on('late', () => late++); root.emit('late'); assert.equal(late, 0);
});
test('failed activation rolls back skins, contributions, service and listener', () => {
  const root = createKernel(); let calls = 0; let cleanup = 0;
  assert.throws(() => loadBuiltinPlugin(root, plugin('test.bad', ctx => {
    ctx.contributions.register('commands', item('test.cmd', 'test.bad'));
    ctx.provide('test.service', {}, () => cleanup++); ctx.on('ping', () => calls++);
    throw new Error('intentional');
  }, { contributes: { skins: [{ id: 'test.skin', name: 'test skin', tokens: {} }] } })), /intentional/);
  assert.equal(root.contributions.list('commands').length, 0); assert.equal(root.contributions.list('skins').length, 0);
  assert.throws(() => root.use('test.service')); root.emit('ping'); assert.equal(calls, 0); assert.equal(cleanup, 1);
});
test('staging is invisible outside, ownership automatic, cleanup reverse and idempotent', () => {
  const root = createKernel(); const order = []; let scope; let events = 0;
  root.on('ready', () => { assert.ok(root.has('test.service')); events++; });
  const loaded = loadBuiltinPlugin(root, plugin('test.owner', ctx => {
    scope = ctx;
    ctx.effects.defer(() => order.push('first'));
    ctx.provide('test.service', 3, () => order.push('service'));
    ctx.contributions.register('commands', { id: 'test.command', value: 1 });
    assert.equal(ctx.use('test.service'), 3); assert.equal(root.has('test.service'), false);
    assert.equal(root.contributions.list('commands').length, 0);
    ctx.emit('ready'); assert.equal(events, 0);
    return () => order.push('last');
  }));
  assert.equal(events, 1); assert.equal(root.contributions.get('commands', 'test.command').pluginId, 'test.owner');
  loaded.dispose(); loaded.dispose(); assert.deepEqual(order, ['last', 'service', 'first']);
  assert.equal(scope.signal.aborted, true); assert.throws(() => scope.provide('late', 1)); assert.throws(() => scope.emit('late'));
});
test('duplicate plugin blocked before activate and cleanup errors do not stop rollback', () => {
  const root = createKernel(); let entered = 0; let cleanup = 0;
  const loaded = loadBuiltinPlugin(root, plugin('test.duplicate', () => { entered++; }));
  assert.throws(() => loadBuiltinPlugin(root, plugin('test.duplicate', () => entered++)), /duplicate/); assert.equal(entered, 1);
  loaded.dispose();
  const bad = loadBuiltinPlugin(root, plugin('test.cleanup', ctx => {
    ctx.effects.defer(() => cleanup++); ctx.effects.defer(() => { throw new Error('expected cleanup failure'); });
  })); bad.dispose(); assert.equal(cleanup, 1);
});
test('forged contribution owner rejected', () => {
  const root = createKernel();
  assert.throws(() => loadBuiltinPlugin(root, plugin('test.owner', ctx => ctx.contributions.register('commands', item('test.forged', 'test.other')))), /owner/);
  assert.equal(root.contributions.list('commands').length, 0);
});
test('dependency ordering, failed provider isolation and blocked provider unload', () => {
  const root = createKernel(); let consumer = 0;
  const [provider, dependent] = loadBuiltinPlugins(root, [plugin('test.consumer', () => { consumer++; }, { requires: ['test.provider'] }), plugin('test.provider')]);
  assert.equal(consumer, 1); assert.equal(provider.manifest.id, 'test.provider');
  assert.throws(() => provider.dispose(), /dependent/); dependent.dispose(); provider.dispose();
  loadBuiltinPlugins(root, [plugin('test.provider', () => { throw new Error('provider failed'); }), plugin('test.consumer', () => { consumer++; }, { requires: ['test.provider'] })]);
  assert.equal(consumer, 1);
});
test('managed timer canceled on failed activation and disposal', async () => {
  const root = createKernel(); let calls = 0;
  assert.throws(() => loadBuiltinPlugin(root, plugin('test.timer', ctx => { ctx.effects.setTimeout(() => calls++, 0); throw new Error('fail'); })));
  const loaded = loadBuiltinPlugin(root, plugin('test.timer', ctx => { ctx.effects.setInterval(() => calls++, 1); })); loaded.dispose();
  await tick(); assert.equal(calls, 0);
});
test('async timeout aborts scope, forbids late registration, cleans late returned effect', async () => {
  const root = createKernel(); let release; let scope; let cleanup = 0;
  const task = loadBuiltinPluginAsync(root, plugin('test.async', async ctx => {
    scope = ctx; ctx.provide('test.pending', 1); await new Promise(resolve => { release = resolve; }); return () => cleanup++;
  }), { timeoutMs: 2 });
  await assert.rejects(task, /timed out/); assert.equal(scope.signal.aborted, true);
  assert.equal(root.has('test.pending'), false); assert.throws(() => scope.provide('late', 1));
  release(); await tick(); assert.equal(cleanup, 1);
  loadBuiltinPlugin(root, plugin('test.async')).dispose();
});
test('async activation publishes atomically, conflicts roll back earlier publications', async () => {
  const root = createKernel(); let release;
  const task = loadBuiltinPluginAsync(root, plugin('test.conflict', async ctx => {
    ctx.provide('test.first', 1); ctx.provide('test.conflict', 2); await new Promise(resolve => { release = resolve; });
  }));
  await Promise.resolve(); assert.equal(root.has('test.first'), false);
  root.provide('test.conflict', 9); release(); await assert.rejects(task, /already provided/);
  assert.equal(root.has('test.first'), false); assert.equal(root.use('test.conflict'), 9);
  const good = await loadBuiltinPluginAsync(root, plugin('test.good', async ctx => { await Promise.resolve(); ctx.provide('test.good', 1); }));
  assert.equal(root.use('test.good'), 1); good.dispose();
});
test('external abort and async disposal drain managed calls', async () => {
  const root = createKernel(); const controller = new AbortController(); let scope;
  const task = loadBuiltinPluginAsync(root, plugin('test.abort', ctx => { scope = ctx; return new Promise(() => {}); }), { signal: controller.signal });
  await Promise.resolve(); controller.abort(); await assert.rejects(task, /aborted/); assert.equal(scope.signal.aborted, true);
  let release; let cleanup = 0;
  const loaded = loadBuiltinPlugin(root, plugin('test.drain', ctx => {
    scope = ctx; ctx.effects.defer(() => cleanup++);
    void ctx.effects.track(() => new Promise(resolve => { release = resolve; }));
  }));
  await Promise.resolve(); assert.throws(() => loaded.dispose(), /disposeAsync/);
  const disposing = loaded.disposeAsync({ timeoutMs: 1000 });
  assert.equal(scope.signal.aborted, true); assert.equal(cleanup, 0); assert.throws(() => scope.effects.track(async () => {}));
  release(); assert.deepEqual(await disposing, { timedOut: false }); assert.equal(cleanup, 1);
  const bounded = loadBuiltinPlugin(root, plugin('test.bounded', ctx => { void ctx.effects.track(() => new Promise(() => {})); }));
  await Promise.resolve(); assert.deepEqual(await bounded.disposeAsync({ timeoutMs: 1 }), { timedOut: true });
});

test('activation reservation rejects concurrent and batch duplicate IDs before side effects', async () => {
  const root = createKernel(); let release; let entered = 0;
  const task = loadBuiltinPluginAsync(root, plugin('test.reserved', async () => { await new Promise(resolve => { release = resolve; }); }));
  assert.throws(() => loadBuiltinPlugin(root, plugin('test.reserved', () => { entered++; })), /duplicate/);
  await Promise.resolve(); release(); (await task).dispose();
  const batch = loadBuiltinPlugins(root, [plugin('test.batch', () => { entered++; }), plugin('test.batch', () => { entered++; })]);
  assert.equal(batch.length, 1); assert.equal(entered, 1); batch[0].dispose();
});
test('pre-abort does not activate, sync loader rejects promise and cleans its late result', async () => {
  const root = createKernel(); const controller = new AbortController(); controller.abort(); let entered = 0;
  await assert.rejects(loadBuiltinPluginAsync(root, plugin('test.preabort', () => { entered++; }), { signal: controller.signal }), /aborted/);
  assert.equal(entered, 0); let cleanup = 0;
  assert.throws(() => loadBuiltinPlugin(root, plugin('test.sync', async ctx => {
    ctx.provide('test.sync', 1); return () => cleanup++;
  })), /async activation/);
  await tick(); assert.equal(cleanup, 1); assert.equal(root.has('test.sync'), false);
});
test('cancelled staged leases and failed activation events never become visible', () => {
  const root = createKernel(); let events = 0; let cleanup = 0;
  root.on('should-not-publish', () => events++);
  assert.throws(() => loadBuiltinPlugin(root, plugin('test.events', ctx => { ctx.emit('should-not-publish'); throw new Error('fail'); })));
  const loaded = loadBuiltinPlugin(root, plugin('test.cancel', ctx => {
    const undo = ctx.provide('test.cancel', 1, () => cleanup++); undo(); undo();
    const off = ctx.on('should-not-publish', () => events++); off();
    const remove = ctx.contributions.register('commands', { id: 'test.cancel', value: 1 }); remove();
  }));
  assert.equal(events, 0); assert.equal(cleanup, 1); assert.equal(root.has('test.cancel'), false);
  assert.equal(root.contributions.list('commands').length, 0); loaded.dispose(); assert.equal(cleanup, 1);
});
test('real builtin inventory loads through v1 adapter and tools-canvas owns arrange registrations automatically', () => {
  // 皮肤插件/引擎在 activate、dispose 路径会碰 document/window.localStorage；
  // Node self-check 下给最小浏览器环境垫片（仅本测试使用，不影响应用运行时）。
  const memStore = new Map();
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = { localStorage: {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => { memStore.set(k, String(v)); },
      removeItem: (k) => { memStore.delete(k); },
    } };
  }
  if (typeof globalThis.document === 'undefined') {
    const fakeEl = () => ({ setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {},
      insertBefore() {}, style: { setProperty() {}, removeProperty() {} } });
    globalThis.document = { documentElement: fakeEl(), head: { appendChild() {}, insertBefore() {} },
      createElement: () => fakeEl(), getElementById: () => null };
  }
  const { BUILTIN_PLUGINS } = require('../builtin-plugins/index.ts');
  const { HOST_PLATFORM_SERVICE } = require('../plugin-runtime/host-platform.ts');
  const { EXTENSION_RUNTIME_SERVICE } = require('../plugin-runtime/extension-service.ts');
  const { createExtensionHost } = require('../plugin-runtime/extension-host.ts');
  const { SLOTS } = require('../plugin-runtime/kernel.ts');
  const root = createKernel(); root.provide(HOST_PLATFORM_SERVICE, {});
  // 扩展宿主服务与 index.tsx 引导一致：activate 时 core-extensions 会消费它。
  root.provide(EXTENSION_RUNTIME_SERVICE, createExtensionHost({ getItem: () => null, setItem: () => {} }));
  // 与 index.tsx 引导一致：皮肤引擎服务先于内置插件装载提供（皮肤插件 activate 经 ctx.use 消费）。
  const { SKIN_ENGINE_SERVICE, createSkinEngine } = require('../plugin-runtime/skin-engine.ts');
  root.provide(SKIN_ENGINE_SERVICE, createSkinEngine(root));
  // editable 通道的插件（formats-* / commands-core / media）不在 BUILTIN_PLUGINS 里 —— 它们随包
  // 播种到 userData，启动时由 loadEditablePlugins 读源码并**合并进同一批**装载。本测试在 Node 下
  // 直接照做：扫描 plugins 的 editable 包，用受信任执行产出模块（等价 index.tsx 的合并）。
  const { readEditablePlugins } = require('../main/editablePlugins.cjs');
  const { evaluateEditableSource } = require('../plugin-runtime/editable-loader.ts');
  const editablePackages = readEditablePlugins(path.join(__dirname, '../plugins')).plugins;
  assert.ok(editablePackages.length > 0, 'expected seeded editable plugins under plugins');
  const editableModules = editablePackages.map(raw => evaluateEditableSource(raw));
  const allModules = [...BUILTIN_PLUGINS, ...editableModules];
  const loaded = loadBuiltinPlugins(root, allModules);
  assert.equal(loaded.length, allModules.length);
  const commands = root.contributions.list('commands').filter(entry => entry.pluginId === 'builtin.tools-canvas' && entry.id.startsWith('arrange.'));
  assert.ok(commands.length > 0);
  // editable 插件的注册确实落地（commands-core 的命令 + media 的 handler）。
  assert.ok(root.contributions.list('commands').some(entry => entry.id === 'edit.undo'));
  assert.ok(root.contributions.list('format_handlers').some(entry => entry.id === 'builtin.media.format-video'));
  // core-extensions 的守卫 hook + project-portable 的两条工程命令。
  assert.ok(root.contributions.list('hooks').some(entry => entry.id === 'core.operation-guard'));
  assert.ok(root.contributions.list('commands').some(entry => entry.id === 'project.export-artflow'));
  assert.ok(root.contributions.list('commands').some(entry => entry.id === 'project.import-artflow'));
  for (const loadedPlugin of [...loaded].reverse()) { loadedPlugin.dispose(); loadedPlugin.dispose(); }
  for (const slot of SLOTS) assert.equal(root.contributions.list(slot).length, 0, slot);
  console.log(`builtin compatibility: ${loaded.length} modules, ${commands.length} scoped arrange commands`);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
  }
  console.log(`plugin lifecycle: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
})();
