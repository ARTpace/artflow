
import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import type { 
    Point, Element, Tool, Rect, Guide, AIRotationState, 
    ImageElement, PathElement, ShapeElement, FrameElement, 
    ArrowElement, LineElement, TextElement, WheelAction
} from '../types';
import { 
    generateId, rotatePoint, getElementBounds, isBoxElement, isPointInPolygon, 
    getSelectableElement, getDescendants, getSelectionBounds, getCanvasScreenRect
} from '../utils/canvasUtils';
import { SNAP_THRESHOLD } from '../constants';
import { getLassoBounds, queryInteractionCandidates } from '../utils/interaction-spatial-query';
import type { InteractionViewportIndexReader } from '../utils/interaction-spatial-query';
import { createDragSnapGuideSnapshot } from '../utils/drag-snap-guide-index';
import type { DragSnapGuideSnapshot } from '../utils/drag-snap-guide-index';
import { resolveContainingFrame } from '../utils/frame-parenting';
import type { CanvasViewportStore } from '../utils/viewport-store';
import { DRAG_MOVED_MIN_SCREEN_PX, useElementDragMoved, type CanvasDragSessionStore } from '../utils/drag-session-store';
import type { ContentInteractionStore } from '../utils/content-interaction-store';
import type { SelectionPreviewStore } from '../utils/selection-preview-store';
import type { ElementTransformSessionStore } from '../utils/element-transform-session';
import { resolveResizedElement, resolveRotatedElement } from '../utils/gesture-transform';
import {
    applySelectionModifiers,
    NO_SELECTION_MODIFIERS,
    pickElementsInBox,
    pickElementsInLasso,
    resolvePreviewMode,
    resolveSelectionModifiers,
} from '../utils/marquee-selection';
import type { SelectionModifiers } from '../utils/marquee-selection';
import { applyDragCommit } from '../utils/drag-commit';
import { normalizeWheelDelta, resolveWheelZoomFactor } from '../utils/wheel-input';

/** 滚轮手势静默多久算结束（结束后提交一次相机到文档状态）。 */
const WHEEL_GESTURE_IDLE_MS = 200;
const MIN_CANVAS_ZOOM = 0.02;
const MAX_CANVAS_ZOOM = 10;

interface PointerMoveSnapshot {
    clientX: number;
    clientY: number;
    shiftKey: boolean;
    /** P0-2：Ctrl 与 Shift 同义（加选），同样按帧快照，避免中途按下/松开读到旧值。 */
    ctrlKey: boolean;
    /** Alt 只在框选/套索里被读（减选），与 shiftKey 一起按帧快照，避免中途松手读到旧值。 */
    altKey: boolean;
}

interface CanvasInteractionsProps {
    elements: Element[];
    zoom: number;
    panOffset: Point;
    activeTool: Tool;
    drawingOptions: { strokeColor: string; strokeWidth: number; opacity: number };
    selectedElementIds: string[];
    setSelectedElementIds: (ids: string[] | ((prev: string[]) => string[])) => void;
    setElements: (updater: (prev: Element[]) => Element[], commit?: boolean) => void;
    updateActiveBoard: (updater: (board: any) => any) => void;
    commitAction: (updater: (prev: Element[]) => Element[]) => void;
    setEditingElement: (el: { id: string; text: string } | null) => void;
    setCroppingState: (state: any | null) => void;
    croppingState: any | null;
    setSelectionBox: (box: Rect | null) => void;
    selectionBox: Rect | null;
    setAlignmentGuides: (guides: Guide[]) => void;
    setLassoPath: (path: Point[] | null) => void;
    lassoPath: Point[] | null;
    setAiRotationState: (state: AIRotationState | null) => void;
    aiRotationState: AIRotationState | null;
    setRotateDialPoint: (point: Point | null) => void;
    setActiveTool: (tool: Tool) => void;
    addElementsWithParenting: (elements: Element[]) => void;
    svgRef: React.RefObject<SVGSVGElement>;
    editingElement?: { id: string; text: string } | null;
    wheelAction: WheelAction;
    getCanvasPoint: (x: number, y: number) => Point;
    onAIRotateFinish?: (state: AIRotationState) => void;
    /** Optional R14 MainCanvas-owned live index snapshot; stale snapshots fail closed to full scan. */
    interactionViewportIndexRef?: InteractionViewportIndexReader;
    /** PureRef 对齐 ③：网格吸附（对齐参考线未命中时兜底）。 */
    gridSnap?: boolean;
    gridSize?: number;
    /**
     * 相机瞬时通道（P1-B'）：存在时平移/缩放只写 store，手势结束才提交一次文档状态；
     * 不存在时保持旧的"每帧 updateActiveBoard"行为。
     */
    viewportStore?: CanvasViewportStore;
    /**
     * 拖动会话瞬时通道（P1-B）：存在时拖动只写 store，mouseup 才一次性提交位移与父级；
     * 不存在时保持旧的"逐帧 setElements"行为。
     */
    dragSessionStore?: CanvasDragSessionStore;
    /**
     * 内容变换瞬时通道（P0-1）：存在时只有**正在被变换**的元素按代理档渲染，
     * 拖小元素不再让整板图片降档；不存在时回落到旧的"手势中全板降档"行为。
     */
    contentInteractionStore?: ContentInteractionStore;
    /**
     * 框选/套索预览瞬时通道（P0-3）：存在时框选/套索逐帧发布"将被选中"高亮（只写通道、
     * 不写 React 状态）；不存在时保持旧的"只在 mouseup 结算"行为。
     */
    selectionPreviewStore?: SelectionPreviewStore;
    /**
     * 几何变换会话瞬时通道（P1-1）：存在时缩放/旋转/绘制（resize / rotate / draw*）
     * 逐帧只写通道、不写文档状态；手势结束一次性提交（一条撤销记录）。
     * 不存在时这些手势回落到旧的逐帧 setElements(..., false) 行为。
     */
    transformSessionStore?: ElementTransformSessionStore;
}

