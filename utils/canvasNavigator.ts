import type { Element as CanvasElement, Point, Rect } from '../types';
import { getElementBounds } from './canvasUtils';

export const NAVIGATOR_MAX_MARKERS = 240;
export const NAVIGATOR_MIN_ZOOM = 0.02;
export const NAVIGATOR_MAX_ZOOM = 10;

export interface CanvasViewportSize {
  width: number;
  height: number;
}

export interface CanvasNavigatorMarker {
  id: string;
  type: CanvasElement['type'];
  bounds: Rect;
}

export interface CanvasNavigatorModel {
  contentBounds: Rect | null;
  markers: CanvasNavigatorMarker[];
  totalCount: number;
  isTruncated: boolean;
}

export interface NavigatorProjection {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const isFiniteNonNegativeRect = (rect: Rect): boolean => (
  Number.isFinite(rect.x)
  && Number.isFinite(rect.y)
  && Number.isFinite(rect.width)
  && Number.isFinite(rect.height)
  && rect.width >= 0
  && rect.height >= 0
);

const storedGroupBounds = (element: Extract<CanvasElement, { type: 'group' }>): Rect => ({
  x: element.x,
  y: element.y,
  width: element.width,
  height: element.height,
});

const evenlySample = <T,>(items: readonly T[], maximum: number): T[] => {
  if (maximum <= 0) return [];
  if (items.length <= maximum) return [...items];
  return Array.from({ length: maximum }, (_, index) => items[Math.floor(index * items.length / maximum)]);
};

/** A bounded renderer overview; groups use their stored rect so malformed parent graphs cannot recurse here. */
export const createCanvasNavigatorModel = (elements: readonly CanvasElement[]): CanvasNavigatorModel => {
  const finite = elements.flatMap(element => {
    const bounds = element.type === 'group'
      ? storedGroupBounds(element)
      : getElementBounds(element, elements as CanvasElement[]);
    return isFiniteNonNegativeRect(bounds) ? [{ id: element.id, type: element.type, bounds }] : [];
  });
  const frames = finite.filter(marker => marker.type === 'frame');
  const nonFrames = finite.filter(marker => marker.type !== 'frame');
  const markers = frames.length >= NAVIGATOR_MAX_MARKERS
    ? evenlySample(frames, NAVIGATOR_MAX_MARKERS)
    : [...frames, ...evenlySample(nonFrames, NAVIGATOR_MAX_MARKERS - frames.length)];

  return {
    contentBounds: unionCanvasRects(finite.map(marker => marker.bounds)),
    markers,
    totalCount: finite.length,
    isTruncated: finite.length > markers.length,
  };
};

export const unionCanvasRects = (rects: readonly (Rect | null | undefined)[]): Rect | null => {
  const valid = rects.filter((rect): rect is Rect => Boolean(rect) && isFiniteNonNegativeRect(rect));
  if (valid.length === 0) return null;
  const minX = Math.min(...valid.map(rect => rect.x));
  const minY = Math.min(...valid.map(rect => rect.y));
  const maxX = Math.max(...valid.map(rect => rect.x + rect.width));
  const maxY = Math.max(...valid.map(rect => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

export const getCanvasWorldViewport = ({
  viewportSize,
  panOffset,
  zoom,
}: {
  viewportSize: CanvasViewportSize;
  panOffset: Point;
  zoom: number;
}): Rect => {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const width = Number.isFinite(viewportSize.width) ? Math.max(0, viewportSize.width) : 0;
  const height = Number.isFinite(viewportSize.height) ? Math.max(0, viewportSize.height) : 0;
  const panX = Number.isFinite(panOffset.x) ? panOffset.x : 0;
  const panY = Number.isFinite(panOffset.y) ? panOffset.y : 0;
  return {
    x: -panX / safeZoom,
    y: -panY / safeZoom,
    width: width / safeZoom,
    height: height / safeZoom,
  };
};

export const createNavigatorProjection = (
  bounds: Rect,
  navigatorSize: CanvasViewportSize,
  padding = 8,
): NavigatorProjection | null => {
  if (!isFiniteNonNegativeRect(bounds) || navigatorSize.width <= 0 || navigatorSize.height <= 0) return null;
  const usableWidth = Math.max(1, navigatorSize.width - padding * 2);
  const usableHeight = Math.max(1, navigatorSize.height - padding * 2);
  const worldWidth = Math.max(1, bounds.width);
  const worldHeight = Math.max(1, bounds.height);
  const scale = Math.min(usableWidth / worldWidth, usableHeight / worldHeight);
  const drawnWidth = worldWidth * scale;
  const drawnHeight = worldHeight * scale;
  return {
    scale,
    offsetX: padding + (usableWidth - drawnWidth) / 2 - bounds.x * scale,
    offsetY: padding + (usableHeight - drawnHeight) / 2 - bounds.y * scale,
  };
};

export const projectNavigatorRect = (rect: Rect, projection: NavigatorProjection): Rect => ({
  x: rect.x * projection.scale + projection.offsetX,
  y: rect.y * projection.scale + projection.offsetY,
  width: rect.width * projection.scale,
  height: rect.height * projection.scale,
});

export const unprojectNavigatorPoint = (point: Point, projection: NavigatorProjection): Point => ({
  x: (point.x - projection.offsetX) / projection.scale,
  y: (point.y - projection.offsetY) / projection.scale,
});

export const centerCanvasPointInViewport = (
  point: Point,
  viewportSize: CanvasViewportSize,
  zoom: number,
): Point => ({
  x: viewportSize.width / 2 - point.x * zoom,
  y: viewportSize.height / 2 - point.y * zoom,
});

export const fitCanvasViewport = (
  bounds: Rect | null,
  viewportSize: CanvasViewportSize,
  padding = 72,
): { panOffset: Point; zoom: number } | null => {
  if (!bounds || !isFiniteNonNegativeRect(bounds) || viewportSize.width <= 0 || viewportSize.height <= 0) return null;
  const usableWidth = Math.max(1, viewportSize.width - padding * 2);
  const usableHeight = Math.max(1, viewportSize.height - padding * 2);
  const worldWidth = Math.max(1, bounds.width);
  const worldHeight = Math.max(1, bounds.height);
  const zoom = Math.max(NAVIGATOR_MIN_ZOOM, Math.min(NAVIGATOR_MAX_ZOOM, usableWidth / worldWidth, usableHeight / worldHeight));
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return { panOffset: centerCanvasPointInViewport(center, viewportSize, zoom), zoom };
};
