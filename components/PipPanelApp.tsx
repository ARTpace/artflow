/**
 * PipPanelApp —— 独立面板窗口的最小宿主（主窗口面板「弹出」后加载的 UI）。
 *
 * 入口分流在 index.tsx：location.hash 以 #pip-panel=<panelId> 开头时不挂主工作台，
 * 只挂本组件。独立窗口是完整 renderer（同 bundle、同 localStorage 配置态、同一套
 * kernel bootstrap），插件面板、主题皮肤与语言设置自动生效，无需跨窗口同步。
 *
 * Windows 无边框窗口（frame:false）：header 即系统拖拽带（-webkit-app-region: drag），
 * 关闭按钮 no-drag 并 window.close()；主进程在 closed 时广播给主窗口还原面板。
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Kernel } from '../plugin-runtime/kernel';
import { listPanelContributions, resolvePanelText } from '../plugin-runtime/panel-contributions';
import { useLanguage } from '../utils/language-store';

const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

export const PipPanelApp: React.FC<{ kernel: Kernel }> = ({ kernel }) => {
  const language = useLanguage();
  const zho = language === 'zho';
  const copy = zho
    ? { close: '关闭', missing: '未找到该面板：它可能已随插件停用，请从主窗口重新打开。' }
    : { close: 'Close', missing: 'Panel not found: it may have been disabled with its plugin. Reopen it from the main window.' };

  const panelId = useMemo(() => {
    const match = /#pip-panel=([^&]+)/.exec(window.location.hash);
    return match ? decodeURIComponent(match[1]) : '';
  }, []);

  const panels = listPanelContributions(kernel);
  const active = panels.find(panel => panel.id === panelId) ?? null;
  const title = active ? resolvePanelText(active.value, language).title : (zho ? 'Artflow 面板' : 'Artflow Panel');
  const ActivePanel = active?.value.component ?? null;
  const [dismissed, setDismissed] = useState(false);

  // HTML <title>（"Infinite Canvas AI Editor"）会在窗口标题栏覆盖主进程默认标题，
  // 挂载后以面板标题为准。
  useEffect(() => {
    document.title = title;
  }, [title]);

  if (dismissed) return null;
  const closeWindow = (): void => {
    setDismissed(true);
    window.close();
  };

  return (
    <div data-bp-ui-surface="" className="fixed inset-0 flex flex-col overflow-hidden bg-[var(--ui-bg-color)] text-white"
      style={{ background: 'var(--bp-ui-surface-strong, #0a0a0a)' }}>
      <header
        style={dragRegionStyle}
        className="flex min-h-11 shrink-0 cursor-default select-none items-center gap-2 border-b border-white/10 px-3 py-2"
      >
        <span aria-hidden="true" className="mr-1 grid w-3 shrink-0 grid-cols-2 gap-[3px] opacity-40">
          {Array.from({ length: 6 }, (_, i) => <i key={i} className="h-[3px] w-[3px] rounded-full bg-current" />)}
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h2>
        <button type="button" onClick={closeWindow} aria-label={copy.close} title={copy.close}
          style={noDragRegionStyle}
          className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-slate-50">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {ActivePanel
          ? <ActivePanel kernel={kernel} onClose={closeWindow} />
          : <p className="rounded-xl border border-dashed border-white/15 px-3 py-6 text-center text-sm text-neutral-400">{copy.missing}</p>}
      </div>
    </div>
  );
};
