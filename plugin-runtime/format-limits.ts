/**
 * format-limits.ts —— 导入准入阈值的**唯一真相源**（配置缝）。
 *
 * 为什么把这些数字从解析器里搬出来：
 *   1. 原先每个解析器各自`export const MAX_*_BYTES`（8/16/64 MiB 各不相同），
 *      阈值定多低全凭当时手写，主观且无法复核 —— 于是出现「MOBI 8 MiB 比 EPUB 16 MiB
 *      还严，而它的内存护栏其实另有其人（MAX_TEXT_BYTES）」这类没有安全理由的反常值。
 *   2. 用户遇到「导入失败」时无处可调，只能改源码重编。
 *   3. 同一个 .cbz 在新版懒加载路径允许 512 MiB、旧版全量路径只允许 16 MiB，
 *      差 32 倍却没有任何文档说明差异从哪来。
 *
 * 现在：数字只在这里定义一次→ 经 manifest.configSchema 暴露到「插件与扩展 → 插件详情」
 * 的参数表单 → 解析器运行时读取。**改变阈值是配置动作，不是重构动作。**
 *
 * 三条不变约束（放宽数值不破坏这些）：
 *   - 单位对外一律 **MiB**（用户看得懂），内部统一 bytes。
 *   - 上下界由本模块钳制：主人可以调高，但调不出「无上限」这种把内存打爆的值。
 *   - 缺失 / 非法 / 越界一律回退**默认值**，绝不回退 0 或 Infinity（那等于关掉准入闸门）。
 *
 * 键名与 manifest.configSchema 的键一一对应 —— 改这里必须同步改那份 manifest，
 * `scripts/check-format-limits.cjs` 会校验两者不漂移。
 */

/** 阈值单位：对外 MiB，对内 bytes。 */
const MIB = 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 接线用的结构化类型（避免本模块 import kernel 造成循环依赖）
 * ------------------------------------------------------------------ */

/** 与 PluginProfileManager 实际用到的形状一致；只声明我们读的那两个成员。 */
interface PluginProfileManagerLike {
  getSnapshot(): {
    activeProfile: { plugins: readonly { id: string; config?: Readonly<Record<string, unknown>> }[] };
  };
}

/** 与 Kernel 实际用到的形状一致。 */
interface KernelLike {
  has(service: string): boolean;
  use<T>(service: string): T;
  on(event: string, handler: (payload: unknown) => void): () => void;
}

const PLUGIN_PROFILE_MANAGER_SERVICE = 'plugin.profile-manager';

/**
 * 单个上限的声明。
 * @param pluginId 拥有该阈值的插件 id（读哪份config）
 * @param key      config 键名（必须与 manifest.configSchema 的键一致）
 * @param label    管理面板与报错里显示的名字
 * @param defaultMiB 默认值。选它依据的是「该格式的典型体积」而非「内存够多少」
 * @param minMiB   下界。低过它就失去准入闸门的意义
 * @param maxMiB   上界。主人可调高，但不允许调到无上限
 */
export interface FormatLimitSpec {
  readonly pluginId: string;
  readonly key: string;
  readonly label: string;
  readonly defaultMiB: number;
  readonly minMiB: number;
  readonly maxMiB: number;
}

export const BOOK_PLUGIN_ID = 'builtin.formats-book';
export const PACKAGED_PLUGIN_ID = 'builtin.formats-packaged';
export const PUREREF_PLUGIN_ID = 'builtin.formats-pureref';

/**
 * 全部可调阈值。数值取舍见 ADR-057。
 *
 * 关键决定：
 *   - MOBI/Palm 8 → 32 MiB。8 MiB 没有任何安全理由：真正的内存护栏是
 *     palmDoc 内部的 MAX_TEXT_BYTES（4 MiB 解压后文本），源文件上限卡在 8 MiB
 *     反而把大量正常中文 mobi（Z-Library 常见 15–40 MiB）挡在门外。
 *   - EPUB 16 → 64 MiB。EPUB 是 ZIP，纯文本章节有 MAX_EPUB_TEXT_BYTES（4 MiB）兜底，
 *     源文件 16 MiB 偏紧。
 *   - 漫画旧路径 16 → 128 MiB，**不再是 512**：旧路径会把所有页解码成 data URL 全量进内存，
 *     与主进程 512 MiB 的懒加载路径不是一回事，不能直接对齐（对齐的是「量级」不是「数值」）。
 *     真正要支持超大漫画，应走新版懒加载路径。
 */
