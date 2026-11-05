/**
 * menu-contributions.ts —— `ui_menus` 插槽契约：右键菜单项内容插件化。
 * 本体只保留弹出/定位/关闭机制（ContextMenu 通用宿主）；
 * 菜单项（label/可见性/动作）全部经此贡献，第三方插件可追加自己的项
 * （如 ComfyUI 插件加「重绘」右键项）。
 */
import type { Element } from '../types';
import type { Contribution, Kernel } from './kernel';
import type { SettingsSectionLanguage } from './settings-contributions';

/** 右键菜单触发时的上下文（宿主组装，插件只读）。 */
export interface ContextMenuContext {
  /** 右键命中的元素；空白画布为 null。 */
  element: Element | null;
  selectedElements: Element[];
  isMultiSelection: boolean;
  /** 宿主机制动作（调 App 既有 handler），菜单项复用而不重写。 */
  actions: {
    layerAction: (id: string, action: 'front' | 'back' | 'forward' | 'backward') => void;
    group: () => void;
    ungroup: () => void;
    mergeGroup: () => void;
    copyElement: (element: Element) => void;
    copySelection: () => void;
    deleteElement: (id: string) => void;
    deleteSelection: () => void;
    rasterizeSelection: () => void;
  };
  /** 动作执行后关闭菜单（宿主在 run 后自动调用，项内无需关心）。 */
}

export interface ContextMenuItem {
  /** 展示文案。 */
  label: (language: SettingsSectionLanguage) => string;
  /** 危险动作（红色调，如删除）。 */
  danger?: boolean;
  /** 同组分隔：切换到不同 group 时宿主插入分隔线。约定按语义命名（layer/group/clipboard/destructive/...）。 */
  group: string;
  /** 可见性谓词；不满足时该项整个不渲染。 */
  visible: (ctx: ContextMenuContext) => boolean;
  /** 动作；执行后宿主自动关闭菜单。 */
  run: (ctx: ContextMenuContext) => void;
}

export interface ContextMenuItemContribution {
  id: string;
  pluginId: string;
  /** 同组内排序，DESC。 */
  priority: number;
  value: ContextMenuItem;
}

export type ContextMenuItemRegistryEntry = Contribution<ContextMenuItem>;

export const listContextMenuContributions = (kernel: Kernel): readonly ContextMenuItemRegistryEntry[] =>
  kernel.contributions.list<ContextMenuItem>('ui_menus');
