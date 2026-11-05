const { app, BrowserWindow, Tray, nativeImage, dialog, ipcMain, Menu, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ProjectStorageController } = require('./main/projectStorageController.cjs');
const { createTrustedRendererUrlChecker } = require('./main/rendererTrust.cjs');
const { handleComfyRequest } = require('./main/comfyProxy.cjs');
const { createVideoShortUrlResolver, validateExternalVideoUrl } = require('./main/onlineVideo.cjs');
const resolveVideoShortUrl = createVideoShortUrlResolver();
const { startEmbeddedMcp } = require('./main/embeddedMcp.cjs');
const { listDeclarativePlugins, parseSkinCustomizationDecl } = require('./main/declarativePlugins.cjs');
const { readEditablePlugins } = require('./main/editablePlugins.cjs');
const { listInstalledPlugins, installPluginDirectory, uninstallPlugin, inspectPluginDirectory, findSandboxedPackage } = require('./main/sandboxedPlugins.cjs');
const { extractPluginZip, resolvePluginSourceDir, PluginArchiveError, isPluginSourcePath } = require('./main/pluginArchive.cjs');
const { loadPluginData, savePluginData } = require('./main/pluginData.cjs');
// setArchiveReader 与 setPluginStore 成对：插件漫画页读取走同一 ZIP 引擎，
// 少解构一个会在 registerPluginStoreIpc() 里抛 ReferenceError，
// 表现为「splash 闪现一下就没了」（启动链在 app ready 后即崩）。
// setHostRecoveryNotifier 与 setStorageController 同批解构：沙箱宿主崩溃后要回调渲染层
// 重新激活（漏解构 = 宿主崩了没人通知，插件面板静默失效）。
const { activateInstalledPlugins, invokePlugin, listPluginClients, setPluginStore, setArchiveReader, setStorageController, setHostRecoveryNotifier } = require('./main/pluginSandboxHost.cjs');
const hostEvents = require('./main/hostEvents.cjs');
const { PluginStoreController } = require('./main/pluginStoreController.cjs');
const { ComicArchiveController } = require('./main/comicArchiveController.cjs');
const { createPluginProfileStore } = require('./main/pluginProfileStore.cjs');
const { createConfigStore } = require('./main/configStore.cjs');
const { createSecretCodec } = require('./main/secretCodec.cjs');
const { createPresetLibrary, PRESET_KIND } = require('./main/presetLibrary.cjs');
const {
  isSafeMode,
  SAFE_MODE_TITLE_SUFFIX,
  SAFE_MODE_WRITE_REJECTED,
  SAFE_MODE_EXTERNAL_PLUGIN_REJECTED,
} = require('./main/safeMode.cjs');

const ASSET_SCHEME = 'artflow-asset';
// dev server 端口的唯一来源（vite.config.ts / scripts/launch-desktop.cjs 读的是同一份）。
const DEV_SERVER_CONFIG = require('./dev-server.config.json');
const DEV_ORIGIN_FALLBACK = `http://localhost:${DEV_SERVER_CONFIG.port}`;

// Windows: bind a stable AppUserModelID so the taskbar / alt-tab show the
// Artflow icon instead of the default Electron placeholder.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.artflow.app');
}

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
  /** 内置可编辑插件（editable channel）：读 userData/plugins 下 builtin.* 的 plugin.js 源码文本。 */
  readEditablePlugins: 'artflow-app:read-editable-plugins',
  listInstalledPlugins: 'artflow-app:list-installed-plugins',
  listSandboxedPlugins: 'artflow-app:list-sandboxed-plugins',
  installExternalPlugin: 'artflow-app:install-external-plugin',
  installExternalPluginFromPath: 'artflow-app:install-external-plugin-from-path',
  isPluginSourcePath: 'artflow-app:is-plugin-source-path',
  uninstallExternalPlugin: 'artflow-app:uninstall-external-plugin',
  invokeSandboxedPlugin: 'artflow-app:invoke-sandboxed-plugin',
  /** 沙箱宿主换代（崩溃重建）后由主进程推给渲染层，要求它重新激活一遍沙箱插件。 */
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
  // 插件偏好（启用/关闭 + config patch）的宿主侧存储。与 dev origin 无关，见 main/pluginProfileStore.cjs。
  pluginStateRead: 'artflow-plugin-state:read-sync',
  pluginStateWrite: 'artflow-plugin-state:write',
  /** 同步读 editable 插件 manifest（仅供顶层启动期解析 profile；不含源码，代价极小）。 */
  pluginStateEditableManifests: 'artflow-plugin-state:editable-manifests-sync',
  pluginStateClear: 'artflow-plugin-state:clear',
  pluginStateBootLog: 'artflow-plugin-state:boot-log',
  // 用户级配置（preferences / secrets）的宿主侧存储。与 dev origin 无关，见 main/configStore.cjs。
  // 通道刻意做得少而通用：read-sync / write-sync / stats-sync / boot-log，用 payload.store 选卷，
  // 避免「每加一个设置项就新开一条通道」的通道爆炸。
  configRead: 'artflow-config:read-sync',
  configWrite: 'artflow-config:write-sync',
  configStats: 'artflow-config:stats-sync',
  configBootLog: 'artflow-config:boot-log',
  // 启动期错误（index.html 内联钩子在 React 之前捕获）→ 主进程日志。
  // 这里**不做** trusted 校验：写日志无副作用，而"页面还没建立起可信上下文"那一刻的
  // 第一手崩溃证据恰恰最需要被录下来。
  configBootError: 'artflow-config:boot-error',
  // 设置预设（导出/导入/列出/删除）与存储管理（总览/清缓存）。
  // 沿用 configWrite 的多路复用风格：一条通道 + `op`，避免通道爆炸。
  configPresets: 'artflow-config:presets',
  configStorage: 'artflow-config:storage',
});

