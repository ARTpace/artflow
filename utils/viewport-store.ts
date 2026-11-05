/**
 * viewport-store.ts —— 画布相机（pan/zoom）的瞬时通道。
 *
 * 背景：Board 是文档状态，每次写入都会让 App 整棵树重绘。平移/缩放是每帧都在变的
 * 视图状态，如果继续逐帧写 Board，代价与"整个工作区"成正比，而不是与"移动了多远"成正比。
 *
 * 分工（和 ADR-021 的 camera-only 语义一致）：
 * - live：手势中的真实相机值，只通知 subscribeLive 的即时消费者（<g> transform、导航器小地图）。
 * - renderState：React 渲染用的相机值，手势中按 renderThrottleMs 节流发布，
 *   只驱动裁剪/LOD/叠加层这类需要重绘的东西。
 * - document(committed)：已提交到 Board 的值。手势结束（或 flush）时只写一次。
 *
 * 本模块不持有持久化、不碰 Board、不做撤销记录；写入动作由调用方的 onCommit 决定。
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Point } from '../types';

export interface CanvasViewport {
  panOffset: Point;
  zoom: number;
}

export interface CanvasViewportRenderState extends CanvasViewport {
  /** 是否处于未提交的手势中（裁剪需要额外 overscan，用于避免快速平移露出空白）。 */
  transient: boolean;
}

/**
 * 手势中 React 渲染通道的发布策略。
 * 只影响裁剪/LOD/叠加层的跟随速度，不影响 transform 的流畅度（那是 live 通道，每帧都到）。
 *
 * 为什么是"位移阈值 + 缩放阈值 + 时间上限"而不是固定间隔：
 * - 裁剪滞后会在快速**平移**时露出未挂载的空白带，所以位移超过 RENDER_PUBLISH_MOVE_PX 必须立刻发布；
 *   （该判据只在 zoom 不变时生效——缩放的 pan 联动不是新内容，见 scheduleRender 注释）
 * - 慢速平移/小幅缩放不该逐帧重算裁剪，所以低于阈值时按时间上限兜底；
 * - 节流下限保证任何情况下都不会退化成逐帧渲染。
 */
export const RENDER_PUBLISH_MOVE_PX = 120;
/**
 * 缩放方向不同，代价不同：
 * - **缩小**：可见的世界范围变大，裁剪滞后就会在边缘露出还没挂载的空白带，必须敏感；
 * - **放大**：可见集只会变小（多挂着的卡片不产生视觉问题），迟钝发布可以省下大量裁剪重算。
 * 方向感知让"连续放大"这条最常见的手势几乎不碰 React 渲染树。
 */
/**
 * 缩小方向的发布阈值：可见世界半径的富余（overscan）兜不住之前必须更新挂载集。
 *
 * overscan 富余 ≈ 26%（RENDER_PUBLISH_MOVE_PX × 1.6 ÷ 屏幕半径 720）——两次发布之间
 * 可见半径最多扩大这么多。平滑追随在时间兜底（100ms）内会完成接近一整格（20%）的
 * 缩小，所以阈值必须 ≥ 一格的可见半径扩大比例（25% 的 80%≈20%……取 22%：既保证
 * 一格缩放不会顶着 40ms 下限逐帧发布，又让 overscan 有余量）。6% 的旧值会让缩小
 * 手势每 40ms 顶格发布一次（25 次/秒），每次发布都是一次 150 张卡的全量 React 提交。
 */
