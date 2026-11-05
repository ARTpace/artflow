/**
 * artflow 插件开发 SDK —— 沙箱通道（sandboxed）公开契约
 * =====================================================
 *
 * 这个文件是给「只安装了 artflow、不持有它源码」的第三方开发者用的。
 * 它把插件的全部可调用能力声明成类型，放进你的插件工程后，
 * 编辑器（VS Code / WebStorm）就能给出补全与报错提示。
 *
 * ## 怎么用
 *
 * 1. 建一个文件夹，里面放两个文件：`manifest.json` 和 `plugin.js`。
 * 2. 在你的工程里引用本文件（任选一种）：
 *    - tsconfig.json：`"include": ["artflow-plugin.d.ts", "src"]`
 *    - 或在插件源码顶部：`/// <reference path="./artflow-plugin.d.ts" />`
 * 3. 在 artflow 里执行「安装插件」，选中这个文件夹，重载后生效。
 *
 * ## 权威来源
 *
 * 运行时校验逻辑全部在 artflow 的 `sandbox/module-table.cjs` 里（208 行）。
 * 本文件是它的类型投影：**每一条注释里写的限制都会在装载时真实校验，
 * 违反即抛错并拒绝该插件**，不是建议。
 */

declare namespace Artflow {
  /* ─────────────────────────────  清单  ───────────────────────────── */

  /**
   * 插件清单，即 `manifest.json` 的内容。
   *
   * 最小可用形态：
   * ```json
   * {
   *   "id": "local.my-plugin",
   *   "name": "我的插件",
   *   "description": "一句话说明。",
   *   "runtime": { "mode": "sandboxed", "entry": "plugin.js" }
   * }
   * ```
   */
  interface Manifest {
    /**
     * 全局唯一标识。
     *
     * 沙箱通道**强制**以 `local.` 开头，且只允许小写字母、数字、`.` 与 `-`
     * （正则 `^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$`）。
     * 这个前缀就是「外部插件」与「内置插件」的分界线，也是你所有贡献 id 的前缀。
     */
    id: `local.${string}`;
    /** 显示名。 */
    name: string;
    /** 一句话说明，显示在插件管理器里。 */
    description?: string;
    /** 运行方式。沙箱插件固定为 `sandboxed`。 */
    runtime: {
      mode: 'sandboxed';
      /** 相对插件目录的入口文件，通常是 `plugin.js`。 */
      entry: string;
      /** 若提供 `client.js`，它会以 unrestricted 权限在画布进程内运行（安装时需用户授权）。 */
      client?: string;
    };
    /**
     * 数据权限声明。申请了会在安装时逐条展示给用户。
     *
     * | 键 | 含义 |
     * |---|---|
     * | `library` | `['rename']` = 允许改名资产 |
     * | `read` / `write` | 相对插件目录的文件路径（最多 8 条，不许 `..` 或绝对路径） |
     * | `network` | 允许访问的域名（最多 8 条，https 且不许 localhost / `.local`） |
     * | `host` | `host` 能力面权限，可选值见 `HostApi`：`assets.read` / `assets.write` / `events.subscribe` |
     *
     * 不在表内的键、或不认识的 `host` 权限，都会让**安装被拒绝**（拼错等于没授权，
     * 不如直接报错）。
     */
    permissions?: {
      library?: Array<'rename'>;
      read?: string[];
      write?: string[];
      network?: string[];
      host?: Array<'assets.read' | 'assets.write'>;
    };
    /**
     * 最低宿主 API 版本（语义版本，如 `1.0.0`）。
     *
     * 声明得比当前宿主新时，插件**不会被激活**，插件管理器里会显示
     * 「requires host API x.y.z, this build provides a.b.c」。用它来声明你依赖的
     * `host` 面方法 —— 比运行到一半才发现方法不存在容易排查得多。
     */
    minHostVersion?: string;
    /**
     * 依赖的其它插件 id（最多 8 条）。
     *
     * 目前只做**声明与展示**：沙箱通道不参与依赖冲突拦截，需要哪个插件一起装好
     * 由用户自行保证。留这个字段是为了让清单契约和内置插件对齐。
     */
    requires?: string[];
  }

