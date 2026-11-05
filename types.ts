
export type Tool = 'select' | 'pan' | 'draw' | 'erase' | 'rectangle' | 'circle' | 'triangle' | 'text' | 'arrow' | 'highlighter' | 'lasso' | 'line' | 'frame';

export type WheelAction = 'zoom' | 'pan';

export type GenerationMode = 'image' | 'video';

export type ImageAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

export interface Point {
  x: number;
  y: number;
}

interface CanvasElementBase {
  id: string;
  x: number;
  y: number;
  name?: string;
  isVisible?: boolean;
  isLocked?: boolean;
  parentId?: string;
  /** Persisted Project Document v2 associates media locators with this id; renderer compatibility fields remain during Phase 1b. */
  assetId?: string;
  /** R24 bounded, canonical labels persisted as ordinary Element metadata. */
  tags?: string[];
}

export interface ImageElement extends CanvasElementBase {
  type: 'image';
  href: string; // The display version (compressed/resized)
  thumbnailHref?: string; // 256px thumbnail proxy for far zoom (< 0.25)
  mediumHref?: string; // 512px medium proxy for dense multi-tile views (texture budget)
  originalHref?: string; // The full resolution version (if available)
  originalPixelWidth?: number; // Source pixels, independent of canvas resizing.
  originalPixelHeight?: number;
  width: number;
  height: number;
  mimeType: string;
  /** Managed-store byte size echo; keeps asset locator byteSize lossless across save/load. */
  fileSize?: number;
  opacity?: number;
  rotation?: number; // degrees
  borderRadius?: number;
}

export interface VideoElement extends CanvasElementBase {
  type: 'video';
  href: string; // Blob URL
  width: number;
  height: number;
  mimeType: string;
  /** Managed-store byte size echo; keeps asset locator byteSize lossless across save/load. */
  fileSize?: number;
  rotation?: number; // degrees
}

export interface AudioElement extends CanvasElementBase {
  type: 'audio';
  href: string; // Blob or Data URL
  width: number;
  height: number;
  mimeType: string;
  /** Managed-store byte size echo; keeps asset locator byteSize lossless across save/load. */
  fileSize?: number;
  duration?: number;
  rotation?: number; // degrees
}

export interface PathElement extends CanvasElementBase {
  type: 'path';
  points: Point[];
  strokeColor: string;
  strokeWidth: number;
  opacity?: number;
  rotation?: number; // degrees
}

export interface ShapeElement extends CanvasElementBase {
    type: 'shape';
    shapeType: 'rectangle' | 'circle' | 'triangle';
    width: number;
    height: number;
    strokeColor: string;
    strokeWidth: number;
    fillColor: string;
    strokeDashArray?: [number, number];
    opacity?: number;
    rotation?: number; // degrees
    borderRadius?: number;
}

export interface TextElement extends CanvasElementBase {
    type: 'text';
    text: string;
    fontSize: number;
    fontColor: string;
    width: number;
    height: number;
    rotation?: number; // degrees
}

export interface ArrowElement extends CanvasElementBase {
    type: 'arrow';
    points: [Point, Point];
    strokeColor: string;
    strokeWidth: number;
    rotation?: number; // degrees
}

export interface LineElement extends CanvasElementBase {
    type: 'line';
    points: [Point, Point];
    strokeColor: string;
    strokeWidth: number;
    rotation?: number; // degrees
}

export interface GroupElement extends CanvasElementBase {
    type: 'group';
    width: number;
    height: number;
    rotation?: number; // degrees
}

export interface MarkdownElement extends CanvasElementBase {
  type: 'markdown';
  name?: string;
  content: string;
  width: number;
  height: number;
  rotation?: number; // degrees
  fontSize?: number;
}

export interface CodeElement extends CanvasElementBase {
  type: 'code';
  name?: string;
  code: string;
  language: string;
  width: number;
  height: number;
  rotation?: number; // degrees
  fontSize?: number;
}

