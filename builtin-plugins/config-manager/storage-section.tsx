/**
 * storage-section —— 存储管理（设置页 "存储" 分组）。
 *
 * 回答的是"我的数据到底在哪、有多大、坏没坏"这三个问题 —— 在这套数据层之前，
 * 用户数据散在 Chromium 的 leveldb 里，这三个问题一个都答不上来。
 *
 * 只读 + 一个动作（清空缓存）。清空缓存严格限定在 `userData/temp`：主进程侧还有一道
 * 路径守卫（basename 必须是 temp 且在 userData 之下），因为删错目录是不可逆的。
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import { SectionBlock } from '../../plugin-runtime/settings-ui';
import type { StorageOverview } from '../../types';

const api = () => (typeof window === 'undefined' ? undefined : window.artflowConfig);

const buttonClass = 'rounded-md border border-white/10 bg-white/[0.06] px-3 py-1 text-sm text-neutral-200 transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const formatTime = (iso: string | null, fallback: string): string => {
  if (!iso) return fallback;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString();
};

const VOLUME_LABELS: Record<string, { en: string; zho: string }> = {
  preferences: { en: 'Preferences', zho: '偏好' },
  workspace: { en: 'Workspace layout', zho: '工作区布局' },
  'recent-files': { en: 'Recent projects', zho: '最近工程' },
  secrets: { en: 'Secrets', zho: '密钥' },
};

export const StorageSection: React.FC<SettingsSectionProps> = ({ language }) => {
  const zho = language === 'zho';
  const t = {
    volumes: zho ? '配置卷' : 'Config volumes',
    volume: zho ? '卷' : 'Volume',
    size: zho ? '大小' : 'Size',
    entries: zho ? '条目' : 'Entries',
    updated: zho ? '最后写入' : 'Last write',
    source: zho ? '来源' : 'Source',
    never: zho ? '从未写入' : 'Never',
    missing: zho ? '文件不存在' : 'File missing',
    degraded: zho ? '降级' : 'degraded',
    inPreset: zho ? '入预设' : 'in preset',
    encrypted: zho ? '已加密' : 'encrypted',
    cache: zho ? '会话缓存' : 'Session cache',
    cacheHint: zho
      ? '中间产物与临时文件。清空它不会影响工程数据或用户配置。'
      : 'Intermediate and temporary files. Clearing this does not touch project data or user configuration.',
    clear: zho ? '清空缓存' : 'Clear cache',
    cleared: zho ? '已清空' : 'Cleared',
    presetsDir: zho ? '预设目录' : 'Presets folder',
    configRoot: zho ? '配置根目录' : 'Config root',
    secretScheme: zho ? '密钥存储方式' : 'Secret storage',
    schemeSafe: zho ? '系统钥匙串（safeStorage）' : 'OS keychain (safeStorage)',
    schemePlain: zho ? '明文（钥匙串不可用）' : 'Plain text (keychain unavailable)',
    safeModeOn: zho
      ? '当前处于安全模式：以下信息报的是磁盘真相，但本次会话不会写入任何数据。'
      : 'Safe mode is on: the numbers below are the on-disk truth, but this session writes nothing.',
    loading: zho ? '读取中…' : 'Loading…',
    refresh: zho ? '刷新' : 'Refresh',
  };

  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const bridge = api();
    if (!bridge?.storageOverview) return;
    try {
      setOverview(await bridge.storageOverview());
    } catch (error) {
      console.warn('Failed to read storage overview:', error);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleClearCache = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api()?.clearCache?.();
      setNote(result && result.ok === false ? (result.message ?? '') : t.cleared);
      await refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refresh, t.cleared]);

  if (!overview) {
    return <SectionBlock title={t.volumes}><p className="px-0.5 text-xs text-neutral-500">{t.loading}</p></SectionBlock>;
  }

  // 显式标注：`Object.entries` 对 `Record<string, 交叉类型>` 的推断在某些 tsconfig 组合下
  // 会退化成 unknown，显式收窄比在 JSX 里到处 `as` 干净。
  const volumeEntries = Object.entries(overview.volumes) as Array<[string, StorageOverview['volumes'][string]]>;

  return (
    <>
      <SectionBlock title={t.volumes}>
        {overview.safeMode && (
          <p data-bp-storage-safemode="" className="px-0.5 text-xs text-amber-300">{t.safeModeOn}</p>
        )}
        <div className="space-y-1.5">
          {volumeEntries.map(([name, stats]) => (
            <div key={name} data-bp-storage-volume={name}
              className="rounded-md border border-white/[0.06] bg-black/20 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-neutral-200">{(VOLUME_LABELS[name] ?? { en: name, zho: name })[zho ? 'zho' : 'en']}</span>
                <code className="text-[11px] text-neutral-500">{name}.json</code>
                <span className="flex-1" />
                {stats.inPreset && <span className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] text-neutral-400">{t.inPreset}</span>}
                {stats.encrypted && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">{t.encrypted}</span>}
                {stats.degraded && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">{t.degraded}</span>}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-neutral-500">
                <span>{t.size}: {formatBytes(stats.bytes)}</span>
                <span>{t.entries}: {stats.keyCount}</span>
                <span>{t.source}: {stats.source}</span>
                <span>{t.updated}: {formatTime(stats.updatedAt, t.never)}</span>
              </div>
            </div>
          ))}
        </div>
      </SectionBlock>

      <SectionBlock title={t.cache}>
        <p className="px-0.5 text-[11px] leading-4 text-neutral-500">{t.cacheHint}</p>
        <div className="flex items-center gap-3">
          <button type="button" disabled={busy} data-bp-storage-clear-cache=""
            className={buttonClass} onClick={() => void handleClearCache()}>
            {t.clear}
          </button>
          <span className="text-xs text-neutral-400">{formatBytes(overview.cache.bytes)}</span>
          {note && <span data-bp-storage-note="" className="text-xs text-emerald-300">{note}</span>}
        </div>
      </SectionBlock>

      <SectionBlock title={zho ? '位置' : 'Locations'}>
        <div className="space-y-1 text-[11px] text-neutral-500">
          <div className="flex gap-2"><span className="shrink-0 text-neutral-400">{t.configRoot}</span><code className="truncate">{overview.configRoot}</code></div>
          <div className="flex gap-2"><span className="shrink-0 text-neutral-400">{t.presetsDir}</span><code className="truncate">{overview.presetsDir}</code></div>
          <div className="flex gap-2">
            <span className="shrink-0 text-neutral-400">{t.secretScheme}</span>
            <code>{overview.secret.encrypted ? t.schemeSafe : t.schemePlain}</code>
          </div>
        </div>
      </SectionBlock>
    </>
  );
};
