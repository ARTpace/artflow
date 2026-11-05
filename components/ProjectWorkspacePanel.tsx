import React from 'react';
import { useTranslation, type TranslationFunction } from '../utils/language-store';

export type WorkspaceStorageMode = 'browser' | 'managed';
export type WorkspaceActivityTone = 'neutral' | 'working' | 'success' | 'warning' | 'error';

interface WorkspaceStatusDockProps {
  storageMode: WorkspaceStorageMode;
  projectName: string | null;
  isProjectOpen: boolean;
  boardCount: number;
  isSaving: boolean;
  hasUnsavedChanges: boolean;
  hasProjectSaveBaseline: boolean;
  onOpen: () => void;
}

interface ProjectWorkspacePanelProps extends WorkspaceStatusDockProps {
  isOpen: boolean;
  onClose: () => void;
  activeBoardName: string | null;
  totalElementCount: number;
  assetLinkedElementCount: number;
  currentBoardElementCount: number;
  currentBoardFrameCount: number;
  selectionCount: number;
  activity: { tone: WorkspaceActivityTone; message: string };
  canOpenImportJobs: boolean;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onOpenImportJobs: () => void;
}

const modeCopy = (storageMode: WorkspaceStorageMode, t: TranslationFunction) => storageMode === 'managed'
  ? {
      label: t('workspace.mode.managedLabel'),
      description: t('workspace.mode.managedDescription'),
      saveLabel: t('workspace.mode.managedSaveLabel'),
      openLabel: t('workspace.mode.managedOpenLabel'),
    }
  : {
      label: t('workspace.mode.browserLabel'),
      description: t('workspace.mode.browserDescription'),
      saveLabel: t('workspace.mode.browserSaveLabel'),
      openLabel: t('workspace.mode.browserOpenLabel'),
    };

const toneClass = (tone: WorkspaceActivityTone) => ({
  neutral: 'border-white/10 bg-white/[0.04] text-neutral-300',
  working: 'border-sky-300/25 bg-sky-400/10 text-sky-100',
  success: 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100',
  warning: 'border-amber-300/25 bg-amber-400/10 text-amber-100',
  error: 'border-rose-300/25 bg-rose-400/10 text-rose-100',
}[tone]);

const workspaceName = (storageMode: WorkspaceStorageMode, projectName: string | null, t: TranslationFunction) => projectName
  ?? (storageMode === 'managed' ? t('workspace.noManagedProject') : t('workspace.untitledBrowser'));

const saveStatusCopy = (isSaving: boolean, hasUnsavedChanges: boolean, hasProjectSaveBaseline: boolean, t: TranslationFunction) => {
  if (isSaving) return {
    label: t('workspace.saveStatus.savingLabel'),
    detail: t('workspace.saveStatus.savingDetail'),
    className: 'border-sky-300/25 bg-sky-400/10 text-sky-100',
  };
  if (hasUnsavedChanges) return {
    label: t('workspace.saveStatus.unsavedLabel'),
    detail: t('workspace.saveStatus.unsavedDetail'),
    className: 'border-amber-300/25 bg-amber-400/10 text-amber-100',
  };
  if (hasProjectSaveBaseline) return {
    label: t('workspace.saveStatus.cleanLabel'),
    detail: t('workspace.saveStatus.cleanDetail'),
    className: 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100',
  };
  return {
    label: t('workspace.saveStatus.newLabel'),
    detail: t('workspace.saveStatus.newDetail'),
    className: 'border-white/10 bg-white/[0.04] text-neutral-300',
  };
};

