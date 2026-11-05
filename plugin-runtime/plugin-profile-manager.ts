/**
 * Staged builtin profile management for Settings. Activation remains startup-owned.
 * ponytail: this deliberately writes only the existing user patch and uses an explicit reload instead of unsafe live plugin lifecycle changes.
 */

import { uiText as t } from '../utils/language-store';
import { validateManifest, type PluginManifest } from './manifest';
import {
  BASE_PROFILE,
  DESKTOP_PROFILE,
  PROFILE_PATCH_STORAGE_KEY,
  readStoredUserProfileLayer,
  resolvePluginProfile,
  type PluginPatch,
  type ProfileLayer,
  type ResolvedPluginProfile,
} from './profile';

export const PLUGIN_PROFILE_MANAGER_SERVICE = 'plugin.profile-manager';

type ProfileStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PluginProfileManagerSnapshot {
  activeProfile: ResolvedPluginProfile;
  pendingProfile: ResolvedPluginProfile;
  restartRequired: boolean;
  protectedPluginIds: readonly string[];
  warning: string | null;
}

export type PluginProfileMutation =
  | { ok: true; snapshot: PluginProfileManagerSnapshot }
  | { ok: false; snapshot: PluginProfileManagerSnapshot; message: string };

export interface PluginProfileManager {
  getSnapshot(): PluginProfileManagerSnapshot;
  getDisableDependents(id: string): readonly string[];
  setPluginEnabled(id: string, enabled: boolean, options?: { confirmedDependentIds: readonly string[] }): PluginProfileMutation;
  /** 合并写入插件 config patch（user 层）；非法键经 resolvePluginProfile 校验拒绝。 */
  setPluginConfig(id: string, config: Record<string, unknown>): PluginProfileMutation;
  clearEnabledOverrides(): PluginProfileMutation;
  reload(): void;
}

export interface PluginProfileManagerOptions {
  manifests: readonly unknown[];
  activeProfile: ResolvedPluginProfile;
  storage: ProfileStorage;
  reload: () => void;
  protectedPluginIds?: readonly string[];
  hostModuleIds?: readonly string[];
  warning?: string | null;
}

export interface StartupPluginProfile {
  profile: ResolvedPluginProfile;
  warning: string | null;
}

const defaultLayers = (userLayer: ProfileLayer | null): ProfileLayer[] =>
  userLayer ? [BASE_PROFILE, DESKTOP_PROFILE, userLayer] : [BASE_PROFILE, DESKTOP_PROFILE];

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const clonePatch = (patch: PluginPatch): PluginPatch => ({
  id: patch.id,
  ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
  ...(patch.config === undefined ? {} : { config: { ...patch.config } }),
});

/** Removes a persisted attempt to disable a bootstrap recovery section, without discarding its declared config. */
export const normalizeProtectedUserProfileLayer = (
  layer: ProfileLayer | null,
  protectedPluginIds: readonly string[],
  hostModuleIds: readonly string[] = [],
): ProfileLayer | null => {
  if (!layer) return null;
  const protectedIds = new Set(protectedPluginIds);
  const hostIds = new Set(hostModuleIds);
  const patches: PluginPatch[] = [];
  for (const rawPatch of layer.patches ?? []) {
    // Host modules no longer have plugin configuration or enabled overrides.
    if (hostIds.has(rawPatch.id)) continue;
    const patch = clonePatch(rawPatch);
    if (protectedIds.has(patch.id) && patch.enabled === false) delete patch.enabled;
    if (patch.enabled !== undefined || patch.config !== undefined) patches.push(patch);
  }
  return patches.length > 0 ? { id: 'user', source: 'user', patches } : null;
};

/** Startup shares the same validation and recovery policy used by the Settings service. */
export const resolveStartupPluginProfile = (
  manifests: readonly unknown[],
  storage: Pick<Storage, 'getItem'>,
  protectedPluginIds: readonly string[] = [],
  hostModuleIds: readonly string[] = [],
): StartupPluginProfile => {
  try {
    const userLayer = normalizeProtectedUserProfileLayer(readStoredUserProfileLayer(storage), protectedPluginIds, hostModuleIds);
    return { profile: resolvePluginProfile(manifests, defaultLayers(userLayer)), warning: null };
  } catch (error) {
    const warning = errorMessage(error);
    console.error('[profile] stored patch ignored:', warning);
    return { profile: resolvePluginProfile(manifests, [BASE_PROFILE, DESKTOP_PROFILE]), warning };
  }
};

