/**
 * Declarative plugin folder. Reads JSON manifests only.
 * A manifest with an entry, script, or any runtime other than "declarative" is ignored.
 *
 * 两种声明式贡献（至少要有一种，否则是个什么都不做的空插件）：
 *   1. `formatAliases` —— 扩展名 → 已注册格式处理器的别名；
 *   2. `locales`       —— 界面语言包补丁，表体可内联（`table`，适合小包）或放分片文件
 *                        （`file`，适合完整一档文案）。分片由**主进程**读取校验后随
 *                        listDeclarativePlugins 一并返回，渲染进程不碰文件系统。
 *
 * 分片存在的理由：manifest 上限 16KB，而完整一档文案表约 18KB —— 直接内联必被拒。
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_PLUGINS = 32;
/**
 * manifest 文件大小上限。**必须 ≥ 单个皮肤包的实际体积** —— 声明式皮肤允许把
 * css / preview / gallery.poster 内联成 data URI（对应下面的 MAX_SKIN_CSS_BYTES /
 * MAX_SKIN_STRING_BYTES / MAX_SKIN_MEDIA_BYTES），一个带预览图的皮肤包很容易上百 KB。
 * 早期定 16KB 是为了挡"整档语言文案内联"，但顺带把带图皮肤也挡掉了（用户实测：621KB 的
 * builtin.skins-abyssal-serenade 被静默跳过）。真正的逐字段限制在 parseSkin* 里，这里放宽到 8MB。
 */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ALIASES = 16;
/** 单个语言包分片上限：完整一档约 18KB，512KB 留足余量。 */
const MAX_LOCALE_SHARD_BYTES = 512 * 1024;
/** 一个插件最多声明几个语言分片（语言数，不是分片文件数）。 */
const MAX_LOCALE_SHARDS = 8;
/**
 * 表体校验阈值，**必须与渲染进程 plugins/manifest.ts 的
 * MAX_LOCALE_SEGMENTS / MAX_LOCALE_DEPTH 保持一致** —— 这里是外部不可信输入的第一道闸，
 * 那边是统一契约。scripts/check-plugin-openings.cjs 用同一组夹具交叉验证两边判定一致。
 */
const MAX_LOCALE_SEGMENTS = 256;
const MAX_LOCALE_ARRAY = 64;
const MAX_LOCALE_DEPTH = 4;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const ALLOWED_KEYS = new Set(['id', 'name', 'version', 'runtime', 'formatAliases', 'description', 'locales', 'contributes']);
/** 声明式皮肤可携带的顶层字段（与 builtin contributes.skins 同语义）。 */
const SKIN_ENTRY_KEYS = new Set(['id', 'name', 'nameI18n', 'mode', 'tokens', 'order', 'tags', 'css', 'customization', 'preview', 'gallery']);
const SKIN_SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const SKIN_CSS_VAR_PATTERN = /^--[a-zA-Z][a-zA-Z0-9-]*$/;
const SKIN_ATTRIBUTE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const SKIN_CLASS_NAME_PATTERN = /^[a-zA-Z_-][a-zA-Z0-9_-]*$/;
const MAX_SKIN_SETTING_COUNT = 12;
const MAX_SKIN_ATTRIBUTE_BINDINGS = 8;
const MAX_SKIN_CLASS_BINDINGS = 8;
const MAX_SKIN_CSS_BYTES = 2 * 1024 * 1024;
const MAX_SKIN_STRING_BYTES = 3 * 1024 * 1024;
const MAX_SKIN_MEDIA_BYTES = 6 * 1024 * 1024;

/**
 * 表体：只接受字符串、数组、纯对象。
 * 函数（底座那 33 条带计数的文案）在 JSON 里表达不了 —— 属于声明式通道的固有边界，
 * 那几条会回落到底座 en 档，而不是被静默丢掉计数。数组必须放行（`quickPrompts`
 * 就是 28 条对象数组），否则"完整一档"根本写不出来。
 *
 * 失败返回 undefined（表体里 undefined 是合法缺席，不能当失败信号），与
 * plugins/manifest.ts 里 validateLocaleNode 的判定保持一致。
 */
