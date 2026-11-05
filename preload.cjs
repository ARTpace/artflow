const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  chooseProject: 'artflow-storage:choose-project',
  getStatus: 'artflow-storage:get-status',
  importAsset: 'artflow-storage:import-asset',
  requestImport: 'artflow-storage:request-import',
  getImportJob: 'artflow-storage:get-import-job',
  listImportJobs: 'artflow-storage:list-import-jobs',
  cancelImportJob: 'artflow-storage:cancel-import-job',
  saveProject: 'artflow-storage:save-project',
  loadProject: 'artflow-storage:load-project',
  listRecentProjects: 'artflow-storage:list-recent-projects',
  openRecentProject: 'artflow-storage:open-recent-project',
  clearRecentProjects: 'artflow-storage:clear-recent-projects',
  queryViewport: 'artflow-storage:query-viewport',
  listAssetInventory: 'artflow-storage:list-asset-inventory',
  reclaimUnreferencedAssets: 'artflow-storage:reclaim-unreferenced-assets',
  requestPreview: 'artflow-storage:request-preview',
  getPreviewJob: 'artflow-storage:get-preview-job',
  cancelPreviewJob: 'artflow-storage:cancel-preview-job',
  openPluginDir: 'artflow-app:open-plugin-dir',
  setAlwaysOnTop: 'artflow-app:set-always-on-top',
  setWindowOpacity: 'artflow-app:set-window-opacity',
  setWindowBackground: 'artflow-app:set-window-background',
  setIgnoreMouseEvents: 'artflow-app:set-ignore-mouse-events',
  windowControl: 'artflow-app:window-control',
  openPanelWindow: 'artflow-app:open-panel-window',
  panelWindowClosed: 'artflow-app:panel-window-closed',
  restartApp: 'artflow-app:restart-app',
  rendererReady: 'artflow-app:renderer-ready',
  skinChanged: 'artflow-app:skin-changed',
  windowMove: 'artflow-app:window-move',
  getWindowState: 'artflow-app:get-window-state',
  windowStateChanged: 'artflow-app:window-state-changed',
  saveBytes: 'artflow-app:save-bytes',
  copyFileToClipboard: 'artflow-app:copy-file-to-clipboard',
  openArtflow: 'artflow-app:open-artflow',
  resolveVideoShortUrl: 'artflow-app:resolve-video-short-url',
  openVideoLink: 'artflow-app:open-video-link',
  getPerfMetrics: 'artflow-app:get-perf-metrics',
  listDeclarativePlugins: 'artflow-app:list-declarative-plugins',
  readEditablePlugins: 'artflow-app:read-editable-plugins',
  listInstalledPlugins: 'artflow-app:list-installed-plugins',
  listSandboxedPlugins: 'artflow-app:list-sandboxed-plugins',
  installExternalPlugin: 'artflow-app:install-external-plugin',
  installExternalPluginFromPath: 'artflow-app:install-external-plugin-from-path',
  isPluginSourcePath: 'artflow-app:is-plugin-source-path',
  uninstallExternalPlugin: 'artflow-app:uninstall-external-plugin',
  invokeSandboxedPlugin: 'artflow-app:invoke-sandboxed-plugin',
  /** 沙箱宿主崩溃重建（换代）后主进程的推送：渲染层据此重新激活沙箱插件。 */
  sandboxHostRestarted: 'artflow-app:sandbox-host-restarted',
  readPluginClients: 'artflow-app:read-plugin-clients',
  renameAssetNames: 'artflow-app:rename-asset-names',
  pluginDataLoad: 'artflow-app:plugin-data-load',
  pluginDataSave: 'artflow-app:plugin-data-save',
  readStored: 'artflow-app:read-stored',
  readPluginPage: 'artflow-app:read-plugin-page',
  comicImport: 'artflow-comic:import',
  comicGetPage: 'artflow-comic:get-page',
  comicCloseArchive: 'artflow-comic:close-archive',
  comfyRequest: 'artflow-ai:comfy-request',
  mcpSetEnabled: 'artflow-mcp:set-enabled',
  mcpGetStatus: 'artflow-mcp:get-status',
  mcpCreateCredential: 'artflow-mcp:create-credential',
  mcpRevokeCredential: 'artflow-mcp:revoke-credential',
  mcpRevealCredential: 'artflow-mcp:reveal-credential',
  mcpPublishCatalog: 'artflow-mcp:publish-catalog',
  mcpDispatch: 'artflow-mcp:dispatch',
  mcpDispatchResult: 'artflow-mcp:dispatch-result',
  pluginStateRead: 'artflow-plugin-state:read-sync',
  pluginStateWrite: 'artflow-plugin-state:write',
  /** 同步读 editable 插件 manifest（顶层 profile 解析用；不含源码）。 */
  pluginStateEditableManifests: 'artflow-plugin-state:editable-manifests-sync',
  pluginStateClear: 'artflow-plugin-state:clear',
  pluginStateBootLog: 'artflow-plugin-state:boot-log',
  configRead: 'artflow-config:read-sync',
  configWrite: 'artflow-config:write-sync',
  configStats: 'artflow-config:stats-sync',
  configBootLog: 'artflow-config:boot-log',
  configBootError: 'artflow-config:boot-error',
  configPresets: 'artflow-config:presets',
  configStorage: 'artflow-config:storage',
});

