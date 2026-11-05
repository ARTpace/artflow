import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComicElement } from '../../types';
import { useUiText } from '../../utils/language-store';

interface ComicCanvasCardProps {
  element: ComicElement;
  isSelected?: boolean;
}

const PAGE_URL_CACHE_LIMIT = 12;
const PREFETCH_RADIUS = 1;

interface PageSlot {
  url: string | null;
  error: string | null;
  loading: boolean;
}

/**
 * 单页懒加载：主进程按需解页 → Blob objectURL。元素级 LRU 缓存（逐出即 revoke），
 * 旧 data URL 页（存量工程）不经过这里。
 */
const useComicPage = (archiveRef: string | undefined, index: number): PageSlot => {
  const cacheRef = useRef<Map<number, PageSlot & { bytes: number }>>(new Map());
  const [slot, setSlot] = useState<PageSlot>({ url: null, error: null, loading: true });

  useEffect(() => {
    if (!archiveRef) return;
    const cache = cacheRef.current;
    const hit = cache.get(index);
    if (hit && (hit.url || hit.error)) {
      setSlot({ url: hit.url, error: hit.error, loading: false });
      return;
    }
    let cancelled = false;
    setSlot({ url: null, error: null, loading: true });
    const bridge = window.artflowComic;
    if (!bridge) {
      setSlot({ url: null, error: 'comic vault unavailable', loading: false });
      return;
    }
    bridge.getPage({ ref: archiveRef, index }).then(result => {
      if (cancelled) return;
      // 显式比较窄化：本项目未开 strictNullChecks，`!result.ok` 真值窄化不可用（TS#12745）。
      if (result.ok === false) {
        cache.set(index, { url: null, error: result.message, bytes: 0 });
        setSlot({ url: null, error: result.message, loading: false });
        return;
      }
      const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }));
      cache.set(index, { url, error: null, bytes: result.bytes.byteLength });
      while (cache.size > PAGE_URL_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value as number | undefined;
        if (oldestKey === undefined) break;
        const oldest = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (oldest?.url) URL.revokeObjectURL(oldest.url);
      }
      setSlot({ url, error: null, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [archiveRef, index]);

  useEffect(() => () => {
    for (const entry of cacheRef.current.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    cacheRef.current.clear();
  }, []);

  return slot;
};

/** 预取相邻页：暖主进程解页缓存，翻页时 IPC 命中热数据。 */
const useComicPrefetch = (archiveRef: string | undefined, index: number, pageCount: number) => {
  useEffect(() => {
    if (!archiveRef) return;
    const bridge = window.artflowComic;
    if (!bridge) return;
    for (const offset of [-PREFETCH_RADIUS, PREFETCH_RADIUS]) {
      const target = index + offset;
      if (target < 0 || target >= pageCount) continue;
      void bridge.getPage({ ref: archiveRef, index: target });
    }
  }, [archiveRef, index, pageCount]);
};

const formatPage = (page: number): string => String(page).padStart(2, '0');

const spinnerStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  border: '3px solid var(--bp-border)',
  borderTopColor: 'var(--bp-accent)',
  borderRadius: '50%',
  animation: 'bp-spin 0.9s linear infinite',
};

/** 单页渲染：懒加载源（archiveRef）与旧 data URL 源（pages）统一到一个视图。 */
const ComicPageImage: React.FC<{
  element: ComicElement;
  archiveRef?: string;
  legacyPages?: string[];
  pageIndex: number;
}> = ({ element, archiveRef, legacyPages, pageIndex }) => {
  const t = useUiText();
  const slot = useComicPage(archiveRef, pageIndex);
  const legacyUrl = legacyPages ? legacyPages[pageIndex] : undefined;

  if (archiveRef) {
    if (slot.loading) {
      return (
        <div className="w-full h-full flex items-center justify-center" style={{ color: 'var(--bp-text-muted)' }}>
          <div style={spinnerStyle} role="status" aria-label={t('加载中', 'Loading')} />
        </div>
      );
    }
    if (slot.error || !slot.url) {
      return (
        <div className="w-full h-full flex items-center justify-center px-4 text-center text-xs" style={{ color: 'var(--bp-text-muted)' }}>
          {slot.error || t('页面不可用', 'Page unavailable')}
        </div>
      );
    }
    return <img src={slot.url} alt={`${element.name} · ${pageIndex + 1}`} draggable={false} className="w-full h-full object-contain select-none" />;
  }
  if (!legacyUrl) {
    return (
      <div className="w-full h-full flex items-center justify-center text-xs" style={{ color: 'var(--bp-text-muted)' }}>
        {t('页面不可用', 'Page unavailable')}
      </div>
    );
  }
  return <img src={legacyUrl} alt={`${element.name} · ${pageIndex + 1}`} draggable={false} className="w-full h-full object-contain select-none" />;
};

/** Plugin-owned ComicCard. Navigation is ephemeral UI state; page data remains immutable Element metadata. */
export const ComicCanvasCard: React.FC<ComicCanvasCardProps> = ({ element, isSelected = false }) => {
  const t = useUiText();
  const [spreadMode, setSpreadMode] = useState(false);
  const [rtl, setRtl] = useState(false);
  const [unitIndex, setUnitIndex] = useState(0);

  const archiveRef = element.archiveRef;
  const legacyPages = element.pages;
  const pageCount = archiveRef ? (element.pageNames?.length ?? 0) : (legacyPages?.length ?? 0);
  const sourceFormat = element.sourceFormat;
  const accent = 'var(--bp-card-accent-comic, var(--bp-accent))';
  const stopEvents = {
    onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
    onTouchStart: (event: React.TouchEvent) => event.stopPropagation(),
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
  };

  /** 视图单元：单页模式每页一格；对开模式封面独占，之后两两成对。 */
  const units = useMemo(() => {
    const list: number[][] = [];
    if (pageCount <= 0) return list;
    if (!spreadMode) {
      for (let index = 0; index < pageCount; index += 1) list.push([index]);
      return list;
    }
    list.push([0]);
    for (let index = 1; index < pageCount; index += 2) {
      const pair = [index];
      if (index + 1 < pageCount) pair.push(index + 1);
      list.push(pair);
    }
    return list;
  }, [spreadMode, pageCount]);

  useEffect(() => {
    setUnitIndex(current => Math.min(Math.max(0, current), Math.max(0, units.length - 1)));
  }, [units.length]);

  const currentUnit = units[Math.min(unitIndex, Math.max(0, units.length - 1))] ?? [];
  const firstPageOfUnit = currentUnit[0] ?? 0;
  const lastPageOfUnit = currentUnit[currentUnit.length - 1] ?? 0;

  const pageLabel = useMemo(() => {
    if (currentUnit.length <= 1) return `${formatPage(Math.min(firstPageOfUnit + 1, pageCount))} / ${formatPage(pageCount)}`;
    return `${formatPage(firstPageOfUnit + 1)}-${formatPage(lastPageOfUnit + 1)} / ${formatPage(pageCount)}`;
  }, [currentUnit, firstPageOfUnit, lastPageOfUnit, pageCount]);

  const goNext = useCallback(() => setUnitIndex(index => Math.min(units.length - 1, index + 1)), [units.length]);
  const goPrev = useCallback(() => setUnitIndex(index => Math.max(0, index - 1)), []);

  useComicPrefetch(archiveRef, firstPageOfUnit, pageCount);
  useComicPrefetch(archiveRef, lastPageOfUnit, pageCount);

  // 键盘快捷键：capture 阶段截获（画布快捷键在 bubble），选中且卡片可见时才接管。
  useEffect(() => {
    if (!isSelected) return;
    const forwardKey = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backKey = rtl ? 'ArrowRight' : 'ArrowLeft';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key;
      if (key === forwardKey) {
        event.preventDefault();
        event.stopPropagation();
        goNext();
      } else if (key === backKey) {
        event.preventDefault();
        event.stopPropagation();
        goPrev();
      } else if (key === 'Home') {
        event.preventDefault();
        event.stopPropagation();
        setUnitIndex(0);
      } else if (key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        setUnitIndex(Math.max(0, units.length - 1));
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isSelected, rtl, goNext, goPrev, units.length]);

  if (pageCount === 0) {
    return (
      <section
        className="w-full h-full rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.46)] flex items-center justify-center select-none"
        style={{ background: 'var(--bp-card-bg)', borderColor: isSelected ? accent : 'var(--bp-border)', borderRadius: 'var(--bp-radius-card)', color: 'var(--bp-text-muted)' }}
        aria-label={t(`漫画：${element.name}`, `Comic: ${element.name}`)}
      >
        <span className="text-xs px-4 text-center">{t('漫画档案不可用', 'Comic archive unavailable')}</span>
      </section>
    );
  }

  const pillButtonStyle: React.CSSProperties = { borderColor: 'var(--bp-border)', color: 'var(--bp-text-primary)' };

  return (
    <section
      className="w-full h-full rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.46)] flex flex-col select-none overflow-hidden relative"
      style={{ background: 'var(--bp-card-bg)', borderColor: isSelected ? accent : 'var(--bp-border)', borderRadius: 'var(--bp-radius-card)', color: 'var(--bp-text-primary)' }}
      aria-label={t(`漫画：${element.name}`, `Comic: ${element.name}`)}
      data-bp-comic-reader
    >
      <div className="absolute -top-12 -right-12 w-32 h-32 rounded-full blur-3xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />
      <header className="relative z-10 flex items-center justify-between gap-2 px-3 pt-3 pb-2 border-b" style={{ borderColor: 'var(--bp-border)' }}>
        <div className="min-w-0 flex items-center gap-2 pointer-events-none">
          <span className="shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide" style={{ background: 'var(--bp-accent-soft)', borderColor: accent, color: accent }}>{sourceFormat}</span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold leading-tight">{element.name}</h3>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--bp-text-muted)' }}>{t(`${pageCount} 页`, `${pageCount} pages`)}</p>
          </div>
        </div>
        <span className="shrink-0 text-xs font-mono font-semibold" style={{ color: accent }}>{pageLabel}</span>
      </header>

      <div
        className="relative z-10 flex-1 min-h-0 m-2 rounded-xl border overflow-hidden bg-black/30 flex items-center justify-center gap-0.5"
        style={{ borderColor: 'var(--bp-border)', flexDirection: rtl && spreadMode ? 'row-reverse' : 'row' }}
        {...stopEvents}
      >
        {currentUnit.map(pageIndex => (
          <div key={pageIndex} className="min-w-0 h-full flex-1 flex items-center justify-center">
            <ComicPageImage element={element} archiveRef={archiveRef} legacyPages={legacyPages} pageIndex={pageIndex} />
          </div>
        ))}
      </div>

      <footer className="relative z-10 px-3 pb-3 pt-1 border-t flex flex-col gap-1.5" style={{ borderColor: 'var(--bp-border)' }} {...stopEvents}>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title={t('单页 / 双页对开', 'Single / two-page spread')}
            className="px-2 py-1 rounded-md border text-[11px] font-medium"
            style={{ ...pillButtonStyle, ...(spreadMode ? { borderColor: accent, color: accent } : {}) }}
            onClick={() => setSpreadMode(mode => !mode)}
          >
            {spreadMode ? t('双页', 'Spread') : t('单页', 'Single')}
          </button>
          <button
            type="button"
            title={t('阅读方向：左到右 / 右到左（日漫）', 'Reading direction: LTR / RTL (manga)')}
            className="px-2 py-1 rounded-md border text-[11px] font-medium"
            style={{ ...pillButtonStyle, ...(rtl ? { borderColor: accent, color: accent } : {}) }}
            onClick={() => setRtl(direction => !direction)}
          >
            {rtl ? t('日漫·右开', 'RTL') : t('左开', 'LTR')}
          </button>
          <span className="flex-1" />
          <span className="text-[10px]" style={{ color: 'var(--bp-text-muted)' }}>
            {isSelected ? t('←→ 翻页 · Home/End 首尾', '←→ pages · Home/End ends') : t('选中卡片后可用键盘翻页', 'Select the card to use keyboard paging')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="px-2 py-1 rounded-md border text-[11px] font-medium disabled:opacity-35" style={pillButtonStyle} disabled={unitIndex === 0} onClick={goPrev}>
            {t(rtl ? '下一页' : '上一页', rtl ? 'Next' : 'Previous')}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, units.length - 1)}
            value={unitIndex}
            onChange={event => setUnitIndex(Number(event.target.value))}
            className="flex-1 accent-pink-400"
            aria-label={t('漫画页', 'Comic page')}
          />
          <button type="button" className="px-2 py-1 rounded-md border text-[11px] font-medium disabled:opacity-35" style={pillButtonStyle} disabled={unitIndex >= units.length - 1} onClick={goNext}>
            {t(rtl ? '上一页' : '下一页', rtl ? 'Previous' : 'Next')}
          </button>
        </div>
      </footer>
    </section>
  );
};