const profileFingerprint = (profile: ResolvedPluginProfile): string => JSON.stringify(profile.plugins.map(plugin => ({
  id: plugin.id,
  enabled: plugin.enabled,
  config: plugin.config,
})));

const withEnabledOverride = (layer: ProfileLayer | null, id: string, enabled: boolean): ProfileLayer => {
  const patches = (layer?.patches ?? []).map(clonePatch);
  const current = patches.find(patch => patch.id === id);
  if (current) current.enabled = enabled;
  else patches.push({ id, enabled });
  return { id: 'user', source: 'user', patches };
};

const withoutEnabledOverrides = (layer: ProfileLayer | null): ProfileLayer | null => {
  const patches = (layer?.patches ?? []).flatMap(rawPatch => {
    const patch = clonePatch(rawPatch);
    delete patch.enabled;
    return patch.config === undefined ? [] : [patch];
  });
  return patches.length > 0 ? { id: 'user', source: 'user', patches } : null;
};

/** 合并（而非覆盖）该插件在 user 层的 config patch。 */
const withConfigOverride = (layer: ProfileLayer | null, id: string, config: Record<string, unknown>): ProfileLayer => {
  const patches = (layer?.patches ?? []).map(clonePatch);
  const current = patches.find(patch => patch.id === id);
  if (current) current.config = { ...(current.config ?? {}), ...config };
  else patches.push({ id, config: { ...config } });
  return { id: 'user', source: 'user', patches };
};

const persistLayer = (storage: ProfileStorage, layer: ProfileLayer | null): void => {
  if (!layer) {
    storage.removeItem(PROFILE_PATCH_STORAGE_KEY);
    return;
  }
  storage.setItem(PROFILE_PATCH_STORAGE_KEY, JSON.stringify({ patches: layer.patches ?? [] }));
};

