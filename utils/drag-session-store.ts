/**
 * drag-session-store.ts —— 元素拖动会话的瞬时通道（P1-B）。
 *
 * 背景：拖动元素原先每帧 `setElements`。写 elements 等于写 Board，也就是写文档状态：
 * App 整棵树重算、viewport 索引每帧重建、侧栏与工具条跟着重绘、项目每帧被标脏。
 * 代价与"整个工作区"成正比，而不是与"拖动了多远"成正比。
 *
 * 分工：
 * - 会话内（begin → end）：位移与对齐参考线只存在这里，只通知订阅者（MainCanvas）。
 *   文档状态一个字节都不动。
 * - 会话结束（end）：调用方拿最终位移**一次性**写 elements（一次撤销记录、一次父级解析）。
 *
 * 这里刻意不持有 elements：本模块不知道元素长什么样，只知道"哪些 id 位移多少"。
 * 呈现由 `applyDragOffset` 负责，保证预览与提交同一份几何。
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Guide, Point } from '../types';

export interface CanvasDragSessionSnapshot {
  /** 拖动中的元素 id（含其可拖动后代）；无会话时为 null。 */
  readonly elementIds: ReadonlySet<string> | null;
  /** 相对拖动起点的画布坐标位移。 */
  readonly offset: Point;
  /** 拖动中的对齐参考线（仅会话内非空）。 */
  readonly guides: readonly Guide[];
}

/** 没有拖动会话时的稳定快照。必须是模块级常量：useSyncExternalStore 会比较引用。 */
export const NO_DRAG_SESSION: CanvasDragSessionSnapshot = {
  elementIds: null,
  offset: { x: 0, y: 0 },
  guides: [],
};

/**
 * 位移小于这个**屏幕**像素数仍按"按下未移动"处理。
 * 用途：普通点选（mousedown 与 mouseup 之间手抖一两个像素）不应该让选区周边的
 * 控件闪一下。用屏幕像素而不是画布坐标：缩放到 10% 时 2 画布像素只有 0.2 屏幕像素。
 */
export const DRAG_MOVED_MIN_SCREEN_PX = 2;

/**
 * 元素是否"真的被拖起来了"：会话已开始 **且** 位移在屏幕坐标下已经可见。
 * 拖动中隐藏选区周边控件（选区工具条、缩放手柄、智能工具条）靠这个判据；
 * 单看 `isActive()` 会在 mousedown 瞬间就隐藏，纯点击时控件一闪而过。
 */
export const hasElementDragMoved = (
  session: CanvasDragSessionSnapshot,
  zoom: number,
): boolean => {
  if (session.elementIds === null) return false;
  const { x, y } = session.offset;
  return Math.hypot(x, y) * zoom >= DRAG_MOVED_MIN_SCREEN_PX;
};

export interface CanvasDragSession {
  readonly elementIds: ReadonlySet<string>;
  readonly offset: Point;
}

export interface CanvasDragSessionStore {
  /** React 渲染用快照。数值不变时返回同一引用。 */
  getSnapshot(): CanvasDragSessionSnapshot;
  subscribe(listener: () => void): () => void;
  isActive(): boolean;
  /**
   * 建立拖动会话。**刻意不通知订阅者**：会话起点的位移是 0，
   * 等于静态呈现，此时通知只会让 MainCanvas 在 mousedown 瞬间白重绘一次。
   */
  begin(elementIds: Iterable<string>): void;
  /** 逐帧写入位移；未 begin 时自动 begin。不触发任何文档写入。 */
  setOffset(offset: Point): void;
  /** 写入对齐参考线，内容不变时不通知。 */
  setGuides(guides: readonly Guide[]): void;
  /**
   * 结束会话并复位预览；返回最终位移供调用方一次性提交。
   * 零位移也会返回会话——点一下落在 Frame 内的元素需要走父级解析，这是既有行为。
   */
  end(): CanvasDragSession | null;
  /** 放弃会话：只复位预览，不产生任何待提交值。 */
  cancel(): void;
  dispose(): void;
}