  /* ──────────────────────────  格式解析返回的卡片  ────────────────────────── */

  interface CardBase {
    kind: 'card';
    /** 卡片显示名，1–180 字符。 */
    name: string;
    /** 1–4000，超出即拒绝。 */
    width: number;
    /** 1–4000，超出即拒绝。 */
    height: number;
  }

  interface MarkdownCard extends CardBase {
    cardType: 'markdown';
    /** 上限 120000 字符。 */
    fields: { content: string };
  }

  interface CodeCard extends CardBase {
    cardType: 'code';
    /** `code` 上限 120000 字符，`language` 上限 32 字符。 */
    fields: { code: string; language: string };
  }

  interface BookmarkCard extends CardBase {
    cardType: 'bookmark';
    /** `url` 必须是 http(s) 且 ≤2000；`title`/`domain` ≤180。 */
    fields: { url: string; title: string; domain: string };
  }

  /**
   * 自定义卡片：`cardType` 必须以你的插件 id 加 `.` 开头。
   * `fields` 必须能被 JSON 序列化，且整体 ≤100000 字符。
   */
  interface CustomCard extends CardBase {
    cardType: `${string}.${string}`;
    fields: Record<string, unknown>;
  }

  /** 沙箱格式解析只能返回卡片，不能直接改画布。 */
  type CardResult = MarkdownCard | CodeCard | BookmarkCard | CustomCard;

  /* ─────────────────────────────  插件可调用的能力面  ───────────────────────────── */

  /** 1. `formats` —— 注册按文件扩展名触发的解析器。 */
  interface FormatDefinition {
    /** 必须以 `${插件id}.` 开头，且 ≤80 字符。 */
    id: string;
    /** 1–8 个扩展名，每个匹配 `^[a-z0-9]{1,16}$`（不带点）。 */
    extensions: string[];
    /** 解析文件并返回一张卡片。抛错即视为解析失败。 */
    parse(file: File): CardResult | Promise<CardResult>;
  }

  /** 2. `commands` —— 注册命令面板里可执行的动作。 */
  interface CommandDefinition {
    /** 必须以 `${插件id}.` 开头，且 ≤80 字符。 */
    id: string;
    /** 命令标题，1–80 字符。 */
    title: string;
    /** 说明，超出 200 字符会被截断。 */
    description?: string;
    run(): void | Promise<void>;
  }

  /** 3. `panels` —— 在画布上挂一个面板（`plugin.js` 侧只能给 HTML 字符串）。 */
  interface PanelDefinition {
    /** 必须以 `${插件id}.` 开头，且 ≤80 字符。 */
    id: string;
    /** 面板标题，1–80 字符。 */
    title: string;
    /** 内联 HTML，≤8000 字符；在 `sandbox="allow-scripts"` 的 iframe 里渲染。 */
    html: string;
  }

  /**
   * 3b. `panels`（`client.js` 侧）—— 注册一个真正的 React 组件面板。
   *
   * 只有提供了 `client.js` 的插件能走这条；因为它在画布渲染进程内直接执行，
   * 安装时 artflow 会向用户弹出 unrestricted 权限确认框。
   * `client.js` 里 `React` 是全局可用的，无需 import。
   */
  interface ClientPanelDefinition {
    id: string;
    title: string;
    component: (props: { library: AssetLibraryClient }) => unknown;
  }

  /** 4. `cards` —— 声明一个卡片类型（让自定义卡片能被画布识别）。 */
  interface CardTypeDefinition {
    /** 必须以 `${插件id}.` 开头；最多注册 8 个。 */
    nodeType: string;
  }

