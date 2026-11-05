/**
 * host-platform.ts —— 宿主平台能力服务（本体 → 插件的单向通道）。
 * 插件面板禁止直接触摸 window / preload 桥（治理断言强制），
 * 平台能力（如打开目录）统一经此服务暴露，能力探测随服务自带。
 */

export const HOST_PLATFORM_SERVICE = 'host.platform';

export type WindowChromeAction = 'minimize' | 'toggle-maximize' | 'close';
export type WindowChromeState = { maximized: boolean };
export type WindowChromeResult = { ok: boolean; maximized?: boolean; minimized?: boolean; message?: string };
export type WindowMoveRequest =
  | { phase: 'start' | 'update'; screenX: number; screenY: number }
  | { phase: 'end' };
export type WindowMoveResult = { ok: boolean; message?: string };
/** 重启应用结果：ok=false 只表示主进程拒绝了请求（能力缺失/重复触发），不表示"重启失败"。 */
export type AppRestartResult = { ok: boolean; message?: string };

export interface HostPlatformService {
  confirm(message: string): boolean;
  /** 打开插件源码目录（相对应用根）；返回 null=成功，否则为拒绝原因。 */
  openPluginDir(relPath: string): Promise<string | null>;
  /** 当前环境是否具备打开目录能力（Electron preload 桥存在）。 */
  canOpenDirs: boolean;
  /** 窗口置顶（'screen-saver' 级）。返回生效状态或拒绝原因。 */
  setAlwaysOnTop(enabled: boolean): Promise<boolean | string>;
  /** 窗口透明度 [0.1, 1]。返回生效值或拒绝原因。 */
  setWindowOpacity(opacity: number): Promise<number | string>;
  /** 鼠标穿透（forward:true 保留 mousemove）。 */
  setIgnoreMouseEvents(ignore: boolean): Promise<boolean | string>;
  /** 字节落盘（保存对话框）。插件导出 PNG/.artflow 共用。 */
  saveBytes(request: { title?: string; defaultName: string; bytes: ArrayBuffer }): Promise<{ ok: boolean; path?: string; message?: string }>;
  /** 当前环境是否具备窗口控制能力。 */
  canWindowControls: boolean;
  /** Windows 无边框窗体才渲染内置拖动区和最小化/最大化/关闭按钮。 */
  isFramelessWindow: boolean;
  windowControl(action: WindowChromeAction): Promise<WindowChromeResult>;
  /** Only the owning Windows frameless window may respond to a canvas right-drag. */
  windowMove(request: WindowMoveRequest): Promise<WindowMoveResult>;
  getWindowState(): Promise<WindowChromeResult>;
  subscribeWindowState(callback: (state: WindowChromeState) => void): () => void;
  /** 当前环境是否具备重启应用能力（仅 Electron 桌面版；浏览器模式无桥）。 */
  canRestartApp: boolean;
  /** 重启整个应用（主进程 relaunch + 清理退出）。成功后窗口随进程销毁，回执可能收不到。 */
  restartApp(): Promise<AppRestartResult>;
  /** 托管资产导入（插件图像工具经此入库，禁直连 window.artflowStorage）。 */
  importAsset(request: { asset: unknown; bytes: ArrayBuffer; originalName?: string }): Promise<unknown>;
  /** 读取当前打开工程的 v2 文档（.artflow 导出源）。 */
  loadProject(): Promise<unknown>;
  /** 写入工程文档（.artflow 导入目的地）。 */
  saveProject(document: unknown): Promise<boolean>;
  /** 弹出工程文件夹选择（.artflow 导入前选新家）。 */
  chooseProject(): Promise<{ projectName: string } | null>;
  /** 打开 .artflow 文件（主进程对话框读字节）。 */
  openArtflow(): Promise<{ ok: boolean; name?: string; bytes?: ArrayBuffer; message?: string }>;
  /** 复制为文件：字节落临时目录并放进系统剪贴板（资源管理器/聊天软件可直接粘贴为文件）。 */
  copyFileToClipboard(request: { name: string; bytes: ArrayBuffer }): Promise<{ ok: boolean; path?: string; message?: string }>;
  /** 抓取资产字节（托管协议/blob/data URL 均可），供"复制为文件/原画质导出"用。 */
  fetchBytes(url: string): Promise<{ ok: boolean; bytes?: ArrayBuffer; mimeType?: string; message?: string }>;
  /** 托管资产库清单。浏览器模式或未打开工程时 ok 为 false。 */
  listAssetInventory(request?: { offset?: number; limit?: number; unreferencedOnly?: boolean }): Promise<
    { ok: true; inventory: import('../types').AssetInventoryPage } | { ok: false; message: string }
  >;
  /** 只改托管资产的显示名，不改文件内容。 */
  renameAssetNames(request: { changes: Array<{ id: string; name: string }> }): Promise<
    { ok: true; renamed: string[]; missing: string[] } | { ok: false; message: string }
  >;
  /** 清理未被工程、进行中导入和 protectIds 引用的资产记录。 */
  reclaimUnreferencedAssets(request: { assetIds: string[]; protectIds?: string[] }): Promise<
    { ok: true; result: import('../types').AssetReclaimResult } | { ok: false; message: string }
  >;
  setMcpEnabled(enabled: boolean): Promise<{ ok: true; enabled: boolean; url: string } | { ok: false; message: string }>;
  getMcpStatus(): Promise<{ ok: true; url: string; credentials: { id: string; name: string; mode: string; createdAt: number }[] } | { ok: false; message: string }>;
  createMcpCredential(request: { name: string; mode: 'read-only' | 'full-access' }): Promise<
    { ok: true; id: string; name: string; mode: string; token: string } | { ok: false; message: string }
  >;
  revokeMcpCredential(id: string): Promise<{ ok: true } | { ok: false; message: string }>;
  revealMcpCredential(id: string): Promise<{ ok: true; url: string; token: string; name: string; mode: string } | { ok: false; message: string }>;
  publishMcpCatalog(catalog: { name: string; commandId: string; title: string; description?: string; impact: 'read' | 'write'; destructive: boolean }[]): Promise<{ ok: true; count: number } | { ok: false; message: string }>;
  subscribeMcpDispatch(handler: (request: { id: string; commandId: string }) => Promise<unknown> | unknown): () => void;
  /** 选择一个插件目录，复制到用户插件文件夹。声明式清单或沙箱脚本都可以。 */
  installExternalPlugin(): Promise<{ ok: boolean; id?: string; mode?: string; message?: string }>;
  uninstallExternalPlugin(id: string): Promise<{ ok: boolean; message?: string }>;
  /** 从给定路径（文件夹或 .zip 压缩包）安装第三方插件，供画布拖拽/外部来源复用。 */
  installExternalPluginFromPath(sourcePath: string): Promise<{ ok: boolean; id?: string; mode?: string; message?: string }>;
  listExternalPlugins(): Promise<{ ok: true; plugins: Array<{ id: string; name: string; mode: 'declarative' | 'sandboxed'; description?: string; permissions?: string[] }> } | { ok: false; message: string }>;
}

