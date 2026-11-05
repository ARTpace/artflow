/**
 * language-store.ts —— 界面语言的单一真相。
 *
 * 背景：语言原先只活在 hooks/useSettings 的 useState 里，再由 App 逐层往下传
 * （CanvasSettings / ContextMenu / MainCanvas…）。插件的 setup 组件能拿到 language，
 * 但本体组件（TopBar / BoardPanel / CanvasNavigator / cards/* 等）拿不到，
 * 于是它们的文案只能硬编码英文，无视设置页的语言开关。
 *
 * 做法与 viewport-store / drag-session-store / canvas-document-state 同构：
 * 模块级 store + useSyncExternalStore 订阅，不引入 React Context
 * （本仓库没有任何 createContext，跨组件共享一律走这个模式）。
 *
 * 分工：本模块只负责"当前语言是什么"以及通知订阅者；持久化交给
 * `plugins/preferences-store`（后端是主进程的 `userData/config/preferences.json`，
 * 与 dev server origin 解耦）。键名 `general.language`；旧的
 * `localStorage['language']` 由偏好存储一次性采纳，读不到时回落 'zho'
 * （与 settings-bridge 默认值一致）。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { resolveLocaleTable, type LocaleBundle, type UiLanguage } from '../plugin-runtime/i18n';
import { getPreference, setPreference } from '../plugin-runtime/preferences-store';
import { translations } from '../translations';

export type { UiLanguage };

/**
 * translations.ts 是本体的 UI 文案表（`translations.en.* / translations.zho.*`）。
 * 本体组件早就有 `t('toolbar.boards')` 这套点分路径取值，但过去只有 hooks/useSettings
 * 内部持有它；拿不到 t prop 的组件（ViewBookmarksPanel / ImportJobsPanel / cards/* 等）
 * 便只能硬编码英文。useTranslation 把同一套表按同一套语义暴露出来，避免出现第二套文案源。
 */
export type TranslationFunction = (key: string, ...args: any[]) => any;

const LANGUAGE_PREF_KEY = 'general.language';

const readPersisted = (): UiLanguage | null => {
  try {
    const saved = getPreference<string>(LANGUAGE_PREF_KEY, '');
    return saved === 'en' || saved === 'zho' ? saved : null;
  } catch {
    return null;
  }
};

let current: UiLanguage = readPersisted() ?? 'zho';
const listeners = new Set<() => void>();

export const getLanguage = (): UiLanguage => current;

const broadcast = (): void => {
  for (const notify of [...listeners]) {
    try {
      notify();
    } catch (error) {
      console.error('[language] subscriber failed', error);
    }
  }
};

/** 写入即落盘并广播；同值写入直接短路，避免无谓重绘（必须保留：快照是原始字符串，引用天然稳定）。 */
export const setLanguage = (next: UiLanguage): void => {
  if (next === current) return;
  current = next;
  try {
    setPreference(LANGUAGE_PREF_KEY, next);
  } catch (error) {
    // 落盘失败同步抛出（主进程小文件原子写）；这里只记日志不阻断 UI ——
    // 本模块是按下一个语言就该立刻生效，写盘失败由 preferences-store 回滚内存值。
    console.error('[language] failed to persist language', error);
  }
  broadcast();
};

/* ------------------------------------------------------------------ *
 * 语言包补丁（locales 槽位）与查表缓存
 *
 * translations.ts 是**内置底座**；插件注册的 LocaleBundle 是**补丁层** ——
 * 结构完全对标皮肤：DEFAULT_SKIN 写在框架里，skins 插件只给 token patch。
 * 因此语言包插件加载失败/被禁用时，本体 UI 只会缺掉被覆盖的几条文案，
 * 不会整档退化成 key 原文。
 *
 * 补丁由启动期注入，且**必须早于首帧**：与 bootstrapSkinEngine 是同一条时序约束，
 * 否则第一帧会先按未合并的底座渲染一遍，再"跳"成合并后的文案。
 * ------------------------------------------------------------------ */
let localePatches: readonly LocaleBundle[] = [];
let cachedLanguage: string | null = null;
let cachedTable: Record<string, unknown> | null = null;

/** 由 index.tsx 在 loadBuiltinPlugins() 之后、root.render() 之前调用。 */
export const setLocalePatches = (next: readonly LocaleBundle[]): void => {
  localePatches = next;
  cachedLanguage = null;
  cachedTable = null;
  broadcast();
};