function parseLocaleNode(value, depth) {
  if (depth > MAX_LOCALE_DEPTH) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_LOCALE_ARRAY) return undefined;
    const out = [];
    for (const entry of value) {
      const node = parseLocaleNode(entry, depth + 1);
      if (node === undefined) return undefined;
      out.push(node);
    }
    return out;
  }
  if (!value || typeof value !== 'object') return undefined;
  const keys = Object.keys(value);
  if (keys.length > MAX_LOCALE_SEGMENTS) return undefined;
  const out = {};
  for (const key of keys) {
    const node = parseLocaleNode(value[key], depth + 1);
    if (node === undefined) return undefined;
    out[key] = node;
  }
  return out;
}

function parseLocaleTable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = parseLocaleNode(value, 0);
  return parsed === undefined ? null : parsed;
}

/**
 * 皮肤 tokens：递归只接受 string | number | boolean | 纯对象（拒绝数组/函数）。
 * 这是把外部不可信输入注入 CSS 变量前的第一道闸——禁止数组可挡掉「颜色数组混进单值槽位」，
 * 也避免 token 形状失控。深度/键数设限，与语言包同一档风控。
 */
function parseSkinTokensNode(value, depth) {
  if (depth > 6) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > 256) return undefined;
  const out = {};
  for (const key of keys) {
    const node = parseSkinTokensNode(value[key], depth + 1);
    if (node === undefined) return undefined;
    out[key] = node;
  }
  return out;
}

/** 皮肤展示名多语补丁：{ lang: text }，语言码走 LANGUAGE_PATTERN，文案限长。 */
function parseSkinNameI18n(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [lang, text] of Object.entries(value)) {
    if (!LANGUAGE_PATTERN.test(lang) || typeof text !== 'string' || text.length > 200) return null;
    out[lang] = text.slice(0, 200);
  }
  return out;
}

/**
 * 皮肤 customization 声明（与 plugins/skin-customization.ts 同语义，主进程侧独立校验副本）。
 * 返回声明对象或 null（整插件拒载）。binding 将 config 键映射到 CSS 自定义属性，引擎在皮肤
 * 激活时自动投影，皮肤无需自带 JS（这正是声明式皮肤能零代码暴露旋钮的原因）。
 */
