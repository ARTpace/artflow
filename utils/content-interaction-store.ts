/**
 * content-interaction-store.ts —— "内容正在被变换"的瞬时通道（P0-1）。
 *
 * 背景：图片降档原先只看"鼠标有没有按下"（isInteracting）。按下即把**整板**图片降到
 * standard 代理档 —— 拖一个小元素、涂鸦、擦除时，满屏高清图全部换 href，松手又集中
 * 换回来。用户看到的是"整屏糊掉再清晰"，一次手势的代价与"整个工作区"成正比，
 * 而不是与"真正被改动的元素"成正比。
 *
 * 分工：真正需要降档的只有**正在被变换的那几个元素**。
 * - 会话内：只有内容真的开始变了（位移跨过可见阈值、缩放/旋转改了尺寸）才登记 id，
 *   登记集合里的元素按代理档渲染，其余元素维持自己的档位。
 * - 会话外（松手 / 取消 / 切画板）：一律清空，元素各自回到应有的档位。
 *
 * 与 drag-session-store 的区别：那边描述"位移了多少"（只服务拖动呈现），
 * 这边只声明"谁正在变"（只服务渲染降档）。缩放与旋转没有位移，却同样要降档 ——
 * 所以是两条通道，只是生命周期对齐（同起同落），故共用 DRAG_MOVED_MIN_SCREEN_PX 这个阈值。
 */
import { useCallback, useSyncExternalStore } from 'react';

/** 只做窄化的订阅快照：订阅者拿到 id 集合即可，无需知道会话起止。 */
export type ContentInteractionIds = ReadonlySet<string> | null;

/** 没有内容变换时的稳定快照。必须是模块级常量：useSyncExternalStore 会比较引用。 */
export const NO_CONTENT_INTERACTION: ContentInteractionIds = null;

export interface ContentInteractionStore {
  /** React 渲染用快照。内容不变时返回同一引用（Object.is 等价）。 */
  getSnapshot(): ContentInteractionIds;
  subscribe(listener: () => void): () => void;
  isActive(): boolean;
  /**
   * 声明"当前正在被变换的就是这些元素"。**替换语义**，不是并集。
   *
   * 热路径上每帧都会调用它，所以：
   * - 同一批 id 重复调用**刻意不通知**订阅者 —— 通知一次等于整板图片重算一次档位；
   * - 空集合等价于 end()，避免"会话还活着但没人被变换"这种中间态，
   *   否则纯点击（mousedown 未移动）会让整板降档。
   */
  begin(elementIds: Iterable<string>): void;
  /** 会话结束：元素回到各自档位。 */
  end(): void;
  dispose(): void;
}

const isSameIdSet = (current: ReadonlySet<string> | null, next: ReadonlySet<string>): boolean => {
  if (current === null || current.size !== next.size) return false;
  for (const id of next) {
    if (!current.has(id)) return false;
  }
  return true;
};

export const createContentInteractionStore = (): ContentInteractionStore => {
  let elementIds: ReadonlySet<string> | null = null;
  let snapshot: ContentInteractionIds = NO_CONTENT_INTERACTION;
  const listeners = new Set<() => void>();

  const publish = () => {
    const next: ContentInteractionIds = elementIds === null || elementIds.size === 0 ? null : elementIds;
    if (snapshot === next) return;
    snapshot = next;
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
    isActive: () => elementIds !== null && elementIds.size > 0,
    begin: ids => {
      const next = new Set(ids);
      if (isSameIdSet(elementIds, next)) return;
      elementIds = next;
      publish();
    },
    end: () => {
      if (elementIds === null) return;
      elementIds = null;
      publish();
    },
    dispose: () => {
      elementIds = null;
      snapshot = NO_CONTENT_INTERACTION;
      listeners.clear();
    },
  };
};

const subscribeNoop = () => () => {};

/**
 * 内容变换集合订阅：MainCanvas 用它按元素决定"这张图要不要走代理档"。
 * store 缺省时返回 null，调用方据此回落到旧的"手势中全板降档"行为。
 */
export const useContentInteractingIds = (
  store: ContentInteractionStore | undefined,
): ContentInteractionIds => {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : subscribeNoop()),
    [store],
  );
  const getSnapshot = useCallback(
    () => (store ? store.getSnapshot() : NO_CONTENT_INTERACTION),
    [store],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
