/**
 * config-volume.ts —— 渲染层的**通用配置卷**适配器（workspace / recent-files 等新卷共用）。
 *
 * 为什么不复用 `preferences-store`：那是**偏好**卷的专用单例（带 `LEGACY_KEYS` 迁移表、
 * 安全模式分支、启动诊断上报）。工作区布局与最近工程既不需要旧键采纳，也不该各自复制
 * 一整套读写 + 订阅 + 回滚逻辑 —— 于是把"一个卷的读写语义"抽成这个工厂：
 * `createConfigVolume('workspace')` 一行拿到一个与 preferences 同语义的独立卷。
 *
 * 语义严格对齐 `preferences-store`（这两条是踩过坑的结论，不是随意选择）：
 *  1. **同步 + 失败即抛 + 回滚内存**。保留内存新值会造成"界面已生效、磁盘没改"的假成功，
 *     下次启动又变回去 —— 那正是"关掉的插件重启又自己开了"的成因。
 *  2. **安全模式下只改内存、不落盘、不抛错**（只读会话，见 ADR-053）。
 *
 * 桥不可用（纯浏览器 vite / 单测）时自动回退 `localStorage`，键前缀 `artflow.volume.<name>.`
 * —— 回退只为"浏览器里能跑"，不是权威存储；Electron 下永远走主进程文件。
 */

import type { ConfigSnapshot } from '../types';

export type VolumeValue = unknown;

export type VolumeSource = 'host-file' | 'host-safe-mode' | 'local-storage-fallback';