function parseSkinCustomizationDecl(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.title !== 'string' || value.title.trim().length === 0) return null;
  if (!Array.isArray(value.settings)) return null;
  if (value.settings.length > MAX_SKIN_SETTING_COUNT) return null;
  const settings = [];
  const seenKeys = new Set();
  for (const entry of value.settings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.key !== 'string' || !SKIN_SETTING_KEY_PATTERN.test(entry.key)) return null;
    if (seenKeys.has(entry.key)) return null;
    seenKeys.add(entry.key);
    if (typeof entry.label !== 'string' || entry.label.trim().length === 0) return null;
    if (entry.type === 'boolean') {
      if (typeof entry.defaultValue !== 'boolean') return null;
      settings.push({ key: entry.key, type: 'boolean', label: entry.label, defaultValue: entry.defaultValue });
    } else if (entry.type === 'number') {
      if (typeof entry.defaultValue !== 'number' || !Number.isFinite(entry.defaultValue)) return null;
      const num = { key: entry.key, type: 'number', label: entry.label, defaultValue: entry.defaultValue };
      for (const opt of ['min', 'max', 'step']) {
        if (entry[opt] !== undefined) {
          if (typeof entry[opt] !== 'number' || !Number.isFinite(entry[opt])) return null;
          num[opt] = entry[opt];
        }
      }
      if (num.min !== undefined && num.max !== undefined && num.min > num.max) return null;
      settings.push(num);
    } else if (entry.type === 'string') {
      if (typeof entry.defaultValue !== 'string') return null;
      const str = { key: entry.key, type: 'string', label: entry.label, defaultValue: entry.defaultValue };
      if (entry.maxLength !== undefined) {
        if (typeof entry.maxLength !== 'number' || !Number.isInteger(entry.maxLength) || entry.maxLength < 1) return null;
        str.maxLength = entry.maxLength;
      }
      if (str.maxLength !== undefined && str.defaultValue.length > str.maxLength) return null;
      settings.push(str);
    } else if (entry.type === 'select') {
      if (typeof entry.defaultValue !== 'string') return null;
      if (!Array.isArray(entry.options) || entry.options.length === 0) return null;
      const optValues = new Set();
      const options = [];
      for (const option of entry.options) {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
        if (typeof option.value !== 'string' || option.value.length === 0 || typeof option.label !== 'string' || option.label.length === 0) return null;
        if (optValues.has(option.value)) return null;
        optValues.add(option.value);
        options.push({ value: option.value, label: option.label });
      }
      if (!optValues.has(entry.defaultValue)) return null;
      settings.push({ key: entry.key, type: 'select', label: entry.label, defaultValue: entry.defaultValue, options });
    } else {
      return null;
    }
  }
  let binding;
  if (value.binding !== undefined) {
    if (!value.binding || typeof value.binding !== 'object' || Array.isArray(value.binding)) return null;
    binding = {};
    for (const [key, bval] of Object.entries(value.binding)) {
      if (!seenKeys.has(key)) return null;
      if (typeof bval !== 'string' || !SKIN_CSS_VAR_PATTERN.test(bval)) return null;
      binding[key] = bval;
    }
  }
  // attributeBindings（M4）：boolean config 键 → documentElement 属性（属性选择器型皮肤开关，
  // 如极光辉光 / 深海壁纸）。键必须指向已声明的 boolean 设置，属性名不可重复。
  let attributeBindings;
  if (value.attributeBindings !== undefined) {
    if (!Array.isArray(value.attributeBindings) || value.attributeBindings.length === 0
      || value.attributeBindings.length > MAX_SKIN_ATTRIBUTE_BINDINGS) return null;
    const booleanKeys = new Set(settings.filter(field => field.type === 'boolean').map(field => field.key));
    attributeBindings = [];
    const seenNames = new Set();
    for (const entry of value.attributeBindings) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      if (typeof entry.name !== 'string' || !SKIN_ATTRIBUTE_NAME_PATTERN.test(entry.name)) return null;
      if (seenNames.has(entry.name)) return null;
      seenNames.add(entry.name);
      if (typeof entry.key !== 'string' || !booleanKeys.has(entry.key)) return null;
      if (typeof entry.on !== 'string' || entry.on.length === 0 || entry.on.length > 64) return null;
      if (entry.off !== undefined && (typeof entry.off !== 'string' || entry.off.length > 64)) return null;
      attributeBindings.push({
        name: entry.name,
        key: entry.key,
        on: entry.on,
        ...(entry.off !== undefined ? { off: entry.off } : {}),
      });
    }
  }
  // classBindings（M5）：boolean config 键 → documentElement class（class 型皮肤开关，如 .is-compact）。
  // class 名全局不可重复（含同一批次的 on/off 互撞），否则两条绑定会互相打架。
  let classBindings;
  if (value.classBindings !== undefined) {
    if (!Array.isArray(value.classBindings) || value.classBindings.length === 0
      || value.classBindings.length > MAX_SKIN_CLASS_BINDINGS) return null;
    const booleanKeys = new Set(settings.filter(field => field.type === 'boolean').map(field => field.key));
    classBindings = [];
    const seenClasses = new Set();
    for (const entry of value.classBindings) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      if (typeof entry.key !== 'string' || !booleanKeys.has(entry.key)) return null;
      for (const field of ['on', 'off']) {
        const cls = entry[field];
        if (field === 'off' && cls === undefined) continue;
        if (typeof cls !== 'string' || !SKIN_CLASS_NAME_PATTERN.test(cls) || cls.length > 64) return null;
        if (seenClasses.has(cls)) return null;
        seenClasses.add(cls);
      }
      classBindings.push({
        key: entry.key,
        on: entry.on,
        ...(entry.off !== undefined ? { off: entry.off } : {}),
      });
    }
  }
  // branding（M6）：皮肤自带固定品牌资源（Logo/启动图），供主进程 splash/托盘消费。
  let branding;
  if (value.branding !== undefined) {
    if (!value.branding || typeof value.branding !== 'object' || Array.isArray(value.branding)) return null;
    branding = {};
    if (value.branding.appLogo !== undefined) {
      if (typeof value.branding.appLogo !== 'string' || value.branding.appLogo.trim().length === 0) return null;
      branding.appLogo = value.branding.appLogo;
    }
    if (value.branding.splash !== undefined) {
      if (!value.branding.splash || typeof value.branding.splash !== 'object' || Array.isArray(value.branding.splash)) return null;
      const splash = {};
      if (value.branding.splash.background !== undefined) {
        if (typeof value.branding.splash.background !== 'string' || value.branding.splash.background.trim().length === 0) return null;
        splash.background = value.branding.splash.background;
      }
      if (value.branding.splash.accent !== undefined) {
        if (typeof value.branding.splash.accent !== 'string' || value.branding.splash.accent.trim().length === 0) return null;
        splash.accent = value.branding.splash.accent;
      }
      if (Object.keys(splash).length > 0) branding.splash = splash;
    }
    if (Object.keys(branding).length === 0) branding = undefined;
  }
  return { title: value.title, settings, ...(binding ? { binding } : {}), ...(attributeBindings ? { attributeBindings } : {}), ...(classBindings ? { classBindings } : {}), ...(branding ? { branding } : {}) };
}