/** Plugin-produced, project-persisted plain reader data. UI/parser behavior remains plugin-owned. */
export interface ReaderElement extends CanvasElementBase {
  type: 'reader';
  name: string;
  content: string;
  sourceFormat: 'text' | 'html' | 'epub' | 'mobi' | 'azw' | 'azw3';
  characterCount: number;
  isTruncated: boolean;
  /** Chapter titles and their UTF-16 offsets in `content`. */
  chapters?: readonly { title: string; start: number }[];
  /** 0–4, matching the reader card's font steps. */
  fontIndex?: number;
  /** 0–1 position inside the reader scroller. */
  readingScroll?: number;
  width: number;
  height: number;
  rotation?: number; // degrees
}

/** Plugin-produced, project-persisted comic page data. Archive/parser/UI behavior remains plugin-owned. */
export interface ComicElement extends CanvasElementBase {
  type: 'comic';
  name: string;
  /** 旧版：全量页 data URL（存量工程兼容保留）；新导入一律走 archiveRef 懒加载。 */
  pages?: string[];
  /** 主进程档案仓引用（内容寻址 sha256），页图按需解压。 */
  archiveRef?: string;
  /** 档案内自然排序的页文件名清单（与 archiveRef 成对出现）。 */
  pageNames?: string[];
  sourceFormat: 'cbz' | 'cbr' | 'cb7' | '7z';
  width: number;
  height: number;
  rotation?: number; // degrees
}

export interface BookmarkElement extends CanvasElementBase {
  type: 'bookmark';
  url: string;
  title: string;
  description?: string;
  favicon?: string;
  domain: string;
  width: number;
  height: number;
  rotation?: number; // degrees
}

export interface FontElement extends CanvasElementBase {
  type: 'font';
  name: string;
  fontFamily: string;
  fontUrl: string;
  format: string; // ttf, otf, woff, woff2
  sampleText?: string;
  fileSize?: number;
  width: number;
  height: number;
  rotation?: number; // degrees
}

export interface Model3DElement extends CanvasElementBase {
  type: 'model3d';
  name: string;
  fileUrl: string;
  fileExtension: string;
  fileSize?: number;
  width: number;
  height: number;
  rotation?: number; // degrees
  autoRotate?: boolean;
  wireframe?: boolean;
  theme?: 'dark' | 'light' | 'transparent' | 'studio';
}

export type FileCardCategory = 'archive' | '3d' | 'design' | 'doc' | 'executable' | 'data' | 'general';

export interface FileElement extends CanvasElementBase {
  type: 'file';
  name: string;
  fileUrl: string;
  fileSize: number;
  fileExtension: string;
  category: FileCardCategory;
  mimeType?: string;
  width: number;
  height: number;
  rotation?: number; // degrees
}

/** Rectangular card whose schema is owned by a plugin, not by a closed element variant. */
export interface PluginNodeElement extends CanvasElementBase {
  type: 'plugin-node';
  name: string;
  /** canvas_node_types registration key used to pick the card component. */
  nodeType: string;
  data: Record<string, unknown>;
  width: number;
  height: number;
  rotation?: number;
}

export interface FrameElement extends CanvasElementBase {
  type: 'frame';
  name: string;
  width: number;
  height: number;
  backgroundColor?: string;
}


export type Element = 
  | ImageElement 
  | PathElement 
  | ShapeElement 
  | TextElement 
  | ArrowElement 
  | LineElement 
  | GroupElement 
  | VideoElement 
  | AudioElement 
  | MarkdownElement 
  | CodeElement 
  | ReaderElement
  | ComicElement
  | BookmarkElement 
  | FontElement 
  | Model3DElement
  | FileElement 
  | PluginNodeElement
  | FrameElement;

export interface UserEffect {
  id: string;
  name: string;
  value: string;
}

