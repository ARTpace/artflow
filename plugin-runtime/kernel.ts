/**
 * kernel.ts —— Artflow 插件内核（蓝本：AssetLibrary ADR-005 微内核四原语）。
 *
 * 设计原则：
 * 1. 四原语：provide（服务）/ on（事件）/ register（贡献，返回可逆 disposer）/ 未来扩展 run（操作瀑布）。
 * 2. 一切皆插件：内置功能（builtin/）与第三方插件走同一套 manifest + 贡献通道。
 * 3. 可逆性：register/provide/on 全部返回 disposer，插件卸载时逐项撤销。
 * 4. 第三方 plugin.js 留在沙箱窗口。client.js 只拿到 React 和卡片契约。文件与网络由主进程按清单代劳。
 */

/** 贡献插槽唯一定义处（对齐 AssetLibrary SLOTS，按 Artflow 现有功能裁剪）。 */
export const SLOTS = [
  'skins',              // 皮肤 token 包
  'locales',            // 界面语言包补丁（对标 skins 的 partial 补丁语义；内置底座仍是 translations.ts）
  'canvas_node_types',  // 画布卡片类型（替代 CanvasElement switch 的远期目标）
  'format_handlers',    // 文件格式处理器（psd/pdf/tiff/raw/...）
  'ai_providers',       // AI 生图/生视频提供方
  'asset_sources',      // 外部工具/资产源（ComfyUI / NAS / Figma 等）
  'commands',           // 统一命令入口（快捷键/菜单/工具栏共用）
  'node_actions',       // 卡片上下文操作（AI重绘、扩图、同参重生成等）
  'ui_panels',          // 可停靠面板（LayerPanel/BoardPanel/Settings...）
  'canvas_widgets',     // 画布常驻/浮层组件（Dock/Navigator/Finder/书签/导入任务，经注册表宿主挂接）
  'canvas_overlays',    // 相机层内的插件覆盖（随缩放平移，不接管合成）
  'settings_sections',  // Settings 内的可扩展 section
  'ui_toolbar',         // 工具栏按钮
  'ui_menus',           // 菜单项
  'hooks',              // 生命周期/操作钩子
] as const;

export type SlotName = (typeof SLOTS)[number];

/** 贡献项 id 必须是 <命名空间>.<名称>，避免跨插件冲突。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_.-]*$/;

export interface Contribution<T = unknown> {
  id: string;
  pluginId: string;
  /** 同插槽内排序权重，大者在前。 */
  priority?: number;
  value: T;
}

export type Effect = () => void;

export class ContributionRegistry {
  private readonly slots = new Map<SlotName, Map<string, Contribution>>();

  constructor() {
    for (const s of SLOTS) this.slots.set(s, new Map());
  }

  /** 注册贡献项；重复 id 直接抛错（实现级查重闸）。返回 disposer。 */
  register<T>(slot: SlotName, item: Contribution<T>): Effect {
    const table = this.slots.get(slot);
    if (!table) throw new Error(`unknown slot: ${slot}`);
    if (!ID_PATTERN.test(item.id)) throw new Error(`contribution id must be <ns>.<name>: ${item.id}`);
    if (item.priority !== undefined && (!Number.isFinite(item.priority) || !Number.isInteger(item.priority))) {
      throw new Error(`contribution priority must be a finite integer: ${item.id}`);
    }
    if (table.has(item.id)) throw new Error(`duplicate contribution ${slot}/${item.id}`);
    // Each registration has its own identity. An old disposer must not delete
    // a replacement registered under the same id (even using the same input object).
    const entry = { ...item } as Contribution;
    const id = entry.id;
    table.set(id, entry);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (table.get(id) === entry) table.delete(id);
    };
  }

  list<T = unknown>(slot: SlotName): readonly Contribution<T>[] {
    return [...(this.slots.get(slot)?.values() ?? [])]
      // priority establishes policy; id is an explicit deterministic tie-break for every consumer.
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id)) as Contribution<T>[];
  }

  get<T = unknown>(slot: SlotName, id: string): Contribution<T> | undefined {
    return this.slots.get(slot)?.get(id) as Contribution<T> | undefined;
  }
}

export type KernelEventHandler = (payload: unknown) => void;

/**
 * 迷你内核：贡献注册表 + 服务容器 + 事件总线。
 * 后续若插件规模扩大，可平滑替换为 Cordis 4（AssetLibrary 已验证该路径）。
 */
export class Kernel {
  readonly contributions = new ContributionRegistry();
  private readonly services = new Map<string, { value: unknown; dispose?: Effect }>();
  private readonly listeners = new Map<string, Set<KernelEventHandler>>();

  /** 原语①：provide —— 注册宿主服务（如 preferences / canvasApi），可逆。 */
  provide<T>(name: string, value: T, dispose?: Effect): Effect {
    if (this.services.has(name)) throw new Error(`service already provided: ${name}`);
    const entry = { value, dispose };
    this.services.set(name, entry);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.services.get(name) !== entry) return;
      this.services.delete(name);
      entry.dispose?.();
    };
  }

  /**
   * 幂等变体：同名重复登记时先释放旧登记再写入新值，不抛错。
   * 用于「渲染期注册 + 内核跨挂载存活」的服务（workspace.ui-bridge / settings.ui-bridge）：
   * HMR / 受控刷新会重挂载组件并重置组件局部 ref，此时 provide 会抛
   * "service already provided" 并让整树卸载成白屏。replace 让重挂载退化为一次覆盖，
   * 同时保证内核始终指向本次挂载的活对象（旧 bridge 已随旧挂载失效）。
   */
  replace<T>(name: string, value: T, dispose?: Effect): Effect {
    const existing = this.services.get(name);
    if (existing) {
      this.services.delete(name);
      existing.dispose?.();
    }
    return this.provide(name, value, dispose);
  }

  /** Presence check without materializing/calling a service (activation conflict checks). */
  has(name: string): boolean { return this.services.has(name); }

  /** 取宿主服务；未注册视为架构错误（插件依赖的底层服务必须显式 provide）。 */
  use<T = unknown>(name: string): T {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`service not provided: ${name}`);
    return svc.value as T;
  }

  /** 原语②：on —— 订阅事件，可逆。 */
  on(topic: string, handler: KernelEventHandler): Effect {
    let set = this.listeners.get(topic);
    if (!set) { set = new Set(); this.listeners.set(topic, set); }
    // Two owners subscribing the same callback still own independent leases.
    let disposed = false;
    const ownedHandler: KernelEventHandler = payload => { if (!disposed) handler(payload); };
    set.add(ownedHandler);
    return () => {
      if (disposed) return;
      disposed = true;
      set!.delete(ownedHandler);
      if (set!.size === 0 && this.listeners.get(topic) === set) this.listeners.delete(topic);
    };
  }

  /** 事件分发；单个监听器异常不影响其他监听器。 */
  emit(topic: string, payload?: unknown): void {
    const set = this.listeners.get(topic);
    if (!set) return;
    for (const handler of [...set]) {
      try { handler(payload); } catch (e) { console.error(`[kernel] listener error on ${topic}:`, e); }
    }
  }
}

export function createKernel(): Kernel {
  return new Kernel();
}
