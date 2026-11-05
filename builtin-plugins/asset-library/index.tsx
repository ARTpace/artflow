/**
 * builtin.asset-library —— 托管资产库数据管理。
 * 清单和清理都走 host.platform，不直接碰 preload / 文件系统。
 * 主进程拒绝删除已保存工程和进行中导入点名的记录；当前画板的 assetId 作为 protectIds 再挡一层。
 */

import React, { useCallback, useState } from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import type { SettingsSectionContribution, SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import { CANVAS_MUTATION_SERVICE, type CanvasMutationService } from '../../plugin-runtime/canvas-mutation';
import type { AssetInventoryPage } from '../../types';
import manifest from './manifest.json';

const PAGE_SIZE = 50;

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const liveAssetIds = (kernel: Kernel): string[] => {
  if (!kernel.has(CANVAS_MUTATION_SERVICE)) return [];
  const ids = new Set<string>();
  const mutation: CanvasMutationService = kernel.use(CANVAS_MUTATION_SERVICE);
  for (const element of mutation.getElements()) {
    if (typeof element.assetId === 'string' && element.assetId.length > 0) ids.add(element.assetId);
  }
  return [...ids];
};

const AssetLibrarySection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const zho = language === 'zho';
  const [page, setPage] = useState<AssetInventoryPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [liveIds, setLiveIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (nextOffset: number, nextUnusedOnly: boolean) => {
    setBusy(true);
    setMessage(null);
    const protecting = liveAssetIds(kernel);
    setLiveIds(protecting);
    const host: HostPlatformService = kernel.use(HOST_PLATFORM_SERVICE);
    const result = await host.listAssetInventory({ offset: nextOffset, limit: PAGE_SIZE, unreferencedOnly: nextUnusedOnly });
    setBusy(false);
    if (result.ok === false) {
      setPage(null);
      setMessage(result.message);
      return;
    }
    setPage(result.inventory);
    setOffset(nextOffset);
    setSelected([]);
  }, [kernel]);

  const reclaim = async () => {
    if (!page || selected.length === 0) return;
    const protecting = liveAssetIds(kernel);
    const live = new Set(protecting);
    const targets = selected.filter(id => {
      const item = page.items.find(entry => entry.id === id);
      return item && item.usage === 'none' && !live.has(id);
    });
    if (targets.length === 0) {
      setMessage(zho ? '所选记录仍被工程或当前画板引用。' : 'Selected records are still referenced.');
      return;
    }
    const confirmed = window.confirm(zho
      ? `清理 ${targets.length} 条未被工程引用的资产？共享文件会保留。此操作不能撤销。`
      : `Remove ${targets.length} unreferenced asset records? Shared files stay. This cannot be undone.`);
    if (!confirmed) return;
    setBusy(true);
    const host: HostPlatformService = kernel.use(HOST_PLATFORM_SERVICE);
    const result = await host.reclaimUnreferencedAssets({ assetIds: targets, protectIds: protecting });
    if (result.ok === false) {
      setBusy(false);
      setMessage(result.message);
      return;
    }
    setMessage(zho
      ? `已清理 ${result.result.removed.length} 条，释放 ${formatBytes(result.result.freedBytes)}。保留 ${result.result.kept.length} 条。`
      : `Removed ${result.result.removed.length}, freed ${formatBytes(result.result.freedBytes)}. Kept ${result.result.kept.length}.`);
    await load(offset, unusedOnly);
  };

  const live = new Set(liveIds);
  const usageLabel = (usage: 'document' | 'import' | 'none', id: string) => {
    if (usage === 'document') return zho ? '工程引用' : 'In project';
    if (usage === 'import') return zho ? '导入中' : 'Importing';
    if (live.has(id)) return zho ? '当前画板' : 'On canvas';
    return zho ? '未引用' : 'Unused';
  };

  return (
    <div className="space-y-3">
      <p className="text-sm leading-5 text-neutral-400">
        {zho
          ? '这里看的是当前托管工程里的资产记录。清理只会删掉已保存工程和当前画板都没有用到的记录；内容相同的其他记录还在时，文件会留下。'
          : 'Records in the open managed project. Cleanup removes rows unused by the saved project and the current board. Shared files stay.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => { void load(0, unusedOnly); }}
          className="rounded-md bg-violet-500 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {zho ? '刷新' : 'Refresh'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const next = !unusedOnly;
            setUnusedOnly(next);
            void load(0, next);
          }}
          className={`rounded-md px-3 py-1.5 text-sm ${unusedOnly ? 'bg-white/15 text-white' : 'text-neutral-300 hover:bg-white/10'}`}
        >
          {zho ? '只看未引用' : 'Unused only'}
        </button>
        <button
          type="button"
          disabled={busy || selected.length === 0}
          onClick={() => { void reclaim(); }}
          className="rounded-md px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40"
        >
          {zho ? `清理所选 (${selected.length})` : `Remove selected (${selected.length})`}
        </button>
      </div>
      {page && (
        <div className="grid grid-cols-2 gap-2 text-sm text-neutral-300 sm:grid-cols-4">
          <div className="rounded-lg bg-black/20 px-3 py-2">{zho ? '记录' : 'Records'} {page.totalAssets}</div>
          <div className="rounded-lg bg-black/20 px-3 py-2">{zho ? '文件' : 'Files'} {page.uniqueBlobs}</div>
          <div className="rounded-lg bg-black/20 px-3 py-2">{formatBytes(page.uniqueBytes)}</div>
          <div className="rounded-lg bg-black/20 px-3 py-2">{zho ? '未引用' : 'Unused'} {page.unreferencedAssets}</div>
        </div>
      )}
      {message && <p className="text-sm text-amber-200/90">{message}</p>}
      {page && page.items.length === 0 && (
        <p className="text-sm text-neutral-500">{zho ? '这一页没有记录。' : 'Nothing on this page.'}</p>
      )}
      {page && page.items.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-white/[0.06]">
          {page.items.map(item => {
            const unused = item.usage === 'none' && !live.has(item.id);
            const checked = selected.includes(item.id);
            return (
              <label key={item.id} className="flex items-center gap-3 border-b border-white/[0.04] px-3 py-2 text-sm last:border-b-0">
                <input
                  type="checkbox"
                  disabled={!unused}
                  checked={checked}
                  onChange={() => setSelected(previous => checked ? previous.filter(id => id !== item.id) : [...previous, item.id])}
                />
                <span className="min-w-0 flex-1 truncate text-neutral-200" title={item.originalName || item.id}>
                  {item.originalName || item.id}
                </span>
                <span className="shrink-0 text-neutral-500">{item.kind}</span>
                <span className="w-16 shrink-0 text-right text-neutral-400">{formatBytes(item.byteSize)}</span>
                <span className={`w-20 shrink-0 text-right ${unused ? 'text-amber-200/80' : 'text-neutral-500'}`}>
                  {usageLabel(item.usage, item.id)}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {page && (
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <button
            type="button"
            disabled={busy || offset === 0}
            onClick={() => { void load(Math.max(0, offset - PAGE_SIZE), unusedOnly); }}
            className="rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40"
          >
            {zho ? '上一页' : 'Prev'}
          </button>
          <span>{offset + 1}–{offset + (page.items.length)}</span>
          <button
            type="button"
            disabled={busy || page.items.length < PAGE_SIZE}
            onClick={() => { void load(offset + PAGE_SIZE, unusedOnly); }}
            className="rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40"
          >
            {zho ? '下一页' : 'Next'}
          </button>
        </div>
      )}
    </div>
  );
};

export const assetLibraryPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const dispose = ctx.contributions.register<SettingsSectionContribution>('settings_sections', {
      id: 'builtin.asset-library.panel',
      pluginId: 'builtin.asset-library',
      priority: 5,
      value: {
        label: lang => (lang === 'zho' ? '资产库' : 'Assets'),
        component: AssetLibrarySection,
        navGroup: 'extensions',
      },
    });
    return () => dispose();
  },
});