  /** 5. `assets` —— 注册一个外部资产源。 */
  interface AssetSourceDefinition {
    /** 必须以 `${插件id}.` 开头，且 ≤80 字符。 */
    id: string;
    /** 1–80 字符。 */
    title: string;
    probe(): { online: boolean; message?: string } | Promise<{ online: boolean; message?: string }>;
    /**
     * 可选。提交后必须返回内联 data URL（≤1500000 字符）与 MIME 类型；
     * `metadata` 的每个键都必须以 `${插件id}.` 开头。
     */
    submit?(input: Record<string, unknown>): AssetSubmitResult | Promise<AssetSubmitResult>;
  }

  interface AssetSubmitResult {
    /** 必须形如 `data:...`，≤1500000 字符。 */
    assetDataUrl: string;
    /** ≤80 字符。 */
    mimeType: string;
    metadata?: Record<string, string>;
  }

  /**
   * 6. `files` —— 文件读写。所有调用都会转交主进程执行，
   * 沙箱自身没有 `require` / `fs` / `fetch` 这些全局对象（它们被显式置为 undefined）。
   */
  interface FilesApi {
    read(path: string): Promise<unknown>;
    write(path: string, text: string): Promise<unknown>;
    /** 把解析输入直接落主进程仓，只拿回一个 ref，避免把大字节塞进消息。 */
    storeInput(): Promise<unknown>;
    /** 存非空字节（`Uint8Array`）。 */
    store(bytes: Uint8Array): Promise<unknown>;
    /** 打开暂存的压缩包输入（ZIP 引擎在主进程侧，与内置漫画阅读器同源）。 */
    openArchiveInput(): Promise<unknown>;
  }

  /** 7. `net` —— 网络请求，同样由主进程代发。 */
  interface NetApi {
    fetch(url: string): Promise<unknown>;
  }

  /**
   * 8. `host` —— 受控宿主对象图（读取 / 操作宿主**自己**的状态）。
   *
   * 与第 5 面 `assets` 的区别：`api.assets.register()` 是「我提供一个资产**源**」，
   * `api.host.assets` 是「我读宿主的资产**库**」。两者层级不同，互不影响。
   *
   * 前七面是「投稿」（登记一个命令 / 面板 / 格式），这一面是「拿到编辑权限」。
   *
   * **权限是逐方法强制的**：清单里 `permissions.host` 没声明对应项时，调用会被
   * 主进程拒绝并抛出 `Error`。沙箱里没有别的路径能摸到这些数据 —— 所以这是真限制，
   * 不是提示。声明方式：
   *
   * ```json
   * { "permissions": { "host": ["assets.read"] } }
   * ```
   *
   * 目前服务 `assets` 与 `events`。`board` / `collections` / `ui` 已在路线图上，
   * 调用会得到明确的「not available yet」，而不是静默失效。
   */
  interface HostApi {
    readonly meta: {
      pluginId: string;
      /** 宿主 API 版本；与清单里的 `minHostVersion` 比对。 */
      hostApiVersion: string;
    };
    readonly assets: HostAssetsApi;
    readonly events: HostEventsApi;
  }

  interface HostAssetsApi {
    /**
     * 需权限 `assets.read`。默认返回前 50 条；`limit` 上限 200，扫描上限 1000 条。
     * 返回的数组按宿主仓储顺序，稳定但不对内容做排序承诺。
     */
    list(options?: { offset?: number; limit?: number; unreferencedOnly?: boolean }): Promise<AssetRef[]>;
    /** 需权限 `assets.read`。找不到返回 `null`。 */
    get(id: string): Promise<AssetRef | null>;
    /** 需权限 `assets.write`。1~40 条；名称长度 1~180。 */
    rename(changes: Array<{ id: string; name: string }>): Promise<{ renamed: string[]; missing: string[] }>;
  }

