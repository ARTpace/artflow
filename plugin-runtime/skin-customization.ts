/**
 * skin-customization.ts —— 皮肤自声明配置协议（M2，对齐 dsh exposeSkinCustomization）。
 *
 * 语义（见《皮肤系统升级开发文档》第 5 节）：
 * - 皮肤在 manifest contributes.skins[].customization 里自声明设置项（≤12 项）；
 * - 存储：localStorage['bp-skin-config.<skinId>'] = { [key]: value }（JSON，try/catch 隔离）；
 * - 读取时逐键校验：值类型不匹配 schema 的键**丢弃**（回落 defaultValue），坏键不落盘；
 * - 不复用 plugin configSchema 通道（那个绑定插件启停 profile，语义不同）。
 * 本文件是纯函数 + 类型，零 DOM 依赖，可直测。
 */

export type SkinSettingField =
  | { key: string; type: 'boolean'; label: string; defaultValue: boolean }
  | { key: string; type: 'number'; label: string; defaultValue: number; min?: number; max?: number; step?: number }
  | { key: string; type: 'string'; label: string; defaultValue: string; maxLength?: number }
  | { key: string; type: 'select'; label: string; defaultValue: string; options: { value: string; label: string }[] };

/**
 * 声明式 HTML 属性绑定（M4）：boolean config 键 → documentElement 属性。
 * 填补声明式 binding 只能写 CSS 变量、无法设置 HTML 属性的缺口——依赖属性选择器的
 * 皮肤开关（如极光「显示辉光」→ data-bp-aurora-glow、深海「显示壁纸」→ data-bp-abyssal-wallpaper）
 * 靠它零代码落地，不再需要内置运行时底座插件做属性投影。
 */
export interface SkinAttributeBindingDecl {
  /** 目标属性名（data-* 或常规属性名，如 data-bp-aurora-glow）。 */
  name: string;
  /** 绑定的 config 键（必须是本 decl.settings 中已声明的 boolean 键）。 */
  key: string;
  /** config 为 true 时写入的属性值。 */
  on: string;
  /** config 为 false 时写入的属性值；缺省 = 移除该属性。 */
  off?: string;
}

/**
 * 声明式 class 绑定（M5）：boolean config 键 → documentElement class。
 * 与 attributeBindings 正交：class 型皮肤开关（组合态切换、框架/工具约定的状态类，
 * 如 `.is-compact` / `.is-cinematic`）靠它零代码落地；CSS 侧用 `.is-compact` 选择器消费。
 * 引擎切皮肤时按追踪清单整体移除，避免跨皮肤残留。
 */
export interface SkinClassBindingDecl {
  /** 绑定的 config 键（必须是本 decl.settings 中已声明的 boolean 键）。 */
  key: string;
  /** config 为 true 时添加的 class 名。 */
  on: string;
  /** config 为 false 时添加的 class 名（缺省 = 仅移除 on）。 */
  off?: string;
}

/**
 * 品牌资源声明（M6）：皮肤可携带的应用级品牌资源，供主进程消费。
 * 与 binding/attributeBindings/classBindings 正交：后者投影运行时配置到 DOM/CSS，
 * 前者是皮肤自带固定资源（图标/启动图），不依赖用户设置、随皮肤激活整体切换。
 * - appLogo：应用内 Logo 与系统托盘图标资源（相对皮肤包路径或 `data:` URI）。
 * - splash：启动图（splash）主题化，注入 splash 窗口 CSS 变量（背景/强调色）。
 */
export interface SkinBrandingDecl {
  /** 应用 Logo / 托盘图标图片资源（相对皮肤包路径或 `data:` URI）。 */
  appLogo?: string;
  /** 启动图主题化：背景与强调色，注入 splash 窗口的 CSS 变量。 */
  splash?: {
    /** 背景，CSS `background` 值（渐变或 `url(...)`）。 */
    background?: string;
    /** 强调色，CSS 颜色值，用于流光/进度条点缀。 */
    accent?: string;
  };
}

