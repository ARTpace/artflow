import React, { useState } from 'react';
import type { CanvasViewBookmark } from '../types';
import { MAX_VIEW_BOOKMARKS, VIEW_BOOKMARK_NAME_MAX_LENGTH } from '../utils/viewBookmarks';
import { useTranslation } from '../utils/language-store';

interface ViewBookmarksPanelProps {
  isOpen: boolean;
  bookmarks: readonly CanvasViewBookmark[];
  onClose: () => void;
  onAdd: (name: string) => void;
  onRestore: (bookmark: CanvasViewBookmark) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

/** Board-local camera shortcuts. Persistence remains delegated to the existing project Save flow. */
export const ViewBookmarksPanel: React.FC<ViewBookmarksPanelProps> = ({
  isOpen,
  bookmarks,
  onClose,
  onAdd,
  onRestore,
  onRename,
  onDelete,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const { t } = useTranslation();

  if (!isOpen) return null;

  const canAdd = bookmarks.length < MAX_VIEW_BOOKMARKS;
  const beginAdd = () => {
    setRenamingId(null);
    setDraftName(t('viewBookmarks.defaultName', bookmarks.length + 1));
    setIsAdding(true);
  };
  const submitAdd = () => {
    if (!canAdd) return;
    onAdd(draftName);
    setDraftName('');
    setIsAdding(false);
  };
  const beginRename = (bookmark: CanvasViewBookmark) => {
    setIsAdding(false);
    setRenamingId(bookmark.id);
    setRenameValue(bookmark.name);
  };
  const submitRename = (bookmark: CanvasViewBookmark) => {
    onRename(bookmark.id, renameValue);
    setRenamingId(null);
  };

  return (
    <aside
      aria-label={t('viewBookmarks.ariaLabel')}
      data-bp-ui-surface="" className="absolute bottom-[16rem] right-4 z-40 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/15 bg-[var(--ui-bg-color)] text-white shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{t('viewBookmarks.title')}</h2>
          <p className="mt-0.5 text-xs text-neutral-400">{t('viewBookmarks.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('viewBookmarks.close')}
          aria-label={t('viewBookmarks.close')}
          className="rounded-lg p-1.5 text-neutral-300 hover:bg-white/10 hover:text-white"
        >
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </header>

      <div className="max-h-[min(32rem,calc(100vh-19rem))] overflow-y-auto p-3">
        <p className="rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2 text-xs leading-5 text-neutral-300">
          {t('viewBookmarks.hint')}
        </p>

        <div className="mt-3">
          {isAdding ? (
            <div className="flex gap-2">
              <input
                autoFocus
                value={draftName}
                maxLength={VIEW_BOOKMARK_NAME_MAX_LENGTH}
                onChange={event => setDraftName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') submitAdd();
                  if (event.key === 'Escape') setIsAdding(false);
                }}
                aria-label={t('viewBookmarks.newNameLabel')}
                className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/25 px-2.5 py-1.5 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-sky-300/60"
              />
              <button type="button" onClick={submitAdd} className="rounded-lg bg-sky-400/15 px-2.5 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-400/25">{t('common.save')}</button>
              <button type="button" onClick={() => setIsAdding(false)} className="rounded-lg px-2 py-1.5 text-xs text-neutral-300 hover:bg-white/10">{t('common.cancel')}</button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!canAdd}
              onClick={beginAdd}
              className="w-full rounded-xl border border-sky-300/25 bg-sky-400/10 px-3 py-2.5 text-left text-sm font-medium text-sky-100 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {canAdd ? t('viewBookmarks.saveCurrent') : t('viewBookmarks.limitReached', MAX_VIEW_BOOKMARKS)}
            </button>
          )}
        </div>

        {bookmarks.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-white/15 px-3 py-6 text-center text-sm text-neutral-400">
            {t('viewBookmarks.empty')}
          </div>
        ) : (
          <ul className="mt-3 space-y-2" aria-live="polite">
            {bookmarks.map(bookmark => (
              <li key={bookmark.id} className="rounded-xl border border-white/10 bg-white/[0.035] p-2.5">
                {renamingId === bookmark.id ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      value={renameValue}
                      maxLength={VIEW_BOOKMARK_NAME_MAX_LENGTH}
                      onChange={event => setRenameValue(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') submitRename(bookmark);
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                      aria-label={t('viewBookmarks.renameLabel', bookmark.name)}
                      className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/25 px-2 py-1.5 text-sm text-white outline-none focus:border-sky-300/60"
                    />
                    <button type="button" onClick={() => submitRename(bookmark)} className="rounded-lg bg-sky-400/15 px-2 py-1.5 text-xs text-sky-100 hover:bg-sky-400/25">{t('common.save')}</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onRestore(bookmark)}
                      className="min-w-0 flex-1 rounded-lg px-1 py-1 text-left hover:bg-white/10"
                      title={t('viewBookmarks.goto', bookmark.name)}
                    >
                      <span className="block truncate text-sm font-medium text-white">{bookmark.name}</span>
                      <span className="mt-0.5 block text-[11px] text-neutral-500">{t('viewBookmarks.zoom', bookmark.zoom.toFixed(2))}</span>
                    </button>
                    <button type="button" onClick={() => beginRename(bookmark)} className="rounded-lg px-2 py-1 text-xs text-neutral-300 hover:bg-white/10">{t('common.rename')}</button>
                    <button type="button" onClick={() => onDelete(bookmark.id)} className="rounded-lg px-2 py-1 text-xs text-rose-200 hover:bg-rose-400/10">{t('common.delete')}</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
