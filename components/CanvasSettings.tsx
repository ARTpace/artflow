import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import type { Kernel } from '../plugin-runtime/kernel';
import { listSettingsSectionContributions } from '../plugin-runtime/settings-contributions';
import { PluginErrorBoundary, reportPluginFailure } from '../plugin-runtime/plugin-error-boundary';
import { SETTINGS_UI_BRIDGE_SERVICE, createSettingsUiBridge, type SettingsUiBridge } from '../plugin-runtime/settings-bridge';
import { useWorkspaceState } from '../hooks/useWorkspaceLayout';
import {
    WORKSPACE_KEYS,
    isSettingsSectionId,
    isSettingsWindowRect,
    SETTINGS_WINDOW_LIMITS,
    type SettingsWindowRect,
} from '../plugin-runtime/workspace-layout';

interface CanvasSettingsProps {
    kernel: Kernel;
    isOpen: boolean;
    onClose: () => void;
    /** Optional generic deep link from another UI surface (for example, the panel directory). */
    requestedSectionId?: string | null;
    canvasBackgroundColor: string;
    onCanvasBackgroundColorChange: (color: string) => void;
    onCanvasBackgroundImageChange: (file: File) => void;
    language: 'en' | 'zho';
    setLanguage: (lang: 'en' | 'zho') => void;
    onOpenAppearance?: () => void;
    wheelAction: WheelAction;
    setWheelAction: (action: WheelAction) => void;
    generateHotkey: Hotkey;
    setGenerateHotkey: (hotkey: Hotkey) => void;
    presentationHotkeys: PresentationHotkeys;
    setPresentationHotkeys: (hotkeys: PresentationHotkeys) => void;
    apiKey: string;
    setApiKey: (key: string) => void;
    t: (key: string) => string;
}

type WheelAction = import('../types').WheelAction;
type Hotkey = import('../types').Hotkey;
type PresentationHotkeys = import('../types').PresentationHotkeys;

// settings.ui-bridge 同 workspace.ui-bridge：载体必须是**模块级单例**。插件 section 组件在
// 首帧就会读它，而 HMR 重挂载会重建组件内的 ref —— 旧对象一旦被插件持有就永久失效。
const settingsUiBridge = createSettingsUiBridge();

/** 悬浮窗离视口边缘的留白：拖到边上时窗口不会和窗口边框贴死（也留出拖动余量）。 */
const WINDOW_MARGIN = 12;
/** 首次打开（或双击标题栏复位）的尺寸 —— 明显小于"铺满屏幕"，才有浮在画布上的感觉。 */
const DEFAULT_WINDOW = { w: 1040, h: 700 } as const;