export const FORMAT_LIMITS = {
  /** 纯文本 .txt/.md：全局兜底，仍保持最严（它没有任何解压步骤）。 */
  bookTextMiB: {
    pluginId: BOOK_PLUGIN_ID,
    key: 'maxTextMiB',
    label: '纯文本文件上限 (MiB)',
    defaultMiB: 8,
    minMiB: 1,
    maxMiB: 128,
  },
  /** EPUB 源文件。 */
  epubSourceMiB: {
    pluginId: BOOK_PLUGIN_ID,
    key: 'maxEpubMiB',
    label: 'EPUB 文件上限 (MiB)',
    defaultMiB: 64,
    minMiB: 4,
    maxMiB: 256,
  },
  /** MOBI/AZW/AZW3 源文件。 */
  palmSourceMiB: {
    pluginId: PACKAGED_PLUGIN_ID,
    key: 'maxPalmMiB',
    label: 'MOBI / AZW 文件上限 (MiB)',
    defaultMiB: 32,
    minMiB: 4,
    maxMiB: 256,
  },
  /** 漫画压缩包（旧版全量路径）。 */
  comicSourceMiB: {
    pluginId: PACKAGED_PLUGIN_ID,
    key: 'maxComicMiB',
    label: '漫画压缩包上限 (MiB, 全量路径)',
    defaultMiB: 128,
    minMiB: 8,
    maxMiB: 512,
  },
  /**
   * PureRef 场景文件。
   *
   * .pur 把**全部原图内嵌**在场景里，一张 4K 参考图板轻松几百 MiB，
   * 64 MiB 的默认值把绝大多数真实场景挡在门外（实测 675 MiB 的工程属常见量级）。
   * 因此默认拉到 2 GiB，允许上调到 8 GiB。仍保留有限上界而非 Infinity：
   * 解析路径会把文件整体读进内存，无上界等于让一次误操作直接把进程撑爆。
   */
  purFileMiB: {
    pluginId: PUREREF_PLUGIN_ID,
    key: 'maxPurMiB',
    label: 'PureRef 文件上限 (MiB)',
    defaultMiB: 2048,
    minMiB: 4,
    maxMiB: 8192,
  },
} as const satisfies Record<string, FormatLimitSpec>;

export type FormatLimitKey = keyof typeof FORMAT_LIMITS;

/** config 里读到的原始值：可能是用户输入的字符串，也可能根本没配。 */
type RawLimitValue = unknown;

/** 插件 config 的最小形状 —— 避免本模块反向依赖整个 plugins/profile。 */
export type LimitConfigLookup = Readonly<Record<string, unknown>> | null | undefined;

/**
 * 把 config 里的原始值解成bytes。
 *
 * 契约（顺序即优先级，逐条都要成立）：
 *   1. 非有限数（NaN / Infinity / 空串 / undefined）→ 默认值。**绝不返回 0 或 Infinity** ——
 *      那等于替用户关掉准入闸门，比阈值偏小严重得多。
 *   2. 数字或可解析的字符串 → 按 MiB 解释。
 *   3. 越界 →钳制到 [min, max]，而不是报错。主人手滑填 99999 不该让功能直接崩掉。
 */
export function resolveLimitBytes(spec: FormatLimitSpec, value: RawLimitValue): number {
  const fallback = spec.defaultMiB * MIB;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const mib = Math.min(spec.maxMiB, Math.max(spec.minMiB, numeric));
  // Math.round 避免 7.3 MiB 变成非整数 bytes，后续错误文案里的 MiB 显示才稳定。
  return Math.round(mib * MIB);
}

/** 同上，但宿主侧（主进程/管理面板）需要「用户到底填了多少 MiB」时用。 */
export function resolveLimitMiB(spec: FormatLimitSpec, value: RawLimitValue): number {
  const fallback = spec.defaultMiB;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(spec.maxMiB, Math.max(spec.minMiB, numeric));
}

/**
 * 从一份「插件 id → config」的表里取阈值。
 * 插件读自己的 config 时用它，天然读不到别人的键。
 */
export function limitBytesFromConfigs(
  spec: FormatLimitSpec,
  configs: Readonly<Record<string, LimitConfigLookup>>,
): number {
  return resolveLimitBytes(spec, configs[spec.pluginId]?.[spec.key]);
}

/**
 * 人类可读的文案。**必须报实际生效的阈值**，而不是常量——
 * 否则主人把上限调到 64 MiB，错误信息还写着 16 MiB，会以为设置没生效。
 */
