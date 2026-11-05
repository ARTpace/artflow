/**
 * i18n.ts —— 插件契约层的语言基元（纯函数，零 React 依赖）。
 *
 * 为什么单独一层：自检脚本（node，经 scripts/register-typescript.cjs）会直接
 * `require` 契约与 builtin 插件，契约层一旦引入 React 就会把 check 链一起拖下水。
 * 因此这里只放类型与解析函数，订阅端（hooks）放 utils/language-store.ts。
 */

/**
 * 界面语言面。
 *
 * 内置底座只提供 'en' / 'zho' 两档，但 locales 槽位允许插件注册任意语言码
 * （外部声明式 JSON 语言包也走这条通道）。因此用 LiteralUnion 写法：
 * 保留 'en'/'zho' 的字面量（自动补全、穷尽检查），同时接受任意语言码。
 */
export type UiLanguage = 'en' | 'zho' | (string & {});

/**
 * 本地化文本：直接给字符串（各语言同文案，兼容既有插件），
 * 或给按语言的解析函数（插件自行决定每档文案）。
 */
export type LocalizedText = string | ((language: UiLanguage) => string);

/**
 * 解析本地化文本。可选字段（description）解析不出东西时返回 undefined，
 * 必需字段（title/name）调用方用 `?? ''` 兜底。
 */
export const resolveLocalizedText = (
  value: LocalizedText | undefined,
  language: UiLanguage,
): string | undefined => {
  if (typeof value === 'function') return value(language);
  return value;
};

/**
 * manifest 用的 JSON 版本地化映射 —— JSON 里放不下函数，只能用键值表。
 * `name` / `description` 是**中文基准**（对齐仓库既有惯例：全部内置插件的
 * description 本来就是中文），本表只提供其它语言的覆盖。
 */
export interface LocalizedManifestText {
  en?: string;
  zho?: string;
}

/** 解析 manifest 文本：命中该语言的覆盖就用覆盖，否则回落基准字段。 */
export const resolveManifestText = (
  base: string | undefined,
  localized: LocalizedManifestText | undefined,
  language: UiLanguage,
): string => {
  const override = localized?.[language];
  return typeof override === 'string' && override.trim().length > 0 ? override : (base ?? '');
};

/**
 * 双语文案简写：`bi('撤销', 'Undo')` 直接产出一个 LocalizedText，可赋给
 * title / description / label 等字段。
 *
 * 插件里逐条写 `language => language === 'zho' ? '中文' : 'English'` 会淹没业务代码，
 * 而这个仓库的界面文案几乎全部是「中文 + 英文」两档，所以统一收敛成这一种写法。
 */
export const bi = (zho: string, en: string) => (language: UiLanguage): string =>
  (language === 'zho' ? zho : en);

/* ------------------------------------------------------------------ *
 * 语言包贡献（locales 槽位）
 *
 * 结构完全对标皮肤：translations.ts 是**内置底座**（角色等同 contributions.ts 里的
 * DEFAULT_SKIN），插件贡献的是**补丁层**（角色等同 skins 槽位里的 token patch）。
 * 这样即使语言包插件加载失败或被禁用，本体 UI 也只会缺掉被覆盖的那几条文案，
 * 而不会整档退化成 key 原文 —— 这是"本体不依赖插件"这条边界的具体落法。
 * ------------------------------------------------------------------ */

/**
 * 语言包补丁。`language` 用 string 而非 UiLanguage：内置底座只有 en/zho 两档，
 * 但插件可以注册任意语言码（外部声明式 JSON 语言包走的就是这条通道）。
 */
export interface LocaleBundle {
  language: string;
  /** 该语言的文案段表（段名 → 段内容）。与 translations.ts 同构。 */
  table: Record<string, unknown>;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneLocaleValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneLocaleValue);
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneLocaleValue(entry)]));
  }
  return value;
};

/**
 * 表格合并的**形状闸**（递归）。
 *
 * 为什么需要它：底座表里混着 33 条**函数叶子**（带计数的文案，如
 * `viewBookmarks.defaultName(n)` → "View {n}"），而语言包 —— 尤其是 B 档的外部
 * JSON 通道 —— 结构上表达不了函数。若放任浅合并，翻译者只要把某个函数叶子写成
 * 对象，界面上就会出现 `[object Object]`；写成字符串则 `t('x', 3)` 会**静默丢掉那个数字**。
 * 两种都是"看起来翻译成功了、其实坏了"的失败。因此：
 *   - 补丁想新增底座没有的键 → 放行（插件给自己那几条补语言，或补一个全新语言段）
 *   - 底座是函数           → **永远保留底座**（JSON 替代不了插值逻辑）
 *   - 两边都是对象          → 递归合并
 *   - 两边都是数组          → 整体替换（列表按序号合并毫无意义，如 quickPrompts）
 *   - 形状不符（对象 / 数组 / 叶子互不匹配）→ 忽略补丁项、保留底座
 *     （若整段被叶子覆盖，该段所有 key 都会查不到而回落成 key 原文，比不翻译更糟）
 */
const mergeLocaleValue = (base: unknown, patch: unknown): unknown => {
  if (base === undefined) return cloneLocaleValue(patch);
  if (typeof base === 'function') return base;
  // 数组只做整体替换：长度与顺序都是文案的一部分，按下标合并会产生半截列表。
  if (Array.isArray(base)) return Array.isArray(patch) ? patch : base;
  if (Array.isArray(patch)) return base;
  const baseRecord = isPlainRecord(base);
  const patchRecord = isPlainRecord(patch);
  if (baseRecord && patchRecord) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = mergeLocaleValue(merged[key], value);
    }
    return merged;
  }
  if (baseRecord !== patchRecord) return base;
  return patch;
};

/**
 * 把语言包补丁合并到内置底座上。合并规则对标 resolveSkinTokens（partial 补丁），
 * 并按段递归、逐键过形状闸（见 mergeLocaleValue）。
 * 非对象 table 忽略而非写入，避免一个坏语言包把整档文案清空。
 */
export const resolveLocaleTable = (
  base: Record<string, unknown> | undefined,
  patches: readonly LocaleBundle[],
  language: string,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const bundle of patches) {
    if (bundle.language !== language) continue;
    if (!isPlainRecord(bundle.table)) continue;
    for (const [segment, value] of Object.entries(bundle.table)) {
      merged[segment] = mergeLocaleValue(merged[segment], value);
    }
  }
  return merged;
};
