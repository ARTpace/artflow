/**
 * operationHistory.ts —— Element[] 的可逆 delta journal。
 *
 * 运行时依赖 immutable element update：未变元素保留对象引用，因此不会被写入 operation。
 * legacy JSON migration 才使用结构比较，将旧 Element[][] 压缩成同一 operation 形状。
 */

import type { Board, CanvasElementChange, CanvasOperation, Element } from '../types';

export type OperationDirection = 'undo' | 'redo';

let operationSequence = 0;

const createOperationId = (): string =>
  `op-${Date.now().toString(36)}-${(++operationSequence).toString(36)}`;

const cloneValue = <T>(value: T): T => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value)) as T;

/**
 * Undo snapshots must own their mutable metadata, but image/audio bytes are immutable strings.
 * structuredClone(element) duplicated every multi-megabyte data URL for each imported image
 * (and again when moving a large selection), causing multi-GB heap spikes on a single commit.
 * Sharing strings is safe; changes to an href always replace the string, never mutate it.
 */
export function cloneElement(element: Element): Element {
  if (element.type === 'image') {
    const { href, thumbnailHref, mediumHref, originalHref, ...metadata } = element;
    return {
      ...cloneValue(metadata),
      href,
      ...('thumbnailHref' in element ? { thumbnailHref } : {}),
      ...('mediumHref' in element ? { mediumHref } : {}),
      ...('originalHref' in element ? { originalHref } : {}),
    } as Element;
  }
  if (element.type === 'audio' || element.type === 'video') {
    const { href, ...metadata } = element;
    return { ...cloneValue(metadata), href } as Element;
  }
  return cloneValue(element);
}

function mapById(elements: readonly Element[]): Map<string, Element> {
  const byId = new Map<string, Element>();
  for (const element of elements) {
    if (byId.has(element.id)) throw new Error(`duplicate element id in operation history: ${element.id}`);
    byId.set(element.id, element);
  }
  return byId;
}

const sameOrder = (before: readonly Element[], after: readonly Element[]): boolean =>
  before.length === after.length && before.every((element, index) => element.id === after[index]?.id);

const structurallyEqual = (before: Element, after: Element): boolean =>
  before === after || JSON.stringify(before) === JSON.stringify(after);

function createCanvasOperationInternal(
  before: readonly Element[],
  after: readonly Element[],
  useStructuralComparison: boolean,
): CanvasOperation | null {
  const beforeById = mapById(before);
  const afterById = mapById(after);
  const ids = new Set<string>([...beforeById.keys(), ...afterById.keys()]);
  const changes: CanvasElementChange[] = [];

  for (const id of ids) {
    const previous = beforeById.get(id);
    const next = afterById.get(id);
    const unchanged = previous !== undefined && next !== undefined
      && (useStructuralComparison ? structurallyEqual(previous, next) : previous === next);
    if (unchanged) continue;
    changes.push({
      id,
      before: previous ? cloneElement(previous) : undefined,
      after: next ? cloneElement(next) : undefined,
    });
  }

  const orderChanged = !sameOrder(before, after);
  if (changes.length === 0 && !orderChanged) return null;
  return {
    id: createOperationId(),
    createdAt: Date.now(),
    // A position-only edit keeps current map order; do not make every drag retain all node ids.
    beforeOrder: orderChanged ? before.map(element => element.id) : undefined,
    afterOrder: orderChanged ? after.map(element => element.id) : undefined,
    changes,
  };
}

/** 在 runtime commit 边界生成一条 operation；未变 element 依赖引用相等性跳过。 */
export function createCanvasOperation(before: readonly Element[], after: readonly Element[]): CanvasOperation | null {
  return createCanvasOperationInternal(before, after, false);
}

/** 依照 operation 重建前/后状态；调用方获得新数组，输入数组不被修改。 */
export function applyCanvasOperation(
  elements: readonly Element[],
  operation: CanvasOperation,
  direction: OperationDirection,
): Element[] {
  const resultById = mapById(elements);
  const useBefore = direction === 'undo';
  for (const change of operation.changes) {
    const target = useBefore ? change.before : change.after;
    if (target) resultById.set(change.id, cloneElement(target));
    else resultById.delete(change.id);
  }

  const order = useBefore ? operation.beforeOrder : operation.afterOrder;
  // For property-only changes, Map preserves the current element order and no full id list is retained.
  if (!order) return [...resultById.values()];

  const ordered: Element[] = [];
  const consumed = new Set<string>();
  for (const id of order) {
    const element = resultById.get(id);
    if (!element) continue;
    ordered.push(element);
    consumed.add(id);
  }
  // 保守处理外部插入且不在 operation order 内的 element，避免无声丢数据。
  for (const element of resultById.values()) {
    if (!consumed.has(element.id)) ordered.push(element);
  }
  return ordered;
}