export interface SkinCustomizationDecl {
  title: string;
  settings: SkinSettingField[];
  /**
   * 声明式绑定（P0-2）：config 键 → CSS 自定义属性名。
   * 引擎在皮肤激活时自动把对应 config 值投影成 CSS 变量注入 documentElement，
   * 皮肤作者无需写 JS 消费配置即可「零代码暴露旋钮」（如颜色 string→--bp-skin-accent）。
   * 键必须是本 decl.settings 中已声明的键；值必须是合法自定义属性名（--[a-zA-Z][a-zA-Z0-9-]*）。
   */
  binding?: Record<string, string>;
  /**
   * 声明式属性绑定（M4）：boolean config 键 → documentElement 属性。
   * 引擎在皮肤激活/配置变更时自动写入或移除属性；切皮肤时按追踪清单整体清理，
   * 避免跨皮肤残留。键必须是已声明的 boolean 设置，属性名不可重复。
   */
  attributeBindings?: SkinAttributeBindingDecl[];
  /**
   * 声明式 class 绑定（M5）：boolean config 键 → documentElement class。
   * 与 attributeBindings 正交——class 型皮肤开关（`.is-compact` 等组合态）走这里。
   * class 名全局不可重复（含同一批次的 on/off 互撞），否则两条绑定会互相打架。
   */
  classBindings?: SkinClassBindingDecl[];
  /**
   * 品牌资源声明（M6）：皮肤自带固定资源（Logo/启动图），供主进程 splash 与托盘消费。
   * 与 binding/classBindings 正交——不依赖用户设置，随皮肤激活整体切换。
   */
  branding?: SkinBrandingDecl;
}

export const SKIN_SETTING_MAX_COUNT = 12;
export const SKIN_SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
export const SKIN_ATTRIBUTE_BINDING_MAX = 8;
export const SKIN_ATTRIBUTE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/;
export const SKIN_CLASS_BINDING_MAX = 8;
export const SKIN_CLASS_NAME_PATTERN = /^[a-zA-Z_-][a-zA-Z0-9_-]*$/;

export const skinConfigStorageKey = (skinId: string): string => `bp-skin-config.${skinId}`;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * manifest 校验用：合法 → 干净 decl；不合法 → 返回 null 并把原因追加进 reasons。
 * 键规则：唯一 + ^[a-zA-Z][a-zA-Z0-9_]{0,31}$（与文档一致）。
 */
