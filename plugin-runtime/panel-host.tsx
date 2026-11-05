import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Kernel } from './kernel';
import { listPanelContributions, resolvePanelText } from './panel-contributions';
import { PluginErrorBoundary, reportPluginFailure } from './plugin-error-boundary';
import { useLanguage } from '../utils/language-store';

interface PluginPanelHostProps {
  kernel: Kernel;
  isOpen: boolean;
  onClose: () => void;
  /** The entry chosen by an external shortcut. Changes while open are intentional. */
  initialPanelId?: string | null;
}

type Position = { x: number; y: number };
const initialPosition = (): Position => typeof window === 'undefined' ? { x: 320, y: 80 } : ({
  x: Math.max(16, Math.round((window.innerWidth - 480) / 2)),
  y: Math.min(84, Math.max(12, window.innerHeight - 180)),
});

/** Generic extension host. Only panels that opt into `floating` are non-modal. */
export const PluginPanelHost: React.FC<PluginPanelHostProps> = ({ kernel, isOpen, onClose, initialPanelId = null }) => {
  const language = useLanguage();
  const zho = language === 'zho';
  const copy = zho ? {
    fallbackTitle: '扩展工具', back: '返回扩展工具', intro: '打开工具面板，或管理已安装的插件和扩展包',
    close: '关闭扩展面板', closeFloating: '关闭并还原未应用的主题预览',
    collapse: '收起悬浮面板', expand: '展开悬浮面板', move: '拖动悬浮面板；方向键也可移动',
    empty: '当前档案没有启用任何扩展面板。', open: '打开',
    popOut: '弹出为独立窗口（可拖到主窗口外）',
  } : {
    fallbackTitle: 'Extension tools', back: 'Back to extension tools', intro: 'Open tool panels or manage installed plugins and packages',
    close: 'Close extensions', closeFloating: 'Close and discard any unapplied theme preview',
    collapse: 'Collapse floating panel', expand: 'Expand floating panel', move: 'Drag floating panel; arrow keys also move it',
    empty: 'No extension panels are enabled in this profile.', open: 'Open',
    popOut: 'Pop out to a separate window (draggable outside the main window)',
  };

  const panels = listPanelContributions(kernel);
  // undefined = follow the external entry, null = explicitly return to the directory.
  const [panelOverride, setPanelOverride] = useState<string | null | undefined>(undefined);
  const activePanelId = panelOverride === undefined ? initialPanelId : panelOverride;
  const activePanel = panels.find(panel => panel.id === activePanelId);
  /**
   * title/description 由插件贡献提供（`resolvePanelText` 会调用插件的函数值），宿主是在 render 期
   * 调它 —— 插件函数抛错只该降级这一条文案，不能连累面板目录/整个设置页（正文另有局部错误边界接管）。
   */
  const readPanelText = (panel: (typeof panels)[number]) => {
    try {
      return resolvePanelText(panel.value, language);
    } catch (error) {
      reportPluginFailure('ui_panels', panel.pluginId, 'text', error);
      return { title: panel.id, description: undefined as string | undefined };
    }
  };
  const activePanelTitle = activePanel ? readPanelText(activePanel).title : copy.fallbackTitle;
  const floating = activePanel?.value.presentation === 'floating';
  // 悬浮宽度档：契约只暴露 sm/md/lg，具体 Tailwind 类名保持在本宿主内。
  const floatingWidthClass = activePanel?.value.floatingWidth === 'lg'
    ? 'w-[min(46rem,calc(100vw-1.5rem))]'
    : activePanel?.value.floatingWidth === 'md'
      ? 'w-[min(38rem,calc(100vw-1.5rem))]'
      : 'w-[min(30rem,calc(100vw-1.5rem))]';
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<Position>(initialPosition);
  const positionRef = useRef(position);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; initial: Position } | null>(null);

  // —— 弹出为独立窗口（主进程 frameless BrowserWindow，IPC：artflow-app:open-panel-window）——
  // 弹出后主窗口侧进入「外派」状态：面板 chrome 暂不渲染；独立窗口关闭时主进程
  // panelWindowClosed 广播回来，面板自动还原原位。独立窗口里是完整 renderer
  // （同 bundle / 同本地配置态），PipPanelApp 精简宿主接管显示。
  const pipSupported = useRef(typeof window !== 'undefined' && !!window.artflowApp?.openPanelWindow).current;
  const [poppedOut, setPoppedOut] = useState(false);

  const popOutPanel = useCallback(async () => {
    if (!activePanel || poppedOut) return;
    const api = window.artflowApp;
    if (!api?.openPanelWindow) return;
    const width = panelRef.current?.offsetWidth ?? 480;
    const height = Math.max(320, Math.min(panelRef.current?.offsetHeight ?? 560, 720));
    setPoppedOut(true); // 乐观置位：独立窗口 ready-to-show 才可见；失败回滚保持原位
    try {
      const result = await api.openPanelWindow({ panelId: activePanel.id, width, height });
      if (!result?.ok) setPoppedOut(false);
    } catch {
      setPoppedOut(false);
    }
  }, [activePanel, poppedOut]);

  // 任一独立面板窗口关闭 → 主窗口侧外派状态复位，面板回到原位。
  useEffect(() => {
    const api = window.artflowApp;
    if (!api?.onPanelWindowClosed) return;
    return api.onPanelWindowClosed(() => setPoppedOut(false));
  }, []);

  const clamp = (next: Position): Position => ({
    x: Math.max(12, Math.min(next.x, Math.max(12, window.innerWidth - (panelRef.current?.offsetWidth ?? 480) - 12))),
    y: Math.max(12, Math.min(next.y, Math.max(12, window.innerHeight - (panelRef.current?.offsetHeight ?? 56) - 12))),
  });
  const movePanel = (next: Position, commit = true) => {
    const safe = clamp(next);
    positionRef.current = safe;
    if (panelRef.current) panelRef.current.style.transform = `translate3d(${safe.x}px, ${safe.y}px, 0)`;
    if (commit) setPosition(safe);
  };

  useEffect(() => {
    if (!isOpen) {
      setPanelOverride(undefined); setCollapsed(false);
      setPoppedOut(false);
      return;
    }
    if (activePanelId && !activePanel) setPanelOverride(null);
  }, [isOpen, activePanelId, activePanel]);
  useEffect(() => { setPanelOverride(undefined); }, [initialPanelId]);
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A non-modal floating inspector must not consume Escape while the user edits the canvas.
      if (floating && !panelRef.current?.contains(document.activeElement)) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, floating]);
  useLayoutEffect(() => {
    if (!isOpen || !floating) return;
    movePanel(positionRef.current);
  }, [isOpen, floating, collapsed]);
  useEffect(() => {
    if (!isOpen || !floating) return;
    const onResize = () => movePanel(positionRef.current);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isOpen, floating]);

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!floating || event.button !== 0 || (event.target as Element).closest('button')) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, initial: positionRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const updateDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    movePanel({ x: drag.initial.x + event.clientX - drag.x, y: drag.initial.y + event.clientY - drag.y }, false);
    event.stopPropagation();
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPosition(positionRef.current); // one React update per drag, never per pointermove
    event.stopPropagation();
  };
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!floating || !event.key.startsWith('Arrow')) return;
    const delta = event.shiftKey ? 48 : 16;
    const offsets: Record<string, Position> = {
      ArrowLeft: { x: -delta, y: 0 }, ArrowRight: { x: delta, y: 0 },
      ArrowUp: { x: 0, y: -delta }, ArrowDown: { x: 0, y: delta },
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault(); event.stopPropagation();
    movePanel({ x: positionRef.current.x + offset.x, y: positionRef.current.y + offset.y });
  };

  if (!isOpen) return null;
  if (poppedOut) return null; // 面板外派独立窗口中：主窗口侧暂不渲染，窗口关闭广播后还原。
  const ActivePanel = activePanel?.value.component;
  // 面板外壳（header + 内容）：由主窗口 scrim 容器或悬浮层原位渲染。
  const panelChrome = (
    <section
      ref={panelRef}
      role="dialog"
      data-bp-ui-panel=""
      data-bp-panel-layout={activePanel?.value.presentation ?? 'standard'}
      aria-modal={!floating}
      aria-label={activePanelTitle}
      style={floating ? { transform: `translate3d(${position.x}px, ${position.y}px, 0)`, backgroundColor: 'var(--bp-ui-surface-strong)', color: 'var(--bp-ui-text)', borderColor: 'var(--bp-ui-border)' } : undefined}
      className={floating
        ? `pointer-events-auto fixed left-0 top-0 flex ${floatingWidthClass} flex-col overflow-hidden rounded-[18px] border border-white/15 shadow-[0_18px_60px_rgba(0,0,0,0.40),0_2px_10px_rgba(0,0,0,0.20)] [will-change:transform] ${collapsed ? '' : 'max-h-[min(44rem,calc(100vh-7rem))]'}`
        : `flex max-h-[min(52rem,calc(100vh-2rem))] flex-col overflow-hidden rounded-2xl border border-white/15 bg-neutral-950/95 text-white shadow-2xl ${activePanel?.value.presentation === 'wide' ? 'w-[min(76rem,calc(100vw-2rem))]' : 'w-[min(34rem,calc(100vw-2rem))]'} `}
      onMouseDown={event => event.stopPropagation()}
    >
      <header
          data-bp-floating-handle={floating ? '' : undefined}
          tabIndex={floating ? 0 : undefined}
          aria-label={floating ? copy.move : undefined}
          onKeyDown={moveByKeyboard}
          onPointerDown={startDrag}
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={`flex shrink-0 items-center gap-2 border-b px-3 py-2.5 ${floating
            ? 'min-h-12 cursor-grab select-none touch-none border-white/10 active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white/60'
            : 'border-white/10 px-4 py-3'}`}
        >
          {floating && <span aria-hidden="true" className="mr-1 grid w-3 shrink-0 grid-cols-2 gap-[3px] opacity-40">{Array.from({ length: 6 }, (_, i) => <i key={i} className="h-[3px] w-[3px] rounded-full bg-current" />)}</span>}
          {activePanel && !collapsed && (
            <button type="button" onClick={() => setPanelOverride(null)}
              className={`rounded-lg px-2 py-1 text-xs hover:bg-white/10 ${floating ? 'text-slate-300 hover:text-slate-50' : 'text-neutral-300 hover:text-white'}`}>
              {copy.back}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-semibold">{activePanelTitle}</h2>
            {!activePanel && <p className="mt-0.5 text-xs text-neutral-400">{copy.intro}</p>}
          </div>
          {pipSupported && activePanel && (
            <button type="button" onClick={popOutPanel}
              aria-label={copy.popOut} title={copy.popOut}
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-slate-50">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6.5 3.5H4a1 1 0 0 0-1 1V12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5M9.5 3H13v3.5M13 3 8.5 7.5" />
              </svg>
            </button>
          )}
          {floating && <button type="button" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? copy.expand : copy.collapse}
            aria-expanded={!collapsed} title={collapsed ? copy.expand : copy.collapse}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-slate-50">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d={collapsed ? 'M3 6l5 5 5-5' : 'M3 10l5-5 5 5'} /></svg>
          </button>}
          <button type="button" onClick={onClose} aria-label={floating ? copy.closeFloating : copy.close} title={floating ? copy.closeFloating : copy.close}
            className={`grid h-7 w-7 place-items-center rounded-lg hover:bg-white/10 ${floating ? 'text-slate-300 hover:text-slate-50' : 'text-neutral-300 hover:text-white'}`}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        </header>
        {/* Keep the panel mounted while collapsed so its draft continues previewing the actual tools. */}
        <div className={collapsed ? 'hidden' : floating ? 'flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2.5' : 'min-h-0 overflow-y-auto p-3'}>
          {ActivePanel ? (
            /* 局部错误边界：某个插件面板渲染抛错时只把该面板正文换成失败占位（含 pluginId），
               scrim/header 与其他界面照常；key 随面板变化 ⇒ 换面板自动清掉失败态。 */
            <PluginErrorBoundary
              key={activePanel?.id ?? 'ui_panel'}
              slot="ui_panels"
              pluginId={activePanel?.pluginId}
              label={activePanel?.id}
              language={language}
            >
              <ActivePanel kernel={kernel} onClose={onClose} chromeless={floating} />
            </PluginErrorBoundary>
          ) : (
            <div className="space-y-2">
              {panels.length === 0 ? (
                <p className="rounded-xl border border-dashed border-white/15 px-3 py-6 text-center text-sm text-neutral-400">{copy.empty}</p>
              ) : <ul className="space-y-2">
              {panels.map(panel => (
                <li key={panel.id}>
                  <button type="button" onClick={() => setPanelOverride(panel.id)} data-bp-ui-panel-entry=""
                    className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] px-3 py-3 text-left hover:border-sky-300/30 hover:bg-sky-400/[0.08]">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-sky-100">
                      <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1" /><rect x="11" y="3.5" width="5.5" height="5.5" rx="1" />
                        <rect x="3.5" y="11" width="5.5" height="5.5" rx="1" /><rect x="11" y="11" width="5.5" height="5.5" rx="1" />
                      </svg>
                    </span>
                    <span className="min-w-0 flex-1">
                      {(() => { const text = readPanelText(panel); return <>
                        <span className="block truncate text-sm font-medium">{text.title}</span>
                        {text.description && <span className="mt-0.5 block text-xs text-neutral-400">{text.description}</span>}
                      </>; })()}
                    </span>
                    <span className="text-xs text-sky-200">{copy.open}</span>
                  </button>
                </li>
              ))}
            </ul>}
            </div>
          )}
        </div>
    </section>
  );

  // 弹出态已在上方 return null；此处为主窗口原位渲染。
  return (
    <div role="presentation" data-bp-ui-scrim={floating ? undefined : ''} className={floating
      ? 'pointer-events-none fixed inset-0 z-50'
      : 'fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm'}
      onMouseDown={floating ? undefined : onClose}
    >
      {panelChrome}
    </div>
  );
};
