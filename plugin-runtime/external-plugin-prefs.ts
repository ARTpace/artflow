/**
 * Enable state for installed third-party plugins.
 * Builtin profiles do not own these ids. A missing entry means enabled.
 */
import { createPreferenceStorage } from './preference-storage';

const STORAGE_KEY = 'artflow.external-plugins.disabled';
const ID_PATTERN = /^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * 第三方插件开关的存储：从 localStorage（按 origin 隔离）搬到主进程 config/preferences.json，
 * 键 `plugins.external.disabled`。适配器的接口就是 `Pick<Storage, ...>`，
 * 所以下面所有读写函数**一行都没改** —— 这也印证了当初把存储抽成参数的"替换缝"是对的。
 */
export const externalPluginStorage = createPreferenceStorage({
  namespace: 'plugins.external',
  toPreferenceKey: () => 'plugins.external.disabled',
});

const browserStorage = (): Pick<Storage, 'getItem' | 'setItem'> => externalPluginStorage;

const readIds = (storage: Pick<Storage, 'getItem'>): string[] => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === 'string' && ID_PATTERN.test(id)).slice(0, 32);
  } catch {
    return [];
  }
};

export const readDisabledExternalPluginIds = (storage: Pick<Storage, 'getItem'>): string[] => readIds(storage);

export const isExternalPluginEnabled = (storage: Pick<Storage, 'getItem'>, id: string): boolean =>
  !readIds(storage).includes(id);

export const setExternalPluginEnabled = (
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  id: string,
  enabled: boolean,
): string[] => {
  const next = new Set(readIds(storage));
  if (enabled) next.delete(id);
  else next.add(id);
  const ids = [...next];
  storage.setItem(STORAGE_KEY, JSON.stringify(ids));
  return ids;
};

export const clearDisabledExternalPlugins = (storage: Pick<Storage, 'setItem'>): void => {
  storage.setItem(STORAGE_KEY, '[]');
};

export const readBrowserDisabledExternalPluginIds = (): string[] => readIds(browserStorage());

/** 外部插件（声明式 / 沙箱 / 客户端面板）是否启用。调用方不必自己碰 window.localStorage。 */
export const isExternalPluginEnabledById = (id: string): boolean =>
  isExternalPluginEnabled(externalPluginStorage, id);

// An external plugin's saved preference can change without hot-loading/unloading its code.
// Capture the startup preference ONCE, before any settings UI can change it. A Settings
// section is unmounted on navigation, so its own useState initializer is not a reliable
// record of what this session actually started with.
let startupDisabledIds: readonly string[] | null = null;
export const captureStartupDisabledExternalPluginIds = (storage: Pick<Storage, 'getItem'>): readonly string[] => {
  if (startupDisabledIds === null) startupDisabledIds = Object.freeze(readDisabledExternalPluginIds(storage));
  return startupDisabledIds;
};

export const readStartupDisabledExternalPluginIds = (): readonly string[] =>
  captureStartupDisabledExternalPluginIds(browserStorage());

export const setBrowserExternalPluginEnabled = (id: string, enabled: boolean): string[] =>
  setExternalPluginEnabled(browserStorage(), id, enabled);

export const clearBrowserDisabledExternalPlugins = (): void => {
  clearDisabledExternalPlugins(browserStorage());
};