export interface Hotkey {
  key: string;
  metaOrCtrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface PresentationHotkeys {
  nextSmooth: Hotkey;
  prevSmooth: Hotkey;
  nextDirect: Hotkey;
  prevDirect: Hotkey;
}

/** 一条可逆的 Element delta；只保存变更元素与前后 id 顺序，不复制整块画布。 */
export interface CanvasElementChange {
  id: string;
  before?: Element;
  after?: Element;
}

export interface CanvasOperation {
  id: string;
  createdAt: number;
  /** 仅发生新增、删除或重排时记录；普通属性修改不复制全量 id 顺序。 */
  beforeOrder?: string[];
  afterOrder?: string[];
  changes: CanvasElementChange[];
}

export type AssetKind = 'image' | 'video' | 'audio' | 'font' | 'model3d' | 'file';
export type AssetSourceKind = 'legacy-inline' | 'runtime-url' | 'external-reference' | 'managed-store';

/** Asset locator: legacy data/blob/external values or a managed-store `artflow-asset://sha256/<hash>` reference. */
export interface AssetLocator {
  previewRef?: string;
  thumbnailRef?: string;
  mediumRef?: string;
  originalRef?: string;
  fileRef?: string;
  mimeType?: string;
  extension?: string;
  byteSize?: number;
  format?: string;
}

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  sourceKind: AssetSourceKind;
  locator: AssetLocator;
  metadata: Record<string, unknown>;
}

/** Persisted layout record. `properties` intentionally excludes asset locator payload. */
export interface BoardNodeRecord {
  id: string;
  boardId: string;
  assetId?: string;
  nodeType: Element['type'];
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  zIndex: number;
  parentId?: string;
  properties: Record<string, unknown>;
}

export interface BoardNodeChange {
  id: string;
  before?: BoardNodeRecord;
  after?: BoardNodeRecord;
}

export interface NodeOperation {
  id: string;
  createdAt: number;
  beforeOrder?: string[];
  afterOrder?: string[];
  changes: BoardNodeChange[];
}

/** A bounded board-local camera location; it is metadata, not an Element or a saved scene snapshot. */
export interface CanvasViewBookmark {
  id: string;
  name: string;
  panOffset: Point;
  zoom: number;
}

export interface ProjectBoardRecord {
  id: string;
  name: string;
  panOffset: Point;
  zoom: number;
  canvasBackgroundColor: string;
  /** Optional for v2 compatibility with projects saved before R21. */
  viewBookmarks?: CanvasViewBookmark[];
  operationHistory: NodeOperation[];
  operationHistoryIndex: number;
}

export interface ProjectDocumentV2 {
  format: 'artflow-project';
  version: 2;
  assets: AssetRecord[];
  boards: ProjectBoardRecord[];
  nodes: BoardNodeRecord[];
}

export interface ProjectStorageStatus {
  isOpen: boolean;
  projectName: string | null;
}

/** Saved-snapshot viewport geometry; it never represents unsaved renderer state. */
export interface PersistentViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keyset continuation is valid only for its exact saved snapshot, board and canonical rect. */
export interface PersistentViewportCursor {
  snapshotRevision: number;
  boardId: string;
  rect: PersistentViewportRect;
  after: { zIndex: number; id: string };
}

export interface PersistentViewportQuery {
  boardId: string;
  rect: PersistentViewportRect;
  limit?: number;
  cursor?: PersistentViewportCursor;
}

export interface PersistentViewportNode {
  id: string;
  boardId: string;
  nodeType: Element['type'];
  parentId?: string;
  zIndex: number;
  bounds: PersistentViewportRect;
}

export interface PersistentViewportPage {
  nodes: PersistentViewportNode[];
  truncated: boolean;
  snapshotRevision: number;
  nextCursor: PersistentViewportCursor | null;
}

export interface ManagedAssetImportResult {
  asset: AssetRecord;
  contentHash: string;
  byteSize: number;
  blobCreated: boolean;
}

/** Durable raw-byte staging job; staging path/hash never cross the preload boundary. */
export type ManagedImportJobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface ManagedImportJob {
  id: string;
  assetId: string;
  /** Presentation-safe basename supplied by the narrow import-job bridge; never a native path. */
  displayName?: string;
  status: ManagedImportJobStatus;
  progress: number;
  errorCode: string | null;
  result: Omit<ManagedAssetImportResult, 'blobCreated'> | null;
  createdAt?: number;
  updatedAt?: number;
}

export type PreviewJobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface PreviewDerivativeRecord {
  assetId: string;
  recipe: string;
  contentHash: string;
  mimeType: string;
  byteSize: number;
  blobCreated?: boolean;
}

export interface PreviewDerivativeJob {
  id: string;
  assetId: string;
  recipe: string;
  status: PreviewJobStatus;
  progress: number;
  errorCode: string | null;
  derivative: PreviewDerivativeRecord | null;
}

