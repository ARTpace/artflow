import { provideLiveService } from './plugin-runtime/live-service';
import { createDocumentSDK, DOCUMENT_PROVIDER, DOCUMENT_SERVICE, OPERATIONS_SERVICE } from './plugin-runtime/document-sdk';
import { createServiceDirectory, SERVICE_DIRECTORY, type ServiceDirectory } from './plugin-runtime/service-directory';
import { getExtensionHost } from './plugin-runtime/extension-host';
import { extensionSchemaProvider } from './plugin-runtime/extension-renderer';
import { executeGuardedTool } from './plugin-runtime/guarded-tools';
import { ExtensionImportPanel } from './components/ExtensionImportPanel';
import { ExtensionNodeProperties } from './components/ExtensionNodeProperties';

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Toolbar } from './components/Toolbar';
import { Loader } from './components/Loader';
import { CanvasSettings } from './components/CanvasSettings';
import { LayerPanel } from './components/LayerPanel';
import { BoardPanel } from './components/BoardPanel';
import { ContextMenu } from './components/ContextMenu';
import { MainCanvas } from './components/MainCanvas';
import { WorkspaceWallpaper, WorkspaceWallpaperSwitch } from './builtin-plugins/ui-skin-picker/WorkspaceWallpaper';
import { WindowChrome } from './components/WindowChrome';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from './plugin-runtime/host-platform';
import { TopBar } from './components/TopBar';
import { ErrorOverlay } from './components/ErrorOverlay';
import { SafeModeBanner } from './components/SafeModeBanner';
import type { WorkspaceActivityTone } from './components/ProjectWorkspacePanel';
import { CommandPalette } from './plugin-runtime/command-palette';
import { WORKSPACE_COMMAND_ACTIONS_SERVICE, type WorkspaceCommandActions } from './plugin-runtime/workspace-command-actions';
import { ELEMENT_COMMAND_ACTIONS_SERVICE, type ElementCommandActions } from './plugin-runtime/element-command-actions';
import { AI_SESSION_SERVICE, type AiSession } from './plugin-runtime/ai-session';
import { invokeAIProvider, type AIProviderRequest } from './plugin-runtime/ai-providers';
import { resolveProviderId } from './plugin-runtime/ai-provider-resolution';
import { CANVAS_EXPORT_SOURCE_SERVICE, type CanvasExportSource } from './plugin-runtime/canvas-export-source';
import { CANVAS_MUTATION_SERVICE, type CanvasMutationService, type ElementPatch } from './plugin-runtime/canvas-mutation';
import { CANVAS_VIEW_STATE_SERVICE, type CanvasViewStateService } from './plugin-runtime/canvas-view-state';
import { peekPreference, setPreference } from './plugin-runtime/preferences-store';
import { useWorkspaceFlag, useWorkspaceState } from './hooks/useWorkspaceLayout';
import { WORKSPACE_KEYS, isSidePanelState, type SidePanelState } from './plugin-runtime/workspace-layout';
import { createCanvasNavigatorModel, fitCanvasViewport } from './utils/canvasNavigator';
import { listPanelContributions, resolvePanelText } from './plugin-runtime/panel-contributions';
import { PluginPanelHost } from './plugin-runtime/panel-host';
import { WorkspaceWidgetHost } from './components/WorkspaceWidgetHost';
import { CanvasToolbarHost } from './plugin-runtime/toolbar-host';
import {
  WORKSPACE_UI_BRIDGE_SERVICE,
  createWorkspaceUiBridge,
  type WorkspaceUiBridge,
} from './plugin-runtime/workspace-bridge';
import { getKernel } from './plugin-runtime/instance';
import { DEFAULT_CANVAS_BACKGROUND } from './plugin-runtime/ui-theme-settings';
import type { PsdParseResult } from './plugin-runtime/format-handlers';
import { isSvgString, parseSvgContent } from './utils/svgUtils';
import type { Tool, Rect, WheelAction, ImageElement, Guide, Point, AIRotationState, TextElement, CanvasViewBookmark, Element as CanvasElement } from './types';
import { 
    generateBoardThumbnail, getSelectionBounds, generateId, getCanvasScreenRect } from './utils/canvasUtils';
import {
    appendCanvasViewBookmark,
    createCanvasViewBookmark,
    removeCanvasViewBookmark,
    renameCanvasViewBookmark,
} from './utils/viewBookmarks';
import { focusCanvasFinderResult, type CanvasFinderResult } from './utils/canvasFinder';
import { consumePluginReloadFlag, reloadForPluginApply } from './utils/pluginReload';
import {
    acceptLoadedProjectBoards,
    completeProjectSave,
    createProjectChangeState,
    observeProjectBoards,
} from './utils/projectChangeTracker';
import {
    addElementTag,
    normalizeElementTag,
    normalizeElementTags,
    removeElementTag,
} from './utils/elementTags';
import { useCanvasState } from './hooks/useCanvasState';
import { useSettings } from './hooks/useSettings';
import { usePresentation } from './hooks/usePresentation';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useCanvasInteractions } from './hooks/useCanvasInteractions';
import { useAIHandlers, type InvokeAIProvider } from './hooks/useAIHandlers';
import { useElementActions } from './hooks/useElementActions';
import { useBoardActions } from './hooks/useBoardActions';
import { useFileHandlers } from './hooks/useFileHandlers';
import { IMPORT_REVEAL_MAX_IMAGES, type ImportRevealRequest } from './utils/importReveal';
import { useFileSystem } from './hooks/useFileSystem';
import type { InteractionViewportIndexSnapshot } from './utils/interaction-spatial-query';
import {
    createCanvasViewportStore,
    type CanvasViewport,
    type CanvasViewportStore,
} from './utils/viewport-store';
import {
    createCanvasDragSessionStore,
    type CanvasDragSessionStore,
} from './utils/drag-session-store';
import {
    createContentInteractionStore,
    type ContentInteractionStore,
} from './utils/content-interaction-store';
import {
    createSelectionPreviewStore,
    type SelectionPreviewStore,
} from './utils/selection-preview-store';
import {
    createElementTransformSessionStore,
    type ElementTransformSessionStore,
} from './utils/element-transform-session';

/** 画布视图辅助（网格/吸附/去色/暗化）的偏好键；值是一个 JSON 对象。 */
const CANVAS_VIEW_PREF_KEY = 'canvas.view';

interface CanvasViewPrefs {
    gridVisible?: boolean;
    gridSnap?: boolean;
    gridSize?: number;
    viewDesaturate?: boolean;
    viewDimUnselected?: boolean;
}

const sameTags = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((tag, index) => tag === right[index]);

// workspace.ui-bridge 的载体必须是**模块级单例**，不能在组件内 useRef 新建：
// App 每次 render 原地更新它（见下方 `workspaceUiBridge.current = {...}`），而插件在 activate
// 期就可能拿到并长期持有该对象。若载体随挂载重建（HMR / 受控刷新会重挂载 App），内核里与
// 插件手里的旧对象就永久停在失效闭包上（表现为插件的调用"点了没反应"）。身份稳定才不漂移。
const workspaceUiBridge = createWorkspaceUiBridge({} as WorkspaceUiBridge);

