/**
 * workspace-layout.ts —— 工作区布局的持久化（面板开关 / 侧栏标签 / 设置页最后分组）。
 *
 * 卷位置：`userData/config/workspace.json`（主进程独占写，见 main/configStore.cjs）。
 *
 * **为什么与 preferences 分卷**：布局是"拖一下就写一次"的高频写，而 preferences.json
 * 里装的是语言、快捷键这类低频小值。单文件卷每次写入都要重写整篇 —— 把高频写与低频值
 * 混在一个文件里，等于让每次拖拽都顺带重写一遍全部偏好（写放大）。切分口径见方案 §5。
 *
 * 布局**不是**偏好：偏好决定"应用怎么工作"，布局决定"用户把窗口摆成什么样"。
 * 前者出问题要找很久，后者随时可以重摆 —— 所以布局不进设置预设之外的范围也不进密钥卷。
 */

import { createConfigVolume } from './config-volume';

export const workspaceVolume = createConfigVolume('workspace');

/**
 * 布局键名清单（集中一处，供 UI 与"存储管理"面板引用，避免键名散落成魔法字符串）。
 * 每个键都带 `panel.` / `settings.` 前缀 —— 将来有新的布局维度时同类归堆。
 */
export const WORKSPACE_KEYS = Object.freeze({
  /** 左侧栏：`{ isOpen, tab }` 整体存（开合与当前标签是同一次交互的两个面）。 */
  sidePanel: 'panel.side',
  projectPanel: 'panel.project',
  bookmarksPanel: 'panel.viewBookmarks',
  finderPanel: 'panel.canvasFinder',
  boardPanel: 'panel.board',
  /** 设置页最后停留的分组 —— 重启后回到同一页，不用每次重新找。 */
  settingsSection: 'settings.activeSection',
  /** 设置悬浮窗的位置与尺寸（可拖动、可调宽高）。x/y 为 null 表示"没被拖过 → 居中"。 */
  settingsWindow: 'settings.window',
});

export const SIDE_PANEL_TABS = ['layers', 'frames'] as const;
export type SidePanelTab = (typeof SIDE_PANEL_TABS)[number];

export interface SidePanelState {
  isOpen: boolean;
  tab: SidePanelTab;
}

/** 读回来的布局是用户可手改的 JSON，必须当不可信输入校验（半截对象会让面板渲染崩掉）。 */
export const isSidePanelState = (value: unknown): value is SidePanelState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SidePanelState>;
  return typeof candidate.isOpen === 'boolean'
    && (SIDE_PANEL_TABS as readonly string[]).includes(candidate.tab as string);
};

export const isSettingsSectionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 120;

/**
 * 设置悬浮窗的几何。`x` / `y` 为 `null` 表示"用户还没拖过窗口" → 每次打开按当前视口居中，
 * 而不是把首次打开时的居中坐标写死（写死之后换分辨率就会跑到屏幕边角）。
 */
export interface SettingsWindowRect {
  x: number | null;
  y: number | null;
  w: number;
  h: number;
}

/**
 * 设置窗口的最小尺寸：左导航（10.5rem）+ 内容区再挤下去就只剩一条缝了。
 * 只约束下限 —— 上限交给渲染时按视口收敛（`CanvasSettings` 的 clampGeometry），
 * 因为"能记多大"取决于用户屏幕，写死上限会让 4K 屏拉大的尺寸在保存时被静默丢弃。
 */
export const SETTINGS_WINDOW_LIMITS = Object.freeze({ minW: 460, minH: 320 });

/** 手改 JSON 的兜底上界（比任何物理屏幕都大，仅仅挡住明显的脏数据）。 */
const SANE_COORD = 1e5;

export const isSettingsWindowRect = (value: unknown): value is SettingsWindowRect => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SettingsWindowRect>;
  const isCoordinate = (n: unknown): boolean => n === null || (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= SANE_COORD);
  const isExtent = (n: unknown, min: number): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= SANE_COORD;
  return isCoordinate(candidate.x)
    && isCoordinate(candidate.y)
    && isExtent(candidate.w, SETTINGS_WINDOW_LIMITS.minW)
    && isExtent(candidate.h, SETTINGS_WINDOW_LIMITS.minH);
};