export interface AssetInventoryItem {
  id: string;
  kind: string;
  byteSize: number;
  mimeType: string;
  originalName: string;
  hashPrefix: string;
  updatedAt: number;
  usage: 'document' | 'import' | 'none';
}

export interface AssetInventoryPage {
  totalAssets: number;
  uniqueBlobs: number;
  uniqueBytes: number;
  unreferencedAssets: number;
  items: AssetInventoryItem[];
}

export interface AssetReclaimResult {
  removed: string[];
  kept: string[];
  missing: string[];
  freedBytes: number;
}

/** Narrow Electron preload capability; no path, filesystem, IPC channel or Node API is exposed. */
export interface ArtflowStorageApi {
  chooseProject(): Promise<ProjectStorageStatus | null>;
  getStatus(): Promise<ProjectStorageStatus>;
  /** 打开插件源码目录（相对应用根，如 "builtin/cards"）；主进程校验越界后 shell.openPath。返回 null=成功，否则为拒绝原因。 */
  openPluginDir(relPath: string): Promise<string | null>;
  importAsset(request: { asset: AssetRecord; bytes: ArrayBuffer; originalName?: string }): Promise<ManagedAssetImportResult>;
  requestImport(request: { asset: AssetRecord; bytes: ArrayBuffer; originalName?: string }): Promise<ManagedImportJob>;
  getImportJob(jobId: string): Promise<ManagedImportJob | null>;
  /** Bounded safe summaries only; no draft, staging, filesystem or database details. */
  listImportJobs(): Promise<ManagedImportJob[]>;
  cancelImportJob(jobId: string): Promise<ManagedImportJob>;
  saveProject(document: ProjectDocumentV2): Promise<void>;
  loadProject(): Promise<ProjectDocumentV2 | null>;
  queryViewport(request: PersistentViewportQuery): Promise<PersistentViewportPage>;
  /** 资产库清单。不含路径、完整哈希或文件字节。 */
  listAssetInventory(request?: { offset?: number; limit?: number; unreferencedOnly?: boolean }): Promise<AssetInventoryPage>;
  /** 只删除未被已保存工程、进行中导入和 protectIds 引用的记录。 */
  reclaimUnreferencedAssets(request: { assetIds: string[]; protectIds?: string[] }): Promise<AssetReclaimResult>;
  requestPreview(assetId: string): Promise<PreviewDerivativeJob>;
  getPreviewJob(jobId: string): Promise<PreviewDerivativeJob | null>;
  cancelPreviewJob(jobId: string): Promise<PreviewDerivativeJob>;
  /** 最近工程（`config/recent-files.json`）。路径由主进程持有并直接用于打开。 */
  listRecentProjects(): Promise<{ ok: boolean; projects: RecentProjectEntry[] }>;
  /** 直接按路径打开（不弹目录对话框）。失败会 reject（目录被删/无权限）。 */
  openRecentProject(projectRoot: string): Promise<ProjectStorageStatus | null>;
  clearRecentProjects(): Promise<ConfigWriteResult>;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  openedAt: string | null;
  /** 目录已不存在（被删或改名）—— 界面据此灰掉该条目。 */
  missing: boolean;
}

/**
 * 用户级配置卷的快照（主进程 config/preferences.json 或 config/secrets.json）。
 * 这是 `main/configStore.cjs` 的渲染层契约，**不是** Storage 的子集：
 * 故意的差异是 `degraded + message` —— 任何回退（文件损坏→备份 / 只读载入）都必须可见，
 * 而不是静默给一份"默认值"（那正是"关掉的插件重启又自己开了"的成因）。
 */
export interface ConfigSnapshot {
  ok: boolean;
  values: Record<string, unknown>;
  /** `safe-mode` = 安全模式刻意忽略用户配置（一切正常，只是没读），与 `unreadable` 语义相反。 */
  source: 'file' | 'backup' | 'none' | 'unreadable' | 'safe-mode';
  schemaVersion: number;
  degraded: boolean;
  message?: string;
  /** 本次读取时执行了从哪个旧版本到当前版本的迁移。 */
  migratedFrom?: number;
}

export interface ConfigWriteResult {
  ok: boolean;
  count?: number;
  bytes?: number;
  message?: string;
}