export const RENDER_PUBLISH_ZOOM_SHRINK_RATIO = 0.22;
export const RENDER_PUBLISH_ZOOM_GROW_RATIO = 0.3;
export const RENDER_PUBLISH_MAX_MS = 100;
/** 放大方向的时间上限不低于此值：连续放大时不该每 100ms 重算一轮裁剪。 */
export const RENDER_PUBLISH_GROW_MAX_MS = 250;
export const RENDER_PUBLISH_MIN_MS = 40;
/**
 * 缩放手势专用的发布下限。
 *
 * 为什么不能用 RENDER_PUBLISH_MIN_MS 管缩放：平滑追随在 40ms 内就能完成一格变化量的
 * ~64%，任何低于该值的比例阈值都会顶着 40ms 下限顶格发布（实测 14-25 次/秒，每次发布
 * 都是一次 150 张卡的全量 React 提交 = "图片一多滚动缩放就卡"的主因，2026-09-24 trace）。
 * 比例阈值管不住连续缩放，能管住频率的只有时间下限本身。
 *
 * 取 250ms（≈4 次/秒，与放大方向的"时间上限"设计一致）：两次发布之间平滑追随已跑完
 * 接近一整格（99%+），缩小时可见半径最多扩大 25%，由 overscan 富余（26.7%）兜住露白。
 */
export const RENDER_PUBLISH_ZOOM_MIN_MS = 250;

/**
 * 滚轮缩放的平滑追随（PureRef 式手感）。
 *
 * 滚轮事件在 Windows 上是离散的（一格一个事件），直接把每个事件写成相机值，
 * 视觉上就是"跳 → 停 → 跳"；每帧向目标逼近则把离散输入变成连续运动。
 * 收敛用指数逼近而非固定时长，因此连续滚动时表现为一阶低通（滑顺跟随），
 * 停止滚动后自动收敛并停掉 rAF。
 */
export const SMOOTH_FOLLOW_FACTOR = 0.45;
export const SMOOTH_SETTLE_ZOOM_RATIO = 0.004;
export const SMOOTH_SETTLE_PAN_PX = 0.4;

export interface CreateCanvasViewportStoreOptions {
  initial: CanvasViewport;
  /** 手势结束/显式 flush 时调用一次；调用方负责写文档状态。 */
  onCommit: (next: CanvasViewport) => void;
  /** 手势中两次渲染发布之间的时间上限（毫秒）。 */
  renderThrottleMs?: number;
}

export interface CanvasViewportStore {
  /** 当前真实相机值；手势中每帧变化。对象引用只在数值变化时替换。 */
  getLive(): CanvasViewport;
  /** React 渲染用相机值（节流后）。引用稳定，可直接给 useSyncExternalStore。 */
  getRenderState(): CanvasViewportRenderState;
  isTransient(): boolean;
  subscribeLive(listener: () => void): () => void;
  subscribeRender(listener: () => void): () => void;
  /** 进入瞬时手势。重复调用是幂等的。 */
  beginInteraction(): void;
  /** 逐帧写入瞬时相机值；未 begin 时自动 begin。不触发文档写入。 */
  setTransient(next: CanvasViewport): void;
  /**
   * 缩放（或其它需要平滑的相机动作）的目标值，**累积基准**。
   *
   * 连续滚轮必须基于目标而不是 live 累积：平滑追随期间 live 只走了一部分，
   * 若拿 live 当基准，滚得越快反而缩放越慢（每格的增量被追随进度吃掉）。
   * 非平滑状态下它与 live 同值。
   */
  getTarget(): CanvasViewport;
  /**
   * 设平滑目标：live 每帧向目标指数逼近，收敛后自动停掉 rAF。
   * 用于滚轮缩放（离散输入 → 连续运动）；平移等需要 1:1 跟手的场景仍走 setTransient。
   */
  setSmoothTarget(next: CanvasViewport): void;
  /** 结束手势：提交一次到文档，并立即发布最终渲染态。 */
  endInteraction(): void;
  /** 只提交（不改变手势标记）：用于保存前/卸载前把相机落盘。 */
  flush(): void;
  /** 文档侧相机变化（书签恢复、Fit、载入项目）时校准 store。手势中忽略，避免覆盖未提交值。 */
  syncDocument(next: CanvasViewport): void;
  dispose(): void;
}

export const sameCanvasViewport = (a: CanvasViewport, b: CanvasViewport): boolean =>
  a.zoom === b.zoom && a.panOffset.x === b.panOffset.x && a.panOffset.y === b.panOffset.y;

export const cloneCanvasViewport = (viewport: CanvasViewport): CanvasViewport => ({
  panOffset: { x: viewport.panOffset.x, y: viewport.panOffset.y },
  zoom: viewport.zoom,
});