export interface HostPlatformBridge {
  confirm?(message: string): boolean;
  openPluginDir?(relPath: string): Promise<string | null>;
  setAlwaysOnTop?(enabled: boolean): Promise<boolean | string>;
  setWindowOpacity?(opacity: number): Promise<number | string>;
  setIgnoreMouseEvents?(ignore: boolean): Promise<boolean | string>;
  isFramelessWindow?: boolean;
  windowControl?(action: WindowChromeAction): Promise<WindowChromeResult>;
  windowMove?(request: WindowMoveRequest): Promise<WindowMoveResult>;
  getWindowState?(): Promise<WindowChromeResult>;
  onWindowStateChanged?(callback: (state: WindowChromeState) => void): () => void;
  restartApp?(): Promise<AppRestartResult>;
  saveBytes?(request: { title?: string; defaultName: string; bytes: ArrayBuffer }): Promise<{ ok: boolean; path?: string; message?: string }>;
  importAsset?(request: { asset: unknown; bytes: ArrayBuffer; originalName?: string }): Promise<unknown>;
  loadProject?(): Promise<unknown>;
  saveProject?(document: unknown): Promise<void>;
  chooseProject?(): Promise<{ projectName: string } | null>;
  openArtflow?(): Promise<{ ok: boolean; name?: string; bytes?: ArrayBuffer; message?: string }>;
  copyFileToClipboard?(request: { name: string; bytes: ArrayBuffer }): Promise<{ ok: boolean; path?: string; message?: string }>;
  fetchBytes?(url: string): Promise<{ ok: boolean; bytes?: ArrayBuffer; mimeType?: string; message?: string }>;
  listAssetInventory?(request?: { offset?: number; limit?: number; unreferencedOnly?: boolean }): Promise<import('../types').AssetInventoryPage>;
  reclaimUnreferencedAssets?(request: { assetIds: string[]; protectIds?: string[] }): Promise<import('../types').AssetReclaimResult>;
  renameAssetNames?(request: { changes: Array<{ id: string; name: string }> }): Promise<{ renamed: string[]; missing: string[] }>;
  setMcpEnabled?(enabled: boolean): Promise<{ enabled: boolean; url: string }>;
  getMcpStatus?(): Promise<{ url: string; credentials: { id: string; name: string; mode: string; createdAt: number }[] }>;
  createMcpCredential?(request: { name: string; mode: 'read-only' | 'full-access' }): Promise<{ id: string; name: string; mode: string; token: string }>;
  revokeMcpCredential?(id: string): Promise<unknown>;
  revealMcpCredential?(id: string): Promise<{ url: string; token: string; name: string; mode: string }>;
  publishMcpCatalog?(catalog: unknown[]): Promise<{ count: number }>;
  onDispatch?(handler: (request: { id: string; commandId: string }) => Promise<unknown> | unknown): () => void;
  installExternalPlugin?(): Promise<{ ok: boolean; id?: string; mode?: string; message?: string }>;
  uninstallExternalPlugin?(id: string): Promise<{ ok: boolean; message?: string }>;
  installExternalPluginFromPath?(sourcePath: string): Promise<{ ok: boolean; id?: string; mode?: string; message?: string }>;
  listInstalledPlugins?(): Promise<{ plugins: Array<{ id: string; name: string; mode: 'declarative' | 'sandboxed'; description?: string; permissions?: string[] }> }>;
}

