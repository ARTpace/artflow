/**
 * preferences-store.ts —— **用户偏好**的单一真相（后端在主进程，不在浏览器存储）。
 *
 * 为什么要有这一层（对照 `docs/用户数据层架构方案.md`）：
 *  1. 在此之前，每个设置项各自 `localStorage.getItem/setItem`，一处新增就要新接一根线；
 *     而 localStorage **按 origin 隔离**，dev :4002 / 直跑 vite / 打包 file:// 各是一份存储，
 *     换个启动方式整套偏好就"看起来被重置"。
 *  2. 主进程 `main/configStore.cjs` 把偏好落在 `userData/config/preferences.json`，与 origin 无关；
 *     本模块是渲染层唯一入口，负责同步读写、订阅通知、旧键一次性采纳与降级可见。
 *
 * 语义约定（三条，与主进程契约配套）：
 *  - **同步**：`set` 落盘失败**同步抛出**并回滚内存值 —— 不能留下"界面已改、磁盘没改"的
 *    假成功，那正是重启后设置复活的成因。写盘是主进程的小文件原子写，阻塞量可忽略。
 *  - **模块级单例**：顶层在模块求值期就把快照读好，供 `utils/language-store` 这类
 *    需要在首帧前定值的消费方同步取用（不走 React context / useEffect，避免时序问题）。
 *  - **降级可见**：任何回退（文件损坏→备份 / 桥不可用→localStorage）都记在 `source` /
 *    `degraded` / `message` 上，并上报主进程日志，绝不静默给默认值。
 */

import { useCallback, useSyncExternalStore } from 'react';
import { createLegacyAdoptionMarker } from './legacy-adoption-marker';

export type PrefValue = boolean | number | string | null | PrefValue[] | { [key: string]: PrefValue };

export type PrefBackendSource = 'host-file' | 'host-safe-mode' | 'local-storage-fallback';

/** 纯浏览器（vite dev / SSR 自检）没有主进程时的回退卷名。 */
const FALLBACK_STORAGE_KEY = 'artflow.prefs.v1';

/**
 * 旧键一次性采纳表：`prefKey → localStorage 原始键`（数组 = 优先级从高到低，兼容历史键名）。
 * 只在偏好卷里**没有**该键、**且该键没被处理过**时才读旧键；采纳后立即写进偏好卷。
 *
 * 旧键本身**不删除**（可回退），所以必须靠标记保证"只采纳一次" ——
 * 否则用户在设置页点了「恢复默认」再重启，旧键会把人已经放弃的值又推回来，
 * 这正是"关了又回来"那一类 bug 的同构形态。
 *
 * 这是**迁移清单**（对应 `docs/用户数据层架构方案.md` §4 P2）：新增一项就多搬一个键，
 * P2 收敛完成、确认稳定后整表删除即可（消费方那时已只认新键）。
 *
 * 归口：**消费方直接 `getPreference` 读的键登记在这里**；消费方以 `Pick<Storage>` 注入存储的
 * （perf-monitor / skin-engine / 扩展包 / 外插件），由 `plugins/preference-storage.ts` 适配器
 * 按 `namespace` 自行采纳 —— 同一批迁移不重复采纳两次。
 */
const LEGACY_KEYS: Readonly<Record<string, string | readonly string[]>> = Object.freeze({
  // P1 · 通用
  'general.language': 'language',
  // P2 · 画布（`bananapod.*` 是更早的历史键名，仅作兜底）
  'canvas.view': ['artflow.canvas-view.v1', 'bananapod.canvas-view.v1'],
  'canvas.userEffects': 'userEffects',
  // P2 · 输入
  'input.wheelAction': 'wheelAction',
  'input.generateHotkey': 'generateHotkey',
  'input.presentationHotkeys': 'presentationHotkeys',
  // P2 · 外观（主题工作室的收藏与混色方案；逐皮肤配置走适配器）
  'appearance.themeStudio.favorites': 'bp-theme-studio-favorites.v1',
  'appearance.themeStudio.mixes': 'bp-theme-studio-mixes.v1',
});

/**
 * 旧键文本 → 偏好值。
 * 只有"解析结果不是字符串"时才吃解析结果，这条规则消除了 `'123'` vs `123` 的歧义：
 *  - `'zho'`（裸串）        → `'zho'`
 *  - `'{"a":1}'`（JSON）    → `{ a: 1 }`（结构化存盘，preferences.json 可读、可手改）
 *  - `'1'` / `'0'`（标志位）→ `1` / `0`（读回时 stringify 仍是 `'1'`，往返一致）
 */