// Must happen before app.ready so Chromium treats the managed asset locator as a secure URL.
protocol.registerSchemesAsPrivileged([{
  scheme: ASSET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

// 本机环境下 GPU 子进程无法启动，禁用硬件加速避免崩溃
if (process.env.ARTFLOW_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

// —— 安全模式 / 工厂启动（对标 Blender --factory-startup）——
// 判定与语义的单一真相在 main/safeMode.cjs。这里只解析一次，然后**注入**给各存储卷：
// 存储层自己不读环境变量，回归脚本因此能直接传 safeMode:true 做对拍。
const SAFE_MODE = isSafeMode();

const isDev = process.env.NODE_ENV === 'development' || Boolean(process.env.VITE_DEV_SERVER_URL);
const devOrigin = new URL(process.env.VITE_DEV_SERVER_URL || DEV_ORIGIN_FALLBACK).origin;
const packagedRendererRoot = path.resolve(__dirname, 'dist');
const sessionFilePath = path.join(app.getPath('userData'), 'banana-session.json');
const storageController = new ProjectStorageController({ sessionFilePath });
// 插件偏好落盘到 userData 下的固定文件：与 dev server 的 origin 解耦，
// dev / 打包 / 多实例共用同一份，避免"换个启动方式插件开关就整套作废"。
const pluginProfileStore = createPluginProfileStore({
  filePath: path.join(app.getPath('userData'), 'plugin-profile.json'),
  safeMode: SAFE_MODE,
});
// —— 用户配置根（对齐 Blender 的 config/）——
// 全部用户级数据集中在这里，由主进程独占写入。渲染层经 artflow-config:* 通道读写，
// 与 dev server 的 origin 彻底解耦：dev / 打包 / 多实例共享同一份真相。
// 卷的切分按「写入频率与体积」：偏好（小、高频）与密钥（敏感、独立权限）分开落文件。
const configRoot = path.join(app.getPath('userData'), 'config');
// 卷的切分按「写入频率与体积 + 敏感度」：
//  preferences  全局偏好（小、高频）
//  workspace    面板布局 / 收起记忆（中频，写放大明显，与偏好分开以免互相拖累）
//  recent-files 最近工程（低频小值，但要能被反复整体替换）
//  secrets      密钥（敏感，独立文件 + 权限收紧 + OS 钥匙串加密）
const preferencesStore = createConfigStore({
  filePath: path.join(configRoot, 'preferences.json'),
  schemaVersion: 1,
  safeMode: SAFE_MODE,
});
const workspaceStore = createConfigStore({
  filePath: path.join(configRoot, 'workspace.json'),
  schemaVersion: 1,
  safeMode: SAFE_MODE,
});
const recentFilesStore = createConfigStore({
  filePath: path.join(configRoot, 'recent-files.json'),
  schemaVersion: 1,
  safeMode: SAFE_MODE,
});
const secretCodec = createSecretCodec();
const secretsStore = createConfigStore({
  filePath: path.join(configRoot, 'secrets.json'),
  schemaVersion: 1,
  safeMode: SAFE_MODE,
  valueCodec: secretCodec,
  restrictPermissions: true,
});
// 云端 AI 供应商档案（元数据：名称 / baseUrl / 模型列表 / 协议）。
// 密钥**不进这里**，仍走 secrets 卷、按 `ai.provider.<id>.apiKey` 分桶。
const aiProvidersStore = createConfigStore({
  filePath: path.join(configRoot, 'ai-providers.json'),
  schemaVersion: 1,
  safeMode: SAFE_MODE,
});

/** 卷名 → store。通道只认这张表，不接受路径、不接受任意文件名。 */
const configStores = Object.freeze({
  preferences: preferencesStore,
  workspace: workspaceStore,
  'recent-files': recentFilesStore,
  secrets: secretsStore,
  'ai-providers': aiProvidersStore,
});

/**
 * 预设的收录范围：**只含偏好与工作区**。
 *  - secrets 明确排除：预设的用途是"分享/迁移一套调好的配置"，把密钥带进去等于泄漏；
 *  - recent-files 明确排除：那是本机路径清单，导到另一台机器上全指向不存在的目录。
 * 这两条是刻意的安全边界，不是遗漏。
 */
const PRESET_VOLUMES = Object.freeze(['preferences', 'workspace']);

const presetLibrary = createPresetLibrary({ dirPath: path.join(configRoot, 'presets') });

// 会话缓存目录（中间产物 / 缩略图临时文件）。可以随时整目录删，工程数据与用户配置都不在这里。
const cacheRoot = path.join(app.getPath('userData'), 'temp');

/** 最近工程：条数上限。列表是要**看**的，超过一屏就没有意义了。 */
const MAX_RECENT_PROJECTS = 12;
const RECENT_PROJECTS_KEY = 'recent.projects';

/**
 * 记录一个刚打开过的工程（去重置顶 + 截尾）。
 *
 * 由**主进程**记录，而不是渲染层 —— 路径是主进程 `dialog` 选出来的，渲染层只拿到
 * `projectName`。让渲染层记录就得把绝对路径回传一次（多一条数据来回，也多一处可能不一致）。
 * 打开与保存都走这里：两种动作都意味着"这个工程我还要用"。
 */
function recordRecentProject(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return;
  const stored = recentFilesStore.read().values[RECENT_PROJECTS_KEY];
  const existing = Array.isArray(stored) ? stored : [];
  // Windows 路径大小写不敏感：`D:\Foo` 与 `d:\foo` 是同一个工程，不能各占一行。
  const normalized = projectRoot.toLowerCase();
  const rest = existing.filter(entry => entry
    && typeof entry === 'object'
    && typeof entry.path === 'string'
    && entry.path.toLowerCase() !== normalized);
  const next = [
    { path: projectRoot, name: path.basename(projectRoot) || projectRoot, openedAt: new Date().toISOString() },
    ...rest,
  ].slice(0, MAX_RECENT_PROJECTS);
  const result = recentFilesStore.set(RECENT_PROJECTS_KEY, next);
  // 安全模式下拒写是**预期行为**（只读会话），不该每开一次工程就刷一条日志。
  if (!result.ok && !SAFE_MODE) bootLog(`最近工程记录失败：${result.message}`);
}

/** 读回最近工程清单。`missing` 让界面能把"目录已被删/改名"的条目灰掉，而不是让用户点进一个必然失败的操作。 */
function readRecentProjects() {
  const stored = recentFilesStore.read().values[RECENT_PROJECTS_KEY];
  const entries = Array.isArray(stored) ? stored : [];
  return entries.filter(entry => entry
    && typeof entry === 'object'
    && typeof entry.path === 'string'
    && typeof entry.name === 'string')
    .map(entry => ({
      path: entry.path,
      name: entry.name,
      openedAt: typeof entry.openedAt === 'string' ? entry.openedAt : null,
      missing: !fs.existsSync(entry.path),
    }));
}

/** 递归求目录体积（存储面板展示用）。单个文件读不到就跳过，不因为一个坏文件让整页报错。 */
function directorySize(dirPath) {
  let total = 0;
  const walk = current => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch { /* 忽略 */ } }
    }
  };
  walk(dirPath);
  return total;
}

/**
 * 清空缓存目录。**只动 `userData/temp` 这一个目录** —— 用户配置（config/）、
 * 工程数据（projects/）、插件（plugins/）都不在其中。
 *
 * 开头那段路径守卫是刻意的、不可省：这个函数执行删除，任何一次"路径算错"
 * 都是不可逆的数据损失。守卫要求目标 basename 就是 `temp` 且确实在 userData 之下，
 * 两条同时成立才动手。
 */
function clearCache() {
  const target = path.resolve(cacheRoot);
  const userDataRoot = path.resolve(app.getPath('userData'));
  if (path.basename(target) !== 'temp' || !target.startsWith(userDataRoot + path.sep)) {
    bootLog(`拒绝清空非缓存目录：${target}`);
    return { ok: false, message: `拒绝清空非缓存目录：${target}` };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    bootLog(`缓存已清空：${target}`);
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
let mcpServer = null;

// —— 启动画面 / "内容就绪才显示主窗口"的控制面 ——
// 为什么要这层：进程起来到渲染层画完首帧之间（会话恢复 + MCP 启动 + 模块装载）主窗口是空的，
// 直接显示就是一段白屏。改成「先亮 splash，渲染层报 ready 后再淡入主窗口」，
// 这段等待就被动画接管了：用户第一眼看到的是品牌动画，而不是白屏。
// 时序：splash 立刻显示 → 会话恢复/MCP → createWindow(show:false) → 渲染层首帧 → 换窗口。
const SPLASH_TIMEOUT_MS = 15000;
// dev 下前端服务可能比 Electron 后起（启动器并行拉起两者，见 scripts/launch-desktop.cjs）。
// 这段等待必须**被 splash 盖住**，而不是立刻 loadURL 撞出错误页。
// 上限刻意比启动器的就绪诊断（30s）短一点，让"启动器把失败写进日志"先于"窗口露出错误页"。
const DEV_SERVER_WAIT_MS = 20000;
const DEV_SERVER_POLL_MS = 200;
const BOOT_STARTED_AT = Date.now();
const bootLog = message => console.log(`[boot +${String(Date.now() - BOOT_STARTED_AT).padStart(5, ' ')}ms] ${message}`);
let splashWindow = null;
let mainWindow = null;
let mainWindowPainted = false;
let rendererReady = false;
let mainWindowRevealed = false;
let splashTimeoutArmed = false;
// 退出中标志：沙箱宿主崩溃回调据此拒绝重建（退出时再建隐藏窗口只会拖住 window-all-closed 的退出判定）。
let appQuitting = false;
// M6：系统托盘（主题化图标 + 常驻后台）。为 null 时退回普通窗口行为（关窗即退出）。
let tray = null;

/**
 * 兜底计时**从装载那一刻起算**，而不是从 whenReady 起算。
 * 否则 dev 冷启动时"等前端服务"这段（可能十几秒）会先把计时耗光，
 * 窗口在服务就绪前就被强行交出去 —— 那等于把 splash 的意义抵消掉。
 */
function armSplashTimeout() {
  if (splashTimeoutArmed) return;
  splashTimeoutArmed = true;
  // 渲染层万一始终不报 ready（脚本报错、极慢、被杀），也必须在有限时间内把窗口交出去，
  // 否则用户会一直盯着一块动画。此时不再等 ready-to-show，直接显示（宁可白也比卡死好）。
  setTimeout(() => {
    if (mainWindowRevealed) return;
    bootLog(`渲染层 ${SPLASH_TIMEOUT_MS}ms 未报 ready，强制显示主窗口`);
    mainWindowPainted = true;
    rendererReady = true;
    revealMainWindow('超时兜底');
  }, SPLASH_TIMEOUT_MS);
}

/** dev：轮询前端服务直到可访问（或超时）。splash 正在上屏，等得起。 */
async function waitForDevServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        bootLog(`前端服务就绪（第 ${attempt} 次探测）`);
        return true;
      }
    } catch {
      /* 服务还没起来：继续轮询 */
    }
    if (Date.now() >= deadline) {
      bootLog(`前端服务 ${timeoutMs}ms 内未就绪，仍然尝试装载（交给加载失败兜底）`);
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, DEV_SERVER_POLL_MS));
  }
}

// 安全模式要**在日志里留下确凿的一条**：用户拿日志反馈时，第一件事就是确认
// "这次是不是安全模式"，否则后面的现象全都解释不通。
if (SAFE_MODE) {
  bootLog(`⚠ 安全模式（ARTFLOW_SAFE_MODE=1）：忽略用户配置 / 不装载外部插件 / 本次会话不写入任何用户数据`);
  bootLog(`  用户数据文件保持原样未动：${path.join(app.getPath('userData'), 'plugin-profile.json')} 与 ${configRoot}`);
}

// —— 单实例锁 ——
// 没有它时，每双击一次就是一个**新实例**，而它们共用同一个 userData
// （localStorage / MCP 凭据 / 插件目录 / 会话文件全在同一份上）。
// 实测：一次会话里叠到了 4 个实例 / 17 个进程 / 2.19GB 内存，且 4 个内嵌 MCP 服务在抢同一份配置。
// 这种叠加自身就是画布卡顿与"插件开关像被重置"的温床（localStorage 是同步 API，
// 多进程写同一份 leveldb 会在主线程上真的阻塞）。
//
// 演进缝：
// - `ARTFLOW_ALLOW_MULTI_INSTANCE=1` → 跳过锁（隔离调试 / 并行对拍用）。
// - 换 `--user-data-dir` → 锁按目录隔离，天然允许并行（探针就是靠这条）。
const ALLOW_MULTI_INSTANCE = process.env.ARTFLOW_ALLOW_MULTI_INSTANCE === '1';
const isPrimaryInstance = ALLOW_MULTI_INSTANCE ? true : app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  // 后来者立刻退出，不注册 IPC、不建窗口；已有实例会收到 second-instance 并把自己顶到前台。
  app.quit();
} else {
  // 第二次启动：聚焦已有窗口，而不是再开一份。最小化/被遮挡时也要能拉回来。
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      // 只认"可见"窗口兜底——隐形 worker（sandbox host 等）绝不能被 show 出来，
      // 那会变成一个没有 UI 的白窗口（曾真实发生过：主窗口关闭后双击图标，白框现形）。
      : BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.isVisible());
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      return;
    }
    // 一个可聚焦的窗口都没有（只剩隐形 worker 撑着进程）：用户此时双击图标的意图
    // 就是"打开应用"，重建主窗口，而不是默默 return 让用户面对毫无反应的桌面。
    createWindow();
  });
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 440,
    height: 280,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Artflow',
    // 零能力面：不挂 preload、不开 nodeIntegration —— 它只是一张会动的图。
    webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: false },
  });
  splash.setMenu(null);
  splash.once('ready-to-show', () => {
    if (splash.isDestroyed()) return;
    splash.show();
    bootLog('splash 显示');
  });
  splash.loadFile(path.join(__dirname, 'branding', 'splash.html'));
  // M6：装载完成后注入激活皮肤的启动图配色（background/accent），并推一档初始进度。
  splash.webContents.once('did-finish-load', () => {
    if (splash.isDestroyed()) return;
    applySplashBranding(splash);
    reportSplashProgress(8);
  });
  return splash;
}

function dismissSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

// —— M6：主题化品牌资源（Logo / 托盘 / 启动图）——
// 主进程侧取数：遍历 bundled 内置皮肤 manifest 建 skinId → branding 映射；
// 再读偏好里的激活皮肤（appearance.skinState，composite 时回退 baseSkinId）。

function buildSkinBrandingMap() {
  const map = {};
  try {
    const root = builtinPluginsRoot();
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('builtin.skins-')) continue;
      const manifestPath = path.join(root, e.name, 'manifest.json');
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
      const skin = manifest && manifest.contributes && manifest.contributes.skins;
      if (!skin) continue;
      const customization = parseSkinCustomizationDecl(skin.customization || {});
      // 应用内 Logo 单一真相：`branding.appLogo`（宿主专用覆盖）优先，否则回落 `tokens.icons.appLogo`
      // （BpIcon 同款来源），避免皮肤作者重复声明。
      const iconLogo = skin.tokens && skin.tokens.icons && typeof skin.tokens.icons.appLogo === 'string'
        ? skin.tokens.icons.appLogo : undefined;
      const brandAppLogo = customization && customization.branding && customization.branding.appLogo;
      const splash = customization && customization.branding && customization.branding.splash;
      const appLogo = brandAppLogo || iconLogo;
      if (appLogo || splash) {
        map[manifest.id || e.name] = { appLogo, splash };
      }
    }
  } catch { /* 无 bundled 皮肤目录 */ }
  return map;
}

function readActiveSkinBranding() {
  const map = buildSkinBrandingMap();
  let activeId = null;
  try {
    let raw = preferencesStore.read().values['appearance.skinState'];
    // 兼容：偏好卷可能直接存对象，也可能存 JSON 字符串（甚至双重编码）。
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = null; }
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
    }
    if (raw && typeof raw.skinId === 'string') {
      activeId = (raw.composite && raw.composite.baseSkinId) || raw.skinId;
    }
  } catch { /* 无皮肤状态 */ }
  if (activeId && map[activeId]) return map[activeId];
  const first = Object.values(map)[0];
  return first || null;
}

function readSkinBrandingById(id) {
  if (!id) return null;
  return buildSkinBrandingMap()[id] || null;
}

function buildSplashCss(splash) {
  const bg = splash.background ? `--bp-splash-bg:${splash.background};` : '';
  const accent = splash.accent ? `--bp-splash-accent:${splash.accent};` : '';
  return `:root{${bg}${accent}}`;
}

