/**
 * viewport-index.ts —— renderer-local spatial query bridge.
 *
 * ponytail: 这是 SQLite R-tree / Worker 查询到位前的内存 uniform-grid 适配层。
 * 它只在 elements 引用变化时重建，camera 移动只查相交网格；不承担持久化、hit-test 或事务一致性。
 */

import type { Element, Rect } from '../types';
import { getElementBounds } from './canvasUtils';

export const DEFAULT_VIEWPORT_GRID_CELL_SIZE = 1024;
export const DEFAULT_VIEWPORT_PADDING = 50;
const DEFAULT_MAX_CELLS_PER_ELEMENT = 256;

export interface ViewportIndexOptions {
  cellSize?: number;
  maxCellsPerElement?: number;
}

export interface ViewportQueryOptions {
  /** 选中对象即使移出屏幕也保留，维持当前拖拽语义。 */
  includeElementIds?: ReadonlySet<string>;
  padding?: number;
}

export interface ViewportIndexDiagnostics {
  indexedElementCount: number;
  gridCellCount: number;
  oversizedElementCount: number;
}

export interface ViewportIndex {
  query(viewport: Rect, options?: ViewportQueryOptions): readonly Element[];
  diagnostics(): ViewportIndexDiagnostics;
}

interface IndexedEntry {
  element: Element;
  bounds: Rect;
}

const cellKey = (x: number, y: number): string => `${x}:${y}`;

function intersects(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    a.x > b.x + b.width ||
    a.y + a.height < b.y ||
    a.y > b.y + b.height
  );
}

function expand(viewport: Rect, padding: number): Rect {
  return {
    x: viewport.x - padding,
    y: viewport.y - padding,
    width: viewport.width + padding * 2,
    height: viewport.height + padding * 2,
  };
}

function cellRange(bounds: Rect, cellSize: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const minX = Math.floor(bounds.x / cellSize);
  const minY = Math.floor(bounds.y / cellSize);
  const maxX = Math.floor((bounds.x + bounds.width) / cellSize);
  const maxY = Math.floor((bounds.y + bounds.height) / cellSize);
  if (![minX, minY, maxX, maxY].every(Number.isSafeInteger)) return null;
  return { minX, minY, maxX, maxY };
}

function finiteBounds(bounds: Rect): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width >= 0
    && bounds.height >= 0;
}

const validateViewportIndexOptions = (options: ViewportIndexOptions) => {
  const cellSize = options.cellSize ?? DEFAULT_VIEWPORT_GRID_CELL_SIZE;
  const maxCellsPerElement = options.maxCellsPerElement ?? DEFAULT_MAX_CELLS_PER_ELEMENT;
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('viewport index cellSize must be positive');
  if (!Number.isInteger(maxCellsPerElement) || maxCellsPerElement < 1) {
    throw new Error('viewport index maxCellsPerElement must be a positive integer');
  }
  return { cellSize, maxCellsPerElement };
};

interface ViewportBoundsDependencySnapshot {
  boundsById: Map<string, Rect>;
  childrenByParentId: Map<string, readonly string[]>;
  parentById: Map<string, string | undefined>;
  groupEvaluationOrder: readonly string[];
}