export const parsePreferenceText = (raw: string): PrefValue => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') return parsed as PrefValue;
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return parsed;
    return raw;
  } catch {
    return raw;
  }
};

/** 采纳标记：记录在 localStorage（旧键的所在地），因此清空偏好卷不会让它失效。 */
const LEGACY_MARKER_KEY = 'artflow.prefs.legacy-adopted.v1';

// 标记读的是 **已处理过** 的 prefKey（无论当时有没有读到旧值），不是"有没有采纳过"。
// 语义与理由见 `plugins/legacy-adoption-marker.ts`；P1 写过的 `'1'` 视为 `general.language` 已处理。
const legacyMarker = createLegacyAdoptionMarker(LEGACY_MARKER_KEY, ['general.language']);

/** 该键是否已尝试过旧键采纳（与"成功采纳"不同：没旧值也算已处理）。 */
export const isLegacyAdoptionSettled = (preferenceKey: string): boolean =>
  legacyMarker.isSettled(preferenceKey);

/** 标记一个（或多个）键已处理。标记写不进去只会导致下次重新尝试，不致命。 */
export const settleLegacyAdoption = (preferenceKeys: string | readonly string[]): void =>
  legacyMarker.settle(preferenceKeys);

type Bridge = NonNullable<Window['artflowConfig']>;

const bridge = (): Bridge | undefined =>
  typeof window === 'undefined' ? undefined : window.artflowConfig;

const readFallbackVolume = (): Record<string, PrefValue> => {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, PrefValue>)
      : {};
  } catch {
    return {};
  }
};

const writeFallbackVolume = (next: Record<string, PrefValue>): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(next));
};

const isPlainRecord = (value: unknown): value is Record<string, PrefValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const samePref = (left: PrefValue | undefined, right: PrefValue): boolean => {
  if (left === right) return true;
  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ *
 * 初始化：同步读一次快照（主进程文件优先，桥不可用时回退 localStorage）
 * ------------------------------------------------------------------ */

const values: Record<string, PrefValue> = {};
const adoptedLegacyKeys: string[] = [];
let backendSource: PrefBackendSource = 'local-storage-fallback';
let degraded = false;
let degradedMessage: string | null = null;
/**
 * 安全模式（`ARTFLOW_SAFE_MODE=1`，见 `main/safeMode.cjs`）：本次会话刻意不消费用户配置。
 * 它对"旧键采纳"有硬性影响 —— 见下面采纳循环前的注释。
 */
let safeMode = false;

const api = bridge();

if (api) {
  const snapshot = api.readPreferences();
  if (isPlainRecord(snapshot?.values)) {
    Object.assign(values, snapshot.values);
    safeMode = snapshot.source === 'safe-mode';
    backendSource = safeMode ? 'host-safe-mode' : 'host-file';
    degraded = snapshot.degraded === true;
    // 只在**真的降级**时才带 message。安全模式也会附一句说明，但它不是问题：
    // 报成"配置异常"会把人引去修一个没坏的东西 —— 那正是不该有的噪声。
    degradedMessage = degraded && typeof snapshot.message === 'string' ? snapshot.message : null;
  }
} else {
  Object.assign(values, readFallbackVolume());
}

// 旧键采纳：逐个键判断「偏好卷缺该键」且「该键没被处理过」。
// 懒判断是刻意的：宿主已有值时（正常启动/升级后），整个启动过程不碰 localStorage。
//
// 安全模式必须**整段跳过**，理由不是省事而是正确性：偏好卷在安全模式下读空，
// 于是每条登记键都"缺值"，采纳逻辑会把用户真实的旧配置原样搬回来 —— 安全模式当场失效。
// 同理也不写采纳标记（"查过了"），留白让正常启动时照旧采纳一次。
const settledKeys: string[] = [];
if (!safeMode) {
  for (const [preferenceKey, storageKeys] of Object.entries(LEGACY_KEYS)) {
    if (values[preferenceKey] !== undefined || isLegacyAdoptionSettled(preferenceKey)) continue;
    const candidates = typeof storageKeys === 'string' ? [storageKeys] : storageKeys;
    for (const storageKey of candidates) {
      let raw: string | null = null;
      try {
        raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey);
      } catch {
        raw = null;
      }
      if (raw === null || raw.length === 0) continue;
      values[preferenceKey] = parsePreferenceText(raw);
      adoptedLegacyKeys.push(`${storageKey}→${preferenceKey}`);
      break;
    }
    // 关键：无论有没有读到旧值，都把「查过」这件事记下来。
    // 否则用户点「恢复默认」清空偏好卷后，旧键会在下次启动把人已放弃的值重新推回来。
    // 收集后一次写标记，避免每键一次 localStorage.setItem。
    settledKeys.push(preferenceKey);
  }

  if (settledKeys.length > 0) settleLegacyAdoption(settledKeys);
}

