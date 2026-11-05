import { resolveServiceBindings, type ServiceBindings } from './service-directory';
/**
 * profile.ts —— 启动期组合控制面。
 *
 * profile / user patch 只决定已验证的 capability plugin 是否装载，以及它们已声明的配置。
 * Runtime Core 不在此图中，因此 camera、renderer、spatial index、storage 与 IPC 无法被 patch 禁用。
 */

import {
  validateManifest,
  type PluginConfigValueKind,
  type PluginManifest,
  type PluginResourceBudget,
} from './manifest';
import type { LocalizedManifestText } from './i18n';

export const PROFILE_PATCH_STORAGE_KEY = 'artflow.profile.patch.v1';

/** Runtime Core 仅作诊断保留，绝不作为 plugin manifest / patch target。 */
export const RUNTIME_CORE_IDS = [
  'runtime.camera',
  'runtime.viewport',
  'runtime.spatial-index',
  'runtime.renderer',
  'runtime.operation-log',
  'runtime.storage-protocol',
  'runtime.worker-lifecycle',
  'runtime.ipc-security',
] as const;
const RUNTIME_CORE_ID_SET = new Set<string>(RUNTIME_CORE_IDS);

export type ProfileLayerSource = 'base' | 'mode' | 'workspace' | 'user' | 'temporary';

export interface PluginPatch {
  id: string;
  enabled?: boolean;
  config?: Readonly<Record<string, unknown>>;
}

export interface ProfileLayer {
  serviceBindings?: ServiceBindings;
  id: string;
  source: ProfileLayerSource;
  patches?: readonly PluginPatch[];
}

export interface ResolvedPlugin {
  id: string;
  name: string;
  /** 插件名的语言覆盖（manifest.nameI18n）；管理面板按当前语言解析。 */
  nameI18n?: LocalizedManifestText;
  /** 一句话简介（manifest.description），管理面板展示用；缺省 undefined。 */
  description?: string;
  /** 简介的语言覆盖（manifest.descriptionI18n）。 */
  descriptionI18n?: LocalizedManifestText;
  /** 管理面板分组类型；缺省 other。 */
  category: PluginManifest['category'];
  /**
   * 运行通道（manifest.runtime.mode）：`builtin` 编译进本体、装完不可改；
   * `editable` 源码在用户目录、装完可直接改（即第三方）。管理面板据此分档。
   */
  runtimeMode: PluginManifest['runtime']['mode'];
  /** 可编辑插件的源码句柄（主进程注入 `editable:<id>`）；管理面板「打开文件夹」用。内置插件无此字段。 */
  sourceDir?: string;
  author: string;
  license: string;
  version: string;
  host: PluginManifest['host'];
  capabilities: readonly string[];
  enabled: boolean;
  requires: readonly string[];
  optionalRequires: readonly string[];
  config: Readonly<Record<string, unknown>>;
  /** schema 驱动的配置表单（manifest.configSchema：键 → boolean/number/string）。 */
  configSchema?: Readonly<Record<string, 'boolean' | 'number' | 'string'>>;
  resourceBudget?: Readonly<PluginResourceBudget>;
  /** 按优先级记录此插件被哪些层影响，供 --dump-profile / diagnostics 使用。 */
  sources: readonly string[];
  /** manifest 透传：聚合插件的子模块元数据（管理界面展示用，不参与运行时注册）。 */
  contributes?: PluginManifest['contributes'];
}

export interface ResolvedPluginProfile {
  serviceBindings?: ServiceBindings;
  layers: readonly { id: string; source: ProfileLayerSource }[];
  plugins: readonly ResolvedPlugin[];
  enabledPluginIds: readonly string[];
  /**
   * 被拒的插件与其原因（manifest 非法 / 重复 id / 依赖缺失被停用等）。
   * 隔离原则（Blender 语义）：单个插件损坏只拒绝该插件并记录原因，绝不阻断本体启动。
   */
  rejected: readonly ResolvedPluginRejection[];
}

