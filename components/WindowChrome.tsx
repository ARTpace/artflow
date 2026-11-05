import React, { useEffect, useState } from 'react';
import type { HostPlatformService, WindowChromeAction } from '../plugin-runtime/host-platform';
import { useLanguage } from '../utils/language-store';

/** Windows-only controls for our frameless BrowserWindow. No direct IPC or Node in the renderer. */
export const WindowChrome: React.FC<{ platform: HostPlatformService }> = React.memo(({ platform }) => {
  const [maximized, setMaximized] = useState(false);
  const zh = useLanguage() === 'zho';

  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    const unsubscribe = platform.subscribeWindowState(state => {
      receivedEvent = true;
      if (mounted) setMaximized(state.maximized);
    });
    void platform.getWindowState().then(state => {
      if (mounted && !receivedEvent && state.ok) setMaximized(state.maximized === true);
    }, () => {});
    return () => { mounted = false; unsubscribe(); };
  }, [platform]);

  const control = (action: WindowChromeAction) => {
    // close() may destroy the sender before its IPC reply arrives; that is a normal exit.
    void platform.windowControl(action).then(result => {
      if (action === 'toggle-maximize' && result.ok) setMaximized(result.maximized === true);
    }, () => {});
  };

  return (
    <div className="bp-window-chrome" data-bp-window-chrome="" role="group" tabIndex={0}
      aria-label={zh ? '窗口控制：移到顶部边缘显示' : 'Window controls: move to the top edge to reveal'}>
      <div className="bp-window-chrome__drag" data-bp-window-drag=""
        title={zh ? '拖动以移动窗口；双击可最大化或还原' : 'Drag to move the window; double-click to maximize or restore'} />
      <div className="bp-window-chrome__controls" data-bp-ui-surface="">
        <button type="button" data-bp-window-control="minimize"
          onClick={() => control('minimize')} title={zh ? '最小化' : 'Minimize'} aria-label={zh ? '最小化窗口' : 'Minimize window'}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 17h14" /></svg>
        </button>
        <button type="button" data-bp-window-control="toggle-maximize"
          onClick={() => control('toggle-maximize')}
          title={maximized ? (zh ? '还原' : 'Restore') : (zh ? '最大化' : 'Maximize')}
          aria-label={maximized ? (zh ? '还原窗口' : 'Restore window') : (zh ? '最大化窗口' : 'Maximize window')}>
          {maximized
            ? <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M8 8V5h11v11h-3M5 8h11v11H5z" /></svg>
            : <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><rect x="5" y="5" width="14" height="14" rx="1" /></svg>}
        </button>
        <button type="button" data-bp-window-control="close"
          onClick={() => control('close')} title={zh ? '关闭' : 'Close'} aria-label={zh ? '关闭窗口' : 'Close window'}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
    </div>
  );
});
