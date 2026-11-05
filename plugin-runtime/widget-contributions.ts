/**
 * widget-contributions.ts —— `canvas_widgets` 插槽契约：画布常驻/浮层组件经注册表挂接。
 * 宿主（components/WorkspaceWidgetHost.tsx）零业务；组件与业务归 builtin 插件（原则 #7）。
 */

import type { ComponentType } from 'react';
import type { Contribution, Kernel } from './kernel';
import type { LocalizedText } from './i18n';

export interface WorkspaceWidgetProps {
  kernel: Kernel;
}

/** 挂载位：workspace=工作台区（默认），其余对应 App 布局中的不同宿主点位。 */
export type WorkspaceWidgetPlacement = 'workspace' | 'topbar' | 'board' | 'toolbar' | 'layer' | 'tags' | 'prompt' | 'presentation';

export interface WorkspaceWidgetContribution {
  /** 展示名（诊断用）。字符串或按语言的解析函数。 */
  title: LocalizedText;
  /** 读取 WorkspaceUiBridge 的哪个分片；'diagnostics' 为自取数浮层（不读 bridge，如性能 HUD）。 */
  bridgeKey: 'dock' | 'projectPanel' | 'finder' | 'bookmarks' | 'navigator' | 'importJobs' | 'topbar' | 'board' | 'toolbar' | 'layer' | 'psdModal' | 'diagnostics' | 'tags' | 'promptBar' | 'presentation';
  /** 挂载位；缺省 workspace。 */
  placement?: WorkspaceWidgetPlacement;
  component: ComponentType<WorkspaceWidgetProps>;
}

export type WorkspaceWidgetRegistryEntry = Contribution<WorkspaceWidgetContribution>;

export const listWorkspaceWidgetContributions = (kernel: Kernel): readonly WorkspaceWidgetRegistryEntry[] =>
  kernel.contributions.list<WorkspaceWidgetContribution>('canvas_widgets');
