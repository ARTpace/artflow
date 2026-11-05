/**
 * selection-preview-store.ts —— 框选/套索"将被选中"高亮的瞬时通道（P0-3）。
 *
 * 背景：框选/套索原先只在 mouseup 结算一次命中，拖动过程中用户看不到"会选中谁"。
 * 最直觉的补法是每帧把命中结果 setSelectedElementIds —— 但那是**文档级**状态：
 * App 整棵树每帧重算、侧栏与工具条跟着重绘、图片按选中态反复换档。
 * 逐帧 setState 会把手势代价从"框了多大范围"抬成"整个工作区"。
 *
 * 分工：预览只写通道，通道只通知一个 DOM 订阅者（components/SelectionPreviewOverlay），
 * 由它直接改 SVG 属性。这条链路上 React 一次都不渲染：
 * - 发布者：useCanvasInteractions 在合并后的指针帧里发一份"命中了谁、是加还是减"；
 * - 订阅者：SelectionPreviewOverlay 按快照增量写 <rect> 的几何与配色。
 *
 * 内容不变刻意不发布：同一份命中结果重复发只会白写一遍 DOM。
 * 预览**只呈现**，不参与命中与布局（pointer-events: none），也不需要被别的组件读到，
 * 所以它没有"被读回去"的接口 —— 真正的选区仍然只由 mouseup 的结算写入。
 */
export interface SelectionPreviewItem {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 预览配色语义：加选沿用框选本身的强调色，减选换红色。
 * 用户按着 Alt 拖框时不需要先松手就能看出"这一框是在做减选"。
 */
export type SelectionPreviewMode = 'add' | 'subtract';

export interface SelectionPreviewSnapshot {
  readonly mode: SelectionPreviewMode;
  readonly items: readonly SelectionPreviewItem[];
}

/** 没有预览时的稳定快照。必须是模块级常量：订阅者会拿它跳过整轮重绘。 */
export const NO_SELECTION_PREVIEW: SelectionPreviewSnapshot = { mode: 'add', items: [] };

export interface SelectionPreviewStore {
  getSnapshot(): SelectionPreviewSnapshot;
  subscribe(listener: () => void): () => void;
  isActive(): boolean;
  /** 发布一份命中预览。items 为空即"这一帧什么都不该高亮"。 */
  publish(mode: SelectionPreviewMode, items: readonly SelectionPreviewItem[]): void;
  /** 手势结束（结算后 / 取消后）清空预览。 */
  clear(): void;
  dispose(): void;
}

const isSameItems = (
  current: readonly SelectionPreviewItem[],
  next: readonly SelectionPreviewItem[],
): boolean => (
  current.length === next.length
  && current.every((item, index) => {
    const other = next[index];
    return item.id === other.id
      && item.x === other.x
      && item.y === other.y
      && item.width === other.width
      && item.height === other.height;
  })
);

export const createSelectionPreviewStore = (): SelectionPreviewStore => {
  let snapshot: SelectionPreviewSnapshot = NO_SELECTION_PREVIEW;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isActive: () => snapshot.items.length > 0,
    publish: (mode, items) => {
      if (items.length === 0) {
        if (snapshot === NO_SELECTION_PREVIEW) return;
        snapshot = NO_SELECTION_PREVIEW;
        notify();
        return;
      }
      // 命中集合与配色都没变：不要再写一遍 DOM，也不要惊动订阅者。
      if (snapshot.mode === mode && isSameItems(snapshot.items, items)) return;
      snapshot = {
        mode,
        items: items.map(item => ({
          id: item.id,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
        })),
      };
      notify();
    },
    clear: () => {
      if (snapshot === NO_SELECTION_PREVIEW) return;
      snapshot = NO_SELECTION_PREVIEW;
      notify();
    },
    dispose: () => {
      snapshot = NO_SELECTION_PREVIEW;
      listeners.clear();
    },
  };
};
