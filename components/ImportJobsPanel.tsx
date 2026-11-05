import React, { useState } from 'react';
import type { ManagedImportJob } from '../types';
import type { ManagedImportJobUpdate } from '../utils/managedProjectStorage';
import { useTranslation, type TranslationFunction } from '../utils/language-store';

interface ImportJobsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  jobs: readonly ManagedImportJob[];
  currentProgress: ManagedImportJobUpdate | null;
  isRefreshing: boolean;
  onRefresh: () => Promise<unknown>;
  onCancel: (jobId: string) => Promise<unknown>;
}

const ACTIVE_STATUSES = new Set<ManagedImportJob['status']>(['queued', 'running']);

const labelForStatus = (status: ManagedImportJob['status'], t: TranslationFunction): string =>
  t(`importJobs.status.${status}`);

const toneForStatus = (status: ManagedImportJob['status']): string => ({
  queued: 'bg-amber-400/15 text-amber-200 border-amber-300/20',
  running: 'bg-sky-400/15 text-sky-200 border-sky-300/20',
  completed: 'bg-emerald-400/15 text-emerald-200 border-emerald-300/20',
  cancelled: 'bg-slate-400/15 text-slate-200 border-slate-300/20',
  failed: 'bg-rose-400/15 text-rose-200 border-rose-300/20',
}[status]);

const percentageFor = (progress: number): number => Math.round(Math.max(0, Math.min(1, progress)) * 100);

/** Managed-storage-only UI. It only renders safe snapshots from the named bridge. */
export const ImportJobsPanel: React.FC<ImportJobsPanelProps> = ({
  isOpen,
  onClose,
  jobs,
  currentProgress,
  isRefreshing,
  onRefresh,
  onCancel,
}) => {
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { t } = useTranslation();

  if (!isOpen) return null;

  const handleCancel = async (jobId: string) => {
    setActionError(null);
    setCancellingJobId(jobId);
    try {
      await onCancel(jobId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancellingJobId(null);
    }
  };

  const activeCount = jobs.filter(job => ACTIVE_STATUSES.has(job.status)).length;

  return (
    <aside
      aria-label={t('importJobs.ariaLabel')}
      data-bp-ui-surface="" className="absolute top-20 left-4 z-40 w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/15 bg-[var(--ui-bg-color)] text-white shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{t('importJobs.title')}</h2>
          <p className="mt-0.5 text-xs text-neutral-400">{t('importJobs.subtitle')}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void onRefresh().catch(error => setActionError(error instanceof Error ? error.message : String(error)))}
            disabled={isRefreshing}
            title={t('importJobs.refresh')}
            className="rounded-lg px-2 py-1 text-xs text-neutral-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRefreshing ? t('importJobs.refreshing') : t('common.refresh')}
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('importJobs.close')}
            className="rounded-lg p-1.5 text-neutral-300 hover:bg-white/10 hover:text-white"
          >
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </div>
      </header>

      <div className="max-h-[min(34rem,calc(100vh-10rem))] overflow-y-auto p-3">
        {currentProgress && (
          <section className="mb-3 rounded-xl border border-sky-300/20 bg-sky-400/10 p-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-xs text-sky-100">
              <span className="truncate font-medium">{t('importJobs.savingAsset', currentProgress.assetOrdinal, currentProgress.assetCount, currentProgress.job.displayName ?? currentProgress.assetId)}</span>
              <span>{percentageFor(currentProgress.job.progress)}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/30">
              <div className="h-full rounded-full bg-sky-300 transition-[width]" style={{ width: `${percentageFor(currentProgress.job.progress)}%` }} />
            </div>
          </section>
        )}

        <p className="mb-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-5 text-neutral-300">
          {t('importJobs.hint')}
        </p>

        {actionError && (
          <p role="alert" className="mb-3 rounded-lg border border-rose-300/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
            {actionError}
          </p>
        )}

        <div className="mb-2 flex items-center justify-between text-xs text-neutral-400">
          <span>{activeCount > 0 ? t('importJobs.activeCount', activeCount) : t('importJobs.recentJobs')}</span>
          <span>{t('importJobs.showingUpTo')}</span>
        </div>

        {jobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/15 px-3 py-6 text-center text-sm text-neutral-400">
            {t('importJobs.empty')}
          </div>
        ) : (
          <ul className="space-y-2" aria-live="polite">
            {jobs.map(job => {
              const isActive = ACTIVE_STATUSES.has(job.status);
              const isCancelling = cancellingJobId === job.id;
              return (
                <li key={job.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">{job.displayName ?? job.assetId}</p>
                      <p className="mt-0.5 truncate text-[11px] text-neutral-500">{t('importJobs.assetLabel', job.assetId)}</p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${toneForStatus(job.status)}`}>
                      {labelForStatus(job.status, t)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/35">
                      <div className="h-full rounded-full bg-white/65 transition-[width]" style={{ width: `${percentageFor(job.progress)}%` }} />
                    </div>
                    <span className="text-[11px] text-neutral-400">{percentageFor(job.progress)}%</span>
                  </div>
                  {job.status === 'failed' && (
                    <p className="mt-2 text-xs text-rose-200">{t('importJobs.failed', job.errorCode ?? 'UNKNOWN_ERROR')}</p>
                  )}
                  {isActive && (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-neutral-400">
                        {job.status === 'running' ? t('importJobs.cancelHintRunning') : t('importJobs.cancelHintQueued')}
                      </span>
                      <button
                        type="button"
                        disabled={isCancelling}
                        onClick={() => void handleCancel(job.id)}
                        className="shrink-0 rounded-lg border border-white/15 px-2 py-1 text-[11px] text-neutral-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isCancelling ? t('importJobs.requesting') : t('common.cancel')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
};
