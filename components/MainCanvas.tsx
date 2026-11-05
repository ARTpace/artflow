
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Element, ImageElement, Point, Rect, Guide, AIRotationState, Tool } from '../types';
import type { HostPlatformService } from '../plugin-runtime/host-platform';
import { useCanvasWindowMove } from '../hooks/useCanvasWindowMove';
import { CanvasBackdrop, CanvasScreenGrid } from './CanvasBackground';
import { CanvasElement } from './CanvasElement';
import { CanvasOverlays } from './CanvasOverlays';
import { tryKernel } from '../plugin-runtime/instance';
import { WORKSPACE_UI_BRIDGE_SERVICE, type WorkspaceUiBridgeService } from '../plugin-runtime/workspace-bridge';
import { CanvasToolbarHost } from '../plugin-runtime/toolbar-host';
import { PluginOverlayHost } from '../plugin-runtime/overlay-host';
import { CroppingOverlay } from './CroppingOverlay';
import { EditingOverlay } from './EditingOverlay';
import { RotationOverlays } from './RotationOverlays';
import { SelectionHandles } from './SelectionHandles';
import { createViewportIndexCache } from '../utils/viewport-index';
import type { InteractionViewportIndexSnapshot } from '../utils/interaction-spatial-query';
import { SVGDefs } from './SVGDefs';
import { beginNativeDragOut, findDragOutImage } from '../utils/nativeDragOut';
import {
    useCanvasViewportRenderState,
    RENDER_PUBLISH_MOVE_PX,
    type CanvasViewportStore,
} from '../utils/viewport-store';
import {
    hasElementDragMoved,
    useCanvasDragSessionSnapshot,
    type CanvasDragSessionStore,
} from '../utils/drag-session-store';
import {
    useContentInteractingIds,
    type ContentInteractionStore,
} from '../utils/content-interaction-store';
import type { SelectionPreviewStore } from '../utils/selection-preview-store';
import {
    useElementTransformSessionSnapshot,
    type ElementTransformSessionStore,
} from '../utils/element-transform-session';
import { SelectionPreviewOverlay } from './SelectionPreviewOverlay';
import { applyDragPreview } from '../utils/drag-offset';
import { applyGesturePreview } from '../utils/gesture-transform';
import { recordProfilerRender } from '../utils/perfTelemetry';
import { captureViewportCullEntries, cullViewportEntries, CULL_HIDE_SCREEN } from '../utils/viewport-culling';
import { createImportRevealController, type ImportRevealRequest } from '../utils/importReveal';

/** 点阵间距（世界单位）。与旧 SVG pattern 的 20×20 一致。 */
const BACKDROP_DOT_WORLD = 20;

const paintScreenLayer = (
    node: HTMLDivElement | null,
    worldStep: number,
    zoom: number,
    panX: number,
    panY: number,
) => {
    if (!node || !(worldStep > 0) || !(zoom > 0)) return;
    const step = worldStep * zoom;
    node.style.backgroundSize = `${step}px ${step}px`;
    node.style.backgroundPosition = `${panX}px ${panY}px`;
};

/**
 * 大跳变阈值：可见查询范围的**面积**一次涨到这么多倍才算"跳变"。
 * 最大化/还原是窗口尺寸的瞬间跳变（1200×802 → 2560×1392 约 4.7 倍），
 * 而连续拖拽边框每次只涨一点点，永远命中不到 —— 所以拖拽手感不受这套机制影响。
 */
const RESIZE_CATCHUP_AREA_RATIO = 1.8;
/**
 * 跳变后分几帧把查询范围补齐到新尺寸。
 * 意义：可见元素集由 viewportRect 直接驱动（见下面的 useMemo），跳变时若一帧到位，
 * 这一帧要一次性挂进 4~5 倍的元素（每张卡片还带图片解码与毛玻璃层）。
 * 摊到几帧之后每帧的挂载量降到 1/N，峰值帧时间随之下降。
 */
const RESIZE_CATCHUP_FRAMES = 4;

interface MainCanvasProps {
    svgRef: React.RefObject<SVGSVGElement>;
    elements: Element[];
    selectedElementIds: string[];
    panOffset: Point;
    zoom: number;
    cursor: string;
    handleMouseDown: (e: React.MouseEvent | React.TouchEvent) => void;
    handleMouseMove: (e: React.MouseEvent | React.TouchEvent) => void;
    handleMouseUp: () => void;
    /** 指针离开画布：只在手势确实依赖 SVG 内事件时才收尾（拖动/平移/框选不算）。 */
    handleMouseLeave: () => void;
    handleWheel: (e: React.WheelEvent) => void;
    handleContextMenu: (e: React.MouseEvent<SVGSVGElement>) => void;
    showCanvasMenu: (x: number, y: number, elementId: string | null) => void;
    dismissCanvasMenu: () => void;
    windowPlatform: HostPlatformService | null;
    activeTool: Tool;
    focusImage: (id: string) => void;
    
    editingElement: { id: string; text: string } | null;
    croppingState: { elementId: string; originalElement: ImageElement; cropBox: Rect } | null;
    aiRotationState: AIRotationState | null;
    lassoPath: Point[] | null;
    alignmentGuides: Guide[];
    selectionBox: Rect | null;
    
