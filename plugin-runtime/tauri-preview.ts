import commandsCoreManifest from '../plugins/builtin.commands-core/manifest.json';
import commandsCoreSource from '../plugins/builtin.commands-core/plugin.js?raw';
import coreExtensionsManifest from '../plugins/builtin.core-extensions/manifest.json';
import coreExtensionsSource from '../plugins/builtin.core-extensions/plugin.js?raw';
import formatsFilesManifest from '../plugins/builtin.formats-files/manifest.json';
import formatsFilesSource from '../plugins/builtin.formats-files/plugin.js?raw';
import formatsImageDocManifest from '../plugins/builtin.formats-image-doc/manifest.json';
import formatsImageDocSource from '../plugins/builtin.formats-image-doc/plugin.js?raw';
import formatsPurerefManifest from '../plugins/builtin.formats-pureref/manifest.json';
import formatsPurerefSource from '../plugins/builtin.formats-pureref/plugin.js?raw';
import formatsReaderManifest from '../plugins/builtin.formats-reader/manifest.json';
import formatsReaderSource from '../plugins/builtin.formats-reader/plugin.js?raw';
import mediaManifest from '../plugins/builtin.media/manifest.json';
import mediaSource from '../plugins/builtin.media/plugin.js?raw';
import projectPortableManifest from '../plugins/builtin.project-portable/manifest.json';
import projectPortableSource from '../plugins/builtin.project-portable/plugin.js?raw';
import { PROFILE_PATCH_STORAGE_KEY } from './profile';
import { PROFILE_MIGRATION_MARKER_KEY } from './plugin-state-storage';
import type { PerfMetricEntry } from '../utils/perf-process-metrics';

/** Optional Tauri host adapter. Electron/browser startup remains untouched. */
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ByteResult = { ok: boolean; name?: string; bytes?: number[]; message?: string };
type BundledEditable = {
  manifest: { id: string; name: string; version: string; description?: string };
  source: string;
};

/**
 * The Electron host reads editable plugins from userData/plugins/builtin/<id>/.
 * The Tauri preview has no such folder, so it ships the same modules that the
 * repository seeds there. Keep this list complete: a missing entry makes its
 * dependents (e.g. builtin.formats-psd requires builtin.formats-image-doc) fail
 * with "requires missing plugin", and the plugin manager reports it as an error.
 */
const BUNDLED_EDITABLE_PLUGINS: readonly BundledEditable[] = [
  { manifest: commandsCoreManifest, source: commandsCoreSource },
  { manifest: coreExtensionsManifest, source: coreExtensionsSource },
  { manifest: formatsFilesManifest, source: formatsFilesSource },
  { manifest: formatsImageDocManifest, source: formatsImageDocSource },
  { manifest: formatsPurerefManifest, source: formatsPurerefSource },
  { manifest: formatsReaderManifest, source: formatsReaderSource },
  { manifest: mediaManifest, source: mediaSource },
  { manifest: projectPortableManifest, source: projectPortableSource },
];

const readPatches = (storage: Storage | null): unknown[] | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PROFILE_PATCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const patches = (parsed as { patches?: unknown }).patches;
    return Array.isArray(patches) ? patches : null;
  } catch {
    return null;
  }
};

/**
 * Tauri keeps plugin preferences in the WebView2 localStorage of the dev origin
 * (there is no userData JSON file yet). Exposing it through the same
 * `artflowPluginState` contract as Electron keeps profile resolution identical
 * in both hosts instead of silently falling back to a separate store.
 */