function applySplashBranding(splashWin) {
  if (!splashWin || splashWin.isDestroyed()) return;
  const branding = readActiveSkinBranding();
  if (!branding || !branding.splash) return;
  splashWin.webContents.insertCSS(buildSplashCss(branding.splash)).catch(() => {});
}

function reportSplashProgress(pct) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  splashWindow.webContents.executeJavaScript(`window.__splashProgress(${clamped})`).catch(() => {});
}

function showMainWindowFromTray() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function updateTrayImage(branding) {
  if (!tray) return;
  let img = null;
  if (branding && typeof branding.appLogo === 'string' && branding.appLogo.startsWith('data:')) {
    try { img = nativeImage.createFromDataURL(branding.appLogo); } catch { /* 非法 data URI */ }
  }
  if (!img || img.isEmpty()) {
    img = nativeImage.createFromPath(path.join(__dirname, 'branding', 'icons', 'artflow-icon-256.png'));
  }
  if (!img.isEmpty()) tray.setImage(img);
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'branding', 'icons', 'artflow-icon-256.png'));
  if (icon.isEmpty()) return; // 缺图标资源则不建托盘，退回普通窗口行为
  tray = new Tray(icon);
  tray.setToolTip('Artflow');
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示 Artflow', click: () => showMainWindowFromTray() },
    { type: 'separator' },
    { label: '退出', click: () => { appQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => showMainWindowFromTray());
  updateTrayImage(readActiveSkinBranding());
}

// 显示主窗口（带淡入）。顺序很关键：**必须先 setOpacity(0) 再 show()**。
// 旧实现是 show() 之后才压透明度，那一瞬间窗口以"完全不透明"合成了一帧 ——
// 露出的就是窗口背景色（历史默认纯白），于是看到"白闪一下才开始淡入"。
// setOpacity 不支持的平台直接显示，绝不影响可见性。
function showMainWindowWithFade() {
  let supportsOpacity = true;
  try {
    mainWindow.setOpacity(0);
  } catch {
    supportsOpacity = false;
  }
  mainWindow.show();
  if (!supportsOpacity) return;

  const steps = 6;
  let step = 0;
  const timer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    step += 1;
    try {
      mainWindow.setOpacity(Math.min(1, step / steps));
    } catch {
      /* 中途失效就到此为止，下面的兜底会把不透明度恢复成 1 */
    }
    if (step >= steps) clearInterval(timer);
  }, 26);

  // 兜底：任何异常都不允许把窗口永久留在半透明状态（那等于把界面藏了）。
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setOpacity(1);
    } catch {
      /* 平台不支持时本来就没动过透明度 */
    }
  }, 800);
}