/** 预览图：{ light?: dataURI, dark?: dataURI }，每值限长、总量限长（data URI 可能很大）。 */
function parseSkinPreview(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > 8) return null;
  const out = {};
  let total = 0;
  for (const key of keys) {
    const v = value[key];
    if (typeof v !== 'string' || v.length > MAX_SKIN_STRING_BYTES) return null;
    total += v.length;
    if (total > MAX_SKIN_MEDIA_BYTES) return null;
    out[key] = v;
  }
  return out;
}

/** Gallery 元数据：family/title 必填，poster 可为背景 data URI。 */
function parseSkinGallery(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['family', 'title', 'titleEn', 'description', 'descriptionEn', 'credit']) {
    const v = value[key];
    if (v !== undefined) {
      if (typeof v !== 'string' || v.length > 200) return null;
      out[key] = v;
    }
  }
  if (value.poster !== undefined) {
    if (typeof value.poster !== 'string' || value.poster.length > MAX_SKIN_STRING_BYTES) return null;
    out.poster = value.poster;
  }
  if (!out.family || !out.title) return null;
  return out;
}

/**
 * 解析 contributes.skins（外部不可信输入）。返回皮肤数组；非法返回 null（整插件拒载）。
 * 放行 id/name/nameI18n/mode/tokens/order/tags/css/customization/preview/gallery：
 * css 是静态皮肤覆盖层（渲染端走 registerSkinCss 静态消毒），customization 经上面独立校验，
 * preview/gallery 为限长 data URI。binding 让皮肤零代码暴露 config 旋钮（CSS 变量），
 * attributeBindings 让 boolean 开关零代码投影 HTML 属性（属性选择器型皮肤开关）。
 */