if (adoptedLegacyKeys.length > 0) {
  // 采纳结果必须尽快落盘（一次批量 patch），否则每个会话都要重新采纳一遍。
  try {
    if (api) {
      api.patchPreferences(Object.fromEntries(
        adoptedLegacyKeys.map(entry => {
          const [from, to] = entry.split('→');
          return [to, values[to]] as [string, PrefValue];
        }),
      ));
    } else {
      writeFallbackVolume(values);
    }
  } catch (error) {
    console.error('[preferences] 旧键采纳落盘失败', error);
  }
}

api?.reportBoot?.({
  source: backendSource,
  degraded,
  keyCount: Object.keys(values).length,
  adoptedLegacyKeys,
  message: degradedMessage,
  safeMode,
});

/* ------------------------------------------------------------------ *
 * 订阅
 * ------------------------------------------------------------------ */

const globalListeners = new Set<() => void>();
const keyListeners = new Map<string, Set<() => void>>();

const safeFire = (listener: () => void): void => {
  try {
    listener();
  } catch (error) {
    console.error('[preferences] subscriber failed', error);
  }
};

const notify = (key: string): void => {
  for (const listener of [...globalListeners]) safeFire(listener);
  const scoped = keyListeners.get(key);
  if (scoped) for (const listener of [...scoped]) safeFire(listener);
};

/** `key = null` 订阅全键变更；返回 disposer。 */
export const subscribePreferences = (key: string | null, listener: () => void): (() => void) => {
  if (key === null) {
    globalListeners.add(listener);
    return () => { globalListeners.delete(listener); };
  }
  let scoped = keyListeners.get(key);
  if (!scoped) {
    scoped = new Set();
    keyListeners.set(key, scoped);
  }
  scoped.add(listener);
  return () => {
    scoped.delete(listener);
    if (scoped.size === 0) keyListeners.delete(key);
  };
};

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

export const getPreference = <T extends PrefValue>(key: string, fallback: T): T => {
  const current = values[key];
  return (current === undefined ? fallback : current) as T;
};

/** 键是否**显式存在**（区别于"值为 null/undefined 的 fallback"）。适配器据此判断该不该做旧键采纳。 */
export const hasPreference = (key: string): boolean => Object.prototype.hasOwnProperty.call(values, key);

/**
 * 原始取值：不存在时返回 `undefined`。
 * 与 `getPreference(key, fallback)` 的区别是"缺省"与"显式存了 null"可区分 —— 存储适配器需要这个。
 */
export const peekPreference = (key: string): PrefValue | undefined => values[key];

/**
 * 落盘。安全模式下**只改内存、不落盘**，并且**不抛错**。
 *
 * 为什么这里破例（其余消费方的同步契约仍然是"失败即抛"）：启动期有一批 effect 会把
 * 当前值（多数是默认值）"写回"一遍 —— 滚轮动作 / 用户特效 / 生成快捷键 / 放映快捷键 /
 * 画布视图各一次。宿主在安全模式下必然拒写，照旧抛错的话这几处会各自刷一条 `[启动错误]`，
 * 于是**用户拿到的第一份日志全是噪声** —— 而"拿到一份干净日志"正是安全模式的全部意义。
 *
 * 这也不构成"假成功"：横幅已明写"本次改动不会保存"，宿主侧同样拒写，
 * 用户面对的是一个被如实告知的**只读会话**，而不是被悄悄吞掉的失败。
 */
const persist = (key: string): void => {
  if (safeMode) return;
  if (api) {
    const result = api.setPreference(key, values[key]);
    if (!result.ok) throw new Error(result.message ?? `写入偏好失败：${key}`);
    return;
  }
  writeFallbackVolume(values);
};

/**
 * 同步写入：失败**同步抛出**并回滚内存值。
 * 回滚是必需的 —— 保留内存里的新值会造成"界面已生效、磁盘没改"的假成功，
 * 下次启动又变回旧值，就是主人遇到的"设置关了又自己开"。
 */