/** Renderer-only project overview. It consumes scalar App state and never reads storage records itself. */
export const WorkspaceStatusDock: React.FC<WorkspaceStatusDockProps> = ({
  storageMode,
  projectName,
  isProjectOpen,
  boardCount,
  isSaving,
  hasUnsavedChanges,
  hasProjectSaveBaseline,
  onOpen,
}) => {
  const { t } = useTranslation();
  const copy = modeCopy(storageMode, t);
  const title = workspaceName(storageMode, projectName, t);
  const saveStatus = saveStatusCopy(isSaving, hasUnsavedChanges, hasProjectSaveBaseline, t);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('workspace.dockAriaLabel')}
      data-bp-ui-workspace-dock=""
      data-bp-ui-surface="" className="absolute bottom-4 left-4 z-30 flex max-w-[min(22rem,calc(100vw-2rem))] items-center gap-3 rounded-2xl border border-white/15 bg-[var(--ui-bg-color)] px-3 py-2.5 text-left text-white shadow-2xl backdrop-blur-xl transition hover:border-white/30 hover:bg-[var(--ui-hover)]"
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${storageMode === 'managed' ? 'bg-sky-400/15 text-sky-200' : 'bg-violet-400/15 text-violet-200'}`} aria-hidden="true">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5a2 2 0 0 1-1.66-.9l-.84-1.2A2 2 0 0 0 8.34 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          <path d="M8 13h8M8 17h5" />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-neutral-300">
          {t('workspace.dockLabel')}
          {isSaving && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" aria-label={t('workspace.saving')} />}
        </span>
        <span className="mt-0.5 block truncate text-sm font-medium text-white">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-neutral-400">
          {isSaving ? t('workspace.saveStatus.savingLabel') : `${saveStatus.label} · ${t('workspace.boardsCount', boardCount)}${isProjectOpen ? '' : ` · ${t('workspace.notOpened')}`}`}
        </span>
      </span>
      <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-neutral-500" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m7 4 6 6-6 6" />
      </svg>
    </button>
  );
};

/** Detailed workspace view; import-job navigation is deliberately passed in only by the existing R18 gate. */
export const ProjectWorkspacePanel: React.FC<ProjectWorkspacePanelProps> = ({
  isOpen,
  onClose,
  storageMode,
  projectName,
  isProjectOpen,
  boardCount,
  isSaving,
  hasUnsavedChanges,
  hasProjectSaveBaseline,
  activeBoardName,
  totalElementCount,
  assetLinkedElementCount,
  currentBoardElementCount,
  currentBoardFrameCount,
  selectionCount,
  activity,
  canOpenImportJobs,
  onOpenProject,
  onSaveProject,
  onOpenImportJobs,
}) => {
  const { t } = useTranslation();
  if (!isOpen) return null;

  const copy = modeCopy(storageMode, t);
  const title = workspaceName(storageMode, projectName, t);
  const saveStatus = saveStatusCopy(isSaving, hasUnsavedChanges, hasProjectSaveBaseline, t);

  const statistics: Array<[string, number]> = [
    [t('workspace.statistics.boards'), boardCount],
    [t('workspace.statistics.canvasCards'), totalElementCount],
    [t('workspace.statistics.assetLinkedCards'), assetLinkedElementCount],
    [t('workspace.statistics.thisBoard'), currentBoardElementCount],
    [t('workspace.statistics.frames'), currentBoardFrameCount],
    [t('workspace.statistics.selected'), selectionCount],
  ];

  return (
    <aside
      aria-label={t('workspace.ariaLabel')}
      data-bp-ui-workspace-panel=""
      data-bp-ui-surface="" className="absolute bottom-20 left-4 z-40 w-[min(29rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/15 bg-[var(--ui-bg-color)] text-white shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t('workspace.panelTitle')}</h2>
          <p className="mt-0.5 truncate text-xs text-neutral-400">{title}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('workspace.close')}
          aria-label={t('workspace.close')}
          className="rounded-lg p-1.5 text-neutral-300 hover:bg-white/10 hover:text-white"
        >
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </header>

      <div className="max-h-[min(38rem,calc(100vh-7rem))] overflow-y-auto p-4">
        <section className={`rounded-xl border p-3 ${storageMode === 'managed' ? 'border-sky-300/20 bg-sky-400/10' : 'border-violet-300/20 bg-violet-400/10'}`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">{copy.label}</p>
            <span className="rounded-full border border-white/15 bg-black/15 px-2 py-0.5 text-[11px] text-neutral-200">
              {isProjectOpen ? t('workspace.openBadge') : t('workspace.closedBadge')}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-5 text-neutral-300">{copy.description}</p>
        </section>

        <section className={`mt-3 rounded-xl border px-3 py-2.5 text-xs ${toneClass(activity.tone)}`} aria-live="polite">
          <span className="font-medium">{t('workspace.activityLabel')}</span>{activity.message}
        </section>

        <section className={`mt-3 rounded-xl border px-3 py-2.5 text-xs ${saveStatus.className}`} aria-live="polite">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{t('workspace.saveStatusLabel')}</span>
            <span className="rounded-full border border-white/15 bg-black/15 px-2 py-0.5 text-[11px]">{saveStatus.label}</span>
          </div>
          <p className="mt-1.5 leading-5">{saveStatus.detail}</p>
        </section>

        <section className="mt-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">{t('workspace.currentCanvas')}</h3>
            <span className="truncate text-xs text-neutral-400">{activeBoardName ?? t('workspace.noActiveBoard')}</span>
          </div>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {statistics.map(([label, value]) => (
              <div key={label} className="rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2">
                <dt className="text-[11px] text-neutral-500">{label}</dt>
                <dd className="mt-0.5 text-base font-semibold text-white">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[11px] leading-4 text-neutral-500">
            {t('workspace.assetNote')}
          </p>
        </section>

        <section className="mt-4 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={onOpenProject}
            className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2.5 text-left text-sm font-medium text-white hover:bg-white/10"
          >
            {copy.openLabel}
          </button>
          <button
            type="button"
            onClick={() => onSaveProject()}
            disabled={isSaving}
            className="rounded-xl border border-sky-300/25 bg-sky-400/10 px-3 py-2.5 text-left text-sm font-medium text-sky-100 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? t('workspace.saveStatus.savingLabel') : copy.saveLabel}
          </button>
        </section>

        {canOpenImportJobs && (
          <button
            type="button"
            onClick={onOpenImportJobs}
            className="mt-2 w-full rounded-xl border border-emerald-300/25 bg-emerald-400/10 px-3 py-2.5 text-left text-sm font-medium text-emerald-100 hover:bg-emerald-400/20"
          >
            {t('workspace.openImportJobs')}
          </button>
        )}
      </div>
    </aside>
  );
};