// ponytail: expose only task-specific calls; never leak ipcRenderer, Node or a caller-selected channel.
contextBridge.exposeInMainWorld('artflowStorage', {
  chooseProject: () => ipcRenderer.invoke(CHANNELS.chooseProject),
  getStatus: () => ipcRenderer.invoke(CHANNELS.getStatus),
  importAsset: ({ asset, bytes, originalName }) => ipcRenderer.invoke(CHANNELS.importAsset, { asset, bytes, originalName }),
  requestImport: ({ asset, bytes, originalName }) => ipcRenderer.invoke(CHANNELS.requestImport, { asset, bytes, originalName }),
  getImportJob: jobId => ipcRenderer.invoke(CHANNELS.getImportJob, jobId),
  listImportJobs: () => ipcRenderer.invoke(CHANNELS.listImportJobs),
  cancelImportJob: jobId => ipcRenderer.invoke(CHANNELS.cancelImportJob, jobId),
  saveProject: document => ipcRenderer.invoke(CHANNELS.saveProject, document),
  loadProject: () => ipcRenderer.invoke(CHANNELS.loadProject),
  /** 最近工程：路径由主进程持有（渲染层只拿到 projectName），所以清单与打开动作都在宿主侧。 */
  listRecentProjects: () => ipcRenderer.invoke(CHANNELS.listRecentProjects),
  openRecentProject: projectRoot => ipcRenderer.invoke(CHANNELS.openRecentProject, projectRoot),
  clearRecentProjects: () => ipcRenderer.invoke(CHANNELS.clearRecentProjects),
  queryViewport: request => ipcRenderer.invoke(CHANNELS.queryViewport, request),
  listAssetInventory: request => ipcRenderer.invoke(CHANNELS.listAssetInventory, request),
  reclaimUnreferencedAssets: request => ipcRenderer.invoke(CHANNELS.reclaimUnreferencedAssets, request),
  requestPreview: assetId => ipcRenderer.invoke(CHANNELS.requestPreview, assetId),
  getPreviewJob: jobId => ipcRenderer.invoke(CHANNELS.getPreviewJob, jobId),
  cancelPreviewJob: jobId => ipcRenderer.invoke(CHANNELS.cancelPreviewJob, jobId),
  openPluginDir: relPath => ipcRenderer.invoke(CHANNELS.openPluginDir, relPath),
});

