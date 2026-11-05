/**
 * interaction-spatial-query.ts —— R11 live index 的保守 interaction query adapter。
 *
 * MainCanvas owns the index. Consumers can only use a snapshot that was built for
 * the exact current elements reference; otherwise they intentionally scan the
 * current list so an out-of-date ref can never omit a selectable element.
 */

import type { Element, Point, Rect } from '../types';
import type { ViewportIndex } from './viewport-index';

export interface InteractionViewportIndexSnapshot {
  readonly elements: readonly Element[];
  readonly index: ViewportIndex;
}

/** A consumer can observe the snapshot but cannot publish/clear MainCanvas-owned state. */
export interface InteractionViewportIndexReader {
  readonly current: InteractionViewportIndexSnapshot | null;
}

/**
 * Gets a conservative candidate list for an interaction region.
 * `ViewportIndex.query` can return padding false positives; callers must retain
 * their exact geometric selection predicate after this function.
 */
export function queryInteractionCandidates(
  snapshot: InteractionViewportIndexSnapshot | null,
  elements: readonly Element[],
  region: Rect,
): readonly Element[] {
  if (!snapshot || snapshot.elements !== elements) return elements;
  return snapshot.index.query(region);
}

/** Returns the smallest finite AABB that encloses a lasso path, or null when unsafe to query. */
export function getLassoBounds(path: readonly Point[]): Rect | null {
  if (path.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of path) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