function parseSkinDeclarations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const skins = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (Object.keys(entry).some(key => !SKIN_ENTRY_KEYS.has(key))) return null;
    if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) return null;
    if (typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > 80) return null;
    const mode = entry.mode === undefined ? 'dark' : entry.mode;
    if (mode !== 'dark' && mode !== 'light') return null;
    const nameI18n = entry.nameI18n === undefined ? undefined : parseSkinNameI18n(entry.nameI18n);
    if (entry.nameI18n !== undefined && !nameI18n) return null;
    const tokens = entry.tokens === undefined ? undefined : parseSkinTokensNode(entry.tokens, 0);
    if (entry.tokens !== undefined && tokens === undefined) return null;
    let order;
    if (entry.order !== undefined) {
      if (typeof entry.order !== 'number' || !Number.isFinite(entry.order)) return null;
      order = entry.order;
    }
    let tags;
    if (entry.tags !== undefined) {
      if (!Array.isArray(entry.tags) || entry.tags.length > 32) return null;
      if (!entry.tags.every(t => typeof t === 'string' && t.length > 0 && t.length <= 40)) return null;
      tags = entry.tags;
    }
    let css;
    if (entry.css !== undefined) {
      if (typeof entry.css !== 'string' || entry.css.length > MAX_SKIN_CSS_BYTES) return null;
      css = entry.css;
    }
    const customization = entry.customization === undefined ? undefined : parseSkinCustomizationDecl(entry.customization);
    if (entry.customization !== undefined && !customization) return null;
    const preview = entry.preview === undefined ? undefined : parseSkinPreview(entry.preview);
    if (entry.preview !== undefined && !preview) return null;
    const gallery = entry.gallery === undefined ? undefined : parseSkinGallery(entry.gallery);
    if (entry.gallery !== undefined && !gallery) return null;
    skins.push({
      id: entry.id,
      name: entry.name,
      mode,
      ...(nameI18n ? { nameI18n } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(order !== undefined ? { order } : {}),
      ...(tags ? { tags } : {}),
      ...(css !== undefined ? { css } : {}),
      ...(customization ? { customization } : {}),
      ...(preview ? { preview } : {}),
      ...(gallery ? { gallery } : {}),
    });
  }
  return skins;
}

/** 校验 locales 声明（不做 I/O）。返回 [{language, table|file}]；非法返回 null。 */
function parseLocaleDeclarations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LOCALE_SHARDS) return null;
  const declarations = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (Object.keys(entry).some(key => key !== 'language' && key !== 'file' && key !== 'table')) return null;
    if (typeof entry.language !== 'string' || !LANGUAGE_PATTERN.test(entry.language)) return null;
    if (seen.has(entry.language)) return null;
    const hasFile = typeof entry.file === 'string';
    const hasTable = entry.table !== undefined;
    // 必须且只能给一种来源，避免「内联表被分片静默覆盖」这类歧义
    if (hasFile === hasTable) return null;
    if (hasFile) {
      if (entry.file.length === 0 || entry.file.length > 200) return null;
      if (!entry.file.endsWith('.json')) return null;
      const segments = entry.file.split(/[\\/]/);
      if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return null;
      declarations.push({ language: entry.language, file: entry.file });
      seen.add(entry.language);
      continue;
    }
    const table = parseLocaleTable(entry.table);
    if (!table) return null;
    declarations.push({ language: entry.language, table });
    seen.add(entry.language);
  }
  return declarations;
}

function parseDeclarativeManifest(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !ALLOWED_KEYS.has(key))) return null;
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return null;
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 80) return null;
  const runtime = value.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
  if (Object.keys(runtime).some(key => key !== 'mode')) return null;
  if (runtime.mode !== 'declarative') return null;

  const formatAliases = [];
  if (value.formatAliases !== undefined) {
    if (!Array.isArray(value.formatAliases) || value.formatAliases.length > MAX_ALIASES) return null;
    for (const alias of value.formatAliases) {
      if (!alias || typeof alias !== 'object' || Array.isArray(alias)) return null;
      if (Object.keys(alias).some(key => key !== 'extension' && key !== 'handlerId')) return null;
      if (typeof alias.extension !== 'string' || !EXTENSION_PATTERN.test(alias.extension)) return null;
      if (typeof alias.handlerId !== 'string' || !ID_PATTERN.test(alias.handlerId)) return null;
      formatAliases.push({ extension: alias.extension, handlerId: alias.handlerId });
    }
  }

  const locales = parseLocaleDeclarations(value.locales);
  if (!locales) return null;

  // 声明式通道目前只在 contributes 里支持 skins（与 builtin 的 contributes.skins 同语义）。
  let skins = [];
  if (value.contributes !== undefined) {
    if (!value.contributes || typeof value.contributes !== 'object' || Array.isArray(value.contributes)) return null;
    if (Object.keys(value.contributes).some(key => key !== 'skins')) return null;
    const parsedSkins = parseSkinDeclarations(value.contributes.skins);
    if (!parsedSkins) return null;
    skins = parsedSkins;
  }

  // 至少一种贡献：formatAliases / locales / skins 任一非空，否则是空插件。
  if (formatAliases.length === 0 && locales.length === 0 && skins.length === 0) return null;

  return {
    id: value.id,
    name: value.name,
    formatAliases,
    locales,
    ...(skins.length > 0 ? { skins } : {}),
    ...(typeof value.description === 'string' && value.description.length > 0 ? { description: value.description.slice(0, 200) } : {}),
  };
}