export function validateSkinCustomizationDecl(
  raw: unknown,
  skinId: string,
  reasons: string[],
): SkinCustomizationDecl | null {
  if (raw === undefined) return null;
  const prefix = `contributes.skins (id=${skinId}).customization`;
  if (!isObj(raw)) { reasons.push(`${prefix} must be an object`); return null; }
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0) {
    reasons.push(`${prefix}.title must be a non-empty string`);
    return null;
  }
  if (!Array.isArray(raw.settings)) { reasons.push(`${prefix}.settings must be an array`); return null; }
  if (raw.settings.length > SKIN_SETTING_MAX_COUNT) {
    reasons.push(`${prefix}.settings must have at most ${SKIN_SETTING_MAX_COUNT} entries`);
    return null;
  }
  const settings: SkinSettingField[] = [];
  const seenKeys = new Set<string>();
  raw.settings.forEach((entry, i) => {
    const where = `${prefix}.settings[${i}]`;
    if (!isObj(entry)) { reasons.push(`${where} must be an object`); return; }
    if (typeof entry.key !== 'string' || !SKIN_SETTING_KEY_PATTERN.test(entry.key)) {
      reasons.push(`${where}.key must match ^[a-zA-Z][a-zA-Z0-9_]{0,31}$`);
      return;
    }
    if (seenKeys.has(entry.key)) { reasons.push(`${where}.key is duplicated: ${entry.key}`); return; }
    seenKeys.add(entry.key);
    if (typeof entry.label !== 'string' || entry.label.trim().length === 0) {
      reasons.push(`${where}.label must be a non-empty string`);
      return;
    }
    if (entry.type === 'boolean') {
      if (typeof entry.defaultValue !== 'boolean') { reasons.push(`${where}.defaultValue must be boolean`); return; }
      settings.push({ key: entry.key, type: 'boolean', label: entry.label, defaultValue: entry.defaultValue });
    } else if (entry.type === 'number') {
      if (typeof entry.defaultValue !== 'number' || !Number.isFinite(entry.defaultValue)) {
        reasons.push(`${where}.defaultValue must be a finite number`);
        return;
      }
      const num: { key: string; type: 'number'; label: string; defaultValue: number; min?: number; max?: number; step?: number } = {
        key: entry.key, type: 'number', label: entry.label, defaultValue: entry.defaultValue,
      };
      for (const opt of ['min', 'max', 'step'] as const) {
        if (entry[opt] !== undefined && (typeof entry[opt] !== 'number' || !Number.isFinite(entry[opt] as number))) {
          reasons.push(`${where}.${opt} must be a finite number`);
          return;
        }
        if (entry[opt] !== undefined) num[opt] = entry[opt] as number;
      }
      if (num.min !== undefined && num.max !== undefined && num.min > num.max) {
        reasons.push(`${where}.min must be <= max`);
        return;
      }
      settings.push(num);
    } else if (entry.type === 'string') {
      if (typeof entry.defaultValue !== 'string') { reasons.push(`${where}.defaultValue must be a string`); return; }
      const str: { key: string; type: 'string'; label: string; defaultValue: string; maxLength?: number } = {
        key: entry.key, type: 'string', label: entry.label, defaultValue: entry.defaultValue,
      };
      const maxLength = entry.maxLength;
      if (maxLength !== undefined) {
        if (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 1) {
          reasons.push(`${where}.maxLength must be a positive integer`);
          return;
        }
        str.maxLength = maxLength;
      }
      if (str.maxLength !== undefined && str.defaultValue.length > str.maxLength) {
        reasons.push(`${where}.defaultValue exceeds maxLength`);
        return;
      }
      settings.push(str);
    } else if (entry.type === 'select') {
      if (typeof entry.defaultValue !== 'string') { reasons.push(`${where}.defaultValue must be a string`); return; }
      if (!Array.isArray(entry.options) || entry.options.length === 0) {
        reasons.push(`${where}.options must be a non-empty array`);
        return;
      }
      const optionValues = new Set<string>();
      const options: { value: string; label: string }[] = [];
      for (const option of entry.options) {
        if (!isObj(option) || typeof option.value !== 'string' || option.value.length === 0
          || typeof option.label !== 'string' || option.label.length === 0) {
          reasons.push(`${where}.options entries must be { value, label } non-empty strings`);
          return;
        }
        if (optionValues.has(option.value)) { reasons.push(`${where}.options has duplicate value: ${option.value}`); return; }
        optionValues.add(option.value);
        options.push({ value: option.value, label: option.label });
      }
      if (!optionValues.has(entry.defaultValue)) {
        reasons.push(`${where}.defaultValue must be one of options`);
        return;
      }
      settings.push({ key: entry.key, type: 'select', label: entry.label, defaultValue: entry.defaultValue, options });
    } else {
      reasons.push(`${where}.type must be boolean, number, string, or select`);
      return;
    }
  });
  if (reasons.length > 0) return null; // forEach 内的 return 只结束单条迭代，统一在这里把关
  // binding（P0-2）：声明式 config→CSS 变量映射；键必须指向已声明设置，值必须合法自定义属性名。
  let binding: Record<string, string> | undefined;
  if (raw.binding !== undefined) {
    if (!isObj(raw.binding) || Array.isArray(raw.binding)) {
      reasons.push(`${prefix}.binding must be an object`);
      return null;
    }
    const b: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.binding)) {
      if (!seenKeys.has(key)) { reasons.push(`${prefix}.binding references unknown setting key: ${key}`); return null; }
      if (typeof value !== 'string' || !/^--[a-zA-Z][a-zA-Z0-9-]*$/.test(value)) {
        reasons.push(`${prefix}.binding["${key}"] must be a CSS custom property name like "--bp-skin-accent"`);
        return null;
      }
      b[key] = value;
    }
    binding = b;
  }
  // attributeBindings（M4）：boolean config 键 → documentElement 属性；键必须指向已声明的 boolean 设置。
  let attributeBindings: SkinAttributeBindingDecl[] | undefined;
  if (raw.attributeBindings !== undefined) {
    if (!Array.isArray(raw.attributeBindings) || raw.attributeBindings.length === 0
      || raw.attributeBindings.length > SKIN_ATTRIBUTE_BINDING_MAX) {
      reasons.push(`${prefix}.attributeBindings must be a non-empty array of at most ${SKIN_ATTRIBUTE_BINDING_MAX} entries`);
      return null;
    }
    const booleanKeys = new Set(settings.filter(field => field.type === 'boolean').map(field => field.key));
    const list: SkinAttributeBindingDecl[] = [];
    const seenNames = new Set<string>();
    raw.attributeBindings.forEach((entry, i) => {
      const where = `${prefix}.attributeBindings[${i}]`;
      if (!isObj(entry)) { reasons.push(`${where} must be an object`); return; }
      if (typeof entry.name !== 'string' || !SKIN_ATTRIBUTE_NAME_PATTERN.test(entry.name)) {
        reasons.push(`${where}.name must match ^[a-zA-Z][a-zA-Z0-9-]*$ (data-* allowed)`);
        return;
      }
      if (seenNames.has(entry.name)) { reasons.push(`${where}.name is duplicated: ${entry.name}`); return; }
      seenNames.add(entry.name);
      if (typeof entry.key !== 'string' || !booleanKeys.has(entry.key)) {
        reasons.push(`${where}.key must reference a declared boolean setting`);
        return;
      }
      if (typeof entry.on !== 'string' || entry.on.length === 0 || entry.on.length > 64) {
        reasons.push(`${where}.on must be a non-empty string (<=64 chars)`);
        return;
      }
      let off: string | undefined;
      if (entry.off !== undefined) {
        if (typeof entry.off !== 'string' || entry.off.length > 64) {
          reasons.push(`${where}.off must be a string (<=64 chars) when present`);
          return;
        }
        off = entry.off;
      }
      list.push({ name: entry.name, key: entry.key, on: entry.on, ...(off !== undefined ? { off } : {}) });
    });
    if (reasons.length > 0) return null; // forEach 内的 return 只结束单条迭代，统一在这里把关
    attributeBindings = list;
  }
  // classBindings（M5）：boolean config 键 → documentElement class；class 名全局不可重复（含 on/off 互撞）。
  let classBindings: SkinClassBindingDecl[] | undefined;
  if (raw.classBindings !== undefined) {
    if (!Array.isArray(raw.classBindings) || raw.classBindings.length === 0
      || raw.classBindings.length > SKIN_CLASS_BINDING_MAX) {
      reasons.push(`${prefix}.classBindings must be a non-empty array of at most ${SKIN_CLASS_BINDING_MAX} entries`);
      return null;
    }
    const booleanKeys = new Set(settings.filter(field => field.type === 'boolean').map(field => field.key));
    const list: SkinClassBindingDecl[] = [];
    const seenClasses = new Set<string>();
    raw.classBindings.forEach((entry, i) => {
      const where = `${prefix}.classBindings[${i}]`;
      if (!isObj(entry)) { reasons.push(`${where} must be an object`); return; }
      if (typeof entry.key !== 'string' || !booleanKeys.has(entry.key)) {
        reasons.push(`${where}.key must reference a declared boolean setting`);
        return;
      }
      const names: string[] = [];
      let ok = true;
      for (const field of ['on', 'off'] as const) {
        const value = entry[field];
        if (field === 'off' && value === undefined) continue;
        if (typeof value !== 'string' || !SKIN_CLASS_NAME_PATTERN.test(value) || value.length > 64) {
          reasons.push(`${where}.${field} must be a valid class name (<=64 chars)`);
          ok = false;
          return;
        }
        if (seenClasses.has(value)) { reasons.push(`${where}.${field} is duplicated: ${value}`); ok = false; return; }
        seenClasses.add(value);
        names.push(value);
      }
      if (!ok) return;
      const off = typeof entry.off === 'string' ? entry.off : undefined;
      list.push({ key: entry.key, on: names[0], ...(off !== undefined ? { off } : {}) });
    });
    if (reasons.length > 0) return null; // forEach 内的 return 只结束单条迭代，统一在这里把关
    classBindings = list;
  }
  // branding（M6）：皮肤自带固定品牌资源（Logo/启动图），供主进程 splash/托盘消费。
  let branding: SkinBrandingDecl | undefined;
  if (raw.branding !== undefined) {
    if (!isObj(raw.branding) || Array.isArray(raw.branding)) {
      reasons.push(`${prefix}.branding must be an object`);
      return null;
    }
    const brand: SkinBrandingDecl = {};
    if (raw.branding.appLogo !== undefined) {
      if (typeof raw.branding.appLogo !== 'string' || raw.branding.appLogo.trim().length === 0) {
        reasons.push(`${prefix}.branding.appLogo must be a non-empty string`);
        return null;
      }
      brand.appLogo = raw.branding.appLogo;
    }
    if (raw.branding.splash !== undefined) {
      if (!isObj(raw.branding.splash) || Array.isArray(raw.branding.splash)) {
        reasons.push(`${prefix}.branding.splash must be an object`);
        return null;
      }
      const splash: { background?: string; accent?: string } = {};
      if (raw.branding.splash.background !== undefined) {
        if (typeof raw.branding.splash.background !== 'string' || raw.branding.splash.background.trim().length === 0) {
          reasons.push(`${prefix}.branding.splash.background must be a non-empty string`);
          return null;
        }
        splash.background = raw.branding.splash.background;
      }
      if (raw.branding.splash.accent !== undefined) {
        if (typeof raw.branding.splash.accent !== 'string' || raw.branding.splash.accent.trim().length === 0) {
          reasons.push(`${prefix}.branding.splash.accent must be a non-empty string`);
          return null;
        }
        splash.accent = raw.branding.splash.accent;
      }
      if (Object.keys(splash).length > 0) brand.splash = splash;
    }
    if (Object.keys(brand).length > 0) branding = brand;
  }
  return {
    title: raw.title,
    settings,
    ...(binding ? { binding } : {}),
    ...(attributeBindings ? { attributeBindings } : {}),
    ...(classBindings ? { classBindings } : {}),
    ...(branding ? { branding } : {}),
  };
}

