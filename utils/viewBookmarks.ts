import type { CanvasViewBookmark, Point } from '../types';

export const MAX_VIEW_BOOKMARKS = 12;
export const VIEW_BOOKMARK_NAME_MAX_LENGTH = 48;
export const VIEW_BOOKMARK_MIN_ZOOM = 0.02;
export const VIEW_BOOKMARK_MAX_ZOOM = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFinitePoint = (value: unknown): value is Point => (
  isRecord(value)
  && typeof value.x === 'number'
  && typeof value.y === 'number'
  && Number.isFinite(value.x)
  && Number.isFinite(value.y)
);

export const clampViewBookmarkZoom = (zoom: number): number =>
  Math.max(VIEW_BOOKMARK_MIN_ZOOM, Math.min(VIEW_BOOKMARK_MAX_ZOOM, zoom));

export const normalizeViewBookmarkName = (value: unknown, fallback: string): string => {
  const compact = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const safeFallback = fallback.replace(/\s+/g, ' ').trim() || 'View';
  return [...(compact || safeFallback)].slice(0, VIEW_BOOKMARK_NAME_MAX_LENGTH).join('').trim() || 'View';
};

/** Safe ingress/egress boundary for small Board-local camera metadata. */
export const normalizeViewBookmarks = (input: unknown): CanvasViewBookmark[] => {
  if (!Array.isArray(input)) return [];
  const normalized: CanvasViewBookmark[] = [];
  const ids = new Set<string>();
  for (const value of input) {
    if (normalized.length >= MAX_VIEW_BOOKMARKS) break;
    if (!isRecord(value)) continue;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const zoom = value.zoom;
    if (!id || id.length > 128 || ids.has(id) || !isFinitePoint(value.panOffset) || typeof zoom !== 'number' || !Number.isFinite(zoom)) {
      continue;
    }
    ids.add(id);
    normalized.push({
      id,
      name: normalizeViewBookmarkName(value.name, `View ${normalized.length + 1}`),
      panOffset: { x: value.panOffset.x, y: value.panOffset.y },
      zoom: clampViewBookmarkZoom(zoom),
    });
  }
  return normalized;
};

export const createCanvasViewBookmark = (
  bookmark: CanvasViewBookmark,
  fallbackName = 'View 1',
): CanvasViewBookmark | null => normalizeViewBookmarks([{
  ...bookmark,
  name: normalizeViewBookmarkName(bookmark.name, fallbackName),
}])[0] ?? null;

export const appendCanvasViewBookmark = (
  existing: unknown,
  bookmark: CanvasViewBookmark,
): CanvasViewBookmark[] => {
  const views = normalizeViewBookmarks(existing);
  const next = createCanvasViewBookmark(bookmark);
  if (!next || views.length >= MAX_VIEW_BOOKMARKS || views.some(view => view.id === next.id)) return views;
  return [...views, next];
};

export const renameCanvasViewBookmark = (existing: unknown, id: string, name: unknown): CanvasViewBookmark[] =>
  normalizeViewBookmarks(existing).map((view, index) => view.id === id
    ? { ...view, name: normalizeViewBookmarkName(name, `View ${index + 1}`) }
    : view);

export const removeCanvasViewBookmark = (existing: unknown, id: string): CanvasViewBookmark[] =>
  normalizeViewBookmarks(existing).filter(view => view.id !== id);