function revealMainWindow(reason) {
  if (mainWindowRevealed || !mainWindow || mainWindow.isDestroyed()) return;
  // 两个条件都要：首帧已绘制（ready-to-show）+ 渲染层已挂载。
  // 只等 ready-to-show 会露出"index.html 已画、React 还没挂"的空窗口；只等渲染层则可能没画过。
  if (!mainWindowPainted || !rendererReady) return;
  mainWindowRevealed = true;
  bootLog(`显示主窗口：${reason}`);
  reportSplashProgress(100);
  dismissSplash();
  // 换窗口之后不再需要"隐藏也照常渲染"，交还默认节流，避免最小化时白白耗电。
  try {
    mainWindow.webContents.setBackgroundThrottling(true);
  } catch {
    /* 旧版本没有这个 API 时忽略 */
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  showMainWindowWithFade();
}

const isTrustedRendererUrl = createTrustedRendererUrlChecker({
  isDev,
  devOrigin,
  rendererRoot: packagedRendererRoot,
});

function assertTrustedRenderer(event) {
  const frame = event.senderFrame;
  if (!frame || frame.isMainFrame === false || !isTrustedRendererUrl(frame.url)) {
    throw new Error('Rejected untrusted renderer storage request');
  }
}

function protocolError(status) {
  return new Response('Not found', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function registerStorageIpc() {
  ipcMain.handle(CHANNELS.chooseProject, async event => {
    assertTrustedRenderer(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error('Storage request has no owning window');
    const selection = await dialog.showOpenDialog(owner, {
      title: 'Open Artflow managed project',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (selection.canceled || selection.filePaths.length !== 1) return null;
    const opened = await storageController.openProject(selection.filePaths[0]);
    // 选了目录并成功打开 = 这个工程要长期用 → 记进最近列表（打开与保存共用这条路径）。
    recordRecentProject(selection.filePaths[0]);
    return opened;
  });
  ipcMain.handle(CHANNELS.listRecentProjects, event => {
    assertTrustedRenderer(event);
    return { ok: true, projects: readRecentProjects() };
  });
  ipcMain.handle(CHANNELS.openRecentProject, async (event, projectRoot) => {
    assertTrustedRenderer(event);
    if (typeof projectRoot !== 'string' || projectRoot.length === 0 || projectRoot.length > 4096) {
      throw new Error('Invalid recent project path');
    }
    const opened = await storageController.openProject(projectRoot);
    // 打开失败会在这里抛出（目录被删/改名/无权限），条目留在列表里供用户重试或清理。
    recordRecentProject(projectRoot);
    return opened;
  });
  ipcMain.handle(CHANNELS.clearRecentProjects, event => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { ok: false, message: SAFE_MODE_WRITE_REJECTED };
    return recentFilesStore.reset([RECENT_PROJECTS_KEY]);
  });
  ipcMain.handle(CHANNELS.getStatus, event => {
    assertTrustedRenderer(event);
    return storageController.status();
  });
  ipcMain.handle(CHANNELS.importAsset, async (event, request) => {
    assertTrustedRenderer(event);
    const result = await storageController.importAsset(request);
    // 宿主事件：导入完成 = 「资产进入库」。
    const asset = result && result.asset;
    if (asset && typeof asset.id === 'string') {
      hostEvents.emit('asset.added', {
        asset: {
          id: asset.id,
          name: typeof request?.originalName === 'string' && request.originalName ? request.originalName : '',
          kind: typeof asset.kind === 'string' ? asset.kind : '',
          mimeType: typeof asset.locator?.mimeType === 'string' ? asset.locator.mimeType : '',
          byteSize: Number.isFinite(result.byteSize) ? result.byteSize : 0,
        },
      });
    }
    return result;
  });
  ipcMain.handle(CHANNELS.requestImport, async (event, request) => {
    assertTrustedRenderer(event);
    return storageController.requestImport(request);
  });
  ipcMain.handle(CHANNELS.getImportJob, (event, jobId) => {
    assertTrustedRenderer(event);
    return storageController.getImportJob(jobId);
  });
  ipcMain.handle(CHANNELS.listImportJobs, event => {
    assertTrustedRenderer(event);
    return storageController.listImportJobs();
  });
  ipcMain.handle(CHANNELS.cancelImportJob, (event, jobId) => {
    assertTrustedRenderer(event);
    return storageController.cancelImportJob(jobId);
  });
  ipcMain.handle(CHANNELS.saveProject, (event, document) => {
    assertTrustedRenderer(event);
    storageController.saveProject(document);
  });
  ipcMain.handle(CHANNELS.loadProject, event => {
    assertTrustedRenderer(event);
    return storageController.loadProject();
  });
  ipcMain.handle(CHANNELS.queryViewport, (event, request) => {
    assertTrustedRenderer(event);
    return storageController.queryViewport(request);
  });
  ipcMain.handle(CHANNELS.listAssetInventory, (event, request) => {
    assertTrustedRenderer(event);
    return storageController.listAssetInventory(request);
  });
  ipcMain.handle(CHANNELS.reclaimUnreferencedAssets, (event, request) => {
    assertTrustedRenderer(event);
    const result = storageController.reclaimUnreferencedAssets(request);
    // 宿主事件：回收即「资产从库里消失」，逐条广播（没有订阅者时 emit 是零开销的）。
    if (result && Array.isArray(result.removed)) {
      for (const assetId of result.removed) hostEvents.emit('asset.removed', { asset: { id: assetId } });
    }
    return result;
  });
  ipcMain.handle(CHANNELS.requestPreview, (event, assetId) => {
    assertTrustedRenderer(event);
    return storageController.requestPreview(assetId);
  });
  ipcMain.handle(CHANNELS.getPreviewJob, (event, jobId) => {
    assertTrustedRenderer(event);
    return storageController.getPreviewJob(jobId);
  });
  ipcMain.handle(CHANNELS.cancelPreviewJob, (event, jobId) => {
    assertTrustedRenderer(event);
    return storageController.cancelPreviewJob(jobId);
  });
}

// 外部 AI 工具（ComfyUI）的代理策略在 main/comfyProxy.cjs，
// 这里只负责 IPC 注册与发送方校验。
function registerAiIpc() {
  ipcMain.handle(CHANNELS.comfyRequest, async function (event, request) {
    assertTrustedRenderer(event);
    return handleComfyRequest(request);
  });
}

// —— 漫画档案仓（懒加载阅读器）——
// 档案字节只进主进程的 userData/comic-archive/，渲染层按页拉取；
// 崩溃/退出由 before-quit 与句柄 LRU 双兜底，不依赖渲染层自觉。
let comicArchive = null;
function registerComicIpc() {
  comicArchive = new ComicArchiveController({ dir: path.join(app.getPath('userData'), 'comic-archive') });  ipcMain.handle(CHANNELS.comicImport, (event, request) => {
    assertTrustedRenderer(event);
    return comicArchive.importArchive(request).then(
      result => ({ ok: true, ...result }),
      error => ({ ok: false, message: error?.message || 'comic import failed' }),
    );
  });
  ipcMain.handle(CHANNELS.comicGetPage, async (event, request) => {
    assertTrustedRenderer(event);
    try {
      const page = await comicArchive.getPage(request);
      // 结构化克隆会把 Uint8Array 视图原样送达渲染层；这里复制出独立 ArrayBuffer，
      // 避免 Buffer 池边界外泄（与 read-asset-bytes 通道同一约定）。
      return {
        ok: true,
        bytes: page.bytes.buffer.slice(page.bytes.byteOffset, page.bytes.byteOffset + page.bytes.byteLength),
        mimeType: page.mimeType,
      };
    } catch (error) {
      return { ok: false, message: error?.message || 'comic page read failed' };
    }
  });
  // close-archive：句柄 LRU 本身就能自愈，这个通道只为显式释放（删除元素后）提供入口。
  ipcMain.handle(CHANNELS.comicCloseArchive, (event, request) => {
    assertTrustedRenderer(event);
    return { ok: true };
  });
}

// —— unrestricted 插件数据仓 ——
// plugin.js 落仓（经沙箱 host bridge），client.js 组件按 ref 读回；
// 渲染层 readStored 通道的 pluginId 由 external-runtime 绑定，主进程再校验格式防穿越。
let pluginStore = null;
function registerPluginStoreIpc() {
  pluginStore = new PluginStoreController({ dir: path.join(app.getPath('userData'), 'plugin-store') });
  setPluginStore(pluginStore);
  if (comicArchive) setArchiveReader(comicArchive);
  // host 能力面（沙箱插件的受控宿主对象图）复用工程仓储：资产清单/改名都在主进程，
  // 不经过渲染层 —— 沙箱窗口只能与主进程通信，走渲染层会多一跳且要再过一次信任校验。
  setStorageController(storageController);
  // 沙箱宿主崩溃（render-process-gone / 长时间无响应被强制销毁）后，主进程会重建宿主窗口，
  // 但**渲染层不知道**：它手里那份沙箱贡献目录（面板 / 命令 / 格式处理器 / 卡片）全是死引用。
  // 这条通知把"重新激活"接回渲染层；返回 false 表示当前不宜重建：
  //  - 应用退出中（宿主随进程收摊，再建隐藏窗口只会拖住退出判定）；
  //  - 主窗口已销毁 / 正在销毁（没有接收方，重建出来的宿主也没人用）。
  setHostRecoveryNotifier(reason => {
    if (appQuitting) return false;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
    mainWindow.webContents.send(CHANNELS.sandboxHostRestarted, { reason: String(reason || 'unknown') });
    return true;
  });
  ipcMain.handle(CHANNELS.readStored, (event, request) => {
    assertTrustedRenderer(event);
    return pluginStore.read(request).then(
      stored => ({
        ok: true,
        bytes: stored.bytes.buffer.slice(stored.bytes.byteOffset, stored.bytes.byteOffset + stored.bytes.byteLength),
      }),
      error => ({ ok: false, message: error?.message || 'stored data read failed' }),
    );
  });
  // 插件漫画页读取：client.js 卡片按 (pluginId, ref, index) 拉单页——与内置阅读器同一 ZIP 引擎。
  ipcMain.handle(CHANNELS.readPluginPage, async (event, request) => {
    assertTrustedRenderer(event);
    try {
      if (!pluginStore || !comicArchive) return { ok: false, message: 'archive service is unavailable' };
      const filePath = pluginStore.pluginPath(request.pluginId, request.ref);
      const key = `${request.pluginId}:${request.ref}`;
      comicArchive.registerArchivePath(key, filePath);
      const page = await comicArchive.readPage(key, request.index);
      return {
        ok: true,
        bytes: page.bytes.buffer.slice(page.bytes.byteOffset, page.bytes.byteOffset + page.bytes.byteLength),
        mimeType: page.mimeType,
      };
    } catch (error) {
      return { ok: false, message: error?.message || 'plugin page read failed' };
    }
  });
}

function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return protocolError(405);
    try {
      const resolved = await storageController.resolveAssetRequest(request.url);
      return new Response(request.method === 'HEAD' ? null : resolved.bytes, {
        status: 200,
        headers: {
          'content-type': resolved.mimeType,
          'content-length': String(resolved.bytes.byteLength),
          'cache-control': 'private, max-age=31536000, immutable',
          'accept-ranges': 'none',
        },
      });
    } catch (error) {
      console.warn('Blocked Artflow asset protocol request:', error.message);
      return protocolError(404);
    }
  });
}

// 启动期诊断（ARTFLOW_DEBUG_RENDERER=1）：启动问题九成出在渲染层，而渲染层默认不出声。
// 打开后做两件事：把渲染层 console.* 转发进 logs/electron.log；并在 8s 回读一次页面实况
// （实际装的是哪份代码 / React 挂没挂 / 桥暴露了没有），与 [boot] 时间线对照看。
function installRendererDiagnostics() {
  mainWindow.webContents.on('console-message', (...args) => {
    const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null;
    if (details) console.log(`[renderer:${details.level}] ${details.message}`);
    else console.log(`[renderer] ${args[1]}`);
  });
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents
      .executeJavaScript(`({
        href: location.href,
        rootChildren: (document.getElementById('root') || {}).childElementCount || 0,
        hasNotify: typeof window.artflowApp?.notifyRendererReady,
        scripts: Array.from(document.scripts).map(s => s.src || 'inline').slice(0, 4),
      })`)
      .then(state => bootLog(`渲染层实况：${JSON.stringify(state)}`))
      .catch(error => bootLog(`渲染层实况探测失败：${error.message}`));
  }, 8000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // 先不显示：等渲染层画完首帧再由 revealMainWindow() 淡入，避免白屏。
    show: false,
    // 窗口底色 = 画布默认底色（与 index.css 的 --bp-canvas-bg 兜底值一致）。
    // 不设的话 Electron 用纯白：show()/重新合成/resize/reload 的任何一帧只要页面还没画，
    // 露出的就是这块白 —— 这是启动白屏最直接的一层来源。
    backgroundColor: '#111827',
    // Windows: the canvas owns its minimal drag strip and window controls.
    // Keep the native resize border, snap/maximize and taskbar behavior.
    frame: process.platform !== 'win32',
    thickFrame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    icon: path.join(__dirname, 'branding', 'icons', 'artflow.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    // 标题同时充当"当前处于安全模式"的第一眼信号（任务栏 / Alt-Tab 都看得见）——
    // 免得用户以为"我的配置丢了"，其实只是这次刻意忽略了它。
    title: SAFE_MODE ? `Artflow — ${SAFE_MODE_TITLE_SUFFIX}` : 'Artflow',
  });

  mainWindow.setMenu(null); // Neither a File/Edit/View/Window row nor Alt-to-reveal menu.
  if (process.env.ARTFLOW_DEBUG_RENDERER === '1') installRendererDiagnostics();
  // 窗口在渲染层报 ready 之前一直不显示；隐藏窗口默认会被节流（rAF 甚至不再触发），
  // 首帧就绪信号就发不出来。这里在"等待期"关掉节流，reveal 后再恢复。
  try {
    mainWindow.webContents.setBackgroundThrottling(false);
  } catch {
    /* 旧版本没有这个 API 时忽略 */
  }
  const reportWindowState = () => {
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.windowStateChanged, { maximized: mainWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', reportWindowState);
  mainWindow.on('unmaximize', reportWindowState);

  // 安全模式的后缀必须**持续**成立：`title:` 只在窗口创建那一刻生效，页面一加载
  // index.html 的 `<title>` 就会把它整个换掉（Electron 默认让 HTML 标题覆盖窗口标题）。
  // 渲染层也自己改了 `document.title`（见 components/SafeModeBanner.tsx），这一道是**兜底**：
  // 安全模式最先要排查的就是"启动失败"，那种情况下 React 没挂起来，只有这里还能保证
  // 任务栏 / Alt-Tab 上的"你在安全模式里"这个信号存在。
  if (SAFE_MODE) {
    mainWindow.on('page-title-updated', event => {
      event.preventDefault();
      if (!mainWindow.isDestroyed()) mainWindow.setTitle(`Artflow — ${SAFE_MODE_TITLE_SUFFIX}`);
    });
  }

  // A navigated renderer must not retain access to the storage bridge.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 换窗口的两条线索：ready-to-show = 这一帧真的画出来了；渲染层 ready = React 已挂载。
  mainWindow.once('ready-to-show', () => {
    mainWindowPainted = true;
    bootLog('主窗口首帧已绘制');
    revealMainWindow('首帧就绪');
  });
  mainWindow.webContents.on('did-fail-load', (event, code, desc, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    bootLog(`主窗口加载失败：${desc} (${code}) ${validatedUrl}`);
    mainWindowPainted = true;
    rendererReady = true; // 渲染层已经不可能再报 ready 了，直接放行（宁可露出错误页也别卡在动画）。
    revealMainWindow('加载失败兜底');
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    bootLog(`渲染进程异常退出：${details?.reason || 'unknown'}`);
    mainWindowPainted = true;
    rendererReady = true;
    revealMainWindow('渲染进程异常兜底');
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    dismissSplash();
    // M6：托盘常驻时关窗即隐藏，进程由托盘"退出"终结，不再主动 quit。
    if (tray) return;
    // 关掉主窗口后，若剩余窗口全部不可见（比如只剩隐形的 sandbox host），必须主动退场：
    // 隐形 worker 会一直挡住 window-all-closed，进程变成"无窗口僵尸"还握着单实例锁，
    // 之后用户每次双击图标都抢锁失败——应用看起来就"再也打不开了"。
    setTimeout(() => {
      if (BrowserWindow.getAllWindows().every(w => w.isDestroyed() || !w.isVisible())) app.quit();
    }, 0);
  });

  const rendererUrl = isDev
    ? (process.env.VITE_DEV_SERVER_URL || DEV_ORIGIN_FALLBACK)
    : `file://${path.join(__dirname, 'dist', 'index.html')}`;
  if (isDev) {
    // splash 已经上屏，这段等待正是它存在的意义：先等服务，再装载。
    // 直接 loadURL 会立刻 did-fail-load 露出错误页，把"冷启动等待"变成一个错误画面。
    bootLog(`等待前端服务：${rendererUrl}`);
    void waitForDevServer(rendererUrl, DEV_SERVER_WAIT_MS).then(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      bootLog(`装载渲染层：${rendererUrl}`);
      mainWindow.loadURL(rendererUrl);
      armSplashTimeout();
    });
  } else {
    bootLog(`装载渲染层：${rendererUrl}`);
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
    armSplashTimeout();
  }
}

// 受控「打开插件文件夹」：只接受应用根内的相对目录（manifest.sourceDir 经 renderer 端
// manifest 校验后传入，这里再做一次权威校验），拒绝一切越界与任意路径。
function pluginsRoot() {
  return path.join(app.getPath('userData'), 'plugins');
}

/**
 * 内置插件「运行副本」的根：plugins/builtin/。
 * 与第三方插件（plugins/ 根下的 local.* / 声明式 JSON 包）物理隔离，便于用户一眼分清
 * 「官方自带」与「自己装的」。出厂源是安装包内的 app.asar → bundled-plugins/**（只读），
 * 对应工程源码目录 plugins/**（构建时由 package.json 的 files.from/to 映射改名）。
 */
function builtinPluginsRoot() {
  return path.join(pluginsRoot(), 'builtin');
}

/**
 * 把随应用分发的「第三方可编辑插件」（工程 plugins/**，asar 内 bundled-plugins/**）在首次启动播种到 plugins/builtin/。
 * 这样内置插件既不被硬编码进安装包，又能保证新装/重装后默认存在，
 * 且用户在插件管理里的停用/删除/升级不会被覆盖（仅当目标子目录不存在时才复制）。
 *
 * 兼容：早期版本把内置副本直接放在 plugins/ 根。这里做一次**就地迁移**（move 而非 copy），
 * 保留用户在旧位置的改动；迁移失败则跳过（旧位置仍可被读取，见 legacyBuiltinDir 回退）。
 */
function copyDirSafe(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) copyDirSafe(s, d);
    else if (item.isFile()) fs.copyFileSync(s, d);
  }
}

