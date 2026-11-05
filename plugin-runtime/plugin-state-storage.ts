/**
 * plugin-state-storage.ts —— 插件偏好存储的宿主侧适配器。
 *
 * 为什么需要它：
 * 偏好原来存在渲染层 `localStorage`，而 localStorage **按 origin 隔离** ——
 * dev 走 `http://localhost:4002`、直接 `npm run dev` 走另一个端口、打包后走 `file://`，
 * 是三份互不相干的存储。换个启动方式，渲染层就读不到用户的关闭记录，退回默认 profile
 * （默认 = 全部启用），表现正是"关掉的插件重启又自己开了"。
 * 现在状态由主进程落到 `userData/plugin-profile.json`，与 origin 无关，dev / 打包 / 多实例
 * 共用同一份真相。
 *
 * 之所以能做成这么薄的一层：`resolveStartupPluginProfile` 与 `PluginProfileManager`
 * 只依赖 `Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>` 这个结构接口 ——
 * 这正是当初预留的替换缝，上层代码一行都不用改。
 *
 * 契约：getItem / setItem / removeItem 全部**同步**。持久化层（persistLayer）是同步契约，
 * 写失败必须能同步抛出才会被设置页捕获并提示；所以宿主桥也用 sendSync。
 */

import { PROFILE_PATCH_STORAGE_KEY } from './profile';

/** 迁移标记：确保旧 localStorage 数据只被搬一次。 */
export const PROFILE_MIGRATION_MARKER_KEY = 'artflow.profile.patch.migrated.v1';

export interface PluginStateHostReadResult {
  ok: boolean;
  patches: unknown[] | null;
  /** file = 正常读到；backup = 主文件坏了回退快照；none = 宿主还没有偏好；unreadable = 读不出来；
   * safe-mode = 安全模式刻意忽略用户偏好（与 unreadable 语义相反：一切正常，只是没读）。 */
  source: 'file' | 'backup' | 'none' | 'unreadable' | 'safe-mode';
  schemaVersion?: number;
  message?: string;
}

export interface PluginStateHostBridge {
  readSync(): PluginStateHostReadResult;
  writeSync(patches: unknown[]): { ok: boolean; count?: number; message?: string };
  clearSync(): { ok: boolean; message?: string };
}

export type PluginPreferenceSource =
  /** 正常从宿主文件读到。 */
  | 'host-file'
  /** 宿主文件损坏，使用了备份快照。 */
  | 'host-backup'
  /** 宿主还没有偏好（全新安装）。 */
  | 'host-empty'
  /** 从旧的 localStorage 一次性迁移到宿主文件成功。 */
  | 'host-migrated'
  /** 宿主读不出来（权限/磁盘异常）。 */
  | 'host-unreadable'
  /** 安全模式（`ARTFLOW_SAFE_MODE=1`）：刻意忽略用户偏好，按默认 profile 启动。 */
  | 'host-safe-mode'
  /** 宿主桥不可用或迁移失败，仍在使用 localStorage（纯浏览器运行时的正常路径）。 */
  | 'local-storage';

export interface PluginStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** 本次偏好实际来自哪里，供启动诊断上报到 logs/electron.log。 */
  readonly source: PluginPreferenceSource;
  /** 读取/迁移过程中的异常描述；正常时为 null。设置页会把它显示成告警条。 */
  readonly warning: string | null;
}

type FallbackStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isProfileKey = (key: string): boolean => key === PROFILE_PATCH_STORAGE_KEY;

/** 逐项比较两份 patches（顺序敏感：写什么读什么才算一致）。 */
const samePatches = (left: readonly unknown[] | null, right: readonly unknown[]): boolean =>
  Array.isArray(left) && left.length === right.length && JSON.stringify(left) === JSON.stringify(right);

/** 偏好统一以 `{ patches: [...] }` 落盘（与 profile.ts 的存储格式一致）。 */
const serializePatches = (patches: readonly unknown[]): string => JSON.stringify({ patches });

/** 宽容解析：结构不对返回 null，绝不抛 —— 坏数据不应该炸掉启动。 */
const parsePatches = (raw: string | null): unknown[] | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const patches = (value as { patches?: unknown }).patches;
    return Array.isArray(patches) ? patches : null;
  } catch {
    return null;
  }
};

interface ResolvedStorage {
  patches: unknown[] | null;
  source: PluginPreferenceSource;
  warning: string | null;
}

/**
 * 解析宿主侧状态，并在"宿主为空且旧 localStorage 还有数据"时做一次性迁移。
 * 迁移失败的取舍：本次会话继续用旧值（否则用户会立刻看到全部插件复活），下次启动再重试。
 */
