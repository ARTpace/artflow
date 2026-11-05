/**
 * drag-commit.ts —— 一次拖动会话落到文档状态上的唯一入口（P1-B）。
 *
 * 拖动期间元素位置只存在于瞬时通道里（见 drag-session-store），文档状态一个字节都不动。
 * 松手时才走这里，把整段位移和由它引起的父级归属变化一次性写下去：
 * 一条撤销记录、一次索引失效，而不是拖动期间的每一帧一次。
 *
 * 两条容易写错的规则，都在这里固定：
 * 1. 父级解析必须用"位移后"的列表。拿拖动前的位置去判断元素落在哪个 Frame 里，
 *    跨 Frame 拖入会完全失效（元素明明被拖进去了，却还是老父级）。
 * 2. Frame 自身不参与父级解析：Frame 不能嵌套 Frame，这是既有语义。
 */
import type { Element } from '../types';
import type { InteractionViewportIndexSnapshot } from './interaction-spatial-query';
import { applyDragOffset, isZeroDragOffset } from './drag-offset';
import { createContainingFrameResolver } from './frame-parenting';

export interface DragCommitSession {
  /** 本次拖动涉及的元素 id（含其可拖动后代）。 */
  readonly elementIds: ReadonlySet<string>;
  readonly offset: { x: number; y: number };
}

/**
 * @param frameCandidateSnapshot 父级解析用的候选索引快照。
 *   拖动期间元素位置没有写回文档，R14 快照指向的是拖动前的位置，
 *   拿它窄化候选会漏掉新位置附近的 Frame，所以拖动提交应传 null（从位移后列表批量提取 Frame）。
 */
export const applyDragCommit = (
  elements: Element[],
  session: DragCommitSession,
  frameCandidateSnapshot: InteractionViewportIndexSnapshot | null = null,
): Element[] => {
  const { elementIds, offset } = session;

  const movedElements = isZeroDragOffset(offset)
    ? elements
    : elements.map(element => (
        elementIds.has(element.id) ? applyDragOffset(element, offset.x, offset.y) : element
      ));

  const resolveFrame = createContainingFrameResolver(movedElements, frameCandidateSnapshot);
  return movedElements.map(element => {
    if (!elementIds.has(element.id) || element.type === 'frame') return element;
    const containingFrame = resolveFrame(element);
    const newParentId = containingFrame ? containingFrame.id : undefined;
    if (element.parentId === newParentId) return element;
    return { ...element, parentId: newParentId };
  });
};