const BUILTIN_DIR_PATTERN = /^builtin\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function seedBundledPlugins(destinationRoot) {
  const candidates = [
    path.join(app.getAppPath(), 'bundled-plugins'),
    path.join(process.resourcesPath, 'bundled-plugins'),
  ];
  // 老布局迁移：plugins/builtin.* → plugins/builtin/builtin.*
  // 必须**先于** source 检查执行：迁移是用户数据搬迁，不该依赖安装包里是否有 bundled-plugins。
  // （早期曾把它放在 `if (!source) return;` 之后，缺源时会连迁移一起跳过，导致老副本读不到。）
  migrateLegacyBuiltinDir(destinationRoot);
  const source = candidates.find(dir => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
  if (!source) return;
  let entries;
  try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch { return; }
  // 播种目标按通道分流：
  //   editable 包 → plugins/builtin/（editablePlugins 的扫描根）
  //   声明式包     → plugins/ 根（listDeclarativePlugins 的扫描根）
  // 若把声明式包也塞进 builtin/，递归扫描会在根和 builtin/ 各命中一次 → 同一 id 注册两遍。
  const declarativeRoot = path.dirname(destinationRoot);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const from = path.join(source, entry.name);
    const isEditable = isEditablePackageDir(from);
    const targetDir = isEditable
      ? path.join(destinationRoot, entry.name)
      : path.join(declarativeRoot, entry.name);
    if (fs.existsSync(targetDir)) continue; // 已存在（用户安装/改过）不覆盖
    try {
      copyDirSafe(from, targetDir);
      bootLog(`播种内置插件：${entry.name} → ${isEditable ? 'builtin/' : '(根)'}`);
    } catch (error) {
      console.warn(`[seed] 复制 bundled 插件 ${entry.name} 失败：`, error);
    }
  }
}

/**
 * 把早期放在 plugins/ 根的内置副本搬到 plugins/builtin/（保留用户改动）。
 *
 * 只搬 **editable** 通道的包（有 runtime.entry / plugin.js 的那种）。声明式包
 * （runtime.mode:"declarative"，如 builtin.skins-*）**留在原地** ——
 * listDeclarativePlugins 是单层扫描，搬进 builtin/ 会让它们凭空消失。
 */
function migrateLegacyBuiltinDir(builtinDir) {
  const parent = path.dirname(builtinDir);
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return; }
  const legacy = entries.filter(entry => {
    if (!entry.isDirectory() || !BUILTIN_DIR_PATTERN.test(entry.name)) return false;
    return isEditablePackageDir(path.join(parent, entry.name));
  });
  if (legacy.length === 0) return;
  fs.mkdirSync(builtinDir, { recursive: true });
  for (const entry of legacy) {
    const from = path.join(parent, entry.name);
    const to = path.join(builtinDir, entry.name);
    if (fs.existsSync(to)) continue; // 新位置已有（用户改过）→ 保留新位置，老副本留存由用户处置
    try {
      fs.renameSync(from, to);
      bootLog(`迁移内置插件目录：${entry.name} → builtin/`);
    } catch (error) {
      console.warn(`[seed] 迁移 ${entry.name} 到 builtin/ 失败（老位置仍可读取）：`, error);
    }
  }
}

/** 该目录是否是 editable 通道的包：manifest 里 runtime.mode 为 editable/builtin，或有 entry 字段。 */
function isEditablePackageDir(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'); } catch { return false; }
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return false; }
  const runtime = manifest && manifest.runtime;
  if (!runtime || typeof runtime !== 'object') return false;
  if (runtime.mode === 'declarative') return false;
  return typeof runtime.entry === 'string' || typeof runtime.mode === 'string';
}

/**
 * 解析某个内置插件「运行副本」所在目录，返回存在的那个（新布局优先，老布局回退）。
 * 都不存在时返回新布局路径（供上层给出准确提示）。
 */