export const createPluginProfileManager = ({
  manifests,
  activeProfile,
  storage,
  reload,
  protectedPluginIds = [],
  hostModuleIds = [],
  warning = null,
}: PluginProfileManagerOptions): PluginProfileManager => {
  // 隔离原则：非法 manifest 只跳过并报错，不让管理面/设置页因单个坏插件瘫痪。
  const validatedManifests: PluginManifest[] = [];
  for (const rawManifest of manifests) {
    try {
      validatedManifests.push(validateManifest(rawManifest));
    } catch (error) {
      console.error('[profile-manager] manifest rejected:', error);
    }
  }
  const knownIds = new Set(validatedManifests.map(manifest => manifest.id));
  const protectedIds = new Set(protectedPluginIds);
  let pendingProfile = activeProfile;
  let currentWarning = warning;

  const snapshot = (): PluginProfileManagerSnapshot => ({
    activeProfile,
    pendingProfile,
    restartRequired: profileFingerprint(activeProfile) !== profileFingerprint(pendingProfile),
    protectedPluginIds: [...protectedIds],
    warning: currentWarning,
  });

  const readLayer = (): ProfileLayer | null => {
    const layer = normalizeProtectedUserProfileLayer(readStoredUserProfileLayer(storage), [...protectedIds], hostModuleIds);
    try {
      resolvePluginProfile(validatedManifests, defaultLayers(layer));
      return layer;
    } catch (error) {
      // A startup-invalid saved patch was already ignored; a new Settings choice may safely replace it.
      currentWarning = errorMessage(error);
      return null;
    }
  };

  const applyLayer = (nextLayer: ProfileLayer | null, changedPluginId?: string): PluginProfileMutation => {
    let nextProfile: ResolvedPluginProfile;
    try {
      nextProfile = resolvePluginProfile(validatedManifests, defaultLayers(nextLayer));
    } catch (error) {
      return { ok: false, snapshot: snapshot(), message: errorMessage(error) };
    }
    // 隔离语义：非法 config/依赖问题的 patch 会被解析器拒收。针对本次改动目标插件的拒绝 → 不落盘，回告原因。
    if (changedPluginId) {
      const rejection = nextProfile.rejected.find(entry => entry.id === changedPluginId);
      if (rejection) {
        return { ok: false, snapshot: snapshot(), message: rejection.reason };
      }
    }
    try {
      persistLayer(storage, nextLayer);
    } catch (error) {
      return { ok: false, snapshot: snapshot(), message: t(`无法保存插件偏好设置：${errorMessage(error)}`, `Cannot save plugin preference: ${errorMessage(error)}`) };
    }
    pendingProfile = nextProfile;
    currentWarning = null;
    return { ok: true, snapshot: snapshot() };
  };

  const getDisableDependents = (id: string): readonly string[] => {
    const affected = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const plugin of pendingProfile.plugins) {
        if (plugin.enabled && !affected.has(plugin.id) && plugin.requires.some(required => affected.has(required))) {
          affected.add(plugin.id);
          changed = true;
        }
      }
    }
    return [...affected].filter(affectedId => affectedId !== id);
  };

  return {
    getSnapshot: snapshot,
    getDisableDependents,
    setPluginEnabled(id, enabled, options) {
      if (!knownIds.has(id)) return { ok: false, snapshot: snapshot(), message: t(`未知插件：${id}`, `Unknown plugin: ${id}`) };
      if (!enabled && protectedIds.has(id)) {
        return { ok: false, snapshot: snapshot(), message: t('这个「设置」恢复插件不能在此处停用。', 'This Settings recovery plugin cannot be disabled here.') };
      }
      const dependents = enabled ? [] : getDisableDependents(id);
      if (!enabled) {
        const confirmed = new Set(options?.confirmedDependentIds ?? []);
        const confirmationMatches = options !== undefined && confirmed.size === dependents.length
          && dependents.every(dependent => confirmed.has(dependent));
        if ((dependents.length > 0 || options !== undefined) && !confirmationMatches) {
          return {
            ok: false,
            snapshot: snapshot(),
            message: t(
              `无法停用 ${id}：仍有已启用的插件依赖它（${dependents.join('、')}）。请先停用这些插件。`,
              `Cannot disable ${id}: enabled plugins require it (${dependents.join(', ')}). Disable them first.`,
            ),
          };
        }
      }
      let layer: ProfileLayer | null;
      try {
        layer = readLayer();
      } catch (error) {
        return { ok: false, snapshot: snapshot(), message: t(`无法读取插件偏好设置：${errorMessage(error)}`, `Cannot read plugin preference: ${errorMessage(error)}`) };
      }
      if (dependents.some(dependent => protectedIds.has(dependent))) {
        return { ok: false, snapshot: snapshot(), message: t('关联插件包含不能停用的恢复入口。', 'A dependent recovery plugin cannot be disabled.') };
      }
      for (const dependent of dependents) layer = withEnabledOverride(layer, dependent, false);
      return applyLayer(withEnabledOverride(layer, id, enabled), id);
    },
    setPluginConfig(id, config) {
      if (!knownIds.has(id)) return { ok: false, snapshot: snapshot(), message: t(`未知插件：${id}`, `Unknown plugin: ${id}`) };
      if (Object.keys(config).length === 0) return { ok: true, snapshot: snapshot() };
      let layer: ProfileLayer | null;
      try {
        layer = readLayer();
      } catch (error) {
        return { ok: false, snapshot: snapshot(), message: t(`无法读取插件偏好设置：${errorMessage(error)}`, `Cannot read plugin preference: ${errorMessage(error)}`) };
      }
      // configSchema 键/类型校验在 resolvePluginProfile → validateConfigPatch 里做；非法 patch 会被拒绝且不落盘。
      return applyLayer(withConfigOverride(layer, id, config), id);
    },
    clearEnabledOverrides() {
      let layer: ProfileLayer | null;
      try {
        layer = readLayer();
      } catch (error) {
        return { ok: false, snapshot: snapshot(), message: t(`无法读取插件偏好设置：${errorMessage(error)}`, `Cannot read plugin preference: ${errorMessage(error)}`) };
      }
      return applyLayer(withoutEnabledOverrides(layer));
    },
    reload,
  };
};