// ponytail: window-level capabilities live on a separate task-scoped bridge so plugins
// consume them through host.platform services instead of touching window/IPC directly.
contextBridge.exposeInMainWorld('artflowApp', {
  openArtflow: () => ipcRenderer.invoke(CHANNELS.openArtflow),
  resolveVideoShortUrl: (url) => ipcRenderer.invoke(CHANNELS.resolveVideoShortUrl, url),
  openVideoLink: (url) => ipcRenderer.invoke(CHANNELS.openVideoLink, url),
  // 重启整个应用（主进程 relaunch + 清理退出）：窗口控制之外的独立应用级 op，仍走可信渲染层校验。
  // 形参保留括号：check-core-foundations 依赖 `)` 截断点守"别把 ipcRenderer 整个暴露"。
  restartApp: () => ipcRenderer.invoke(CHANNELS.restartApp),
  // 首帧就绪信号（单向 send，不要回执）：宿主据此撤掉启动画面、淡入主窗口。
  notifyRendererReady: () => ipcRenderer.send(CHANNELS.rendererReady),
  // M6：皮肤切换后通知主进程（单向 send，附 skinId）：宿主据此实时更新托盘图标。
  notifySkinChanged: (skinId) => ipcRenderer.send(CHANNELS.skinChanged, skinId),
  setAlwaysOnTop: enabled => ipcRenderer.invoke(CHANNELS.setAlwaysOnTop, enabled),
  setWindowOpacity: opacity => ipcRenderer.invoke(CHANNELS.setWindowOpacity, opacity),
  setWindowBackground: color => ipcRenderer.invoke(CHANNELS.setWindowBackground, color),
  setIgnoreMouseEvents: ignore => ipcRenderer.invoke(CHANNELS.setIgnoreMouseEvents, ignore),
  isFramelessWindow: process.platform === 'win32',
  windowControl: action => ipcRenderer.invoke(CHANNELS.windowControl, action),
  windowMove: request => ipcRenderer.invoke(CHANNELS.windowMove, request),
  // 面板弹出为独立窗口（主进程 frameless BrowserWindow），关闭后经 panelWindowClosed 还原。
  openPanelWindow: (request) => ipcRenderer.invoke(CHANNELS.openPanelWindow, request),
  onPanelWindowClosed: (callback) => {
    const listener = (_event, payload) => callback({ panelId: String(payload && payload.panelId ? payload.panelId : '') });
    ipcRenderer.on(CHANNELS.panelWindowClosed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.panelWindowClosed, listener);
  },
  getWindowState: () => ipcRenderer.invoke(CHANNELS.getWindowState),
  onWindowStateChanged: callback => {
    const listener = (_event, state) => callback({ maximized: state.maximized === true });
    ipcRenderer.on(CHANNELS.windowStateChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.windowStateChanged, listener);
  },
  saveBytes: request => ipcRenderer.invoke(CHANNELS.saveBytes, request),
  copyFileToClipboard: request => ipcRenderer.invoke(CHANNELS.copyFileToClipboard, request),
  getPerfMetrics: () => ipcRenderer.invoke(CHANNELS.getPerfMetrics),
  listDeclarativePlugins: () => ipcRenderer.invoke(CHANNELS.listDeclarativePlugins),
  readEditablePlugins: () => ipcRenderer.invoke(CHANNELS.readEditablePlugins),
  listInstalledPlugins: () => ipcRenderer.invoke(CHANNELS.listInstalledPlugins),
  listSandboxedPlugins: () => ipcRenderer.invoke(CHANNELS.listSandboxedPlugins),
  installExternalPlugin: () => ipcRenderer.invoke(CHANNELS.installExternalPlugin),
  installExternalPluginFromPath: (sourcePath) => ipcRenderer.invoke(CHANNELS.installExternalPluginFromPath, sourcePath),
  isPluginSourcePath: (sourcePath) => ipcRenderer.invoke(CHANNELS.isPluginSourcePath, sourcePath),
  uninstallExternalPlugin: (id) => ipcRenderer.invoke(CHANNELS.uninstallExternalPlugin, id),
  invokeSandboxedPlugin: (message) => ipcRenderer.invoke(CHANNELS.invokeSandboxedPlugin, message),
  readPluginClients: () => ipcRenderer.invoke(CHANNELS.readPluginClients),
  // 沙箱宿主崩溃重建后，渲染层持有的沙箱贡献（面板/命令/格式处理器/卡片）全部作废，
  // 必须重新激活一遍。单向事件 + 返回退订函数，与其他 on* 桥一致。
  onSandboxHostRestarted: (callback) => {
    const listener = (_event, payload) => callback({ reason: String(payload && payload.reason ? payload.reason : 'unknown') });
    ipcRenderer.on(CHANNELS.sandboxHostRestarted, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sandboxHostRestarted, listener);
  },
  readStored: (request) => ipcRenderer.invoke(CHANNELS.readStored, request),
  readPluginPage: (request) => ipcRenderer.invoke(CHANNELS.readPluginPage, request),
  renameAssetNames: (request) => ipcRenderer.invoke(CHANNELS.renameAssetNames, request),
  pluginDataLoad: (pluginId) => ipcRenderer.invoke(CHANNELS.pluginDataLoad, pluginId),
  pluginDataSave: (request) => ipcRenderer.invoke(CHANNELS.pluginDataSave, request),
});

