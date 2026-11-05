/**
 * secrets-store.ts —— **敏感用户数据**（API key 等）的单一真相。
 *
 * 与 `preferences-store` 同一套后端，但**独立成卷**（`userData/config/secrets.json`）：
 *  - 权限与备份策略可以和普通偏好分开；
 *  - 导出/分享偏好预设时不会顺带把密钥带出去；
 *  - 未来若改用系统钥匙串（Electron `safeStorage`）加密，只需换这一个卷的实现。
 *
 * 为什么不继续用 localStorage：明文落在浏览器存储里，且按 origin 隔离 ——
 * 换启动方式就要重填一次密钥。
 *
 * 与偏好一致的三条语义：同步读写（失败同步抛）、模块级单例（首帧前可读）、
 * 旧键一次性采纳（`localStorage['geminiApiKey']` → `ai.geminiApiKey`，旧值不删）。
 */

import type { ConfigSnapshot } from '../types';
import { createLegacyAdoptionMarker } from './legacy-adoption-marker';

/** 纯浏览器（vite dev / SSR 自检）没有主进程时的回退卷名。 */
const FALLBACK_STORAGE_KEY = 'artflow.secrets.v1';

/** 旧键一次性采纳表：`secretKey → localStorage 原始键`。 */
const LEGACY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'ai.geminiApiKey': 'geminiApiKey',
});

/** 采纳标记：旧键不删除（可回退），靠标记保证"只采纳一次"，避免清空密钥卷后旧值复活。 */
const LEGACY_MARKER_KEY = 'artflow.secrets.legacy-adopted.v1';

// 与偏好卷同一套机制（`plugins/legacy-adoption-marker.ts`）；早期写的 `'1'` 视为
// `ai.geminiApiKey` 已处理。per-key 集合让"以后再加密钥键"不会漏掉旧值。
const legacyMarker = createLegacyAdoptionMarker(LEGACY_MARKER_KEY, ['ai.geminiApiKey']);

type Bridge = NonNullable<Window['artflowConfig']>;

const bridge = (): Bridge | undefined =>
  typeof window === 'undefined' ? undefined : window.artflowConfig;

const readFallbackVolume = (): Record<string, string> => {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
};

const writeFallbackVolume = (next: Record<string, string>): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(next));
};

const api = bridge();
const secrets: Record<string, string> = {};
let backendSource: 'host-file' | 'host-safe-mode' | 'local-storage-fallback' = 'local-storage-fallback';
let degraded = false;
let degradedMessage: string | null = null;
/** 安全模式：密钥卷读空，且**不做旧键采纳**（否则 `localStorage['geminiApiKey']` 会把密钥搬回来）。 */
let safeMode = false;

if (api) {
  const snapshot: ConfigSnapshot | undefined = api.readSecrets();
  if (snapshot && snapshot.values && typeof snapshot.values === 'object') {
    for (const [key, value] of Object.entries(snapshot.values)) {
      if (typeof value === 'string') secrets[key] = value;
    }
    safeMode = snapshot.source === 'safe-mode';
    backendSource = safeMode ? 'host-safe-mode' : 'host-file';
    degraded = snapshot.degraded === true;
    // 与偏好卷同理：只有真的降级才带 message，安全模式的说明不是"配置异常"。
    degradedMessage = degraded && typeof snapshot.message === 'string' ? snapshot.message : null;
  }
} else {
  Object.assign(secrets, readFallbackVolume());
}

// 旧键采纳：仅在密钥卷缺该键、且该键没被处理过时读旧键（旧键不删，可回退）。
// 安全模式整段跳过（含标记）：读空之后每个键都"缺值"，不跳过就会把用户密钥搬回来 —— 那就不是工厂启动了。
const adoptedLegacyKeys: string[] = [];
const missingLegacyKeys = safeMode ? [] : Object.entries(LEGACY_KEYS).filter(
  ([secretKey]) => secrets[secretKey] === undefined && !legacyMarker.isSettled(secretKey),
);
if (missingLegacyKeys.length > 0) {
  for (const [secretKey, storageKey] of missingLegacyKeys) {
    let raw: string | null = null;
    try {
      raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey);
    } catch {
      raw = null;
    }
    if (raw === null || raw.length === 0) continue;
    secrets[secretKey] = raw;
    adoptedLegacyKeys.push(`${storageKey}→${secretKey}`);
  }
}

if (adoptedLegacyKeys.length > 0) {
  try {
    if (api) {
      for (const entry of adoptedLegacyKeys) {
        const secretKey = entry.split('→')[1];
        api.setSecret(secretKey, secrets[secretKey]);
      }
    } else {
      writeFallbackVolume(secrets);
    }
  } catch (error) {
    console.error('[secrets] 旧键采纳落盘失败', error);
  }
}

// 无论有没有读到旧值都要标记"查过了"，否则清空密钥卷后旧值会复活。
legacyMarker.settle(missingLegacyKeys.map(([secretKey]) => secretKey));

api?.reportBoot?.({
  source: backendSource,
  degraded,
  keyCount: Object.keys(secrets).length,
  adoptedLegacyKeys,
  message: degradedMessage,
});

export const readSecret = (key: string): string | null => {
  const value = secrets[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const hasSecret = (key: string): boolean => readSecret(key) !== null;

/** 空串等同删除：避免"填了个空"这种既占位又没用的状态。 */
export const writeSecret = (key: string, value: string): void => {
  const trimmed = value;
  if (trimmed.length === 0) {
    clearSecret(key);
    return;
  }
  if (secrets[key] === trimmed) return;
  const previous = secrets[key];
  const hadPrevious = Object.prototype.hasOwnProperty.call(secrets, key);
  secrets[key] = trimmed;
  try {
    if (api) {
      const result = api.setSecret(key, trimmed);
      if (!result.ok) throw new Error(result.message ?? `写入密钥失败：${key}`);
    } else {
      writeFallbackVolume(secrets);
    }
  } catch (error) {
    if (hadPrevious) secrets[key] = previous;
    else delete secrets[key];
    throw error;
  }
};

export const clearSecret = (key: string): void => {
  if (!Object.prototype.hasOwnProperty.call(secrets, key)) return;
  delete secrets[key];
  if (api) {
    const result = api.removeSecret(key);
    if (!result.ok) throw new Error(result.message ?? `删除密钥失败：${key}`);
  } else {
    writeFallbackVolume(secrets);
  }
};

export const secretsBackendSource = (): 'host-file' | 'host-safe-mode' | 'local-storage-fallback' => backendSource;
export const secretsDegraded = (): { degraded: boolean; message: string | null } => ({
  degraded,
  message: degradedMessage,
});
/** 只返回键名，绝不返回值 —— 供存储健康度面板展示。 */
export const listSecretKeys = (): string[] => Object.keys(secrets);

/**
 * 脱敏视图：供设置面板展示「是否已配置」，**绝不下发明文**。
 * 预览规则对齐 art-canvas：前 4 + `••••` + 后 4；过短（≤8）则整串省略为 `••••••••`。
 */
export const maskSecret = (key: string): { hasKey: boolean; preview: string } => {
  const value = readSecret(key);
  if (!value) return { hasKey: false, preview: '' };
  const preview = value.length > 8 ? `${value.slice(0, 4)}••••${value.slice(-4)}` : '••••••••';
  return { hasKey: true, preview };
};
