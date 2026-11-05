import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RecentProjectEntry } from '../types';

interface RecentProjectsMenuProps {
  t: (key: string, ...args: any[]) => any;
  /** 选中某个最近工程（宿主负责真正打开它）。 */
  onOpen: (path: string) => void;
  /** 宿主正在打开/保存工程时禁用，避免连点出两个并发加载。 */
  disabled?: boolean;
}

/**
 * RecentProjectsMenu —— "最近工程"下拉（挂在顶栏打开按钮旁）。
 *
 * 为什么列表要在这里读、而不是由 App 透传：清单会在**每次打开工程后**变化，
 * 而打开动作发生在 App 里。若由 App 持有，就得在打开成功后回读一次并往下传两层 props；
 * 组件自己在下拉展开时读一次，既少两条 props，也天然拿到最新的那份。
 *
 * 目录已被删/改名的条目**保留但灰掉**（`missing`）—— 直接隐藏会让用户以为
 * "我的工程不见了"，灰掉 + 提示"文件夹不存在"才说明白发生了什么。
 */
export const RecentProjectsMenu: React.FC<RecentProjectsMenuProps> = ({ t, onOpen, disabled }) => {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<RecentProjectEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const bridge = typeof window === 'undefined' ? undefined : window.artflowStorage;
    if (!bridge || typeof bridge.listRecentProjects !== 'function') {
      setProjects([]);
      setLoaded(true);
      return;
    }
    try {
      const result = await bridge.listRecentProjects();
      setProjects(Array.isArray(result?.projects) ? result.projects : []);
    } catch (error) {
      console.warn('Failed to read recent projects:', error);
      setProjects([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    void refresh();
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, refresh]);

  const handleClear = useCallback(async () => {
    const bridge = typeof window === 'undefined' ? undefined : window.artflowStorage;
    if (!bridge || typeof bridge.clearRecentProjects !== 'function') return;
    try {
      await bridge.clearRecentProjects();
    } catch (error) {
      console.warn('Failed to clear recent projects:', error);
    }
    setProjects([]);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(previous => !previous)}
        disabled={disabled}
        title={t('topBar.recentProjects')}
        aria-label={t('topBar.recentProjects')}
        aria-expanded={open}
        data-bp-recent-projects-trigger=""
        className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[var(--ui-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>

      {open && (
        <div
          data-bp-recent-projects-menu=""
          style={{ backgroundColor: 'var(--ui-bg-color)' }}
          className="absolute left-0 top-12 z-30 w-72 overflow-hidden rounded-[14px] border border-[var(--ui-border)] shadow-xl"
        >
          <div className="flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wide text-neutral-400">
            <span>{t('topBar.recentProjects')}</span>
            {projects.length > 0 && (
              <button
                type="button"
                onClick={handleClear}
                data-bp-recent-projects-clear=""
                className="rounded px-1.5 py-0.5 text-[11px] normal-case text-neutral-400 transition-colors hover:bg-[var(--ui-hover)] hover:text-[var(--ui-text)]"
              >
                {t('topBar.clearRecent')}
              </button>
            )}
          </div>
          {loaded && projects.length === 0 && (
            <div className="px-3 pb-3 text-xs text-neutral-500">{t('topBar.noRecentProjects')}</div>
          )}
          <div className="max-h-72 overflow-y-auto pb-1">
            {projects.map(entry => (
              <button
                key={entry.path}
                type="button"
                disabled={entry.missing}
                title={entry.missing ? t('topBar.recentMissing') : entry.path}
                onClick={() => { setOpen(false); onOpen(entry.path); }}
                className="block w-full text-left px-3 py-2 text-[13px] text-[var(--ui-text)] transition-colors hover:bg-[var(--ui-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="block truncate">{entry.name}</span>
                <span className="block truncate text-[11px] text-neutral-500">
                  {entry.missing ? t('topBar.recentMissing') : entry.path}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