export interface ConfigStoreStats {
  filePath: string;
  exists: boolean;
  bytes: number;
  keyCount: number;
  schemaVersion: number;
  source: 'file' | 'backup' | 'none' | 'unreadable';
  degraded: boolean;
  updatedAt: string | null;
  /** 本次会话是否处于安全模式（`statistics` 报的是磁盘真相，与本次是否消费无关）。 */
  safeMode?: boolean;
  /** 该卷是否启用了值级加密（secrets 卷接 OS 钥匙串时才为 true）。 */
  encrypted?: boolean;
}

/** 设置预设（`config/presets/<name>.json`）的清单条目。 */
export interface PresetSummary {
  name: string;
  bytes: number;
  updatedAt: string;
  /** 该预设收录了哪些卷 —— 面板上要标出来，免得用户以为"导出预设=备份全部"。 */
  volumes: string[];
  exportedAt: string | null;
}

/** 预设操作回执（导出/导入/删除共用）。 */
export interface PresetResult {
  ok: boolean;
  message?: string;
  filePath?: string;
  bytes?: number;
  canceled?: boolean;
  /** 导入时逐卷的写入结果。 */
  applied?: Record<string, { ok: boolean; count: number; message?: string }>;
}

/** 存储管理面板的数据源。 */
export interface StorageOverview {
  ok: boolean;
  configRoot: string;
  volumes: Record<string, ConfigStoreStats & { inPreset?: boolean }>;
  cache: { path: string; bytes: number; exists: boolean };
  presets: PresetSummary[];
  presetsDir: string;
  secret: { encrypted: boolean; scheme: string; prefix: string };
  safeMode: boolean;
}

/** 主进程代发的外部 AI 工具通道（ComfyUI）。
 * 形态是固定 op 白名单，不是 (method, url) 转发 —— 该通道不得演变成通用 HTTP 桥。
 */
export type ComfyProxyRequest =
  | { op: 'stats' }
  | { op: 'objectInfo' }
  | { op: 'submit'; workflow: Record<string, unknown>; clientId?: string }
  | { op: 'history'; promptId: string }
  | { op: 'view'; filename: string; subfolder?: string; type?: 'input' | 'output' | 'temp' }
  | { op: 'interrupt' };

export type ComfyProxyResponse =
  | { ok: true; status: number; data: unknown }
  | { ok: true; status: number; contentType: string; bytes: ArrayBuffer }
  | { ok: false; status?: number; message: string };

