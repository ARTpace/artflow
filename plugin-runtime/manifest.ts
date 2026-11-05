/**
 * manifest.ts —— 插件清单 v1（builtin-only）。
 * 严格校验 manifest / capability / profile 可配置字段；未知字段一律拒绝。
 * Runtime Core 不在 manifest 体系内，因此不能被普通 profile patch 替换或禁用。
 */

import type { SkinTokens } from './contributions';
import { validateSkinCustomizationDecl, type SkinCustomizationDecl } from './skin-customization';
import { resolveManifestText, type LocaleBundle, type LocalizedManifestText, type UiLanguage } from './i18n';

export const MANIFEST_VERSION = 1 as const;
/** Plugin contract API version, intentionally separate from the application package release number. */
export const PLUGIN_HOST_API_VERSION = '1.0.0' as const;

export const PLUGIN_HOSTS = ['worker', 'renderer', 'main'] as const;
export type PluginHost = (typeof PLUGIN_HOSTS)[number];

export const PLUGIN_CAPABILITIES = [
  'format.handler',
  'canvas.card',
  'ui.panel',
  'ui.settings',
  'ui.menu',
  'ui.skin',
  'command',
  'ai.provider',
  'asset.source',
  'node.action',
  'exporter',
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** 当前只支持可在无依赖条件下严格校验的基础字段类型。 */
export type PluginConfigValueKind = 'boolean' | 'number' | 'string';
export type PluginConfigSchema = Readonly<Record<string, PluginConfigValueKind>>;

export interface PluginResourceBudget {
  maxActiveInstances?: number;
  maxMemoryMB?: number;
  maxConcurrentJobs?: number;
}

export interface SkinManifestEntry {
  id: string;
  name: string;
  mode?: 'dark' | 'light';
  /** partial 补丁；缺省键回落到默认底座。 */
  tokens?: SkinTokens;
  // —— v1 兼容扩展（全部可选 + 显式校验，不升 MANIFEST_VERSION，见《皮肤系统升级开发文档》4.2）——
  /** 亮/暗预览图（构建期经 vite 资产导入转 dataURI 或 URL）。 */
  preview?: { dark?: string; light?: string };
  /** Optional theme-family and poster metadata, kept separate from legacy screenshots. */
  gallery?: {
    family: string;
    title: string;
    titleEn?: string;
    description?: string;
    descriptionEn?: string;
    poster?: string;
    credit?: string;
  };
  /** 标签（主题库筛选展示），≤8 项，每项 ≤16 字符。 */
  tags?: string[];
  /** 主题库排序权重，小者在前；缺省 100。 */
  order?: number;
  /** 皮肤自声明配置（M2，对齐 dsh exposeSkinCustomization）。 */
  customization?: SkinCustomizationDecl;
}

/** 插件在管理面板中的分组类型（Blender Add-on category 同思路）。缺省归 other。 */
export const PLUGIN_CATEGORIES = [
  'format',     // 格式解析/导入导出
  'canvas',     // 卡片与画布内容
  'ui',         // 面板/外壳/设置类
  'ai',         // AI provider 与生成
  'skin',       // 皮肤与主题
  'workspace',  // 工作台/状态/导航组件
  'other',
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export interface PluginManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  /** <命名空间>.<名称>，全局唯一。 */
  id: string;
  version: string;
  /** Optional minimum plugin-contract API version required by this module. */
  minHostVersion?: string;
  name: string;
  /**
   * 插件名与简介的**中文基准**（description 缺省为空，name 必需）。
   * JSON 里放不下函数，因此其它语言的文案走下面两张覆盖表。
   */
  nameI18n?: LocalizedManifestText;
  /** 一句话简介，展示于插件管理面板；可选。 */
  description?: string;
  /** 简介的语言覆盖；未命中该语言时回落 description。 */
  descriptionI18n?: LocalizedManifestText;
  /** 管理面板分组类型；缺省 other。 */
  category?: PluginCategory;
  /** 插件源码目录（相对应用根，如 "builtin/cards"）；管理面板「打开文件夹」跳转用。可选。 */
  sourceDir?: string;
  author: string;
  license: string;
  /** 贡献在哪个受控 host 中运行；不是给插件选择任意进程的能力。 */
  host: PluginHost;
  runtime: { mode: 'builtin' | 'declarative' | 'editable'; entry?: string };
  requires: readonly string[];
  optionalRequires: readonly string[];
  capabilities: readonly PluginCapability[];
  /** 只有此处声明的字段可以被 profile / user patch 覆盖。 */
  configSchema?: PluginConfigSchema;
  /** 声明值会进入 resolved profile；Runtime Core 在对应 host 执行预算。 */
  resourceBudget?: PluginResourceBudget;
  /**
   * 允许投影到 MCP 的命令 id。未列出的命令不会变成工具。
   * 插件不能在这里启动自己的 MCP 服务。
   */
  mcp?: {
    export: readonly string[];
  };
  contributes?: {
    skins?: SkinManifestEntry[];
    /** 本地化语言包（内置/声明式插件专用）。 */
    locales?: LocaleBundle[];
    /**
     * 聚合插件的子模块元数据（仅供管理界面展开展示；不参与运行时注册）。
     * 子模块的代码/贡献仍由聚合插件 activate 统一注册，这里只声明其原始身份。
     */
    builtinModules?: BuiltinModuleMetadata[];
  };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_.-]*$/;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const SAFE_ENTRY = /^[a-zA-Z0-9._/-]+$/; // 相对路径，禁止盘符/绝对路径/上级跳转
const CONFIG_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * manifest `contributes` 允许的插槽。
 * ★不变量：validateManifest 的**返回值**会被再次送进 validateManifest（resolvePluginProfile
 * 对已校验 manifest 复验），因此这里必须放行返回值里出现的全部插槽键 —— 否则第一遍通过、
 * 第二遍自我拒收（本轮踩过：新加 locales 后 profile 操作全报 "unknown contribution slot"）。
 */
export const CONTRIBUTION_SLOTS = ['skins', 'locales', 'builtinModules'] as const;

/** 聚合插件子模块元数据（管理界面展示用，不参与运行时注册）。 */
export interface BuiltinModuleMetadata {
  id: string;
  name: string;
  nameI18n?: LocalizedManifestText;
  description?: string;
  descriptionI18n?: LocalizedManifestText;
}

export class ManifestError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`invalid plugin manifest:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'ManifestError';
  }
}

export class PluginCompatibilityError extends Error {
  constructor(public readonly pluginId: string, public readonly minHostVersion: string, public readonly hostVersion: string) {
    super(`plugin ${pluginId} requires host API >= ${minHostVersion}, current is ${hostVersion}`);
    this.name = 'PluginCompatibilityError';
  }
}

type ParsedVersion = { major: number; minor: number; patch: number; prerelease?: string };

function parseVersion(version: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new ManifestError([`invalid semantic version: ${version}`]);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

/** Positive means left is newer. This is intentionally small because manifests only declare a minimum. */
export function comparePluginVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function assertManifestHostCompatibility(manifest: Pick<PluginManifest, 'id' | 'minHostVersion'>, hostVersion = PLUGIN_HOST_API_VERSION): void {
  if (manifest.minHostVersion && comparePluginVersions(hostVersion, manifest.minHostVersion) < 0) {
    throw new PluginCompatibilityError(manifest.id, manifest.minHostVersion, hostVersion);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function validateDependencyIds(value: unknown, field: string, reasons: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    reasons.push(`${field} must be an array`);
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  value.forEach((id, index) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      reasons.push(`${field}[${index}] must match <ns>.<name>`);
      return;
    }
    if (seen.has(id)) {
      reasons.push(`${field} contains duplicate id: ${id}`);
      return;
    }
    seen.add(id);
    ids.push(id);
  });
  return ids;
}

function validateResourceBudget(value: unknown, reasons: string[]): PluginResourceBudget | undefined {
  if (value === undefined) return undefined;
  if (!isObj(value)) {
    reasons.push('resourceBudget must be an object');
    return undefined;
  }
  const allowed = ['maxActiveInstances', 'maxMemoryMB', 'maxConcurrentJobs'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) reasons.push(`unknown resourceBudget field: ${key}`);
  }
  const budget: PluginResourceBudget = {};
  for (const key of allowed as Array<keyof PluginResourceBudget>) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      reasons.push(`resourceBudget.${key} must be a positive integer`);
      continue;
    }
    budget[key] = raw;
  }
  return budget;
}

function validateConfigSchema(value: unknown, reasons: string[]): PluginConfigSchema | undefined {
  if (value === undefined) return undefined;
  if (!isObj(value)) {
    reasons.push('configSchema must be an object');
    return undefined;
  }
  const schema: Record<string, PluginConfigValueKind> = {};
  for (const [key, kind] of Object.entries(value)) {
    if (!CONFIG_KEY_PATTERN.test(key)) {
      reasons.push(`configSchema has invalid key: ${key}`);
      continue;
    }
    if (kind !== 'boolean' && kind !== 'number' && kind !== 'string') {
      reasons.push(`configSchema.${key} must be boolean, number, or string`);
      continue;
    }
    schema[key] = kind;
  }
  return schema;
}

/** manifest 本地化覆盖表支持的语言档，与 plugins/i18n 的 UiLanguage 对齐。 */
const MANIFEST_LANGUAGES = ['en', 'zho'] as const;

/**
 * 校验 nameI18n / descriptionI18n：必须是「语言键 → 非空字符串」的对象。
 * 未知语言键直接拒绝（避免拼错 `zho` → `zh` 后静默永不生效）。
 */
function validateLocalizedText(
  value: unknown,
  field: string,
  reasons: string[],
): LocalizedManifestText | undefined {
  if (value === undefined) return undefined;
  if (!isObj(value)) {
    reasons.push(`${field} must be an object keyed by language`);
    return undefined;
  }
  const out: LocalizedManifestText = {};
  for (const [key, text] of Object.entries(value)) {
    if (!(MANIFEST_LANGUAGES as readonly string[]).includes(key)) {
      reasons.push(`${field} has unsupported language: ${key}`);
      continue;
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      reasons.push(`${field}.${key} must be a non-empty string`);
      continue;
    }
    out[key as UiLanguage] = text;
  }
  return out;
}

const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const MAX_LOCALE_SEGMENTS = 256;
const MAX_LOCALE_ARRAY = 64;
const MAX_LOCALE_DEPTH = 4;

/** 校验结果的包装：表体里 `undefined` 是合法缺席，不能拿它当失败信号。 */
type LocaleNode = { value: unknown };

/**
 * 递归校验语言包表体的一个节点。只接受字符串、数组、纯对象：
 * translations 表里的**函数式文案**（33 条带计数的，如 boardsCount(n)）在 JSON 里
 * 表达不了，那几条由内置底座提供 —— 属于声明式语言包通道的固有边界。
 * 数组必须放行：`quickPrompts` 就是 28 条对象数组，挡掉它等于"完整一档"根本写不出来。
 */
function validateLocaleNode(
  value: unknown,
  field: string,
  reasons: string[],
  depth: number,
): LocaleNode | null {
  if (depth > MAX_LOCALE_DEPTH) {
    reasons.push(`${field} is nested too deeply`);
    return null;
  }
  if (typeof value === 'string') return { value };
  if (Array.isArray(value)) {
    if (value.length > MAX_LOCALE_ARRAY) {
      reasons.push(`${field} has too many entries`);
      return null;
    }
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const node = validateLocaleNode(value[index], `${field}[${index}]`, reasons, depth + 1);
      if (!node) return null;
      out.push(node.value);
    }
    return { value: out };
  }
  if (!isObj(value)) {
    reasons.push(`${field} must be a string, an array, or a nested object`);
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_LOCALE_SEGMENTS) {
    reasons.push(`${field} has too many keys`);
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const node = validateLocaleNode(value[key], `${field}.${key}`, reasons, depth + 1);
    if (!node) return null;
    out[key] = node.value;
  }
  return { value: out };
}

function validateLocaleTable(
  value: unknown,
  field: string,
  reasons: string[],
): Record<string, unknown> | undefined {
  if (!isObj(value)) {
    reasons.push(`${field} must be an object`);
    return undefined;
  }
  const node = validateLocaleNode(value, field, reasons, 0);
  return node ? (node.value as Record<string, unknown>) : undefined;
}

/** strict 校验：返回干净 manifest 或抛 ManifestError。 */
export function validateManifest(raw: unknown): PluginManifest {
  const reasons: string[] = [];
  if (!isObj(raw)) throw new ManifestError(['manifest must be an object']);
  const m = raw;

  // —— 顶层字段（未知键拒绝）——
  const allowed = [
    'manifestVersion', 'id', 'version', 'minHostVersion', 'name', 'nameI18n', 'description', 'descriptionI18n', 'category', 'sourceDir', 'author', 'license', 'host', 'runtime',
    'requires', 'optionalRequires', 'capabilities', 'configSchema', 'resourceBudget', 'mcp', 'contributes',
  ];
  for (const key of Object.keys(m)) {
    if (!allowed.includes(key)) reasons.push(`unknown top-level field: ${key}`);
  }
  if (m.manifestVersion !== MANIFEST_VERSION) reasons.push(`manifestVersion must be ${MANIFEST_VERSION}`);
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) reasons.push(`id must match <ns>.<name>: ${String(m.id)}`);
  if (typeof m.version !== 'string' || !VERSION_PATTERN.test(m.version)) reasons.push(`invalid semver version: ${String(m.version)}`);
  if (m.minHostVersion !== undefined && (typeof m.minHostVersion !== 'string' || !VERSION_PATTERN.test(m.minHostVersion))) {
    reasons.push(`invalid minHostVersion: ${String(m.minHostVersion)}`);
  }
  if (typeof m.name !== 'string' || m.name.trim().length === 0) reasons.push('name is required');
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.trim().length === 0)) {
    reasons.push('description must be a non-empty string when present');
  }
  const nameI18n = validateLocalizedText(m.nameI18n, 'nameI18n', reasons);
  const descriptionI18n = validateLocalizedText(m.descriptionI18n, 'descriptionI18n', reasons);
  if (m.category !== undefined && !PLUGIN_CATEGORIES.includes(m.category as PluginCategory)) {
    reasons.push(`category must be one of: ${PLUGIN_CATEGORIES.join(', ')}`);
  }
  // sourceDir：必须是以 / 分隔的相对路径段，禁止 .. 与绝对路径（主进程跳转前还会再校验一次）。
  if (m.sourceDir !== undefined) {
    const looksAbsolute = typeof m.sourceDir === 'string'
      && (m.sourceDir.startsWith('/') || m.sourceDir.startsWith('\\') || /^[A-Za-z]:/.test(m.sourceDir));
    const ok = typeof m.sourceDir === 'string'
      && m.sourceDir.length > 0
      && !looksAbsolute
      && m.sourceDir.split(/[\\/]/).every(seg => seg.length > 0 && seg !== '.' && seg !== '..');
    if (!ok) reasons.push('sourceDir must be a relative slash-separated path without "." or ".." segments');
  }
  if (typeof m.author !== 'string' || m.author.trim().length === 0) reasons.push('author is required');
  if (typeof m.license !== 'string' || m.license.trim().length === 0) reasons.push('license is required');
  if (!PLUGIN_HOSTS.includes(m.host as PluginHost)) reasons.push(`host must be one of: ${PLUGIN_HOSTS.join(', ')}`);

  // —— runtime：v1 接受 builtin（需 entry）、declarative（外部声明式，无 entry）
  //    与 editable（内置可编辑：entry 指向播种到 userData 的 plugin.js，源码受信任执行）——
  if (!isObj(m.runtime)) {
    reasons.push('runtime is required');
  } else if (m.runtime.mode !== 'builtin' && m.runtime.mode !== 'declarative' && m.runtime.mode !== 'editable') {
    reasons.push(`v1 only supports runtime.mode "builtin" | "declarative" | "editable", got: ${String(m.runtime.mode)}`);
  } else if (m.runtime.mode === 'builtin' || m.runtime.mode === 'editable') {
    if (typeof m.runtime.entry !== 'string' || !SAFE_ENTRY.test(m.runtime.entry) || m.runtime.entry.includes('..')) {
      reasons.push(`runtime.entry must be a safe relative path: ${String(m.runtime.entry)}`);
    }
  }

  const requires = validateDependencyIds(m.requires, 'requires', reasons);
  const optionalRequires = validateDependencyIds(m.optionalRequires, 'optionalRequires', reasons);
  if (typeof m.id === 'string' && (requires.includes(m.id) || optionalRequires.includes(m.id))) {
    reasons.push(`plugin cannot depend on itself: ${m.id}`);
  }
  for (const id of requires) {
    if (optionalRequires.includes(id)) reasons.push(`dependency cannot be both required and optional: ${id}`);
  }

  const capabilities: PluginCapability[] = [];
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
    reasons.push('capabilities must be a non-empty array');
  } else {
    const seen = new Set<string>();
    m.capabilities.forEach((capability, index) => {
      if (typeof capability !== 'string' || !PLUGIN_CAPABILITIES.includes(capability as PluginCapability)) {
        reasons.push(`capabilities[${index}] is not supported: ${String(capability)}`);
        return;
      }
      if (seen.has(capability)) {
        reasons.push(`capabilities contains duplicate: ${capability}`);
        return;
      }
      seen.add(capability);
      capabilities.push(capability as PluginCapability);
    });
  }
  const configSchema = validateConfigSchema(m.configSchema, reasons);
  const resourceBudget = validateResourceBudget(m.resourceBudget, reasons);

  // —— contributes：skins（皮肤补丁）/ locales（界面语言包补丁）两个插槽 ——
  let mcp: PluginManifest['mcp'];
  if (m.mcp !== undefined) {
    if (!isObj(m.mcp)) {
      reasons.push('mcp must be an object');
    } else {
      for (const key of Object.keys(m.mcp)) {
        if (key !== 'export') reasons.push(`unknown mcp field: ${key}`);
      }
      if (!Array.isArray(m.mcp.export) || m.mcp.export.length > 32
        || !m.mcp.export.every(id => typeof id === 'string' && ID_PATTERN.test(id))) {
        reasons.push('mcp.export must be an array of at most 32 command ids');
      } else if (new Set(m.mcp.export).size !== m.mcp.export.length) {
        reasons.push('mcp.export contains a duplicate command id');
      } else {
        mcp = { export: [...m.mcp.export] };
      }
    }
  }

  let skins: SkinManifestEntry[] = [];
  let locales: LocaleBundle[] = [];
  let builtinModules: BuiltinModuleMetadata[] = [];
  if (m.contributes !== undefined) {
    if (!isObj(m.contributes)) {
      reasons.push('contributes must be an object');
    } else {
      for (const key of Object.keys(m.contributes)) {
        if (!(CONTRIBUTION_SLOTS as readonly string[]).includes(key)) reasons.push(`unknown contribution slot in manifest: ${key}`);
      }
      if (Array.isArray(m.contributes.skins)) {
        skins = [];
        m.contributes.skins.forEach((entry, i) => {
          if (!isObj(entry)) { reasons.push(`contributes.skins[${i}] must be an object`); return; }
          if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
            reasons.push(`contributes.skins[${i}].id must match <ns>.<name>`); return;
          }
          if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
            reasons.push(`contributes.skins[${i}].name is required`); return;
          }
          if (entry.mode !== undefined && entry.mode !== 'dark' && entry.mode !== 'light') {
            reasons.push(`contributes.skins[${i}].mode must be "dark" or "light"`); return;
          }
          if (entry.tokens !== undefined && !isObj(entry.tokens)) {
            reasons.push(`contributes.skins[${i}].tokens must be an object`); return;
          }
          // —— v1 扩展字段（preview/tags/order/customization）：非法 → 该皮肤拒收隔离，不抛错（对齐 profile rejected[] 语义）——
          const skinReasons: string[] = [];
          let preview: { dark?: string; light?: string } | undefined;
          if (entry.preview !== undefined) {
            if (!isObj(entry.preview)) {
              skinReasons.push('preview must be an object { dark?, light? }');
            } else {
              preview = {};
              if (entry.preview.dark !== undefined && typeof entry.preview.dark !== 'string') skinReasons.push('preview.dark must be a string');
              if (entry.preview.light !== undefined && typeof entry.preview.light !== 'string') skinReasons.push('preview.light must be a string');
              if (typeof entry.preview.dark === 'string') preview.dark = entry.preview.dark;
              if (typeof entry.preview.light === 'string') preview.light = entry.preview.light;
            }
          }
          let gallery: SkinManifestEntry['gallery'];
          if (entry.gallery !== undefined) {
            if (!isObj(entry.gallery)) {
              skinReasons.push('gallery must be an object');
            } else {
              const g = entry.gallery;
              if (typeof g.family !== 'string' || !ID_PATTERN.test(g.family)) {
                skinReasons.push('gallery.family must match <ns>.<name>');
              }
              if (typeof g.title !== 'string' || !g.title.trim() || g.title.length > 64) {
                skinReasons.push('gallery.title must be 1-64 characters');
              }
              for (const [key, max] of [['titleEn', 64], ['description', 240], ['descriptionEn', 240], ['credit', 160]] as const) {
                if (g[key] !== undefined && (typeof g[key] !== 'string' || g[key].length > max)) {
                  skinReasons.push(`gallery.${key} must be a string of at most ${max} characters`);
                }
              }
              // No external image requests or executable SVG through contributed cover art.
              if (g.poster !== undefined && (typeof g.poster !== 'string'
                || g.poster.length > 250_000 || !/^data:image\/(?:png|webp|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(g.poster))) {
                skinReasons.push('gallery.poster must be a data:image/png|webp|jpeg base64 URI <=250000 characters');
              }
              if (skinReasons.length === 0) gallery = {
                family: g.family as string,
                title: g.title as string,
                ...(g.titleEn !== undefined ? { titleEn: g.titleEn as string } : {}),
                ...(g.description !== undefined ? { description: g.description as string } : {}),
                ...(g.descriptionEn !== undefined ? { descriptionEn: g.descriptionEn as string } : {}),
                ...(g.poster !== undefined ? { poster: g.poster as string } : {}),
                ...(g.credit !== undefined ? { credit: g.credit as string } : {}),
              };
            }
          }
          let tags: string[] | undefined;
          if (entry.tags !== undefined) {
            if (!Array.isArray(entry.tags) || entry.tags.length > 8
              || !entry.tags.every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 16)) {
              skinReasons.push('tags must be a string[] with at most 8 entries, each 1-16 chars');
            } else {
              tags = [...entry.tags];
            }
          }
          let order: number | undefined;
          if (entry.order !== undefined && (typeof entry.order !== 'number' || !Number.isFinite(entry.order))) {
            skinReasons.push('order must be a finite number');
          } else {
            order = entry.order as number | undefined;
          }
          const customization = validateSkinCustomizationDecl(entry.customization, entry.id, skinReasons);
          if (skinReasons.length > 0) {
            console.warn(`[manifest] skin "${String(entry.id)}" rejected and isolated: ${skinReasons.join('; ')}`);
            return;
          }
          skins.push({
            ...(entry as object),
            ...(preview !== undefined ? { preview } : {}),
            ...(gallery !== undefined ? { gallery } : {}),
            ...(tags !== undefined ? { tags } : {}),
            ...(order !== undefined ? { order } : {}),
            ...(customization !== undefined ? { customization } : {}),
          } as unknown as SkinManifestEntry);
        });
      } else if (m.contributes.skins !== undefined) {
        reasons.push('contributes.skins must be an array');
      }
      if (Array.isArray(m.contributes.locales)) {
        locales = [];
        const seenLocaleLanguages = new Set<string>();
        m.contributes.locales.forEach((entry, i) => {
          if (!isObj(entry)) { reasons.push(`contributes.locales[${i}] must be an object`); return; }
          if (typeof entry.language !== 'string' || !LANGUAGE_TAG_PATTERN.test(entry.language)) {
            reasons.push(`contributes.locales[${i}].language must be a BCP-47 style tag`);
            return;
          }
          if (seenLocaleLanguages.has(entry.language)) {
            reasons.push(`contributes.locales has duplicate language: ${entry.language}`);
            return;
          }
          const table = validateLocaleTable(entry.table, `contributes.locales[${i}].table`, reasons);
          if (!table) return;
          seenLocaleLanguages.add(entry.language);
          locales.push({ language: entry.language, table });
        });
      } else if (m.contributes.locales !== undefined) {
        reasons.push('contributes.locales must be an array');
      }
      if (m.contributes.builtinModules !== undefined) {
        if (!Array.isArray(m.contributes.builtinModules)) {
          reasons.push('contributes.builtinModules must be an array');
        } else {
          builtinModules = [];
          const seenModuleIds = new Set<string>();
          m.contributes.builtinModules.forEach((entry, i) => {
            if (!isObj(entry)) { reasons.push(`contributes.builtinModules[${i}] must be an object`); return; }
            if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
              reasons.push(`contributes.builtinModules[${i}].id must match <ns>.<name>`); return;
            }
            if (seenModuleIds.has(entry.id)) {
              reasons.push(`contributes.builtinModules has duplicate id: ${entry.id}`); return;
            }
            seenModuleIds.add(entry.id);
            if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
              reasons.push(`contributes.builtinModules[${i}].name is required`); return;
            }
            const nameI18n = entry.nameI18n !== undefined
              ? validateLocalizedText(entry.nameI18n, `contributes.builtinModules[${i}].nameI18n`, reasons)
              : undefined;
            const description = typeof entry.description === 'string' && entry.description.trim().length > 0
              ? entry.description : undefined;
            if (entry.description !== undefined && description === undefined) {
              reasons.push(`contributes.builtinModules[${i}].description must be a non-empty string`); return;
            }
            const descriptionI18n = entry.descriptionI18n !== undefined
              ? validateLocalizedText(entry.descriptionI18n, `contributes.builtinModules[${i}].descriptionI18n`, reasons)
              : undefined;
            builtinModules.push({ id: entry.id, name: entry.name, ...(nameI18n ? { nameI18n } : {}), ...(description ? { description } : {}), ...(descriptionI18n ? { descriptionI18n } : {}) });
          });
        }
      }
    }
  }

  if (reasons.length > 0) throw new ManifestError(reasons);
  return {
    ...(m as unknown as PluginManifest),
    host: m.host as PluginHost,
    requires,
    optionalRequires,
    capabilities,
    configSchema,
    resourceBudget,
    ...(nameI18n ? { nameI18n } : {}),
    ...(descriptionI18n ? { descriptionI18n } : {}),
    ...(mcp ? { mcp } : {}),
    contributes: {
      skins,
      locales,
      ...(builtinModules.length > 0 ? { builtinModules } : {}),
    },
  };
}

/** 插件名按语言解析：`name` 是中文基准，`nameI18n` 提供其它语言覆盖。 */
export function resolvePluginName(manifest: PluginManifest, language: UiLanguage): string {
  return resolveManifestText(manifest.name, manifest.nameI18n, language);
}

/** 简介按语言解析；两个来源都没有时返回 undefined（管理面板据此显示占位文案）。 */
export function resolvePluginDescription(
  manifest: PluginManifest,
  language: UiLanguage,
): string | undefined {
  const override = manifest.descriptionI18n?.[language];
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return manifest.description;
}