/**
 * 当前可用的语言码：内置底座两档 + 语言包补丁声明的语言（去重，内置档在前）。
 * 设置页的语言切换器据此渲染 —— 注册了语言包的插件会在这里多出一个选项，
 * 无需改设置页代码。
 */
export const listAvailableLanguages = (): string[] => {
  const builtin = Object.keys(translations);
  const extra = new Set<string>();
  for (const bundle of localePatches) {
    if (!builtin.includes(bundle.language)) extra.add(bundle.language);
  }
  return [...builtin, ...[...extra].sort()];
};

/**
 * 底座没有该语言档时的回落档。声明式语言包是**补丁层** —— 插件通常只翻译自己那几条，
 * 整档缺项是常态。这时若把底座取成 undefined，未覆盖的键会被 t() 的 `result || key`
 * 兜底成 key 原文（界面上出现 "toolbar.boards"），比显示英文糟得多。
 * 因此未知语言档一律以 en 档为底，再由补丁逐键覆盖。
 */
const FALLBACK_LANGUAGE = 'en';

/** 底座 + 补丁 合并后的表；按语言缓存，语言切换或补丁变更时失效。 */
const getTable = (language: string): Record<string, unknown> => {
  if (cachedLanguage === language && cachedTable) return cachedTable;
  const base = (translations as Record<string, Record<string, unknown> | undefined>)[language]
    ?? (translations as Record<string, Record<string, unknown> | undefined>)[FALLBACK_LANGUAGE];
  cachedTable = resolveLocaleTable(base, localePatches, language);
  cachedLanguage = language;
  return cachedTable;
};

export const subscribeLanguage = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** React 订阅入口：任何本体组件 / 卡片 / 插件 UI 都可以直接用它读当前语言。 */
export const useLanguage = (): UiLanguage =>
  useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);

/** 语法糖：`zho(language) ? '中文' : 'English'`，避免每处都写 `=== 'zho'`。 */
export const isZho = (language: UiLanguage): boolean => language === 'zho';

/**
 * 一次性取值场景的双语简写（非 React、且不经过 LocalizedText 契约的地方）：
 * 原生保存对话框标题、档案管理器的提示条文案等 —— 这些值在**产生的那一刻**就要定语言，
 * 没有后续解析机会。声明式字段请改用 plugins/i18n 的 `bi()`。
 */
export const uiText = (zho: string, en: string): string => (getLanguage() === 'zho' ? zho : en);

/**
 * React 组件内的双语取值：`const t = useUiText(); … {t('已启用', 'Active')}`。
 * 返回值随语言变化而换引用，组件会正确重绘。
 */
export const useUiText = (): ((zho: string, en: string) => string) => {
  const language = useLanguage();
  return useCallback((zho: string, en: string) => (language === 'zho' ? zho : en), [language]);
};

/**
 * 非 React 的一次性查表：`translateFor('zho', 'toolbar.boards')` —— 与 useTranslation 共用
 * 同一份合并表与同一套回落语义（查不到回落 key 原文）。供自检脚本等非组件场景走**真实**路径，
 * 避免为了可测试性再写一份查表实现而与组件行为漂移。
 */
export const translateFor = (language: UiLanguage, key: string, ...args: any[]): any => {
  let result: any = getTable(language);
  for (const segment of key.split('.')) {
    result = result?.[segment];
  }
  if (typeof result === 'function') return result(...args);
  return result || key;
};

/**
 * React 组件内的 UI 文案取值，语义与 hooks/useSettings 的 t 完全一致
 * （点分路径 → 合并表，叶子为函数则以剩余参数调用，查不到回落 key）。
 *
 * `const { t } = useTranslation(); … {t('importJobs.title')}`
 *
 * 与 useUiText 的分工：**能用 translations 表就用本 hook**（文案集中、可被检索/校验）；
 * useUiText 只留给表里尚不存在的临时内联串。
 */
export const useTranslation = (): { language: UiLanguage; t: TranslationFunction } => {
  const language = useLanguage();
  const t = useCallback<TranslationFunction>(
    (key: string, ...args: any[]) => translateFor(language, key, ...args),
    [language],
  );
  return { language, t };
};