/** 读取并校验一个语言包分片。任何异常（越界、超限、坏 JSON、坏表体）都返回 null → 该分片被丢弃。 */
function readLocaleShard(pluginDir, file) {
  const base = path.resolve(pluginDir);
  const target = path.resolve(base, file);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_LOCALE_SHARD_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
  return parseLocaleTable(parsed);
}

/** 把 locales 声明解析成可直接给渲染进程用的 [{language, table}]（分片在这里被读掉）。 */
function resolveLocaleBundles(declarations, pluginDir) {
  const bundles = [];
  for (const declaration of declarations) {
    const table = declaration.table ?? readLocaleShard(pluginDir, declaration.file);
    // 坏分片只丢弃自己，不影响插件的 formatAliases 与其它语言
    if (table) bundles.push({ language: declaration.language, table });
  }
  return bundles;
}

/**
 * 扫描根目录下的声明式插件。**递归一层**：新布局把内置包放在 plugins/builtin/ 下，
 * 而声明式皮肤（builtin.skins-*）仍可能落在根或 builtin/ 里，单层扫描会漏掉。
 * 判据始终是「目录名 === manifest.id 且 runtime.mode === 'declarative'」，不看位置。
 */
function collectDeclarativeDirs(root, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const containers = [];
  // 第一轮：根下的直接插件目录（根优先 —— 用户的副本总是胜过 builtin/ 里的播种副本）
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (fs.existsSync(path.join(dir, 'manifest.json'))) out.push(dir);
    else containers.push(dir);
  }
  // 第二轮：容器目录下探一层（仅一层，避免任意深度遍历）
  for (const dir of containers) {
    let sub;
    try { sub = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const child of sub) {
      if (child.isDirectory() && fs.existsSync(path.join(dir, child.name, 'manifest.json'))) {
        out.push(path.join(dir, child.name));
      }
    }
  }
}

function listDeclarativePlugins(root) {
  const plugins = [];
  const dirs = [];
  collectDeclarativeDirs(root, dirs);
  const seen = new Set();
  for (const pluginDir of dirs) {
    if (plugins.length >= MAX_PLUGINS) break;
    const entryName = path.basename(pluginDir);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    let raw;
    try {
      const stat = fs.statSync(manifestPath);
      if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) continue;
      raw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDeclarativeManifest(raw);
    if (!parsed || parsed.id !== entryName) continue;
    // 同一 id 只认第一个（根优先于 builtin/，见 collectDeclarativeDirs 的遍历顺序）——
    // 防止「根 + builtin/ 各有一份」导致的重复注册。
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    const { locales: declarations, ...rest } = parsed;
    const locales = resolveLocaleBundles(declarations, pluginDir);
    plugins.push({ ...rest, ...(locales.length > 0 ? { locales } : {}) });
  }
  return { plugins };
}

module.exports = {
  parseDeclarativeManifest,
  parseLocaleDeclarations,
  parseLocaleTable,
  listDeclarativePlugins,
  MAX_LOCALE_SEGMENTS,
  MAX_LOCALE_ARRAY,
  MAX_LOCALE_DEPTH,
  MAX_LOCALE_SHARD_BYTES,
};