export const useCanvasInteractions = ({
    elements,
    zoom,
    panOffset,
    activeTool,
    drawingOptions,
    selectedElementIds,
    setSelectedElementIds,
    setElements,
    updateActiveBoard,
    commitAction,
    setEditingElement,
    setCroppingState,
    croppingState,
    setSelectionBox,
    selectionBox,
    setAlignmentGuides,
    setLassoPath,
    lassoPath,
    setAiRotationState,
    aiRotationState,
    setRotateDialPoint,
    setActiveTool,
    addElementsWithParenting,
    svgRef,
    editingElement,
    wheelAction,
    getCanvasPoint,
    onAIRotateFinish,
    interactionViewportIndexRef,
    gridSnap = false,
    gridSize = 32,
    viewportStore,
    dragSessionStore,
    contentInteractionStore,
    selectionPreviewStore,
    transformSessionStore,
}: CanvasInteractionsProps) => {
    const interactionMode = useRef<string | null>(null);
    const startPoint = useRef<Point>({ x: 0, y: 0 });
    // 框选/套索：这类手势画的是"选择框"，指针必须能拖出画布边界继续画（见 beginGlobalSelectionGesture）。
    const isSelectionBoxGesture = (mode: string | null): boolean => mode === 'selectBox' || mode === 'lasso';
    /**
     * P1-1：走"变换瞬时通道"的手势族 —— 缩放/旋转/绘制。
     * 它们和拖动一样：指针可能滑出画布、松手点可能落在侧栏上，必须由窗口级跟踪收尾
     * （见 beginGlobalTransformGesture），否则会丢 mouseup 或"拖到边界被就地结账"。
     */
    const isTransformGesture = (mode: string | null): boolean => Boolean(mode) && (
        (mode as string).startsWith('resize-')
        || mode === 'rotate'
        || mode === 'draw'
        || mode === 'drawShape'
        || mode === 'drawFrame'
        || mode === 'drawArrow'
        || mode === 'drawLine'
    );
    const currentDrawingElementId = useRef<string | null>(null);
    const resizeStartInfo = useRef<{ originalElement: Element; startCanvasPoint: Point; handle: string; } | null>(null);
    const rotateStartInfo = useRef<{ originalElement: Element; center: Point; startCanvasPoint: Point; } | null>(null);
    const cropStartInfo = useRef<{ originalCropBox: Rect, startCanvasPoint: Point } | null>(null);
    const dragStartElementPositions = useRef<Map<string, {x: number, y: number} | Point[]>>(new Map());
    // R15: flat drag's static global guides and moving source order live only for the active gesture.
    const dragSnapGuideSnapshotRef = useRef<DragSnapGuideSnapshot | null>(null);
    const dragMovingElementsRef = useRef<Element[]>([]);
    
    // Performance optimization: Track interaction state to downgrade image quality during active use
    const [isInteracting, setIsInteracting] = useState(false);
    const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Pointer devices can dispatch hundreds of events per second. Keep only the latest
    // absolute sample and apply at most one React/canvas update per animation frame.
    const pendingPointerMoveRef = useRef<PointerMoveSnapshot | null>(null);
    const pointerMoveFrameRef = useRef<number | null>(null);
    // Installed only for an active mouse card drag. SVG mouseleave is not a
    // release: the pointer can travel through sidebars/outside the window and
    // return while the button is still held.
    const windowDragCleanupRef = useRef<(() => void) | null>(null);
    const liveWindowDragHandlersRef = useRef<{
        move: (event: MouseEvent) => void;
        finish: () => void;
        cancel: () => void;
    } | null>(null);
    // P1-B': pan/zoom 手势的瞬时通道。滚轮事件按 rAF 合并，手势结束（或静默）才提交一次相机。
    const [isViewportGesture, setIsViewportGesture] = useState(false);
    /**
     * 一帧内合并的滚轮样本。
     * deltaX/deltaY 是**相对增量 → 必须累加**（一帧多个事件时覆盖就等于丢输入）；
     * clientX/clientY 是绝对锚点 → 保留最新值。
     */
    const pendingWheelRef = useRef<{
        deltaX: number;
        deltaY: number;
        clientX: number;
        clientY: number;
        zoomIntent: boolean;
    } | null>(null);
    const wheelFrameRef = useRef<number | null>(null);
    const wheelRectRef = useRef<{ left: number; top: number } | null>(null);
    const panGestureRef = useRef<{ pointerX: number; pointerY: number; basePan: Point; zoom: number } | null>(null);
    // Mirrors for transient state that mouseup must read synchronously after flushing
    // a queued pointer sample (React state updates may still be batched at that point).
    const latestAiRotationStateRef = useRef<AIRotationState | null>(aiRotationState);
    const latestSelectionBoxRef = useRef<Rect | null>(selectionBox);
    const latestLassoPathRef = useRef<Point[] | null>(lassoPath);
    latestAiRotationStateRef.current = aiRotationState;
    latestSelectionBoxRef.current = selectionBox;
    latestLassoPathRef.current = lassoPath;

    // P0-2：框选/套索的修饰键、以及"将被选中"的 id 集合，只存在 ref 里。
    // 它们每帧都在变，但没有任何东西需要因此重渲染（配色由通道快照自己带），
    // 放进 state 等于每次移动都多一轮 App 渲染。
    const marqueeModifiersRef = useRef<SelectionModifiers>(NO_SELECTION_MODIFIERS);
    const marqueePreviewIdsRef = useRef<readonly string[]>([]);
    // P0-1：正在被变换（值得降档）的元素集合。只有它真的变了（含空↔非空）才发通道通知，
    // 否则"一次拖动 = 几十次全板图片档位重算"。
    const contentInteractionIdsRef = useRef<ReadonlySet<string> | null>(null);

    /**
     * P0-1：声明"这批元素正在被变换"。热路径上每帧调用，所以先在这里比一次，
     * 内容没变就一个字节都不发 —— 通道每次通知都会让整板图片重算档位。
     */
    const refreshContentInteraction = (ids: Iterable<string>) => {
        if (!contentInteractionStore) return;
        const next = new Set(ids);
        const current = contentInteractionIdsRef.current;
        const unchanged = current !== null
            && current.size === next.size
            && Array.from(next).every(id => current.has(id));
        if (unchanged) return;
        contentInteractionIdsRef.current = next;
        contentInteractionStore.begin(next);
    };

    const resetContentInteraction = () => {
        if (contentInteractionIdsRef.current === null) return;
        contentInteractionIdsRef.current = null;
        contentInteractionStore?.end();
    };

    /**
     * P1-1：读取某个元素"当前可见的几何"。会话内优先取变换通道里的预览，
     * 否则回落文档 —— 绘制类手势要在自己上一帧的预览上继续累积（画Path 追加点、拉箭头换端点）。
     */
    const readLiveElement = (id: string): Element | null => {
        const active = transformSessionStore?.getSnapshot().element;
        if (active && active.id === id) return active;
        return elements.find(element => element.id === id) ?? null;
    };

    /**
     * P1-1：发布变换预览。**逐帧只写瞬时通道，不写文档状态** ——
     * 这就是"缩放/旋转/绘制不再每帧重建空间索引 + 重算可见集"的全部机制。
     * 通道缺席时回落到旧行为（仍是 commit=false，不产生撤销记录）。
     */
    const publishGesturePreview = (preview: Element) => {
        if (!transformSessionStore) {
            setElements(prev => prev.map(element => (element.id === preview.id ? preview : element)), false);
            return;
        }
        transformSessionStore.setPreview(preview);
    };

    /**
     * P1-1：结账 —— 从通道取回最终几何，**一次性**写进文档。
     * 走官方的 `commitAction` 而不是裸 setElements：撤销栈只留一条记录，
     * 且与"命令式操作"共用同一套提交语义（脏标记、按画板派发）。
     * 通道里没有东西时（未走瞬时通道的手势）回落 `commitAction(els => els)`，
     * 保持"手势结束 = 一次提交"的既有语义。
     */
    const commitGestureSession = (commitAction: (updater: (prev: Element[]) => Element[]) => void) => {
        const preview = transformSessionStore?.end() ?? null;
        if (!preview) {
            commitAction(els => els);
            return;
        }
        commitAction(els => els.map(element => (element.id === preview.id ? preview : element)));
    };

    /**
     * P1-1：兜底结账。手势还没等到 mouseup 就被打断（窗口失焦 / 画板切换 / 紧接着的下一次按下）时，
     * 把通道里的几何落盘 —— "屏幕上看到的改动"和"文档里的改动"必须一致，预览不能静默消失。
     * 返回是否真的收了一次账。
     */
    const flushOrphanTransformSession = (): boolean => {
        if (!transformSessionStore?.isActive()) return false;
        commitGestureSession(commitAction);
        resetContentInteraction();
        interactionMode.current = null;
        return true;
    };

    const resolveMarqueeModifiers = (event: { shiftKey: boolean; altKey?: boolean; ctrlKey?: boolean }): SelectionModifiers => {
        const next = resolveSelectionModifiers(event);
        marqueeModifiersRef.current = next;
        return next;
    };

    /**
     * P0-3：发布"将被选中"预览。唯一的硬要求是**不写 React 状态** ——
     * 逐帧 setSelectedElementIds 会让整棵树按帧重算，这正是本项要避开的那件事。
     * 预览几何由 marquee-selection 与 mouseup 结算共用，保证"亮着的"就是"会选中的"。
     */
    const publishSelectionPreview = () => {
        if (!selectionPreviewStore) return;
        const mode = resolvePreviewMode(marqueeModifiersRef.current);
        if (interactionMode.current === 'selectBox' && latestSelectionBoxRef.current) {
            const picks = pickElementsInBox(elements, interactionViewportIndexRef?.current ?? null, latestSelectionBoxRef.current);
            marqueePreviewIdsRef.current = picks.map(pick => pick.id);
            selectionPreviewStore.publish(mode, picks);
            return;
        }
        if (interactionMode.current === 'lasso' && latestLassoPathRef.current) {
            const picks = pickElementsInLasso(elements, interactionViewportIndexRef?.current ?? null, latestLassoPathRef.current);
            marqueePreviewIdsRef.current = picks.map(pick => pick.id);
            selectionPreviewStore.publish(mode, picks);
            return;
        }
        marqueePreviewIdsRef.current = [];
        selectionPreviewStore.clear();
    };

    useEffect(() => () => {
        windowDragCleanupRef.current?.();
        if (pointerMoveFrameRef.current !== null) cancelAnimationFrame(pointerMoveFrameRef.current);
        if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current);
        if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
    }, []);

    const [smartToolbarState, setSmartToolbarState] = useState<{
        top: number;
        left: number;
        show: boolean;
        selectionType: 'single-image' | 'multi-image' | 'none';
    }>({ top: 0, left: 0, show: false, selectionType: 'none' });

    // 元素是否真的被拖起来了（会话已开始 + 位移可见）。智能工具条贴在选区右侧，
    // 拖动中要跟着让位。只订阅 boolean：通道每帧发位移，App 不会跟着每帧重绘。
    const isDraggingElements = useElementDragMoved(dragSessionStore, zoom);

    useEffect(() => {
        // 交互（拖动/绘制/平移/缩放）期间不重算悬浮工具条位置：
        // 它依赖 getSelectionBounds + 容器 rect（强制同步布局）并在每帧 setState。
        // 注意：相机 transform 挂在 <svg> 上（ADR-049），屏幕基准用未变换的容器盒子。
        // 拖动期间冻结在原位；相机手势（含滚轮）期间先隐藏 —— 画布内容已经从它下面移走，
        // 而且滚轮期间 zoom 会按渲染通道发布，重算等于每次发布都多一次布局读取 + setState。
        if (isDraggingElements) {
            setSmartToolbarState(prev => (prev.show ? { ...prev, show: false } : prev));
            return;
        }
        if (isInteracting || isViewportGesture) {
            if (isViewportGesture) {
                setSmartToolbarState(prev => (prev.show ? { ...prev, show: false } : prev));
            }
            return;
        }
        if (selectedElementIds.length > 0 && !croppingState && !editingElement && !aiRotationState) {
            const selectionHasImages = elements.some(
                el => selectedElementIds.includes(el.id) && el.type === 'image'
            );
    
            if (selectionHasImages) {
                const bounds = getSelectionBounds(selectedElementIds, elements);
                const svgBounds = getCanvasScreenRect(svgRef.current);
                if (!svgBounds) {
                    setSmartToolbarState(prev => ({ ...prev, show: false }));
                    return;
                }
    
                const screenRight = (bounds.x + bounds.width) * zoom + panOffset.x + svgBounds.left;
                const screenCenterY = bounds.y * zoom + panOffset.y + (bounds.height * zoom / 2) + svgBounds.top;
    
                let type: 'single-image' | 'multi-image' | 'none' = 'none';
                if (selectedElementIds.length === 1 && elements.find(el => el.id === selectedElementIds[0])?.type === 'image') {
                    type = 'single-image';
                } else if (selectedElementIds.length > 1) {
                    type = 'multi-image';
                }
    
                if (type !== 'none') {
                    setSmartToolbarState({
                        top: screenCenterY,
                        left: screenRight + 10,
                        show: true,
                        selectionType: type,
                    });
                } else {
                    setSmartToolbarState(prev => ({ ...prev, show: false }));
                }
            } else {
                setSmartToolbarState(prev => ({ ...prev, show: false }));
            }
        } else {
            setSmartToolbarState(prev => ({ ...prev, show: false }));
        }
    }, [isDraggingElements, isInteracting, isViewportGesture, selectedElementIds, elements, zoom, panOffset, croppingState, editingElement, aiRotationState, svgRef]);

    const cursor = useMemo(() => {
        if (croppingState) return 'default';
        if (interactionMode.current === 'ai-rotate') return 'grabbing';
        if (aiRotationState) return 'grab';
        if (interactionMode.current === 'pan') return 'grabbing';
        if (activeTool === 'pan') return 'grab';
        if (['draw', 'erase', 'rectangle', 'circle', 'triangle', 'arrow', 'line', 'text', 'highlighter', 'lasso', 'frame'].includes(activeTool)) return 'crosshair';
        return 'default';
    }, [croppingState, aiRotationState, activeTool, interactionMode.current]);

    /**
     * 对齐参考线发布：拖动中每帧都会算一遍，但绝大多数帧内容没变。
     * 逐帧 setState 会把整棵 App 拉起来重绘（参考线只是画布上一条红线），
     * 所以有拖动通道时写通道（订阅者只有 MainCanvas），无通道时按内容去重后才 setState。
     */
    const lastPublishedGuidesRef = useRef<readonly Guide[]>([]);
    const publishAlignmentGuides = useCallback((guides: Guide[]) => {
        const last = lastPublishedGuidesRef.current;
        const unchanged = last.length === guides.length && guides.every((guide, index) => {
            const previous = last[index];
            return previous.type === guide.type
                && previous.position === guide.position
                && previous.start === guide.start
                && previous.end === guide.end;
        });
        if (unchanged) return;
        lastPublishedGuidesRef.current = guides;
        if (dragSessionStore) {
            dragSessionStore.setGuides(guides);
            return;
        }
        setAlignmentGuides(guides);
    }, [dragSessionStore, setAlignmentGuides]);

    /** 记录平移基准相机与起点指针：逐帧只写瞬时值，不再累加文档状态。 */
    const beginPanGesture = (clientX: number, clientY: number) => {
        const base = viewportStore ? viewportStore.getLive() : { panOffset, zoom };
        panGestureRef.current = {
            pointerX: clientX,
            pointerY: clientY,
            basePan: { x: base.panOffset.x, y: base.panOffset.y },
            zoom: base.zoom,
        };
        viewportStore?.beginInteraction();
        setIsViewportGesture(true);
    };

    const startCanvasGesture = (e: React.MouseEvent<SVGSVGElement>) => {
        // A new gesture must never inherit queued motion or static guides from a prior drag.
        if (pointerMoveFrameRef.current !== null) cancelAnimationFrame(pointerMoveFrameRef.current);
        // 拖动开始前必须**结清悬着的滚轮手势**：滚轮靠 200ms 空闲定时器收尾，
        // 如果滚轮后 200ms 内按下鼠标开始拖动，那个定时器会在拖动进行中触发
        // endWheelGesture（endInteraction + 状态翻转），把本次拖动从中间打断
        // （真机表现为"拖动突然失效"）。此刻还没进入任何鼠标手势，结清是安全的。
        if (wheelFrameRef.current !== null) {
            cancelAnimationFrame(wheelFrameRef.current);
            wheelFrameRef.current = null;
        }
        if (wheelTimeoutRef.current !== null) {
            clearTimeout(wheelTimeoutRef.current);
            wheelTimeoutRef.current = null;
        }
        if (pendingWheelRef.current) {
            // 用掉最后一个滚轮样本（相机落终值）；applyPendingWheel 内部会重排定时器，随后清掉。
            applyPendingWheel();
            if (wheelTimeoutRef.current !== null) {
                clearTimeout(wheelTimeoutRef.current);
                wheelTimeoutRef.current = null;
            }
        }
        if (isViewportGesture) endWheelGesture();
        pointerMoveFrameRef.current = null;
        pendingPointerMoveRef.current = null;
        // 收尾上一段滚轮相机手势，避免未提交的瞬时相机跨手势/跨画板残留。
        if (wheelFrameRef.current !== null) {
            cancelAnimationFrame(wheelFrameRef.current);
            wheelFrameRef.current = null;
        }
        pendingWheelRef.current = null;
        wheelRectRef.current = null;
        if (wheelTimeoutRef.current) {
            clearTimeout(wheelTimeoutRef.current);
            wheelTimeoutRef.current = null;
        }
        if (isViewportGesture) {
            viewportStore?.endInteraction();
            setIsViewportGesture(false);
        }
        dragSnapGuideSnapshotRef.current?.invalidate();
        dragSnapGuideSnapshotRef.current = null;
        dragMovingElementsRef.current = [];
        // P0-1：手势开始**不再**无条件置全局交互态。降档改由"内容真的变了"那一刻触发 ——
        // 位移跨过可见阈值（拖动）或尺寸真的改了（缩放/旋转），见 refreshContentInteraction 的调用点。
        setIsInteracting(true);
        // ... (MouseDown logic from App.tsx)
        const canvasStartPoint = getCanvasPoint(e.clientX, e.clientY);
        startPoint.current = { x: e.clientX, y: e.clientY };
        const target = e.target as SVGElement;
        const handleName = target.getAttribute('data-handle');

        if (e.button === 1) { // Middle button always pans, even above a resize/rotate handle.
            interactionMode.current = 'pan';
            beginPanGesture(e.clientX, e.clientY);
            e.preventDefault();
            return;
        }

        if (handleName === 'ai-rotate') {
            interactionMode.current = 'ai-rotate';
            const nextAiRotationState = aiRotationState ? ({ ...aiRotationState, currentAngle: 0, dragDirection: null }) : null;
            latestAiRotationStateRef.current = nextAiRotationState;
            setAiRotationState(nextAiRotationState);
            e.stopPropagation();
            return;
        }

        if (aiRotationState) setAiRotationState(null);

        if (croppingState) {
             if (handleName) {
                 interactionMode.current = `crop-${handleName}`;
                 cropStartInfo.current = { originalCropBox: { ...croppingState.cropBox }, startCanvasPoint: canvasStartPoint };
             }
             return;
        }

        if (activeTool === 'text') {
            const newText: Element = {
                id: generateId(), type: 'text', name: 'Text',
                x: canvasStartPoint.x, y: canvasStartPoint.y,
                width: 150, height: 40,
                text: "Text", fontSize: 24, fontColor: drawingOptions.strokeColor,
                rotation: 0,
            } as TextElement;
            addElementsWithParenting([newText]);
            setSelectedElementIds([newText.id]);
            setEditingElement({ id: newText.id, text: (newText as TextElement).text || '' });
            setActiveTool('select');
            return;
        }

        if (activeTool === 'pan') {
            interactionMode.current = 'pan';
            beginPanGesture(e.clientX, e.clientY);
            return;
        }
        
        if (handleName && activeTool === 'select' && selectedElementIds.length === 1) {
            const element = elements.find(el => el.id === selectedElementIds[0]);
            if (!element) return;
            
            if (handleName === 'rotate') {
                interactionMode.current = 'rotate';
                const bounds = getElementBounds(element, elements);
                const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
                rotateStartInfo.current = {
                    originalElement: { ...element },
                    center,
                    startCanvasPoint: canvasStartPoint,
                };
            } else {
                 interactionMode.current = `resize-${handleName}`;
                 resizeStartInfo.current = {
                    originalElement: { ...element },
                    startCanvasPoint: canvasStartPoint,
                    handle: handleName,
                };
            }
            return;
        }

        if (activeTool === 'draw' || activeTool === 'highlighter') {
            interactionMode.current = 'draw';
            const newPath: PathElement = {
                id: generateId(),
                type: 'path', name: 'Path',
                points: [canvasStartPoint],
                strokeColor: drawingOptions.strokeColor,
                strokeWidth: drawingOptions.strokeWidth,
                opacity: drawingOptions.opacity,
                rotation: 0,
                x: 0, y: 0 
            };
            currentDrawingElementId.current = newPath.id;
            setElements(prev => [...prev, newPath], false);
        } else if (activeTool === 'rectangle' || activeTool === 'circle' || activeTool === 'triangle') {
            interactionMode.current = 'drawShape';
            const newShape: ShapeElement = {
                id: generateId(),
                type: 'shape', name: activeTool.charAt(0).toUpperCase() + activeTool.slice(1),
                shapeType: activeTool as any,
                x: canvasStartPoint.x,
                y: canvasStartPoint.y,
                width: 0,
                height: 0,
                strokeColor: drawingOptions.strokeColor,
                strokeWidth: drawingOptions.strokeWidth,
                fillColor: 'transparent',
                opacity: drawingOptions.opacity,
                rotation: 0,
                borderRadius: 0,
            }
            currentDrawingElementId.current = newShape.id;
            setElements(prev => [...prev, newShape], false);
        } else if (activeTool === 'frame') {
            interactionMode.current = 'drawFrame';
            const frameCount = elements.filter(el => el.type === 'frame').length;
            const newFrame: FrameElement = {
                id: generateId(),
                type: 'frame',
                name: `Frame ${frameCount + 1}`,
                x: canvasStartPoint.x,
                y: canvasStartPoint.y,
                width: 0,
                height: 0,
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
            };
            currentDrawingElementId.current = newFrame.id;
            setElements(prev => [newFrame, ...prev], false);
        } else if (activeTool === 'arrow') {
            interactionMode.current = 'drawArrow';
            const newArrow: ArrowElement = {
                id: generateId(), type: 'arrow', name: 'Arrow',
                x: canvasStartPoint.x, y: canvasStartPoint.y,
                points: [canvasStartPoint, canvasStartPoint],
                strokeColor: drawingOptions.strokeColor, strokeWidth: drawingOptions.strokeWidth,
                rotation: 0,
            };
            currentDrawingElementId.current = newArrow.id;
            setElements(prev => [...prev, newArrow], false);
        } else if (activeTool === 'line') {
            interactionMode.current = 'drawLine';
            const newLine: LineElement = {
                id: generateId(), type: 'line', name: 'Line',
                x: canvasStartPoint.x, y: canvasStartPoint.y,
                points: [canvasStartPoint, canvasStartPoint],
                strokeColor: drawingOptions.strokeColor, strokeWidth: drawingOptions.strokeWidth,
                rotation: 0,
            };
            currentDrawingElementId.current = newLine.id;
            setElements(prev => [...prev, newLine], false);
        } else if (activeTool === 'erase') {
            interactionMode.current = 'erase';
        } else if (activeTool === 'lasso') {
            interactionMode.current = 'lasso';
            latestLassoPathRef.current = [canvasStartPoint];
            setLassoPath(latestLassoPathRef.current);
            // P0-2/P0-3：套索与框选共用同一套修饰键快照与合并逻辑（Shift/Ctrl 加选、Alt 减选）；起手先清掉上一次手势残留的高亮。
            resolveMarqueeModifiers(e);
            publishSelectionPreview();
        } else if (activeTool === 'select') {
            const clickedElementId = target.closest('[data-id]')?.getAttribute('data-id');
            const selectableElement = clickedElementId ? getSelectableElement(clickedElementId, elements) : null;
            const selectableElementId = selectableElement?.id;

            if (selectableElementId) {
                const element = elements.find(el => el.id === selectableElementId);
                if (e.detail === 2 && (element?.type === 'text' || element?.type === 'frame')) {
                     const el = element as TextElement | FrameElement;
                     setEditingElement({ id: el.id, text: el.type === 'text' ? el.text : el.name || 'Frame' });
                     return;
                }
                if (!e.shiftKey && !selectedElementIds.includes(selectableElementId)) {
                     setSelectedElementIds([selectableElementId]);
                } else if (e.shiftKey) {
                    setSelectedElementIds(prev => 
                        prev.includes(selectableElementId) ? prev.filter(id => id !== selectableElementId) : [...prev, selectableElementId]
                    );
                }
                interactionMode.current = 'dragElements';
                const idsToDrag = new Set<string>();
                 if (selectedElementIds.includes(selectableElementId)) {
                    selectedElementIds.forEach(id => {
                        const el = elements.find(e => e.id === id);
                        if (el) {
                            idsToDrag.add(id);
                            if (el.type === 'group' || el.type === 'frame') {
                                getDescendants(id, elements).forEach(desc => idsToDrag.add(desc.id));
                            }
                        }
                    });
                } else {
                    idsToDrag.add(selectableElementId);
                     if (selectableElement.type === 'group' || selectableElement.type === 'frame') {
                        getDescendants(selectableElementId, elements).forEach(desc => idsToDrag.add(desc.id));
                    }
                }

                 const initialPositions = new Map<string, {x: number, y: number} | Point[]>();
                const movingElementsAtDragStart: Element[] = [];
                elements.forEach(el => {
                    if (idsToDrag.has(el.id)) {
                        movingElementsAtDragStart.push(el);
                         if (el.type !== 'path' && el.type !== 'arrow' && el.type !== 'line') {
                            initialPositions.set(el.id, { x: el.x, y: el.y });
                        } else {
                            initialPositions.set(el.id, (el as PathElement).points);
                        }
                    }
                });
                dragStartElementPositions.current = initialPositions;
                dragMovingElementsRef.current = movingElementsAtDragStart;
                // Groups / duplicate ids / invalid bounds deliberately produce no snapshot and keep legacy scan semantics.
                dragSnapGuideSnapshotRef.current = createDragSnapGuideSnapshot(elements, idsToDrag);
                // P1-B：进入拖动会话。这一刻元素还没动，所以通道不发布任何东西（不会在 mousedown 上加一次重绘）。
                dragSessionStore?.begin(idsToDrag);

            } else {
                // P0-2：空白按下不再无条件清空选区。
                // 无修饰键 → 旧行为（以空框起手，松手即清空结果）；Shift/Ctrl（加选）、Alt（减选）
                // → 保留既有选区（加选/减选都允许从空白起手，否则"再补选一块"会先把已选的丢掉），
                // 合并发生在 mouseup，由本次手势的修饰键快照决定并集/差集。
                const marqueeModifiers = resolveMarqueeModifiers(e);
                if (!marqueeModifiers.additive && !marqueeModifiers.subtractive) {
                    setSelectedElementIds([]);
                }
                interactionMode.current = 'selectBox';
                latestSelectionBoxRef.current = { x: canvasStartPoint.x, y: canvasStartPoint.y, width: 0, height: 0 };
                setSelectionBox(latestSelectionBoxRef.current);
                // 零面积框命中的是空集合，这一步只是清掉上一次手势残留的高亮。
                publishSelectionPreview();
            }
        }
    };

    const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
        // A right-click must not cancel an in-flight image drag or start an edit tool.
        if (e.button === 2) return;
        // A board switch can cancel a drag before a native mouseup reaches us.
        // Do not let that stale interaction state leak into a new gesture.
        if (interactionMode.current === 'dragElements' && dragSessionStore && !dragSessionStore.isActive()) {
            cancelMouseDrag();
        }
        // P1-1：上一个变换手势没等到 mouseup（丢焦点 / 切画板）就又有新按下 ——
        // 先把通道里的几何结账落盘，避免"屏幕上已经改完的样子"静默回退。
        flushOrphanTransformSession();
        windowDragCleanupRef.current?.();
        startCanvasGesture(e);
        // Touch uses the hook's existing touch shim. Only a real left-button
        // mouse gesture with the transient drag store needs window listeners.
        if (e.button === 0 && e.nativeEvent?.type === 'mousedown' && dragSessionStore?.isActive()) {
            beginGlobalMouseDrag();
        } else if (e.button === 0 && e.nativeEvent?.type === 'mousedown' && isSelectionBoxGesture(interactionMode.current)) {
            // 框选/套索同样要吃掉画布外的 move/up，否则拖到边界就被 onMouseLeave 就地提交。
            beginGlobalSelectionGesture();
        } else if (e.nativeEvent?.type === 'mousedown' && isTransformGesture(interactionMode.current)) {
            // P1-1：缩放/旋转/绘制同样要吃掉画布外的 move/up —— 不然"拖到画布边缘松手"
            // 会在边界处被就地结账，或者干脆丢了 mouseup 让预览悬着。
            beginGlobalTransformGesture();
        } else if (interactionMode.current === 'pan' && e.nativeEvent?.type === 'mousedown') {
            beginGlobalMousePan(e.button === 1 ? 1 : 0);
        }
    };

    const processMouseMove = (e: PointerMoveSnapshot) => {
        if (!interactionMode.current) return;
        // P0-2：修饰键按**帧**读 —— 用户可以在拖动中途按下/松开 Shift / Ctrl 或 Alt，
        // 预览配色与松手结算都必须用同一份快照。
        resolveMarqueeModifiers(e);
        const point = getCanvasPoint(e.clientX, e.clientY);
        const startCanvasPoint = getCanvasPoint(startPoint.current.x, startPoint.current.y);

        if (interactionMode.current === 'ai-rotate') {
            const currentAiRotationState = latestAiRotationStateRef.current;
            if (!currentAiRotationState) return;
            const { center } = currentAiRotationState;
            const dx = point.x - center.x;
            const dy = point.y - center.y;

            let direction = currentAiRotationState.dragDirection;
            if (!direction) {
                direction = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
            }

            const distance = direction === 'h' ? dx : -dy; 
            const maxDistance = 150 / zoom;
            const cappedDistance = Math.max(-maxDistance, Math.min(maxDistance, distance));
            const rawAngle = (cappedDistance / maxDistance) * 90;
            const snappedAngle = Math.round(rawAngle / 15) * 15;

            const nextAiRotationState = { ...currentAiRotationState, currentAngle: snappedAngle, dragDirection: direction };
            latestAiRotationStateRef.current = nextAiRotationState;
            setAiRotationState(nextAiRotationState);
            return;
        }

        if (interactionMode.current === 'rotate') {
            if (!rotateStartInfo.current) return;
            setRotateDialPoint(point);
            const { originalElement, center, startCanvasPoint: rotateStartPoint } = rotateStartInfo.current;

            const startAngle = Math.atan2(rotateStartPoint.y - center.y, rotateStartPoint.x - center.x);
            const currentAngle = Math.atan2(point.y - center.y, point.x - center.x);
            
            const angleDiff = (currentAngle - startAngle) * (180 / Math.PI);
            let newRotation = (('rotation' in originalElement && (originalElement as any).rotation) || 0) + angleDiff;

            if (e.shiftKey) {
                newRotation = Math.round(newRotation / 15) * 15;
            }

            // P1-1：预览与提交共用这一份几何。角度真的变了才算"正在转" ——
            // 点一下手柄没转起来既不降档、也不发预览（旧代码这里也会白写一帧文档）。
            const preview = resolveRotatedElement(originalElement, newRotation);
            if (preview === originalElement) return;
            // P0-1：旋转只影响这一个元素，但角度真的变了才降档。
            refreshContentInteraction([originalElement.id]);
            publishGesturePreview(preview);
            return;
        }

        if (interactionMode.current === 'erase') {
            const eraseRadius = drawingOptions.strokeWidth / zoom;
            const idsToDelete = new Set<string>();

            elements.forEach(el => {
                if (el.type === 'path') {
                    for (let i = 0; i < el.points.length - 1; i++) {
                        const distance = Math.hypot(point.x - el.points[i].x, point.y - el.points[i].y);
                        if (distance < eraseRadius) {
                            idsToDelete.add(el.id);
                            return;
                        }
                    }
                }
            });

            if (idsToDelete.size > 0) {
                setElements(prev => prev.filter(el => !idsToDelete.has(el.id)), false);
            }
            return;
        }

        if (interactionMode.current.startsWith('resize-')) {
            if (!resizeStartInfo.current) return;
            const { originalElement, handle, startCanvasPoint: resizeStartPoint } = resizeStartInfo.current;
            
            const rotation = ('rotation' in originalElement && (originalElement as any).rotation) || 0;
            const dx = point.x - resizeStartPoint.x;
            const dy = point.y - resizeStartPoint.y;

            const angleRad = (rotation * Math.PI) / 180;
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);
            const dx_local = dx * cos + dy * sin;
            const dy_local = -dx * sin + dy * cos;
            
            const originalBounds = getElementBounds(originalElement, []);
            if (originalBounds.width === 0 && originalBounds.height === 0 && (dx_local === 0 || dy_local === 0)) return;

            let newX = originalBounds.x;
            let newY = originalBounds.y;
            let newWidth = originalBounds.width;
            let newHeight = originalBounds.height;
            
            const isProportional = originalElement.type === 'image' || (e.shiftKey && originalElement.type !== 'text');

            if (handle.includes('r')) { newWidth = originalBounds.width + dx_local; }
            if (handle.includes('l')) { newWidth = originalBounds.width - dx_local; }
            if (handle.includes('b')) { newHeight = originalBounds.height + dy_local; }
            if (handle.includes('t')) { newHeight = originalBounds.height - dy_local; }
            
            if (isProportional && originalBounds.width > 0 && originalBounds.height > 0) {
                const aspectRatio = originalBounds.width / originalBounds.height;
                if ((handle.includes('r') || handle.includes('l'))) {
                    newHeight = newWidth / aspectRatio;
                } else {
                    newWidth = newHeight * aspectRatio;
                }
            }

            const minWidth = originalElement.type === 'reader' ? 280 : originalElement.type === 'comic' ? 220 : 1;
            const minHeight = originalElement.type === 'reader' ? 360 : originalElement.type === 'comic' ? 280 : 1;
            if (newWidth < minWidth) newWidth = minWidth;
            if (newHeight < minHeight) newHeight = minHeight;
            
            const originalCenter = { x: originalBounds.x + originalBounds.width / 2, y: originalBounds.y + originalBounds.height / 2 };
            
            let pivot_local: Point = { x: 0, y: 0 };
            if (handle.includes('t')) { pivot_local.y = originalBounds.y + originalBounds.height; } else if (handle.includes('b')) { pivot_local.y = originalBounds.y; } else { pivot_local.y = originalCenter.y; }
            if (handle.includes('l')) { pivot_local.x = originalBounds.x + originalBounds.width; } else if (handle.includes('r')) { pivot_local.x = originalBounds.x; } else { pivot_local.x = originalCenter.x; }
            
            const pivot_world = rotatePoint(pivot_local, originalCenter, rotation);
            
            let tempX = originalBounds.x;
            let tempY = originalBounds.y;
            if (handle.includes('l')) { tempX = originalBounds.x + originalBounds.width - newWidth; }
            if (handle.includes('t')) { tempY = originalBounds.y + originalBounds.height - newHeight; }

            const temp_center = { x: tempX + newWidth / 2, y: tempY + newHeight / 2 };
            
            let new_pivot_local: Point = {x: 0, y: 0};
            if (handle.includes('t')) { new_pivot_local.y = tempY + newHeight; } else if (handle.includes('b')) { new_pivot_local.y = tempY; } else { new_pivot_local.y = temp_center.y; }
            if (handle.includes('l')) { new_pivot_local.x = tempX + newWidth; } else if (handle.includes('r')) { new_pivot_local.x = tempX; } else { new_pivot_local.x = temp_center.x; }
            
            const new_pivot_world = rotatePoint(new_pivot_local, temp_center, rotation);
            
            const dx_world = pivot_world.x - new_pivot_world.x;
            const dy_world = pivot_world.y - new_pivot_world.y;
            
            const finalX = tempX + dx_world;
            const finalY = tempY + dy_world;

            const scaleX = originalBounds.width > 0 ? newWidth / originalBounds.width : 1;
            const scaleY = originalBounds.height > 0 ? newHeight / originalBounds.height : 1;
            // P0-1：缩放只影响这一个元素，但它确实"正在变" —— 尺寸真的改了才降档
            // （按住手柄没动不该降档）。
            if (scaleX === 1 && scaleY === 1) return;
            refreshContentInteraction([originalElement.id]);
            // P1-1：逐帧只写瞬时通道。预览元素与松手提交的那一条**同一份几何**，
            // 所以拿手柄松手不会跳；文档状态在整段手势里一个字节都没动。
            publishGesturePreview(resolveResizedElement(originalElement, {
                bounds: originalBounds,
                x: finalX,
                y: finalY,
                width: newWidth,
                height: newHeight,
                scaleX,
                scaleY,
            }));
            return;
        }

        if (interactionMode.current.startsWith('crop-')) {
            if (!croppingState || !cropStartInfo.current) return;
            const handle = interactionMode.current.split('-')[1];
            const { originalCropBox, startCanvasPoint: cropStartPoint } = cropStartInfo.current;
            let x = originalCropBox.x;
            let y = originalCropBox.y;
            let width = originalCropBox.width;
            let height = originalCropBox.height;

            const { originalElement } = croppingState;
            const dx = point.x - cropStartPoint.x;
            const dy = point.y - cropStartPoint.y;

            if (handle.includes('r')) { width = originalCropBox.width + dx; }
            if (handle.includes('l')) { width = originalCropBox.width - dx; x = originalCropBox.x + dx; }
            if (handle.includes('b')) { height = originalCropBox.height + dy; }
            if (handle.includes('t')) { height = originalCropBox.height - dy; y = originalCropBox.y + dy; }
            
            if (x < originalElement.x) {
                width += x - originalElement.x;
                x = originalElement.x;
            }
            if (y < originalElement.y) {
                height += y - originalElement.y;
                y = originalElement.y;
            }
            if (x + width > originalElement.x + originalElement.width) {
                width = originalElement.x + originalElement.width - x;
            }
            if (y + height > originalElement.y + originalElement.height) {
                height = originalElement.y + originalElement.height - y;
            }

            if (width < 1) {
                width = 1;
                if (handle.includes('l')) { x = originalCropBox.x + originalCropBox.width - 1; }
            }
            if (height < 1) {
                height = 1;
                if (handle.includes('t')) { y = originalCropBox.y + originalCropBox.height - 1; }
            }
            
            setCroppingState((currentCroppingState: any) => {
                if (!currentCroppingState) return null;
                const newCropBox: Rect = { x, y, width, height };
                return { ...currentCroppingState, cropBox: newCropBox };
            });
            return;
        }

        switch(interactionMode.current) {
            case 'pan': {
                const panGesture = panGestureRef.current;
                if (viewportStore && panGesture) {
                    // 相对手势起点的绝对位移：不累加、不产生文档写入，单帧只更新瞬时相机。
                    viewportStore.setTransient({
                        zoom: panGesture.zoom,
                        panOffset: {
                            x: panGesture.basePan.x + (e.clientX - panGesture.pointerX),
                            y: panGesture.basePan.y + (e.clientY - panGesture.pointerY),
                        },
                    });
                    break;
                }
                const dx = e.clientX - startPoint.current.x;
                const dy = e.clientY - startPoint.current.y;
                updateActiveBoard(b => ({ ...b, panOffset: { x: b.panOffset.x + dx, y: b.panOffset.y + dy } }));
                startPoint.current = { x: e.clientX, y: e.clientY };
                break;
            }
            case 'draw': {
                // P1-1：手绘路径是**累积**的 —— 在通道里的上一帧预览上追加一个点，
                // 只发预览（可见集/空间索引不再每帧重算）。文档在 mouseup 一次性落盘。
                const livePath = currentDrawingElementId.current ? readLiveElement(currentDrawingElementId.current) : null;
                if (livePath && livePath.type === 'path') {
                    publishGesturePreview({ ...livePath, points: [...livePath.points, point] });
                }
                break;
            }
            case 'lasso': {
                const nextLassoPath = latestLassoPathRef.current ? [...latestLassoPathRef.current, point] : [point];
                latestLassoPathRef.current = nextLassoPath;
                setLassoPath(nextLassoPath);
                // P0-3：轨迹是**累积**的，套索每帧都换形状，所以这里必须重算命中；
                // 结果只写瞬时通道，不写 React 状态。
                publishSelectionPreview();
                break;
            }
            case 'drawShape':
            case 'drawFrame': {
                // P1-1：拖框期间只发预览；框的几何由指针绝对位置算出，与旧代码逐字等价。
                const liveBox = currentDrawingElementId.current ? readLiveElement(currentDrawingElementId.current) : null;
                if (liveBox && (liveBox.type === 'shape' || liveBox.type === 'frame')) {
                    let newWidth = Math.abs(point.x - startCanvasPoint.x);
                    let newHeight = Math.abs(point.y - startCanvasPoint.y);
                    let newX = Math.min(point.x, startCanvasPoint.x);
                    let newY = Math.min(point.y, startCanvasPoint.y);

                    if (e.shiftKey && liveBox.type === 'shape') {
                        if (liveBox.shapeType === 'rectangle' || liveBox.shapeType === 'circle') {
                            const side = Math.max(newWidth, newHeight);
                            newWidth = side;
                            newHeight = side;
                        } else if (liveBox.shapeType === 'triangle') {
                            newHeight = newWidth * (Math.sqrt(3) / 2);
                        }

                        if (point.x < startCanvasPoint.x) newX = startCanvasPoint.x - newWidth;
                        if (point.y < startCanvasPoint.y) newY = startCanvasPoint.y - newHeight;
                    }

                    publishGesturePreview({ ...liveBox, x: newX, y: newY, width: newWidth, height: newHeight });
                }
                break;
            }
            case 'drawArrow': {
                // P1-1：拉箭头 = 换第二个端点；起点取上一帧预览的 points[0]。
                const liveArrow = currentDrawingElementId.current ? readLiveElement(currentDrawingElementId.current) : null;
                if (liveArrow && liveArrow.type === 'arrow') {
                    publishGesturePreview({ ...liveArrow, points: [liveArrow.points[0], point] });
                }
                break;
            }
            case 'drawLine': {
                const liveLine = currentDrawingElementId.current ? readLiveElement(currentDrawingElementId.current) : null;
                if (liveLine && liveLine.type === 'line') {
                    publishGesturePreview({ ...liveLine, points: [liveLine.points[0], point] });
                }
                break;
            }
            case 'dragElements': {
                const dx = point.x - startCanvasPoint.x;
                const dy = point.y - startCanvasPoint.y;
                // P0-1：只有位移在**屏幕上真的看得见**，这批元素才需要降档渲染。
                // 单纯按下（手抖一两个像素）不降档 —— 否则每次普通点选都会让整屏图片闪一次档位。
                // 阈值与"元素是否真的被拖起来了"共用同一个常量，两处判据不会漂移。
                if (Math.hypot(dx, dy) * zoom >= DRAG_MOVED_MIN_SCREEN_PX) {
                    refreshContentInteraction(dragStartElementPositions.current.keys());
                }
                
                const movingElementIds = Array.from(dragStartElementPositions.current.keys());
                const movingElementIdSet = new Set(movingElementIds);
                const snapThresholdCanvas = SNAP_THRESHOLD / zoom;

                // R15 snapshots only static flat guides. A ref mismatch is deliberately not reused.
                let dragSnapGuideSnapshot = dragSnapGuideSnapshotRef.current;
                if (dragSnapGuideSnapshot && !dragSnapGuideSnapshot.isCurrent(elements)) {
                    dragSnapGuideSnapshot.invalidate();
                    dragSnapGuideSnapshotRef.current = null;
                    dragSnapGuideSnapshot = null;
                }
                // On the supported path this avoids a full elements filter per pointer move.
                const movingElements = dragSnapGuideSnapshot
                    ? dragMovingElementsRef.current
                    : elements.filter(el => movingElementIdSet.has(el.id));

                let finalDx = dx;
                let finalDy = dy;
                let activeGuides: Guide[] = [];

                // Alignment Snapping
                const getSnapPoints = (bounds: Rect) => ({
                    v: [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width],
                    h: [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height],
                });

                // Unsupported/changed input retains the exact legacy Set build and scan path.
                const staticSnapPoints = dragSnapGuideSnapshot ? null : { v: new Set<number>(), h: new Set<number>() };
                if (staticSnapPoints) {
                    const otherElements = elements.filter(el => !movingElementIdSet.has(el.id));
                    otherElements.forEach(el => {
                        const bounds = getElementBounds(el, elements);
                        getSnapPoints(bounds).v.forEach(p => staticSnapPoints.v.add(p));
                        getSnapPoints(bounds).h.forEach(p => staticSnapPoints.h.add(p));
                    });
                }
                
                let bestSnapX = { dist: Infinity, val: finalDx, guide: null as Guide | null };
                let bestSnapY = { dist: Infinity, val: finalDy, guide: null as Guide | null };
                
                movingElements.forEach(movingEl => {
                    const startPos = dragStartElementPositions.current.get(movingEl.id);
                    if (!startPos) return;

                    // Only the transient-store path keeps all group children at gesture-start positions.
                    // Legacy document updates move children each frame, so retain their live recursive bounds.
                    const cachedBounds = dragSessionStore ? dragSnapGuideSnapshot?.getMovingBounds(movingEl.id) : undefined;
                    let movingBounds: Rect = cachedBounds ?? { x: 0, y: 0, width: 0, height: 0 };
                    if (cachedBounds) {
                        // Reuse geometry already computed while creating this current gesture snapshot.
                    } else if (movingEl.type !== 'path' && movingEl.type !== 'arrow' && movingEl.type !== 'line') {
                        movingBounds = getElementBounds({...movingEl, x: (startPos as Point).x, y: (startPos as Point).y } as any, elements);
                    } else { 
                        if (movingEl.type === 'arrow' || movingEl.type === 'line') {
                            movingBounds = getElementBounds({...movingEl, points: startPos as [Point, Point]} as any, elements);
                        } else {
                            movingBounds = getElementBounds({...movingEl, points: startPos as Point[]} as any, elements);
                        }
                    }

                    const movingSnapPoints = getSnapPoints(movingBounds);
                    movingSnapPoints.v.forEach(p => {
                        const consider = (staticP: number) => {
                            const dist = Math.abs((p + finalDx) - staticP);
                            if (dist < snapThresholdCanvas && dist < bestSnapX.dist) {
                                bestSnapX = { dist, val: staticP - p, guide: { type: 'v', position: staticP, start: movingBounds.y, end: movingBounds.y + movingBounds.height }};
                            }
                        };
                        if (dragSnapGuideSnapshot) {
                            const match = dragSnapGuideSnapshot.vertical.findNearest(p + finalDx, snapThresholdCanvas);
                            if (match) consider(match.value);
                        } else {
                            staticSnapPoints!.v.forEach(consider);
                        }
                    });
                    movingSnapPoints.h.forEach(p => {
                        const consider = (staticP: number) => {
                            const dist = Math.abs((p + finalDy) - staticP);
                            if (dist < snapThresholdCanvas && dist < bestSnapY.dist) {
                                bestSnapY = { dist, val: staticP - p, guide: { type: 'h', position: staticP, start: movingBounds.x, end: movingBounds.x + movingBounds.width }};
                            }
                        };
                        if (dragSnapGuideSnapshot) {
                            const match = dragSnapGuideSnapshot.horizontal.findNearest(p + finalDy, snapThresholdCanvas);
                            if (match) consider(match.value);
                        } else {
                            staticSnapPoints!.h.forEach(consider);
                        }
                    });
                });
                
                if (bestSnapX.guide) { finalDx = bestSnapX.val; activeGuides.push(bestSnapX.guide); }
                if (bestSnapY.guide) { finalDy = bestSnapY.val; activeGuides.push(bestSnapY.guide); }

                // PureRef 对齐 ③：网格吸附兜底（对齐参考线未命中时，把首个移动元素的原点对齐到网格倍数）。
                if (gridSnap && !bestSnapX.guide && !bestSnapY.guide) {
                    const primary = movingElements[0];
                    const startPos = primary ? dragStartElementPositions.current.get(primary.id) : undefined;
                    if (startPos) {
                        const baseX = typeof startPos === 'object' && 'x' in startPos ? startPos.x : (Array.isArray(startPos) ? startPos[0].x : 0);
                        const baseY = typeof startPos === 'object' && 'y' in startPos ? startPos.y : (Array.isArray(startPos) ? startPos[0].y : 0);
                        finalDx = Math.round((baseX + finalDx) / gridSize) * gridSize - baseX;
                        finalDy = Math.round((baseY + finalDy) / gridSize) * gridSize - baseY;
                    }
                }

                publishAlignmentGuides(activeGuides);

                if (dragSessionStore) {
                    // P1-B 快路径：整个拖动期间只把位移写进瞬时通道，文档状态（elements）一个字节都不动。
                    // 于是 App 外壳、viewport 索引、撤销记录、脏标记都不参与拖动。
                    // 顺带一个额外的好处：吸附快照的 expected-array 守卫在整个会话里都成立，
                    // 因为拖动的位移不再表现为 elements 变化，静态参考线不可能中途失效。
                    dragSessionStore.setOffset({ x: finalDx, y: finalDy });
                    break;
                }

                setElements(prev => {
                    const nextElements = prev.map(el => {
                        if (movingElementIdSet.has(el.id)) {
                            const startPos = dragStartElementPositions.current.get(el.id);
                            if (!startPos) return el;
                            
                            switch (el.type) {
                                case 'path': {
                                    const initialPoints = startPos as Point[];
                                    const newPoints = initialPoints.map(p => ({ x: p.x + finalDx, y: p.y + finalDy }));
                                    return { ...el, points: newPoints };
                                }
                                case 'arrow':
                                case 'line': {
                                    const initialPoints = startPos as [Point, Point];
                                    const newPoints: [Point, Point] = [
                                        { x: initialPoints[0].x + finalDx, y: initialPoints[0].y + finalDy },
                                        { x: initialPoints[1].x + finalDx, y: initialPoints[1].y + finalDy },
                                    ];
                                    return { ...el, points: newPoints };
                                }
                                default: {
                                    if (!isBoxElement(el)) return el;
                                    const initialPos = startPos as Point;
                                    return { ...el, x: initialPos.x + finalDx, y: initialPos.y + finalDy };
                                }
                            }
                        }
                        return el;
                    });
                    // O(1) expected-array advance is valid only for this hook's own static-preserving map.
                    if (dragSnapGuideSnapshot) {
                        if (dragSnapGuideSnapshot.isCurrent(prev)) {
                            dragSnapGuideSnapshot.advance(nextElements);
                        } else {
                            dragSnapGuideSnapshot.invalidate();
                            if (dragSnapGuideSnapshotRef.current === dragSnapGuideSnapshot) dragSnapGuideSnapshotRef.current = null;
                        }
                    }
                    return nextElements;
                }, false);
                break;
            }
             case 'selectBox': {
                const newX = Math.min(point.x, startCanvasPoint.x);
                const newY = Math.min(point.y, startCanvasPoint.y);
                const newWidth = Math.abs(point.x - startCanvasPoint.x);
                const newHeight = Math.abs(point.y - startCanvasPoint.y);
                const nextSelectionBox = { x: newX, y: newY, width: newWidth, height: newHeight };
                latestSelectionBoxRef.current = nextSelectionBox;
                setSelectionBox(nextSelectionBox);
                // P0-3：这一帧"会被选中"的元素高亮 —— 只发瞬时通道，不发 setState。
                publishSelectionPreview();
                break;
            }
        }
    };

    const flushPendingPointerMove = () => {
        if (pointerMoveFrameRef.current !== null) cancelAnimationFrame(pointerMoveFrameRef.current);
        pointerMoveFrameRef.current = null;
        const pending = pendingPointerMoveRef.current;
        pendingPointerMoveRef.current = null;
        if (pending) processMouseMove(pending);
    };

    const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
        if (!interactionMode.current) return;
        pendingPointerMoveRef.current = {
            clientX: e.clientX,
            clientY: e.clientY,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
        };
        if (pointerMoveFrameRef.current !== null) return;
        pointerMoveFrameRef.current = requestAnimationFrame(() => {
            pointerMoveFrameRef.current = null;
            const pending = pendingPointerMoveRef.current;
            pendingPointerMoveRef.current = null;
            if (pending) processMouseMove(pending);
        });
    };

    const handleMouseUp = () => {
        windowDragCleanupRef.current?.();
        // Board/project switches may cancel the transient store before the OS
        // sends mouseup. Do not fall through to the legacy commit path on the
        // newly active board when this store-backed drag is already gone.
        if (interactionMode.current === 'dragElements' && dragSessionStore && !dragSessionStore.isActive()) {
            cancelMouseDrag();
            return;
        }
        // A window capture-phase mouseup may have completed the gesture before
        // React's SVG onMouseUp runs. Never commit twice.
        if (!interactionMode.current) return;
        // Do not lose the final sample when mouseup arrives before the scheduled frame.
        flushPendingPointerMove();
        setIsInteracting(false);
        // P0-1：手势结束，元素回到各自档位（降档状态刻意不跨手势残留）。
        resetContentInteraction();
        // 平移手势结束时才把相机提交到文档状态（整个手势只产生一次 boards 更新）。
        if (interactionMode.current === 'pan') {
            panGestureRef.current = null;
            viewportStore?.endInteraction();
            setIsViewportGesture(false);
        }
        if (interactionMode.current === 'ai-rotate') {
            const finalAiRotationState = latestAiRotationStateRef.current;
            if (finalAiRotationState && finalAiRotationState.currentAngle !== 0) {
                onAIRotateFinish?.(finalAiRotationState);
            }
            latestAiRotationStateRef.current = null;
            setAiRotationState(null);
        } else if (interactionMode.current) {
            if (interactionMode.current === 'dragElements') {
                // 拖动会话结束：拿最终位移，一次性写文档状态（一条撤销记录、一次父级解析）。
                const dragSession = dragSessionStore ? dragSessionStore.end() : null;

                if (dragSession) {
                    // 快路径：整段位移 + 它引起的父级归属变化一次提交。
                    // 候选索引传 null —— 拖动期间位置没写回文档，R14 快照指向拖动前的位置，
                    // 用它窄化候选会漏掉新位置附近的 Frame（跨 Frame 拖入失效）。
                    commitAction(els => applyDragCommit(els, dragSession, null));
                } else {
                    // 旧路径（无通道）：元素位置已经逐帧写进文档，这里只补父级归属。
                    commitAction(els => {
                        const movingElementIds = new Set(dragStartElementPositions.current.keys());

                        return els.map(el => {
                            if (!movingElementIds.has(el.id) || el.type === 'frame') return el;
                            // R17: current reader only narrows candidates; stale/missing snapshot falls back to all current elements.
                            const containingFrame = resolveContainingFrame(el, els, interactionViewportIndexRef?.current ?? null);
                            const newParentId = containingFrame ? containingFrame.id : undefined;
                            if (el.parentId !== newParentId) return { ...el, parentId: newParentId };
                            return el;
                        });
                    });
                }
            } else if (interactionMode.current === 'selectBox' && latestSelectionBoxRef.current) {
                // P0-2/P0-3：命中口径与逐帧预览共用 marquee-selection 的同一份实现，
                // 修饰键也读同一份快照 —— 保证"高亮亮着的"就是"松手选中的"。
                const picks = pickElementsInBox(elements, interactionViewportIndexRef?.current ?? null, latestSelectionBoxRef.current);
                setSelectedElementIds(applySelectionModifiers(selectedElementIds, picks.map(pick => pick.id), marqueeModifiersRef.current));
            } else if (interactionMode.current === 'lasso' && latestLassoPathRef.current && latestLassoPathRef.current.length > 2) {
                const picks = pickElementsInLasso(elements, interactionViewportIndexRef?.current ?? null, latestLassoPathRef.current);
                setSelectedElementIds(applySelectionModifiers(selectedElementIds, picks.map(pick => pick.id), marqueeModifiersRef.current));
                latestLassoPathRef.current = null;
                setLassoPath(null);
            } else {
                // P1-1：缩放/旋转/绘制 —— 会话内几何只存在瞬时通道里，这里取回来**一次性**提交。
                // 只在真正提交的那一刻写一次 elements：一条撤销记录、一次空间索引重建。
                // 通道为空（这些手势本就没动过，或走的是无通道回落路径）时保持
                // `commitAction(els => els)` 的旧语义（手势结束 = 一次提交）。
                commitGestureSession(commitAction);
            }
        }
        interactionMode.current = null;
        latestSelectionBoxRef.current = null;
        latestLassoPathRef.current = null;
        setSelectionBox(null);
        setLassoPath(null);
        // P0-3：手势结束就清掉预览高亮 —— 真正选中的结果已经写进 selectedElementIds，
        // 预览不该以任何形式替它兜底（两者口径相同，留着只会重叠一层）。
        marqueePreviewIdsRef.current = [];
        selectionPreviewStore?.clear();
        publishAlignmentGuides([]);
        setRotateDialPoint(null);
        currentDrawingElementId.current = null;
        dragSnapGuideSnapshotRef.current?.invalidate();
        dragSnapGuideSnapshotRef.current = null;
        dragMovingElementsRef.current = [];
    };

    /** The button was released outside the OS window (or the app lost focus).
     * Without an observed mouseup there is no trustworthy drop position. Roll
     * back the transient preview rather than accidentally committing at an edge.
     */
    const cancelMouseDrag = () => {
        // P1-1：丢焦点 / 画板被切走时，变换手势也没有 mouseup —— 同样先结账，
        // 别让通道里的几何悬着（结账后 interactionMode 已清空，下面的守卫会直接返回）。
        flushOrphanTransformSession();
        if (interactionMode.current !== 'dragElements' || !dragSessionStore) return;
        windowDragCleanupRef.current?.();
        if (pointerMoveFrameRef.current !== null) cancelAnimationFrame(pointerMoveFrameRef.current);
        pointerMoveFrameRef.current = null;
        pendingPointerMoveRef.current = null;
        dragSessionStore.cancel();
        interactionMode.current = null;
        setIsInteracting(false);
        // P0-1：取消路径同样要撤销降档，否则被中断的拖动会让元素一直停在代理档。
        resetContentInteraction();
        publishAlignmentGuides([]);
        setRotateDialPoint(null);
        dragSnapGuideSnapshotRef.current?.invalidate();
        dragSnapGuideSnapshotRef.current = null;
        dragStartElementPositions.current.clear();
        dragMovingElementsRef.current = [];
    };

    // The native listener keeps an up-to-date hook closure without adding
    // listeners on every render. Within the SVG React handles moves; elsewhere
    // in the window these listeners forward just the latest rAF-coalesced move.
    liveWindowDragHandlersRef.current = {
        move: event => handleMouseMove(event as unknown as React.MouseEvent<SVGSVGElement>),
        finish: handleMouseUp,
        cancel: cancelMouseDrag,
    };
    const beginGlobalMouseDrag = () => {
        if (windowDragCleanupRef.current || !dragSessionStore?.isActive()) return;
        const owner = svgRef.current?.ownerDocument.defaultView;
        if (!owner) return;
        const fromCanvas = (event: MouseEvent): boolean => {
            const svg = svgRef.current;
            return Boolean(svg && event.target instanceof Node && svg.contains(event.target));
        };
        const onMove = (event: MouseEvent) => {
            if (interactionMode.current !== 'dragElements') {
                cleanup();
                return;
            }
            if (!dragSessionStore.isActive()) {
                liveWindowDragHandlersRef.current?.cancel();
                return;
            }
            if ((event.buttons & 1) === 0) {
                // If mouseup was never delivered outside the app, a no-button
                // move on re-entry is proof the gesture has ended: cancel it.
                liveWindowDragHandlersRef.current?.cancel();
                return;
            }
            if (!fromCanvas(event)) liveWindowDragHandlersRef.current?.move(event);
        };
        const onUp = (event: MouseEvent) => {
            if (interactionMode.current !== 'dragElements') {
                cleanup();
                return;
            }
            if (!dragSessionStore.isActive()) {
                liveWindowDragHandlersRef.current?.cancel();
                return;
            }
            // Mouseup may precede the last animation frame. Include its final
            // coordinates before ending (including over a sidebar/tool panel).
            if (!fromCanvas(event)) liveWindowDragHandlersRef.current?.move(event);
            liveWindowDragHandlersRef.current?.finish();
        };
        const onBlur = () => liveWindowDragHandlersRef.current?.cancel();
        const onVisibilityChange = () => {
            if (owner.document.hidden) liveWindowDragHandlersRef.current?.cancel();
        };
        const cleanup = () => {
            owner.removeEventListener('mousemove', onMove, true);
            owner.removeEventListener('mouseup', onUp, true);
            owner.removeEventListener('blur', onBlur);
            owner.document.removeEventListener('visibilitychange', onVisibilityChange);
            if (windowDragCleanupRef.current === cleanup) windowDragCleanupRef.current = null;
        };
        owner.addEventListener('mousemove', onMove, true);
        owner.addEventListener('mouseup', onUp, true);
        owner.addEventListener('blur', onBlur);
        owner.document.addEventListener('visibilitychange', onVisibilityChange);
        windowDragCleanupRef.current = cleanup;
    };

    /**
     * 框选（selectBox）/ 套索（lasso）同样要能拖出画布边界。
     * 指针一旦离开 <svg>，React 的 onMouseMove 就再收不到样本，而 MainCanvas 的
     * onMouseLeave 会把选择框就地提交 —— 表现为"选择框拖到边界被自动取消、选区停在边界上"。
     * 这里在按下时接管整个手势：离开画布后继续吃窗口上的 move/up，指针回画布内或松手时
     * 按最后一个已知点收尾（**提交**，不是回滚）：既不异常取消，也不丢选区。
     */
    const beginGlobalSelectionGesture = () => {
        if (windowDragCleanupRef.current) return;
        const owner = svgRef.current?.ownerDocument.defaultView;
        if (!owner) return;
        const svg = svgRef.current;
        const fromCanvas = (event: MouseEvent): boolean =>
            Boolean(svg && event.target instanceof Node && svg.contains(event.target));
        const isAlive = () => isSelectionBoxGesture(interactionMode.current);
        const onMove = (event: MouseEvent) => {
            if (!isAlive()) {
                cleanup();
                return;
            }
            if ((event.buttons & 1) === 0) {
                // OS 没把 mouseup 送进来：用最后一个已知点收尾。选择框是只读装饰，
                // 提交它不会造成任何文档写入，比"凭空丢掉选区"更符合预期。
                if (!fromCanvas(event)) liveWindowDragHandlersRef.current?.move(event);
                liveWindowDragHandlersRef.current?.finish();
                return;
            }
            if (!fromCanvas(event)) liveWindowDragHandlersRef.current?.move(event);
        };
        const onUp = (event: MouseEvent) => {
            if (event.button !== 0) return;
            if (!isAlive()) {
                cleanup();
                return;
            }
            // 松手点可能在侧栏/面板上：先补最后一个样本，再收尾。
            if (!fromCanvas(event)) liveWindowDragHandlersRef.current?.move(event);
            liveWindowDragHandlersRef.current?.finish();
        };
        // 失焦不是取消：选择框画到哪就算到哪，避免"选区凭空消失"。
        const onBlur = () => { if (isAlive()) liveWindowDragHandlersRef.current?.finish(); };
        const onVisibilityChange = () => { if (owner.document.hidden) onBlur(); };
        const cleanup = () => {
            owner.removeEventListener('mousemove', onMove, true);
            owner.removeEventListener('mouseup', onUp, true);
            owner.removeEventListener('blur', onBlur);
            owner.document.removeEventListener('visibilitychange', onVisibilityChange);
            if (windowDragCleanupRef.current === cleanup) windowDragCleanupRef.current = null;
        };
        owner.addEventListener('mousemove', onMove, true);
        owner.addEventListener('mouseup', onUp, true);
        owner.addEventListener('blur', onBlur);
        owner.document.addEventListener('visibilitychange', onVisibilityChange);
        windowDragCleanupRef.current = cleanup;
    };

    /**
     * 指针离开画布 ≠ 手势结束。拖动元素 / 平移 / 框选 / 套索由窗口级跟踪接管
     * （见 beginGlobal*），这里只收尾真正依赖 SVG 内事件的旧手势。
     */
    const handleCanvasMouseLeave = () => {
        const mode = interactionMode.current;
        if (!mode) return;
        if (mode === 'pan' || isSelectionBoxGesture(mode)) return;
        if (mode === 'dragElements' && dragSessionStore?.isActive()) return;
        // P1-1：缩放/旋转/绘制同样由窗口级跟踪接管（见 beginGlobalTransformGesture）。
        // 手指/指针滑出画布不该就地结账 —— 否则"拖到画布边缘松手"会在边界处提前定稿。
        if (isTransformGesture(mode)) return;
        handleMouseUp();
    };

    /**
     * P1-1：缩放 / 旋转 / 绘制的窗口级跟踪。
     * 这三族手势的最终几何是**松手那一下**才提交的（会话内只有预览），所以更不能丢 mouseup：
     * 指针滑出 <svg> 后 React 的 onMouseMove 断供，若此时松手或失焦，通道里的预览要么悬着、
     * 要么被 onMouseLeave 就地提前定稿。这里在按下时接管整个手势，与 beginGlobalSelectionGesture 同构：
     * 离开画布后继续吃窗口上的 move，松手按**最后一个已知点**收尾（提交，不是回滚）。
     */
    const beginGlobalTransformGesture = () => {
        if (windowDragCleanupRef.current) return;
        const owner = svgRef.current?.ownerDocument.defaultView;
        if (!owner) return;
        const svg = svgRef.current;
        const fromCanvas = (event: MouseEvent): boolean =>
            Boolean(svg && event.target instanceof Node && svg.contains(event.target));
        const isAlive = () => isTransformGesture(interactionMode.current);
        const onMove = (event: MouseEvent) => {
            if (!isAlive()) {
                cleanup();
                return;
            }
            if ((event.buttons & 1) === 0) {
                // OS 没把 mouseup 送进来：用最后一个已知点收尾。
                // 变换几何完全由指针位置决定，最后一个样本就是用户看到的最后形状。
                if (!fromCanvas(event)) liveWindowDragHandlersRef.current?.move(event);
                liveWindowDragHandlersRef.current?.finish();
                return;
            }
            if (!fromCanvas(event)) liveWindowDragHandlersRef.current?.move(event);
        };
        const onUp = (event: MouseEvent) => {
            if (event.button !== 0) return;
            if (!isAlive()) {
                cleanup();
                return;
            }
            // 松手点可能在侧栏/工具面板上：先补最后一个样本，再收尾。
            if (!fromCanvas(event)) liveWindowDragHandlersRef.current?.move(event);
            liveWindowDragHandlersRef.current?.finish();
        };
        // 失焦不是取消：几何已经画到哪就是哪，按最后一个已知点提交，避免"改完的样子凭空回退"。
        const onBlur = () => { if (isAlive()) liveWindowDragHandlersRef.current?.finish(); };
        const onVisibilityChange = () => { if (owner.document.hidden) onBlur(); };
        const cleanup = () => {
            owner.removeEventListener('mousemove', onMove, true);
            owner.removeEventListener('mouseup', onUp, true);
            owner.removeEventListener('blur', onBlur);
            owner.document.removeEventListener('visibilitychange', onVisibilityChange);
            if (windowDragCleanupRef.current === cleanup) windowDragCleanupRef.current = null;
        };
        owner.addEventListener('mousemove', onMove, true);
        owner.addEventListener('mouseup', onUp, true);
        owner.addEventListener('blur', onBlur);
        owner.document.addEventListener('visibilitychange', onVisibilityChange);
        windowDragCleanupRef.current = cleanup;
    };

    // Pan-tool (left) and middle-button pan both keep tracking outside the SVG.
    // A release over a toolbar, or window blur, commits the final transient camera.
    const beginGlobalMousePan = (button: 0 | 1) => {
        if (windowDragCleanupRef.current) return;
        const owner = svgRef.current?.ownerDocument.defaultView;
        if (!owner) return;
        const mask = button === 1 ? 4 : 1;
        const onMove = (event: MouseEvent) => {
            if (interactionMode.current !== 'pan') { cleanup(); return; }
            if ((event.buttons & mask) === 0) {
                liveWindowDragHandlersRef.current?.finish();
            } else if (!(event.target instanceof Node && svgRef.current?.contains(event.target))) {
                liveWindowDragHandlersRef.current?.move(event);
            }
        };
        const onUp = (event: MouseEvent) => {
            if (event.button !== button) return;
            if (interactionMode.current === 'pan') liveWindowDragHandlersRef.current?.finish();
            else cleanup();
        };
        const onBlur = () => liveWindowDragHandlersRef.current?.finish();
        const onVisibilityChange = () => { if (owner.document.hidden) onBlur(); };
        const cleanup = () => {
            owner.removeEventListener('mousemove', onMove, true);
            owner.removeEventListener('mouseup', onUp, true);
            owner.removeEventListener('blur', onBlur);
            owner.document.removeEventListener('visibilitychange', onVisibilityChange);
            if (windowDragCleanupRef.current === cleanup) windowDragCleanupRef.current = null;
        };
        owner.addEventListener('mousemove', onMove, true);
        owner.addEventListener('mouseup', onUp, true);
        owner.addEventListener('blur', onBlur);
        owner.document.addEventListener('visibilitychange', onVisibilityChange);
        windowDragCleanupRef.current = cleanup;
    };

    /** 滚轮手势收尾：提交一次相机，恢复 LOD 与悬浮工具条状态。 */
    const endWheelGesture = () => {
        if (wheelTimeoutRef.current) {
            clearTimeout(wheelTimeoutRef.current);
            wheelTimeoutRef.current = null;
        }
        wheelRectRef.current = null;
        viewportStore?.endInteraction();
        setIsViewportGesture(false);
        // 滚轮手势可能在鼠标手势进行中被 200ms 空闲定时器收尾（滚轮后立刻按下、
        // 或拖动中滚动滚轮）。isInteracting 是鼠标手势的状态，滚轮路径从没把它置 true，
        // 这里也就不能抢着置 false —— 否则拖动进行中会被强制翻转交互标记
        // （LOD 降级/悬浮条重算插进拖动每一帧）。真机表现为"拖动突然失效"。
        if (!interactionMode.current) setIsInteracting(false);
    };

    /** 一帧内合并所有滚轮样本：只做一次相机更新，只读一次 SVG 布局。 */
    const applyPendingWheel = () => {
        wheelFrameRef.current = null;
        const pending = pendingWheelRef.current;
        pendingWheelRef.current = null;
        if (!pending) return;

        const element = svgRef.current;
        if (!element) {
            endWheelGesture();
            return;
        }
        // 每个滚轮手势只量一次布局（原来每个滚轮事件都会 getBoundingClientRect → 强制回流）。
        // 相机 transform 挂在 <svg> 上（ADR-049），屏幕基准必须用未变换的容器盒子，
        // 否则 pan/zoom 中量到的 left/top 是漂移的变换后位置。
        let cachedRect = wheelRectRef.current;
        if (!cachedRect) {
            const rect = getCanvasScreenRect(element);
            if (!rect) {
                endWheelGesture();
                return;
            }
            cachedRect = { left: rect.left, top: rect.top };
            wheelRectRef.current = cachedRect;
        }

        const liveBase = viewportStore ? viewportStore.getLive() : { panOffset, zoom };

        if (pending.zoomIntent) {
            // 缩放必须基于"平滑目标"而不是 live 累积：追随期间 live 只走了一部分，
            // 拿它当基准会让滚得越快、每格增量越小（越滚越黏）。
            const zoomBase = viewportStore ? viewportStore.getTarget() : liveBase;
            const nextZoom = Math.max(
                MIN_CANVAS_ZOOM,
                Math.min(zoomBase.zoom * resolveWheelZoomFactor(pending.deltaY), MAX_CANVAS_ZOOM),
            );
            const mouseX = pending.clientX - cachedRect.left;
            const mouseY = pending.clientY - cachedRect.top;
            // Pan to keep the point under mouse stable
            const nextPan = {
                x: mouseX - (mouseX - zoomBase.panOffset.x) * (nextZoom / zoomBase.zoom),
                y: mouseY - (mouseY - zoomBase.panOffset.y) * (nextZoom / zoomBase.zoom),
            };
            if (viewportStore) {
                // 走平滑通道：离散的滚轮事件 → 每帧逼近的连续运动（PureRef 式手感）。
                viewportStore.setSmoothTarget({ zoom: nextZoom, panOffset: nextPan });
            } else {
                updateActiveBoard(b => ({ ...b, zoom: nextZoom, panOffset: nextPan }));
            }
        } else {
            const nextPan = {
                x: liveBase.panOffset.x - pending.deltaX,
                y: liveBase.panOffset.y - pending.deltaY,
            };
            if (viewportStore) {
                // 滚轮平移是 1:1 跟手通道（触控板两指滑动），不加平滑，否则会有拖尾感。
                viewportStore.setTransient({ zoom: liveBase.zoom, panOffset: nextPan });
            } else {
                updateActiveBoard(b => ({ ...b, panOffset: nextPan }));
            }
        }

        if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
        wheelTimeoutRef.current = setTimeout(() => {
            wheelTimeoutRef.current = null;
            endWheelGesture();
        }, WHEEL_GESTURE_IDLE_MS);
    };

    const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
        // 只标记相机手势，**不置 isInteracting**：
        // isInteracting 会让每张图片降级到 standard proxy 并 release 掉高清原图，
        // 滚轮停下 200ms 又重新加载解码。缩放本身只是 GPU 变换，
        // 继续用已准入的高清纹理更划算（PureRef 就是这个行为），也避免"越放大越糊、停下才清晰"。
        if (!isViewportGesture) setIsViewportGesture(true);
        viewportStore?.beginInteraction();

        const nextDeltaX = normalizeWheelDelta(e.deltaX, e.deltaMode);
        const nextDeltaY = normalizeWheelDelta(e.deltaY, e.deltaMode);
        const nextZoomIntent = e.ctrlKey || wheelAction === 'zoom';

        // 滚轮 delta 是**相对增量**，一帧内的多个事件必须累加，不能互相覆盖。
        // 覆盖的后果是确定的输入丢失：实测每帧 3 个事件时最终只放大到应有值的 5.3%
        // （丢失 94.7%，见 scripts/benchmark-scale-hotpaths.cjs），表现为"发黏、不跟手"，
        // 而且机器越忙一帧里挤进的事件越多、丢得越狠。
        // 缩放倍率是指数模型（resolveWheelZoomFactor），累加后应用一次与逐个应用数学等价；
        // 平移是线性模型，同样等价。
        const existing = pendingWheelRef.current;
        if (existing && existing.zoomIntent === nextZoomIntent) {
            existing.deltaX += nextDeltaX;
            existing.deltaY += nextDeltaY;
            // 锚点（鼠标位置）是绝对量，保留最新样本即可。
            existing.clientX = e.clientX;
            existing.clientY = e.clientY;
        } else {
            // 同一帧里换了操作模式（例如触控板从两指滑动切成捏合）：先把旧模式的累积结清，
            // 否则会被新模式整体覆盖。applyPendingWheel 会同步用掉并清空旧样本。
            if (existing) applyPendingWheel();
            pendingWheelRef.current = {
                deltaX: nextDeltaX,
                deltaY: nextDeltaY,
                clientX: e.clientX,
                clientY: e.clientY,
                zoomIntent: nextZoomIntent,
            };
        }
        if (wheelFrameRef.current === null) {
            wheelFrameRef.current = requestAnimationFrame(applyPendingWheel);
        }
    };

    const handleTouchStart = (e: React.TouchEvent<SVGSVGElement>) => {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            handleMouseDown({
                clientX: touch.clientX,
                clientY: touch.clientY,
                button: 0,
                target: e.target,
                stopPropagation: () => e.stopPropagation(),
                preventDefault: () => e.preventDefault(),
                detail: 1,
                shiftKey: false,
                // P0-2：触摸没有修饰键，显式补 false，别让 undefined 流进选区合并逻辑。
                ctrlKey: false,
                altKey: false,
            } as any);
        }
    };

    const handleTouchMove = (e: React.TouchEvent<SVGSVGElement>) => {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            handleMouseMove({
                clientX: touch.clientX,
                clientY: touch.clientY,
                shiftKey: false,
                ctrlKey: false,
                altKey: false,
            } as any);
        }
    };

    const handleTouchEnd = (e: React.TouchEvent<SVGSVGElement>) => {
        handleMouseUp();
    };

    return {
        handleMouseDown,
        handleMouseMove,
        handleMouseUp,
        handleCanvasMouseLeave,
        handleTouchStart,
        handleTouchMove,
        handleTouchEnd,
        handleWheel,
        cursor,
        smartToolbarState,
        interactionMode,
        rotateStartInfo,
        isInteracting,
    };
};