declare global {
  interface Window {
    artflowStorage?: ArtflowStorageApi;
    /** 漫画档案仓桥（preload 暴露）：档案字节只进主进程，渲染层拿页清单与按需解压的单页字节。 */
    artflowComic?: {
      /** 上传档案字节 → 主进程内容寻址落盘 + 解析页清单（失败返回 ok:false，不抛异常）。 */
      importArchive(request: { bytes: Uint8Array; name: string }): Promise<{
        ok: true; ref: string; pageNames: string[]; pageCount: number; byteSize: number; originalName: string;
      } | { ok: false; message: string }>;
      /** 按页拉取（主进程 LRU 缓存）；bytes 是独立 ArrayBuffer。 */
      getPage(request: { ref: string; index: number }): Promise<
        { ok: true; bytes: ArrayBuffer; mimeType: string } | { ok: false; message: string }
      >;
    };
    /**
     * 插件偏好（启用/关闭 + config patch）的宿主侧存储桥（preload 暴露）。
     * 状态落在 userData/plugin-profile.json，与 dev server 的 origin 解耦 ——
     * 这样 dev / 打包 / 多实例共用同一份，不会"换个启动方式插件开关就整套作废"。
     * `readSync` 必须同步：顶层 index.tsx 在模块求值阶段就要拿到 profile。
     */
    artflowPluginState?: {
      readSync(): {
        ok: boolean;
        patches: unknown[] | null;
        source: 'file' | 'backup' | 'none' | 'unreadable';
        schemaVersion?: number;
        message?: string;
      };
      /** 同步写：与持久化层的同步契约对齐，失败会直接返回 ok:false（不静默丢）。 */
      writeSync(patches: unknown[]): { ok: boolean; count?: number; message?: string };
      clearSync(): { ok: boolean; message?: string };
      /** 同步读 editable 插件 manifest（顶层 profile 解析用；不含源码）。 */
      readEditableManifestsSync(): { manifests: unknown[] };
      reportBoot(payload: {
        source?: string;
        enabled?: string[];
        disabled?: string[];
        rejected?: string[];
        warning?: string | null;
      }): void;
    };
    /**
     * 用户级配置（偏好 / 密钥）的宿主侧存储桥（preload 暴露）。
     * 状态落在 userData/config/{preferences,secrets}.json，与 dev server 的 origin 解耦 ——
     * dev / 打包 / 多实例共用同一份，不会"换个启动方式整套用户数据作废"。
     * 全部走同步 `sendSync`：语言等值在**模块求值期**就要读到（见 utils/language-store），
     * 消费方是同步契约。形参只接受固定 op 白名单，不接受路径或任意文件名。
     */
    artflowConfig?: {
      readPreferences(): ConfigSnapshot;
      readSecrets(): ConfigSnapshot;
      setPreference(key: string, value: unknown): ConfigWriteResult;
      patchPreferences(values: Record<string, unknown>): ConfigWriteResult;
      /** 只删这些键（回到默认值）。 */
      resetPreferences(keys: string[]): ConfigWriteResult;
      /** 清空整个偏好卷（设置页「恢复默认」）。 */
      clearPreferences(): ConfigWriteResult;
      setSecret(key: string, value: unknown): ConfigWriteResult;
      removeSecret(key: string): ConfigWriteResult;
      /** 通用多卷面（workspace / recent-files 等新卷走这里）。卷名白名单由主进程把关。 */
      readStore?(name: string): ConfigSnapshot;
      setStoreValue?(name: string, key: string, value: unknown): ConfigWriteResult;
      patchStore?(name: string, values: Record<string, unknown>): ConfigWriteResult;
      resetStore?(name: string, keys: string[]): ConfigWriteResult;
      clearStore?(name: string): ConfigWriteResult;
      stats(store: string): ConfigStoreStats | null;
      /** —— 设置预设（导出/导入/列出/删除；均为异步，用户点击触发）—— */
      listPresets?(): Promise<{ ok: boolean; presets: PresetSummary[] }>;
      savePreset?(name: string): Promise<PresetResult>;
      loadPreset?(name: string): Promise<PresetResult>;
      removePreset?(name: string): Promise<PresetResult>;
      exportPresetToFile?(): Promise<PresetResult>;
      importPresetFromFile?(): Promise<PresetResult>;
      /** —— 存储管理 —— */
      storageOverview?(): Promise<StorageOverview>;
      clearCache?(): Promise<{ ok: boolean; path?: string; message?: string }>;
      reportBoot(payload: {
        source?: string;
        degraded?: boolean;
        keyCount?: number;
        adoptedLegacyKeys?: string[];
        message?: string | null;
        /** 本次会话是否处于安全模式（`ARTFLOW_SAFE_MODE=1`）。 */
        safeMode?: boolean;
      }): void;
      /** 启动期错误上报（index.html 内联钩子最先调用）→ 主进程 logs/electron.log。 */
      reportBootError?(line: string): void;
    };
    /** Electron 窗口级能力桥（preload 暴露；插件须经 host.platform 服务消费，禁直连）。 */
    artflowApp?: {
      setAlwaysOnTop(enabled: boolean): Promise<boolean | string>;
      setWindowOpacity(opacity: number): Promise<number | string>;
      setWindowBackground(color: string): Promise<string>;
      setIgnoreMouseEvents(ignore: boolean): Promise<boolean | string>;
      /** Only Windows uses the custom, frameless controls; other platforms retain native chrome. */
      isFramelessWindow: boolean;
      windowControl(action: 'minimize' | 'toggle-maximize' | 'close'): Promise<{ ok: boolean; maximized?: boolean; message?: string }>;
      windowMove(request: { phase: 'start' | 'update'; screenX: number; screenY: number } | { phase: 'end' }): Promise<{ ok: boolean; message?: string }>;
      getWindowState(): Promise<{ ok: boolean; maximized?: boolean; minimized?: boolean; message?: string }>;
      onWindowStateChanged(callback: (state: { maximized: boolean }) => void): () => void;
      saveBytes(request: { title?: string; defaultName: string; bytes: ArrayBuffer }): Promise<{ ok: boolean; path?: string; message?: string }>;
      copyFileToClipboard(request: { name: string; bytes: ArrayBuffer }): Promise<{ ok: boolean; path?: string; message?: string }>;
      openArtflow(): Promise<{ ok: boolean; name?: string; bytes?: ArrayBuffer; message?: string }>;
      /** Resolve an HTTPS b23.tv short link through the restricted main-process redirect resolver. */
      resolveVideoShortUrl(url: string): Promise<string>;
      /** Open an HTTP(S) URL without credentials in the system browser. */
      openVideoLink(url: string): Promise<void>;
      /** 重启整个应用：主进程 relaunch 后本进程退出，回执丢失属正常（窗口已销毁）。 */
      restartApp(): Promise<{ ok: boolean; message?: string }>;
      /** 首帧就绪（单向）：宿主据此撤掉启动画面、淡入主窗口；无回执，重复上报是安全的。 */
      notifyRendererReady(): void;
      /**
       * 进程性能指标（perf-monitor HUD 消费；纯浏览器模式不存在）。
       * Electron 走 app.getAppMetrics() 白名单映射（type 词表含 'Tab'）；Tauri 走 Rust 原生采样
       * （type 词表含 'Renderer'）。`dedicatedGpuKB` 仅在宿主能取到专用显存时提供。
       */
      getPerfMetrics(): Promise<Array<{ type: string; name?: string; pid: number; cpuPercent: number; workingSetKB: number; peakWorkingSetKB: number; dedicatedGpuKB?: number }>>;
      /**
       * JSON-only manifests from the user plugin folder. Never includes executable entries.
       * `locales` 的表体已由主进程读好（内联或分片），渲染进程不碰文件系统。
       */
      listDeclarativePlugins(): Promise<{ plugins: Array<{ id: string; name: string; formatAliases: Array<{ extension: string; handlerId: string }>; locales?: Array<{ language: string; table: Record<string, unknown> }> }> }>;
      /**
       * 内置可编辑插件（editable channel）：id 保留 `builtin.`，代码以纯 JS 落在
       * userData/plugins/<id>/plugin.js。主进程只搬运源码文本，执行在渲染层（受信任）。
       */
      readEditablePlugins(): Promise<{ plugins: Array<{ id: string; name: string; version: string; description: string; manifest: Record<string, unknown>; source: string }> }>;
      listInstalledPlugins(): Promise<{ plugins: Array<{ id: string; name: string; mode: 'declarative' | 'sandboxed'; description?: string; permissions?: string[] }> }>;
      listSandboxedPlugins(): Promise<{ plugins: Array<{ id: string; name: string; error?: string; formats: Array<{ id: string; extensions: string[] }>; commands: Array<{ id: string; title: string; description?: string }>; assets?: Array<{ id: string; title: string; canSubmit: boolean }>; cards?: Array<{ nodeType: string }>; panels: Array<{ id: string; title: string; html?: string; schema?: { controls: Array<{ type: 'text' | 'textarea' | 'toggle' | 'number' | 'select' | 'button' | 'note'; key?: string; label?: string; text?: string; placeholder?: string; action?: string; options?: Array<{ value: string; label: string }>; min?: number; max?: number; step?: number; default?: string | number | boolean }>; content?: string } }>; settingsTabs?: Array<{ id: string; title: string; controls: Array<{ type: 'text' | 'password' | 'toggle' | 'number' | 'select' | 'button' | 'note'; key?: string; label?: string; text?: string; description?: string; options?: Array<{ value: string; label: string }>; min?: number; max?: number; step?: number; default?: string | number | boolean; commandId?: string }> }> }> }>;
      /** 插件 data.json 读写（渲染端设置表单用；主进程按插件 id 推导目录，不接受路径）。 */
      pluginDataLoad?(pluginId: string): Promise<{ ok: boolean; data?: unknown; message?: string }>;
      pluginDataSave?(request: { pluginId: string; data: unknown }): Promise<{ ok: boolean; bytes?: number; message?: string }>;
      installExternalPlugin(): Promise<{ ok: boolean; id?: string; mode?: string; message?: string }>;
      installExternalPluginFromPath(sourcePath: string): Promise<{ ok: boolean; id?: string; mode?: string; message?: string }>;
      /** 画布拖拽预检：落点是不是插件来源（.zip 含 manifest 或文件夹含 manifest）。 */
      isPluginSourcePath(sourcePath: string): Promise<boolean>;
      uninstallExternalPlugin(id: string): Promise<{ ok: boolean; message?: string }>;
      invokeSandboxedPlugin(message: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; message?: string }>;
      /**
       * 沙箱宿主渲染进程崩溃后主进程重建了宿主窗口 —— 渲染层此前注册的沙箱贡献
       * （面板 / 命令 / 格式处理器 / 卡片）全部指向旧窗口，必须重新激活一遍。
       * 返回退订函数；无回执，重复激活是安全的（主进程侧有并发去重）。
       */
      onSandboxHostRestarted?(callback: (payload: { reason: string }) => void): () => void;
      readPluginClients(): Promise<{ clients: Array<{ id: string; source: string; capabilities?: string[]; library?: boolean }> }>;
      /** unrestricted 插件数据仓：按内容寻址 ref 读回大字节（pluginId 由运行时绑定，见 external-runtime）。 */
      readStored(request: { pluginId: string; ref: string }): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; message: string }>;
      /** 插件漫画页：主进程 ZIP 引擎按 (pluginId, ref, index) 解压单页（与内置阅读器同引擎）。 */
      readPluginPage(request: { pluginId: string; ref: string; index: number }): Promise<
        { ok: true; bytes: ArrayBuffer; mimeType: string } | { ok: false; message: string }
      >;
      renameAssetNames(request: { changes: Array<{ id: string; name: string }> }): Promise<{ renamed: string[]; missing: string[] }>;
      /** 面板弹出为独立窗口（主进程创建 frameless BrowserWindow，hash 携带面板 id）。 */
      openPanelWindow(request: { panelId: string; width: number; height: number }): Promise<{ ok: boolean; message?: string }>;
      /** 独立面板窗口关闭后主进程广播；返回退订函数。 */
      onPanelWindowClosed(callback: (payload: { panelId: string }) => void): () => void;
    };
    /** 主进程代发的 ComfyUI 通道（preload 暴露；插件经 ai_providers / asset_sources 契约消费，不直连 window）。 */
    artflowAi?: {
      comfyRequest(request: ComfyProxyRequest): Promise<ComfyProxyResponse>;
    };
    artflowMcp?: {
      setEnabled(enabled: boolean): Promise<{ enabled: boolean; url: string }>;
      getStatus(): Promise<{ url: string; credentials: { id: string; name: string; mode: 'read-only' | 'full-access'; createdAt: number }[] }>;
      createCredential(request: { name: string; mode: 'read-only' | 'full-access' }): Promise<{ id: string; name: string; mode: string; token: string }>;
      revokeCredential(id: string): Promise<{ url: string; credentials: { id: string; name: string; mode: string; createdAt: number }[] }>;
      revealCredential(id: string): Promise<{ url: string; id: string; name: string; mode: string; token: string }>;
      publishCatalog(catalog: unknown[]): Promise<{ count: number }>;
      onDispatch(callback: (request: { id: string; commandId: string }) => Promise<unknown> | unknown): () => void;
    };
  }
}

export interface Board {
  id: string;
  name: string;
  elements: Element[];
  /** 新运行时历史：仅保存 Element delta，undo/redo 用 operationHistoryIndex 重放。 */
  operationHistory: CanvasOperation[];
  operationHistoryIndex: number;
  /** 只为读取旧 artflow-data.json 保留；迁移后不再写回。 */
  history?: Element[][];
  historyIndex?: number;
  panOffset: Point;
  zoom: number;
  /** New boards initialize this to []; legacy boards are normalized at document ingress. */
  viewBookmarks?: CanvasViewBookmark[];
  canvasBackgroundColor: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Guide {
  type: 'v' | 'h';
  position: number;
  start: number;
  end: number;
}

export interface AIRotationState {
  element: ImageElement;
  center: Point;
  currentAngle: number;
  dragDirection: 'h' | 'v' | null;
}