export interface ResolvedPluginRejection {
  /** 拒绝时能从原始 manifest 抢救出的 id；完全读不出时为 undefined。 */
  id?: string;
  name?: string;
  /** 名的语言覆盖；管理面板按当前语言解析。 */
  nameI18n?: LocalizedManifestText;
  reason: string;
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

export const BASE_PROFILE: ProfileLayer = Object.freeze({ id: 'base', source: 'base', patches: [] });
export const DESKTOP_PROFILE: ProfileLayer = Object.freeze({ id: 'desktop', source: 'mode', patches: [] });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function normalizePatch(raw: unknown, layerId: string): PluginPatch {
  if (!isObject(raw)) throw new ProfileError(`profile layer ${layerId} contains a non-object patch`);
  const allowed = ['id', 'enabled', 'config'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new ProfileError(`profile layer ${layerId} patch has unknown field: ${key}`);
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    throw new ProfileError(`profile layer ${layerId} patch id is required`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new ProfileError(`profile layer ${layerId} patch ${raw.id}.enabled must be boolean`);
  }
  if (raw.config !== undefined && !isObject(raw.config)) {
    throw new ProfileError(`profile layer ${layerId} patch ${raw.id}.config must be an object`);
  }
  if (raw.enabled === undefined && raw.config === undefined) {
    throw new ProfileError(`profile layer ${layerId} patch ${raw.id} has no effect`);
  }
  const config = isObject(raw.config) ? { ...raw.config } : undefined;
  return {
    id: raw.id,
    enabled: raw.enabled as boolean | undefined,
    config,
  };
}

function normalizeLayer(raw: ProfileLayer, index: number): Required<Pick<ProfileLayer, 'id' | 'source' | 'patches'>> {
  if (!isObject(raw)) throw new ProfileError(`profile layer at index ${index} must be an object`);
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    throw new ProfileError(`profile layer at index ${index} needs an id`);
  }
  if (!['base', 'mode', 'workspace', 'user', 'temporary'].includes(raw.source)) {
    throw new ProfileError(`profile layer ${raw.id} has unsupported source: ${String(raw.source)}`);
  }
  if (raw.patches !== undefined && !Array.isArray(raw.patches)) {
    throw new ProfileError(`profile layer ${raw.id}.patches must be an array`);
  }
  const seen = new Set<string>();
  const patches = (raw.patches ?? []).map(patch => normalizePatch(patch, raw.id));
  for (const patch of patches) {
    if (seen.has(patch.id)) throw new ProfileError(`profile layer ${raw.id} patches ${patch.id} more than once`);
    seen.add(patch.id);
  }
  return { id: raw.id, source: raw.source, patches };
}

function valueMatchesKind(value: unknown, kind: PluginConfigValueKind): boolean {
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === kind;
}

function validateConfigPatch(manifest: PluginManifest, config: Readonly<Record<string, unknown>>, layerId: string): void {
  const schema = manifest.configSchema ?? {};
  for (const [key, value] of Object.entries(config)) {
    const kind = schema[key];
    if (!kind) {
      throw new ProfileError(`profile layer ${layerId} cannot set undeclared config ${manifest.id}.${key}`);
    }
    if (!valueMatchesKind(value, kind)) {
      throw new ProfileError(`profile layer ${layerId} config ${manifest.id}.${key} must be ${kind}`);
    }
  }
}

interface MutablePluginState {
  manifest: PluginManifest;
  enabled: boolean;
  config: Record<string, unknown>;
  sources: string[];
  /** 非致命拒绝原因（依赖缺失停用/依赖环）；致命拒绝不进 states。 */
  rejectionReason?: string;
}

function assertDependencyGraph(states: Map<string, MutablePluginState>): void {
  // 缺失依赖：把依赖方停用（记录原因），而不是炸掉整个 profile。
  let changed = true;
  while (changed) {
    changed = false;
    for (const state of states.values()) {
      if (!state.enabled) continue;
      for (const requiredId of state.manifest.requires) {
        const dependency = states.get(requiredId);
        if (!dependency || !dependency.enabled) {
          state.enabled = false;
          state.rejectionReason = `disabled: requires ${dependency ? 'disabled' : 'missing'} plugin ${requiredId}`;
          changed = true;
          break;
        }
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      // 依赖环是 manifest 缺陷，但装载顺序本就按声明序，记录即可，不必致命。
      states.get(id)!.rejectionReason = states.get(id)!.rejectionReason ?? 'dependency cycle detected';
      visited.add(id);
      return;
    }
    visiting.add(id);
    for (const dependency of states.get(id)!.manifest.requires) {
      if (states.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of states.keys()) visit(id);
}

/**
 * 将 validated manifest 和优先级由低到高的 profile layers 合并成不可变启动快照。
 * 此函数只能在启动 / 明确 reload 时调用；render 和 pointermove 热路径不得调用它。
 */
export function resolvePluginProfile(
  rawManifests: readonly unknown[],
  rawLayers: readonly ProfileLayer[],
): ResolvedPluginProfile {
  const states = new Map<string, MutablePluginState>();
  const rejections: ResolvedPluginRejection[] = [];
  const reject = (reason: string, rawManifest?: unknown): void => {
    const source = isObject(rawManifest) ? rawManifest : undefined;
    rejections.push({
      id: typeof source?.id === 'string' ? source.id : undefined,
      name: typeof source?.name === 'string' ? source.name : undefined,
      reason,
    });
  };
  for (const rawManifest of rawManifests) {
    let manifest: PluginManifest;
    try {
      manifest = validateManifest(rawManifest);
    } catch (error) {
      reject(`invalid manifest: ${error instanceof Error ? error.message : String(error)}`, rawManifest);
      continue;
    }
    if (RUNTIME_CORE_ID_SET.has(manifest.id)) {
      reject(`Runtime Core cannot be declared as a plugin: ${manifest.id}`, rawManifest);
      continue;
    }
    if (states.has(manifest.id)) {
      reject(`duplicate plugin manifest id: ${manifest.id}`, rawManifest);
      continue;
    }
    states.set(manifest.id, { manifest, enabled: true, config: {}, sources: ['builtin'] });
  }

  const layerIds = new Set<string>();
  const layers = rawLayers.map(normalizeLayer);
  for (const layer of layers) {
    if (layerIds.has(layer.id)) throw new ProfileError(`duplicate profile layer id: ${layer.id}`);
    layerIds.add(layer.id);
    for (const patch of layer.patches) {
      if (RUNTIME_CORE_ID_SET.has(patch.id)) {
        reject(`Runtime Core cannot be changed by profile patch: ${patch.id}`);
        continue;
      }
      const state = states.get(patch.id);
      if (!state) {
        // 引用不存在的插件（常见于插件已卸载的遗留 patch）：忽略该 patch，不炸启动。
        reject(`profile layer ${layer.id} references unknown plugin: ${patch.id}`);
        continue;
      }
      try {
        if (patch.enabled !== undefined) state.enabled = patch.enabled;
        if (patch.config) {
          validateConfigPatch(state.manifest, patch.config, layer.id);
          Object.assign(state.config, patch.config);
        }
        state.sources.push(layer.id);
      } catch (error) {
        reject(`patch from layer ${layer.id} for ${patch.id} ignored: ${error instanceof Error ? error.message : String(error)}`, state.manifest);
      }
    }
  }

  assertDependencyGraph(states);

  const plugins = [...states.values()].map<ResolvedPlugin>(state => ({
    id: state.manifest.id,
    name: state.manifest.name,
    nameI18n: state.manifest.nameI18n,
    description: state.manifest.description,
    descriptionI18n: state.manifest.descriptionI18n,
    category: state.manifest.category ?? 'other',
    runtimeMode: state.manifest.runtime.mode,
    sourceDir: state.manifest.sourceDir,
    author: state.manifest.author,
    license: state.manifest.license,
    version: state.manifest.version,
    host: state.manifest.host,
    capabilities: [...state.manifest.capabilities],
    enabled: state.enabled,
    requires: [...state.manifest.requires],
    optionalRequires: [...state.manifest.optionalRequires],
    config: { ...state.config },
    configSchema: state.manifest.configSchema ? { ...state.manifest.configSchema } : undefined,
    resourceBudget: state.manifest.resourceBudget ? { ...state.manifest.resourceBudget } : undefined,
    sources: [...state.sources],
    ...(state.manifest.contributes ? { contributes: state.manifest.contributes } : {}),
  }));
  for (const state of states.values()) {
    if (state.rejectionReason) {
      rejections.push({ id: state.manifest.id, name: state.manifest.name, nameI18n: state.manifest.nameI18n, reason: state.rejectionReason });
    }
  }
  const profile: ResolvedPluginProfile = {
    serviceBindings: resolveServiceBindings(rawLayers),
    layers: layers.map(layer => ({ id: layer.id, source: layer.source })),
    plugins,
    enabledPluginIds: plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id),
    rejected: deepFreeze(rejections),
  };
  return deepFreeze(profile);
}

/** 稳定、可复制的 resolved-profile dump，供 CLI / diagnostics 页面复用。 */
export function dumpResolvedProfile(profile: ResolvedPluginProfile): string {
  return JSON.stringify(profile, null, 2);
}

/**
 * 从 localStorage 读取用户 patch。配置只能声明 patches，不能伪造 base/mode/workspace 层。
 * 解析和 schema 校验仍在 resolvePluginProfile 中执行；调用者应在失败时回退默认 profile 并显示诊断。
 */
export function readStoredUserProfileLayer(storage: Pick<Storage, 'getItem'>): ProfileLayer | null {
  let serialized: string | null;
  try {
    serialized = storage.getItem(PROFILE_PATCH_STORAGE_KEY);
  } catch (error) {
    throw new ProfileError(`cannot read stored profile patch: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!serialized) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new ProfileError(`stored profile patch is not valid JSON (${PROFILE_PATCH_STORAGE_KEY})`);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.patches)) {
    throw new ProfileError(`stored profile patch must be { patches: [...] } (${PROFILE_PATCH_STORAGE_KEY})`);
  }
  // Legacy aggregate preference fans out once; an explicit split preference always wins.
  const patches = parsed.patches.map(patch => normalizePatch(patch, 'user'));
  const splitCardIds = ['builtin.cards-media', 'builtin.cards-files', 'builtin.cards-reader'];
  const explicitIds = new Set(patches.map(patch => patch.id));
  const migrated = patches.flatMap(patch => patch.id === 'builtin.cards'
    ? splitCardIds.filter(id => !explicitIds.has(id)).map(id => ({ ...patch, id }))
    : [patch]);
  return { id: 'user', source: 'user', patches: migrated };
}