  /**
   * 宿主事件订阅（需权限 `events.subscribe`）。
   *
   * handler 永远留在沙箱里：`on()` 同步返回一个 `subscriptionId`，宿主发生变更时
   * 回推 payload 并在这里按 id 找回 handler。登记是后台异步的 —— 失败（最常见是
   * manifest 没声明权限）会立即撤销本地 handler 并 `console.error`，不会静默哑掉。
   *
   * ```js
   * const id = api.host.events.on('asset.added', event => {
   *   console.log('新资产：', event.asset.id, event.asset.name);
   * });
   * // api.host.events.off(id); // 退订
   * ```
   */
  interface HostEventsApi {
    /** 宿主当前支持的事件名（权威列表；别硬编码）。 */
    names(): Promise<string[]>;
    /** 订阅一个事件，返回 `subscriptionId`。同一插件最多 16 个订阅。 */
    on(name: string, handler: (event: HostEvent) => void | Promise<void>): string;
    /** 退订；从未存在过返回 `false`（幂等）。 */
    off(subscriptionId: string): Promise<boolean>;
  }

  /** 宿主事件 payload。字段按事件名逐个重建 —— 内部字段（hashPrefix/路径等）不会出现。 */
  interface HostEvent {
    /** 事件名，如 `asset.added`。 */
    type: 'asset.added' | 'asset.renamed' | 'asset.removed';
    /** 事件发生时间（宿主侧 `Date.now()`）。 */
    at: number;
    /** 事件主体资产。 */
    asset: {
      id: string;
      name: string;
      kind?: string;
      mimeType?: string;
      byteSize?: number;
    };
    /** 仅 `asset.renamed`：改之前的名字（部分变更路径拿不到旧名时缺省）。 */
    previousName?: string;
    /** 仅 `asset.removed`：回收释放的字节数（宿主逐条广播时可能缺省）。 */
    freedBytes?: number;
  }

  /**
   * 宿主资产库里的一个资产。
   *
   * 刻意不含 `hashPrefix` 与任何存储路径 —— 插件拿不到可以定位磁盘文件的线索。
   */
  interface AssetRef {
    id: string;
    name: string;
    kind: string;
    mimeType: string;
    byteSize: number;
    updatedAt: number;
    /** `document` = 被已保存工程引用；`import` = 导入中；`none` = 未被引用。 */
    usage: 'document' | 'import' | 'none';
  }

  /** `activate` 时拿到的 api 对象。 */
  interface PluginApi {
    formats: { register(definition: FormatDefinition): void };
    commands: { register(definition: CommandDefinition): void };
    panels: { register(definition: PanelDefinition | ClientPanelDefinition): void };
    cards: { register(definition: CardTypeDefinition): void };
    assets: { register(definition: AssetSourceDefinition): void };
    files: FilesApi;
    net: NetApi;
    storage: PluginStorageApi;
    ui: UiApi;
    host: HostApi;
  }

  /** 声明式设置页控件（`api.ui.registerSettingsTab`）。 */
  interface SettingsControlDefinition {
    type: 'text' | 'password' | 'toggle' | 'number' | 'select' | 'button' | 'note';
    /** 值在 data.json 里的键（`note`/`button` 不需要）。须匹配 `[A-Za-z_][A-Za-z0-9_]*`。 */
    key?: string;
    label?: string;
    /** 仅 `note`：静态说明文字（≤200 字符）。 */
    text?: string;
    /** 控件下方的说明文字（≤200 字符）。 */
    description?: string;
    /** 仅 `select`：1~16 个选项。 */
    options?: Array<{ value: string; label: string }>;
    /** 仅 `number`。 */
    min?: number;
    max?: number;
    step?: number;
    /** 首次运行（data.json 还没有这个键）时的初始值；类型必须与控件匹配。 */
    default?: string | number | boolean;
    /** 仅 `button`：必须是本插件注册过的命令 id。 */
    commandId?: string;
  }

