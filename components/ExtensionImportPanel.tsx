import React, { useEffect, useState } from 'react';
import type { ExtensionRuntime, ExternalImportBatch } from '../plugin-runtime/extension-registry';
import { useTranslation } from '../utils/language-store';

interface ExtensionImportPanelProps {
  runtime: ExtensionRuntime | null;
  onClose: () => void;
}
const ACTIVE: ExternalImportBatch['status'][] = ['parsing', 'committing'];
const percentFor = (batch: ExternalImportBatch): number => {
  if (batch.entries.length === 0) return 0;
  const sum = batch.entries.reduce((total, entry) => {
    if (entry.status === 'committed') return total + 1;
    if (entry.status === 'failed' || entry.status === 'cancelled') return total + 0.4;
    if (entry.status === 'parsed') return total + 0.9;
    return total + Math.min(1, (entry.progress.done / Math.max(1, entry.progress.total))) * 0.9;
  }, 0);
  return Math.round((sum / batch.entries.length) * 100);
};

/** Generic declarative-extension import monitor. No sample-specific content. */
export const ExtensionImportPanel: React.FC<ExtensionImportPanelProps> = ({ runtime, onClose }) => {
  const { t } = useTranslation();
  const [batches, setBatches] = useState<ExternalImportBatch[]>([]);
  useEffect(() => {
    if (!runtime) return;
    const refresh = () => { try { setBatches(runtime.batches()); } catch { /* disposed mid-tick */ } };
    refresh();
    const timer = window.setInterval(refresh, 200);
    return () => window.clearInterval(timer);
  }, [runtime]);
  const visible = [...batches].reverse();
  return (
    <div data-bp-ui-surface="" className="fixed bottom-4 right-4 z-40 flex max-h-72 w-80 flex-col gap-2 rounded-2xl border border-white/10 bg-[var(--ui-bg-color)] p-3 text-white shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">{t('extensionImports.title')}</h4>
        <button type="button" onClick={onClose} className="rounded-full p-1 text-gray-400 hover:text-white" aria-label={t('extensionImports.close')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      {visible.length === 0 && <p className="text-xs text-neutral-400">{t('extensionImports.empty')}</p>}
      {visible.map(batch => (
        <div key={batch.id} className="rounded-xl border border-white/[0.07] bg-black/30 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{batch.packageId}</span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${ACTIVE.includes(batch.status) ? 'border-sky-400/40 text-sky-300' : batch.status === 'completed' ? 'border-emerald-400/40 text-emerald-300' : 'border-rose-400/40 text-rose-300'}`}>{batch.status}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className={`h-full rounded-full transition-[width] ${batch.status === 'completed' ? 'bg-emerald-400' : 'bg-sky-400'}`} style={{ width: `${percentFor(batch)}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-neutral-400">
            <span>{t('extensionImports.nodes', batch.entries.filter(entry => entry.status === 'committed').length, batch.entries.length, percentFor(batch))}</span>
            {ACTIVE.includes(batch.status) && (
              <button
                type="button"
                className="text-rose-300 hover:text-rose-200"
                onClick={() => { try { runtime?.cancelBatch(batch.id); } catch { /* already terminal */ } }}
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
          {batch.entries.some(entry => entry.error) && (
            <p className="mt-1 truncate text-[10px] text-rose-300" title={batch.entries.find(entry => entry.error)?.error}>
              {batch.entries.find(entry => entry.error)?.error}
            </p>
          )}
        </div>
      ))}
    </div>
  );
};