/** 单个值是否符合该字段类型（select 额外要求值在选项内；string 校验 maxLength；number 校验 min/max）。 */
export function validateSkinConfigValue(field: SkinSettingField, value: unknown): boolean {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (field.min !== undefined && value < field.min) return false;
      if (field.max !== undefined && value > field.max) return false;
      return true;
    }
    case 'string':
      if (typeof value !== 'string') return false;
      if (field.maxLength !== undefined && value.length > field.maxLength) return false;
      return true;
    case 'select':
      return typeof value === 'string' && field.options.some(option => option.value === value);
  }
}

export interface SkinConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 读取皮肤配置：defaults + 存储值（逐键校验，坏键丢弃）。
 * 存储本身损坏（JSON 解析失败/非对象）→ 仅用 defaults，不抛错。
 */
export function readSkinConfig(
  storage: SkinConfigStorage,
  skinId: string,
  decl: SkinCustomizationDecl | null | undefined,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const byKey = new Map<string, SkinSettingField>();
  for (const field of decl?.settings ?? []) {
    defaults[field.key] = field.defaultValue;
    byKey.set(field.key, field);
  }
  if (!decl || byKey.size === 0) return defaults;
  let stored: Record<string, unknown> = {};
  try {
    const raw = storage.getItem(skinConfigStorageKey(skinId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isObj(parsed)) stored = parsed;
    }
  } catch { /* 存储损坏：回落 defaults */ }
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, field] of byKey) {
    if (key in stored && validateSkinConfigValue(field, stored[key])) {
      result[key] = stored[key];
    }
  }
  return result;
}

