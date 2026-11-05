import React, { useEffect } from 'react';
import { useLanguage } from '../utils/language-store';
import { preferencesSafeMode } from '../plugin-runtime/preferences-store';

/** 标题后缀。主进程侧 `main/safeMode.cjs` 有一个同名的 `SAFE_MODE_TITLE_SUFFIX`。 */
const TITLE_SUFFIX = '安全模式';

/**
 * SafeModeBanner —— 安全模式（`ARTFLOW_SAFE_MODE=1`）的常驻提示条。
 *
 * 为什么必须有这一条：安全模式**故意**不读用户配置，界面看起来就是"我的皮肤没了、
 * 插件开关全回来了、语言变回中文"—— 与"用户数据丢了"的症状一模一样。
 * 没有显式提示，用户会以为程序坏了或者配置被清空了，然后去做一堆没必要的抢救。
 * 所以这条横幅不给关闭按钮：只要在安全模式，它就必须一直在。
 *
 * 标题后缀也在这里改 `document.title`：Electron 默认让页面的 `<title>` 决定窗口标题，
 * 所以这一处设置同时体现在任务栏与 Alt-Tab 上。主进程另有一道 `page-title-updated` 兜底
 * （见 main.cjs）—— 它保证 React 万一没挂起来（安全模式最常见的用途就是排查启动失败）
 * 标题仍然是醒目的。
 *
 * 位置与层级：固定贴窗口顶部下方居中（`top-9` 是给 32px 高的自绘窗口控制条让位），
 * `z-60` 高于 chrome(35)，但不覆盖右侧的最小化/最大化/关闭按钮。
 * 数据属性 `data-bp-safe-mode-banner` 供端到端探针断言"真的画出来了"。
 */
export const SafeModeBanner: React.FC = () => {
  const zh = useLanguage() === 'zho';
  const safe = preferencesSafeMode();

  useEffect(() => {
    if (!safe) return;
    const previous = document.title;
    document.title = `${previous} — ${TITLE_SUFFIX}`;
    return () => { document.title = previous; };
  }, [safe]);

  if (!safe) return null;

  return (
    <div
      data-bp-safe-mode-banner=""
      data-bp-ui-surface=""
      className="pointer-events-none fixed left-1/2 top-9 z-[60] -translate-x-1/2"
      role="status"
    >
      <div className="flex items-center gap-2 rounded-[var(--bp-ui-radius)] border border-amber-400/70 bg-[var(--bp-ui-surface-strong)] px-3 py-1.5 text-[12px] leading-none text-[var(--bp-ui-text)] shadow-lg">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          className="text-amber-400">
          <path d="M12 3.6 2.4 20.4h19.2L12 3.6Z" />
          <path d="M12 10v4.4M12 17.4h.01" />
        </svg>
        <span className="font-semibold text-amber-400">{zh ? '安全模式' : 'Safe mode'}</span>
        <span className="opacity-80">
          {zh ? '已忽略用户配置，本次改动不会保存' : 'User settings ignored; changes will not be saved'}
        </span>
      </div>
    </div>
  );
};