const unionGroupChildren = (childIds: readonly string[], boundsById: ReadonlyMap<string, Rect>): Rect | null => {
  if (childIds.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const childId of childIds) {
    const bounds = boundsById.get(childId);
    if (!bounds) return null;
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** Build a unique, acyclic Group dependency projection and compute every bound once. */
const createViewportBoundsDependencySnapshot = (
  elements: readonly Element[],
): ViewportBoundsDependencySnapshot | null => {
  const elementsById = new Map<string, Element>();
  const parentById = new Map<string, string | undefined>();
  const mutableChildren = new Map<string, string[]>();
  for (const element of elements) {
    if (elementsById.has(element.id)) return null;
    elementsById.set(element.id, element);
    parentById.set(element.id, element.parentId);
    if (element.parentId) {
      const children = mutableChildren.get(element.parentId);
      if (children) children.push(element.id);
      else mutableChildren.set(element.parentId, [element.id]);
    }
  }

  const boundsById = new Map<string, Rect>();
  const pendingGroupChildren = new Map<string, number>();
  const readyGroups: string[] = [];
  let groupCount = 0;
  for (const element of elements) {
    if (element.type !== 'group') {
      boundsById.set(element.id, getElementBounds(element, []));
      continue;
    }
    groupCount += 1;
    const childIds = mutableChildren.get(element.id) ?? [];
    let pending = 0;
    for (const childId of childIds) {
      if (elementsById.get(childId)?.type === 'group') pending += 1;
    }
    pendingGroupChildren.set(element.id, pending);
    if (pending === 0) readyGroups.push(element.id);
  }

  const groupEvaluationOrder: string[] = [];
  for (let cursor = 0; cursor < readyGroups.length; cursor += 1) {
    const groupId = readyGroups[cursor];
    const group = elementsById.get(groupId)!;
    const childIds = mutableChildren.get(groupId) ?? [];
    const childUnion = unionGroupChildren(childIds, boundsById);
    boundsById.set(groupId, childUnion ?? getElementBounds(group, []));
    groupEvaluationOrder.push(groupId);

    const parentId = parentById.get(groupId);
    if (!parentId || elementsById.get(parentId)?.type !== 'group') continue;
    const remaining = (pendingGroupChildren.get(parentId) ?? 0) - 1;
    pendingGroupChildren.set(parentId, remaining);
    if (remaining === 0) readyGroups.push(parentId);
  }
  if (groupEvaluationOrder.length !== groupCount) return null;

  return {
    boundsById,
    childrenByParentId: mutableChildren,
    parentById,
    groupEvaluationOrder,
  };
};

export function createViewportIndex(elements: readonly Element[], options: ViewportIndexOptions = {}): ViewportIndex {
  const { cellSize, maxCellsPerElement } = validateViewportIndexOptions(options);

  const entries: IndexedEntry[] = [];
  const grid = new Map<string, number[]>();
  const oversizedIndexes = new Set<number>();
  const indexesById = new Map<string, number>();
  const dependencySnapshot = createViewportBoundsDependencySnapshot(elements);

  elements.forEach((element, index) => {
    // Invalid duplicate/cyclic Group graphs fail closed: primitive nodes remain queryable,
    // while unsafe Group bounds are omitted instead of recursing indefinitely.
    const bounds = dependencySnapshot?.boundsById.get(element.id)
      ?? (element.type === 'group'
        ? { x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN }
        : getElementBounds(element, []));
    if (!finiteBounds(bounds)) return;
    entries[index] = { element, bounds };
    indexesById.set(element.id, index);

    const range = cellRange(bounds, cellSize);
    if (!range) {
      oversizedIndexes.add(index);
      return;
    }
    const cellCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    if (!Number.isSafeInteger(cellCount) || cellCount > maxCellsPerElement) {
      oversizedIndexes.add(index);
      return;
    }
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = cellKey(x, y);
        const bucket = grid.get(key);
        if (bucket) bucket.push(index);
        else grid.set(key, [index]);
      }
    }
  });

  return {
    query(viewport: Rect, queryOptions: ViewportQueryOptions = {}): readonly Element[] {
      const paddedViewport = expand(viewport, queryOptions.padding ?? DEFAULT_VIEWPORT_PADDING);
      const candidateIndexes = new Set<number>(oversizedIndexes);
      const range = cellRange(paddedViewport, cellSize);
      if (range) {
        for (let x = range.minX; x <= range.maxX; x += 1) {
          for (let y = range.minY; y <= range.maxY; y += 1) {
            for (const index of grid.get(cellKey(x, y)) ?? []) candidateIndexes.add(index);
          }
        }
      }
      for (const id of queryOptions.includeElementIds ?? []) {
        const index = indexesById.get(id);
        if (index !== undefined) candidateIndexes.add(index);
      }

      const included = queryOptions.includeElementIds ?? new Set<string>();
      return [...candidateIndexes]
        .sort((a, b) => a - b)
        .flatMap(index => {
          const entry = entries[index];
          if (!entry) return [];
          return intersects(entry.bounds, paddedViewport) || included.has(entry.element.id) ? [entry.element] : [];
        });
    },
    diagnostics: () => ({
      indexedElementCount: entries.filter(Boolean).length,
      gridCellCount: grid.size,
      oversizedElementCount: oversizedIndexes.size,
    }),
  };
}

/** Update result for the mount-scoped cache; full rebuild always wins over stale geometry. */
export type ViewportIndexCacheUpdateKind = 'initial' | 'reused' | 'incremental' | 'rebuild';

export interface ViewportIndexCacheDiagnostics extends ViewportIndexDiagnostics {
  buildCount: number;
  incrementalUpdateCount: number;
  dependencyPropagationCount: number;
  reusedUpdateCount: number;
  lastUpdate: ViewportIndexCacheUpdateKind;
}

