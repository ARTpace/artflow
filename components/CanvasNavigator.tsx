import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Element as CanvasElement, Point, Rect } from '../types';
import {
  centerCanvasPointInViewport,
  createCanvasNavigatorModel,
  createNavigatorProjection,
  fitCanvasViewport,
  getCanvasWorldViewport,
  projectNavigatorRect,
  unprojectNavigatorPoint,
  unionCanvasRects,
  type CanvasViewportSize,
} from '../utils/canvasNavigator';
import {
  useCanvasViewportRenderState,
  type CanvasViewportStore,
} from '../utils/viewport-store';
import { useTranslation } from '../utils/language-store';
import type { Kernel } from '../plugin-runtime/kernel';
import { PLUGIN_PROFILE_MANAGER_SERVICE } from '../plugin-runtime/plugin-profile-manager';

const NAVIGATOR_SIZE = { width: 240, height: 160 };
/** 面板默认不透明度；可在「插件与扩展 → 工作台面板包」详情里调 navigatorOpacity。 */
const NAVIGATOR_DEFAULT_OPACITY = 0.65;
const NAVIGATOR_PLUGIN_ID = 'builtin.workspace-panels';

const clampNavigatorOpacity = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return NAVIGATOR_DEFAULT_OPACITY;
  return Math.min(1, Math.max(0.05, numeric));
};

interface CanvasNavigatorProps {
  kernel: Kernel;
  svgRef: React.RefObject<SVGSVGElement>;
  elements: readonly CanvasElement[];
  selectedElementIds: readonly string[];
  panOffset: Point;
  zoom: number;
  viewBookmarkCount: number;
  onOpenFinder: () => void;
  onOpenViews: () => void;
  onViewportChange: (next: { panOffset: Point; zoom: number }) => void;
  /**
   * 相机瞬时通道：存在时小地图直接跟随主画布的 live 相机（含未提交的手势），
   * 不必等 App 因为相机提交而重绘。
   */
  viewportStore?: CanvasViewportStore;
}

/**
 * R20 local camera overview —— 极简形态：只有边框与画布内容。
 * 动作（查找/视图/适应）悬浮在地图角落、悬停才出现；操作提示收进面板 tooltip。
 * 相机更新沿用 renderer 单一真相：经 viewportStore 写入并在手势收尾时提交。
 */