const REJECTED = 'rejected: host bridge unavailable' as const;

export const createHostPlatformService = (bridge: HostPlatformBridge | undefined): HostPlatformService => ({
  confirm: message => bridge?.confirm?.(message) ?? false,
  canOpenDirs: typeof bridge?.openPluginDir === 'function',
  openPluginDir: relPath => {
    if (!bridge?.openPluginDir) return Promise.resolve(REJECTED);
    return bridge.openPluginDir(relPath);
  },
  canWindowControls: typeof bridge?.setAlwaysOnTop === 'function',
  isFramelessWindow: bridge?.isFramelessWindow === true && typeof bridge?.windowControl === 'function',
  windowControl: action => bridge?.windowControl?.(action) ?? Promise.resolve({ ok: false, message: REJECTED }),
  windowMove: request => bridge?.windowMove?.(request) ?? Promise.resolve({ ok: false, message: REJECTED }),
  getWindowState: () => bridge?.getWindowState?.() ?? Promise.resolve({ ok: false, message: REJECTED }),
  subscribeWindowState: callback => bridge?.onWindowStateChanged?.(callback) ?? (() => {}),
  canRestartApp: typeof bridge?.restartApp === 'function',
  restartApp: () => bridge?.restartApp?.() ?? Promise.resolve({ ok: false, message: REJECTED }),
  setAlwaysOnTop: enabled => {
    if (!bridge?.setAlwaysOnTop) return Promise.resolve(REJECTED);
    return bridge.setAlwaysOnTop(enabled);
  },
  setWindowOpacity: opacity => {
    if (!bridge?.setWindowOpacity) return Promise.resolve(REJECTED);
    return bridge.setWindowOpacity(opacity);
  },
  setIgnoreMouseEvents: ignore => {
    if (!bridge?.setIgnoreMouseEvents) return Promise.resolve(REJECTED);
    return bridge.setIgnoreMouseEvents(ignore);
  },
  saveBytes: request => {
    if (!bridge?.saveBytes) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.saveBytes(request);
  },
  importAsset: request => {
    if (!bridge?.importAsset) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.importAsset(request);
  },
  loadProject: () => {
    if (!bridge?.loadProject) return Promise.resolve(null);
    return bridge.loadProject();
  },
  saveProject: document => {
    if (!bridge?.saveProject) return Promise.resolve(false);
    return bridge.saveProject(document).then(() => true, () => false);
  },
  chooseProject: () => {
    if (!bridge?.chooseProject) return Promise.resolve(null);
    return bridge.chooseProject();
  },
  openArtflow: () => {
    if (!bridge?.openArtflow) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.openArtflow();
  },
  copyFileToClipboard: request => {
    if (!bridge?.copyFileToClipboard) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.copyFileToClipboard(request);
  },
  listAssetInventory: request => {
    if (!bridge?.listAssetInventory) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.listAssetInventory(request).then(
      inventory => ({ ok: true as const, inventory }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: inventory failed' }),
    );
  },
  reclaimUnreferencedAssets: request => {
    if (!bridge?.reclaimUnreferencedAssets) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.reclaimUnreferencedAssets(request).then(
      result => ({ ok: true as const, result }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: reclaim failed' }),
    );
  },
  renameAssetNames: request => {
    if (!bridge?.renameAssetNames) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.renameAssetNames(request).then(
      result => ({ ok: true as const, renamed: result.renamed, missing: result.missing }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: rename failed' }),
    );
  },
  setMcpEnabled: enabled => {
    if (!bridge?.setMcpEnabled) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.setMcpEnabled(enabled).then(
      status => ({ ok: true as const, ...status }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: mcp state failed' }),
    );
  },
  getMcpStatus: () => {
    if (!bridge?.getMcpStatus) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.getMcpStatus().then(
      status => ({ ok: true as const, ...status }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: mcp status failed' }),
    );
  },
  createMcpCredential: request => {
    if (!bridge?.createMcpCredential) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.createMcpCredential(request).then(
      created => ({ ok: true as const, ...created }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: mcp credential failed' }),
    );
  },
  revokeMcpCredential: id => {
    if (!bridge?.revokeMcpCredential) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.revokeMcpCredential(id).then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: mcp revoke failed' }),
    );
  },
  revealMcpCredential: id => {
    if (!bridge?.revealMcpCredential) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.revealMcpCredential(id).then(
      revealed => ({ ok: true as const, ...revealed }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: mcp reveal failed' }),
    );
  },
  publishMcpCatalog: catalog => {
    if (!bridge?.publishMcpCatalog) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.publishMcpCatalog(catalog).then(
      published => ({ ok: true as const, count: published.count }),
      error => ({ ok: false as const, message: (error as Error)?.message || 'rejected: mcp catalog failed' }),
    );
  },
  subscribeMcpDispatch: handler => bridge?.onDispatch?.(handler) ?? (() => {}),
  installExternalPlugin: () => {
    if (!bridge?.installExternalPlugin) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.installExternalPlugin();
  },
  uninstallExternalPlugin: id => {
    if (!bridge?.uninstallExternalPlugin) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.uninstallExternalPlugin(id);
  },
  installExternalPluginFromPath: sourcePath => {
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      return Promise.resolve({ ok: false, message: 'rejected: empty source path' });
    }
    if (!bridge?.installExternalPluginFromPath) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.installExternalPluginFromPath(sourcePath);
  },
  listExternalPlugins: () => {
    if (!bridge?.listInstalledPlugins) return Promise.resolve({ ok: false, message: REJECTED });
    return bridge.listInstalledPlugins().then(
      listed => ({ ok: true as const, plugins: listed.plugins }),
      error => ({ ok: false as const, message: (error as Error)?.message || REJECTED }),
    );
  },
  fetchBytes: url => {
    if (typeof url !== 'string' || url.length === 0) return Promise.resolve({ ok: false, message: 'rejected: empty url' });
    return (async (): Promise<{ ok: boolean; bytes?: ArrayBuffer; mimeType?: string; message?: string }> => {
      try {
        const response = await fetch(url);
        if (!response.ok) return { ok: false, message: `rejected: http ${response.status}` };
        const bytes = await response.arrayBuffer();
        return { ok: true, bytes, mimeType: response.headers.get('content-type') ?? undefined };
      } catch (error) {
        return { ok: false, message: `rejected: ${(error as Error)?.message ?? 'fetch failed'}` };
      }
    })();
  },
});
