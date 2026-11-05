/**
 * marquee-selection.ts —— 框选/套索的命中口径与修饰键语义（P0-2 / P0-3）。
 *
 * 抽出来的唯一理由：**逐帧预览与 mouseup 结算必须是同一份口径**。
 * 各写一套迟早漂移成"高亮亮着、松手却没选中"，而且两处都要各自维护
 * "锁定元素不可选、Frame 内的元素选自己、组成员选整个组"这几条老规矩。
 *
 * 命中判定本身沿用既有实现（严格 AABB 相交 / 中心点落在套索多边形内 + 可选中父级解析），
 * 这里只是把它从 mouseup 里搬出来，让预览与结算共用一处。
 */
import type { Element, Point, Rect } from '../types';
import { getElementBounds, getSelectableElement, isPointInPolygon } from './canvasUtils';
import { getLassoBounds, queryInteractionCandidates } from './interaction-spatial-query';
import type { InteractionViewportIndexSnapshot } from './interaction-spatial-query';
import type { SelectionPreviewMode } from './selection-preview-store';

/** 命中结果：id 是**结算后**会写进选区的 id，几何是它的完整外框（预览高亮直接画这个框）。 */
export interface MarqueePick {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 框选/套索的修饰键语义。Shift / Ctrl 等价（加选），Alt 减选；两者可以同时按下，减选优先（Alt 更强表达意图）。 */
export interface SelectionModifiers {
  readonly additive: boolean;
  readonly subtractive: boolean;
}

export const NO_SELECTION_MODIFIERS: SelectionModifiers = { additive: false, subtractive: false };

/**
 * mousedown 与 mousemove 都读同一份修饰键（用户可以在拖动中途按下/松开 Shift/Ctrl）。
 * 存在 ref 里而不是 state：它只影响"结算口径"与预览配色，没有东西需要因此重渲染。
 * Ctrl 与 Shift 同义（P0-2）：Windows 下"按住 Ctrl 加选"是更常见的手势；画布里的 Ctrl 只参与
 * 键盘快捷键与滚轮缩放（wheel + ctrlKey），不参与任何选区语义，因此复用 additive 不会抢手势。
 */
export const resolveSelectionModifiers = (event: {
  shiftKey: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
}): SelectionModifiers => ({
  additive: event.shiftKey || Boolean(event.ctrlKey),
  subtractive: Boolean(event.altKey),
});

export const resolvePreviewMode = (modifiers: SelectionModifiers): SelectionPreviewMode => (
  modifiers.subtractive ? 'subtract' : 'add'
);

/**
 * 候选元素 → 命中清单。三条老规矩保持原样：
 * - 锁定元素（或所属组锁定）不可选，直接跳过；
 * - 命中 Frame 内的元素时选中元素自己，命中组成员时选中整个组（getSelectableElement 负责）；
 * - 同一个可选中 id 只保留一份，几何取该可选中元素的完整外框。
 */
const collectPicks = (
  elements: Element[],
  candidates: readonly Element[],
  hitTest: (element: Element, bounds: Rect) => boolean,
): MarqueePick[] => {
  const picks = new Map<string, MarqueePick>();
  for (const candidate of candidates) {
    const bounds = getElementBounds(candidate, elements);
    if (!hitTest(candidate, bounds)) continue;
    const selectable = getSelectableElement(candidate.id, elements);
    if (!selectable || picks.has(selectable.id)) continue;
    const selectableBounds = selectable.id === candidate.id ? bounds : getElementBounds(selectable, elements);
    picks.set(selectable.id, {
      id: selectable.id,
      x: selectableBounds.x,
      y: selectableBounds.y,
      width: selectableBounds.width,
      height: selectableBounds.height,
    });
  }
  return Array.from(picks.values());
};

/** 框选命中：与选框**相交**即可（严格 AABB 相交，不看旋转 —— 既有口径不变）。 */
export const pickElementsInBox = (
  elements: Element[],
  index: InteractionViewportIndexSnapshot | null,
  box: Rect,
): MarqueePick[] => {
  const candidates = queryInteractionCandidates(index, elements, box);
  return collectPicks(elements, candidates, (_element, bounds) => (
    box.x < bounds.x + bounds.width
    && box.x + box.width > bounds.x
    && box.y < bounds.y + bounds.height
    && box.y + box.height > bounds.y
  ));
};

/** 套索命中：元素包围盒中心落在多边形内（既有口径不变）。 */
export const pickElementsInLasso = (
  elements: Element[],
  index: InteractionViewportIndexSnapshot | null,
  path: Point[],
): MarqueePick[] => {
  const bounds = getLassoBounds(path);
  const candidates = bounds ? queryInteractionCandidates(index, elements, bounds) : elements;
  return collectPicks(elements, candidates, (_element, elementBounds) => (
    isPointInPolygon({ x: elementBounds.x + elementBounds.width / 2, y: elementBounds.y + elementBounds.height / 2 }, path)
  ));
};

/**
 * 结算：把命中结果按修饰键合进既有选区。
 *
 * - 无修饰键：以命中结果为准 —— 框选空白即清空，这是既有行为；
 * - Shift / Ctrl（加选，两者等价）：并入命中项并去重；**空白框选保持原样**，否则"再加选一块"会先把已选的丢掉；
 * - Alt（减选）：从既有选区里剔除命中项；同样在没命中时保持原样（减空 = 不变）。
 *
 * 结果与入参等价时**刻意返回原数组引用**：React 对同一引用直接跳过这次重渲染，
 * 于是"按着 Shift 拖了个空框"这种手势不会产生任何状态变更。
 */
export const applySelectionModifiers = (
  base: readonly string[],
  pickedIds: readonly string[],
  modifiers: SelectionModifiers,
): string[] => {
  if (modifiers.subtractive) {
    if (pickedIds.length === 0) return base as string[];
    const removed = new Set(pickedIds);
    const next = base.filter(id => !removed.has(id));
    return next.length === base.length ? (base as string[]) : next;
  }
  if (modifiers.additive) {
    if (pickedIds.length === 0) return base as string[];
    const merged = new Set(base);
    pickedIds.forEach(id => merged.add(id));
    return merged.size === base.length ? (base as string[]) : Array.from(merged);
  }
  return Array.from(new Set(pickedIds));
};