const App: React.FC = () => {
    const pluginKernel = getKernel();
    // The SSR smoke-test mounts App with an intentionally empty kernel.
    const windowPlatform = pluginKernel.has(HOST_PLATFORM_SERVICE)
        ? pluginKernel.use<HostPlatformService>(HOST_PLATFORM_SERVICE) : null;
    const {

        boards,
        setBoards,
        activeBoardId,
        setActiveBoardId,
        activeBoard,
        elements,
        canUndo,
        canRedo,
        panOffset,
        zoom,
        canvasBackgroundColor,
        updateActiveBoard,
        setElements,
        commitAction,
        addElementsWithParenting,
        endImportHistoryGroup,
        handleUndo,
        handleRedo,
        loadBoardData,
        documentState,
        isDocumentInteractionPending,
    } = useCanvasState();

    // —— P1-B'：相机瞬时通道 ——
    // pan/zoom 期间不再逐帧写 Board（那会让 App 整棵树每帧重绘），只在手势结束时提交一次。
    // 提交动作永远走最新的 updateActiveBoard（它是 useCallback 依赖 activeBoardId，会随画板切换变化）。
    const commitViewportRef = useRef<(next: CanvasViewport) => void>(() => {});
    commitViewportRef.current = next => {
        updateActiveBoard(board => ({ ...board, panOffset: next.panOffset, zoom: next.zoom }));
    };
    const canvasViewportStore = useMemo<CanvasViewportStore>(() => createCanvasViewportStore({
        initial: { panOffset: { x: 0, y: 0 }, zoom: 1 },
        onCommit: next => commitViewportRef.current(next),
    }), []);
    // 文档侧相机（书签恢复 / Fit / 载入项目 / 画板切换）反向校准 store。
    useEffect(() => {
        canvasViewportStore.syncDocument({ panOffset, zoom });
    }, [canvasViewportStore, panOffset, zoom]);
    useEffect(() => () => canvasViewportStore.dispose(), [canvasViewportStore]);

    // P1-B：拖动会话瞬时通道。拖动中的位移与对齐参考线只存在这里，松手才提交一次文档状态。
    const canvasDragSessionStore = useMemo<CanvasDragSessionStore>(() => createCanvasDragSessionStore(), []);
    useEffect(() => () => canvasDragSessionStore.dispose(), [canvasDragSessionStore]);

    // P0-1：内容变换瞬时通道。只登记"正在被变换的元素"，图片降档不再跟着"鼠标是否按下"走。
    const canvasContentInteractionStore = useMemo<ContentInteractionStore>(() => createContentInteractionStore(), []);
    useEffect(() => () => canvasContentInteractionStore.dispose(), [canvasContentInteractionStore]);

    // P0-3：框选/套索"将被选中"预览瞬时通道。逐帧只写通道，不写 React 状态。
    const canvasSelectionPreviewStore = useMemo<SelectionPreviewStore>(() => createSelectionPreviewStore(), []);
    useEffect(() => () => canvasSelectionPreviewStore.dispose(), [canvasSelectionPreviewStore]);

    // P1-1：缩放/旋转/绘制的元素几何瞬时通道。手势期间只发预览（松手才落一次文档），
    // 与拖动会话同款 —— 目的是让这些手势不再逐帧改 elements 引用（不再逐帧重建空间索引）。
    const canvasTransformSessionStore = useMemo<ElementTransformSessionStore>(() => createElementTransformSessionStore(), []);
    useEffect(() => () => canvasTransformSessionStore.dispose(), [canvasTransformSessionStore]);

    // 切画板前先把未提交的瞬时相机落到"旧画板"上：提交走的是当前 activeBoardId 的闭包，
    // 必须发生在 setActiveBoardId 之前，否则会写进新画板。
    // 拖动会话则直接丢弃：旧画板上的拖动预览没有可提交的去处，留着会污染新画板的呈现。
    // 内容变换/框选预览同属"上一块画板的瞬时态"，一并清掉（降档与高亮不得跨画板残留）。
    const handleSetActiveBoardId = useCallback((id: string) => {
        canvasViewportStore.endInteraction();
        canvasDragSessionStore.cancel();
        canvasContentInteractionStore.end();
        canvasSelectionPreviewStore.clear();
        // P1-1：变换会话是**丢弃**不是提交 —— 提交走的是当前 activeBoardId 的闭包，
        // 在这里提交会把旧画板上没画完的形状写进新画板。
        canvasTransformSessionStore.cancel();
        setActiveBoardId(id);
    }, [canvasViewportStore, canvasDragSessionStore, canvasContentInteractionStore, canvasSelectionPreviewStore, canvasTransformSessionStore, setActiveBoardId]);

    // R23 follows existing immutable Board[] updates only; it does not own serializer or storage semantics.
    const latestBoardsRef = useRef(boards);
    latestBoardsRef.current = boards;
    const projectChangeStateRef = useRef(createProjectChangeState(boards));
    const pendingProjectLoadBaselineRef = useRef(false);
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    const [hasProjectSaveBaseline, setHasProjectSaveBaseline] = useState(false);

    const {
        language,
        setLanguage,
        toolbarPosition,
        apiKey,
        setApiKey,
        userEffects,
        setUserEffects,
        generationMode,
        setGenerationMode,
        videoAspectRatio,
        setVideoAspectRatio,
        imageAspectRatio,
        setImageAspectRatio,
        numberOfImages,
        setNumberOfImages,
        numberOfVideos,
        setNumberOfVideos,
        generateHotkey,
        setGenerateHotkey,
        presentationHotkeys,
        setPresentationHotkeys,
        handleAddUserEffect,
        handleDeleteUserEffect,
        t,
        wheelAction,
        setWheelAction
    } = useSettings();

    const {
        openProjectFolder,
        openRecentProject,
        saveProject,
        restoreStartupProject,
        projectFolderName,
        isProjectOpen,
        isManagedProjectStorageAvailable,
        isManagedImportJobsAvailable,
        importJobs,
        currentImportProgress,
        isRefreshingImportJobs,
        refreshImportJobs,
        requestCancelImportJob,
    } = useFileSystem();

    const [activeTool, setActiveTool] = useState<Tool>('select');
    const [drawingOptions, setDrawingOptions] = useState({ strokeColor: '#FFFFFF', strokeWidth: 5, opacity: 1 });
    const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
    // PureRef 对齐 ③⑤：背景网格 + 视图辅助（去色/暗化非选中）。
    // 持久化后端是主进程 config/preferences.json（旧键 artflow.canvas-view.v1 /
    // bananapod.canvas-view.v1 由 preferences-store 一次性采纳），与 origin 无关。
    const canvasViewPrefs = useMemo(() => {
        const stored = peekPreference(CANVAS_VIEW_PREF_KEY);
        return stored && typeof stored === 'object' && !Array.isArray(stored)
            ? (stored as CanvasViewPrefs)
            : {};
    }, []);
    const [gridVisible, setGridVisible] = useState<boolean>(canvasViewPrefs.gridVisible ?? false);
    const [gridSnap, setGridSnap] = useState<boolean>(canvasViewPrefs.gridSnap ?? false);
    const [gridSize, setGridSize] = useState<number>(canvasViewPrefs.gridSize ?? 32);
    const [viewDesaturate, setViewDesaturate] = useState<boolean>(canvasViewPrefs.viewDesaturate ?? false);
    const [viewDimUnselected, setViewDimUnselected] = useState<boolean>(canvasViewPrefs.viewDimUnselected ?? false);
    useEffect(() => {
        try {
            setPreference(CANVAS_VIEW_PREF_KEY, { gridVisible, gridSnap, gridSize, viewDesaturate, viewDimUnselected });
        } catch (error) {
            console.error('Failed to persist canvas view prefs', error);
        }
    }, [gridVisible, gridSnap, gridSize, viewDesaturate, viewDimUnselected]);
    const [selectionBox, setSelectionBox] = useState<Rect | null>(null);
    const [prompt, setPrompt] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(false);
    const [requestedSettingsSectionId, setRequestedSettingsSectionId] = useState<string | null>(null);
    // 悬浮扩展面板宿主（主题工作台 / 插件管理）：非模态、可拖拽，背景界面实时可见。
    const [isPanelHostOpen, setIsPanelHostOpen] = useState(false);
    const [panelHostId, setPanelHostId] = useState<string | null>(null);
    // —— 工作区布局（userData/config/workspace.json）：面板开合跨重启保持 ——
    // 只收录"常驻面板"。命令面板 / 右键菜单 / 标签编辑器这类**交互中才存在**的浮层刻意不入卷：
    // 重启后自动弹出一个命令面板不是"记住布局"，是干扰。
    // 设置面板同样不入卷 —— 它带 requestedSettingsSectionId 这类一次性深链语义。
    const [isBoardPanelOpen, setIsBoardPanelOpen] = useWorkspaceFlag(WORKSPACE_KEYS.boardPanel, false);
    const [isImportJobsPanelOpen, setIsImportJobsPanelOpen] = useState(false);
    const [isWorkspacePanelOpen, setIsWorkspacePanelOpen] = useWorkspaceFlag(WORKSPACE_KEYS.projectPanel, false);
    const [isViewBookmarksPanelOpen, setIsViewBookmarksPanelOpen] = useWorkspaceFlag(WORKSPACE_KEYS.bookmarksPanel, false);
    const [isCanvasFinderPanelOpen, setIsCanvasFinderPanelOpen] = useWorkspaceFlag(WORKSPACE_KEYS.finderPanel, false);
    const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
    const [tagEditorElementIds, setTagEditorElementIds] = useState<string[] | null>(null);
    const [isSavingProject, setIsSavingProject] = useState(false);
    const [lastWorkspaceActivity, setLastWorkspaceActivity] = useState<{ tone: WorkspaceActivityTone; message: string }>({
        tone: 'neutral',
        message: 'Ready to work on this canvas.',
    });
    // 侧栏整体存一个键：开合与当前标签是同一次交互的两个面，拆成两个键会写下自相矛盾的中间态。
    const [sidePanel, setSidePanel] = useWorkspaceState<SidePanelState>(
        WORKSPACE_KEYS.sidePanel,
        { isOpen: false, tab: 'layers' },
        isSidePanelState,
    );
    const [croppingState, setCroppingState] = useState<{ elementId: string; originalElement: ImageElement; cropBox: Rect } | null>(null);
    const [alignmentGuides, setAlignmentGuides] = useState<Guide[]>([]);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; elementId: string | null } | null>(null);
    const [editingElement, setEditingElement] = useState<{ id: string; text: string; } | null>(null);
    const [lassoPath, setLassoPath] = useState<Point[] | null>(null);
    const [aiRotationState, setAiRotationState] = useState<AIRotationState | null>(null);
    const [rotateDialPoint, setRotateDialPoint] = useState<Point | null>(null);
    const [progressMessage, setProgressMessage] = useState<string>('');
    const mousePosRef = useRef<Point | null>(null);
    // R14: MainCanvas owns/publishes the live index; App only transports this non-reactive read port.
    const interactionViewportIndexRef = useRef<InteractionViewportIndexSnapshot | null>(null);
    const workspaceCommandActionsRef = useRef<WorkspaceCommandActions | null>(null);
    const workspaceCommandServiceRef = useRef<WorkspaceCommandActions>({
        fitCanvas: () => workspaceCommandActionsRef.current?.fitCanvas(),
        canFitCanvas: () => workspaceCommandActionsRef.current?.canFitCanvas() ?? false,
        openCanvasFinder: () => workspaceCommandActionsRef.current?.openCanvasFinder(),
        openSavedViews: () => workspaceCommandActionsRef.current?.openSavedViews(),
        openExtensions: () => workspaceCommandActionsRef.current?.openExtensions(),
        canOpenExtensions: () => workspaceCommandActionsRef.current?.canOpenExtensions() ?? false,
    });
    const elementCommandActionsRef = useRef<ElementCommandActions | null>(null);
    const elementCommandServiceRef = useRef<ElementCommandActions>({
        undo: () => elementCommandActionsRef.current?.undo(),
        redo: () => elementCommandActionsRef.current?.redo(),
        copy: () => elementCommandActionsRef.current?.copy(),
        deleteSelection: () => elementCommandActionsRef.current?.deleteSelection(),
        canEditSelection: () => elementCommandActionsRef.current?.canEditSelection() ?? false,
        startPresentation: () => elementCommandActionsRef.current?.startPresentation(),
        presentationNext: () => elementCommandActionsRef.current?.presentationNext(),
        presentationPrev: () => elementCommandActionsRef.current?.presentationPrev(),
        exitPresentation: () => elementCommandActionsRef.current?.exitPresentation(),
        isPresenting: () => elementCommandActionsRef.current?.isPresenting() ?? false,
    });
    const aiGenerateRef = useRef<() => void>(() => {});
    const aiSessionServiceRef = useRef<AiSession>({
        generate: () => aiGenerateRef.current(),
    });

    const shiftEraseOriginalTool = useRef<Tool | null>(null);

    const {
        presentationState,
        setPresentationState,
        frames,
        zoomToFrame,
        zoomToBounds,
        handleNavigateWithTransition,
        handleExitPresentation,
        handleStartPresentation,
        handleNavigatePresentation,
        svgRef
    } = usePresentation(elements, zoom, panOffset, updateActiveBoard, canvasViewportStore);

    const syncProjectChangeState = useCallback((nextState: { baseline: typeof boards; isDirty: boolean }) => {
        projectChangeStateRef.current = nextState;
        setHasUnsavedChanges(previous => previous === nextState.isDirty ? previous : nextState.isDirty);
    }, []);

    useEffect(() => {
        const nextState = pendingProjectLoadBaselineRef.current
            ? acceptLoadedProjectBoards(boards)
            : observeProjectBoards(projectChangeStateRef.current, boards);
        pendingProjectLoadBaselineRef.current = false;
        syncProjectChangeState(nextState);
    }, [boards, syncProjectChangeState]);

    const workspaceMetrics = useMemo(() => {
        // 无中间数组：boards 变化时也只是 O(元素数) 的线性累加，不再每次 filter 分配。
        let totalElementCount = 0;
        let assetLinkedElementCount = 0;
        for (const board of boards) {
            const boardElements = board.elements ?? [];
            totalElementCount += boardElements.length;
            for (const element of boardElements) {
                if (element.assetId) assetLinkedElementCount += 1;
            }
        }
        return {
            totalElementCount,
            assetLinkedElementCount,
            currentBoardElementCount: elements.length,
            currentBoardFrameCount: frames.length,
        };
    }, [boards, elements.length, frames.length]);

    const workspaceActivity = useMemo(() => {
        if (currentImportProgress) {
            const { assetOrdinal, assetCount, job } = currentImportProgress;
            return {
                tone: 'working' as WorkspaceActivityTone,
                message: `Saving asset ${assetOrdinal}/${assetCount}: ${job.displayName ?? job.assetId}.`,
            };
        }
        if (isSavingProject) {
            return { tone: 'working' as WorkspaceActivityTone, message: 'Saving project…' };
        }
        return lastWorkspaceActivity;
    }, [currentImportProgress, isSavingProject, lastWorkspaceActivity]);

    // 旧实现每次 getCanvasPoint 都 getBoundingClientRect()：交互热路径上每帧两次强制同步布局。
    // 这里按"元素 + 布局变化"缓存，布局变化由 ResizeObserver / window resize 失效。
    // 量的是**外层容器**：相机 transform 挂在 <svg> 元素自身（GPU 合成，见 ADR-049），
    // <svg> 的 rect 随 pan/zoom 漂移，只有未变换的容器盒子是稳定的换算基准。
    const canvasRectCacheRef = useRef<{ element: SVGSVGElement | null; rect: DOMRect | null }>({
        element: null,
        rect: null,
    });
    const invalidateCanvasRect = useCallback(() => {
        canvasRectCacheRef.current = { element: null, rect: null };
    }, []);
    const readCanvasRect = useCallback((): DOMRect | null => {
        const element = svgRef.current;
        if (!element) return null;
        const cache = canvasRectCacheRef.current;
        if (cache.element === element && cache.rect) return cache.rect;
        const rect = getCanvasScreenRect(element);
        canvasRectCacheRef.current = { element, rect };
        return rect;
    }, [svgRef]);

    useEffect(() => {
        const element = svgRef.current;
        const container = element?.parentElement;
        window.addEventListener('resize', invalidateCanvasRect);
        let observer: ResizeObserver | null = null;
        if (container && typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(invalidateCanvasRect);
            observer.observe(container);
        }
        return () => {
            window.removeEventListener('resize', invalidateCanvasRect);
            observer?.disconnect();
        };
    }, [invalidateCanvasRect, svgRef]);

    const getCanvasPoint = useCallback((clientX: number, clientY: number): Point => {
        const rect = readCanvasRect();
        if (!rect) return { x: 0, y: 0 };
        // 相机读 live 值：手势中（未提交）的平移/缩放也要命中正确坐标。
        const liveViewport = canvasViewportStore.getLive();
        return {
            x: (clientX - rect.left - liveViewport.panOffset.x) / liveViewport.zoom,
            y: (clientY - rect.top - liveViewport.panOffset.y) / liveViewport.zoom,
        };
    }, [readCanvasRect, canvasViewportStore]);

    // AI 生成本体已迁到 builtin.ai-providers 插件：这里只把「用哪个 provider」交给运行时决议，
    // 本体不再出现任何具体 provider id —— 之后插件侧增删 provider 无需改动本体。
    const invokeProvider: InvokeAIProvider = useCallback(
        (request: AIProviderRequest) => invokeAIProvider(pluginKernel, resolveProviderId(pluginKernel, request), request),
        [pluginKernel],
    );

    const {
        handleAIGenerateRotation,
        handleRemoveBackground,
        handleGetPromptFromImage,
        handleGenerate,
        handleRasterizeSelection,
    } = useAIHandlers({
        invokeProvider,
        elements,
        selectedElementIds,
        zoom,
        panOffset,
        generationMode,
        videoAspectRatio,
        numberOfVideos,
        numberOfImages,
        imageAspectRatio,
        prompt,
        setPrompt,
        setIsLoading,
        setError,
        setProgressMessage,
        setSelectedElementIds,
        addElementsWithParenting,
        commitAction,
        setAiRotationState,
        getCanvasPoint,
        svgRef,
    });

    const {
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
    } = useCanvasInteractions({
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
        onAIRotateFinish: handleAIGenerateRotation,
        interactionViewportIndexRef,
        // PureRef 对齐 ③：网格吸附
        gridSnap,
        gridSize,
        viewportStore: canvasViewportStore,
        dragSessionStore: canvasDragSessionStore,
        contentInteractionStore: canvasContentInteractionStore,
        selectionPreviewStore: canvasSelectionPreviewStore,
        transformSessionStore: canvasTransformSessionStore,
    });

    const {
        handleDeleteElement,
        handleDeleteSelection,
        handleCopyElement,
        handleCopySelection,
        handleCopy,
        handlePasteElements,
        handleDownloadImage,
        handleStartCrop,
        handleCancelCrop,
        handleConfirmCrop,
        handleGroup,
        handleUngroup,
        handleMergeGroup,
        handleAutoCombine,
        handleAlignSelection,
        handlePropertyChange,
        handleSelectionPropertyChange,
        handleLayerAction,
        handleReorderElements,
        handleSetActiveTool,
        handleFrameAspectRatioChange,
        handleStartAIRotate,
        handleStopEditing,
        handleMasonryLayout,
        isElementVisible,
    } = useElementActions({
        elements,
        selectedElementIds,
        setSelectedElementIds,
        commitAction,
        addElementsWithParenting,
        zoom,
        invokeProvider,
        setIsLoading,
        setError,
        setProgressMessage,
        setActiveTool,
        setAiRotationState,
        setCroppingState,
        croppingState,
        setContextMenu,
        setDrawingOptions,
    });

    const handleFocusImage = useCallback((id: string) => {
        const image = elements.find(element => element.id === id && element.type === 'image');
        if (!image || image.isVisible === false) return;
        const bounds = getSelectionBounds([image], elements); // rotation-aware bounding box
        if (bounds.width > 0 && bounds.height > 0) {
            zoomToBounds(bounds, { animated: false, minZoom: 0.02 });
        }
    }, [elements, zoomToBounds]);

    const handleFocusSelection = useCallback(() => {
        if (selectedElementIds.length > 0) {
            const bounds = getSelectionBounds(selectedElementIds, elements);
            zoomToBounds(bounds, { animated: true });
        }
    }, [selectedElementIds, elements, zoomToBounds]);

    // R28 uses the exact same bounded Navigator fit helper; it changes only current camera metadata.
    const handleFitCanvas = useCallback(() => {
        const viewport = getCanvasScreenRect(svgRef.current);
        if (!viewport || viewport.width <= 0 || viewport.height <= 0) return;
        const next = fitCanvasViewport(createCanvasNavigatorModel(elements).contentBounds, {
            width: viewport.width,
            height: viewport.height,
        });
        if (!next) return;
        updateActiveBoard(board => ({ ...board, panOffset: next.panOffset, zoom: next.zoom }));
    }, [elements, svgRef, updateActiveBoard]);

    const {
        handleAddBoard,
        handleDuplicateBoard,
        handleDeleteBoard,
        handleRenameBoard,
        handleCanvasBackgroundColorChange,
    } = useBoardActions({
        boards,
        setBoards,
        activeBoardId,
        setActiveBoardId: handleSetActiveBoardId,
        updateActiveBoard,
    });

    const [psdModalState, setPsdModalState] = useState<{ psdData: PsdParseResult; dropPoint?: { x: number; y: number } } | null>(null);
    const [isExtensionImportPanelOpen, setIsExtensionImportPanelOpen] = useState(false);

    // V3：受管扩展导入 —— 后台 Worker 解析（真实进度/取消）→ 单事务节点提交 → 面板观察。
    const importExtensionFiles = useCallback(async (files: File[], dropPoint?: { x: number; y: number }): Promise<boolean> => {
        const host = getExtensionHost();
        if (!host) return false;
        const groups = new Map<string, File[]>();
        for (const file of files) {
            const packageId = host.runtime.matchFormat(file);
            if (!packageId) continue;
            const list = groups.get(packageId) ?? [];
            list.push(file);
            groups.set(packageId, list);
        }
        if (groups.size === 0) return false;
        const sdk = documentSdkRef.current;
        if (!sdk) throw new Error('Document SDK not ready for extension import');
        const state = documentState.getSnapshot();
        const boardId = state.activeBoardId;
        const operationsService = sdk.forConsumer('core.extension-import', new AbortController().signal).operations;
        for (const [packageId, group] of groups) {
            const entry = host.runtime.installed().find(item => item.package.id === packageId);
            if (!entry?.enabled) throw new Error(`Extension not active: ${packageId}`);
            const nodeType = entry.package.node.id;
            const batchId = host.runtime.beginBatch(packageId, boardId);
            const controller = new AbortController();
            setIsExtensionImportPanelOpen(true);
            for (const file of group) {
                const entryId = generateId();
                host.runtime.addFileEntry(batchId, { id: entryId, name: file.name });
                try {
                    const records = await host.runtime.parseFile(packageId, file, controller.signal, progress => {
                        try { host.runtime.updateBatchProgress(batchId, entryId, progress); } catch { /* batch terminal */ }
                    });
                    host.runtime.completeFileEntry(batchId, entryId, records);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    try { host.runtime.markBatchEntryFailed(batchId, entryId, message); } catch { /* batch terminal */ }
                }
            }
            const baseX = dropPoint?.x ?? 0;
            const baseY = dropPoint?.y ?? 0;
            host.runtime.commitBatch(batchId, boardId, entries => {
                const operations = entries.flatMap(entry => entry.records.map((record, i) => ({
                    kind: 'extension.node.create' as const,
                    node: {
                        id: `${entry.id}-${i}`,
                        typeId: nodeType,
                        x: baseX + (i % 4) * 260,
                        y: baseY + Math.floor(i / 4) * 160,
                        data: record,
                    },
                })));
                const result = operationsService.apply({
                    sessionId: state.sessionId,
                    boardId,
                    revision: documentState.revision(boardId),
                    requestId: `ext-import-${batchId}`,
                    label: `Import ${operations.length} extension node(s)`,
                    operations,
                });
                if (result.status !== 'applied' && result.status !== 'noop') {
                    throw new Error(result.message ?? result.code ?? 'Commit rejected');
                }
            });
        }
        return true;
    }, [documentState]);

    // Live, stable read port: import batches must not publish while another
    // canvas operation (including a transient drag/camera gesture) is active.
    const importInteractionRef = useRef(isDocumentInteractionPending);
    importInteractionRef.current = isDocumentInteractionPending;
    const isCanvasBusyForImport = useCallback(() => importInteractionRef.current()
        || canvasDragSessionStore.isActive()
        // P1-1：缩放/旋转/绘制会话期间文档不动，但预览几何握在通道里。
        // 此时放行一次批量导入，会让预览的基准元素在同一帧被换掉（用户看到的手势白做）。
        || canvasTransformSessionStore.isActive()
        || canvasViewportStore.isTransient(), [canvasDragSessionStore, canvasTransformSessionStore, canvasViewportStore]);

    // Import-only, one-shot visual metadata. Do not put animation flags or large
    // image URLs into Board state, saved projects, or the operation history.
    const importRevealQueueRef = useRef<ImportRevealRequest | null>(null);
    const stageImportedImages = useCallback((items: CanvasElement[]) => {
        const ids = items.filter(item => item.type === 'image')
            .slice(0, IMPORT_REVEAL_MAX_IMAGES).map(item => item.id);
        if (!ids.length) return;
        const state = documentState.getSnapshot();
        const scope = `${state.sessionId}:${state.activeBoardId}`;
        const previous = importRevealQueueRef.current;
        importRevealQueueRef.current = {
            scope,
            ids: previous?.scope === scope
                ? [...previous.ids, ...ids].slice(0, IMPORT_REVEAL_MAX_IMAGES) : ids,
        };
    }, [documentState]);
    const importRevealScope = `${documentState.getSnapshot().sessionId}:${activeBoardId}`;

    const {
        handleAddFiles,
        handleImportPsdMerged,
        handleImportPsdLayers,
        handleCanvasBackgroundImageChange,
    } = useFileHandlers({
        getCanvasPoint,
        addElementsWithParenting,
        endImportHistoryGroup,
        documentState,
        isCanvasBusy: isCanvasBusyForImport,
        onImportElementsReady: stageImportedImages,
        setSelectedElementIds,
        setActiveTool,
        setError,
        svgRef,
        updateActiveBoard,
        openPsdModal: (psdData, dropPoint) => setPsdModalState({ psdData, dropPoint }),
        setIsLoading,
        setProgressMessage,
        importExtensionFiles,
    });

    useKeyboardShortcuts({
        presentationState,
        presentationHotkeys,
        handleNavigateWithTransition,
        handleExitPresentation,
        aiRotationState,
        setAiRotationState,
        editingElement,
        handleStopEditing: () => handleStopEditing(editingElement, setEditingElement),
        activeTool,
        setActiveTool,
        shiftEraseOriginalTool,
        handleUndo,
        handleRedo,
        selectedElementIds,
        handleDeleteSelected: handleDeleteSelection,
        handleFocusSelection,
        handleCopy,
        handlePasteElements,
        handleAddFiles,
        addElementsWithParenting,
        getCanvasCenterPoint: () => {
            const r = getCanvasScreenRect(svgRef.current);
            if (!r) return { x: 0, y: 0 };
            return getCanvasPoint(r.left + r.width / 2, r.top + r.height / 2);
        },
    });

    const handleOpenProjectClick = async () => {
        setIsLoading(true);
        setLastWorkspaceActivity({ tone: 'working', message: 'Opening workspace…' });
        try {
            const data = await openProjectFolder();
            if (data && loadBoardData(data)) {
                pendingProjectLoadBaselineRef.current = true;
                setHasProjectSaveBaseline(true);
                setLastWorkspaceActivity({ tone: 'success', message: 'Workspace loaded.' });
            } else {
                setLastWorkspaceActivity({ tone: 'neutral', message: 'No saved workspace was loaded.' });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Failed to open project:', error);
            setError(`Failed to open project: ${message}`);
            setLastWorkspaceActivity({ tone: 'error', message: 'Unable to open the workspace.' });
        } finally {
            setIsLoading(false);
        }
    };

    // 最近工程：路径来自主进程的最近列表，直接打开，不弹目录对话框。
    // 与 handleOpenProjectClick 的后处理刻意保持一致 —— 两条入口若不一致，
    // 会出现"从最近打开的项目没有保存基线"这类只在一条路径上复现的怪问题。
    const handleOpenRecentProjectClick = async (projectRoot: string) => {
        setIsLoading(true);
        setLastWorkspaceActivity({ tone: 'working', message: 'Opening workspace…' });
        try {
            const data = await openRecentProject(projectRoot);
            if (data && loadBoardData(data)) {
                pendingProjectLoadBaselineRef.current = true;
                setHasProjectSaveBaseline(true);
                setLastWorkspaceActivity({ tone: 'success', message: 'Workspace loaded.' });
            } else {
                setLastWorkspaceActivity({ tone: 'neutral', message: 'No saved workspace was loaded.' });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Failed to open recent project:', error);
            setError(`Failed to open project: ${message}`);
            setLastWorkspaceActivity({ tone: 'error', message: 'Unable to open the workspace.' });
        } finally {
            setIsLoading(false);
        }
    };

    // overrideBoards：关闭确认里的“保存并关闭”会传入补齐瞬时相机的快照（boards state 可能
    // 还没反映最后一次拖动/滚轮的 live 相机）。返回是否真的写入了项目，失败/取消返回 false，
    // 调用方据此决定是否放行关窗。
    const handleSaveProjectClick = async (overrideBoards?: typeof boards): Promise<boolean> => {
        // 工具栏按钮会把点击事件传进来；只有画板数组才当作关闭前的相机快照。
        const boardsAtSaveStart = Array.isArray(overrideBoards) ? overrideBoards : boards;
        setIsLoading(true);
        setIsSavingProject(true);
        setProgressMessage('Saving project...');
        setLastWorkspaceActivity({ tone: 'working', message: 'Saving project…' });
        try {
            const didSave = await saveProject(boardsAtSaveStart);
            if (didSave) {
                syncProjectChangeState(completeProjectSave(
                    projectChangeStateRef.current,
                    boardsAtSaveStart,
                    latestBoardsRef.current,
                ));
                setHasProjectSaveBaseline(true);
            }
            setLastWorkspaceActivity(didSave
                ? { tone: 'success', message: 'Project saved.' }
                : { tone: 'warning', message: 'Save was cancelled before a project was written.' });
            return didSave;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const wasCancelled = /did not complete: cancelled/.test(message);
            console.error('Failed to save project:', error);
            setError(wasCancelled
                ? 'Project save stopped because an import was cancelled.'
                : `Failed to save project: ${message}`);
            setLastWorkspaceActivity(wasCancelled
                ? { tone: 'warning', message: 'Project save stopped because an import was cancelled.' }
                : { tone: 'error', message: 'Unable to save the project.' });
            return false;
        } finally {
            setIsSavingProject(false);
            setIsLoading(false);
            setProgressMessage('');
        }
    };

    const handleOpenImportJobs = () => {
        setIsWorkspacePanelOpen(false);
        setIsImportJobsPanelOpen(true);
        void refreshImportJobs().catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            setError(`Failed to refresh import jobs: ${message}`);
        });
    };

    // R21 keeps view edits out of CanvasOperation: they are only Board camera metadata.
    const handleAddViewBookmark = (name: string) => {
        if (!activeBoard) return;
        const next = createCanvasViewBookmark({
            id: generateId(),
            name,
            panOffset: { ...panOffset },
            zoom,
        }, `View ${(activeBoard.viewBookmarks?.length ?? 0) + 1}`);
        if (!next) return;
        updateActiveBoard(board => ({
            ...board,
            viewBookmarks: appendCanvasViewBookmark(board.viewBookmarks, next),
        }));
    };

    const handleRestoreViewBookmark = (bookmark: CanvasViewBookmark) => {
        updateActiveBoard(board => ({
            ...board,
            panOffset: { ...bookmark.panOffset },
            zoom: bookmark.zoom,
        }));
        setIsViewBookmarksPanelOpen(false);
    };

    const handleRenameViewBookmark = (id: string, name: string) => {
        updateActiveBoard(board => ({
            ...board,
            viewBookmarks: renameCanvasViewBookmark(board.viewBookmarks, id, name),
        }));
    };

    const handleDeleteViewBookmark = (id: string) => {
        updateActiveBoard(board => ({
            ...board,
            viewBookmarks: removeCanvasViewBookmark(board.viewBookmarks, id),
        }));
    };

    // R22 finder is read-only until Focus; Focus preserves zoom and changes only current camera pan.
    const handleFocusCanvasFinderResult = (result: CanvasFinderResult) => {
        const viewport = getCanvasScreenRect(svgRef.current);
        if (!viewport) return;
        const panOffsetForResult = focusCanvasFinderResult(result, {
            width: viewport.width,
            height: viewport.height,
        }, zoom);
        if (!panOffsetForResult) return;
        updateActiveBoard(board => ({ ...board, panOffset: panOffsetForResult }));
        setIsCanvasFinderPanelOpen(false);
    };

    useEffect(() => {
        if (!currentImportProgress) return;
        const { assetOrdinal, assetCount, job } = currentImportProgress;
        const displayName = job.displayName ?? job.assetId;
        const percent = Math.round(Math.max(0, Math.min(1, job.progress)) * 100);
        setProgressMessage(`Saving asset ${assetOrdinal}/${assetCount}: ${displayName} (${percent}%)`);
    }, [currentImportProgress]);

    // R24 tag writes deliberately use the existing element operation boundary; editor state itself is transient.
    const handleOpenElementTags = () => {
        const ids = selectedElementIds.filter((id, index) =>
            selectedElementIds.indexOf(id) === index && elements.some(element => element.id === id));
        if (ids.length > 0) setTagEditorElementIds(ids);
    };

    const handleAddElementTag = (rawTag: string): boolean => {
        const tag = normalizeElementTag(rawTag);
        const targetIds = new Set(tagEditorElementIds ?? []);
        if (!tag || targetIds.size === 0) return false;
        const canAdd = elements.some(element => {
            if (!targetIds.has(element.id)) return false;
            const currentTags = normalizeElementTags(element.tags);
            return !sameTags(currentTags, addElementTag(currentTags, tag));
        });
        if (!canAdd) return false;
        commitAction(previous => previous.map(element => {
            if (!targetIds.has(element.id)) return element;
            const currentTags = normalizeElementTags(element.tags);
            const nextTags = addElementTag(currentTags, tag);
            return sameTags(currentTags, nextTags) ? element : { ...element, tags: nextTags };
        }));
        return true;
    };

    const handleRemoveElementTag = (rawTag: string): boolean => {
        const tag = normalizeElementTag(rawTag);
        const targetIds = new Set(tagEditorElementIds ?? []);
        if (!tag || targetIds.size === 0) return false;
        const canRemove = elements.some(element => targetIds.has(element.id)
            && normalizeElementTags(element.tags).includes(tag));
        if (!canRemove) return false;
        commitAction(previous => previous.map(element => {
            if (!targetIds.has(element.id)) return element;
            const currentTags = normalizeElementTags(element.tags);
            const nextTags = removeElementTag(currentTags, tag);
            if (sameTags(currentTags, nextTags)) return element;
            if (nextTags.length > 0) return { ...element, tags: nextTags };
            const { tags: _removedTags, ...withoutTags } = element;
            return withoutTags as CanvasElement;
        }));
        return true;
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                handleSaveProjectClick();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [boards, saveProject]);

    // R34: Startup auto-recovery for managed desktop projects (REQ-001)
    useEffect(() => {
        let isMounted = true;
        const attemptStartupRecovery = async () => {
            if (!isManagedProjectStorageAvailable) return;
            try {
                const restoredDoc = await restoreStartupProject();
                if (!isMounted || !restoredDoc) return;
                if (loadBoardData(restoredDoc)) {
                    pendingProjectLoadBaselineRef.current = true;
                    setHasProjectSaveBaseline(true);
                    setLastWorkspaceActivity({ tone: 'success', message: 'Workspace restored.' });
                }
            } catch (error) {
                console.warn('Startup project recovery failed:', error);
            }
        };
        void attemptStartupRecovery();
        return () => { isMounted = false; };
    }, [isManagedProjectStorageAvailable, loadBoardData, restoreStartupProject]);

    // R34 修订（手动保存制）：不再自动保存。数据只在用户点保存（工具栏/面板/Ctrl+S）时落盘；
    // 有未保存改动时拦截窗口关闭/刷新，弹确认模态让用户选择“保存并关闭 / 不保存 / 取消”。
    const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
    const isCloseConfirmOpenRef = useRef(false);
    isCloseConfirmOpenRef.current = isCloseConfirmOpen;
    // 放行标志：确认模态做出决定（保存成功 / 放弃更改）后置位，让下一次 beforeunload 通过。
    const forceCloseRef = useRef(false);
    const isSaveAndCloseRunningRef = useRef(false);

    // 关闭前把未提交的瞬时相机补进快照（此时 React 状态更新已来不及反映到 ref）。
    const buildClosingSnapshot = () => {
        const live = canvasViewportStore.getLive();
        return canvasViewportStore.isTransient()
            ? latestBoardsRef.current.map(board => (
                board.id === activeBoardId
                    ? { ...board, panOffset: live.panOffset, zoom: live.zoom }
                    : board
            ))
            : latestBoardsRef.current;
    };

    const handleSaveAndClose = async () => {
        if (isSaveAndCloseRunningRef.current || isSavingProject) return;
        isSaveAndCloseRunningRef.current = true;
        try {
            const didSave = await handleSaveProjectClick(buildClosingSnapshot());
            if (didSave) {
                forceCloseRef.current = true;
                window.close();
            }
        } finally {
            isSaveAndCloseRunningRef.current = false;
        }
    };

    const handleDiscardAndClose = () => {
        forceCloseRef.current = true;
        window.close();
    };

    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            // 插件设置应用的受控重载（manager.reload → location.reload）→ 放行：
            // 这是导航不是关窗，弹关闭确认会误伤（确认按钮 window.close() 在 Electron 里会真退应用）。
            if (consumePluginReloadFlag()) return;
            // 已确认（保存成功 / 放弃更改）后的收尾关闭 → 直接放行。
            if (forceCloseRef.current) return;
            // 无未保存改动（或 browser 模式——数据本就即时持久化，与原 flush 条件一致）→ 放行。
            if (!hasUnsavedChanges || !isProjectOpen || !isManagedProjectStorageAvailable) return;
            // Electron：returnValue = false 同步取消关闭且不弹原生框，随后由我们弹确认模态。
            e.preventDefault();
            e.returnValue = false;
            if (!isCloseConfirmOpenRef.current) setIsCloseConfirmOpen(true);
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [hasUnsavedChanges, isProjectOpen, isManagedProjectStorageAvailable]);

    useEffect(() => {
        setTagEditorElementIds(openIds => {
            if (!openIds) return openIds;
            const selectionMatchesEditor = openIds.length === selectedElementIds.length
                && openIds.every(id => selectedElementIds.includes(id));
            return selectionMatchesEditor ? openIds : null;
        });
    }, [selectedElementIds]);

    useEffect(() => {
        setSelectedElementIds([]);
        setEditingElement(null);
        setCroppingState(null);
        setSelectionBox(null);
        setPrompt('');
        setAiRotationState(null);
        setIsViewBookmarksPanelOpen(false);
        setIsCanvasFinderPanelOpen(false);
        setIsCommandPaletteOpen(false);
        setTagEditorElementIds(null);
    }, [activeBoardId]);

    const [pluginDropNotice, setPluginDropNotice] = useState<string | null>(null);
    useEffect(() => {
        if (!pluginDropNotice) return;
        const timer = setTimeout(() => setPluginDropNotice(null), 5000);
        return () => clearTimeout(timer);
    }, [pluginDropNotice]);

    const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);
    const handleDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        const dropPoint = getCanvasPoint(e.clientX, e.clientY);
        const files = e.dataTransfer.files && e.dataTransfer.files.length > 0 ? Array.from(e.dataTransfer.files) : [];
        // 画布拖拽安装：拖入「恰好一个」落点且被识别为插件来源（.zip 含 manifest 或文件夹含 manifest）
        // 时走安装流程，不混入画布资产导入；其余（多文件 / 普通素材 / 非插件 zip）照常作为资产导入。
        if (files.length === 1 && typeof window.artflowApp?.isPluginSourcePath === 'function') {
            const dropped = files[0] as File & { path?: string };
            const dropPath = dropped.path;
            if (typeof dropPath === 'string' && dropPath.length > 0) {
                try {
                    if (await window.artflowApp.isPluginSourcePath(dropPath)) {
                        const result = await window.artflowApp.installExternalPluginFromPath(dropPath);
                        if (result && result.ok) {
                            reloadForPluginApply(); // 受控重载使插件生效（跳过未保存确认）
                            return;
                        }
                        setPluginDropNotice(result && result.message ? `插件安装失败：${result.message}` : '插件安装失败');
                        return;
                    }
                } catch {
                    // 预检失败 → 当作普通资产继续，不阻断拖拽导入
                }
            }
        }
        if (files.length > 0) handleAddFiles(files, dropPoint);
    }, [handleAddFiles, getCanvasPoint]);

    const handleContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
        e.preventDefault();
        setContextMenu(null);
        const target = e.target as SVGElement;
        const elementId = target.closest('[data-id]')?.getAttribute('data-id');
        setContextMenu({ x: e.clientX, y: e.clientY, elementId: elementId || null });
    };

    useEffect(() => {
        const handlePaste = (e: ClipboardEvent) => { 
            // 输入框 / 可编辑区域内粘贴交给浏览器默认行为：
            // 不要吞掉文本（否则所有输入框都粘不进来），更不要误创建一个画布文本元素。
            const pasteTarget = e.target as HTMLElement | null;
            if (pasteTarget && (
                pasteTarget.tagName === 'INPUT' ||
                pasteTarget.tagName === 'TEXTAREA' ||
                pasteTarget.isContentEditable
            )) {
                return;
            }
            let targetPoint = { x: 0, y: 0 };
            if (mousePosRef.current && svgRef.current) {
                targetPoint = getCanvasPoint(mousePosRef.current.x, mousePosRef.current.y);
            } else {
                 const rect = getCanvasScreenRect(svgRef.current);
                 if (rect) {
                     const centerX = rect.width / 2;
                     const centerY = rect.height / 2;
                     targetPoint = getCanvasPoint(rect.left + centerX, rect.top + centerY);
                 }
            }

            const items = e.clipboardData?.items;
            const pastedFiles: File[] = [];
            if (items) {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file' && (items[i].type.indexOf("image") !== -1 || items[i].type.indexOf("video") !== -1)) {
                        const blob = items[i].getAsFile();
                        if (blob) pastedFiles.push(blob);
                    }
                }
            }
            if (pastedFiles.length > 0) {
                e.preventDefault();
                handleAddFiles(pastedFiles, targetPoint);
                return;
            }

            const text = e.clipboardData?.getData('text');
            if (text) {
                try {
                    const data = JSON.parse(text);
                    if (data?.type === 'artflow-elements' && Array.isArray(data.elements)) {
                        e.preventDefault();
                        handlePasteElements(data.elements, targetPoint);
                        return;
                    }
                } catch (err) {}

                if (isSvgString(text)) {
                    e.preventDefault();
                    const svgRes = parseSvgContent(text, 'Vector.svg');
                    const id = generateId();
                    const newSvgElement: ImageElement = {
                        id,
                        type: 'image',
                        name: 'Vector',
                        x: targetPoint.x - svgRes.width / 2,
                        y: targetPoint.y - svgRes.height / 2,
                        width: svgRes.width,
                        height: svgRes.height,
                        href: svgRes.dataUrl,
                        originalHref: svgRes.dataUrl,
                        mimeType: 'image/svg+xml',
                        opacity: 1,
                        borderRadius: 0,
                        rotation: 0,
                    };
                    addElementsWithParenting([newSvgElement]);
                    setSelectedElementIds([id]);
                    setActiveTool('select');
                    return;
                }

                if (text.trim().length > 0) {
                    e.preventDefault();
                    const newText: TextElement = {
                        id: generateId(),
                        type: 'text',
                        name: 'Text',
                        x: targetPoint.x,
                        y: targetPoint.y,
                        width: 200, 
                        height: 40, 
                        text: text,
                        fontSize: 24,
                        fontColor: '#FFFFFF',
                        rotation: 0,
                    };
                    addElementsWithParenting([newText]);
                    setSelectedElementIds([newText.id]);
                }
            }
        };
        window.addEventListener('paste', handlePaste);
        return () => window.removeEventListener('paste', handlePaste);
    }, [handleAddFiles, handlePasteElements, getCanvasPoint, addElementsWithParenting, setSelectedElementIds]);

    // R25/R28: App consumes generic extension hosts and offers only a narrow, live renderer action service.
    const pluginPanels = listPanelContributions(pluginKernel);
    const pluginPanelCount = pluginPanels.length;
    const appearancePanel = pluginPanels.find(panel => panel.value.quickEntry === 'appearance');
    // 主题工作台作为悬浮面板打开（非模态、可拖拽、背景界面实时可见），而不是塞进带遮罩的设置模态。
    const openAppearanceStudio = () => {
        setPanelHostId(appearancePanel?.id ?? 'builtin.panel-skin-picker');
        setIsPanelHostOpen(true);
    };
    workspaceCommandActionsRef.current = {
        fitCanvas: handleFitCanvas,
        canFitCanvas: () => {
            const viewport = getCanvasScreenRect(svgRef.current);
            return Boolean(viewport && viewport.width > 0 && viewport.height > 0
                && fitCanvasViewport(createCanvasNavigatorModel(elements).contentBounds, {
                    width: viewport.width,
                    height: viewport.height,
                }));
        },
        openCanvasFinder: () => {
            setIsViewBookmarksPanelOpen(false);
            setIsCanvasFinderPanelOpen(true);
        },
        openSavedViews: () => {
            setIsCanvasFinderPanelOpen(false);
            setIsViewBookmarksPanelOpen(true);
        },
        openExtensions: () => {
            // 统一入口：扩展工具目录页已收敛进设置的「插件与扩展」。
            setRequestedSettingsSectionId('builtin.settings-plugins');
            setIsSettingsPanelOpen(true);
        },
        canOpenExtensions: () => true,
    };
    elementCommandActionsRef.current = {
        undo: handleUndo,
        redo: handleRedo,
        copy: handleCopy,
        deleteSelection: handleDeleteSelection,
        canEditSelection: () => selectedElementIds.length > 0,
        startPresentation: () => handleStartPresentation(),
        presentationNext: () => handleNavigatePresentation('next'),
        presentationPrev: () => handleNavigatePresentation('prev'),
        exitPresentation: handleExitPresentation,
        isPresenting: () => Boolean(presentationState?.isActive),
    };
    aiGenerateRef.current = () => { void handleGenerate(); };
    useEffect(() => pluginKernel.replace(
        WORKSPACE_COMMAND_ACTIONS_SERVICE,
        workspaceCommandServiceRef.current,
    ), [pluginKernel]);
    useEffect(() => pluginKernel.replace(
        ELEMENT_COMMAND_ACTIONS_SERVICE,
        elementCommandServiceRef.current,
    ), [pluginKernel]);
    useEffect(() => pluginKernel.replace(
        AI_SESSION_SERVICE,
        aiSessionServiceRef.current,
    ), [pluginKernel]);

    // Public SDK consumes the same synchronous Board[] owner and existing history journal.
    const documentHostRef = useRef({ selectedElementIds, isDocumentInteractionPending });
    documentHostRef.current = { selectedElementIds, isDocumentInteractionPending };
    const documentSdkRef = useRef<ReturnType<typeof createDocumentSDK> | null>(null);
    useEffect(() => {
        const directory = pluginKernel.has(SERVICE_DIRECTORY)
            ? pluginKernel.use<ServiceDirectory>(SERVICE_DIRECTORY) : createServiceDirectory();
        const removeDirectory = pluginKernel.has(SERVICE_DIRECTORY) ? () => {} : pluginKernel.provide(SERVICE_DIRECTORY, directory);
        const lifetime = new AbortController();
        const sdk = createDocumentSDK(documentState, {
            selection: () => documentHostRef.current.selectedElementIds,
            isBusy: () => documentHostRef.current.isDocumentInteractionPending()
                || canvasDragSessionStore.getSnapshot().elementIds !== null
                // P1-1：缩放/旋转/绘制会话进行中同样是"忙" —— 插件不能在这中间插一次文档写入，
                // 否则会与松手时的那一次一次性提交抢同一份 elements。
                || canvasTransformSessionStore.isActive(),
            onDeleted: (boardId, ids) => {
                const deleted = new Set(ids);
                setSelectedElementIds(previous => documentState.getSnapshot().activeBoardId === boardId
                    ? previous.filter(id => !deleted.has(id)) : previous);
            },
        }, { schemas: extensionSchemaProvider });
        documentSdkRef.current = sdk;
        let removeDocument = () => {};
        try {
            removeDocument = directory.provide(DOCUMENT_SERVICE, 1, DOCUMENT_PROVIDER, consumer =>
                sdk.forConsumer(consumer.pluginId, AbortSignal.any([consumer.signal, lifetime.signal])).document);
            const removeOperations = directory.provide(OPERATIONS_SERVICE, 1, DOCUMENT_PROVIDER, consumer =>
                sdk.forConsumer(consumer.pluginId, AbortSignal.any([consumer.signal, lifetime.signal])).operations);
            return () => { lifetime.abort(); removeOperations(); removeDocument(); removeDirectory(); };
        } catch (error) {
            lifetime.abort(); removeDocument(); removeDirectory(); throw error;
        }
    }, [pluginKernel, documentState, canvasDragSessionStore, canvasTransformSessionStore]);

    // —— 声明式扩展（V3–V7）：把文档侧 invoke/update 挂到引导期创建的单一运行时手柄上。——
    const stageExtensionHost = useCallback((sdk: ReturnType<typeof createDocumentSDK>) => {
        const host = getExtensionHost();
        if (!host) return;
        const operationsFor = (actor: string) => sdk.forConsumer(actor, new AbortController().signal).operations;
        host.updateNode = (elementId, data) => {
            const state = documentState.getSnapshot();
            const board = state.boards.find(candidate => candidate.id === state.activeBoardId);
            const element = board?.elements.find(candidate => candidate.id === elementId);
            if (!board || !element || typeof element.type !== 'string' || !element.type.startsWith('ext.')) {
                return { ok: false, error: 'Target is not an active extension node' };
            }
            const result = operationsFor('ui').apply({
                sessionId: state.sessionId,
                boardId: state.activeBoardId,
                revision: documentState.revision(board.id),
                requestId: `ext-ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
                label: 'Extension node properties',
                operations: [{ kind: 'extension.node.update', id: elementId, data }],
            });
            return result.status === 'applied' || result.status === 'noop'
                ? { ok: true }
                : { ok: false, error: result.message ?? result.code ?? 'Update rejected' };
        };
        host.invokeTool = (packageId, toolId, value, actor) => {
            const entry = host.runtime.installed().find(item => item.package.id === packageId);
            const tool = entry?.package.tools.find(item => item.id === toolId);
            if (!entry?.enabled || !tool) throw new Error(`Extension tool unavailable: ${packageId}.${toolId}`);
            const state = documentState.getSnapshot();
            const board = state.boards.find(candidate => candidate.id === state.activeBoardId);
            if (!board) throw new Error('No active board');
            const selected = new Set(documentHostRef.current.selectedElementIds);
            const nodeType = entry.package.node.id;
            const targets = board.elements.filter(el => (el as { type?: string }).type === nodeType && (selected.size === 0 || selected.has(el.id)));
            if (targets.length === 0) return Promise.resolve({ ok: false, error: 'No target extension nodes in scope' });
            const operations = targets.map(el => ({ kind: 'extension.node.update' as const, id: el.id, data: { [tool.field]: value } }));
            return Promise.resolve(executeGuardedTool(pluginKernel, {
                id: `${packageId}.${toolId}`,
                actor,
                args: { packageId, toolId, value, surface: actor, operationKinds: ['extension.node.update'] },
            }, async () => operationsFor('core.extension-tools').apply({
                sessionId: state.sessionId,
                boardId: state.activeBoardId,
                revision: documentState.revision(board.id),
                requestId: `ext-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
                label: `Extension tool ${toolId}`,
                operations,
            }), {
                authorize: () => {
                    const current = host.runtime.installed().find(item => item.package.id === packageId);
                    if (!current?.enabled) throw new Error(`Extension no longer active: ${packageId}`);
                    if (!current.grants.includes('document.write')) throw new Error('Extension lacks document.write grant');
                },
                timeoutMs: 15000,
            }));
        };
    }, [pluginKernel, documentState]);
    useEffect(() => {
        if (documentSdkRef.current) stageExtensionHost(documentSdkRef.current);
    }, [stageExtensionHost]);

    // PureRef 对齐：导出快照 / 元素修改 / 视图状态三个窄服务（ref 保活，render 期同步最新闭包）。
    const canvasExportSourceRef = useRef<CanvasExportSource>({
        getExportScope: () => null,
    });
    const canvasMutationRef = useRef<CanvasMutationService>({
        patchElements: () => false,
        getElements: () => [],
    });
    const canvasViewStateRef = useRef<CanvasViewStateService>({
        toggleDesaturate: () => {}, isDesaturate: () => false,
        toggleDimUnselected: () => {}, isDimUnselected: () => false,
        toggleGrid: () => {}, isGridVisible: () => false,
        toggleGridSnap: () => {}, isGridSnap: () => false,
        adjustGridSize: () => {}, gridSize: () => 32,
    });
    canvasExportSourceRef.current = {
        getExportScope: () => activeBoard ? {
            elements: activeBoard.elements,
            background: activeBoard.canvasBackgroundColor ?? null,
            selectionIds: selectedElementIds,
        } : null,
    };
    canvasMutationRef.current = {
        patchElements: (patches: readonly ElementPatch[], options?: { committed?: boolean; history?: 'record' | 'skip' }) => {
            if (patches.length === 0) return false;
            const patchById = new Map(patches.map(p => [p.id, p.patch]));
            const apply = (prev: typeof elements) => prev.map(el => {
                const patch = patchById.get(el.id);
                return patch ? { ...el, ...patch } as typeof el : el;
            });
            if (options?.history === 'skip') {
                updateActiveBoard(board => ({ ...board, elements: apply(board.elements) }));
                return true;
            }
            setElements(prev => apply(prev), options?.committed ?? true);
            return true;
        },
        getElements: () => elements,
    };
    canvasViewStateRef.current = {
        toggleDesaturate: () => setViewDesaturate(v => !v),
        isDesaturate: () => viewDesaturate,
        toggleDimUnselected: () => setViewDimUnselected(v => !v),
        isDimUnselected: () => viewDimUnselected,
        toggleGrid: () => setGridVisible(v => !v),
        isGridVisible: () => gridVisible,
        toggleGridSnap: () => setGridSnap(v => !v),
        isGridSnap: () => gridSnap,
        adjustGridSize: (delta: number) => setGridSize(size => Math.max(8, Math.min(256, size + delta))),
        gridSize: () => gridSize,
    };
    useEffect(() => {
        const disposers: Array<() => void> = [];
        try {
            disposers.push(provideLiveService(pluginKernel, CANVAS_EXPORT_SOURCE_SERVICE, canvasExportSourceRef));
            disposers.push(provideLiveService(pluginKernel, CANVAS_MUTATION_SERVICE, canvasMutationRef));
            disposers.push(provideLiveService(pluginKernel, CANVAS_VIEW_STATE_SERVICE, canvasViewStateRef));
        } catch (error) {
            for (const dispose of disposers.reverse()) dispose();
            throw error;
        }
        // 必须返回清理函数：StrictMode 双挂载时先卸后装，否则二次 provide 抛 "service already provided"。
        return () => disposers.forEach(dispose => dispose());
    }, [pluginKernel]);

    const isSelectionActive = selectedElementIds.length > 0;
    const singleSelectedElement = selectedElementIds.length === 1 ? elements.find(el => el.id === selectedElementIds[0]) : null;
    const activeViewBookmarks = activeBoard?.viewBookmarks ?? [];
    const tagEditorElements = useMemo(() => {
        if (!tagEditorElementIds) return [];
        const ids = new Set(tagEditorElementIds);
        return elements.filter(element => ids.has(element.id));
    }, [elements, tagEditorElementIds]);
    // V4：选中声明式扩展节点时显示 schema 驱动的通用编辑面板（无样例特判）。
    const extensionHost = getExtensionHost();
    const selectedExtensionElements = useMemo(() => {
        if (selectedElementIds.length === 0) return [];
        const ids = new Set(selectedElementIds);
        return elements.filter(element => typeof element.type === 'string' && element.type.startsWith('ext.') && ids.has(element.id));
    }, [elements, selectedElementIds]);

    const handleToggleSidePanel = (tab: 'layers' | 'frames') => {
        setSidePanel(prev => ({
            tab,
            isOpen: prev.tab === tab ? !prev.isOpen : true
        }));
    };

    // Personal board backgrounds always win. Wallpaper previews belong only to the
    // workspace's default theme background, never a user's board or presentation.
    const wallpaperEligible = !presentationState?.isActive && (!canvasBackgroundColor || canvasBackgroundColor === DEFAULT_CANVAS_BACKGROUND);
    const canvasStyle: React.CSSProperties = {};
    if (presentationState?.isActive) {
        canvasStyle.backgroundColor = '#000';
    } else if (canvasBackgroundColor?.startsWith('url(')) {
        canvasStyle.backgroundImage = canvasBackgroundColor;
        canvasStyle.backgroundSize = 'cover';
        canvasStyle.backgroundPosition = 'center';
        canvasStyle.backgroundColor = DEFAULT_CANVAS_BACKGROUND;
    } else if (!canvasBackgroundColor || canvasBackgroundColor === DEFAULT_CANVAS_BACKGROUND) {
        // 板未自定义背景 → 皮肤默认层接管：壁纸优先，回落画布底色（颜色/渐变均可，走 background 简写）
        canvasStyle.background = 'var(--bp-canvas-bg-image, var(--bp-canvas-bg, #111827)) center / cover no-repeat';
    } else {
        canvasStyle.backgroundColor = canvasBackgroundColor;
    }

    // —— workspace.ui-bridge：canvas_widgets 插件组件的状态桥（App 每次 render 原地更新，ref 突变不触发订阅）——
    const workspaceUiBridgeRef = useRef(workspaceUiBridge);
    workspaceUiBridgeRef.current.current = {
        dock: {
            storageMode: isManagedProjectStorageAvailable ? 'managed' : 'browser',
            projectName: projectFolderName,
            isProjectOpen,
            boardCount: boards.length,
            isSaving: isSavingProject,
            hasUnsavedChanges,
            hasProjectSaveBaseline,
            onOpen: () => setIsWorkspacePanelOpen(true),
        },
        projectPanel: {
            isOpen: isWorkspacePanelOpen,
            onClose: () => setIsWorkspacePanelOpen(false),
            storageMode: isManagedProjectStorageAvailable ? 'managed' : 'browser',
            projectName: projectFolderName,
            isProjectOpen,
            boardCount: boards.length,
            isSaving: isSavingProject,
            hasUnsavedChanges,
            hasProjectSaveBaseline,
            activeBoardName: activeBoard?.name ?? null,
            totalElementCount: workspaceMetrics.totalElementCount,
            assetLinkedElementCount: workspaceMetrics.assetLinkedElementCount,
            currentBoardElementCount: workspaceMetrics.currentBoardElementCount,
            currentBoardFrameCount: workspaceMetrics.currentBoardFrameCount,
            selectionCount: selectedElementIds.length,
            activity: workspaceActivity,
            canOpenImportJobs: isManagedImportJobsAvailable,
            onOpenProject: handleOpenProjectClick,
            onSaveProject: handleSaveProjectClick,
            onOpenImportJobs: handleOpenImportJobs,
        },
        finder: {
            isOpen: isCanvasFinderPanelOpen,
            elements,
            onClose: () => setIsCanvasFinderPanelOpen(false),
            onFocus: handleFocusCanvasFinderResult,
        },
        bookmarks: {
            isOpen: isViewBookmarksPanelOpen,
            bookmarks: activeViewBookmarks,
            onClose: () => setIsViewBookmarksPanelOpen(false),
            onAdd: handleAddViewBookmark,
            onRestore: handleRestoreViewBookmark,
            onRename: handleRenameViewBookmark,
            onDelete: handleDeleteViewBookmark,
        },
        navigator: {
            kernel: pluginKernel,
            svgRef,
            elements,
            selectedElementIds,
            panOffset,
            zoom,
            viewportStore: canvasViewportStore,
            viewBookmarkCount: activeViewBookmarks.length,
            onOpenFinder: () => {
                setIsViewBookmarksPanelOpen(false);
                setIsCanvasFinderPanelOpen(true);
            },
            onOpenViews: () => {
                setIsCanvasFinderPanelOpen(false);
                setIsViewBookmarksPanelOpen(true);
            },
            onViewportChange: next => updateActiveBoard(board => ({
                ...board,
                panOffset: next.panOffset,
                zoom: next.zoom,
            })),
        },
        importJobs: {
            isAvailable: isManagedImportJobsAvailable,
            isOpen: isImportJobsPanelOpen,
            onClose: () => setIsImportJobsPanelOpen(false),
            jobs: importJobs,
            currentProgress: currentImportProgress,
            isRefreshing: isRefreshingImportJobs,
            onRefresh: refreshImportJobs,
            onCancel: requestCancelImportJob,
        },
        topbar: {
            t,
            isBoardPanelOpen,
            setIsBoardPanelOpen,
            handleStartPresentation,
            framesCount: frames.length,
            handleToggleSidePanel,
            selectedElementCount: selectedElementIds.length,
            onOpenTags: handleOpenElementTags,
            commandCount: pluginKernel.contributions.list('commands').length,
            onOpenCommandPalette: () => setIsCommandPaletteOpen(true),
            pluginPanelCount,
            // 左上角扩展入口：直达设置里的「插件与扩展」section（不再打开独立目录页）。
            onOpenPluginPanels: () => { setRequestedSettingsSectionId('builtin.settings-plugins'); setIsSettingsPanelOpen(true); },
            appearancePanelTitle: appearancePanel ? resolvePanelText(appearancePanel.value, language).title : undefined,
            onOpenAppearance: openAppearanceStudio,
            setIsSettingsPanelOpen,
            onOpenProject: handleOpenProjectClick,
            onSaveProject: handleSaveProjectClick,
            onOpenImportJobs: handleOpenImportJobs,
            onOpenRecentProject: handleOpenRecentProjectClick,
            hasImportJobs: isManagedImportJobsAvailable,
            hasActiveImportJobs: importJobs.some(job => job.status === 'queued' || job.status === 'running'),
            projectFolderName,
        },
        board: {
            isOpen: isBoardPanelOpen,
            onClose: () => setIsBoardPanelOpen(false),
            boards,
            activeBoardId,
            onSwitchBoard: handleSetActiveBoardId,
            onAddBoard: handleAddBoard,
            onRenameBoard: handleRenameBoard,
            onDuplicateBoard: handleDuplicateBoard,
            onDeleteBoard: handleDeleteBoard,
            generateBoardThumbnail: (els) => generateBoardThumbnail(els, activeBoard?.canvasBackgroundColor ?? DEFAULT_CANVAS_BACKGROUND),
        },
        toolbar: {
            t,
            activeTool,
            setActiveTool: handleSetActiveTool,
            drawingOptions,
            setDrawingOptions,
            onUpload: (files) => handleAddFiles(files),
            isCropping: !!croppingState,
            onConfirmCrop: handleConfirmCrop,
            onCancelCrop: handleCancelCrop,
            onUndo: handleUndo,
            onRedo: handleRedo,
            canUndo,
            canRedo,
            position: toolbarPosition,
        },
        layer: {
            t,
            isOpen: sidePanel.isOpen,
            onClose: () => setSidePanel(prev => ({ ...prev, isOpen: false })),
            activeTab: sidePanel.tab,
            setActiveTab: (tab) => setSidePanel(prev => ({ ...prev, tab })),
            elements,
            selectedElementIds,
            onSelectElement: id => setSelectedElementIds(id ? [id] : []),
            onToggleVisibility: id => handlePropertyChange(id, { isVisible: !(elements.find(el => el.id === id)?.isVisible ?? true) }),
            onToggleLock: id => handlePropertyChange(id, { isLocked: !(elements.find(el => el.id === id)?.isLocked ?? false) }),
            onRenameElement: (id, name) => handlePropertyChange(id, { name }),
            onReorder: handleReorderElements,
            frames,
            onSelectFrame: (id) => zoomToFrame(id, { animated: true }),
            onDeleteFrame: handleDeleteElement,
        },
        psdModal: {
            isOpen: !!psdModalState,
            psdData: psdModalState?.psdData ?? null,
            onClose: () => setPsdModalState(null),
            onImportMerged: (data) => {
                handleImportPsdMerged(data, psdModalState?.dropPoint);
                setPsdModalState(null);
            },
            onImportLayers: (data, options) => {
                handleImportPsdLayers(data, psdModalState?.dropPoint, options);
                setPsdModalState(null);
            },
            t,
        },
        smartToolbar: {
            isVisible: smartToolbarState.show,
            top: smartToolbarState.top,
            left: smartToolbarState.left,
            selectionType: smartToolbarState.selectionType,
            onRemoveBackground: () => handleRemoveBackground(singleSelectedElement as ImageElement),
            onGetPrompt: () => handleGetPromptFromImage(singleSelectedElement as ImageElement),
            onAutoCombine: handleAutoCombine,
            onAIRotate: handleStartAIRotate,
            t,
        },
        tags: {
            isOpen: tagEditorElementIds !== null,
            selectedElements: tagEditorElements,
            onClose: () => setTagEditorElementIds(null),
            onAddTag: handleAddElementTag,
            onRemoveTag: handleRemoveElementTag,
        },
        promptBar: {
            t,
            prompt,
            setPrompt,
            onGenerate: handleGenerate,
            isLoading,
            isSelectionActive,
            selectedElementCount: selectedElementIds.length,
            userEffects,
            onAddUserEffect: handleAddUserEffect,
            onDeleteUserEffect: handleDeleteUserEffect,
            generationMode,
            setGenerationMode,
            videoAspectRatio,
            setVideoAspectRatio,
            imageAspectRatio,
            setImageAspectRatio,
            numberOfImages,
            setNumberOfImages,
            numberOfVideos,
            setNumberOfVideos,
            generateHotkey,
        },
        presentation: {
            active: Boolean(presentationState?.isActive),
            t,
            onPrev: () => handleNavigatePresentation('prev'),
            onNext: () => handleNavigatePresentation('next'),
            onExit: handleExitPresentation,
            onToggleTransition: () => setPresentationState(current => (
                current ? { ...current, transition: current.transition === 'smooth' ? 'direct' : 'smooth' } : current
            )),
            transition: presentationState?.transition ?? 'smooth',
            isPrevDisabled: false,
            isNextDisabled: false,
        },
    };
    // provide 必须发生在首帧渲染期间（早于 JSX return）：canvas_widgets 插件组件在首帧
    // 渲染树内就 kernel.use() 本服务，useEffect 时序必炸（service not provided）。
    // 守卫必须锚定「内核里已有的登记」而不是组件局部 ref：内核是跨挂载存活的单例（引导只在
    // index.tsx 跑一次），而 HMR / 受控刷新会重挂载 App 并重置 ref —— 那时二次 provide 会抛
    // "service already provided: workspace.ui-bridge"，整树卸载成白屏（"一改代码就空白"的来源）。
    // replace 幂等：重挂载时用本次挂载的 bridge 覆盖旧登记，内核始终指向活的 bridge 对象。
    const uiBridgeKernelRef = useRef<ReturnType<typeof getKernel> | null>(null);
    if (uiBridgeKernelRef.current !== pluginKernel) {
        pluginKernel.replace(WORKSPACE_UI_BRIDGE_SERVICE, workspaceUiBridgeRef.current);
        uiBridgeKernelRef.current = pluginKernel;
    }

    return (
        <div 
            className="w-screen h-screen flex flex-col font-sans relative" 
            data-bp-frameless={windowPlatform?.isFramelessWindow ? '' : undefined}
            data-bp-board-background={wallpaperEligible ? 'theme' : 'personal'}
            style={canvasStyle} 
            onDragOver={handleDragOver} 
            onDrop={handleDrop}
            onMouseMove={(e) => { mousePosRef.current = { x: e.clientX, y: e.clientY }; }}
        >
            <WorkspaceWallpaper active={wallpaperEligible} />
            <WorkspaceWallpaperSwitch active={wallpaperEligible} />
            {windowPlatform?.isFramelessWindow && <WindowChrome platform={windowPlatform} />}
            {/* 安全模式提示条：常驻、不可关闭 —— 见 components/SafeModeBanner.tsx 的说明。 */}
            <SafeModeBanner />
            {pluginDropNotice && (
                <div className="pointer-events-none fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-lg border border-rose-300/30 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-100">
                    {pluginDropNotice}
                </div>
            )}
            {isLoading && <Loader progressMessage={progressMessage} />}
            <ErrorOverlay error={error} setError={setError} />
            {!presentationState?.isActive && (
                <>
                    <CommandPalette
                        kernel={pluginKernel}
                        isOpen={isCommandPaletteOpen}
                        onOpen={() => setIsCommandPaletteOpen(true)}
                        onClose={() => setIsCommandPaletteOpen(false)}
                        commandSurfaceEnabled={!presentationState?.isActive}
                    />
                    {/* 扩展工具目录页已下线：插件与扩展、主题工作台统一收敛进 CanvasSettings
                        （settings_sections / navGroup 'extensions'）；TopBar 与命令入口全部 deep link 到设置。 */}
                    <WorkspaceWidgetHost kernel={pluginKernel} />
                    <WorkspaceWidgetHost kernel={pluginKernel} placement="tags" />
                    {isExtensionImportPanelOpen && (
                        <ExtensionImportPanel
                            runtime={extensionHost?.runtime ?? null}
                            onClose={() => setIsExtensionImportPanelOpen(false)}
                        />
                    )}
                    {selectedExtensionElements.length > 0 && extensionHost && (
                        <div data-bp-ui-surface="" className="fixed left-4 top-1/2 z-40 w-72 -translate-y-1/2 rounded-2xl border border-white/10 bg-zinc-900/95 p-3 text-white shadow-2xl backdrop-blur">
                            <h4 className="mb-2 text-sm font-semibold">Extension properties</h4>
                            <ExtensionNodeProperties
                                elements={selectedExtensionElements}
                                onCommit={(elementId, data) => extensionHost.updateNode(elementId, data)}
                            />
                        </div>
                    )}
                    <WorkspaceWidgetHost kernel={pluginKernel} placement="topbar" />
                    <WorkspaceWidgetHost kernel={pluginKernel} placement="board" />
                    <CanvasSettings 
                        kernel={pluginKernel}
                        isOpen={isSettingsPanelOpen}
                        requestedSectionId={requestedSettingsSectionId}
                        onClose={() => { setIsSettingsPanelOpen(false); setRequestedSettingsSectionId(null); }}
                        apiKey={apiKey}
                        setApiKey={setApiKey}
                        canvasBackgroundColor={canvasBackgroundColor} 
                        onCanvasBackgroundColorChange={handleCanvasBackgroundColorChange}
                        onCanvasBackgroundImageChange={handleCanvasBackgroundImageChange}
                        language={language}
                        setLanguage={setLanguage}
                        onOpenAppearance={openAppearanceStudio}
                        wheelAction={wheelAction}
                        setWheelAction={setWheelAction}
                        generateHotkey={generateHotkey}
                        setGenerateHotkey={setGenerateHotkey}
                        presentationHotkeys={presentationHotkeys}
                        setPresentationHotkeys={setPresentationHotkeys}
                        t={t}
                    />
                    <PluginPanelHost
                        kernel={pluginKernel}
                        isOpen={isPanelHostOpen}
                        initialPanelId={panelHostId}
                        onClose={() => setIsPanelHostOpen(false)}
                    />
                    <WorkspaceWidgetHost kernel={pluginKernel} placement="toolbar" />
                    <WorkspaceWidgetHost kernel={pluginKernel} placement="layer" />
                </>
            )}
            
            <CanvasToolbarHost kernel={pluginKernel} placement="smart" />

            <MainCanvas
                svgRef={svgRef}
                elements={elements}
                selectedElementIds={selectedElementIds}
                panOffset={panOffset}
                zoom={zoom}
                cursor={cursor}
                handleMouseDown={handleMouseDown}
                handleMouseMove={handleMouseMove}
                handleMouseUp={handleMouseUp}
                handleMouseLeave={handleCanvasMouseLeave}
                handleWheel={handleWheel}
                handleContextMenu={handleContextMenu}
                showCanvasMenu={(x, y, elementId) => setContextMenu({ x, y, elementId })}
                dismissCanvasMenu={() => setContextMenu(null)}
                windowPlatform={windowPlatform}
                activeTool={activeTool}
                focusImage={handleFocusImage}
                editingElement={editingElement}
                croppingState={croppingState}
                aiRotationState={aiRotationState}
                lassoPath={lassoPath}
                alignmentGuides={alignmentGuides}
                selectionBox={selectionBox}
                interactionMode={interactionMode.current}
                rotateStartInfo={rotateStartInfo.current}
                rotateDialPoint={rotateDialPoint}
                isElementVisible={isElementVisible}
                setEditingElement={setEditingElement}
                handleStopEditing={() => handleStopEditing(editingElement, setEditingElement)}
                setElements={setElements}
                singleSelectedElement={singleSelectedElement}
                handleCopySelection={handleCopySelection}
                handleGroup={handleGroup}
                handleRasterizeSelection={handleRasterizeSelection}
                handleSelectionPropertyChange={handleSelectionPropertyChange}
                handleAlignSelection={handleAlignSelection}
                handleMasonryLayout={handleMasonryLayout}
                handleCopyElement={handleCopyElement}
                handleFrameAspectRatioChange={handleFrameAspectRatioChange}
                handleUngroup={handleUngroup}
                handleMergeGroup={handleMergeGroup}
                handleDownloadImage={handleDownloadImage as any}
                handleStartCrop={handleStartCrop as any}
                handlePropertyChange={handlePropertyChange}
                handleDeleteElement={handleDeleteElement}
                isActivePresentation={presentationState?.isActive ?? false}
                t={t}
                isInteracting={isInteracting}
                interactionViewportIndexRef={interactionViewportIndexRef}
                viewportStore={canvasViewportStore}
                dragSessionStore={canvasDragSessionStore}
                contentInteractionStore={canvasContentInteractionStore}
                selectionPreviewStore={canvasSelectionPreviewStore}
                transformSessionStore={canvasTransformSessionStore}
                importRevealQueueRef={importRevealQueueRef}
                importRevealScope={importRevealScope}
                isImportRevealBusy={isCanvasBusyForImport}
                gridVisible={gridVisible}
                gridSize={gridSize}
                viewDesaturate={viewDesaturate}
                viewDimUnselected={viewDimUnselected}
            />
            
            <WorkspaceWidgetHost kernel={pluginKernel} placement="prompt" />
            <WorkspaceWidgetHost kernel={pluginKernel} placement="presentation" />
            {contextMenu && (
                <ContextMenu
                    kernel={pluginKernel}
                    x={contextMenu.x}
                    y={contextMenu.y}
                    language={language}
                    elementId={contextMenu.elementId}
                    elements={elements}
                    selectedElementIds={selectedElementIds}
                    actions={{
                        layerAction: handleLayerAction,
                        group: handleGroup,
                        ungroup: handleUngroup,
                        mergeGroup: handleMergeGroup,
                        copyElement: handleCopyElement,
                        copySelection: handleCopySelection,
                        deleteElement: handleDeleteElement,
                        deleteSelection: handleDeleteSelection,
                        rasterizeSelection: handleRasterizeSelection,
                    }}
                    onClose={() => setContextMenu(null)}
                />
            )}
            {isCloseConfirmOpen && (
                <div
                    data-bp-ui-scrim="" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
                    onMouseDown={e => { if (e.target === e.currentTarget) setIsCloseConfirmOpen(false); }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label="Unsaved changes"
                        data-bp-ui-surface="" className="w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/15 bg-neutral-950/95 text-white shadow-2xl"
                    >
                        <div className="border-b border-white/10 px-5 py-4">
                            <h2 className="text-sm font-semibold">Unsaved changes</h2>
                            <p className="mt-1.5 text-xs leading-5 text-neutral-300">
                                The workspace has changes that were not saved yet. Autosave is off — close without saving and they will be lost.
                            </p>
                        </div>
                        <div className="flex items-center justify-end gap-2 px-5 py-4">
                            <button
                                type="button"
                                onClick={() => setIsCloseConfirmOpen(false)}
                                className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm font-medium text-white hover:bg-white/10"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleDiscardAndClose}
                                className="rounded-xl border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-100 hover:bg-amber-400/20"
                            >
                                Don&apos;t save
                            </button>
                            <button
                                type="button"
                                onClick={handleSaveAndClose}
                                data-bp-ui-action="primary"
                                disabled={isSavingProject}
                                className="rounded-xl border border-sky-300/25 bg-sky-400/10 px-3 py-2 text-sm font-medium text-sky-100 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isSavingProject ? 'Saving project…' : 'Save and close'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default App;