export const setPreference = <T extends PrefValue>(key: string, value: T): void => {
  if (samePref(values[key], value)) return;
  const previous = values[key];
  const hadPrevious = Object.prototype.hasOwnProperty.call(values, key);
  values[key] = value;
  try {
    persist(key);
  } catch (error) {
    if (hadPrevious) values[key] = previous as PrefValue;
    else delete values[key];
    throw error;
  }
  notify(key);
};

export const resetPreference = (keys: string[]): void => {
  if (keys.length === 0) return;
  // 安全模式：内存照常清（界面要立刻反映出来），但不碰宿主 —— 见 `persist` 的说明。
  if (api && !safeMode) {
    const result = api.resetPreferences(keys);
    if (!result.ok) throw new Error(result.message ?? '重置偏好失败');
  }
  for (const key of keys) delete values[key];
  if (!api) writeFallbackVolume(values);
  for (const key of keys) notify(key);
};

/** 删除单个 / 若干偏好键（回到 fallback）。 */
export const deletePreference = (key: string): void => resetPreference([key]);

/** 清空整个偏好卷（设置页「恢复默认」）。 */
export const clearPreferences = (): void => {
  if (api && !safeMode) {
    const result = api.clearPreferences();
    if (!result.ok) throw new Error(result.message ?? '清空偏好失败');
  }
  for (const key of Object.keys(values)) delete values[key];
  if (!api) writeFallbackVolume(values);
  for (const listener of [...globalListeners]) safeFire(listener);
};

/* ------------------------------------------------------------------ *
 * 预设（导出 / 导入，对齐 Blender presets/）
 * ------------------------------------------------------------------ */

export const exportPreferences = (): string => JSON.stringify(values, null, 2);

/**
 * 只接受纯 JSON 值 —— 绝不接受可执行内容。
 * `replace` 先清空再写；`merge` 只在键缺失时补（用户现有选择优先）。
 */
export const importPreferences = (json: string, mode: 'merge' | 'replace'): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`偏好预设不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainRecord(parsed)) throw new Error('偏好预设必须是一个 JSON 对象');
  const entries = Object.entries(parsed).filter(([key, value]) =>
    key.length > 0 && key.length <= 120 && value !== undefined && isJsonValue(value));
  if (entries.length === 0) throw new Error('偏好预设里没有可导入的键');

  if (mode === 'replace') {
    if (api && !safeMode) {
      const cleared = api.clearPreferences();
      if (!cleared.ok) throw new Error(cleared.message ?? '清空偏好失败');
    }
    for (const key of Object.keys(values)) delete values[key];
  }
  for (const [key, value] of entries) values[key] = value as PrefValue;
  if (api && !safeMode) {
    const result = api.patchPreferences(Object.fromEntries(entries));
    if (!result.ok) throw new Error(result.message ?? '导入偏好失败');
  } else if (!api) {
    writeFallbackVolume(values);
  }
  for (const listener of [...globalListeners]) safeFire(listener);
};

const isJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 12) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 5_000 && value.every(item => isJsonValue(item, depth + 1));
  if (isPlainRecord(value)) return Object.entries(value).every(([, item]) => isJsonValue(item, depth + 1));
  return false;
};

/* ------------------------------------------------------------------ *
 * 诊断与 React 绑定
 * ------------------------------------------------------------------ */

export const preferencesBackendSource = (): PrefBackendSource => backendSource;
export const preferencesDegraded = (): { degraded: boolean; message: string | null } => ({
  degraded,
  message: degradedMessage,
});
/**
 * 本次会话是否处于**安全模式**（`ARTFLOW_SAFE_MODE=1`）：刻意忽略用户配置、不做旧键采纳、
 * 任何写入都会被宿主拒绝。`plugins/preference-storage.ts` 与 UI 提示条据此分支。
 */
export const preferencesSafeMode = (): boolean => safeMode;
export const snapshotPreferences = (): Readonly<Record<string, PrefValue>> => ({ ...values });

/**
 * React 绑定。`fallback` 必须是模块级常量：getSnapshot 的返回值参与引用比较，
 * 每次渲染新造的数组 / 对象字面量会导致无限重渲染。
 */
export const usePref = <T extends PrefValue>(key: string, fallback: T): [T, (value: T) => void] => {
  const subscribe = useCallback((listener: () => void) => subscribePreferences(key, listener), [key]);
  const value = useSyncExternalStore(
    subscribe,
    () => getPreference(key, fallback),
    () => getPreference(key, fallback),
  );
  const setValue = useCallback((next: T) => setPreference(key, next), [key]);
  return [value, setValue];
};