  /**
   * 声明式 UI。与 panels 一样是**本地登记**：不过 bridge、不需要权限。
   * 宿主的插件管理器按 schema 画出表单，值读写插件自己的 data.json —— 插件
   * 一行 UI 代码都不用写（对应 Obsidian 的 `addSettingTab` + `Setting`）。
   */
  interface UiApi {
    /**
     * 登记声明式设置页。每插件最多 1 个，控件 1~16 个。
     * `id` 必须以插件 id 开头；改动自动持久化（400ms 防抖），改完插件下次
     * `api.storage.load()` 就能读到。
     */
    registerSettingsTab(definition: {
      id: string;
      title: string;
      controls: SettingsControlDefinition[];
    }): void;
    /**
     * 登记声明式交互面板（Obsidian `Modal` 的声明式等价物）。每插件最多 4 个
     * （与 `api.panels` 共享上限），控件 0~16 个，`id` 必须以插件 id 开头。
     *
     * 宿主渲染控件；`button` 的 `action` 被点击后，宿主把控件当前值回推给
     * `onAction(actionId, values)`，返回值 `{ content?, notice?, error? }` 原样
     * 带回渲染层（`content` HTML 只进沙箱 iframe，永不注入宿主 DOM）。
     * 本地登记，无需权限。
     */
    registerPanel(definition: {
      id: string;
      title: string;
      /** 可省略；`button` 必须带 `action`（`[A-Za-z0-9_-]{1,48}`）。 */
      controls?: Array<Omit<SettingsControlDefinition, 'commandId'> & {
        type: 'text' | 'textarea' | 'toggle' | 'number' | 'select' | 'button' | 'note';
        placeholder?: string;
        /** 仅 `button`：动作 id，`onAction` 按它分发。 */
        action?: string;
      }>;
      /** 内容区初始 HTML（≤8000 字符，渲染在隔离 iframe 里）。 */
      content?: string;
      onAction(actionId: string, values: Record<string, string | number | boolean>):
        Promise<{ content?: string; notice?: string; error?: string } | void> | void;
    }): void;
  }

  /**
   * 插件自有 KV 持久化（对应 Obsidian `loadData()/saveData()`）。
   *
   * 数据固定落在插件自己目录的 `data.json`（≤256KB），路径不可选 → 不需要权限。
   * 典型用法：设置项、上次状态、缓存索引。
   *
   * ```js
   * var state = (await api.storage.load()) || { count: 0 };
   * state.count += 1;
   * await api.storage.save(state);
   * ```
   */
  interface PluginStorageApi {
    /** 读持久化数据；从未保存过返回 `null`。data.json 损坏时抛错（不静默清零）。 */
    load(): Promise<unknown>;
    /** 写持久化数据（须 JSON 可序列化，≤256KB）。原子写：崩溃不会留下半截文件。 */
    save(data: unknown): Promise<{ bytes: number }>;
  }

  /* ─────────────────────────  宿主注入给 client.js 的  ───────────────────────── */

  /** `client.js` 面板组件 props 里的资产库访问器。 */
  interface AssetLibraryClient {
    /** 是否允许重命名（由清单里的权限决定）。 */
    allowRename: boolean;
    list(): Promise<Array<{ id: string; name: string; size?: number }>>;
    rename(ids: string[], next: (name: string, index: number) => string): Promise<unknown>;
  }

  /* ─────────────────────────────  全局入口  ───────────────────────────── */

  /**
   * 插件唯一入口。`setup` 会立刻拿到 api 对象。
   *
   * **注意**：它必须被同步调用 —— artflow 在求值完源码后立即检查 `definePlugin`
   * 是否执行过，异步调用会被判为「plugin.js did not call definePlugin」。
   *
   * 沙箱里除 `Artflow` 之外的全局（`window` / `document` / `globalThis` /
   * `process` / `require` / `module` / `exports` / `fetch` / `XMLHttpRequest` /
   * `WebSocket` / `localStorage` / `sessionStorage` / `indexedDB` / `navigator` /
   * `Function` 等 20 个）**全部是 undefined**，访问即报错。源码本身上限 65536 字节。
   */
  const modules: {
    definePlugin(setup: (api: PluginApi) => void): void;
  };
}
