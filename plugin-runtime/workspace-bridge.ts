/**
 * workspace-bridge.ts —— 工作台 UI 状态桥（本体 ↔ canvas_widgets 插件组件的唯一通道）。
 *
 * App 每次渲染把面板所需的 state + 回调写入 bridge.current（ref 突变，不触发订阅），
 * 插件组件经 kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) 读取。面板语义零改动（R18-R22 保护条款），
 * 仅宿主挂接方式从 App 硬编码改为注册表贡献（原则 #7 债务迁移）。
 */

import type { ComponentProps } from 'react';
import type { ImportJobsPanel } from '../components/ImportJobsPanel';
import type { ProjectWorkspacePanel, WorkspaceStatusDock } from '../components/ProjectWorkspacePanel';
import type { CanvasNavigator } from '../components/CanvasNavigator';
import type { ViewBookmarksPanel } from '../components/ViewBookmarksPanel';
import type { CanvasFinderPanel } from '../components/CanvasFinderPanel';
import type { TopBar } from '../components/TopBar';
import type { BoardPanel } from '../components/BoardPanel';
import type { Toolbar } from '../components/Toolbar';
import type { LayerPanel } from '../components/LayerPanel';
import type { PsdImportModal } from '../components/PsdImportModal';
import type { ToolbarOverlay } from '../components/ToolbarOverlay';
import type { SmartToolbar } from '../components/SmartToolbar';
import type { GenerationMode, Hotkey, ImageAspectRatio, UserEffect } from '../types';
import type { ElementTagsPanel } from '../components/ElementTagsPanel';
import type { PresentationUI } from '../components/PresentationUI';

export const WORKSPACE_UI_BRIDGE_SERVICE = 'workspace.ui-bridge';

/**
 * 底部提示词栏的 props。
 * 组件本体已迁入 `builtin.ai-providers`，运行时共享层**不再 import 具体组件**，改用这份独立接口
 * —— 否则 plugin-runtime 会反向依赖某个插件（层次倒置）。字段与原 PromptBarProps 一一对齐。
 */
export interface PromptBarBridgeProps {
  t: (key: string, ...args: any[]) => string;
  prompt: string;
  setPrompt: (prompt: string) => void;
  onGenerate: () => void;
  isLoading: boolean;
  isSelectionActive: boolean;
  selectedElementCount: number;
  userEffects: UserEffect[];
  onAddUserEffect: (effect: UserEffect) => void;
  onDeleteUserEffect: (id: string) => void;
  generationMode: GenerationMode;
  setGenerationMode: (mode: GenerationMode) => void;
  videoAspectRatio: '16:9' | '9:16';
  setVideoAspectRatio: (ratio: '16:9' | '9:16') => void;
  imageAspectRatio: ImageAspectRatio;
  setImageAspectRatio: (ratio: ImageAspectRatio) => void;
  numberOfImages: number;
  setNumberOfImages: (num: number) => void;
  numberOfVideos: number;
  setNumberOfVideos: (num: number) => void;
  generateHotkey: Hotkey;
}

export interface WorkspaceUiBridge {
  /** 常驻 Dock（storageMode/保存状态/入口）。 */
  dock: ComponentProps<typeof WorkspaceStatusDock>;
  /** 项目工作台面板（弹层）。 */
  projectPanel: ComponentProps<typeof ProjectWorkspacePanel>;
  /** 当前板查找浮层。 */
  finder: ComponentProps<typeof CanvasFinderPanel>;
  /** 视图书签浮层。 */
  bookmarks: ComponentProps<typeof ViewBookmarksPanel>;
  /** 画布导航器（常驻）。 */
  navigator: ComponentProps<typeof CanvasNavigator>;
  /** 导入任务面板 + 可用性门（isManagedImportJobsAvailable）。 */
  importJobs: ComponentProps<typeof ImportJobsPanel> & { isAvailable: boolean };
  /** 顶栏（原本体 UI 外壳，R38 后迁 builtin.ui-shell）。 */
  topbar: ComponentProps<typeof TopBar>;
  /** 板列表面板（弹层）。 */
  board: ComponentProps<typeof BoardPanel>;
  /** 左侧工具条。 */
  toolbar: ComponentProps<typeof Toolbar>;
  /** 图层/帧侧面板。 */
  layer: ComponentProps<typeof LayerPanel>;
  /** PSD 导入向导（弹层；解析在 formats-image-doc 的 handler，合并/图层导入走本体元素管线）。 */
  psdModal: ComponentProps<typeof PsdImportModal>;
  /** 画布选区/元素工具条。MainCanvas 在绘制前写入。 */
  selectionOverlay?: ComponentProps<typeof ToolbarOverlay>;
  /** 智能工具条。App 每次 render 写入。 */
  smartToolbar: ComponentProps<typeof SmartToolbar>;
  /** 选中卡片的标签面板。 */
  tags: ComponentProps<typeof ElementTagsPanel>;
  /** 底部提示词栏（快捷提示在组件内部）。 */
  promptBar: PromptBarBridgeProps;
  /** 放映界面。active 为 false 时插件不挂出界面。 */
  presentation: { active: boolean } & ComponentProps<typeof PresentationUI>;
}

export interface WorkspaceUiBridgeService {
  /** App 每次 render 原地更新；插件组件仅在自身 render 中读取。 */
  readonly current: WorkspaceUiBridge;
}

export const createWorkspaceUiBridge = (initial: WorkspaceUiBridge): WorkspaceUiBridgeService => ({
  current: initial,
});
