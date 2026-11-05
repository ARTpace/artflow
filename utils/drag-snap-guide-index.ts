/**
 * drag-snap-guide-index.ts —— drag lifetime global alignment-guide snapshot.
 *
 * This is deliberately not a viewport index: existing snapping compares every
 * static board alignment line. The snapshot only replaces repeated guide-set
 * rebuilding during one supported drag and fails closed when its expected
 * immutable elements reference is no longer observed. R16 admits a group only
 * after proving its reachable descendants are all static for this gesture.
 */

import type { Element, Rect } from '../types';
import { getElementBounds } from './canvasUtils';

export type SnapAxis = 'v' | 'h';

export interface SnapGuideMatch {
  value: number;
  distance: number;
  /** Original legacy Set insertion position, used for deterministic equal-distance ties. */
  rank: number;
}

export interface SnapAxisGuideIndex {
  findNearest(target: number, threshold: number): SnapGuideMatch | null;
  diagnostics(): { distinctGuideCount: number };
}

export interface DragSnapGuideSnapshot {
  readonly vertical: SnapAxisGuideIndex;
  readonly horizontal: SnapAxisGuideIndex;
  /** Gesture-start geometry, including real group descendant bounds. Use only while documents stay unchanged. */
  getMovingBounds(elementId: string): Rect | undefined;
  /** O(1) currentness guard; the hook advances only through its own immutable drag updater. */
  isCurrent(elements: readonly Element[]): boolean;
  advance(elements: readonly Element[]): void;
  invalidate(): void;
  diagnostics(): { staticElementCount: number; verticalGuideCount: number; horizontalGuideCount: number };
}

interface RankedGuide {
  value: number;
  rank: number;
}

const finiteBounds = (bounds: Rect): boolean => [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite);

const lowerBound = (entries: readonly RankedGuide[], value: number): number => {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (entries[middle].value < value) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Preserves a legacy Set's first-insertion rank while sorting a copy for range lookup.
 * It returns the same single-guide winner as a strict-distance Set scan for one target.
 */
export function createSnapAxisGuideIndex(values: Iterable<number>): SnapAxisGuideIndex | null {
  const ranks = new Map<number, number>();
  for (const value of values) {
    if (!Number.isFinite(value)) return null;
    // Map insertion order is the same order a legacy Set would expose for unique values.
    if (!ranks.has(value)) ranks.set(value, ranks.size);
  }

  const entries = [...ranks.entries()]
    .map(([value, guideRank]) => ({ value, rank: guideRank }))
    .sort((a, b) => a.value - b.value || a.rank - b.rank);

  return {
    findNearest(target: number, threshold: number): SnapGuideMatch | null {
      if (!Number.isFinite(target) || !Number.isFinite(threshold) || threshold <= 0) return null;
      const maximum = target + threshold;
      let best: SnapGuideMatch | null = null;
      for (let index = lowerBound(entries, target - threshold); index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.value > maximum) break;
        const distance = Math.abs(target - entry.value);
        // Original code uses `distance < threshold`, then keeps the first Set item on an exact tie.
        if (
          distance < threshold
          && (!best || distance < best.distance || (distance === best.distance && entry.rank < best.rank))
        ) {
          best = { value: entry.value, distance, rank: entry.rank };
        }
      }
      return best;
    },
    diagnostics: () => ({ distinctGuideCount: entries.length }),
  };
}

const addGuidePoints = (vertical: Set<number>, horizontal: Set<number>, bounds: Rect) => {
  vertical.add(bounds.x);
  vertical.add(bounds.x + bounds.width / 2);
  vertical.add(bounds.x + bounds.width);
  horizontal.add(bounds.y);
  horizontal.add(bounds.y + bounds.height / 2);
  horizontal.add(bounds.y + bounds.height);
};

const buildChildrenByParentId = (elements: readonly Element[]): Map<string, readonly Element[]> => {
  const mutable = new Map<string, Element[]>();
  for (const element of elements) {
    if (!element.parentId) continue;
    const children = mutable.get(element.parentId);
    if (children) children.push(element);
    else mutable.set(element.parentId, [element]);
  }
  return mutable;
};

/**
 * getElementBounds recursively visits only group children. Reject a cycle before
 * snapshot construction so the optimization never starts recursive geometry on
 * malformed input.
 */
const groupGraphIsAcyclic = (groups: readonly Element[], childrenByParentId: ReadonlyMap<string, readonly Element[]>): boolean => {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (groupId: string): boolean => {
    if (visited.has(groupId)) return true;
    if (visiting.has(groupId)) return false;
    visiting.add(groupId);
    for (const child of childrenByParentId.get(groupId) ?? []) {
      if (child.type === 'group' && !visit(child.id)) return false;
    }
    visiting.delete(groupId);
    visited.add(groupId);
    return true;
  };
  return groups.every(group => visit(group.id));
};

/** A frozen static group is safe only when every group-reachable child remains static in this gesture. */
const staticGroupHasMovingDescendant = (
  groupId: string,
  movingElementIds: ReadonlySet<string>,
  childrenByParentId: ReadonlyMap<string, readonly Element[]>,
): boolean => {
  const pending = [...(childrenByParentId.get(groupId) ?? [])];
  while (pending.length > 0) {
    const child = pending.pop()!;
    if (movingElementIds.has(child.id)) return true;
    if (child.type === 'group') pending.push(...(childrenByParentId.get(child.id) ?? []));
  }
  return false;
};

/**
 * Creates the static half of one drag's legacy global snap comparison.
 * R16 admits static groups only after a one-shot descendant dependency proof.
 */
export function createDragSnapGuideSnapshot(
  elements: readonly Element[],
  movingElementIds: ReadonlySet<string>,
): DragSnapGuideSnapshot | null {
  if (movingElementIds.size === 0) return null;

  const ids = new Set<string>();
  const groups: Element[] = [];
  for (const element of elements) {
    if (ids.has(element.id)) return null;
    ids.add(element.id);
    if (element.type === 'group') groups.push(element);
  }

  const childrenByParentId = buildChildrenByParentId(elements);
  if (!groupGraphIsAcyclic(groups, childrenByParentId)) return null;
  for (const group of groups) {
    if (!movingElementIds.has(group.id) && staticGroupHasMovingDescendant(group.id, movingElementIds, childrenByParentId)) {
      return null;
    }
  }

  const verticalValues = new Set<number>();
  const horizontalValues = new Set<number>();
  let staticElementCount = 0;
  const movingBounds = new Map<string, Rect>();
  for (const element of elements) {
    const bounds = getElementBounds(element, elements as Element[]);
    if (!finiteBounds(bounds)) return null;
    if (movingElementIds.has(element.id)) {
      movingBounds.set(element.id, bounds);
      continue;
    }
    addGuidePoints(verticalValues, horizontalValues, bounds);
    staticElementCount += 1;
  }

  const vertical = createSnapAxisGuideIndex(verticalValues);
  const horizontal = createSnapAxisGuideIndex(horizontalValues);
  if (!vertical || !horizontal) return null;

  let expectedElements: readonly Element[] | null = elements;
  return {
    vertical,
    horizontal,
    getMovingBounds: elementId => movingBounds.get(elementId),
    isCurrent: currentElements => expectedElements === currentElements,
    advance: currentElements => { expectedElements = currentElements; },
    invalidate: () => { expectedElements = null; },
    diagnostics: () => ({
      staticElementCount,
      verticalGuideCount: vertical.diagnostics().distinctGuideCount,
      horizontalGuideCount: horizontal.diagnostics().distinctGuideCount,
    }),
  };
}