const sameGuide = (a: Guide, b: Guide): boolean => (
  a.type === b.type && a.position === b.position && a.start === b.start && a.end === b.end
);

const sameGuideList = (a: readonly Guide[], b: readonly Guide[]): boolean => (
  a.length === b.length && a.every((guide, index) => sameGuide(guide, b[index]))
);

export const createCanvasDragSessionStore = (): CanvasDragSessionStore => {
  let elementIds: ReadonlySet<string> | null = null;
  let offset: Point = { x: 0, y: 0 };
  let guides: readonly Guide[] = NO_DRAG_SESSION.guides;
  let snapshot: CanvasDragSessionSnapshot = NO_DRAG_SESSION;
  const listeners = new Set<() => void>();

  const publish = () => {
    // 无位移目标、无参考线才算"彻底空闲"；参考线可以脱离拖动会话单独存在。
    if (elementIds === null && guides.length === 0) {
      if (snapshot === NO_DRAG_SESSION) return;
      snapshot = NO_DRAG_SESSION;
    } else {
      if (
        snapshot.elementIds === elementIds
        && snapshot.offset.x === offset.x
        && snapshot.offset.y === offset.y
        && snapshot.guides === guides
      ) {
        return;
      }
      snapshot = { elementIds, offset, guides };
    }
    for (const listener of Array.from(listeners)) listener();
  };

  const reset = () => {
    elementIds = null;
    offset = { x: 0, y: 0 };
    guides = NO_DRAG_SESSION.guides;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isActive: () => elementIds !== null,
    begin: ids => {
      reset();
      // 会话期间 id 集合必须保持引用稳定：订阅者把它当依赖项，每次重建会让裁剪白重算。
      elementIds = new Set(ids);
    },
    setOffset: next => {
      if (elementIds === null) elementIds = new Set();
      if (offset.x === next.x && offset.y === next.y) return;
      offset = { x: next.x, y: next.y };
      publish();
    },
    setGuides: next => {
      if (sameGuideList(guides, next)) return;
      guides = next.length === 0 ? NO_DRAG_SESSION.guides : next.map(guide => ({ ...guide }));
      publish();
    },
    end: () => {
      if (elementIds === null) return null;
      const session: CanvasDragSession = {
        elementIds,
        offset: { x: offset.x, y: offset.y },
      };
      reset();
      publish();
      return session;
    },
    cancel: () => {
      if (elementIds === null) return;
      reset();
      publish();
    },
    dispose: () => {
      reset();
      snapshot = NO_DRAG_SESSION;
      listeners.clear();
    },
  };
};

const subscribeNoop = () => () => {};

/**
 * 拖动会话订阅：MainCanvas 用它拿"要位移哪些元素、位移多少、参考线画在哪"。
 * store 缺省时返回稳定空快照（向后兼容无 store 的旧路径）。
 */
export const useCanvasDragSessionSnapshot = (
  store: CanvasDragSessionStore | undefined,
): CanvasDragSessionSnapshot => {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : subscribeNoop()),
    [store],
  );
  const getSnapshot = useCallback(() => (store ? store.getSnapshot() : NO_DRAG_SESSION), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * `hasElementDragMoved` 的订阅版本：拖动中隐藏周边控件的组件用它。
 *
 * 刻意只返回 boolean——useSyncExternalStore 用 Object.is 比较返回值，拖动期间
 * 每帧的位移发布不会引起重渲染（整段拖动只有 false→true、true→false 各一次）。
 * 直接订阅快照对象的话，App 会跟着每一帧位移重绘，与通道"只让 MainCanvas 重绘"的
 * 分工相悖。
 */
export const useElementDragMoved = (
  store: CanvasDragSessionStore | undefined,
  zoom: number,
): boolean => {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : subscribeNoop()),
    [store],
  );
  const getSnapshot = useCallback(
    () => hasElementDragMoved(store ? store.getSnapshot() : NO_DRAG_SESSION, zoom),
    [store, zoom],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
