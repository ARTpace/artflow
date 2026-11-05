import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Element as CanvasElement } from '../types';
import {
  createCanvasFinderModel,
  type CanvasFinderFilter,
  type CanvasFinderResult,
} from '../utils/canvasFinder';
import { useTranslation } from '../utils/language-store';

interface CanvasFinderPanelProps {
  isOpen: boolean;
  elements: readonly CanvasElement[];
  onClose: () => void;
  onFocus: (result: CanvasFinderResult) => void;
}

/** Filter order is stable; labels resolve through translations (`finder.filters.*`). */
const FILTERS: readonly CanvasFinderFilter[] = ['all', 'frames', 'text', 'assets'];

/** A transient current-board lookup surface; focusing a result deliberately does not select it. */
export const CanvasFinderPanel: React.FC<CanvasFinderPanelProps> = ({ isOpen, elements, onClose, onFocus }) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CanvasFinderFilter>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const model = useMemo(() => createCanvasFinderModel(elements, { query, filter }), [elements, filter, query]);
  const { t } = useTranslation();

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  if (!isOpen) return null;

  const summary = model.totalMatches === 0
    ? t('finder.summaryNone')
    : model.isTruncated
      ? t('finder.summaryTruncated', model.results.length, model.totalMatches)
      : t('finder.summaryCount', model.totalMatches);

  return (
    <aside
      aria-label={t('finder.ariaLabel')}
      data-bp-ui-surface="" className="absolute bottom-[16rem] right-4 z-40 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/15 bg-[var(--ui-bg-color)] text-white shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{t('finder.title')}</h2>
          <p className="mt-0.5 text-xs text-neutral-400">{t('finder.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('finder.close')}
          aria-label={t('finder.close')}
          className="rounded-lg p-1.5 text-neutral-300 hover:bg-white/10 hover:text-white"
        >
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </header>

      <div className="p-3">
        <label className="sr-only" htmlFor="canvas-finder-query">{t('finder.searchLabel')}</label>
        <input
          ref={inputRef}
          id="canvas-finder-query"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') onClose();
          }}
          placeholder={t('finder.searchPlaceholder')}
          className="w-full rounded-xl border border-white/15 bg-black/25 px-3 py-2 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-sky-300/60"
        />

        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('finder.filterLabel')}>
          {FILTERS.map(option => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              aria-pressed={filter === option}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${filter === option
                ? 'bg-sky-400/20 text-sky-100 ring-1 ring-sky-300/30'
                : 'bg-white/[0.055] text-neutral-300 hover:bg-white/10'}`}
            >
              {t(`finder.filters.${option}`)}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs text-neutral-400" aria-live="polite">{summary}</p>
        <p className="mt-1 text-[11px] leading-4 text-neutral-500">{t('finder.focusHint')}</p>

        {model.results.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-white/15 px-3 py-7 text-center text-sm text-neutral-400">
            {elements.length === 0 ? t('finder.emptyNoCards') : t('finder.emptyNoMatch')}
          </div>
        ) : (
          <ul className="mt-3 max-h-[min(28rem,calc(100vh-22rem))] space-y-1.5 overflow-y-auto pr-0.5">
            {model.results.map(result => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => onFocus(result)}
                  title={t('finder.focusTitle', result.label)}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2.5 text-left hover:border-sky-300/30 hover:bg-sky-400/[0.08]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-white">{result.label}</span>
                    <span className="mt-0.5 block text-[11px] text-neutral-500">{result.typeLabel}</span>
                    {result.tags.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {result.tags.slice(0, 3).map(tag => <span key={tag} className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-100">#{tag}</span>)}
                        {result.tags.length > 3 && <span className="px-0.5 text-[10px] text-neutral-500">+{result.tags.length - 3}</span>}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs font-medium text-sky-200">{t('common.focus')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