export const CanvasNavigator: React.FC<CanvasNavigatorProps> = ({
  kernel,
  svgRef,
  elements,
  selectedElementIds,
  panOffset,
  zoom,
  viewBookmarkCount,
  onOpenFinder,
  onOpenViews,
  onViewportChange,
  viewportStore,
}) => {
  const { t } = useTranslation();
  // 面板透明度 = 插件参数（插件详情里的 navigatorOpacity），改动经 plugin:config-changed 即时生效。
  const profileManager = kernel.has(PLUGIN_PROFILE_MANAGER_SERVICE)
    ? kernel.use(PLUGIN_PROFILE_MANAGER_SERVICE)
    : null;
  const readSurfaceOpacity = (): number => {
    if (!profileManager) return NAVIGATOR_DEFAULT_OPACITY;
    const plugin = profileManager.getSnapshot().pendingProfile.plugins.find(entry => entry.id === NAVIGATOR_PLUGIN_ID);
    return clampNavigatorOpacity(plugin?.config?.navigatorOpacity);
  };
  const [surfaceOpacity, setSurfaceOpacity] = useState(readSurfaceOpacity);
  useEffect(() => {
    if (!profileManager) return;
    return kernel.on('plugin:config-changed', payload => {
      const data = payload as { id?: string; key?: string; value?: unknown };
      if (data?.id !== NAVIGATOR_PLUGIN_ID || data?.key !== 'navigatorOpacity') return;
      setSurfaceOpacity(clampNavigatorOpacity(data.value));
    });
  }, [kernel, profileManager]);
  const [viewportSize, setViewportSize] = useState<CanvasViewportSize>({ width: 0, height: 0 });
  const fallbackViewport = useMemo(
    () => ({ panOffset, zoom, transient: false }),
    [panOffset, zoom],
  );
  // 投影与 marker 用**节流后**的渲染态：它们是 O(元素数) 的工作，不该每帧重做。
  // 每帧必须跟手的东西只有下面那个相机框，走 imperative 通道。
  const renderViewport = useCanvasViewportRenderState(viewportStore, fallbackViewport);

  /**
   * 主画布 svg 与导航器的挂载顺序不保证：首帧 layout effect 时 ref 可能还是 null，
   * 若直接 return 就永远不会再执行（deps 只有 svgRef、ref 对象引用恒定），viewportSize
   * 卡在 0 → 点击/取景框/fit 全部被守卫静默吞掉（2026-10 实测根因）。
   * 因此 ref 未就绪时用 rAF 逐帧补挂（上限 90 帧），挂上后 ResizeObserver 持续跟尺寸。
   */
  useLayoutEffect(() => {
    let observer: ResizeObserver | null = null;
    let attached = false;
    const attach = (): boolean => {
      const svg = svgRef.current;
      if (!svg) return false;
      attached = true;
      const measure = () => {
        const rect = svg.getBoundingClientRect();
        const next = { width: rect.width, height: rect.height };
        setViewportSize(previous => previous.width === next.width && previous.height === next.height ? previous : next);
      };
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(svg);
      }
      return true;
    };
    let attempt = 0;
    let frame: number | null = null;
    const retry = () => {
      attempt += 1;
      if (attach() || attempt >= 90) return;
      frame = requestAnimationFrame(retry);
    };
    if (!attach()) frame = requestAnimationFrame(retry);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (!attached) return;
      observer?.disconnect();
    };
  }, [svgRef]);

  const model = useMemo(() => createCanvasNavigatorModel(elements), [elements]);
  const worldViewport = useMemo(
    () => getCanvasWorldViewport({
      viewportSize,
      panOffset: renderViewport.panOffset,
      zoom: renderViewport.zoom,
    }),
    [viewportSize, renderViewport],
  );
  const overviewBounds = useMemo(
    () => unionCanvasRects([model.contentBounds, worldViewport]),
    [model.contentBounds, worldViewport],
  );
  const projection = useMemo(
    () => overviewBounds ? createNavigatorProjection(overviewBounds, NAVIGATOR_SIZE) : null,
    [overviewBounds],
  );
  const selectedIds = useMemo(() => new Set(selectedElementIds), [selectedElementIds]);

  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const cameraRectRef = useRef<SVGRectElement | null>(null);

  /**
   * 相机取景框逐帧跟手（live 通道），但**整棵小地图不再逐帧重渲染**。
   *
   * 旧实现订阅 live，于是每帧都要 diff 整个组件树（含最多 240 个 marker 矩形），
   * 图片一多，小地图就成了滚动时的主要 JS 开销。
   * 现在每帧只写 4 个属性；marker/投影只在节流发布时更新。
   * deps 含 projection：内容增减或窗口变化让投影重算时，取景框必须按新投影重摆，
   * 否则它会停在旧坐标系里（框与内容错位）。
   */
  useLayoutEffect(() => {
    if (!viewportStore) return;
    let frame: number | null = null;
    const applyLiveCameraRect = () => {
      frame = null;
      const rectElement = cameraRectRef.current;
      const currentProjection = projectionRef.current;
      const size = viewportSizeRef.current;
      if (!rectElement || !currentProjection || size.width <= 0 || size.height <= 0) return;
      const live = viewportStore.getLive();
      const world = getCanvasWorldViewport({
        viewportSize: size,
        panOffset: live.panOffset,
        zoom: live.zoom,
      });
      const projected = projectNavigatorRect(world, currentProjection);
      rectElement.setAttribute('x', String(projected.x));
      rectElement.setAttribute('y', String(projected.y));
      rectElement.setAttribute('width', String(Math.max(1, projected.width)));
      rectElement.setAttribute('height', String(Math.max(1, projected.height)));
    };
    const scheduleLiveCameraRect = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(applyLiveCameraRect);
    };
    applyLiveCameraRect();
    const unsubscribe = viewportStore.subscribeLive(scheduleLiveCameraRect);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [viewportStore, projection]);

  /** 没有相机通道时（兼容路径）取景框仍由 React 渲染。 */
  const staticCameraRect = useMemo(
    () => (!viewportStore && projection ? projectNavigatorRect(worldViewport, projection) : null),
    [projection, viewportStore, worldViewport],
  );

  /**
   * 导航写入走 store（相机单一真相），手势收尾 endInteraction→onCommit 自动回写 board。
   *
   * 以前点击经 onViewportChange→board→syncDocument 绕回 store，而 syncDocument 在
   * transient 手势期间**直接丢弃**文档值、随后 endInteraction 又把旧 live 提交回 board——
   * 刚滚过画布再点小地图，跳转就被无声覆盖（"点击没办法定位"）。
   */
  const applyCamera = (next: { panOffset: Point; zoom: number }, commit: boolean) => {
    if (viewportStore) {
      viewportStore.setTransient(next);
      if (commit) viewportStore.endInteraction();
    } else {
      onViewportChange(next);
    }
  };

  /** 命中检测：取包含点击点的最小 marker（框内的小图优先于外框）。 */
  const hitMarkerBoundsAt = (worldPoint: Point): Rect | null => {
    if (!projection) return null;
    const tol = 10 / projection.scale;
    let best: Rect | null = null;
    for (const marker of model.markers) {
      const b = marker.bounds;
      if (worldPoint.x < b.x - tol || worldPoint.x > b.x + b.width + tol
        || worldPoint.y < b.y - tol || worldPoint.y > b.y + b.height + tol) continue;
      if (!best || b.width * b.height < best.width * best.height) best = b;
    }
    return best;
  };

  /** primary=true（按下）命中小图时聚焦查看：居中并放大到刚好容纳（上限 4x）；空白处/拖拽保持纯平移居中。 */
  const viewForPointer = (event: React.PointerEvent<SVGSVGElement>, primary: boolean) => {
    if (!projection || viewportSize.width <= 0 || viewportSize.height <= 0) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const navigatorPoint = {
      x: (event.clientX - rect.left) * NAVIGATOR_SIZE.width / rect.width,
      y: (event.clientY - rect.top) * NAVIGATOR_SIZE.height / rect.height,
    };
    const worldPoint = unprojectNavigatorPoint(navigatorPoint, projection);
    const currentZoom = viewportStore ? viewportStore.getLive().zoom : renderViewport.zoom;
    if (primary) {
      const hit = hitMarkerBoundsAt(worldPoint);
      if (hit) {
        const fit = fitCanvasViewport(hit, viewportSize, 96);
        if (fit) {
          const zoom = Math.min(Math.max(fit.zoom, currentZoom), Math.max(currentZoom, 4));
          return {
            zoom,
            panOffset: centerCanvasPointInViewport({ x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 }, viewportSize, zoom),
          };
        }
      }
    }
    return {
      zoom: currentZoom,
      panOffset: centerCanvasPointInViewport(worldPoint, viewportSize, currentZoom),
    };
  };

  const dragPointerIdRef = useRef<number | null>(null);
  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const next = viewForPointer(event, true);
    if (!next) return;
    event.preventDefault();
    dragPointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyCamera(next, false);
  };
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragPointerIdRef.current !== event.pointerId) return;
    const next = viewForPointer(event, false);
    if (next) applyCamera(next, false);
  };
  const handlePointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragPointerIdRef.current !== event.pointerId) return;
    dragPointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // 停稳并提交：board 状态经 onCommit 落到当前相机，syncDocument 回来时值已相等。
    if (viewportStore) viewportStore.endInteraction();
  };

  const handleFit = () => {
    const next = fitCanvasViewport(model.contentBounds, viewportSize);
    if (next) applyCamera(next, true);
  };

  return (
    <aside
      aria-label={t('navigator.ariaLabel')}
      title={t('navigator.hint')}
      data-bp-ui-navigator=""
      data-bp-ui-surface="" className="group absolute bottom-4 right-4 z-30 w-[min(14rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-white/30 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-md hover:border-white/50 focus-within:border-white/50"
      style={{ backgroundColor: `color-mix(in srgb, var(--bp-ui-surface-strong) ${Math.round(surfaceOpacity * 100)}%, transparent)` }}
    >
      <svg
        aria-label={t('navigator.svgLabel')}
        className="block h-auto w-full touch-none select-none"
        style={{ cursor: projection ? 'crosshair' : 'default' }}
        viewBox={`0 0 ${NAVIGATOR_SIZE.width} ${NAVIGATOR_SIZE.height}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        {projection && model.markers.map((marker, index) => {
          const rect = projectNavigatorRect(marker.bounds, projection);
          const selected = selectedIds.has(marker.id);
          const frame = marker.type === 'frame';
          return (
            <rect
              key={`${marker.id}-${index}`}
              x={rect.x}
              y={rect.y}
              width={Math.max(1, rect.width)}
              height={Math.max(1, rect.height)}
              rx={frame ? 1.5 : 0.75}
              fill={selected ? 'rgba(251, 191, 36, 0.95)' : 'rgba(203, 213, 225, 0.30)'}
              stroke={frame ? 'rgba(203, 213, 225, 0.55)' : 'none'}
              strokeWidth={frame ? 0.8 : 0}
              pointerEvents="none"
            />
          );
        })}
        {projection && (staticCameraRect ? (
          <rect
            x={staticCameraRect.x}
            y={staticCameraRect.y}
            width={Math.max(1, staticCameraRect.width)}
            height={Math.max(1, staticCameraRect.height)}
            fill="rgba(125, 211, 252, 0.10)"
            stroke="rgba(125, 211, 252, 0.95)"
            strokeWidth="1.4"
            pointerEvents="none"
          />
        ) : (
          /* 有相机通道时位置由 imperative 层独占（故意不设 x/y/width/height，避免 React 每帧覆盖）。 */
          <rect
            ref={cameraRectRef}
            fill="rgba(125, 211, 252, 0.10)"
            stroke="rgba(125, 211, 252, 0.95)"
            strokeWidth="1.4"
            pointerEvents="none"
          />
        ))}
        {model.totalCount === 0 && (
          <text x={NAVIGATOR_SIZE.width / 2} y={NAVIGATOR_SIZE.height / 2} textAnchor="middle" fill="rgba(255,255,255,0.38)" fontSize="11" pointerEvents="none">
            {t('navigator.empty')}
          </text>
        )}
      </svg>
      {/* 极简约束：动作不占布局——地图内右上角悬浮，悬停/聚焦时才浮现 */}
      <div className="pointer-events-none absolute right-1 top-1 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <button
          type="button"
          onClick={onOpenFinder}
          className="rounded-md border border-white/20 bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-neutral-200 hover:bg-black/75 hover:text-white"
        >
          {t('navigator.find')}
        </button>
        <button
          type="button"
          onClick={onOpenViews}
          className="rounded-md border border-white/20 bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-neutral-200 hover:bg-black/75 hover:text-white"
        >
          {t('navigator.views')}{viewBookmarkCount > 0 ? ` (${viewBookmarkCount})` : ''}
        </button>
        <button
          type="button"
          onClick={handleFit}
          disabled={!model.contentBounds || viewportSize.width <= 0 || viewportSize.height <= 0}
          className="rounded-md border border-sky-300/35 bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-100 hover:bg-sky-400/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('navigator.fit')}
        </button>
      </div>
    </aside>
  );
};