// ponytail: 外部 AI 工具通道是第三个任务域桥。渲染层拿到的是固定 op 白名单
// （stats/submit/history/view/interrupt），真实 HTTP 只在主进程发生 —— ComfyUI 的
// origin_only_middleware 会拒绝跨源直连，且 §12.2 进程原则要求 renderer 不出网。
// 形参必须保留括号：check-core-foundations 用 /exposeInMainWorld\([^)]*ipcRenderer/ 守
// "别把 ipcRenderer 整个暴露"，无括号的箭头形参会越过它依赖的 `)` 截断点而误报。
contextBridge.exposeInMainWorld('artflowAi', {
  comfyRequest: (request) => ipcRenderer.invoke(CHANNELS.comfyRequest, request),
});

// ponytail: 插件偏好（启用/关闭 + config patch）的宿主侧存储桥。它存在的原因是
// localStorage 按 origin 隔离 —— dev :4002 / 直跑 vite / 打包 file:// 各是一份存储，
// 换个启动方式插件开关就"看起来被重置"。状态改由主进程落到 userData 下的单一文件。
// readSync 必须是同步的：顶层 index.tsx 在模块求值阶段就要拿到 profile 才能决定装载哪些插件。
// 形参必须保留括号：check-core-foundations 用 /exposeInMainWorld\([^)]*ipcRenderer/ 守
// "别把 ipcRenderer 整个暴露"，无括号的箭头形参会越过它依赖的 `)` 截断点而误报。
contextBridge.exposeInMainWorld('artflowPluginState', {
  readSync: () => ipcRenderer.sendSync(CHANNELS.pluginStateRead),
  writeSync: (patches) => ipcRenderer.sendSync(CHANNELS.pluginStateWrite, patches),
  clearSync: () => ipcRenderer.sendSync(CHANNELS.pluginStateClear),
  /** 同步读 editable 插件 manifest（顶层 profile 解析用；不含源码，代价极小）。 */
  readEditableManifestsSync: () => ipcRenderer.sendSync(CHANNELS.pluginStateEditableManifests),
  reportBoot: (payload) => ipcRenderer.send(CHANNELS.pluginStateBootLog, payload),
});

