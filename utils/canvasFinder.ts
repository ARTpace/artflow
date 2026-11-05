import type { Element as CanvasElement, Point, Rect } from '../types';
import { centerCanvasPointInViewport, type CanvasViewportSize } from './canvasNavigator';
import { normalizeElementTags } from './elementTags';

export const CANVAS_FINDER_MAX_RESULTS = 50;

export type CanvasFinderFilter = 'all' | 'frames' | 'text' | 'assets';

export interface CanvasFinderResult {
  id: string;
  label: string;
  type: CanvasElement['type'];
  typeLabel: string;
  tags: string[];
  bounds: Rect;
}

export interface CanvasFinderModel {
  results: CanvasFinderResult[];
  totalMatches: number;
  isTruncated: boolean;
}

export interface CanvasFinderOptions {
  query?: string;
  filter?: CanvasFinderFilter;
  limit?: number;
}

const ASSET_TYPES = new Set<CanvasElement['type']>(['image', 'video', 'audio', 'font', 'model3d', 'file']);

const TYPE_LABELS: Partial<Record<CanvasElement['type'], string>> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  path: 'Path',
  shape: 'Shape',
  text: 'Text',
  arrow: 'Arrow',
  line: 'Line',
  group: 'Group',
  markdown: 'Markdown',
  code: 'Code',
  bookmark: 'Bookmark',
  font: 'Font',
  model3d: '3D model',
  file: 'File',
  frame: 'Frame',
};

/** Plugin-owned node types need no core label switch; known primitives retain their curated labels. */
const typeLabelFor = (type: CanvasElement['type']): string =>
  TYPE_LABELS[type] ?? type.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const compactText = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const truncateLabel = (value: string): string =>
  [...value].slice(0, 96).join('').trim();

/** Uses element-owned geometry only; it intentionally never traverses group children. */
const getStoredRect = (element: CanvasElement): Rect | null => {
  if (!isFiniteNumber(element.x) || !isFiniteNumber(element.y)) return null;
  const width = 'width' in element && isFiniteNumber(element.width) ? element.width : 0;
  const height = 'height' in element && isFiniteNumber(element.height) ? element.height : 0;
  if (width < 0 || height < 0) return null;
  return { x: element.x, y: element.y, width, height };
};

const getElementContent = (element: CanvasElement): string => {
  switch (element.type) {
    case 'text': return element.text;
    case 'markdown': return element.content;
    case 'code': return element.code;
    case 'bookmark': return `${element.title} ${element.url} ${element.description ?? ''}`;
    case 'shape': return element.shapeType;
    default: return '';
  }
};

const getElementLabel = (element: CanvasElement): string => {
  const named = compactText(element.name);
  const content = compactText(getElementContent(element));
  return truncateLabel(named || content || typeLabelFor(element.type)) || typeLabelFor(element.type);
};

const matchesFilter = (element: CanvasElement, filter: CanvasFinderFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'frames') return element.type === 'frame';
  if (filter === 'text') return element.type === 'text' || element.type === 'markdown' || element.type === 'code';
  return ASSET_TYPES.has(element.type);
};

const resolveLimit = (limit: number | undefined): number => {
  if (!isFiniteNumber(limit)) return CANVAS_FINDER_MAX_RESULTS;
  return Math.max(1, Math.min(CANVAS_FINDER_MAX_RESULTS, Math.floor(limit)));
};

/** Bounded, stable-order current-board lookup. This is not a persistent or indexed query. */
export const createCanvasFinderModel = (
  elements: readonly CanvasElement[],
  options: CanvasFinderOptions = {},
): CanvasFinderModel => {
  const queryTokens = compactText(options.query).toLowerCase().split(' ')
    .map(token => token.replace(/^#+/, ''))
    .filter(Boolean);
  const filter = options.filter ?? 'all';
  const limit = resolveLimit(options.limit);
  const ids = new Set<string>();
  const results: CanvasFinderResult[] = [];
  let totalMatches = 0;

  for (const element of elements) {
    if (!element || typeof element !== 'object' || element.isVisible === false || !matchesFilter(element, filter)) continue;
    const id = typeof element.id === 'string' ? element.id.trim() : '';
    const bounds = getStoredRect(element);
    if (!id || ids.has(id) || !bounds) continue;
    ids.add(id);
    const label = getElementLabel(element);
    const tags = normalizeElementTags(element.tags);
    const searchable = `${label} ${getElementContent(element)} ${tags.join(' ')} ${element.type} ${typeLabelFor(element.type)}`.toLowerCase();
    if (!queryTokens.every(token => searchable.includes(token))) continue;
    totalMatches += 1;
    if (results.length < limit) {
      results.push({ id, label, type: element.type, typeLabel: typeLabelFor(element.type), tags, bounds });
    }
  }

  return { results, totalMatches, isTruncated: totalMatches > results.length };
};

/** Reuses the R20 affine camera transform while preserving the caller's current zoom. */
export const focusCanvasFinderResult = (
  result: Pick<CanvasFinderResult, 'bounds'>,
  viewportSize: CanvasViewportSize,
  zoom: number,
): Point | null => {
  const { bounds } = result;
  if (!bounds || !isFiniteNumber(bounds.x) || !isFiniteNumber(bounds.y)
    || !isFiniteNumber(bounds.width) || !isFiniteNumber(bounds.height)
    || bounds.width < 0 || bounds.height < 0
    || !isFiniteNumber(viewportSize.width) || !isFiniteNumber(viewportSize.height)
    || viewportSize.width <= 0 || viewportSize.height <= 0
    || !isFiniteNumber(zoom) || zoom <= 0) return null;
  return centerCanvasPointInViewport({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }, viewportSize, zoom);
};
