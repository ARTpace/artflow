require('./register-typescript.cjs');
const assert = require('node:assert/strict');
require.extensions['.js?raw'] = (module, filename) => {
  module.exports = require('node:fs').readFileSync(filename.replace(/\?raw$/, ''), 'utf8');
};
const { installTauriPreviewBridge } = require('../plugin-runtime/tauri-preview.ts');
const createStorage = () => {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
};
(async () => {
  assert.equal(installTauriPreviewBridge({}), false);
  const calls = [];
  let perfReply = { ok: true, metrics: [{ type: 'Renderer', pid: 111, cpuPercent: 5.5, workingSetKB: 1024, peakWorkingSetKB: 0 }] };
  let comicImportReply = { ok: true, ref: 'abc123', pageNames: ['001.png'], pageCount: 1, byteSize: 9, originalName: 'book.cbz' };
  let comicPageReply = { ok: true, bytes: [1, 2, 3], mimeType: 'image/png' };
  let declarativeReply = { ok: true, plugins: [{ id: 'builtin.skins-default', name: 'Default', formatAliases: [], skins: [] }] };
  const listeners = new Map();
  const target = { localStorage: createStorage(), __TAURI__: {
    core: { invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'tauri_open_artflow') return { ok: true, name: 'test.artflow', bytes: [1, 2, 3] };
      if (command === 'tauri_perf_metrics') return perfReply;
      if (command === 'tauri_comic_import') return comicImportReply;
      if (command === 'tauri_comic_get_page') return comicPageReply;
      if (command === 'tauri_list_declarative_plugins') return declarativeReply;
      // 窗口命令返回与 Rust 侧一致的形状：bool/number/string 直返，其余是对象回执。
      if (command === 'tauri_set_always_on_top') return args.enabled;
      if (command === 'tauri_set_window_opacity') return args.opacity;
      if (command === 'tauri_set_window_background') return args.color;
      if (command === 'tauri_set_ignore_mouse_events') return args.ignore;
      return { ok: true };
    } },
    event: { listen: async (event, handler) => {
      listeners.set(event, handler);
      return () => { listeners.delete(event); };
    } },
  } };
  assert.equal(installTauriPreviewBridge(target), true);
  assert.equal(installTauriPreviewBridge(target), false);
  const app = target.artflowApp;
  // Phase 2 已交付托管项目存储（artflowStorage）与 AI 代理（artflowAi）：渲染层以
  // window.artflowStorage 是否存在决定走桌面后端还是浏览器回退，故此处必须存在且为对象。
  assert.equal(typeof target.artflowStorage, 'object', 'artflowStorage bridge must be wired in Phase 2');
  assert.equal(typeof target.artflowAi, 'object', 'artflowAi bridge must be wired in Phase 2');
  assert.equal(typeof target.artflowAi.comfyRequest, 'function', 'artflowAi.comfyRequest must be wired');
  for (const method of ['chooseProject', 'getStatus', 'importAsset', 'requestImport', 'getImportJob', 'listImportJobs', 'cancelImportJob', 'saveProject', 'loadProject', 'listRecentProjects', 'openRecentProject', 'clearRecentProjects', 'queryViewport', 'listAssetInventory', 'reclaimUnreferencedAssets', 'requestPreview', 'getPreviewJob', 'cancelPreviewJob', 'openPluginDir']) {
    assert.equal(typeof target.artflowStorage[method], 'function', `artflowStorage.${method}`);
  }
  assert.equal(app.resolveVideoShortUrl, undefined);
  assert.equal(app.isFramelessWindow, true);

  // 全部内置可编辑插件必须成套提供：少一个，依赖它的插件会被判「requires missing plugin」。
  const bundled = await app.readEditablePlugins();
  const ids = bundled.plugins.map(plugin => plugin.id).sort();
  assert.deepEqual(ids, [
    'builtin.commands-core', 'builtin.core-extensions', 'builtin.formats-files',
    'builtin.formats-image-doc', 'builtin.formats-pureref', 'builtin.formats-reader',
    'builtin.media', 'builtin.project-portable',
  ]);
  for (const plugin of bundled.plugins) {
    assert.ok(plugin.source.length > 0, `${plugin.id} source must not be empty`);
    assert.equal(plugin.manifest.id, plugin.id);
  }

  // 插件偏好：与 Electron 同一套 artflowPluginState 契约，读写回到同一份存储。
  const state = target.artflowPluginState;
  for (const method of ['readSync', 'writeSync', 'clearSync', 'readEditableManifestsSync', 'reportBoot']) {
    assert.equal(typeof state[method], 'function', `artflowPluginState.${method}`);
  }
  assert.deepEqual(state.readEditableManifestsSync().manifests.map(entry => entry.id).sort(), ids);
  assert.deepEqual(state.readSync(), { ok: true, patches: null, source: 'none' });
  const patches = [{ id: 'builtin.cutout', enabled: false }];
  assert.deepEqual(state.writeSync(patches), { ok: true, count: 1 });
  assert.deepEqual(state.readSync(), { ok: true, patches, source: 'file', schemaVersion: 1 });
  assert.equal(target.localStorage.getItem('artflow.profile.patch.migrated.v1'), null);
  assert.deepEqual(state.clearSync(), { ok: true });
  assert.deepEqual(state.readSync(), { ok: true, patches: null, source: 'none' });

  // 外部插件：Phase 2 已接真实的宿主后端（sandboxBridge），渲染层经此走 Rust 命令；
  // 原先「Tauri 预览不支持安装」的诚实拒绝是 Phase 1 占位契约，现已废弃，改测桥接存在性。
  assert.deepEqual(await app.listInstalledPlugins(), { plugins: [] });
  for (const method of ['openPanelWindow', 'listSandboxedPlugins', 'installExternalPlugin', 'installExternalPluginFromPath', 'isPluginSourcePath', 'uninstallExternalPlugin', 'invokeSandboxedPlugin', 'readPluginClients', 'readStored', 'readPluginPage', 'sandboxReply']) {
    assert.equal(typeof app[method], 'function', `artflowApp.${method} must be wired in Phase 2`);
  }

  let formatModule;
  new Function('Artflow', bundled.plugins.find(plugin => plugin.id === 'builtin.formats-files').source)({ definePlugin: value => { formatModule = value; }, host: {}, constants: {
    MARKDOWN_EXTENSIONS: [], CODE_EXTENSIONS_MAP: {}, URL_EXTENSIONS: [], FONT_EXTENSIONS: [], MODEL_3D_EXTENSIONS: ['fbx', 'glb', 'gltf'],
  } });
  const handlers = [];
  formatModule.activate({ pluginId: formatModule.manifest.id, contributions: {
    register: (slot, entry) => { handlers.push(entry.value); return () => {}; },
  } });
  const modelHandler = handlers.find(handler => handler.id === 'builtin.format-model3d');
  for (const extension of ['fbx', 'glb', 'gltf']) {
    const file = new Blob(['model']);
    Object.defineProperty(file, 'name', { value: `test.${extension}` });
    const parsed = await modelHandler.parse(file);
    assert.equal(parsed.cardType, 'model3d');
    assert.equal(parsed.fields.fileExtension, extension);
    assert.ok(parsed.fields.fileUrl.startsWith('blob:'));
    URL.revokeObjectURL(parsed.fields.fileUrl);
  }
  await app.saveBytes({ defaultName: 'test.artflow', bytes: new Uint8Array([4, 5]).buffer });
  assert.deepEqual(calls.at(-1), ['tauri_save_bytes', { request: { defaultName: 'test.artflow', bytes: [4, 5] } }]);
  const opened = await app.openArtflow();
  assert.deepEqual(Array.from(new Uint8Array(opened.bytes)), [1, 2, 3]);
  await app.openVideoLink('https://example.com/video');
  assert.equal(calls.at(-1)[0], 'tauri_open_video_link');

  // 进程指标：Rust 侧 tauri_perf_metrics 的形状必须与 Electron getPerfMetrics() 兼容。
  assert.equal(typeof app.getPerfMetrics, 'function', 'getPerfMetrics must be exposed on the Tauri bridge');
  assert.deepEqual(
    await app.getPerfMetrics(),
    [{ type: 'Renderer', pid: 111, cpuPercent: 5.5, workingSetKB: 1024, peakWorkingSetKB: 0 }],
  );
  assert.equal(calls.at(-1)[0], 'tauri_perf_metrics');
  perfReply = { ok: false, message: 'boom' };
  await assert.rejects(() => app.getPerfMetrics(), { message: 'boom' });
  perfReply = { ok: true };
  assert.deepEqual(await app.getPerfMetrics(), [], '无 metrics 字段时降级为空快照');

  // 漫画档案仓：档案字节只留在宿主侧，渲染层拿页清单与按需单页 ArrayBuffer。
  const comic = target.artflowComic;
  assert.equal(typeof comic.importArchive, 'function', 'artflowComic.importArchive must be exposed');
  assert.equal(typeof comic.getPage, 'function', 'artflowComic.getPage must be exposed');
  assert.deepEqual(
    await comic.importArchive({ bytes: new Uint8Array([1, 2]), name: 'book.cbz' }),
    { ok: true, ref: 'abc123', pageNames: ['001.png'], pageCount: 1, byteSize: 9, originalName: 'book.cbz' },
  );
  assert.deepEqual(calls.at(-1), ['tauri_comic_import', { request: { bytes: [1, 2], name: 'book.cbz' } }]);
  const page = await comic.getPage({ ref: 'abc123', index: 0 });
  assert.equal(page.ok, true);
  assert.equal(page.mimeType, 'image/png');
  assert.ok(page.bytes instanceof ArrayBuffer, 'bytes 必须是 ArrayBuffer（可直接喂 Blob）');
  assert.deepEqual(Array.from(new Uint8Array(page.bytes)), [1, 2, 3]);
  assert.deepEqual(calls.at(-1), ['tauri_comic_get_page', { request: { ref: 'abc123', index: 0 } }]);
  comicImportReply = { ok: false, message: 'comic archive exceeds 512 MiB' };
  assert.deepEqual(
    await comic.importArchive({ bytes: new Uint8Array([1]), name: 'big.cbz' }),
    { ok: false, message: 'comic archive exceeds 512 MiB' },
  );
  comicPageReply = { ok: false, message: 'page index out of range' };
  assert.deepEqual(
    await comic.getPage({ ref: 'abc123', index: 99 }),
    { ok: false, message: 'page index out of range' },
  );

  // 声明式插件：ok:false 必须抛出，不能静默变成空皮肤列表。
  assert.equal(typeof app.listDeclarativePlugins, 'function', 'listDeclarativePlugins must be exposed');
  assert.deepEqual(
    await app.listDeclarativePlugins(),
    { plugins: [{ id: 'builtin.skins-default', name: 'Default', formatAliases: [], skins: [] }] },
  );
  assert.equal(calls.at(-1)[0], 'tauri_list_declarative_plugins');
  declarativeReply = { ok: false, message: 'forbidden caller' };
  await assert.rejects(() => app.listDeclarativePlugins(), { message: 'forbidden caller' });
  declarativeReply = { ok: true };
  assert.deepEqual(await app.listDeclarativePlugins(), { plugins: [] }, '无 plugins 字段时降级为空列表');

  // 窗口控制：形参必须与 preload.cjs 一致（渲染层按 typeof result === 'string' 判失败）。
  await app.restartApp();
  assert.deepEqual(calls.at(-1), ['tauri_restart_app', undefined]);
  assert.deepEqual(await app.setAlwaysOnTop(true), true);
  assert.deepEqual(calls.at(-1), ['tauri_set_always_on_top', { enabled: true }]);
  await app.setWindowOpacity(0.5);
  assert.deepEqual(calls.at(-1), ['tauri_set_window_opacity', { opacity: 0.5 }]);
  assert.equal(await app.setWindowBackground('#111827'), '#111827');
  assert.deepEqual(calls.at(-1), ['tauri_set_window_background', { color: '#111827' }]);
  await app.setIgnoreMouseEvents(false);
  assert.deepEqual(calls.at(-1), ['tauri_set_ignore_mouse_events', { ignore: false }]);
  await app.windowControl('toggle-maximize');
  assert.deepEqual(calls.at(-1), ['tauri_window_control', { action: 'toggle-maximize' }]);
  await app.windowMove({ phase: 'start', screenX: 10, screenY: 20 });
  assert.deepEqual(calls.at(-1), ['tauri_window_move', { request: { phase: 'start', screenX: 10, screenY: 20 } }]);
  await app.windowMove({ phase: 'end' });
  assert.deepEqual(calls.at(-1), ['tauri_window_move', { request: { phase: 'end' } }]);
  await app.getWindowState();
  assert.deepEqual(calls.at(-1), ['tauri_get_window_state', undefined]);

  // 事件订阅必须返回可调用的退订函数，且退订后不再回调。
  const stateCalls = [];
  const offState = app.onWindowStateChanged(state => stateCalls.push(state));
  assert.equal(typeof offState, 'function');
  assert.ok(listeners.has('artflow-app:window-state-changed'));
  listeners.get('artflow-app:window-state-changed')({ payload: { maximized: true } });
  assert.deepEqual(stateCalls, [{ maximized: true }]);
  offState();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(listeners.has('artflow-app:window-state-changed'), false, '退订必须真正移除监听');
  const panelCalls = [];
  const offPanel = app.onPanelWindowClosed(payload => panelCalls.push(payload));
  assert.equal(typeof offPanel, 'function');
  listeners.get('artflow-app:panel-window-closed')({ payload: { panelId: 'board' } });
  assert.deepEqual(panelCalls, [{ panelId: 'board' }]);
  offPanel();

  const electron = { artflowApp: { existing: true }, localStorage: createStorage(), __TAURI__: target.__TAURI__ };
  assert.equal(installTauriPreviewBridge(electron), false);
  assert.equal(electron.artflowApp.existing, true);
  assert.equal(electron.artflowPluginState, undefined);
  assert.equal(electron.artflowComic, undefined);
  console.log('PASS Tauri preview adapter: browser/Electron isolation, full editable plugin set, plugin-state bridge, byte conversion, native command wiring, perf metrics, comic vault, declarative plugins, window controls, capability honesty');
})().catch(error => { console.error(error); process.exitCode = 1; });
