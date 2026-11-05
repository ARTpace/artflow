/**
 * presets-section —— 设置预设的导出 / 导入（设置页 "设置预设" 分组）。
 *
 * 对应方案 P3 的 `presets/`：换机迁移、出问题前留一份能用的配置、把一套调好的
 * 外观与快捷键分享出去。**收录范围只有 preferences + workspace** ——
 * 密钥与最近工程被主进程明确排除（见 main.cjs 的 PRESET_VOLUMES）：预设是拿来分享的，
 * 带出密钥等于泄漏；最近工程是本机路径，导到别的机器全是死链。
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import { SectionBlock } from '../../plugin-runtime/settings-ui';
import type { PresetSummary } from '../../types';

const api = () => (typeof window === 'undefined' ? undefined : window.artflowConfig);

const buttonClass = 'rounded-md border border-white/10 bg-white/[0.06] px-3 py-1 text-sm text-neutral-200 transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40';

export const PresetsSection: React.FC<SettingsSectionProps> = ({ language }) => {
  const zho = language === 'zho';
  const t = {
    title: zho ? '设置预设' : 'Settings presets',
    intro: zho
      ? '预设收录「偏好」与「工作区布局」两部分。密钥与本机路径不会写入预设。'
      : 'A preset contains preferences and workspace layout only. Secrets and machine-local paths are never included.',
    namePlaceholder: zho ? '预设名称（字母/数字/._-）' : 'Preset name (letters/digits/._-)',
    save: zho ? '导出到预设库' : 'Save to preset library',
    saveAs: zho ? '另存为文件…' : 'Export as file…',
    importFile: zho ? '从文件导入…' : 'Import from file…',
    library: zho ? '预设库' : 'Preset library',
    empty: zho ? '预设库还是空的。' : 'The preset library is empty.',
    apply: zho ? '应用' : 'Apply',
    remove: zho ? '删除' : 'Delete',
    volumes: zho ? '包含' : 'contains',
    restartHint: zho ? '预设已导入。部分设置需要重启应用后生效。' : 'Preset imported. Some settings take effect after a restart.',
    restartNow: zho ? '立即重启' : 'Restart now',
    applied: zho ? '已应用。' : 'Applied.',
    imported: zho ? '已导入。' : 'Imported.',
  };

  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const bridge = api();
    if (!bridge?.listPresets) {
      setPresets([]);
      return;
    }
    try {
      const result = await bridge.listPresets();
      setPresets(Array.isArray(result?.presets) ? result.presets : []);
    } catch (error) {
      console.warn('Failed to list presets:', error);
      setPresets([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * 统一处理"调用 → 报结果 → 刷新"这段，避免每个按钮各写一遍 try/catch。
   *
   * `restart`：把整套配置从磁盘灌回正在运行的进程，只有一部分读取路径会立刻反映
   * （语言、外观、皮肤都在各自的模块级单例里，改文件不会让它们重新求值）。
   * 与其做成"一半悄悄生效"的迷惑状态，不如明说"重启后生效"并给一个一键重启。
   */
  const run = useCallback(async (
    task: () => Promise<{ ok: boolean; message?: string; canceled?: boolean } | undefined>,
    { restart = false }: { restart?: boolean } = {},
  ) => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await task();
      if (!result || result.canceled) return;
      if (result.ok) setNeedsRestart(restart);
      setStatus(result.ok
        ? { tone: 'ok', text: result.ok && restart ? (zho ? '已导入。' : 'Imported.') : (zho ? '已应用。' : 'Applied.') }
        : { tone: 'error', text: result.message ?? (zho ? '操作失败' : 'Operation failed') });
      await refresh();
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, [refresh, zho]);

  return (
    <>
      <SectionBlock title={t.title}>
        <p className="px-0.5 text-[11px] leading-4 text-neutral-500">{t.intro}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder={t.namePlaceholder}
            data-bp-preset-name=""
            className="min-w-[12rem] flex-1 rounded-md border border-white/10 bg-black/25 px-3 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-white/25"
          />
          <button
            type="button"
            disabled={busy || name.trim().length === 0}
            data-bp-preset-save=""
            className={buttonClass}
            onClick={() => void run(() => api()?.savePreset?.(name.trim()))}
          >
            {t.save}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} data-bp-preset-export=""
            className={buttonClass} onClick={() => void run(() => api()?.exportPresetToFile?.())}>
            {t.saveAs}
          </button>
          <button type="button" disabled={busy} data-bp-preset-import=""
            className={buttonClass} onClick={() => void run(() => api()?.importPresetFromFile?.(), { restart: true })}>
            {t.importFile}
          </button>
        </div>
        {status && (
          <p data-bp-preset-status={status.tone} className={`px-0.5 text-xs ${status.tone === 'ok' ? 'text-emerald-300' : 'text-amber-300'}`}>
            {status.text}
          </p>
        )}
        {needsRestart && (
          <div data-bp-preset-restart="" className="flex items-center gap-3 rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2">
            <span className="flex-1 text-xs leading-4 text-amber-200">{t.restartHint}</span>
            <button
              type="button"
              className={buttonClass}
              onClick={() => { void (typeof window === 'undefined' ? undefined : window.artflowApp?.restartApp?.()); }}
            >
              {t.restartNow}
            </button>
          </div>
        )}
      </SectionBlock>

      <SectionBlock title={t.library}>
        {presets.length === 0 && <p className="px-0.5 text-xs text-neutral-500">{t.empty}</p>}
        <div className="space-y-1.5">
          {presets.map(preset => (
            <div key={preset.name} data-bp-preset-entry={preset.name}
              className="flex items-center gap-3 rounded-md border border-white/[0.06] bg-black/20 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{preset.name}</span>
              <span className="shrink-0 text-[11px] text-neutral-500">
                {t.volumes}: {preset.volumes.join(' + ') || '—'} · {(preset.bytes / 1024).toFixed(1)} KB
              </span>
              <button type="button" disabled={busy} className={buttonClass}
                onClick={() => void run(() => api()?.loadPreset?.(preset.name), { restart: true })}>
                {t.apply}
              </button>
              <button type="button" disabled={busy} className={buttonClass}
                onClick={() => void run(() => api()?.removePreset?.(preset.name))}>
                {t.remove}
              </button>
            </div>
          ))}
        </div>
      </SectionBlock>
    </>
  );
};