function resolveBuiltinPackageDir(id) {
  const preferred = path.join(builtinPluginsRoot(), id);
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(pluginsRoot(), id);
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

// —— 插件偏好宿主侧存储 ——
// 启动期 index.tsx 顶层是**同步**解析 profile 的，所以读必须走 sendSync（invoke 是 Promise，
// 来不及在模块求值阶段拿到值）。写走 invoke：允许失败并回告，渲染层据此报错而不是静默丢失。
function registerPluginStateIpc() {
  ipcMain.on(CHANNELS.pluginStateRead, event => {
    try {
      assertTrustedRenderer(event);
    } catch {
      // 不可信来源一律不给数据；返回 ok:false 让渲染层回退，而不是抛错炸掉启动。
      event.returnValue = { ok: false, patches: null, source: 'unreadable', message: 'untrusted renderer' };
      return;
    }
    event.returnValue = pluginProfileStore.read();
  });
  // editable 插件的 manifest 同步读取：顶层 index.tsx 在模块求值阶段就要把它们并入 profile 解析
  // （否则这些插件在设置页不可见、也无法被停用，pureref 的 configSchema 阈值更是无处可改）。
  // 只回 manifest，不回源码 —— 源码体积大且只有渲染层执行时才需要，走异步 readEditablePlugins。
  ipcMain.on(CHANNELS.pluginStateEditableManifests, event => {
    try {
      assertTrustedRenderer(event);
    } catch {
      event.returnValue = { manifests: [] };
      return;
    }
    if (SAFE_MODE) { event.returnValue = { manifests: [] }; return; }
    try {
      // 兼容半迁移状态：新布局为空时回退扫老布局（plugins/ 根下的 builtin.*）。
      // 否则迁移一旦失败，profile 里仍引用这些 id 的 patch 会被判为 unknown plugin。
      const read = root => { try { return readEditablePlugins(root).plugins.map(plugin => plugin.manifest); } catch { return []; } };
      let manifests = read(builtinPluginsRoot());
      if (manifests.length === 0) {
        const legacy = read(pluginsRoot());
        if (legacy.length > 0) {
          bootLog(`editable 清单：新布局为空，回退读取老布局（${legacy.length} 个）`);
          manifests = legacy;
        }
      }
      event.returnValue = { manifests };
    } catch (error) {
      console.warn('[editable] manifest scan failed:', error);
      event.returnValue = { manifests: [] };
    }
  });
  // 写也走 sendSync：持久化层（plugin-profile-manager.persistLayer）是**同步契约**，
  // 写失败必须能立刻抛给设置页，而不是变成一个没人 await 的 Promise 然后静默丢失。
  // 触发点只有用户点开关那一下的小文件原子写，阻塞量可忽略。
  ipcMain.on(CHANNELS.pluginStateWrite, (event, patches) => {
    try {
      assertTrustedRenderer(event);
    } catch {
      event.returnValue = { ok: false, message: 'untrusted renderer' };
      return;
    }
    const result = pluginProfileStore.write(patches);
    if (!result.ok) bootLog(`插件偏好写入失败：${result.message}`);
    event.returnValue = result;
  });
  ipcMain.on(CHANNELS.pluginStateClear, event => {
    try {
      assertTrustedRenderer(event);
    } catch {
      event.returnValue = { ok: false, message: 'untrusted renderer' };
      return;
    }
    event.returnValue = pluginProfileStore.clear();
  });
  // 启动诊断：把渲染层实际读到的偏好来源、被拒条目与最终启用/关闭集写进 logs/electron.log。
  // 这些以前只打在渲染层 console —— Electron 里根本看不见，出问题只能靠猜。
  ipcMain.on(CHANNELS.pluginStateBootLog, (event, payload) => {
    try {
      assertTrustedRenderer(event);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const source = typeof payload.source === 'string' ? payload.source : 'unknown';
    const enabled = Array.isArray(payload.enabled) ? payload.enabled : [];
    const disabled = Array.isArray(payload.disabled) ? payload.disabled : [];
    const rejected = Array.isArray(payload.rejected) ? payload.rejected.length : 0;
    bootLog(`插件偏好：来源=${source} 启用=${enabled.length} 关闭=${disabled.length} 被拒=${rejected}`);
    if (disabled.length > 0) bootLog(`  已关闭：${disabled.join(', ')}`);
    if (typeof payload.warning === 'string' && payload.warning.length > 0) {
      bootLog(`  [警告] 偏好异常：${payload.warning}`);
    }
  });
}

/**
 * 用户级配置（preferences / secrets）的 IPC。
 *
 * 为什么是 sendSync：配置的读取发生在**模块求值期**（`utils/language-store` 在模块顶层就要
 * 知道当前语言），消费方同 plugin-profile-manager 一样是同步契约。写失败也必须同步抛给 UI，
 * 不能退化成没人 await 的 Promise。触发点只有小文件原子写，阻塞量可忽略。
 *
 * 安全：只暴露「读 / 写 / 统计」三个固定 op + store 名白名单，不接受路径、不接受任意文件名，
 * 一律先过 assertTrustedRenderer。
 */
function registerConfigIpc() {
  const resolveStore = raw => (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(configStores, raw)
    ? configStores[raw]
    : null);
  const untrusted = { ok: false, values: {}, source: 'unreadable', degraded: true, message: 'untrusted renderer' };

  ipcMain.on(CHANNELS.configRead, (event, payload) => {
    try {
      assertTrustedRenderer(event);
    } catch {
      event.returnValue = untrusted;
      return;
    }
    const store = resolveStore(payload && payload.store);
    if (!store) {
      event.returnValue = { ok: false, values: {}, source: 'unreadable', degraded: true, message: 'unknown config store' };
      return;
    }
    const snapshot = store.read();
    // 降级必须可见：这些以前只打在渲染层 console，Electron 里根本看不见。
    if (snapshot.degraded) bootLog(`配置[${payload.store}]降级：来源=${snapshot.source} ${snapshot.message ?? ''}`);
    event.returnValue = snapshot;
  });

  ipcMain.on(CHANNELS.configWrite, (event, payload) => {
    try {
      assertTrustedRenderer(event);
    } catch {
      event.returnValue = { ok: false, message: 'untrusted renderer' };
      return;
    }
    if (!payload || typeof payload !== 'object') {
      event.returnValue = { ok: false, message: 'config write payload must be an object' };
      return;
    }
    const store = resolveStore(payload.store);
    if (!store) {
      event.returnValue = { ok: false, message: 'unknown config store' };
      return;
    }
    let result;
    if (payload.op === 'set') {
      result = store.set(payload.key, payload.value);
    } else if (payload.op === 'patch') {
      result = store.patch(payload.values);
    } else if (payload.op === 'reset') {
      result = store.reset(payload.keys);
    } else {
      result = { ok: false, message: `unsupported config op: ${String(payload.op)}` };
    }
    if (!result.ok) bootLog(`配置[${payload.store}]写入失败(op=${String(payload.op)})：${result.message}`);
    event.returnValue = result;
  });

  ipcMain.on(CHANNELS.configStats, (event, payload) => {
    try {
      assertTrustedRenderer(event);
    } catch {
      event.returnValue = null;
      return;
    }
    const store = resolveStore(payload && payload.store);
    event.returnValue = store ? store.stats() : null;
  });

  // 启动诊断：把渲染层读到的偏好来源、降级原因与最终生效值规模写进 logs/electron.log。
  ipcMain.on(CHANNELS.configBootLog, (event, payload) => {
    try {
      assertTrustedRenderer(event);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const source = typeof payload.source === 'string' ? payload.source : 'unknown';
    const degraded = payload.degraded === true ? '（降级）' : '';
    const keyCount = Number.isInteger(payload.keyCount) ? payload.keyCount : 0;
    bootLog(`用户配置：来源=${source}${degraded} 键=${keyCount} 根=${configRoot}`);
    // 来源自身已说明是安全模式，这里补一句"所以看到 0 个键是正常的"——
    // 免得后来看日志的人把"键=0"当成配置丢失。
    if (payload.safeMode === true || source === 'host-safe-mode') {
      bootLog('  ↳ 安全模式：本次按"全新安装"启动，上面的 0 个键是刻意的，用户数据文件未被读取也未被修改');
    }
    const adopted = Array.isArray(payload.adoptedLegacyKeys) ? payload.adoptedLegacyKeys : [];
    if (adopted.length > 0) bootLog(`  已从旧 localStorage 采纳：${adopted.join(', ')}`);
    if (typeof payload.message === 'string' && payload.message.length > 0) {
      bootLog(`  [警告] 配置异常：${payload.message}`);
    }
  });

  // 渲染层启动期错误：只落日志，不回传。长度上限与 index.html 里的截断保持一致。
  ipcMain.on(CHANNELS.configBootError, (_event, line) => {
    if (typeof line !== 'string' || line.length === 0) return;
    bootLog(`[启动错误] ${line.slice(0, 1600)}`);
  });

  /** 预设收录范围（见 PRESET_VOLUMES）：空卷不写进去，免得预设里全是空壳。 */
  function collectPresetVolumes() {
    const volumes = {};
    for (const name of PRESET_VOLUMES) {
      const snapshot = configStores[name]?.read();
      if (snapshot && Object.keys(snapshot.values).length > 0) volumes[name] = snapshot.values;
    }
    return volumes;
  }

  /** 把预设里的卷逐个补丁进对应存储。逐卷报结果，某一卷失败不影响其它卷。 */
  function applyPresetVolumes(volumes) {
    const applied = {};
    for (const name of PRESET_VOLUMES) {
      const values = volumes[name];
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const result = configStores[name].patch(values);
      applied[name] = { ok: result.ok, count: Object.keys(values).length, message: result.message };
    }
    if (Object.keys(applied).length === 0) {
      return { ok: false, message: '预设里没有可应用的配置', applied };
    }
    const failed = Object.entries(applied).filter(([, r]) => !r.ok);
    return { ok: failed.length === 0, applied, message: failed.length > 0 ? '部分配置写入失败，详见日志' : undefined };
  }

  /** 存储管理面板的数据源：各卷 stats + 预设目录 + 缓存目录 + 密钥加密方式。 */
  function storageOverview() {
    const volumes = {};
    for (const [name, store] of Object.entries(configStores)) {
      const stats = store.stats();
      volumes[name] = {
        filePath: stats.filePath,
        exists: stats.exists,
        bytes: stats.bytes,
        keyCount: stats.keyCount,
        source: stats.source,
        degraded: stats.degraded,
        updatedAt: stats.updatedAt,
        safeMode: stats.safeMode,
        encrypted: stats.encrypted === true,
        /** 预设覆盖范围（面板上标出来，避免用户以为"导出预设=备份全部"）。 */
        inPreset: PRESET_VOLUMES.includes(name),
      };
    }
    let cacheBytes = 0;
    try {
      cacheBytes = directorySize(cacheRoot);
    } catch { /* 目录不存在时算 0 */ }
    return {
      ok: true,
      configRoot,
      volumes,
      cache: { path: cacheRoot, bytes: cacheBytes, exists: fs.existsSync(cacheRoot) },
      presets: presetLibrary.list().presets ?? [],
      presetsDir: presetLibrary.dirPath,
      secret: secretCodec.describe(),
      safeMode: SAFE_MODE,
    };
  }

  ipcMain.handle(CHANNELS.configPresets, async (event, payload) => {
    assertTrustedRenderer(event);
    const op = payload && payload.op;
    // 导出/导入都是"写"：安全模式下整段拒绝（那是只读会话）。
    if (op === 'save' || op === 'load' || op === 'import-from') {
      if (SAFE_MODE) return { ok: false, message: SAFE_MODE_WRITE_REJECTED };
    }
    if (op === 'list') return presetLibrary.list();
    if (op === 'save') {
      const result = presetLibrary.write(payload.name, collectPresetVolumes(), app.getVersion());
      if (result.ok) bootLog(`预设已导出：${result.filePath}（${result.bytes} 字节）`);
      return result;
    }
    if (op === 'load') {
      const loaded = presetLibrary.read(payload.name);
      if (!loaded.ok) return loaded;
      const applied = applyPresetVolumes(loaded.document.volumes);
      bootLog(`预设已导入：${payload.name}（${JSON.stringify(applied.applied ?? {})}）`);
      return applied;
    }
    if (op === 'remove') return presetLibrary.remove(payload.name);
    // 「另存为文件」/「从文件导入」走系统对话框，用于分享与换机迁移。
    if (op === 'export-to') {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const picked = await dialog.showSaveDialog(owner, {
        title: '导出设置预设',
        defaultPath: `artflow-preset-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'Artflow 预设', extensions: ['json'] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      const volumes = collectPresetVolumes();
      if (Object.keys(volumes).length === 0) return { ok: false, message: '没有可导出的配置' };
      try {
        const document = {
          kind: PRESET_KIND,
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          app: { version: app.getVersion() },
          volumes,
        };
        fs.writeFileSync(picked.filePath, JSON.stringify(document, null, 2), 'utf8');
        return { ok: true, filePath: picked.filePath };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (op === 'import-from') {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const picked = await dialog.showOpenDialog(owner, {
        title: '导入设置预设',
        properties: ['openFile'],
        filters: [{ name: 'Artflow 预设', extensions: ['json'] }],
      });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
      let document;
      try {
        const raw = fs.readFileSync(picked.filePaths[0], 'utf8');
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return { ok: false, message: '预设文件过大（>2MB）' };
        document = JSON.parse(raw);
      } catch (error) {
        return { ok: false, message: `无法读取该文件：${error instanceof Error ? error.message : String(error)}` };
      }
      if (!document || document.kind !== PRESET_KIND || typeof document.volumes !== 'object' || document.volumes === null) {
        return { ok: false, message: '不是 Artflow 预设文件' };
      }
      return applyPresetVolumes(document.volumes);
    }
    return { ok: false, message: `不支持的预设操作：${String(op)}` };
  });

  ipcMain.handle(CHANNELS.configStorage, async (event, payload) => {
    assertTrustedRenderer(event);
    const op = payload && payload.op;
    if (op === 'overview') return storageOverview();
    if (op === 'clear-cache') {
      if (SAFE_MODE) return { ok: false, message: SAFE_MODE_WRITE_REJECTED };
      return clearCache();
    }
    return { ok: false, message: `不支持的存储操作：${String(op)}` };
  });
}

/** 校验目录存在并交给系统"打开"；返回 null 表示成功，否则返回拒绝原因。 */
async function openDirWithHint(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 'rejected: directory not found';
  }
  if (!stat.isDirectory()) return 'rejected: not a directory';
  const errorMessage = await shell.openPath(target);
  return errorMessage || null;
}

function registerAppIpc() {
  ipcMain.handle(CHANNELS.openPluginDir, async (event, relPath) => {
    assertTrustedRenderer(event);
    if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 200) {
      return 'rejected: invalid path';
    }
    // `editable:<id>` —— 可编辑内置插件的运行副本在 userData/plugins/builtin/<id>/，不在 app 根下，
    // 用前缀显式区分，避免把用户可写目录暴露成任意 app 根相对路径解析。
    if (relPath.startsWith('editable:')) {
      const id = relPath.slice('editable:'.length);
      if (!BUILTIN_DIR_PATTERN.test(id)) {
        return 'rejected: invalid editable plugin id';
      }
      // resolveBuiltinPackageDir 已做白名单 + 存在的布局判定；这里再校验解析结果仍落在插件根内。
      const allowedRoots = [path.resolve(builtinPluginsRoot()), path.resolve(pluginsRoot())];
      const target = path.resolve(resolveBuiltinPackageDir(id));
      if (!allowedRoots.some(root => target === root || target.startsWith(root + path.sep))) {
        return 'rejected: path escapes plugins root';
      }
      return openDirWithHint(target);
    }
    const segments = relPath.split(/[\\/]/);
    if (segments.some(seg => seg.length === 0 || seg === '.' || seg === '..')) {
      return 'rejected: path must be relative without "." or ".." segments';
    }
    const appRoot = path.resolve(__dirname);
    const target = path.resolve(appRoot, ...segments);
    if (target !== appRoot && !target.startsWith(appRoot + path.sep)) {
      return 'rejected: path escapes application root';
    }
    return openDirWithHint(target);
  });

  // 窗口级能力（置顶/透明度/穿透）：作用于发起调用的那个窗口，多窗口安全。
  ipcMain.handle(CHANNELS.setAlwaysOnTop, (event, enabled) => {
    assertTrustedRenderer(event);
    if (typeof enabled !== 'boolean') return 'rejected: enabled must be boolean';
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return 'rejected: window not found';
    win.setAlwaysOnTop(enabled, 'screen-saver');
    return win.isAlwaysOnTop();
  });
  ipcMain.handle(CHANNELS.setWindowOpacity, (event, opacity) => {
    assertTrustedRenderer(event);
    if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0.1 || opacity > 1) {
      return 'rejected: opacity must be within [0.1, 1]';
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return 'rejected: window not found';
    win.setOpacity(opacity);
    return win.getOpacity();
  });
  ipcMain.handle(CHANNELS.setWindowBackground, (event, color) => {
    assertTrustedRenderer(event);
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      return 'rejected: color must be #rrggbb';
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return 'rejected: window not found';
    win.setBackgroundColor(color);
    return color;
  });
  ipcMain.handle(CHANNELS.setIgnoreMouseEvents, (event, ignore) => {
    assertTrustedRenderer(event);
    if (typeof ignore !== 'boolean') return 'rejected: ignore must be boolean';
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return 'rejected: window not found';
    // forward:true 让窗口仍能收到 mousemove（供渲染层判断悬停恢复），点击依旧穿透。
    win.setIgnoreMouseEvents(ignore, { forward: true });
    return ignore;
  });

  // Frameless controls: a fixed action whitelist and the requesting webContents' own window.
  // close() intentionally goes through Electron's normal beforeunload/save-confirm flow.
  ipcMain.handle(CHANNELS.getWindowState, event => {
    assertTrustedRenderer(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, message: 'rejected: window not found' };
    return { ok: true, maximized: win.isMaximized(), minimized: win.isMinimized() };
  });
  ipcMain.handle(CHANNELS.windowControl, (event, action) => {
    assertTrustedRenderer(event);
    if (action !== 'minimize' && action !== 'toggle-maximize' && action !== 'close') {
      return { ok: false, message: 'rejected: invalid window action' };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, message: 'rejected: window not found' };
    if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else win.close();
    return { ok: true, maximized: win.isDestroyed() ? false : win.isMaximized() };
  });

  // 面板弹出为独立窗口（Blender 式拖出的 OS 窗口实现）：无边界 frameless 窗口加载同一
  // renderer（同 bundle、同 localStorage 配置态），hash 携带面板 id，渲染层走
  // PipPanelApp 精简宿主。窗口关闭后向发起窗口广播，由面板宿主还原原位显示。
  ipcMain.handle(CHANNELS.openPanelWindow, (event, request) => {
    assertTrustedRenderer(event);
    if (!request || typeof request !== 'object') return { ok: false, message: 'rejected: request required' };
    const panelId = typeof request.panelId === 'string' ? request.panelId : '';
    if (!/^[\w.:-]{1,120}$/.test(panelId)) return { ok: false, message: 'rejected: invalid panelId' };
    const width = Math.round(Math.max(320, Math.min(Number(request.width) || 480, 1600)));
    const height = Math.round(Math.max(240, Math.min(Number(request.height) || 640, 1200)));
    const sender = BrowserWindow.fromWebContents(event.sender);
    const panelWindow = new BrowserWindow({
      width,
      height,
      minWidth: 300,
      minHeight: 200,
      // 与主窗口同策略：Windows 无边框 + 渲染层自绘拖拽带，其他平台保留原生边框。
      frame: process.platform !== 'win32',
      thickFrame: true,
      resizable: true,
      minimizable: true,
      maximizable: true,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#0a0a0a',
      icon: path.join(__dirname, 'branding', 'icons', 'artflow.ico'),
      title: 'Artflow · Panel',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.cjs'),
      },
    });
    panelWindow.setMenu(null);
    const hash = `pip-panel=${encodeURIComponent(panelId)}`;
    const devUrl = process.env.VITE_DEV_SERVER_URL ? String(process.env.VITE_DEV_SERVER_URL).replace(/\/+$/, '') : '';
    if (devUrl) panelWindow.loadURL(`${devUrl}/#${hash}`);
    else panelWindow.loadFile(path.join(__dirname, 'dist/index.html'), { hash });
    panelWindow.once('ready-to-show', () => panelWindow.show());
    panelWindow.on('closed', () => {
      if (sender && !sender.isDestroyed()) {
        sender.webContents.send(CHANNELS.panelWindowClosed, { panelId });
      }
    });
    return { ok: true };
  });

  // 渲染层「首帧已画完」信号：主窗口据此撤掉启动画面并淡入。
  // 只认主窗口自己发来的（弹出面板窗口不参与启动时序），且必须是可信渲染层；
  // 用 on 而非 handle —— 宿主不需要回执，也不该让渲染层等待窗口切换。
  ipcMain.on(CHANNELS.rendererReady, event => {
    try {
      assertTrustedRenderer(event);
    } catch (error) {
      console.warn('Rejected untrusted renderer-ready signal:', error.message);
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    if (rendererReady) return;
    rendererReady = true;
    bootLog('渲染层已挂载');
    revealMainWindow('渲染层就绪');
  });

  // 应用级重启（唯一会终结本进程的渲染层能力，故给固定 op 而非通用进程控制）。
  // 与 windowControl('close') 不同，这里刻意不经过窗口 beforeunload：重启语义就是丢弃当前会话
  // （与"插件受控重载"同理），未保存改动确认由设置面板在调用前完成，避免"关窗确认一次、
  // 重启再确认一次"的双重拦截。先回执、后退出，保证渲染层 promise 不悬挂。
  let restartPending = false;
  ipcMain.handle(CHANNELS.restartApp, event => {
    assertTrustedRenderer(event);
    if (restartPending) return { ok: false, message: 'rejected: restart already in progress' };
    restartPending = true;
    const win = BrowserWindow.fromWebContents(event.sender);
    setTimeout(() => {
      // 先交还单实例锁：relaunch 出来的新进程要立刻拿到锁，否则它会把自己当成"第二个实例"
      // 直接退出 —— 表现就是点重启之后应用再也没起来。
      try {
        app.releaseSingleInstanceLock();
      } catch {
        /* 没拿到锁时（隔离调试）不需要交还 */
      }
      app.relaunch();
      // destroy 跳过 beforeunload 与 close 事件；本进程即将退出，窗口无需收尾动作。
      if (win && !win.isDestroyed()) win.destroy();
      app.quit();
    }, 150);
    return { ok: true };
  });

  // Right-drag moves ONLY the requesting Windows frameless window. Never accept a
  // window id, absolute position, or unbounded renderer-supplied displacement.
  //
  // 尺寸必须每帧显式回传（不能只给位置）：Windows 上对 frameless 窗口调用
  // setPosition，Chromium 会按窗口边框重算外框，每调用一次就把边框厚度再累加一层
  // —— 实测每帧 +1px（拖 1 秒长 60px，窗口肉眼可见地"越拖越大"）。
  // 锁住 start 那一刻的宽高并用 setBounds 定位，膨胀只会在第一帧发生一次，之后恒定。
  const windowMoveSessions = new WeakMap();
  ipcMain.handle(CHANNELS.windowMove, (event, request) => {
    assertTrustedRenderer(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (process.platform !== 'win32' || !win || win.isDestroyed() || !win.isMovable()) {
      return { ok: false, message: 'rejected: window not movable' };
    }
    if (request?.phase === 'end') {
      windowMoveSessions.delete(win);
      return { ok: true };
    }
    const x = request?.screenX;
    const y = request?.screenY;
    if ((request?.phase !== 'start' && request?.phase !== 'update')
        || !Number.isFinite(x) || !Number.isFinite(y)
        || Math.abs(x) > 1000000 || Math.abs(y) > 1000000) {
      return { ok: false, message: 'rejected: invalid window gesture' };
    }
    if (request.phase === 'start') {
      if (win.isMaximized()) {
        // Restore only AFTER the drag threshold, not when opening a context menu.
        const maximized = win.getBounds();
        win.unmaximize();
        const restored = win.getBounds();
        const fractionX = Math.max(0.05, Math.min(0.95, (x - maximized.x) / maximized.width));
        const fractionY = Math.max(0.05, Math.min(0.95, (y - maximized.y) / maximized.height));
        win.setBounds({
          x: Math.round(x - restored.width * fractionX),
          y: Math.round(y - restored.height * fractionY),
          width: restored.width,
          height: restored.height,
        });
      }
      const bounds = win.getBounds();
      windowMoveSessions.set(win, {
        x, y,
        baseX: bounds.x, baseY: bounds.y,
        width: bounds.width, height: bounds.height,
        started: Date.now(),
      });
      return { ok: true };
    }
    const session = windowMoveSessions.get(win);
    if (!session || Date.now() - session.started > 15000
        || Math.abs(x - session.x) > 8192 || Math.abs(y - session.y) > 8192) {
      windowMoveSessions.delete(win);
      return { ok: false, message: 'rejected: expired or out-of-bounds gesture' };
    }
    win.setBounds({
      x: session.baseX + Math.round(x - session.x),
      y: session.baseY + Math.round(y - session.y),
      width: session.width,
      height: session.height,
    });
    return { ok: true };
  });

  // 性能指标（性能监测 HUD）：app 级只读快照，白名单字段映射，不透传内部结构.
  // 安全模式：用户装的外部插件一律不列举、不激活、不调用（对标 --factory-startup 忽略用户 addons）。
  // 判据放在 IPC 边界而不是各个扫描函数内部 —— 扫描函数仍只认一个 root，不必各自长出一条分支。
  ipcMain.handle(CHANNELS.listDeclarativePlugins, (event) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { plugins: [] };
    return listDeclarativePlugins(pluginsRoot());
  });
  // 内置可编辑插件：返回源码文本，执行在渲染层（受信任，等同编译进 bundle 的内置插件）。
  // 安全模式下同样屏蔽：它是"读用户目录 + 执行"的组合，工厂启动语义下不该跑。
  ipcMain.handle(CHANNELS.readEditablePlugins, (event) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { plugins: [] };
    // 与同步清单一致：新布局为空时回退老布局，避免半迁移状态下插件整体消失。
    const fresh = readEditablePlugins(builtinPluginsRoot());
    if (fresh.plugins.length > 0) return fresh;
    const legacy = readEditablePlugins(pluginsRoot());
    return legacy.plugins.length > 0 ? legacy : fresh;
  });
  ipcMain.handle(CHANNELS.listInstalledPlugins, (event) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { plugins: [] };
    return listInstalledPlugins(pluginsRoot());
  });
  ipcMain.handle(CHANNELS.listSandboxedPlugins, async (event) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { plugins: [] };
    return activateInstalledPlugins(pluginsRoot());
  });
  /**
   * 安装的统一入口：sourcePath 可以是「插件文件夹」或「.zip 压缩包」。
   * 压缩包先解到 userData/temp 下的临时目录，再走目录安装流程；用完即清。
   * 信任确认（components / host 权限）沿用目录安装的同一套弹窗。
   */
  async function installFromSourcePath(sourcePath, owner) {
    let sourceDir = null;
    let cleanup = null;
    try {
      let stat;
      try { stat = fs.statSync(sourcePath); } catch { return { ok: false, message: 'path is not accessible' }; }
      if (stat.isFile()) {
        if (!/\.zip$/i.test(sourcePath)) return { ok: false, message: 'only .zip archives and plugin folders are supported' };
        try {
          cleanup = fs.mkdtempSync(path.join(app.getPath('temp'), 'artflow-plugin-'));
          extractPluginZip(sourcePath, cleanup);
        } catch (error) {
          return { ok: false, message: error instanceof PluginArchiveError ? error.message : 'failed to read the archive' };
        }
        sourceDir = resolvePluginSourceDir(cleanup);
        if (!sourceDir) return { ok: false, message: 'archive does not contain an Artflow plugin (manifest.json not found)' };
      } else if (stat.isDirectory()) {
        sourceDir = sourcePath;
      } else {
        return { ok: false, message: 'not a file or directory' };
      }
      // 组件贡献 = 宿主权限（docs/插件系统设计.md §8）：申请了 client.js 组件的插件
      // 将在画布渲染进程内直接运行 —— 安装前必须让用户显式授权。
      const inspection = inspectPluginDirectory(sourceDir);
      if (inspection.ok && inspection.needsTrustConfirmation) {
        const lines = ['此插件申请了额外权限：'];
        if (inspection.capabilities.includes('components')) lines.push('• 可在画布与应用内直接运行代码（unrestricted：卡片 / 覆盖层 / 面板组件）');
        if (inspection.permissions.length) lines.push(`• 数据权限：${inspection.permissions.join(' / ')}`);
        lines.push('', '只安装你信任的插件。卸载插件即可撤销授权。');
        const confirm = await dialog.showMessageBox(owner, {
          type: 'warning',
          title: 'Trust this plugin?',
          message: `安装「${inspection.name || inspection.id}」？`,
          detail: lines.join('\n'),
          buttons: ['信任并安装', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (confirm.response !== 0) return { ok: false, message: 'trust confirmation declined' };
      }
      return installPluginDirectory(sourceDir, pluginsRoot());
    } finally {
      if (cleanup) {
        try { fs.rmSync(cleanup, { recursive: true, force: true }); } catch { /* 临时目录清不掉也不影响安装结果 */ }
      }
    }
  }

  ipcMain.handle(CHANNELS.installExternalPlugin, async (event) => {
    assertTrustedRenderer(event);
    // 安装会真的往 userData/plugins 落文件 —— 安全模式下必须拒绝，不能只是"看不见"。
    if (SAFE_MODE) return { ok: false, message: SAFE_MODE_EXTERNAL_PLUGIN_REJECTED };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const selection = await dialog.showOpenDialog(owner, {
      title: 'Install Artflow plugin',
      // 同时允许文件夹与 .zip 压缩包：拖入画布也走同一套信任/安装流程。
      properties: ['openDirectory', 'openFile'],
      filters: [
        { name: 'Artflow plugin (folder or .zip)', extensions: ['zip'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (selection.canceled || selection.filePaths.length !== 1) return { ok: false, message: 'cancelled' };
    return installFromSourcePath(selection.filePaths[0], owner);
  });
  // 画布拖拽安装：渲染层把落点路径传过来（文件夹或 .zip），主进程校验后装。
  ipcMain.handle(CHANNELS.installExternalPluginFromPath, async (event, sourcePath) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { ok: false, message: SAFE_MODE_EXTERNAL_PLUGIN_REJECTED };
    if (typeof sourcePath !== 'string' || sourcePath.length === 0 || sourcePath.length > 4000) {
      return { ok: false, message: 'install path was rejected' };
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    return installFromSourcePath(path.resolve(sourcePath), owner);
  });
  ipcMain.handle(CHANNELS.uninstallExternalPlugin, async (event, id) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { ok: false, message: SAFE_MODE_EXTERNAL_PLUGIN_REJECTED };
    // 稳健卸载：删除目录时若命中 Windows 下偶发的文件锁（防病毒/索引器/仍驻留的沙箱引用），
    // 用递增延时重试兜底，避免「点了卸载却删不掉、且界面无任何反馈」的静默失败。
    // 任何异常都转成 {ok:false, message} 回执，而不是让 IPC 抛拒绝被渲染层吞掉。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const result = uninstallPlugin(pluginsRoot(), id);
        return result; // 校验类失败（id 非法/路径越界）直接回告，不重试
      } catch (error) {
        const code = error && error.code;
        const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EMFILE';
        if (retryable && attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        return { ok: false, message: `failed to remove plugin files: ${code || (error && error.message) || 'unknown error'}` };
      }
    }
    return { ok: false, message: 'failed to remove plugin files after retries' };
  });
  // 画布拖拽预检：落点是「插件来源」（.zip 含 manifest，或文件夹含 manifest）才走安装，
  // 否则照常作为画布资产导入。失败一律返回 false，不抛错。
  ipcMain.handle(CHANNELS.isPluginSourcePath, (event, sourcePath) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return false;
    if (typeof sourcePath !== 'string' || sourcePath.length === 0 || sourcePath.length > 4000) return false;
    return isPluginSourcePath(path.resolve(sourcePath));
  });
  ipcMain.handle(CHANNELS.invokeSandboxedPlugin, (event, message) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { ok: false, message: SAFE_MODE_EXTERNAL_PLUGIN_REJECTED };
    return invokePlugin(message);
  });
  ipcMain.handle(CHANNELS.readPluginClients, (event) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { clients: [] };
    return listPluginClients(pluginsRoot());
  });
  ipcMain.handle(CHANNELS.renameAssetNames, (event, request) => {
    assertTrustedRenderer(event);
    const result = storageController.renameAssetNames(request);
    // 宿主事件：逐条广播成功改名的资产（missing 的不发）。旧名主进程无从得知，不带。
    if (result && Array.isArray(result.renamed) && request && Array.isArray(request.changes)) {
      const named = new Map(request.changes.filter(change => change && typeof change.id === 'string' && typeof change.name === 'string').map(change => [change.id, change.name]));
      for (const assetId of result.renamed) {
        hostEvents.emit('asset.renamed', { asset: { id: assetId, name: named.get(assetId) || '' } });
      }
    }
    return result;
  });

  // —— 插件 data.json（渲染端设置表单的读写通道）——
  // 渲染层只传插件 id：目录由主进程从已安装清单推导，不接受任何路径参数。
  ipcMain.handle(CHANNELS.pluginDataLoad, (event, pluginId) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { ok: false, message: SAFE_MODE_EXTERNAL_PLUGIN_REJECTED };
    const pkg = findSandboxedPackage(pluginsRoot(), pluginId);
    if (!pkg) return { ok: false, message: 'plugin is not installed' };
    try {
      return { ok: true, data: loadPluginData(pkg.dir) };
    } catch (error) {
      return { ok: false, message: error?.message || 'plugin data load failed' };
    }
  });
  ipcMain.handle(CHANNELS.pluginDataSave, (event, request) => {
    assertTrustedRenderer(event);
    if (SAFE_MODE) return { ok: false, message: SAFE_MODE_EXTERNAL_PLUGIN_REJECTED };
    const pluginId = request && typeof request.pluginId === 'string' ? request.pluginId : '';
    const pkg = findSandboxedPackage(pluginsRoot(), pluginId);
    if (!pkg) return { ok: false, message: 'plugin is not installed' };
    try {
      return { ok: true, ...savePluginData(pkg.dir, request.data) };
    } catch (error) {
      return { ok: false, message: error?.message || 'plugin data save failed' };
    }
  });

  ipcMain.handle(CHANNELS.getPerfMetrics, (event) => {
    assertTrustedRenderer(event);
    return app.getAppMetrics().map(m => ({
      type: String(m.type || ''),
      pid: Number(m.pid || 0),
      cpuPercent: Number((m.cpu && m.cpu.percentCPUUsage) || 0),
      workingSetKB: Number((m.memory && m.memory.workingSetSize) || 0),
      peakWorkingSetKB: Number((m.memory && m.memory.peakWorkingSetSize) || 0),
    }));
  });

  // 通用字节保存：渲染层生成（导出 PNG / .artflow 包），主进程弹保存对话框写盘。
  ipcMain.handle(CHANNELS.saveBytes, async (event, request) => {
    assertTrustedRenderer(event);
    const { title, defaultName, bytes } = request || {};
    if (typeof defaultName !== 'string' || defaultName.length === 0 || defaultName.length > 200) {
      return { ok: false, message: 'rejected: invalid file name' };
    }
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
      return { ok: false, message: 'rejected: invalid bytes' };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      title: typeof title === 'string' && title.length > 0 ? title : 'Save',
      defaultPath: defaultName,
    });
    if (result.canceled || !result.filePath) return { ok: false, message: 'canceled' };
    try {
      await fs.promises.writeFile(result.filePath, Buffer.from(bytes));
      return { ok: true, path: result.filePath };
    } catch (error) {
      return { ok: false, message: `write failed: ${error.message}` };
    }
  });

  // 复制为文件：字节写临时目录，再把文件放进系统剪贴板（贴进资源管理器/微信即落文件）。
  ipcMain.handle(CHANNELS.copyFileToClipboard, async (event, request) => {
    assertTrustedRenderer(event);
    const { name, bytes } = request || {};
    if (typeof name !== 'string' || name.length === 0 || name.length > 200 || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return { ok: false, message: 'rejected: invalid file name' };
    }
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
      return { ok: false, message: 'rejected: invalid bytes' };
    }
    const dir = path.join(app.getPath('temp'), 'artflow-clipboard');
    const target = path.join(dir, name);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(target, Buffer.from(bytes));
    } catch (error) {
      return { ok: false, message: `write failed: ${error.message}` };
    }
    if (process.platform === 'win32') {
      // CF_HDROP 通道：文件名用 UTF-16LE 双 NUL 结尾，资源管理器/聊天软件识别为可粘贴文件。
      clipboard.writeBuffer('FileNameW', Buffer.from(`${target}\0\0`, 'ucs2'));
      return { ok: true, path: target };
    }
    clipboard.write({ text: target });
    return { ok: true, path: target, message: 'text-path-fallback' };
  });

  ipcMain.handle(CHANNELS.resolveVideoShortUrl, (event, url) => {
    assertTrustedRenderer(event);
    return resolveVideoShortUrl(url);
  });
  ipcMain.handle(CHANNELS.openVideoLink, async (event, url) => {
    assertTrustedRenderer(event);
    await shell.openExternal(validateExternalVideoUrl(url));
  });

  // .artflow 打开：主进程对话框读字节（单文件工程包，见 docs/PureRef功能对齐清单.md ⑥）。
  ipcMain.handle(CHANNELS.openArtflow, async event => {
    assertTrustedRenderer(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Artflow portable project',
      filters: [{ name: 'Artflow Portable', extensions: ['artflow', 'zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, message: 'canceled' };
    const filePath = result.filePaths[0];
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 1024 * 1024 * 1024) return { ok: false, message: 'rejected: file exceeds 1GB limit' };
      const buffer = await fs.promises.readFile(filePath);
      return {
        ok: true,
        name: path.basename(filePath),
        // 显式 slice 复制出独立 ArrayBuffer，避免超出 Buffer 池边界传参。
        bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      };
    } catch (error) {
      return { ok: false, message: `read failed: ${error.message}` };
    }
  });
}

app.whenReady().then(async () => {
  // 抢不到单实例锁的后来者不启动任何东西（app.quit() 已经发过，这里只是不让已排队的任务跑起来）。
  if (!isPrimaryInstance) return;
  // 第一件事就是亮启动画面：后面的会话恢复 / MCP 启动 / 窗口装载都在它背后跑，
  // 用户看到的第一帧永远是这块动画，而不是空屏或白屏。
  bootLog('app ready');
  splashWindow = createSplashWindow();
  // Remove Electron's default File/Edit/View/Window menu entirely (not just auto-hide).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  registerStorageIpc();
  registerPluginStateIpc();
  registerConfigIpc();
  registerAppIpc();
  registerAiIpc();
  registerComicIpc();
  registerPluginStoreIpc();
  registerAssetProtocol();
  try {
    await storageController.restoreLastSession?.();
  } catch (error) {
    console.warn('Failed to restore previous project session on startup:', error);
  }
  bootLog('会话恢复完成');
  reportSplashProgress(30);
  try {
    // Register trusted IPC only; renderer's resolved headless profile owns HTTP activation.
    mcpServer = await startEmbeddedMcp({
      userData: app.getPath('userData'),
      storageController,
      assertTrustedRenderer,
    });
  } catch (error) {
    console.warn('Failed to start Artflow MCP:', error);
  }
  bootLog('MCP 就绪');
  reportSplashProgress(55);
  // 首次启动把随应用分发的内置插件（可编辑内置 + 默认皮肤包）播种到 plugins/builtin/；
  // 必须在 createWindow 之前完成，确保渲染层首次请求清单时已就位。
  try { seedBundledPlugins(builtinPluginsRoot()); } catch (error) { console.warn('播种 bundled 插件失败：', error); }
  reportSplashProgress(75);
  createWindow();
  reportSplashProgress(90);
  bootLog('主窗口已创建，等待渲染层');

  // M6：主题切换时实时更新托盘图标（渲染层先落盘皮肤状态再发此信号）。
  ipcMain.on(CHANNELS.skinChanged, (event, skinId) => {
    if (tray) updateTrayImage(readSkinBrandingById(skinId) || readActiveSkinBranding());
  });
  // M6：新建系统托盘（主题化图标 + 常驻后台）。
  createTray();

  // 注意：splash 超时计时不在这里。它必须在*装载*之后才起算 ——
  // dev 冷启动的"等前端服务"可能占掉十几秒，从 whenReady 起算会把预算提前耗光。
  // 计时由 createWindow() 在 loadURL / loadFile 之后 armSplashTimeout() 启动。

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // 先置退出标志：宿主窗口随进程销毁时也会触发 render-process-gone/closed，
  // 不拦一下会在退出过程中重建一个隐藏沙箱窗口。
  appQuitting = true;
  mcpServer?.close();
  storageController.close();
  comicArchive?.closeAll();
});
app.on('window-all-closed', function () {
  // M6：托盘常驻模式下，关掉最后一个窗口不退出，进程由托盘菜单的"退出"终结。
  if (process.platform !== 'darwin' && tray) return;
  if (process.platform !== 'darwin') app.quit();
});