    interactionMode: string | null;
    rotateStartInfo: { originalElement: Element; center: Point; startCanvasPoint: Point; } | null;
    rotateDialPoint: Point | null;
    isElementVisible: (element: Element, allElements: Element[]) => boolean;
    setEditingElement: (el: { id: string; text: string } | null) => void;
    handleStopEditing: () => void;
    setElements: (elements: Element[] | ((prev: Element[]) => Element[])) => void;
    
    singleSelectedElement: Element | null;
    handleCopySelection: () => void;
    handleGroup: () => void;
    handleRasterizeSelection: () => void;
    handleSelectionPropertyChange: (updates: { [key: string]: any }) => void;
    handleAlignSelection: (alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
    handleMasonryLayout: () => void;
    handleCopyElement: (el: Element) => void;
    handleFrameAspectRatioChange: (id: string, ratio: string) => void;
    handleUngroup: () => void;
    handleMergeGroup: () => void;
    handleDownloadImage: (el: ImageElement) => void;
    handleStartCrop: (el: ImageElement) => void;
    handlePropertyChange: (id: string, updates: Partial<Element>) => void;
    handleDeleteElement: (id: string) => void;
    
    isActivePresentation: boolean;
    t: (key: string, ...args: any[]) => any;
    isInteracting: boolean;
    /** PureRef 对齐 ③⑤：背景网格与视图辅助。 */
    gridVisible?: boolean;
    gridSize?: number;
    viewDesaturate?: boolean;
    viewDimUnselected?: boolean;
    /** R14 optional read-only port; MainCanvas retains cache ownership. */
    interactionViewportIndexRef?: React.MutableRefObject<InteractionViewportIndexSnapshot | null>;
    /**
     * 相机瞬时通道（P1-B'）：存在时 transform 由 imperative 层按 live 值直接写 DOM，
     * React 只按节流后的渲染态做裁剪/LOD/叠加层，不再每帧写 Board。
     */
    viewportStore?: CanvasViewportStore;
    /**
     * 拖动会话瞬时通道（P1-B）：存在时拖动中的元素按通道里的位移呈现，
     * 文档状态在整个拖动期间不变；不存在时保持旧行为（拖动已经写进 elements）。
     */
    dragSessionStore?: CanvasDragSessionStore;
    /**
     * 内容变换瞬时通道（P0-1）：存在时元素是否降档只看"它自己有没有在被变换"，
     * 不再跟着"鼠标有没有按下"全板降档；不存在时回落到 isInteracting 的旧口径。
     */
    contentInteractionStore?: ContentInteractionStore;
    /** 框选/套索"将被选中"预览通道（P0-3）：存在时挂载高亮呈现层。 */
    selectionPreviewStore?: SelectionPreviewStore;
    /**
     * 元素几何变换瞬时通道（P1-1）：缩放/旋转/绘制期间"这个元素现在长什么样"
     * 只存在通道里，文档状态整段手势不变（于是空间索引不重建、可见集不重算）。
     * 不存在时保持旧行为（几何已经逐帧写进 elements）。
     */
    transformSessionStore?: ElementTransformSessionStore;
    /** One-shot import-only visual cue; unrelated canvas edits never replay it. */
    importRevealQueueRef?: React.MutableRefObject<ImportRevealRequest | null>;
    importRevealScope?: string;
    isImportRevealBusy?: () => boolean;
}

const MainCanvasBase: React.FC<MainCanvasProps> = ({
    svgRef,
    elements,
    selectedElementIds,
    panOffset,
    zoom,
    cursor,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleWheel,
    handleContextMenu,
    showCanvasMenu,
    dismissCanvasMenu,
    windowPlatform,
    activeTool,
    focusImage,
    editingElement,
    croppingState,
    aiRotationState,
    lassoPath,
    alignmentGuides: staticAlignmentGuides,
    selectionBox,
    interactionMode,
    rotateStartInfo,
    rotateDialPoint,
    isElementVisible,
    setEditingElement,
    handleStopEditing,
    setElements,
    singleSelectedElement,
    handleCopySelection,
    handleGroup,
    handleRasterizeSelection,
    handleSelectionPropertyChange,
    handleAlignSelection,
    handleMasonryLayout,
    handleCopyElement,
    handleFrameAspectRatioChange,
    handleUngroup,
    handleMergeGroup,
    handleDownloadImage,
    handleStartCrop,
    handlePropertyChange,
    handleDeleteElement,
    isActivePresentation,

    // PureRef 对齐 ③⑤
    gridVisible = false,
    gridSize = 32,
    viewDesaturate = false,
    viewDimUnselected = false,
    t,
    isInteracting,
    interactionViewportIndexRef,
    viewportStore,
    dragSessionStore,
    contentInteractionStore,
    selectionPreviewStore,
    transformSessionStore,
    importRevealQueueRef,
    importRevealScope = '',
    isImportRevealBusy,
}) => {
    // 相机来源：有 store 时用节流后的渲染态，否则保持旧的 props 行为（向后兼容）。
    const fallbackViewport = useMemo(
        () => ({ panOffset, zoom, transient: false }),
        [panOffset, zoom],
    );
    const viewport = useCanvasViewportRenderState(viewportStore, fallbackViewport);
    const viewportPan = viewport.panOffset;
    const viewportZoom = viewport.zoom;
    // 手势进行中不把新的缩放交给元素。渲染通道仍会发布（裁剪要跟上），
    // 但图片档位、描边按手势开始时的缩放保持不变，避免中途换 href 把相机层整层打脏。
    // 手势结束（transient 归位）后用最终缩放结算一次。不把 transient 本身传进元素。
    const elementZoomRef = useRef(viewportZoom);
    if (!viewport.transient) elementZoomRef.current = viewportZoom;
    const elementZoom = viewport.transient ? elementZoomRef.current : viewportZoom;

    // 拖动会话来源（P1-B）：有通道时拖动中的元素按"起始位置 + 位移"呈现，文档状态不动。
    const dragSession = useCanvasDragSessionSnapshot(dragSessionStore);
    const dragElementIds = dragSession.elementIds;
    const dragOffset = dragSession.offset;
    const alignmentGuides = dragSessionStore ? dragSession.guides : staticAlignmentGuides;

    // 内容变换集合（P0-1）：只有"正在被变换"的元素需要降档。通道在场时它**取代**全局
    // isInteracting 作为降档依据 —— 拖一个小元素不会再把整板图片的 href 全换一遍；
    // 通道缺席时保持旧的全局口径（手势中全板降档）。
    const contentInteractingIds = useContentInteractingIds(contentInteractionStore);

    // 几何变换会话来源（P1-1）：缩放/旋转/绘制期间"这个元素现在长什么样"从这个通道读。
    // 与拖动通道同构 —— 通道一变只有订阅的这一层重渲染，文档状态与空间索引都不动。
    const transformPreview = useElementTransformSessionSnapshot(transformSessionStore).element;
    /**
     * P1-1 关键点：白名单只认**元素 id**，不认每帧都在变的预览对象。
     *
     * 反例（一开始就踩的坑）：直接依赖 transformPreview，会让 interactionIncludeIds 每帧
     * 换一个新 Set → viewportIncludeIds 跟着换引用 → visibleElements 的 useMemo 每帧重算一
     * 次视口查询与可见性过滤。那样"每帧改 elements"只是换成了"每帧重算可见集"，
     * 空间索引是冻住了，可见集这层却照旧全量重算 —— 手感不会好转。
     * 会话期间 id 恒定，所以这一层必须只依赖 id。
     */
    const transformSessionElementId = transformPreview ? transformPreview.id : null;

    // 拖动中让位：选区工具条与缩放手柄都贴着选区画，拖动时它们只会跟着图片晃、
    // 挡住下方内容。判据取"位移已经可见"而不是会话已开始——纯点击（mousedown 未移动）
    // 不该让这些控件闪一下。松手（会话结束）后按新位置重算。
    const isDraggingElements = hasElementDragMoved(dragSession, viewportZoom);

    // Translate stable media cards instead of rendering their content every frame.
    // This also covers a single image/video and mixed media selections. Videos use
    // local CSS rounding; only image clips depend on absolute preview geometry.
    // Groups, frames and rounded images retain the existing exact preview.
    const translateImageBatch = useMemo(() => {
        if (!dragElementIds || dragElementIds.size === 0 || selectedElementIds.length === 0
            || !selectedElementIds.every(id => dragElementIds.has(id))) return false;
        const byId = new Map<string, Element>(elements.map(el => [el.id, el]));
        for (const id of dragElementIds) {
            const el = byId.get(id);
            // HTML cards position their content in a local foreignObject. Translating
            // the wrapper preserves player/editor/3D instances instead of cloning
            // their element prop on every pointer frame. Groups/frames and SVG
            // image clips still require exact document-space preview geometry.
            if (el && ['video', 'audio', 'code', 'markdown', 'model3d', 'file', 'bookmark', 'plugin-node'].includes(el.type)) continue;
            if (el?.type !== 'image' || (el.borderRadius ?? 0) > 0) return false;
        }
        return true;
    }, [dragElementIds, elements, selectedElementIds]);

    /**
     * Drag geometry for the selection bounds, toolbar and rounded clip paths.
     * The flat-image fast path still uses this for overlays, but renders the
     * actual cards from stable document elements under small translating <g>s.
     * Non-moving elements retain their references.
     *
     * 注意这里有意传全量列表而不是可见子集：group 的 bounds 要靠子元素递归求，
     * 只给子集会算出退化的包围盒。
     *
     * P1-1：变换通道（缩放/旋转/绘制）的预览在这里叠上去 —— 于是选区手柄、圆角裁剪
     * 的 clipPath、组包围盒与工具条用的都是"用户此刻看到的那份几何"，而不是文档里那份。
     * 没有会话时 applyGesturePreview 原样返回入参引用，两个通道都不在场时
     * presentElements 仍与 elements 同引用（下游的引用相等判断不受影响）。
     */
    const presentElements = useMemo(
        () => applyGesturePreview(applyDragPreview(elements, dragElementIds, dragOffset), transformPreview),
        [elements, dragElementIds, dragOffset, transformPreview],
    );

    // 视口尺寸只在布局变化时测量一次，避免每帧强制读取布局（同步回流）。
    // 量的是**外层容器**而不是 <svg>：相机 transform 挂在 <svg> 元素自身上（GPU 合成，
    // 见 ADR-049），<svg> 的 getBoundingClientRect() 返回变换后的盒子；
    // 外层容器未变换，其盒子与 <svg> 未变换时的盒子重合。
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        const container = svgRef.current?.parentElement;
        if (!container) return;
        const measure = () => {
            const rect = container.getBoundingClientRect();
            setCanvasSize(previous => (
                previous.width === rect.width && previous.height === rect.height
                    ? previous
                    : { width: rect.width, height: rect.height }
            ));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, [svgRef]);

    // —— 可见查询范围的大跳变追赶 ——
    //
    // 为什么需要：viewportRect 直接由 canvasSize 驱动（见下面 useMemo），窗口尺寸一变，
    // 可见查询范围立刻变成新尺寸，于是**这一帧**要挂进全部新增的可见元素。
    // 平移/缩放有 RENDER_PUBLISH_* 那套增长节流（viewport-store），窗口 resize 这条路径没有。
    // 最大化在 2560×1392 下面积是恢复态的 4.7 倍，也就是一次性挂进 ~4.7 倍元素。
    //
    // 处理：只在"面积跳变 ≥ RESIZE_CATCHUP_AREA_RATIO"时把它摊到 RESIZE_CATCHUP_FRAMES 帧，
    // 连续拖拽（增量小）与还原（面积变小）都走即时路径，行为与改动前完全一致。
    const [queryCanvasSize, setQueryCanvasSize] = useState(canvasSize);
    const queryCanvasSizeRef = useRef(queryCanvasSize);
    queryCanvasSizeRef.current = queryCanvasSize;
    useEffect(() => {
        const from = queryCanvasSizeRef.current;
        const to = canvasSize;
        if (to.width <= 0 || to.height <= 0) return;
        const fromArea = from.width * from.height;
        const toArea = to.width * to.height;
        if (fromArea <= 0 || toArea / fromArea < RESIZE_CATCHUP_AREA_RATIO) {
            setQueryCanvasSize(to);
            return;
        }
        let step = 0;
        let frame: number | null = null;
        const advance = () => {
            step += 1;
            const t = Math.min(1, step / RESIZE_CATCHUP_FRAMES);
            setQueryCanvasSize({
                width: from.width + (to.width - from.width) * t,
                height: from.height + (to.height - from.height) * t,
            });
            if (t < 1) frame = window.requestAnimationFrame(advance);
        };
        frame = window.requestAnimationFrame(advance);
        return () => {
            if (frame !== null) window.cancelAnimationFrame(frame);
        };
    }, [canvasSize.width, canvasSize.height]);

    // 性能核心：相机 transform 挂在内层 <g>（ADR-051 恢复；"挂 <svg> 根"方案已被真机证伪）。
    //
    // ADR-049 曾把 transform 移到 <svg> 元素自身（will-change:transform 提升合成层，
    // 期望 pan/zoom 只更新变换矩阵、不重栅格化）。真机实测被证伪：
    // <svg> 层的 bounds 覆盖 overflow:visible 下的全部世界内容（巨型单层），
    // 缩放时栅格比例失配 —— 手势中显示旧比例瓦片（发软/闪）、新暴露区域尚未
    // 栅格化（图片消失）、比例变化触发整层重栅格 + 合成器饱和（输入停滞感）。
    // 真机症状："滚动缩放很闪、图片消失、滚动和拖动突然失效"。
    // 命中测试不受影响（scratch/probe-svg-root-hit-test.html 已排除），
    // 问题出在合成器侧，且回退后消失 —— 详细记录见 docs/adr/ADR-051。
    //
    // <g> 方案的每帧重栅格成本由 512px 中档纹理（ADR-049 后半，保留）压到 1/4，
    // 这才是对"图片一多才卡"的正确解；合成层路线不再使用。
    const canvasTransform = `translate3d(${viewportPan.x}px, ${viewportPan.y}px, 0) scale(${viewportZoom})`;

    const viewportGroupRef = useRef<SVGGElement | null>(null);
    const canvasSizeRef = useRef(canvasSize);
    canvasSizeRef.current = canvasSize;
    const backdropRef = useRef<HTMLDivElement | null>(null);
    const screenGridRef = useRef<HTMLDivElement | null>(null);
    const cullEntriesRef = useRef<ReturnType<typeof captureViewportCullEntries>>([]);
    const runLiveCullRef = useRef<() => void>(() => {});
    runLiveCullRef.current = () => {
        const group = viewportGroupRef.current;
        if (!group || !viewportStore) return;
        const live = viewportStore.getLive();
        const size = canvasSizeRef.current;
        cullViewportEntries(
            cullEntriesRef.current,
            live.zoom,
            live.panOffset.x,
            live.panOffset.y,
            size.width,
            size.height,
        );
    };

    // 有 store 时：transform 由 live 值直接写内层 <g>，每帧只做一次字符串赋值，不触发 React。
    //
    // ⚠️ 已实测否决"量化步进写入"（方案②，2026-09-24）：曾试过 zoom 相对上次写入
    // 偏移 <6% 时冻结 transform、跨步才写真实值，A/B 交错各两轮（150 图全屏 12s
    // 缩放手势，scratch/probe-paint-trace.mjs）结果 B 比 A 差 2.5 倍：
    //   A（每帧精确写）RasterTask ≈6300 / GPUTask ≈2.3s
    //   B（6% 步进跳写）RasterTask ≈17000 / GPUTask ≈6.0s
    // 机制：Chromium cc 对**连续微小 scale 变化会保持旧瓦片拉伸显示**（延迟重光栅，
    // 正是"低清瓦片过渡"想要的；每帧写入天然享受）；而 6% 跳变每次都越过重光栅
    // 判据，把"延迟重光栅"变成"每步必重光栅"。结论：imperative 每帧写入是当前
    // 架构下对 cc 拉伸启发式最友好的写法，勿再改步进。
    useLayoutEffect(() => {
        if (!viewportStore) return;
        let frame: number | null = null;
        const applyLiveTransform = () => {
            frame = null;
            const group = viewportGroupRef.current;
            if (!group) return;
            const live = viewportStore.getLive();
            group.style.transform = `translate3d(${live.panOffset.x}px, ${live.panOffset.y}px, 0) scale(${live.zoom})`;
            runLiveCullRef.current();
            paintScreenLayer(backdropRef.current, BACKDROP_DOT_WORLD, live.zoom, live.panOffset.x, live.panOffset.y);
            paintScreenLayer(screenGridRef.current, gridSize, live.zoom, live.panOffset.x, live.panOffset.y);
        };
        const scheduleTransform = () => {
            if (frame !== null) return;
            frame = window.requestAnimationFrame(applyLiveTransform);
        };
        applyLiveTransform();
        const unsubscribe = viewportStore.subscribeLive(scheduleTransform);
        return () => {
            unsubscribe();
            if (frame !== null) window.cancelAnimationFrame(frame);
        };
    }, [viewportStore, gridSize, gridVisible, isActivePresentation]);

    // React 提交（例如越过星系阈值、挂上一整屏图片）发生在绘制前。
    // 若只等下一帧 rAF 再裁，这一帧仍会把整板图片栅进去。
    useLayoutEffect(() => {
        if (!viewportGroupRef.current || !viewportStore) return;
        // Read all metadata before any display writes. Camera-only frames reuse
        // this snapshot instead of walking HTML/3D card descendants every frame.
        cullEntriesRef.current = captureViewportCullEntries(viewportGroupRef.current);
        runLiveCullRef.current();
    });

    useLayoutEffect(() => {
        if (viewportStore) return;
        paintScreenLayer(backdropRef.current, BACKDROP_DOT_WORLD, viewportZoom, viewportPan.x, viewportPan.y);
        paintScreenLayer(screenGridRef.current, gridSize, viewportZoom, viewportPan.x, viewportPan.y);
    }, [viewportStore, viewportZoom, viewportPan.x, viewportPan.y, gridSize, isActivePresentation, gridVisible]);

    const viewportRect = useMemo(() => {
        // 尺寸未测到前退回旧的固定视口，避免首帧裁剪为空。
        // 用 queryCanvasSize（大跳变时会分帧补齐）而不是 canvasSize，见上面的追赶逻辑。
        const width = queryCanvasSize.width > 0 ? queryCanvasSize.width : 2000;
        const height = queryCanvasSize.height > 0 ? queryCanvasSize.height : 2000;
        // 计算当前视口在 Canvas 坐标系下的范围
        return {
            x: -viewportPan.x / viewportZoom,
            y: -viewportPan.y / viewportZoom,
            width: width / viewportZoom,
            height: height / viewportZoom,
        };
    }, [queryCanvasSize.height, queryCanvasSize.width, viewportPan, viewportZoom]);

    // 裁剪 overscan：**恒定**，不跟随"手势中"标记开关。
    //
    // 为什么不能用手势标记：那个标记每次手势都要翻转（滚轮靠 200ms 空闲定时器收尾），
    // 它一变，这个 padding 就从"有"变"无"、再从"无"变"有" —— 于是每次滚动都要
    // 先多挂一圈元素、停手再卸掉一圈、下次滚动又挂回来。挂载一个 SVG <image>
    // 是要解码的，这就变成"每滚一次付一遍"的固定开销。
    // 恒定 overscan 让可见集只随相机连续变化（缩放本来就会改变可见范围），
    // 不再因为手势开关而跳变。
    //
    // 取值为发布阈值的 1.6 倍：平移时渲染态最多滞后 RENDER_PUBLISH_MOVE_PX，1.25 就够；
    // 但缩小的可见半径扩大由 zoom 阈值（RENDER_PUBLISH_ZOOM_SHRINK_RATIO=22%）管辖，
    // 两次发布之间可见半径最多扩大约 25%，overscan 必须按"屏幕半径的富余"兜住它：
    // 120 × 1.6 = 192px ≈ 屏幕半径 720 的 26.7% > 25%，露白风险归零。
    // 对比原来的"屏幕短边 30%"（1440×900 下约 270px），稳态挂载量仍更小，抖动归零。
    const viewportQueryPadding = useMemo(
        () => (RENDER_PUBLISH_MOVE_PX * 1.6 + CULL_HIDE_SCREEN) / viewportZoom,
        [viewportZoom],
    );

    // ponytail: flat immutable edits update changed cells only; group/structural changes conservatively rebuild.
    const viewportIndexCacheRef = useRef<ReturnType<typeof createViewportIndexCache> | null>(null);
    if (!viewportIndexCacheRef.current) viewportIndexCacheRef.current = createViewportIndexCache();
    const viewportIndex = useMemo(() => viewportIndexCacheRef.current!.update(elements), [elements]);

    // R14: publish only a same-elements snapshot after the cache is current. The App/hook
    // consumer identity-gates it and safely falls back to its current full list if stale.
    useLayoutEffect(() => {
        if (!interactionViewportIndexRef) return;
        const snapshot: InteractionViewportIndexSnapshot = { elements, index: viewportIndex };
        interactionViewportIndexRef.current = snapshot;
        return () => {
            if (interactionViewportIndexRef.current === snapshot) interactionViewportIndexRef.current = null;
        };
    }, [elements, interactionViewportIndexRef, viewportIndex]);

    const selectedElementIdSet = useMemo(() => new Set(selectedElementIds), [selectedElementIds]);

    /**
     * 裁剪白名单 = **必须驻留**的交互对象，而不是整个选中集。
     *
     * 原来这里是"选中集 ∪ 拖动集"，于是"导入即全选"会把裁剪完全抵消：
     * 视口里只有 8 张时，全选 5000 张就让 5000 张全部进入渲染层（实测见
     * scripts/benchmark-scale-hotpaths.cjs）。**选中一张屏幕外的卡片，不该意味着
     * 把它整份内容挂载回来** —— 选中只是语义状态，手柄与工具条都从全量 elements
     * 取数据，不依赖它是否被渲染。
     *
     * 真正必须驻留的只有三类"状态与挂载绑定"的对象：
     * - 拖动会话（含组/Frame 的后代）：拖动期间新位置只存在于拖动通道里，
     *   视口索引仍是拖动前的位置，不放行的话拖动中会"掉块"。
     * - 文本编辑中的元素：编辑态 UI 挂在元素自身，卸载就丢输入框。
     * - 裁剪中 / AI 旋转中的元素：同理，交互过程不能中断。
     * - P1-1 缩放/旋转/绘制中的元素：新几何同理只存在于变换通道里，视口索引还是手势前的位置，
     *   不放行的话"把形状拖大"会在旧包围盒外被裁掉。
     *
     * P1-1：白名单只与**元素 id** 有关，与逐帧在变的 cropBox / currentAngle 无关。
     * 直接把 croppingState / aiRotationState 对象放进依赖，裁剪手柄每动一帧都会换掉
     * 依赖引用 → Set 重建 → viewportIncludeIds 换新 → visibleElements 的 useMemo
     * 每帧白重算一次（手势期间本该冻结的就是它）。折算成 id 后，裁剪/AI 旋转期间
     * 这两个 memo 只在元素换人时才失效。
     */
    const croppingElementId = croppingState ? croppingState.elementId : null;
    const aiRotationElementId = aiRotationState ? aiRotationState.element.id : null;

    const interactionIncludeIds = useMemo(() => {
        const ids = new Set<string>();
        if (dragElementIds) dragElementIds.forEach(id => ids.add(id));
        if (editingElement) ids.add(editingElement.id);
        if (croppingElementId) ids.add(croppingElementId);
        if (aiRotationElementId) ids.add(aiRotationElementId);
        if (transformSessionElementId) ids.add(transformSessionElementId);
        return ids;
    }, [dragElementIds, editingElement, croppingElementId, aiRotationElementId, transformSessionElementId]);

    /** 白名单为空时不传，省掉索引里那一轮无意义的 id 查找。 */
    const viewportIncludeIds = interactionIncludeIds.size > 0 ? interactionIncludeIds : undefined;

    const visibleElements = useMemo(() => {
        const candidates = isActivePresentation
            ? elements
            : viewportIndex.query(viewportRect, {
                includeElementIds: viewportIncludeIds,
                ...(viewportQueryPadding === undefined ? {} : { padding: viewportQueryPadding }),
            });
        // 可见性（含 parent 链）在候选集上判断，而不再让每个 CanvasElement 重复扫描全量 elements。
        return candidates.filter(el => isElementVisible(el, elements));
    }, [
        elements,
        viewportIndex,
        viewportRect,
        viewportQueryPadding,
        viewportIncludeIds,
        isActivePresentation,
        isElementVisible,
    ]);

    /** 渲染层：可见子集 + 拖动位移 + 变换预览。三个通道都不在场时与 visibleElements 同引用。 */
    const visiblePresentElements = useMemo(() => {
        const base = translateImageBatch || presentElements === elements
            ? visibleElements
            : applyDragPreview(visibleElements, dragElementIds, dragOffset);
        // P1-1：可见子集是从**视口索引**取的（手势前那份几何），所以变换预览必须叠在它之后 ——
        // 这样"正在被缩放的那张卡片"才会按新几何画出来，而其余卡片照旧拿原引用跳过重绘。
        return applyGesturePreview(base, transformPreview);
    }, [visibleElements, presentElements, elements, dragElementIds, dragOffset, translateImageBatch, transformPreview]);

    const importRevealLayerRef = useRef<HTMLDivElement | null>(null);
    const importRevealControllerRef = useRef<ReturnType<typeof createImportRevealController> | null>(null);
    if (!importRevealControllerRef.current) importRevealControllerRef.current = createImportRevealController();
    const importRevealScopeRef = useRef(importRevealScope);
    useEffect(() => () => importRevealControllerRef.current?.cancel(), []);
    // Called only at a document commit. No React state updates, timers or
    // per-frame work on the large SVG; the transient overlay handles the fade.
    useLayoutEffect(() => {
        if (importRevealScopeRef.current !== importRevealScope) {
            importRevealScopeRef.current = importRevealScope;
            importRevealControllerRef.current?.cancel();
        }
        const request = importRevealQueueRef?.current;
        if (!request) return;
        if (request.scope !== importRevealScope) {
            importRevealQueueRef!.current = null;
            return;
        }
        const ids = new Set(request.ids);
        // If selection/progress rendered before the document commit, wait for
        // the image to exist instead of consuming the one-shot request early.
        if (!elements.some(element => ids.has(element.id))) return;
        importRevealQueueRef!.current = null;
        if (isInteracting || isActivePresentation || viewDesaturate || viewDimUnselected || croppingState
            || visiblePresentElements.length > 96 // Dense views must prioritize painting over decoration.
            || !importRevealLayerRef.current || !svgRef.current) return;
        const images = visiblePresentElements.filter(
            (element): element is ImageElement => element.type === 'image' && ids.has(element.id),
        );
        importRevealControllerRef.current?.reveal({
            svg: svgRef.current,
            layer: importRevealLayerRef.current,
            images,
            isBusy: () => Boolean(isImportRevealBusy?.()) || Boolean(viewportStore?.isTransient())
                || Boolean(dragSessionStore?.isActive()),
            subscribeToCamera: viewportStore
                ? cancel => viewportStore.subscribeLive(cancel) : undefined,
        });
    }, [elements, importRevealScope, importRevealQueueRef, visiblePresentElements,
        isInteracting, isActivePresentation, viewDesaturate, viewDimUnselected, croppingState,
        isImportRevealBusy, viewportStore, dragSessionStore, svgRef]);

    // Alt+拖拽图片元素 → 原生拖出（捕获阶段拦截，画布移动手势不启动）。
    const handleAltDragOutCapture = (event: React.MouseEvent) => {
        if (!event.altKey || event.button !== 0) return;
        const targetId = (event.target as SVGElement).getAttribute?.('data-element-id') ?? null;
        const image = findDragOutImage(targetId, elements);
        if (!image) return;
        event.stopPropagation();
        event.preventDefault();
        beginNativeDragOut(image, event.clientX, event.clientY);
    };

    // The right-button gesture has its own small session, never a canvas edit
    // session. A click shows the original menu; only a thresholded drag moves
    // the native app window, without mutating image or camera state.
    const windowMove = useCanvasWindowMove({
        svgRef, platform: windowPlatform, showMenu: showCanvasMenu, dismissMenu: dismissCanvasMenu,
    });
    const imageAtEvent = (target: EventTarget): ImageElement | null => {
        const id = target instanceof globalThis.Element
            ? target.closest('g[data-id]')?.getAttribute('data-id') : null;
        return (elements.find((element): element is ImageElement => element.id === id && element.type === 'image') ?? null);
    };
    const handleCanvasDownCapture = (event: React.MouseEvent<SVGSVGElement>) => {
        if (event.button === 2) { windowMove.onMouseDownCapture(event); return; }
        // The second mousedown in a double-click must not start a new image
        // drag/resize; the subsequent dblclick will commit the camera once.
        if (event.button === 0 && event.detail >= 2 && activeTool === 'select'
            && !event.altKey && !croppingState && !editingElement && !isActivePresentation
            && imageAtEvent(event.target)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        handleAltDragOutCapture(event);
    };
    const handleCanvasDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
        if (event.button !== 0 || event.altKey || activeTool !== 'select'
            || croppingState || editingElement || isActivePresentation) return;
        const image = imageAtEvent(event.target);
        if (!image) return; // frame/text's original double-click behavior remains intact
        event.preventDefault();
        event.stopPropagation();
        focusImage(image.id);
    };

    const toolbarKernel = tryKernel();
    if (toolbarKernel?.has(WORKSPACE_UI_BRIDGE_SERVICE)) {
        const bridge = toolbarKernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService;
        bridge.current.selectionOverlay = {
            zoom: viewportZoom,
            selectedElementIds,
            elements: presentElements,
            singleSelectedElement,
            croppingState,
            editingElement,
            aiRotationState,
            handleCopySelection,
            handleGroup,
            handleRasterizeSelection,
            handleSelectionPropertyChange,
            handleAlignSelection,
            handleMasonryLayout,
            handleCopyElement,
            handleFrameAspectRatioChange,
            handleUngroup,
            handleMergeGroup,
            handleDownloadImage,
            handleStartCrop,
            handlePropertyChange,
            handleDeleteElement,
            t,
        };
    }

    return (
        <div className="flex-grow relative overflow-hidden">
            <CanvasBackdrop active={!isActivePresentation} ref={backdropRef} />
            <CanvasScreenGrid
                active={gridVisible && !isActivePresentation}
                ref={screenGridRef}
            />
            {/* 相机 transform 载体：内层 <g>（ADR-051）。有 store 时由 imperative 层独占
                （live 值直接写 group.style.transform，避免 React 与 rAF 互相覆盖），无 store 时
                由 React 渲染。svg 根不得携带相机 transform/will-change（真机证伪，见 ADR-051）。
                点阵与对齐网格在这层外面（视口 CSS），避免 40 万像素 pattern 跟着图片一起重栅格。 */}
            <svg
                ref={svgRef}
                className="relative z-10 w-full h-full block"
                onMouseDownCapture={handleCanvasDownCapture}
                onDoubleClick={handleCanvasDoubleClick}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
                onWheel={handleWheel}
                onContextMenu={handleContextMenu}
                style={{ cursor, touchAction: 'none' }}
            >
                {/* defs 里的 clipPath 是绝对坐标：必须拿呈现层，否则拖动圆角图片时裁剪区留在原地。 */}
                <SVGDefs elements={presentElements} />

                {/* 使用 will-change: transform 提示浏览器对该图层进行优化；
                    有相机 store 时 transform 由 imperative 层独占（避免 React 与 rAF 互相覆盖）。 */}
                <g
                    ref={viewportGroupRef}
                    style={viewportStore
                        ? { willChange: 'transform' }
                        : { transform: canvasTransform, willChange: 'transform' }}
                >
                    {/* PureRef 对齐 ⑤：一键去色（整层滤镜，仅内容层不含选择手柄） */}
                    <g style={viewDesaturate ? { filter: 'grayscale(1)' } : undefined}>
                    {visiblePresentElements.map(el => {
                            // PureRef 对齐 ⑤：暗化非选中（仅在有选区时生效）
                            const dimmed = viewDimUnselected
                                && selectedElementIds.length > 0
                                && !selectedElementIdSet.has(el.id);
                            const movesByTransform = translateImageBatch && dragElementIds?.has(el.id);
                            // P0-1：单张卡片是否降档（= 是否放弃高清原图）只看它自己有没有在被变换。
                            const interacting = contentInteractionStore
                                ? Boolean(contentInteractingIds?.has(el.id))
                                : isInteracting;
                            // Only groups need moving children to calculate their bounds.
                            // A flat card must never receive the changing full image array:
                            // React 19 dev would deep-diff it once PER visible selected card.
                            const card = (
                                <g key={el.id}
                                    transform={movesByTransform ? `translate(${dragOffset.x} ${dragOffset.y})` : undefined}
                                    data-bp-drag-x={movesByTransform ? dragOffset.x : undefined}
                                    data-bp-drag-y={movesByTransform ? dragOffset.y : undefined}
                                >
                                    <CanvasElement
                                        element={el}
                                        elements={el.type === 'group' ? presentElements : elements}
                                        selectedElementIds={selectedElementIds}
                                        zoom={elementZoom}
                                        editingElement={editingElement}
                                        croppingState={croppingState}
                                        aiRotationState={aiRotationState}
                                        setEditingElement={setEditingElement}
                                        isInteracting={interacting}
                                    />
                                </g>
                            );
                            return dimmed ? (
                                <g key={`dim-${el.id}`} style={{ filter: 'brightness(0.5) saturate(0.75)' }}>
                                    {card}
                                </g>
                            ) : card;
                    })}
                    </g>

                    <SelectionHandles
                        selectedElementIds={selectedElementIds}
                        elements={presentElements}
                        zoom={viewportZoom}
                        croppingState={croppingState}
                        aiRotationState={aiRotationState}
                        isDragging={isDraggingElements}
                    />

                    <CanvasOverlays
                        zoom={viewportZoom}
                        lassoPath={lassoPath}
                        alignmentGuides={alignmentGuides}
                        selectionBox={selectionBox}
                    />

                    {/* P0-3：框选/套索"将被选中"的实时高亮。逐帧写入 store 的瞬时集合，
                        由该层自己按 data-preview-id 增量切换属性 —— 不经过 React 状态，
                        所以框选期间不会每帧触发一次整板元素的重渲染。 */}
                    {selectionPreviewStore && (
                        <SelectionPreviewOverlay store={selectionPreviewStore} zoom={viewportZoom} />
                    )}
                    {toolbarKernel && (
                        <PluginOverlayHost kernel={toolbarKernel} zoom={viewportZoom} />
                    )}

                    {/* 拖动中卸掉选区工具条（ElementToolbar / SelectionToolbar）：它按选区几何
                        摆位，拖动期间只会跟着图片一起走。卸掉而不是藏起来，省掉每帧渲染一条
                        不会再被点的 HTML 工具条；松手后按新位置重新挂出。 */}
                    {toolbarKernel && !isDraggingElements && (
                        <CanvasToolbarHost kernel={toolbarKernel} placement="selection-overlay" />
                    )}
                    
                    {croppingState && (
                        <CroppingOverlay zoom={viewportZoom} croppingState={croppingState} />
                    )}

                    <EditingOverlay
                        zoom={viewportZoom}
                        editingElement={editingElement}
                        elements={elements}
                        setEditingElement={setEditingElement}
                        handleStopEditing={handleStopEditing}
                        setElements={setElements}
                    />

                    <RotationOverlays
                        zoom={viewportZoom}
                        aiRotationState={aiRotationState}
                        interactionMode={interactionMode}
                        rotateStartInfo={rotateStartInfo}
                        rotateDialPoint={rotateDialPoint}
                        elements={elements}
                    />
                </g>
            </svg>
            {/* One short-lived HTML compositor layer, above the SVG but inert to pointer input. */}
            <div ref={importRevealLayerRef} aria-hidden="true"
                className="absolute inset-0 z-[11] overflow-hidden pointer-events-none" />
        </div>
    );
};

/**
 * 性能遥测包裹（builtin/perf-monitor 消费）：Profiler 只包一层整体画布，
 * 卡片级归因在 CanvasElement 内部按元素类型挂（见 components/CanvasElement.tsx）。
 * production 构建下 actualDuration 恒为 0，recordProfilerRender 自动忽略，零数据噪音。
 */
export const MainCanvas: React.FC<MainCanvasProps> = props => (
    <React.Profiler id="MainCanvas" onRender={recordProfilerRender}>
        <MainCanvasBase {...props} />
    </React.Profiler>
);
