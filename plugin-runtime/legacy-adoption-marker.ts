/**
 * legacy-adoption-marker.ts —— "旧 localStorage 键只采纳一次"的标记机制（各存储卷共用）。
 *
 * 为什么需要这个机制：
 *   迁移期旧键**不删除**（出问题可一键回退），但这就带来一个隐患 —— 用户点「恢复默认」
 *   把新的配置卷清空后，键又"缺失"了，旧键会把用户已经放弃的值重新推回来。
 *   这和「插件关了重启又开」是同一类 bug。标记的作用就是记住"这个键查过了"。
 *
 * 为什么标记必须是 **per-key 集合**、而不是一个全局布尔：
 *   - 全局布尔一旦置位，**后加的键就永远读不到旧值** —— 升级用户的画布/皮肤/快捷键
 *     设置会被静默重置成默认，那是数据丢失，不是降级；
 *   - "已查过"语义才能同时满足：① 升级用户的旧值被采纳一次；② 恢复默认后旧值不复活。
 *
 * 标记记在 **localStorage**（旧键的所在地），因此清空配置卷不会让它失效。
 * 兼容早期版本写下的 `'1'`（当时每个卷只有一个键）→ 视为"那个键已处理"。
 */

export interface LegacyAdoptionMarker {
  /** 该键是否已尝试过旧键采纳（与"成功采纳"不同：没读到旧值也算已处理）。 */
  isSettled(preferenceKey: string): boolean;
  /** 标记一个（或多个）键已处理。标记写不进去只会导致下次重新尝试，不致命。 */
  settle(preferenceKeys: string | readonly string[]): void;
}

export const createLegacyAdoptionMarker = (
  markerKey: string,
  legacyBooleanSeed: readonly string[] = [],
): LegacyAdoptionMarker => {
  const read = (): Set<string> => {
    try {
      if (typeof localStorage === 'undefined') return new Set();
      const raw = localStorage.getItem(markerKey);
      if (!raw) return new Set();
      // 早期格式：一个布尔 '1'，代表"本卷唯一那个键已经处理过"。
      if (raw === '1') return new Set(legacyBooleanSeed);
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? new Set(parsed.filter((item): item is string => typeof item === 'string'))
        : new Set();
    } catch {
      return new Set();
    }
  };

  // 惰性：偏好卷里已有值时（升级用户/正常启动），整个启动过程不碰 localStorage。
  let markers: Set<string> | null = null;
  const ensure = (): Set<string> => (markers ??= read());

  return {
    isSettled: (preferenceKey: string): boolean => ensure().has(preferenceKey),
    settle: (preferenceKeys: string | readonly string[]): void => {
      const list = typeof preferenceKeys === 'string' ? [preferenceKeys] : preferenceKeys;
      // 空列表直接短路：否则会为了写一个空标记而白读一次 localStorage。
      if (list.length === 0) return;
      const set = ensure();
      let changed = false;
      for (const key of list) {
        if (!set.has(key)) {
          set.add(key);
          changed = true;
        }
      }
      if (!changed) return;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(markerKey, JSON.stringify([...set]));
        }
      } catch {
        /* 标记丢失 → 下次启动会再读一遍旧键，无害 */
      }
    },
  };
};
