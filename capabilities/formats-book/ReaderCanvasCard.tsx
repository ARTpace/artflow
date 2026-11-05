import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReaderElement } from '../../types';
import { tryKernel } from '../../plugin-runtime/instance';
import { CANVAS_MUTATION_SERVICE, type CanvasMutationService } from '../../plugin-runtime/canvas-mutation';
import { readerChapters } from './readerOutline';
import { useUiText } from '../../utils/language-store';

interface ReaderCanvasCardProps {
  element: ReaderElement;
  isSelected?: boolean;
}

const FONT_SIZES = [13, 15, 17, 19, 21] as const;

type UiText = (zho: string, en: string) => string;

const sourceLabel = (sourceFormat: ReaderElement['sourceFormat'], t: UiText) => {
  if (sourceFormat === 'epub') return t('EPUB → 文本', 'EPUB → text');
  if (sourceFormat === 'html') return t('HTML → 文本', 'HTML → text');
  if (sourceFormat === 'text') return t('文本阅读器', 'Text reader');
  return t(`${sourceFormat.toUpperCase()} → 文本`, `${sourceFormat.toUpperCase()} → text`);
};

const clampFontIndex = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 1;
  return Math.min(FONT_SIZES.length - 1, Math.max(0, value));
};

/** Plugin-owned ReaderCard. Content is rendered as React text, never source HTML. */
export const ReaderCanvasCard: React.FC<ReaderCanvasCardProps> = ({ element, isSelected = false }) => {
  const t = useUiText();
  const [fontIndex, setFontIndex] = useState(() => clampFontIndex(element.fontIndex));
  const [contentsOpen, setContentsOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const scrollTimer = useRef<number | null>(null);
  const stopEvents = {
    onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
    onTouchStart: (event: React.TouchEvent) => event.stopPropagation(),
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
  };
  const accent = 'var(--bp-card-accent-reader, var(--bp-accent))';
  const canShrink = fontIndex > 0;
  const canGrow = fontIndex < FONT_SIZES.length - 1;
  const chapters = useMemo(
    () => readerChapters(element.content, element.chapters),
    [element.content, element.chapters],
  );
  const showContents = chapters.length >= 2;

  const remember = (patch: { fontIndex?: number; readingScroll?: number }) => {
    const kernel = tryKernel();
    if (!kernel?.has(CANVAS_MUTATION_SERVICE)) return;
    const mutation = kernel.use(CANVAS_MUTATION_SERVICE) as CanvasMutationService;
    mutation.patchElements([{ id: element.id, patch }], { history: 'skip' });
  };

  useEffect(() => {
    setFontIndex(clampFontIndex(element.fontIndex));
  }, [element.id, element.fontIndex]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const ratio = typeof element.readingScroll === 'number' ? element.readingScroll : 0;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max > 0 && ratio > 0) scroller.scrollTop = Math.min(max, ratio * max);
  }, [element.id]);

  useEffect(() => () => {
    if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current);
  }, []);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const ratio = max > 0 ? scroller.scrollTop / max : 0;
    if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      remember({ readingScroll: Math.round(ratio * 1000) / 1000 });
    }, 400);
  };

  const jumpToChapter = (index: number) => {
    const scroller = scrollerRef.current;
    const section = sectionRefs.current[index];
    if (!scroller || !section) return;
    scroller.scrollTop = Math.max(0, section.offsetTop - scroller.offsetTop);
    setContentsOpen(false);
  };

  const slices = chapters.length >= 2
    ? chapters.map((chapter, index) => {
      const end = chapters[index + 1]?.start ?? element.content.length;
      return { ...chapter, text: element.content.slice(chapter.start, end) };
    })
    : [{ title: element.name, start: 0, text: element.content }];

  return (
    <section
      className="w-full h-full rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.42)] flex flex-col select-none overflow-hidden relative"
      style={{
        background: 'var(--bp-card-bg)',
        borderColor: isSelected ? accent : 'var(--bp-border)',
        borderRadius: 'var(--bp-radius-card)',
        color: 'var(--bp-text-primary)',
      }}
      aria-label={`Reader: ${element.name}`}
    >
      <div className="absolute -top-12 -right-10 w-32 h-32 rounded-full blur-3xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />
      <header className="relative z-10 flex items-center justify-between gap-2 px-3 pt-3 pb-2 border-b" style={{ borderColor: 'var(--bp-border)' }}>
        <div className="min-w-0 flex items-center gap-2 pointer-events-none">
          <span className="shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide" style={{ background: 'var(--bp-accent-soft)', borderColor: accent, color: accent }}>
            READ
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold leading-tight">{element.name}</h3>
            <p className="truncate text-[10px] mt-0.5" style={{ color: 'var(--bp-text-muted)' }}>{sourceLabel(element.sourceFormat, t)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0" {...stopEvents}>
          {showContents && (
            <button
              type="button"
              className="h-6 px-1.5 rounded-md border text-[10px] font-semibold"
              style={{ borderColor: contentsOpen ? accent : 'var(--bp-border)', color: contentsOpen ? accent : 'var(--bp-text-primary)' }}
              onClick={() => setContentsOpen(open => !open)}
              aria-pressed={contentsOpen}
              aria-label={t('阅读器目录', 'Reader contents')}
              title={t('目录', 'Contents')}
            >目录</button>
          )}
          <button
            type="button"
            className="w-6 h-6 rounded-md border text-xs font-semibold transition-opacity disabled:opacity-35"
            style={{ borderColor: 'var(--bp-border)', color: 'var(--bp-text-primary)' }}
            onClick={() => {
              const next = Math.max(0, fontIndex - 1);
              setFontIndex(next);
              remember({ fontIndex: next });
            }}
            disabled={!canShrink}
            aria-label={t('缩小阅读器字号', 'Decrease reader font size')}
            title={t('更小的字', 'Smaller text')}
          >A−</button>
          <button
            type="button"
            className="w-6 h-6 rounded-md border text-xs font-semibold transition-opacity disabled:opacity-35"
            style={{ borderColor: 'var(--bp-border)', color: 'var(--bp-text-primary)' }}
            onClick={() => {
              const next = Math.min(FONT_SIZES.length - 1, fontIndex + 1);
              setFontIndex(next);
              remember({ fontIndex: next });
            }}
            disabled={!canGrow}
            aria-label={t('放大阅读器字号', 'Increase reader font size')}
            title={t('更大的字', 'Larger text')}
          >A+</button>
        </div>
      </header>

      <div className="relative z-10 flex-1 min-h-0 mx-2 my-2">
        <div
          ref={scrollerRef}
          className="h-full rounded-xl border overflow-y-auto select-text"
          style={{ borderColor: 'var(--bp-border)' }}
          onScroll={onScroll}
          {...stopEvents}
        >
          {slices.map((slice, index) => (
            <article
              key={`${slice.start}-${slice.title}`}
              ref={node => { sectionRefs.current[index] = node; }}
              className="whitespace-pre-wrap break-words px-3 py-2.5 leading-7"
              style={{ fontSize: `${FONT_SIZES[fontIndex]}px`, color: 'var(--bp-text-primary)', fontFamily: 'var(--bp-font-content, inherit)' }}
            >
              {slice.text}
            </article>
          ))}
        </div>
        {showContents && contentsOpen && (
          <aside
            className="absolute inset-y-0 left-0 w-[46%] max-w-[220px] overflow-y-auto rounded-l-xl border-r shadow-xl"
            style={{ background: 'var(--bp-card-bg)', borderColor: 'var(--bp-border)' }}
            {...stopEvents}
            aria-label={t('目录', 'Contents')}
          >
            <ol className="py-1">
              {chapters.map((chapter, index) => (
                <li key={`${chapter.start}-${chapter.title}`}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-[12px] leading-5 hover:bg-white/5"
                    style={{ color: 'var(--bp-text-primary)' }}
                    onClick={() => jumpToChapter(index)}
                  >
                    {chapter.title}
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>

      <footer className="relative z-10 flex items-center justify-between gap-2 px-3 pb-2 pt-1 text-[10px] border-t pointer-events-none" style={{ borderColor: 'var(--bp-border)', color: 'var(--bp-text-muted)' }}>
        <span>{element.characterCount.toLocaleString()} characters</span>
        <span className="font-medium" style={{ color: element.isTruncated ? 'var(--bp-warning, #f59e0b)' : accent }}>
          {element.isTruncated ? 'Preview truncated at 120k' : 'Stored in project'}
        </span>
      </footer>
    </section>
  );
};
