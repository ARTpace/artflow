/**
 * drag-offset.ts —— 一次拖动位移作用到元素上的唯一实现（P1-B）。
 *
 * 拖动预览和最终提交必须共用这一个函数。分成两处实现的话，path/arrow/line
 * 这类"位置存在 points 里而不是 x/y 里"的元素会在松手瞬间跳到别的地方，
 * 而且这种分叉只在拖动点集元素时才暴露，回归成本很高。
 *
 * 位移为 0 时返回原引用：调用方（预览层）依赖引用相等跳过重绘。
 */
import type { Element } from '../types';

export const applyDragOffset = (element: Element, dx: number, dy: number): Element => {
  if (dx === 0 && dy === 0) return element;

  if (element.type === 'path') {
    return { ...element, points: element.points.map(point => ({ x: point.x + dx, y: point.y + dy })) };
  }

  if (element.type === 'arrow' || element.type === 'line') {
    const [start, end] = element.points;
    return {
      ...element,
      points: [
        { x: start.x + dx, y: start.y + dy },
        { x: end.x + dx, y: end.y + dy },
      ],
    };
  }

  const positioned = element as Element & { x?: number; y?: number };
  if (typeof positioned.x !== 'number' || typeof positioned.y !== 'number') return element;
  return { ...positioned, x: positioned.x + dx, y: positioned.y + dy };
};

/** 只比较拖动位移是否为零，供"零位移也要走父级解析"的提交路径复用。 */
export const isZeroDragOffset = (offset: { x: number; y: number }): boolean =>
  offset.x === 0 && offset.y === 0;

/**
 * 拖动预览：只替换会话内的元素，其余保持原引用。
 *
 * 引用相等是这里的性能契约——`CanvasElement` 的 memo 只比较 `element` 引用，
 * 于是拖动 N 个元素就只重绘 N 个，而不是"可见元素全体"。也因此零位移必须返回同一引用。
 */
export const applyDragPreview = <T extends Element>(
  elements: T[],
  elementIds: ReadonlySet<string> | null,
  offset: { x: number; y: number },
): T[] => {
  if (!elementIds || elementIds.size === 0) return elements;
  if (isZeroDragOffset(offset)) return elements;
  return elements.map(element => (
    elementIds.has(element.id) ? (applyDragOffset(element, offset.x, offset.y) as T) : element
  ));
};