// SSR/Node（自检脚本会直接 require 本模块）下不依赖 window。
const scheduleTimeout = (callback: () => void, ms: number): number =>
  typeof window === 'undefined'
    ? (setTimeout(callback, ms) as unknown as number)
    : window.setTimeout(callback, ms);

const cancelTimeout = (handle: number): void => {
  if (typeof window === 'undefined') clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  else window.clearTimeout(handle);
};

const scheduleFrame = (callback: () => void): number => {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return setTimeout(callback, 16) as unknown as number;
  }
  return window.requestAnimationFrame(callback);
};

const cancelFrame = (handle: number): void => {
  if (typeof window === 'undefined' || typeof window.cancelAnimationFrame !== 'function') {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    return;
  }
  window.cancelAnimationFrame(handle);
};

export const createCanvasViewportStore = ({
  initial,
  onCommit,
  renderThrottleMs = RENDER_PUBLISH_MAX_MS,
}: CreateCanvasViewportStoreOptions): CanvasViewportStore => {
  const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

  let live: CanvasViewport = cloneCanvasViewport(initial);
  /** 最后一次交给 onCommit 的值，用于避免"提交后又提交同一个值"。 */
  let committed: CanvasViewport = cloneCanvasViewport(initial);
  let transient = false;
  let renderState: CanvasViewportRenderState = {
    panOffset: live.panOffset,
    zoom: live.zoom,
    transient: false,
  };

  let renderTimer: number | null = null;
  let liveFrame: number | null = null;
  let smoothFrame: number | null = null;
  /** 平滑追随的目标值；空闲时与 live 同值（由 setTransient/syncDocument 对齐）。 */
  let target: CanvasViewport = cloneCanvasViewport(initial);
  // 以创建时刻为基准，避免第一次采样就被"时间上限"当成早就该发布了。
  let lastRenderPublishAt = now();
  const liveListeners = new Set<() => void>();
  const renderListeners = new Set<() => void>();

  const notify = (listeners: Set<() => void>) => {
    for (const listener of Array.from(listeners)) listener();
  };

  /** 立即发布渲染态（数值与标记都没变时保持引用不变，避免无谓重绘）。 */
  const publishRender = () => {
    if (renderTimer !== null) {
      cancelTimeout(renderTimer);
      renderTimer = null;
    }
    lastRenderPublishAt = now();
    if (
      renderState.zoom === live.zoom
      && renderState.transient === transient
      && renderState.panOffset.x === live.panOffset.x
      && renderState.panOffset.y === live.panOffset.y
    ) {
      return;
    }
    renderState = { panOffset: live.panOffset, zoom: live.zoom, transient };
    notify(renderListeners);
  };

  const armRenderTimer = (delayMs: number) => {
    if (renderTimer !== null) return;
    renderTimer = scheduleTimeout(() => {
      renderTimer = null;
      publishRender();
    }, Math.max(1, delayMs));
  };

  /** 手势中按"位移/缩放阈值优先，时间上限兜底，节流下限防抖"发布渲染态。 */
  const scheduleRender = () => {
    if (!transient) {
      publishRender();
      return;
    }
    const elapsed = now() - lastRenderPublishAt;
    // 缩放手势（live.zoom 已偏离基准）用专用下限；平移保持 40ms 的低延迟。
    const zooming = live.zoom !== renderState.zoom;
    const minMs = zooming ? RENDER_PUBLISH_ZOOM_MIN_MS : RENDER_PUBLISH_MIN_MS;
    if (elapsed < minMs) {
      armRenderTimer(minMs - elapsed);
      return;
    }
    // 位移判据**只在平移（zoom 不变）时生效**。
    //
    // 语义是"视口看到了新内容"（裁剪滞后的露白风险）。滚轮缩放围绕视口中心缩放时
    // pan 会随之联动变化（zoom=2 时一格 ×1.25 的 Δpan≈280px），那批内容只是换了
    // 比例、并没有平移进来 —— 若把它算进"位移"，每格缩放都会立即发布（实测 14 次/秒，
    // 设计值 4 次/秒），每次发布都迫使 MainCanvas/CanvasNavigator 做全量 React 重渲
    // （150 张卡 ≈ 15-18ms 提交），这就是"图片一多、滚动缩放就卡"的主因（2026-09-24 trace）。
    // 缩放期间可见范围的变化改由下面的 zoom 比例阈值 + 时间兜底管辖。
    const zoomUnchanged = live.zoom === renderState.zoom;
    const movedEnough = zoomUnchanged && (
      Math.abs(live.panOffset.x - renderState.panOffset.x) >= RENDER_PUBLISH_MOVE_PX
      || Math.abs(live.panOffset.y - renderState.panOffset.y) >= RENDER_PUBLISH_MOVE_PX
    );
    // 方向感知：缩小必须敏感（可见世界范围在变大，滞后就露白），放大可以迟钝。
    const shrinking = live.zoom < renderState.zoom;
    const zoomRatio = renderState.zoom === 0 ? 1 : Math.abs(live.zoom - renderState.zoom) / renderState.zoom;
    const zoomThreshold = shrinking ? RENDER_PUBLISH_ZOOM_SHRINK_RATIO : RENDER_PUBLISH_ZOOM_GROW_RATIO;
    if (movedEnough || zoomRatio >= zoomThreshold) {
      publishRender();
      return;
    }
    const maxMs = shrinking ? renderThrottleMs : Math.max(renderThrottleMs, RENDER_PUBLISH_GROW_MAX_MS);
    armRenderTimer(maxMs - elapsed);
  };

  const scheduleLive = () => {
    if (liveFrame !== null) return;
    liveFrame = scheduleFrame(() => {
      liveFrame = null;
      notify(liveListeners);
    });
  };

  /** 停掉平滑追随；alignToTarget 时把 live 直接对齐目标（手势被打断/收尾用，避免提交中间值）。 */
  const stopSmooth = (alignToTarget: boolean) => {
    if (smoothFrame !== null) {
      cancelFrame(smoothFrame);
      smoothFrame = null;
    }
    if (!alignToTarget || sameCanvasViewport(live, target)) return;
    live = cloneCanvasViewport(target);
    scheduleLive();
    scheduleRender();
  };

  /**
   * 平滑追随的一帧：live 向 target 指数逼近。
   *
   * zoom 与 panOffset 用同一个系数一起插值，锚点是精确的 —— pan 是 zoom 的仿射函数
   * （`pan(z) = m - (m - p0) * z / z0`），两份插值走同一条时间曲线时，中间态恰好落在
   * 对应的理想 pan 上。所以"鼠标下的点不动"这个约束在追随期间也成立，不会漂移。
   */
  const stepSmooth = () => {
    smoothFrame = null;
    const nextZoom = live.zoom + (target.zoom - live.zoom) * SMOOTH_FOLLOW_FACTOR;
    const nextPanX = live.panOffset.x + (target.panOffset.x - live.panOffset.x) * SMOOTH_FOLLOW_FACTOR;
    const nextPanY = live.panOffset.y + (target.panOffset.y - live.panOffset.y) * SMOOTH_FOLLOW_FACTOR;
    const settled = Math.abs(target.zoom - nextZoom) <= Math.abs(target.zoom) * SMOOTH_SETTLE_ZOOM_RATIO
      && Math.abs(target.panOffset.x - nextPanX) <= SMOOTH_SETTLE_PAN_PX
      && Math.abs(target.panOffset.y - nextPanY) <= SMOOTH_SETTLE_PAN_PX;
    live = settled ? cloneCanvasViewport(target) : { panOffset: { x: nextPanX, y: nextPanY }, zoom: nextZoom };
    scheduleLive();
    // 收敛只代表"追随到位"，**不代表手势结束** —— 这里刻意不复位 transient。
    //
    // 滚轮手势由 useCanvasInteractions 的空闲定时器（WHEEL_GESTURE_IDLE_MS = 200ms）
    // 收尾，那才是真正的结束点（endInteraction → 提交 + 复位标记 + 发布渲染态）。
    // 曾经在这里顺手复位过，结果是：本该 200ms 才发生的收尾被提前到收敛的那一刻，
    // 而 transient 每翻转一次，裁剪 overscan 与 LOD 档位都会跟着跳变一次 ——
    // 表现为"还没停手就抖一下"。状态收尾只在一处做，不要在这里抢。
    scheduleRender();
    if (!settled) smoothFrame = scheduleFrame(stepSmooth);
  };

  const commit = () => {
    if (sameCanvasViewport(live, committed)) return;
    committed = cloneCanvasViewport(live);
    onCommit(committed);
  };

  return {
    getLive: () => live,
    getRenderState: () => renderState,
    isTransient: () => transient,
    subscribeLive: listener => {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    subscribeRender: listener => {
      renderListeners.add(listener);
      return () => {
        renderListeners.delete(listener);
      };
    },
    beginInteraction: () => {
      if (transient) return;
      transient = true;
      // 刻意不在这里发布渲染态：手势起点没有位移，发布只会让裁剪白算一轮并多挂载一圈卡片
      // （那正好是 mousedown 瞬间最不该出现的卡顿）。transient 标记会随第一次移动的发布一起生效。
    },
    getTarget: () => target,
    setTransient: next => {
      // 平移/绘制这类 1:1 跟手通道：接管平滑追随，避免两套写入互相拉扯。
      stopSmooth(false);
      const changed = !sameCanvasViewport(next, live);
      if (changed) live = cloneCanvasViewport(next);
      // 目标必须跟着走，否则之后第一次滚轮会从过期的目标值起算。
      target = cloneCanvasViewport(live);
      if (!transient) transient = true; // 未显式 begin 也自动进入手势；仅当数值变化才需要发布
      if (!changed) return;
      scheduleLive();
      scheduleRender();
    },
    setSmoothTarget: next => {
      target = cloneCanvasViewport(next);
      if (!transient) transient = true;
      if (smoothFrame === null) smoothFrame = scheduleFrame(stepSmooth);
    },
    endInteraction: () => {
      // 还在追随中就对齐目标：提交的必须是用户滚到的最终相机，而不是中途某一帧。
      stopSmooth(true);
      transient = false;
      commit();
      publishRender();
    },
    flush: () => {
      stopSmooth(true);
      commit();
      publishRender();
    },
    syncDocument: next => {
      if (transient) return;
      stopSmooth(false);
      committed = cloneCanvasViewport(next);
      if (sameCanvasViewport(next, live)) {
        target = cloneCanvasViewport(live);
        return;
      }
      live = cloneCanvasViewport(next);
      target = cloneCanvasViewport(live);
      publishRender();
      scheduleLive();
    },
    dispose: () => {
      if (smoothFrame !== null) {
        cancelFrame(smoothFrame);
        smoothFrame = null;
      }
      if (renderTimer !== null) {
        cancelTimeout(renderTimer);
        renderTimer = null;
      }
      if (liveFrame !== null) {
        cancelFrame(liveFrame);
        liveFrame = null;
      }
      liveListeners.clear();
      renderListeners.clear();
    },
  };
};

const subscribeNoop = () => () => {};

/**
 * 渲染通道订阅：MainCanvas 用它拿裁剪/LOD/叠加层需要的相机值。
 * `fallback` 必须是稳定引用（调用方 useMemo），否则 useSyncExternalStore 会自激。
 */
export const useCanvasViewportRenderState = (
  store: CanvasViewportStore | undefined,
  fallback: CanvasViewportRenderState,
): CanvasViewportRenderState => {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribeRender(listener) : subscribeNoop()),
    [store],
  );
  const getSnapshot = useCallback(() => (store ? store.getRenderState() : fallback), [store, fallback]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/** 即时通道订阅：导航器小地图这类"每帧都要跟手"的消费者用。 */
export const useCanvasViewportLiveState = (
  store: CanvasViewportStore | undefined,
  fallback: CanvasViewport,
): CanvasViewport => {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribeLive(listener) : subscribeNoop()),
    [store],
  );
  const getSnapshot = useCallback(() => (store ? store.getLive() : fallback), [store, fallback]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