const createPluginStateBridge = (storage: Storage | null) => ({
  readSync: () => {
    const patches = readPatches(storage);
    if (!patches) return { ok: true, patches: null, source: 'none' as const };
    return { ok: true, patches, source: 'file' as const, schemaVersion: 1 };
  },
  writeSync: (patches: unknown[]) => {
    if (!storage) return { ok: false, message: 'localStorage unavailable' };
    try {
      storage.setItem(PROFILE_PATCH_STORAGE_KEY, JSON.stringify({ patches }));
      return { ok: true, count: patches.length };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  clearSync: () => {
    if (!storage) return { ok: false, message: 'localStorage unavailable' };
    try {
      storage.removeItem(PROFILE_PATCH_STORAGE_KEY);
      storage.removeItem(PROFILE_MIGRATION_MARKER_KEY);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  readEditableManifestsSync: () => ({ manifests: BUNDLED_EDITABLE_PLUGINS.map(entry => entry.manifest) }),
  reportBoot: () => {},
});

export function installTauriPreviewBridge(target: Window = window): boolean {
  const tauri = (target as unknown as {
    __TAURI__?: {
      core?: { invoke?: Invoke };
      event?: { listen?: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void> };
    };
  }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke || target.artflowApp) return false;
  const listen = tauri?.event?.listen;
  const storage = (() => {
    try {
      return target.localStorage ?? null;
    } catch {
      return null;
    }
  })();
  // 订阅必须返回可用的退订函数：WindowChrome / panel-host 会持有它并在卸载时调用。
  // listen 是异步的，所以退订函数在 Promise 落地后才真正移除监听，期间置位 disposed
  // 保证迟到的 payload 不会再回调进已卸载的组件。
  const subscribe = <T>(event: string, callback: (payload: T) => void): (() => void) => {
    if (!listen) return () => {};
    let disposed = false;
    const pending = listen<T>(event, payload => {
      if (!disposed) callback(payload.payload);
    }).catch(error => {
      console.warn(`[tauri] subscribe ${event} failed`, error);
      return () => {};
    });
    return () => {
      disposed = true;
      void pending.then(off => off());
    };
  };
  const windowReply = <T>(command: string, args?: Record<string, unknown>) =>
    invoke<T>(command, args);
  const bridge = {
    // tauri.conf.json 关掉了原生装饰（decorations:false），自绘标题栏在所有平台都启用，
    // 因此这里与 Electron 的 process.platform === 'win32' 语义不同：恒为 true。
    // 想要运行时事实的调用方可以走 tauri_window_platform 命令。
    isFramelessWindow: true,
    restartApp: () => windowReply<{ ok: boolean; message?: string }>('tauri_restart_app'),
    setAlwaysOnTop: (enabled: boolean) =>
      windowReply<boolean | string>('tauri_set_always_on_top', { enabled }),
    setWindowOpacity: (opacity: number) =>
      windowReply<number | string>('tauri_set_window_opacity', { opacity }),
    setWindowBackground: (color: string) =>
      windowReply<string>('tauri_set_window_background', { color }),
    setIgnoreMouseEvents: (ignore: boolean) =>
      windowReply<boolean | string>('tauri_set_ignore_mouse_events', { ignore }),
    windowControl: (action: string) =>
      windowReply<{ ok: boolean; maximized?: boolean; message?: string }>('tauri_window_control', { action }),
    windowMove: (request: unknown) =>
      windowReply<{ ok: boolean; message?: string }>('tauri_window_move', { request: request ?? null }),
    getWindowState: () =>
      windowReply<{ ok: boolean; maximized?: boolean; minimized?: boolean; message?: string }>(
        'tauri_get_window_state',
      ),
    // 事件名与 Electron 主进程保持同一套词汇（window.rs 复用原频道字符串）。
    onWindowStateChanged: (callback: (state: { maximized: boolean }) => void) =>
      subscribe<{ maximized?: boolean }>('artflow-app:window-state-changed', payload =>
        callback({ maximized: payload?.maximized === true }),
      ),
    onPanelWindowClosed: (callback: (payload: { panelId: string }) => void) =>
      subscribe<{ panelId?: string }>('artflow-app:panel-window-closed', payload =>
        callback({ panelId: String(payload?.panelId ?? '') }),
      ),
    // Electron enumerates userData; here the trusted bundled sources are shipped
    // with the preview bundle. Never fetch arbitrary scripts.
    readEditablePlugins: async () => ({
      plugins: BUNDLED_EDITABLE_PLUGINS.map(entry => ({
        id: entry.manifest.id,
        name: entry.manifest.name,
        version: entry.manifest.version,
        description: entry.manifest.description,
        manifest: entry.manifest,
        source: entry.source,
      })),
    }),
    // No external (sandboxed/declarative) plugin repository exists in this
    // preview. Report an empty list and an explicit message instead of letting
    // the plugin manager render "host bridge unavailable".
    listInstalledPlugins: async () => ({ plugins: [] }),
    // 声明式插件（皮肤 + 语言包）由 Rust 侧扫描内置 plugins/ 目录给出。
    // ok:false 必须抛出：declarative-loader 只读 payload.plugins，静默变成空列表
    // 会表现为「皮肤系统没生效」的假成功。
    listDeclarativePlugins: async () => {
      const result = await invoke<{ ok: boolean; plugins?: unknown[]; message?: string }>(
        'tauri_list_declarative_plugins',
      );
      if (!result.ok) throw new Error(result.message ?? 'declarative plugins unavailable');
      return { plugins: result.plugins ?? [] };
    },
    installExternalPlugin: async () => ({
      ok: false,
      message: 'Tauri 预览不支持安装外部插件，请在 Electron 版中操作。',
    }),
    saveBytes: (request: { title?: string; defaultName: string; bytes: ArrayBuffer }) =>
      invoke<{ ok: boolean; path?: string; message?: string }>('tauri_save_bytes', {
        request: { ...request, bytes: Array.from(new Uint8Array(request.bytes)) },
      }),
    openArtflow: async () => {
      const result = await invoke<ByteResult>('tauri_open_artflow');
      return { ...result, bytes: result.bytes ? new Uint8Array(result.bytes).buffer : undefined };
    },
    openVideoLink: async (url: string) => {
      const result = await invoke<{ ok: boolean; message?: string }>('tauri_open_video_link', { url });
      if (!result.ok) throw new Error(result.message ?? 'Unable to open video link');
    },
    // Rust 侧原生采样（sysinfo）提供与 Electron app.getAppMetrics() 兼容的形状，
    // 只多一个可选 dedicatedGpuKB。失败时抛出，让 HUD 统一走「取不到」分支。
    getPerfMetrics: async () => {
      const result = await invoke<{ ok: boolean; metrics?: PerfMetricEntry[]; message?: string }>('tauri_perf_metrics');
      if (!result.ok) throw new Error(result.message ?? 'perf metrics unavailable');
      return result.metrics ?? [];
    },
    notifyRendererReady: () => {},
  };
  // Phase 2 已交付的宿主后端桥（project / panel / comfy / sandbox），与 preload.cjs 同契约名：
  // 缺失的方法保留浏览器/Electron 回退，不伪造桌面支持。
  const storageBridge = {
    chooseProject: () => invoke<Value>('tauri_storage_choose_project'),
    getStatus: () => invoke<Value>('tauri_storage_status'),
    importAsset: (request: { asset: unknown; bytes: number[]; originalName?: string }) =>
      invoke<Value>('tauri_storage_import_asset', { request }),
    requestImport: (request: { asset: unknown; bytes: number[]; originalName?: string }) =>
      invoke<Value>('tauri_storage_request_import', { request }),
    getImportJob: (jobId: string) => invoke<Value>('tauri_storage_get_import_job', { job_id: jobId }),
    listImportJobs: () => invoke<Value>('tauri_storage_list_import_jobs'),
    cancelImportJob: (jobId: string) => invoke<Value>('tauri_storage_cancel_import_job', { job_id: jobId }),
    saveProject: (document: unknown) => invoke<Value>('tauri_storage_save_project', { document }),
    loadProject: () => invoke<Value>('tauri_storage_load_project'),
    listRecentProjects: () => invoke<Value>('tauri_storage_list_recent_projects'),
    openRecentProject: (projectRoot: string) =>
      invoke<Value>('tauri_storage_open_recent_project', { project_root: projectRoot }),
    clearRecentProjects: () => invoke<Value>('tauri_storage_clear_recent_projects'),
    queryViewport: (request: unknown) => invoke<Value>('tauri_storage_query_viewport', { request }),
    listAssetInventory: (request: unknown) =>
      invoke<Value>('tauri_storage_list_asset_inventory', { request: request ?? null }),
    reclaimUnreferencedAssets: (request: unknown) =>
      invoke<Value>('tauri_storage_reclaim_assets', { request }),
    requestPreview: (assetId: string) => invoke<Value>('tauri_storage_request_preview', { asset_id: assetId }),
    getPreviewJob: (jobId: string) => invoke<Value>('tauri_storage_get_preview_job', { job_id: jobId }),
    cancelPreviewJob: (jobId: string) => invoke<Value>('tauri_storage_cancel_preview_job', { job_id: jobId }),
    openPluginDir: (relPath: unknown) => invoke<Value>('tauri_open_plugin_dir', { rel_path: relPath ?? null }),
  };
  const panelBridge = {
    openPanelWindow: (request: { panelId: string; width: number; height: number }) =>
      invoke<Value>('tauri_open_panel_window', { request }),
  };
  const aiBridge = {
    comfyRequest: (request: unknown) => invoke<Value>('tauri_comfy_request', { request: request ?? null }),
  };
  const sandboxBridge = {
    listSandboxedPlugins: () => invoke<Value>('tauri_list_sandboxed_plugins'),
    installExternalPlugin: () => invoke<Value>('tauri_install_external_plugin'),
    installExternalPluginFromPath: (sourcePath: string) =>
      invoke<Value>('tauri_install_external_plugin_from_path', { source: sourcePath }),
    isPluginSourcePath: (sourcePath: string) =>
      invoke<Value>('tauri_is_plugin_source_path', { request: { sourcePath } }),
    uninstallExternalPlugin: (id: string) => invoke<Value>('tauri_uninstall_external_plugin', { id }),
    invokeSandboxedPlugin: (message: unknown) => invoke<Value>('tauri_invoke_sandboxed_plugin', { message }),
    readPluginClients: () => invoke<Value>('tauri_read_plugin_clients'),
    readStored: (request: { pluginId?: string; ref?: string }) =>
      invoke<Value>('tauri_read_stored', { request }),
    readPluginPage: (request: { pluginId?: string; ref?: string; index?: number }) =>
      invoke<Value>('tauri_read_plugin_page', { request }),
    sandboxReply: (message: unknown) => invoke<boolean>('tauri_sandbox_reply', { message }),
  };
  // 漫画档案仓：档案字节只留在宿主侧，渲染层拿页清单与按需单页字节。
  // Tauri 没有结构化克隆，Uint8Array 必须转成 number[] 过 IPC，回来再包回 ArrayBuffer。
  const comicBridge = {
    importArchive: async (request: { bytes: Uint8Array; name: string }) => {
      const result = await invoke<{
        ok: boolean;
        ref?: string;
        pageNames?: string[];
        pageCount?: number;
        byteSize?: number;
        originalName?: string;
        message?: string;
      }>('tauri_comic_import', {
        request: { bytes: Array.from(request.bytes), name: request.name },
      });
      if (!result.ok) return { ok: false as const, message: result.message ?? 'comic archive unavailable' };
      return {
        ok: true as const,
        ref: result.ref ?? '',
        pageNames: result.pageNames ?? [],
        pageCount: result.pageCount ?? 0,
        byteSize: result.byteSize ?? 0,
        originalName: result.originalName ?? request.name,
      };
    },
    getPage: async (request: { ref: string; index: number }) => {
      const result = await invoke<{ ok: boolean; bytes?: number[]; mimeType?: string; message?: string }>(
        'tauri_comic_get_page',
        { request },
      );
      if (!result.ok) return { ok: false as const, message: result.message ?? 'comic page unavailable' };
      return {
        ok: true as const,
        bytes: new Uint8Array(result.bytes ?? []).buffer,
        mimeType: result.mimeType ?? 'application/octet-stream',
      };
    },
  };
  // Only implemented methods are exposed. Missing Electron services retain their
  // existing browser fallback rather than falsely advertising desktop support.
  target.artflowApp = bridge as unknown as NonNullable<Window['artflowApp']>;
  target.artflowPluginState = createPluginStateBridge(storage) as unknown as NonNullable<Window['artflowPluginState']>;
  target.artflowComic = comicBridge as unknown as NonNullable<Window['artflowComic']>;
  // Phase 2 已交付后端：托管项目存储（artflowStorage）、外部 AI 代理（artflowAi）、
  // 面板独立窗口（artflowApp.openPanelWindow）、外部沙箱插件（artflowApp.*）。
  // 渲染层以这些全局名存在与否决定走桌面后端还是浏览器回退，故按契约名平铺赋值。
  target.artflowStorage = storageBridge as unknown as NonNullable<Window['artflowStorage']>;
  target.artflowAi = aiBridge as unknown as NonNullable<Window['artflowAi']>;
  target.artflowApp = {
    ...bridge,
    openPanelWindow: panelBridge.openPanelWindow,
    listSandboxedPlugins: sandboxBridge.listSandboxedPlugins,
    installExternalPlugin: sandboxBridge.installExternalPlugin,
    installExternalPluginFromPath: sandboxBridge.installExternalPluginFromPath,
    isPluginSourcePath: sandboxBridge.isPluginSourcePath,
    uninstallExternalPlugin: sandboxBridge.uninstallExternalPlugin,
    invokeSandboxedPlugin: sandboxBridge.invokeSandboxedPlugin,
    readPluginClients: sandboxBridge.readPluginClients,
    readStored: sandboxBridge.readStored,
    readPluginPage: sandboxBridge.readPluginPage,
    sandboxReply: sandboxBridge.sandboxReply,
  } as unknown as NonNullable<Window['artflowApp']>;
  return true;
}

if (typeof window !== 'undefined') installTauriPreviewBridge();