/**
 * 合并补丁：未知键丢弃；类型不符的键丢弃（保留旧值/默认值）；
 * 返回 { config, changed }，changed=false 表示补丁没有引入任何合法变更。
 */
export function mergeSkinConfig(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  decl: SkinCustomizationDecl,
): { config: Record<string, unknown>; changed: boolean } {
  const config: Record<string, unknown> = { ...current };
  let changed = false;
  for (const [key, field] of decl.settings.map(field => [field.key, field] as const)) {
    if (!(key in patch)) continue;
    const value = (patch as Record<string, unknown>)[key];
    if (validateSkinConfigValue(field, value)) {
      if (config[key] !== value) changed = true;
      config[key] = value;
    }
  }
  return { config, changed };
}

/**
 * 把单个配置值序列化为 CSS 自定义属性取值（P0-2 桥接用）。
 * - boolean → '1' / '0'（可直接喂 opacity/scale/calc 等数值场景）
 * - number  → 十进制字符串
 * - string / select → 原值（如颜色 '#a855f7'）
 * 皮肤作者据此在 customization.binding 选用能产出合法 CSS 的取值类型。
 */
export function configValueToCssToken(value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/**
 * 声明式桥接（P0-2）：把 customization.binding 映射的 config 键投影成 CSS 变量名→取值。
 * 引擎据此在皮肤激活时自动注入 documentElement，无需皮肤写 JS 消费配置。纯函数、零 DOM、可直测。
 */
export function resolveSkinConfigBindings(
  binding: Record<string, string> | undefined | null,
  config: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!binding) return out;
  for (const [key, varName] of Object.entries(binding)) {
    if (key in config) out[varName] = configValueToCssToken(config[key]);
  }
  return out;
}