/** 将新 operation 追加到当前 undo branch；若曾 undo，会自动丢弃旧 redo branch。 */
export function commitCanvasOperation(
  operationHistory: readonly CanvasOperation[],
  operationHistoryIndex: number,
  before: readonly Element[],
  after: readonly Element[],
): { operationHistory: CanvasOperation[]; operationHistoryIndex: number } {
  const operation = createCanvasOperation(before, after);
  const currentIndex = Math.max(-1, Math.min(operationHistoryIndex, operationHistory.length - 1));
  if (!operation) {
    return { operationHistory: [...operationHistory], operationHistoryIndex: currentIndex };
  }
  const nextHistory = [...operationHistory.slice(0, currentIndex + 1), operation];
  return { operationHistory: nextHistory, operationHistoryIndex: nextHistory.length - 1 };
}

export interface CanvasOperationGroup {
  /** Shares immutable element references; it does not copy image data URLs. */
  baseline: readonly Element[];
  operationId: string;
}

/**
 * Merge successive painted import chunks into one undo step if nobody edited or
 * undid the document between them. If another operation intervenes, start a new
 * step instead of accidentally absorbing that user's changes into the import.
 */
export function commitGroupedCanvasOperation(
  history: readonly CanvasOperation[],
  index: number,
  before: readonly Element[],
  after: readonly Element[],
  group?: CanvasOperationGroup | null,
): { operationHistory: CanvasOperation[]; operationHistoryIndex: number; group: CanvasOperationGroup | null } {
  const canMerge = Boolean(group && index === history.length - 1 && history[index]?.id === group.operationId);
  const previousOperation = canMerge ? history[index] : undefined;
  const previousOrder = previousOperation?.afterOrder;
  // A typical import merely appends a few elements. Re-diffing every previous
  // image against the group baseline at every flush clones metadata O(n²),
  // creating long frames late in large imports. Extend the existing operation
  // with only the new tail when no intervening edit changed the prefix.
  if (group && previousOperation && previousOrder && after.length > before.length
      && previousOrder.length === before.length
      && before.every((element, i) => after[i] === element && previousOrder[i] === element.id)) {
    const added = after.slice(before.length);
    const ids = new Set(previousOrder);
    for (const element of added) {
      if (ids.has(element.id)) throw new Error(`duplicate element id in operation history: ${element.id}`);
      ids.add(element.id);
    }
    const extended: CanvasOperation = {
      ...previousOperation,
      afterOrder: [...previousOrder, ...added.map(element => element.id)],
      changes: [...previousOperation.changes, ...added.map(element => ({ id: element.id, after: cloneElement(element) }))],
    };
    return {
      operationHistory: [...history.slice(0, index), extended],
      operationHistoryIndex: index,
      group,
    };
  }
  const baseline = canMerge ? group!.baseline : before;
  const journal = commitCanvasOperation(
    canMerge ? history.slice(0, -1) : history,
    canMerge ? index - 1 : index,
    baseline,
    after,
  );
  const operation = journal.operationHistory[journal.operationHistoryIndex];
  return {
    ...journal,
    group: operation ? { baseline, operationId: operation.id } : null,
  };
}

function isOperation(value: unknown): value is CanvasOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.createdAt === 'number'
    && (candidate.beforeOrder === undefined || Array.isArray(candidate.beforeOrder))
    && (candidate.afterOrder === undefined || Array.isArray(candidate.afterOrder))
    && (candidate.beforeOrder === undefined) === (candidate.afterOrder === undefined)
    && Array.isArray(candidate.changes);
}

const clampIndex = (index: number, historyLength: number): number =>
  Math.max(-1, Math.min(index, historyLength - 1));

/**
 * 将历史 JSON 的 Element[][] 压缩为 operation journal。
 * 新保存文件会移除 legacy history 字段；当前 elements 保持项目打开时的状态。
 */
export function migrateLegacyBoardHistory(board: Board): Board {
  const { history: legacyHistory, historyIndex: legacyHistoryIndex, ...withoutLegacy } = board;
  if (Array.isArray(board.operationHistory) && board.operationHistory.every(isOperation)) {
    const operationHistory = board.operationHistory;
    const requestedIndex = typeof board.operationHistoryIndex === 'number'
      ? board.operationHistoryIndex
      : operationHistory.length - 1;
    return {
      ...withoutLegacy,
      operationHistory,
      operationHistoryIndex: clampIndex(requestedIndex, operationHistory.length),
    };
  }

  const snapshots = Array.isArray(legacyHistory) && legacyHistory.length > 0
    ? legacyHistory
    : [Array.isArray(board.elements) ? board.elements : []];
  const activeSnapshotIndex = Math.max(0, Math.min(
    typeof legacyHistoryIndex === 'number' ? legacyHistoryIndex : snapshots.length - 1,
    snapshots.length - 1,
  ));
  const operationHistory: CanvasOperation[] = [];
  let operationHistoryIndex = -1;
  for (let index = 1; index < snapshots.length; index += 1) {
    const operation = createCanvasOperationInternal(snapshots[index - 1], snapshots[index], true);
    if (!operation) continue;
    operationHistory.push(operation);
    if (index <= activeSnapshotIndex) operationHistoryIndex = operationHistory.length - 1;
  }

  return {
    ...withoutLegacy,
    elements: Array.isArray(board.elements) ? board.elements : snapshots[activeSnapshotIndex],
    operationHistory,
    operationHistoryIndex,
  };
}