export function limitMessage(spec: FormatLimitSpec, bytes: number): string {
  return `${spec.label.replace(/\s*\(MiB.*\)$/, '')} are limited to ${bytes / MIB} MiB.`;
}

/** 供manifest 生成的键映射：{ [key]: 'number' }。避免手抄键名抄错。 */
export function configSchemaFor(...keys: readonly FormatLimitKey[]): Record<string, 'number'> {
  const schema: Record<string, 'number'> = {};
  for (const key of keys) schema[FORMAT_LIMITS[key].key] = 'number';
  return schema;
}

/** 供检查脚本用：列出某插件应声明的全部 config 键。 */
export function limitKeysForPlugin(pluginId: string): readonly FormatLimitSpec[] {
  return Object.values(FORMAT_LIMITS).filter(spec => spec.pluginId === pluginId);
}

/* ------------------------------------------------------------------ *
 * 运行时接线：让解析器读得到当前 plugin config
 * ------------------------------------------------------------------ */

/**
 * 解析器的 `parse(file)` 签名里**没有 kernel**（见 FormatHandler 契约），
 * 所以阈值读取靠一个模块级提供者在插件 activate 时注入。
 *
 * 为什么不用别的方案：
 *   - 改 `FormatHandler.parse` 签名要动全部格式插件 + 类型 + 契约测试，
 *     属于「为了一个可配置项改公共契约」；
 *   - 直接读 localStorage 会绕过 profile 校验（绕过 configSchema 类型检查与
 *     依赖停用判定），且踩ADR-055 那条「localStorage 按 origin 隔离」的坑；
 *   - 每帧从 snapshot 抓 config 也可以，但要把 kernel 穿进解析器，同样改签名。
 *
 * 注入点只有一个（各格式插件的 activate），读取点是全部解析器 —— 依赖单向向下。
 * 没注入时（例如单元测试直接调解析器）读取器为 null，一律回退契约默认值，
 * **解析器因此永远可独立测试**，不依赖宿主状态。
 */
let configProvider: ((pluginId: string) => LimitConfigLookup) | null = null;

/** 由插件 activate 调用。传null 清除（测试用）。 */
export function setFormatLimitConfigProvider(
  provider: ((pluginId: string) => LimitConfigLookup) | null,
): void {
  configProvider = provider;
}

/**
 * 解析器侧的取阈值入口。
 * @param spec阈值声明
 * @returns 生效的字节上限；未注入 provider 或配置缺失/非法时为契约默认值
 */
export function limitBytes(spec: FormatLimitSpec): number {
  if (!configProvider) return resolveLimitBytes(spec, undefined);
  return resolveLimitBytes(spec, configProvider(spec.pluginId)?.[spec.key]);
}

/** 与 limitBytes 配套：报错文案必须报**实际生效**的阈值，否则主人调完设置会以为没生效。 */
export function limitExceeded(spec: FormatLimitSpec, actualBytes: number): string {
  return limitMessage(spec, limitBytes(spec));
}

/**
 * 插件 activate 里的接线动作：把 profileManager 接成config 来源。
 *
 * 返回一个 dispose，与其他 contribution 注册并列返回 —— 插件被停用时阈值读取器
 * 一起摘掉，避免留一个指向已停用 manager 的悬空引用。
 *
 * 放在插件侧而不是 App.tsx：activate 本身就是「我需要什么」的声明处，
 * 且各格式插件互不感知（不互相 import，符合插件间零依赖的约定）。
 */
export function bindFormatLimitConfig(kernel: KernelLike): () => void {
  if (!kernel.has(PLUGIN_PROFILE_MANAGER_SERVICE)) return () => {};
  const manager = kernel.use(PLUGIN_PROFILE_MANAGER_SERVICE) as PluginProfileManagerLike;
  setFormatLimitConfigProvider(pluginId => {
    const snapshot = manager.getSnapshot();
    // activeProfile 是**当前生效**的那份；pendingProfile 可能含用户刚填但尚未
    // 重启的改动。导入走的是活跃插件，读 active 才是真相。
    return snapshot.activeProfile.plugins.find(plugin => plugin.id === pluginId)?.config;
  });
  // 主人改了阈值并应用后，让下一次导入立刻用新值（插件可能未重启）。
  const off = kernel.on('plugin:config-changed', () => { /* provider 是闭包读快照，无需重建 */ });
  return () => {
    off();
    setFormatLimitConfigProvider(null);
  };
}