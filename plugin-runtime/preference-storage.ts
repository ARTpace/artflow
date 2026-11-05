/**
 * preference-storage.ts —— 把 `preferences-store`（扁平 kv，后端在主进程文件里）
 * 伪装成 Web `Storage` 的一小部分，供**既有以 `Pick<Storage, ...>` 为注入契约**的模块复用。
 *
 * 为什么需要它（对照 `docs/用户数据层架构方案.md` §4 P2）：
 *   存量代码里，画布视图 / 皮肤配置 / 扩展包 / 外部插件的开关都已经把存储抽成了
 *   `Pick<Storage, 'getItem' | 'setItem'>` 参数 —— 这正是当初留下的**替换缝**。
 *   有了这个适配器，那些模块**内部一行都不用改**，只要在注入点把 `window.localStorage`
 *   换成这里返回的对象，用户数据就从浏览器存储挪到了主进程文件：
 *     - 与 origin 解耦（dev :4002 / 打包 file:// / 换端口不再各存一份）；
 *     - 享受原子写 + 备份回退 + 降级可见（见 `main/configStore.cjs`）；
 *     - 首次启动自动把旧 localStorage 值**一次性采纳**过来，旧键不删（可回退）。
 *
 * 值语义（关键）：
 *   读 → 偏好卷里的结构化值 `JSON.stringify` 成字符串返回（与 Storage 语义一致）；
 *   写 → 能 `JSON.parse` 成对象/数字/布尔的值**结构化存盘**（让 preferences.json 可读、可手改），
 *        否则原样存字符串。裸字符串（`hello`）与 JSON 字符串字面量（`"hello"`）都往返一致，
 *        因为只有"解析结果不是 string"时才吃解析结果 —— 这条规则消除了 `'123'` vs `123` 的歧义。
 *
 * 一次性采纳：靠 `preferences-store` 的 per-key 标记保证 —— 用户点「恢复默认」清空偏好卷后，
 * 旧键**不会**把已放弃的值重新推回来（否则就是"关了又回来"的同构 bug）。
 */

import {
  deletePreference,
  hasPreference,
  isLegacyAdoptionSettled,
  parsePreferenceText,
  peekPreference,
  preferencesSafeMode,
  setPreference,
  settleLegacyAdoption,
  type PrefValue,
} from './preferences-store';

/** 与调用方既有注入契约完全一致 —— 换的是实现，不是签名。 */
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PreferenceStorageOptions {
  /** 新键命名空间：默认 `prefKey = \`${namespace}.${storageKey}\``。 */
  namespace: string;
  /** 自定义 `storageKey → prefKey` 映射（用于 `bp-skin-config.<id>` 这类前缀式旧键）。 */
  toPreferenceKey?: (storageKey: string) => string;
  /** 是否做旧键一次性采纳，默认 `true`。 */
  adoptLegacy?: boolean;
}

/** 偏好值 → 旧键值。字符串原样返回（它要么是裸串、要么本来就是 JSON 文本）。 */
const serializeStored = (value: PrefValue | undefined): string | null => {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
};

/**
 * 构造一个 Storage 兼容视图。
 * 每个命名空间建议只建一个实例（模块级常量），避免重复做旧键采纳判断。
 */
export const createPreferenceStorage = (options: PreferenceStorageOptions): PreferenceStorage => {
  const { namespace, toPreferenceKey, adoptLegacy = true } = options;
  const mapKey = toPreferenceKey ?? ((storageKey: string) => `${namespace}.${storageKey}`);

  /** 首次见到的键：尝试从旧 localStorage 采纳一次，并打上"已处理"标记。 */
  const adoptLegacyKey = (storageKey: string, preferenceKey: string): PrefValue | undefined => {
    // 安全模式：偏好卷读空 → 每个键都"缺值"，若不短路就会把用户旧配置又搬回来，
    // 安全模式当场失效。所以这里**既不读旧值也不打标记**（留白给正常启动采纳）。
    if (preferencesSafeMode()) return undefined;
    if (!adoptLegacy || isLegacyAdoptionSettled(preferenceKey)) return undefined;
    let raw: string | null = null;
    try {
      raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey);
    } catch {
      raw = null;
    }
    // 先打标记再做可能失败的写入：标记的意思是"查过了"，避免每次启动重复读 localStorage。
    settleLegacyAdoption(preferenceKey);
    if (raw === null || raw.length === 0) return undefined;
    const adopted = parsePreferenceText(raw);
    try {
      setPreference(preferenceKey, adopted);
    } catch (error) {
      console.error(`[preference-storage] 旧键采纳落盘失败：${storageKey}`, error);
    }
    return adopted;
  };

  return {
    getItem(storageKey: string): string | null {
      const preferenceKey = mapKey(storageKey);
      if (hasPreference(preferenceKey)) return serializeStored(peekPreference(preferenceKey));
      const adopted = adoptLegacyKey(storageKey, preferenceKey);
      return adopted === undefined ? null : serializeStored(adopted);
    },

    setItem(storageKey: string, value: string): void {
      setPreference(mapKey(storageKey), parsePreferenceText(value));
    },

    removeItem(storageKey: string): void {
      deletePreference(mapKey(storageKey));
    },
  };
};

/**
 * 便捷构造：旧键带固定前缀时用（如 `bp-skin-config.<id>` → `appearance.skinConfig.<id>`）。
 * 前缀不匹配的键按 `namespace + '.' + storageKey` 兜底。
 */
export const createPrefixedPreferenceStorage = (
  legacyPrefix: string,
  preferencePrefix: string,
): PreferenceStorage =>
  createPreferenceStorage({
    namespace: preferencePrefix,
    toPreferenceKey: storageKey =>
      storageKey.startsWith(legacyPrefix)
        ? `${preferencePrefix}.${storageKey.slice(legacyPrefix.length)}`
        : `${preferencePrefix}.${storageKey}`,
  });
