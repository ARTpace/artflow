import React from 'react';
import { BpIcon } from './BpIcon';
import { RecentProjectsMenu } from './RecentProjectsMenu';

interface TopBarProps {
  // Updated t signature to match useSettings hook for better type compatibility
  t: (key: string, ...args: any[]) => any;
  isBoardPanelOpen: boolean;
  setIsBoardPanelOpen: (val: boolean | ((prev: boolean) => boolean)) => void;
  handleStartPresentation: () => void;
  framesCount: number;
  handleToggleSidePanel: (tab: 'layers' | 'frames') => void;
  selectedElementCount: number;
  onOpenTags: () => void;
  commandCount: number;
  onOpenCommandPalette: () => void;
  pluginPanelCount: number;
  onOpenPluginPanels: () => void;
  appearancePanelTitle?: string;
  onOpenAppearance?: () => void;
  setIsSettingsPanelOpen: (val: boolean) => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onOpenImportJobs: () => void;
  /** 打开一个已知路径的最近工程（宿主执行）。缺省时不渲染"最近"入口。 */
  onOpenRecentProject?: (path: string) => void;
  hasImportJobs: boolean;
  hasActiveImportJobs: boolean;
  projectFolderName: string | null;
}

export const TopBar: React.FC<TopBarProps> = ({
  t,
  isBoardPanelOpen,
  setIsBoardPanelOpen,
  handleStartPresentation,
  framesCount,
  handleToggleSidePanel,
  selectedElementCount,
  onOpenTags,
  commandCount,
  onOpenCommandPalette,
  pluginPanelCount,
  onOpenPluginPanels,
  appearancePanelTitle,
  onOpenAppearance,
  setIsSettingsPanelOpen,
  onOpenProject,
  onSaveProject,
  onOpenImportJobs,
  onOpenRecentProject,
  hasImportJobs,
  hasActiveImportJobs,
  projectFolderName
}) => {
  return (
    <>
      <div data-bp-topbar-side="left" className="absolute top-4 left-4 z-20 flex items-center gap-2">
        <button
          onClick={() => setIsBoardPanelOpen(prev => !prev)}
          style={{ backgroundColor: 'var(--ui-bg-color)' }}
          title={t('toolbar.boards')}
          data-bp-ui-floating-shell=""
          className="w-12 h-12 flex items-center justify-center border border-[var(--ui-border)] rounded-[14px] text-[var(--ui-text)] hover:bg-[var(--ui-hover)] transition-colors"
        >
          <BpIcon name="topbar.boards" size={24} />
        </button>

        <button
          type="button"
          onClick={onOpenCommandPalette}
          disabled={commandCount === 0}
          title={commandCount > 0 ? t('topBar.commands', commandCount) : t('topBar.noCommands')}
          aria-label={t('topBar.openCommandPalette')}
          style={{ backgroundColor: 'var(--ui-bg-color)' }}
          data-bp-ui-floating-shell=""
          className="relative flex h-12 w-12 items-center justify-center rounded-[14px] border border-[var(--ui-border)] text-[var(--ui-text)] transition-colors hover:bg-[var(--ui-hover)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          <BpIcon name="topbar.search" size={21} strokeWidth={1.8} />
        </button>

        <div style={{ backgroundColor: 'var(--ui-bg-color)' }} data-bp-ui-floating-shell="" className="flex items-center gap-1 p-1 border border-[var(--ui-border)] rounded-[14px] text-[var(--ui-text)] h-12">
            <button onClick={onOpenProject}
              title={projectFolderName ? `${t('toolbar.openProject')} · ${projectFolderName}` : t('toolbar.openProject')}
              aria-label={t('toolbar.openProject')}
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[var(--ui-hover)] transition-colors">
                <BpIcon name="topbar.open" size={20} />
            </button>
            <button onClick={() => onSaveProject()} title={t('toolbar.saveProject')} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[var(--ui-hover)] transition-colors">
                <BpIcon name="topbar.save" size={20} />
            </button>
            {hasImportJobs && (
              <button
                onClick={onOpenImportJobs}
                title={t('topBar.importJobs')}
                className="relative w-10 h-10 flex items-center justify-center rounded-full hover:bg-[var(--ui-hover)] transition-colors"
              >
                <BpIcon name="topbar.import" size={20} />
                {hasActiveImportJobs && <span aria-label={t('topBar.activeImportJobs')} className="absolute top-2 right-2 h-2 w-2 rounded-full bg-sky-300 ring-2 ring-neutral-900" />}
              </button>
            )}
            {onOpenRecentProject && <RecentProjectsMenu t={t} onOpen={onOpenRecentProject} />}
        </div>
      </div>

      <div data-bp-topbar-side="right" className="absolute top-4 right-4 z-20 flex items-center gap-2">
        <div
          style={{ backgroundColor: 'var(--ui-bg-color)' }}
          data-bp-ui-floating-shell="" className="flex items-center gap-1 p-1 border border-[var(--ui-border)] rounded-[14px]"
        >
          <button
            onClick={handleStartPresentation}
            title={t('sidePanel.present')}
            disabled={framesCount === 0}
            className="p-2 rounded-full text-[var(--ui-text)] hover:bg-[var(--ui-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <BpIcon name="topbar.present" size={20} strokeWidth={2.5} />
          </button>
          <div className="w-px h-5 bg-[var(--ui-border)] mx-1"></div>
          <button onClick={() => handleToggleSidePanel('layers')} title={t('toolbar.layers')} className="p-2 rounded-full text-[var(--ui-text)] hover:bg-[var(--ui-hover)] transition-colors">
            <BpIcon name="topbar.layers" size={20} />
          </button>
          <button onClick={() => handleToggleSidePanel('frames')} title={t('toolbar.frames')} className="p-2 rounded-full text-[var(--ui-text)] hover:bg-[var(--ui-hover)] transition-colors">
            <BpIcon name="topbar.frames" size={20} />
          </button>
          <button
            onClick={onOpenTags}
            title={selectedElementCount > 0 ? t('topBar.tagSelected', selectedElementCount) : t('topBar.selectCardsToTag')}
            disabled={selectedElementCount === 0}
            className="relative p-2 rounded-full text-[var(--ui-text)] hover:bg-[var(--ui-hover)] transition-colors disabled:cursor-not-allowed disabled:opacity-30"
          >
            <BpIcon name="topbar.tags" size={20} />
          </button>
          {onOpenAppearance && (
            <button
              type="button"
              onClick={onOpenAppearance}
              title={appearancePanelTitle}
              aria-label={appearancePanelTitle}
              data-bp-appearance-shortcut=""
              style={{ color: 'var(--bp-ui-button-icon, var(--bp-ui-accent-text))' }}
              className="relative flex h-9 w-9 items-center justify-center rounded-full bg-transparent hover:bg-[var(--ui-hover)] transition-colors"
            >
              <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3a9 9 0 1 0 0 18h1.4a2.2 2.2 0 0 0 1.4-3.9 1.6 1.6 0 0 1 1.1-2.8H17a4 4 0 0 0 4-4C21 6.3 17 3 12 3Z" />
                <circle cx="7.5" cy="11" r=".6" fill="currentColor" stroke="none" /><circle cx="11" cy="7.5" r=".6" fill="currentColor" stroke="none" /><circle cx="16" cy="8.5" r=".6" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
          <button
            onClick={onOpenPluginPanels}
            title={pluginPanelCount > 0 ? t('topBar.extensions', pluginPanelCount) : t('topBar.noExtensions')}
            aria-label={t('topBar.extensionsLabel')}
            data-bp-plugin-entry=""
            className="relative p-2 rounded-full text-[var(--ui-text)] hover:bg-[var(--ui-hover)] transition-colors"
          >
            <BpIcon name="topbar.extensions" size={20} strokeWidth={1.8} />
          </button>
          <div className="w-px h-5 bg-[var(--ui-border)] mx-1"></div>
          <button onClick={() => setIsSettingsPanelOpen(true)} title={t('toolbar.settings')} className="p-2 rounded-full text-[var(--ui-text)] hover:bg-[var(--ui-hover)] transition-colors">
            <BpIcon name="topbar.settings" size={20} />
          </button>
        </div>
      </div>
    </>
  );
};