/**
 * 声明式属性桥接（M4）：把 attributeBindings 映射的 boolean config 投影成「属性名 → 属性值」。
 * true → on 值；false 且声明了 off → off 值；false 但未声明 off → 不出现在结果里（引擎按移除处理）。
 * 纯函数、零 DOM、可直测。
 */
export function resolveSkinAttributeBindings(
  bindings: SkinAttributeBindingDecl[] | undefined | null,
  config: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!bindings) return out;
  for (const binding of bindings) {
    const value = config[binding.key];
    if (value === true) out[binding.name] = binding.on;
    else if (value === false && binding.off !== undefined) out[binding.name] = binding.off;
  }
  return out;
}

/**
 * 声明式 class 桥接（M5）：把 classBindings 映射的 boolean config 投影成「class 名 → 是否启用」。
 * true → on 添加、off 移除；false → on 移除、off 添加（声明了才动）。
 * 非 boolean 值不出现在结果里（引擎按不处理对待，与 attribute 桥接一致）。
 * 纯函数、零 DOM、可直测。
 */
export function resolveSkinClassBindings(
  bindings: SkinClassBindingDecl[] | undefined | null,
  config: Record<string, unknown>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!bindings) return out;
  for (const binding of bindings) {
    const value = config[binding.key];
    if (value === true) {
      out[binding.on] = true;
      if (binding.off !== undefined) out[binding.off] = false;
    } else if (value === false) {
      out[binding.on] = false;
      if (binding.off !== undefined) out[binding.off] = true;
    }
  }
  return out;
}