const resolveInitialState = (bridge: PluginStateHostBridge, fallback: FallbackStorage | null): ResolvedStorage => {
  const host = bridge.readSync();

  if (host.source === 'file' && host.ok) {
    return { patches: host.patches, source: 'host-file', warning: null };
  }
  if (host.source === 'backup') {
    return {
      patches: host.patches,
      source: 'host-backup',
      warning: host.message ?? '插件偏好文件已损坏，本次使用上次可用快照',
    };
  }
  // 安全模式：宿主**刻意**没读用户偏好 → patches 为空（全部插件按默认装载）。
  // 必须放在下面 unreadable 分支之前，更不能落到"host 为空 → 迁移旧 localStorage"那条路 ——
  // 那条路会把用户真实的旧开关记录搬回来，安全模式就白进了。没有 warning：一切正常。
  if (host.source === 'safe-mode') {
    return { patches: null, source: 'host-safe-mode', warning: null };
  }
  if (host.source !== 'none') {
    return {
      patches: null,
      source: 'host-unreadable',
      warning: host.message ?? '插件偏好无法读取，本次按默认配置（全部插件启用）启动',
    };
  }

  // source === 'none'：宿主还没有偏好。检查旧数据做一次性迁移。
  if (!fallback) return { patches: null, source: 'host-empty', warning: null };

  let legacyRaw: string | null = null;
  let alreadyMigrated = false;
  try {
    legacyRaw = fallback.getItem(PROFILE_PATCH_STORAGE_KEY);
    alreadyMigrated = fallback.getItem(PROFILE_MIGRATION_MARKER_KEY) === '1';
  } catch {
    /* 读不了旧存储就当没有旧数据 */
  }
  // 已经迁过一次就不再搬：宿主为空只能是用户主动清了偏好，不能拿旧值把它复活。
  if (alreadyMigrated) return { patches: null, source: 'host-empty', warning: null };

  const legacyPatches = parsePatches(legacyRaw);
  if (!legacyPatches || legacyPatches.length === 0) return { patches: null, source: 'host-empty', warning: null };

  const migrated = bridge.writeSync(legacyPatches);
  if (!migrated.ok) {
    return {
      patches: legacyPatches,
      source: 'local-storage',
      warning: `旧插件偏好迁移到宿主存储失败，本次仍沿用旧值：${migrated.message ?? '未知错误'}`,
    };
  }
  try {
    // 旧值不删，留作可回退的快照；标记确保它不会被再次读取。
    fallback.setItem(PROFILE_MIGRATION_MARKER_KEY, '1');
  } catch {
    /* 标记写不进去只影响下次是否重复尝试迁移，不影响本次结果 */
  }
  return { patches: legacyPatches, source: 'host-migrated', warning: null };
};

export interface PluginStateStorageOptions {
  /** 宿主桥；默认取 window.artflowPluginState（preload 暴露）。 */
  bridge?: PluginStateHostBridge | null;
  /** 迁移来源与降级目标；默认 window.localStorage。 */
  fallback?: FallbackStorage | null;
}

export const createPluginStateStorage = (options: PluginStateStorageOptions = {}): PluginStateStorage => {
  const bridge = options.bridge !== undefined
    ? options.bridge
    : (typeof window === 'undefined' ? null : window.artflowPluginState ?? null);
  const fallback = options.fallback !== undefined
    ? options.fallback
    : (typeof window === 'undefined' ? null : window.localStorage);

  // 宿主桥不可用（纯浏览器里跑 vite、或单测环境）：行为与迁移前完全一致。
  if (!bridge) {
    return {
      source: 'local-storage',
      warning: null,
      getItem: key => fallback?.getItem(key) ?? null,
      setItem: (key, value) => { fallback?.setItem(key, value); },
      removeItem: key => { fallback?.removeItem(key); },
    };
  }

  const initial = resolveInitialState(bridge, fallback);
  let cached = initial.patches ? serializePatches(initial.patches) : null;

  return {
    source: initial.source,
    warning: initial.warning,
    getItem(key) {
      return isProfileKey(key) ? cached : fallback?.getItem(key) ?? null;
    },
    setItem(key, value) {
      if (!isProfileKey(key)) {
        fallback?.setItem(key, value);
        return;
      }
      const nextPatches = parsePatches(value);
      if (!nextPatches) throw new Error('插件偏好必须是 { patches: [...] } 结构');
      const result = bridge.writeSync(nextPatches);
      if (!result.ok) throw new Error(result.message ?? '插件偏好写入失败');
      // 写后回读：确认真的落到磁盘了。只信"写入返回 ok"是不够的 ——
      // 上次就是"改了看着像成功、重启却回到默认"这种静默不一致最伤人。
      const verified = bridge.readSync();
      if (!verified.ok || !samePatches(verified.patches, nextPatches)) {
        throw new Error('插件偏好写入后校验失败：磁盘内容与本次修改不一致');
      }
      cached = serializePatches(nextPatches);
    },
    removeItem(key) {
      if (!isProfileKey(key)) {
        fallback?.removeItem(key);
        return;
      }
      const result = bridge.clearSync();
      if (!result.ok) throw new Error(result.message ?? '插件偏好清除失败');
      cached = null;
    },
  };
};