export interface ViewportIndexCache {
  update(elements: readonly Element[]): ViewportIndex;
  diagnostics(): ViewportIndexCacheDiagnostics;
}

interface CachedViewportEntry {
  element: Element;
  bounds: Rect;
  cellKeys: readonly string[];
  oversized: boolean;
}

/**
 * Mutable renderer-local facade over the existing immutable index semantics.
 * Flat edits update changed entries; valid Group hierarchies additionally propagate bounds to ancestors.
 * Structural mutations and invalid dependency graphs conservatively rebuild.
 */
export function createViewportIndexCache(options: ViewportIndexOptions = {}): ViewportIndexCache {
  const { cellSize, maxCellsPerElement } = validateViewportIndexOptions(options);
  const effectiveOptions = { cellSize, maxCellsPerElement };
  let previousElements: readonly Element[] | null = null;
  let currentIndex: ViewportIndex | null = null;
  let mutableMode = false;
  let dependencySnapshot: ViewportBoundsDependencySnapshot | null = null;
  let order: string[] = [];
  let orderById = new Map<string, number>();
  let entriesById = new Map<string, CachedViewportEntry>();
  let grid = new Map<string, Set<string>>();
  let oversizedIds = new Set<string>();
  let buildCount = 0;
  let incrementalUpdateCount = 0;
  let dependencyPropagationCount = 0;
  let reusedUpdateCount = 0;
  let lastUpdate: ViewportIndexCacheUpdateKind = 'initial';

  const detach = (id: string) => {
    const entry = entriesById.get(id);
    if (!entry) return;
    entriesById.delete(id);
    if (entry.oversized) oversizedIds.delete(id);
    for (const key of entry.cellKeys) {
      const bucket = grid.get(key);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) grid.delete(key);
    }
  };

  const attach = (element: Element, bounds: Rect) => {
    if (!finiteBounds(bounds)) return;
    const range = cellRange(bounds, cellSize);
    if (!range) {
      entriesById.set(element.id, { element, bounds, cellKeys: [], oversized: true });
      oversizedIds.add(element.id);
      return;
    }
    const cellCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    if (!Number.isSafeInteger(cellCount) || cellCount > maxCellsPerElement) {
      entriesById.set(element.id, { element, bounds, cellKeys: [], oversized: true });
      oversizedIds.add(element.id);
      return;
    }
    const cellKeys: string[] = [];
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = cellKey(x, y);
        cellKeys.push(key);
        const bucket = grid.get(key);
        if (bucket) bucket.add(element.id);
        else grid.set(key, new Set([element.id]));
      }
    }
    entriesById.set(element.id, { element, bounds, cellKeys, oversized: false });
  };

  const mutableIndex: ViewportIndex = {
    query(viewport: Rect, queryOptions: ViewportQueryOptions = {}): readonly Element[] {
      const paddedViewport = expand(viewport, queryOptions.padding ?? DEFAULT_VIEWPORT_PADDING);
      const candidateIds = new Set<string>(oversizedIds);
      const range = cellRange(paddedViewport, cellSize);
      if (range) {
        for (let x = range.minX; x <= range.maxX; x += 1) {
          for (let y = range.minY; y <= range.maxY; y += 1) {
            for (const id of grid.get(cellKey(x, y)) ?? []) candidateIds.add(id);
          }
        }
      }
      const included = queryOptions.includeElementIds ?? new Set<string>();
      for (const id of included) if (entriesById.has(id)) candidateIds.add(id);

      // Preserve source order without scanning every canvas element on each camera query.
      // The grid already narrowed the candidate set; sorting only those ids keeps the
      // hot path proportional to visible/candidate content rather than document size.
      return [...candidateIds]
        .sort((a, b) => (orderById.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderById.get(b) ?? Number.MAX_SAFE_INTEGER))
        .flatMap(id => {
          const entry = entriesById.get(id);
          if (!entry) return [];
          return intersects(entry.bounds, paddedViewport) || included.has(id) ? [entry.element] : [];
        });
    },
    diagnostics: () => ({
      indexedElementCount: entriesById.size,
      gridCellCount: grid.size,
      oversizedElementCount: oversizedIds.size,
    }),
  };

  const rebuild = (elements: readonly Element[], kind: Extract<ViewportIndexCacheUpdateKind, 'initial' | 'rebuild'>): ViewportIndex => {
    buildCount += 1;
    lastUpdate = kind;
    previousElements = elements;
    dependencySnapshot = createViewportBoundsDependencySnapshot(elements);
    if (!dependencySnapshot) {
      mutableMode = false;
      currentIndex = createViewportIndex(elements, effectiveOptions);
      return currentIndex;
    }
    mutableMode = true;
    order = elements.map(element => element.id);
    orderById = new Map(order.map((id, index) => [id, index]));
    entriesById = new Map();
    grid = new Map();
    oversizedIds = new Set();
    for (const element of elements) {
      const bounds = dependencySnapshot.boundsById.get(element.id);
      if (bounds) attach(element, bounds);
    }
    currentIndex = mutableIndex;
    return currentIndex;
  };

  return {
    update(elements: readonly Element[]): ViewportIndex {
      if (!currentIndex || !previousElements) return rebuild(elements, 'initial');
      if (previousElements === elements) {
        reusedUpdateCount += 1;
        lastUpdate = 'reused';
        return currentIndex;
      }
      if (!mutableMode || previousElements.length !== elements.length) {
        return rebuild(elements, 'rebuild');
      }

      // Validate the stable dependency structure and collect immutable changes in one pass.
      // Reparent/type/id/order mutations rebuild rather than risk stale Group geometry.
      if (!dependencySnapshot) return rebuild(elements, 'rebuild');
      const changedIds = new Set<string>();
      for (let index = 0; index < elements.length; index += 1) {
        const previous = previousElements[index];
        const next = elements[index];
        if (
          !next
          || previous.id !== next.id
          || previous.type !== next.type
          || previous.parentId !== next.parentId
        ) {
          return rebuild(elements, 'rebuild');
        }
        if (previous !== next) changedIds.add(next.id);
      }
      if (changedIds.size === 0) {
        previousElements = elements;
        reusedUpdateCount += 1;
        lastUpdate = 'reused';
        return mutableIndex;
      }

      const impactedIds = new Set(changedIds);
      for (const changedId of changedIds) {
        let parentId = dependencySnapshot.parentById.get(changedId);
        const observedParents = new Set<string>();
        while (parentId) {
          if (observedParents.has(parentId)) return rebuild(elements, 'rebuild');
          observedParents.add(parentId);
          const parentIndex = orderById.get(parentId);
          if (parentIndex === undefined || elements[parentIndex]?.type !== 'group') break;
          impactedIds.add(parentId);
          parentId = dependencySnapshot.parentById.get(parentId);
        }
      }

      // Primitive bounds are independent. Group bounds are then recomputed child-first
      // using the build-time topological order and the just-updated child bounds.
      for (const changedId of changedIds) {
        const elementIndex = orderById.get(changedId);
        const element = elementIndex === undefined ? undefined : elements[elementIndex];
        if (!element || element.type === 'group') continue;
        dependencySnapshot.boundsById.set(changedId, getElementBounds(element, []));
      }
      for (const groupId of dependencySnapshot.groupEvaluationOrder) {
        if (!impactedIds.has(groupId)) continue;
        const groupIndex = orderById.get(groupId);
        const group = groupIndex === undefined ? undefined : elements[groupIndex];
        if (!group || group.type !== 'group') return rebuild(elements, 'rebuild');
        const childIds = dependencySnapshot.childrenByParentId.get(groupId) ?? [];
        const childUnion = unionGroupChildren(childIds, dependencySnapshot.boundsById);
        dependencySnapshot.boundsById.set(groupId, childUnion ?? getElementBounds(group, []));
      }

      for (const id of impactedIds) detach(id);
      for (const id of impactedIds) {
        const elementIndex = orderById.get(id);
        const element = elementIndex === undefined ? undefined : elements[elementIndex];
        const bounds = dependencySnapshot.boundsById.get(id);
        if (element && bounds) attach(element, bounds);
      }
      previousElements = elements;
      incrementalUpdateCount += changedIds.size;
      dependencyPropagationCount += Math.max(0, impactedIds.size - changedIds.size);
      lastUpdate = 'incremental';
      return mutableIndex;
    },
    diagnostics: () => ({
      ...(currentIndex?.diagnostics() ?? { indexedElementCount: 0, gridCellCount: 0, oversizedElementCount: 0 }),
      buildCount,
      incrementalUpdateCount,
      dependencyPropagationCount,
      reusedUpdateCount,
      lastUpdate,
    }),
  };
}