// ponytail: 用户级配置（偏好 / 密钥）的宿主侧存储桥。与 artflowPluginState 同因
// （localStorage 按 origin 隔离），但面向的是**全部用户数据**，不是插件开关：
// preferences 与 secrets 各占一个卷，形参只允许固定 op + 卷名白名单，
// 不接受路径、不接受任意文件名。readSync 必须同步 —— 语言等值在模块求值期就要拿到。
// 形参必须保留括号：check-core-foundations 用 /exposeInMainWorld\([^)]*ipcRenderer/ 守
// "别把 ipcRenderer 整个暴露"，无括号的箭头形参会越过它依赖的 `)` 截断点而误报。
contextBridge.exposeInMainWorld('artflowConfig', {
  readPreferences: () => ipcRenderer.sendSync(CHANNELS.configRead, { store: 'preferences' }),
  readSecrets: () => ipcRenderer.sendSync(CHANNELS.configRead, { store: 'secrets' }),
  setPreference: (key, value) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: 'preferences', op: 'set', key, value }),
  patchPreferences: (values) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: 'preferences', op: 'patch', values }),
  /** 只删这些键，回到默认值。 */
  resetPreferences: (keys) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: 'preferences', op: 'reset', keys: Array.isArray(keys) ? keys : [] }),
  /** 清空整个偏好卷（设置页「恢复默认」）。显式命名，避免 resetPreferences() 误清空。 */
  clearPreferences: () => ipcRenderer.sendSync(CHANNELS.configWrite, { store: 'preferences', op: 'reset' }),
  setSecret: (key, value) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: 'secrets', op: 'set', key, value }),
  removeSecret: (key) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: 'secrets', op: 'reset', keys: [key] }),
  /** 通用多卷面：新卷（workspace / recent-files）走这里，避免"每加一卷就加一组方法"。 */
  readStore: (name) => ipcRenderer.sendSync(CHANNELS.configRead, { store: name }),
  setStoreValue: (name, key, value) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: name, op: 'set', key, value }),
  patchStore: (name, values) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: name, op: 'patch', values }),
  resetStore: (name, keys) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: name, op: 'reset', keys: Array.isArray(keys) ? keys : [] }),
  clearStore: (name) => ipcRenderer.sendSync(CHANNELS.configWrite, { store: name, op: 'reset' }),
  // 卷名白名单由主进程把关（main.cjs 的 resolveStore），这里透传即可，不重复一份真相。
  stats: (store) => ipcRenderer.sendSync(CHANNELS.configStats, { store: String(store) }),
  reportBoot: (payload) => ipcRenderer.send(CHANNELS.configBootLog, payload),
  /** 启动期错误上报（index.html 内联钩子最先调用）→ 主进程 logs/electron.log。 */
  reportBootError: (line) => ipcRenderer.send(CHANNELS.configBootError, String(line).slice(0, 1600)),
  // —— 设置预设：全部是用户点击触发的动作，不是启动期同步契约 → 一律 invoke（异步）——
  listPresets: () => ipcRenderer.invoke(CHANNELS.configPresets, { op: 'list' }),
  savePreset: (name) => ipcRenderer.invoke(CHANNELS.configPresets, { op: 'save', name }),
  loadPreset: (name) => ipcRenderer.invoke(CHANNELS.configPresets, { op: 'load', name }),
  removePreset: (name) => ipcRenderer.invoke(CHANNELS.configPresets, { op: 'remove', name }),
  exportPresetToFile: () => ipcRenderer.invoke(CHANNELS.configPresets, { op: 'export-to' }),
  importPresetFromFile: () => ipcRenderer.invoke(CHANNELS.configPresets, { op: 'import-from' }),
  // —— 存储管理 ——
  storageOverview: () => ipcRenderer.invoke(CHANNELS.configStorage, { op: 'overview' }),
  clearCache: () => ipcRenderer.invoke(CHANNELS.configStorage, { op: 'clear-cache' }),
});

contextBridge.exposeInMainWorld('artflowMcp', {
  setEnabled: (enabled) => ipcRenderer.invoke(CHANNELS.mcpSetEnabled, enabled),
  getStatus: () => ipcRenderer.invoke(CHANNELS.mcpGetStatus),
  createCredential: (request) => ipcRenderer.invoke(CHANNELS.mcpCreateCredential, request),
  revokeCredential: (id) => ipcRenderer.invoke(CHANNELS.mcpRevokeCredential, id),
  revealCredential: (id) => ipcRenderer.invoke(CHANNELS.mcpRevealCredential, id),
  publishCatalog: (catalog) => ipcRenderer.invoke(CHANNELS.mcpPublishCatalog, catalog),
  onDispatch: (callback) => {
    const listener = (_event, request) => {
      Promise.resolve(callback(request)).then(
        result => ipcRenderer.send(CHANNELS.mcpDispatchResult, { id: request.id, ok: true, result }),
        error => ipcRenderer.send(CHANNELS.mcpDispatchResult, { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) }),
      );
    };
    ipcRenderer.on(CHANNELS.mcpDispatch, listener);
    return () => ipcRenderer.removeListener(CHANNELS.mcpDispatch, listener);
  },
});

// ponytail: 漫画档案仓桥（懒加载阅读器）。档案字节只进主进程，渲染层拿到的
// 只有页清单与按需解压的单页字节 —— 形参必须保留括号：check-core-foundations
// 用 /exposeInMainWorld\([^)]*ipcRenderer/ 守"别把 ipcRenderer 整个暴露"。
contextBridge.exposeInMainWorld('artflowComic', {
  importArchive: (request) => ipcRenderer.invoke(CHANNELS.comicImport, request),
  getPage: (request) => ipcRenderer.invoke(CHANNELS.comicGetPage, request),
});

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector);
    if (element) element.innerText = text;
  };

  for (const type of ['node', 'chrome', 'electron']) {
    replaceText(`${type}-version`, process.versions[type]);
  }
});