export interface ConfigVolume {
  readonly name: string;
  /** 后端来源自证：是不是真的落在了主进程文件上。 */
  readonly source: VolumeSource;
  readonly safeMode: boolean;
  read<T>(key: string, fallback: T): T;
  /** 原始取值：不存在时 `undefined`（与"显式存了 null"可区分）。 */
  peek(key: string): VolumeValue | undefined;
  has(key: string): boolean;
  write(key: string, value: VolumeValue): void;
  patch(values: Record<string, VolumeValue>): void;
  reset(keys: string[]): void;
  clear(): void;
  all(): Record<string, VolumeValue>;
  /** `key = null` 订阅整个卷；返回 disposer。 */
  subscribe(key: string | null, listener: () => void): () => void;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 结构化比较：值都是 JSON 可序列化的，直接比字符串即可（省掉深比较的实现与坑）。 */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

type ConfigBridge = NonNullable<Window['artflowConfig']>;

const bridge = (): ConfigBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.artflowConfig;

const volumes = new Map<string, ConfigVolume>();

/**
 * 取（或首次创建）一个配置卷。同名重复调用返回同一实例 ——
 * 订阅与内存态必须共享，否则两个组件各自持有一份就回到"互相覆盖"的老问题。
 */
export const createConfigVolume = (name: string): ConfigVolume => {
  const cached = volumes.get(name);
  if (cached) return cached;

  const fallbackPrefix = `artflow.volume.${name}.`;
  const values: Record<string, VolumeValue> = {};
  const globalListeners = new Set<() => void>();
  const keyListeners = new Map<string, Set<() => void>>();
  let source: VolumeSource = 'local-storage-fallback';
  let safeMode = false;

  const readFallback = (): Record<string, VolumeValue> => {
    const out: Record<string, VolumeValue> = {};
    try {
      if (typeof localStorage === 'undefined') return out;
      for (let index = 0; index < localStorage.length; index += 1) {
        const storageKey = localStorage.key(index);
        if (!storageKey || !storageKey.startsWith(fallbackPrefix)) continue;
        try {
          out[storageKey.slice(fallbackPrefix.length)] = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        } catch { /* 单个坏值跳过，不影响整卷 */ }
      }
    } catch { /* 无存储环境（SSR / 隐私模式） */ }
    return out;
  };

  const writeFallback = (): void => {
    try {
      if (typeof localStorage === 'undefined') return;
      for (const key of Object.keys(values)) {
        localStorage.setItem(`${fallbackPrefix}${key}`, JSON.stringify(values[key]));
      }
    } catch { /* 回退路径写失败不值得让调用方崩 */ }
  };

  const api = bridge();
  if (api?.readStore) {
    const snapshot: ConfigSnapshot | undefined = api.readStore(name);
    if (isPlainRecord(snapshot?.values)) {
      Object.assign(values, snapshot.values as Record<string, VolumeValue>);
      safeMode = snapshot.source === 'safe-mode';
      source = safeMode ? 'host-safe-mode' : 'host-file';
    }
  } else {
    Object.assign(values, readFallback());
  }

  const safeFire = (listener: () => void): void => {
    try {
      listener();
    } catch (error) {
      console.error(`[config-volume:${name}] subscriber failed`, error);
    }
  };

  const notify = (key: string): void => {
    for (const listener of [...globalListeners]) safeFire(listener);
    const scoped = keyListeners.get(key);
    if (scoped) for (const listener of [...scoped]) safeFire(listener);
  };

  /** 见文件头语义 ②：安全模式下只改内存、不落盘、不抛错。 */
  const persist = (operation: () => { ok: boolean; message?: string }, errorText: string): void => {
    if (safeMode) return;
    if (api) {
      const result = operation();
      if (!result.ok) throw new Error(result.message ?? errorText);
      return;
    }
    writeFallback();
  };

  const volume: ConfigVolume = {
    name,
    get source() { return source; },
    get safeMode() { return safeMode; },
    read: <T,>(key: string, fallback: T): T => {
      const current = values[key];
      return (current === undefined ? fallback : current) as T;
    },
    peek: key => values[key],
    has: key => Object.prototype.hasOwnProperty.call(values, key),
    write: (key, value) => {
      if (sameValue(values[key], value)) return;
      const previous = values[key];
      const hadPrevious = Object.prototype.hasOwnProperty.call(values, key);
      values[key] = value;
      try {
        persist(() => api!.setStoreValue!(name, key, value), `写入配置失败：${name}.${key}`);
      } catch (error) {
        if (hadPrevious) values[key] = previous;
        else delete values[key];
        throw error;
      }
      notify(key);
    },
    patch: next => {
      const entries = Object.entries(next);
      if (entries.length === 0) return;
      // 回滚基线只记"原本就存在的键"，回滚时先全删再加上基线 = 新增键也一并撤销。
      const snapshotBefore: Record<string, VolumeValue> = {};
      for (const [key] of entries) {
        if (Object.prototype.hasOwnProperty.call(values, key)) snapshotBefore[key] = values[key];
      }
      for (const [key, value] of entries) values[key] = value;
      try {
        persist(() => api!.patchStore!(name, next), `批量写入配置失败：${name}`);
      } catch (error) {
        for (const [key] of entries) delete values[key];
        Object.assign(values, snapshotBefore);
        throw error;
      }
      for (const [key] of entries) notify(key);
    },
    reset: keys => {
      if (keys.length === 0) return;
      const snapshotBefore: Record<string, VolumeValue> = {};
      for (const key of keys) if (Object.prototype.hasOwnProperty.call(values, key)) snapshotBefore[key] = values[key];
      try {
        persist(() => api!.resetStore!(name, keys), `重置配置失败：${name}`);
      } catch (error) {
        Object.assign(values, snapshotBefore);
        throw error;
      }
      for (const key of keys) delete values[key];
      if (!api) writeFallback();
      for (const key of keys) notify(key);
    },
    clear: () => {
      const snapshotBefore = { ...values };
      try {
        persist(() => api!.clearStore!(name), `清空配置失败：${name}`);
      } catch (error) {
        for (const key of Object.keys(values)) delete values[key];
        Object.assign(values, snapshotBefore);
        throw error;
      }
      for (const key of Object.keys(values)) delete values[key];
      if (!api) writeFallback();
      for (const listener of [...globalListeners]) safeFire(listener);
    },
    all: () => ({ ...values }),
    subscribe: (key, listener) => {
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
    },
  };

  volumes.set(name, volume);
  return volume;
};
