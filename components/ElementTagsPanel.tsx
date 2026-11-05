import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Element as CanvasElement } from '../types';
import { normalizeElementTag, normalizeElementTags } from '../utils/elementTags';
import { useTranslation } from '../utils/language-store';

interface ElementTagsPanelProps {
  isOpen: boolean;
  selectedElements: readonly CanvasElement[];
  onClose: () => void;
  onAddTag: (tag: string) => boolean;
  onRemoveTag: (tag: string) => boolean;
}

/** Selection-scoped tag editor. Persisted writes remain delegated to App's existing operation boundary. */
export const ElementTagsPanel: React.FC<ElementTagsPanelProps> = ({
  isOpen,
  selectedElements,
  onClose,
  onAddTag,
  onRemoveTag,
}) => {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const tagSummaries = useMemo(() => {
    const counts = new Map<string, number>();
    selectedElements.forEach(element => normalizeElementTags(element.tags).forEach(tag => {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }));
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [selectedElements]);
  const { t } = useTranslation();

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  if (!isOpen) return null;

  const submit = () => {
    const tag = normalizeElementTag(draft);
    if (!tag || selectedElements.length === 0) return;
    if (onAddTag(tag)) setDraft('');
  };

  return (
    <aside
      aria-label={t('tags.ariaLabel')}
      data-bp-ui-surface="" className="absolute right-4 top-20 z-40 w-[min(23rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/15 bg-[var(--ui-bg-color)] text-white shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{t('tags.title')}</h2>
          <p className="mt-0.5 text-xs text-neutral-400">
            {t('tags.selectedCount', selectedElements.length)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('tags.close')}
          aria-label={t('tags.close')}
          className="rounded-lg p-1.5 text-neutral-300 hover:bg-white/10 hover:text-white"
        >
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </header>

      <div className="p-3">
        {selectedElements.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/15 px-3 py-6 text-center text-sm text-neutral-400">
            {t('tags.unavailable')}
          </p>
        ) : (
          <>
            <p className="rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2 text-xs leading-5 text-neutral-300">
              {t('tags.hint')}
            </p>
            <div className="mt-3 flex gap-2">
              <input
                ref={inputRef}
                value={draft}
                maxLength={32}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') submit();
                  if (event.key === 'Escape') onClose();
                }}
                placeholder={t('tags.placeholder')}
                aria-label={t('tags.addLabel')}
                className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/25 px-2.5 py-2 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-sky-300/60"
              />
              <button type="button" onClick={submit} className="rounded-lg bg-sky-400/15 px-3 py-2 text-xs font-medium text-sky-100 hover:bg-sky-400/25">{t('common.add')}</button>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">{t('tags.current')}</h3>
                <span className="text-[11px] text-neutral-500">{t('tags.maxHint')}</span>
              </div>
              {tagSummaries.length === 0 ? (
                <p className="rounded-xl border border-dashed border-white/15 px-3 py-5 text-center text-sm text-neutral-400">{t('tags.empty')}</p>
              ) : (
                <ul className="space-y-1.5" aria-live="polite">
                  {tagSummaries.map(({ tag, count }) => (
                    <li key={tag} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-white">#{tag}</span>
                      <span className="shrink-0 text-[11px] text-neutral-500">{count}/{selectedElements.length}</span>
                      <button
                        type="button"
                        onClick={() => onRemoveTag(tag)}
                        className="shrink-0 rounded-lg px-2 py-1 text-xs text-rose-200 hover:bg-rose-400/10"
                        title={t('tags.removeLabel', tag)}
                      >
                        {t('common.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
};