interface WindowGeometry {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** 缩放方向：`xy` 是右下角对角手柄，`x`/`y` 是右边缘、下边缘。 */
type ResizeAxis = 'x' | 'y' | 'xy';

interface PointerSession {
    kind: 'move' | 'resize';
    axis: ResizeAxis;
    pointerId: number;
    startX: number;
    startY: number;
    base: WindowGeometry;
}

/**
 * 把窗口收敛进视口：尺寸先夹到 [最小尺寸, 视口可容纳尺寸]，再把左上角夹到"窗口完整可见"的范围内。
 * 拖动、缩放、视口变化三条路径都过这一个函数 —— 于是"窗口跑到屏幕外找不回来"不可能发生。
 */
const clampGeometry = (geometry: WindowGeometry): WindowGeometry => {
    const { minW, minH } = SETTINGS_WINDOW_LIMITS;
    const maxW = Math.max(minW, window.innerWidth - WINDOW_MARGIN * 2);
    const maxH = Math.max(minH, window.innerHeight - WINDOW_MARGIN * 2);
    const width = Math.min(Math.max(geometry.width, minW), maxW);
    const height = Math.min(Math.max(geometry.height, minH), maxH);
    const left = Math.min(Math.max(geometry.left, WINDOW_MARGIN), Math.max(WINDOW_MARGIN, window.innerWidth - width - WINDOW_MARGIN));
    const top = Math.min(Math.max(geometry.top, WINDOW_MARGIN), Math.max(WINDOW_MARGIN, window.innerHeight - height - WINDOW_MARGIN));
    return { left, top, width, height };
};

/** 卷里存的 rect → 实际几何（`x`/`y` 为 null 时居中）。 */
const resolveGeometry = (rect: SettingsWindowRect): WindowGeometry => clampGeometry({
    left: rect.x ?? (window.innerWidth - rect.w) / 2,
    top: rect.y ?? (window.innerHeight - rect.h) / 2,
    width: rect.w,
    height: rect.h,
});

/**
 * 设置面板通用宿主（Blender 布局）：左侧分组导航 + 右侧 settings_sections 贡献内容。
 * 核心 tab（通用/外观/画布/快捷键）由 builtin.core-settings 提供，本组件只负责
 * 壳、桥（settings.ui-bridge）与导航分组——零业务内容。
 */
export const CanvasSettings: React.FC<CanvasSettingsProps> = ({
    kernel,
    isOpen,
    onClose,
    requestedSectionId,
    canvasBackgroundColor,
    onCanvasBackgroundColorChange,
    onCanvasBackgroundImageChange,
    language,
    setLanguage,
    onOpenAppearance,
    wheelAction,
    setWheelAction,
    generateHotkey,
    setGenerateHotkey,
    presentationHotkeys,
    setPresentationHotkeys,
    apiKey,
    setApiKey,
    t
}) => {
    // 最后停留的分组写进 workspace 卷：重启后回到同一页，不用每次重新找。
    // 读回来的是用户可手改的 JSON，过 `isSettingsSectionId` 校验；失效分组由下面的
    // "回落到第一个 core 项" 兜住 —— 两条一起才不会出现"打开了设置却是空白页"。
    const [activeTab, setActiveTab] = useWorkspaceState<string>(
        WORKSPACE_KEYS.settingsSection,
        'builtin.core-settings.general',
        isSettingsSectionId,
    );
    const settingsSections = listSettingsSectionContributions(kernel);
    const activeSettingsSection = settingsSections.find(section => section.id === activeTab);
    const ActiveSettingsSection = activeSettingsSection?.value.component;

    // —— settings.ui-bridge：插件 section 组件的状态桥（原地更新 + 首帧同步 provide，时序教训同 workspace.ui-bridge）——
    const bridgeRef = useRef<SettingsUiBridge>(settingsUiBridge);
    bridgeRef.current.general = { apiKey, setApiKey, language, setLanguage };
    bridgeRef.current.appearance = { available: !!onOpenAppearance, openThemeStudio: onOpenAppearance ?? (() => {}) };
    bridgeRef.current.hotkeys = { wheelAction, setWheelAction, generateHotkey, setGenerateHotkey, presentationHotkeys, setPresentationHotkeys };
    bridgeRef.current.canvas = { canvasBackgroundColor, onCanvasBackgroundColorChange, onCanvasBackgroundImageChange };
    // 守卫锚定「内核里的现有登记」而非组件局部 ref —— HMR 重挂载会重置 ref，而内核单例跨挂载
    // 存活，二次 provide 会抛 "service already provided" 并让整树白屏。replace 幂等覆盖。
    const bridgeKernelRef = useRef<Kernel | null>(null);
    if (bridgeKernelRef.current !== kernel) {
        kernel.replace(SETTINGS_UI_BRIDGE_SERVICE, bridgeRef.current);
        bridgeKernelRef.current = kernel;
    }

    // Only follow explicit deep links when opening; ordinary Settings retains its last tab.
    const requestedAvailable = !!requestedSectionId && settingsSections.some(section => section.id === requestedSectionId);
    useEffect(() => {
        if (isOpen && requestedSectionId && requestedAvailable) setActiveTab(requestedSectionId);
    }, [isOpen, requestedSectionId, requestedAvailable]);

    // activeTab 失效时回落到第一个 core 项。
    useEffect(() => {
        if (!activeSettingsSection) {
            const firstCore = settingsSections.find(section => section.value.navGroup === 'core');
            if (firstCore) setActiveTab(firstCore.id);
        }
    }, [activeSettingsSection, settingsSections]);

    // —— 悬浮窗几何（可拖动 + 可调宽高）——
    // 尺寸/位置写进 workspace 卷（布局是"拖一下就写一次"的高频写，与 preferences 分卷的原因见 workspace-layout.ts）。
    const [windowRect, setWindowRect] = useWorkspaceState<SettingsWindowRect>(
        WORKSPACE_KEYS.settingsWindow,
        { x: null, y: null, w: DEFAULT_WINDOW.w, h: DEFAULT_WINDOW.h },
        isSettingsWindowRect,
    );
    const windowRectRef = useRef(windowRect);
    windowRectRef.current = windowRect;
    const [geometry, setGeometry] = useState<WindowGeometry>(() => resolveGeometry(windowRect));
    const geometryRef = useRef(geometry);
    const windowRef = useRef<HTMLDivElement | null>(null);
    const pointerRef = useRef<PointerSession | null>(null);

    /** Dragging writes straight to the DOM (transform/width/height) —— one React update per gesture, not per pointermove. */
    const applyGeometry = (next: WindowGeometry) => {
        geometryRef.current = next;
        const element = windowRef.current;
        if (!element) return;
        element.style.width = `${next.width}px`;
        element.style.height = `${next.height}px`;
        element.style.transform = `translate3d(${next.left}px, ${next.top}px, 0)`;
    };

    const commitGeometry = (next: WindowGeometry) => {
        applyGeometry(next);
        setGeometry(next);
        setWindowRect({ x: next.left, y: next.top, w: next.width, h: next.height });
    };

    // 打开时按"当前视口"重算一次（上次存的尺寸可能已经大于现在的窗口），并跟随视口变化持续收敛。
    useLayoutEffect(() => {
        if (!isOpen) return;
        const next = resolveGeometry(windowRectRef.current);
        applyGeometry(next);
        setGeometry(next);
        const onViewportResize = () => applyGeometry(clampGeometry(geometryRef.current));
        window.addEventListener('resize', onViewportResize);
        return () => window.removeEventListener('resize', onViewportResize);
    }, [isOpen]);

    const beginPointer = (kind: 'move' | 'resize', axis: ResizeAxis) => (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        // 标题栏上的关闭按钮照常可点：只有非按钮区域才当作拖动把手。
        if (kind === 'move' && (event.target as Element).closest('button')) return;
        pointerRef.current = {
            kind,
            axis,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            base: geometryRef.current,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
    };

    const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
        const session = pointerRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        const dx = event.clientX - session.startX;
        const dy = event.clientY - session.startY;
        const next = session.kind === 'move'
            ? { ...session.base, left: session.base.left + dx, top: session.base.top + dy }
            : {
                ...session.base,
                width: session.axis.includes('x') ? session.base.width + dx : session.base.width,
                height: session.axis.includes('y') ? session.base.height + dy : session.base.height,
            };
        applyGeometry(clampGeometry(next));
        event.stopPropagation();
    };

    const endPointer = (event: React.PointerEvent<HTMLElement>) => {
        const session = pointerRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        pointerRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        commitGeometry(geometryRef.current); // 松手才写卷：拖动过程不落盘
        event.stopPropagation();
    };

    const pointerHandlers = {
        onPointerMove,
        onPointerUp: endPointer,
        onPointerCancel: endPointer,
    };

    const resetWindow = () => commitGeometry(resolveGeometry({ x: null, y: null, w: DEFAULT_WINDOW.w, h: DEFAULT_WINDOW.h }));

    if (!isOpen) return null;

    // 贡献里的 label 是插件函数，宿主在 render 期调用它 —— 抛错只该降级这一条导航文案
    // （回落贡献 id），不能让整个设置页导航白屏；正文渲染另有局部错误边界接管。
    const readSectionLabel = (section: (typeof settingsSections)[number]): string => {
        try {
            return section.value.label(language);
        } catch (error) {
            reportPluginFailure('settings_sections', section.pluginId, 'label', error);
            return section.id;
        }
    };
    const coreNav = settingsSections
        .filter(section => section.value.navGroup === 'core')
        .map(section => ({ key: section.id, label: readSectionLabel(section) }));
    const pluginNav = settingsSections
        .filter(section => section.value.navGroup !== 'core')
        .map(section => ({ key: section.id, label: readSectionLabel(section) }));
    const renderNavButton = ({ key, label }: { key: string; label: string }) => (
        <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            data-bp-ui-active={activeTab === key}
            className={`w-full truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${activeTab === key ? 'bg-[var(--bp-ui-selected-bg)] font-medium text-[var(--bp-ui-text)] ring-1 ring-[var(--bp-ui-selected-border)]' : 'text-neutral-300 hover:bg-white/[0.06]'}`}
        >
            {label}
        </button>
    );

    return (
        <div
            data-bp-ui-scrim="" className="fixed inset-0 z-50 bg-black/25"
            onClick={onClose}
        >
            <div
                ref={windowRef}
                data-bp-ui-settings=""
                data-bp-ui-surface=""
                role="dialog"
                aria-label={t('settings.title')}
                className="pointer-events-auto fixed left-0 top-0 z-50 flex flex-col overflow-hidden rounded-2xl border border-white/10 p-4 text-white shadow-2xl backdrop-blur-xl [will-change:transform]"
                style={{
                    width: geometry.width,
                    height: geometry.height,
                    transform: `translate3d(${geometry.left}px, ${geometry.top}px, 0)`,
                    backgroundColor: 'var(--bp-ui-surface-strong)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* 标题栏同时是拖动把手（双击复位）。手柄只在非按钮区域生效，关闭按钮照常可点。 */}
                <div
                    {...pointerHandlers}
                    onPointerDown={beginPointer('move', 'xy')}
                    onDoubleClick={resetWindow}
                    title={language === 'zho' ? '拖动可移动窗口，双击复位' : 'Drag to move, double-click to reset'}
                    className="flex cursor-move select-none items-center justify-between pb-2"
                >
                    <h3 className="text-lg font-semibold">{t('settings.title')}</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-full">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>

                {/* Blender 布局：左侧分组导航 + 右侧内容区 */}
                <div className="grid min-h-0 flex-1 grid-cols-[10.5rem_1fr] gap-3 overflow-hidden">
                    <nav data-bp-ui-settings-nav="" aria-label={t('settings.title')} className="space-y-3 overflow-y-auto pr-0.5">
                        <div className="space-y-0.5 rounded-xl border border-white/[0.07] bg-black/20 p-1">
                            {coreNav.map(renderNavButton)}
                        </div>
                        {pluginNav.length > 0 && (
                            <div className="space-y-0.5 rounded-xl border border-white/[0.07] bg-black/20 p-1">
                                {pluginNav.map(renderNavButton)}
                            </div>
                        )}
                    </nav>

                    <div className="min-h-0 space-y-2.5 overflow-y-auto pr-1 pl-0.5">
                        {ActiveSettingsSection && (
                            /* 局部错误边界：某个插件的设置段渲染抛错只降级为该段占位（含 pluginId），
                               设置窗、分组导航与其他段照常；key 随段切换 ⇒ 换段自动清掉失败态。 */
                            <PluginErrorBoundary
                                key={activeSettingsSection?.id ?? 'settings_section'}
                                slot="settings_sections"
                                pluginId={activeSettingsSection?.pluginId}
                                label={activeSettingsSection?.id}
                                language={language}
                                fill
                                minHeight={120}
                            >
                                <ActiveSettingsSection kernel={kernel} language={language} />
                            </PluginErrorBoundary>
                        )}
                    </div>
                </div>

                {/* 尺寸手柄：右边缘（只调宽）、下边缘（只调高）、右下角（同时调宽高）。 */}
                <div
                    {...pointerHandlers}
                    onPointerDown={beginPointer('resize', 'x')}
                    aria-hidden="true"
                    className="absolute bottom-6 right-0 top-6 w-1.5 cursor-ew-resize rounded-full hover:bg-white/20"
                />
                <div
                    {...pointerHandlers}
                    onPointerDown={beginPointer('resize', 'y')}
                    aria-hidden="true"
                    className="absolute bottom-0 left-6 right-6 h-1.5 cursor-ns-resize rounded-full hover:bg-white/20"
                />
                <div
                    {...pointerHandlers}
                    onPointerDown={beginPointer('resize', 'xy')}
                    role="separator"
                    aria-label={language === 'zho' ? '拖动调整设置窗口大小' : 'Resize settings window'}
                    className="group absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize rounded-br-2xl"
                >
                    <svg
                        width="10" height="10" viewBox="0 0 10 10"
                        className="absolute bottom-1 right-1 text-white/35 group-hover:text-white/80"
                        fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
                    >
                        <line x1="9" y1="1" x2="1" y2="9" />
                        <line x1="9" y1="5" x2="5" y2="9" />
                    </svg>
                </div>
            </div>
        </div>
    );
};
