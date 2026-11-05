/**
 * builtin/workspace-panels —— R18-R22 五面板债务迁移（原则 #7：UI 必须走贡献通道）。
 * 组件本体不重写（保护条款：迁移只改宿主挂接方式）；App 经 workspace.ui-bridge 服务供给状态与回调，
 * 本插件把六个组件注册进 canvas_widgets 插槽，由通用宿主 WorkspaceWidgetHost 投影渲染。
 */

import React from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import {
  WORKSPACE_UI_BRIDGE_SERVICE,
  type WorkspaceUiBridgeService,
} from '../../plugin-runtime/workspace-bridge';
import type { WorkspaceWidgetProps } from '../../plugin-runtime/widget-contributions';
import { ImportJobsPanel } from '../../components/ImportJobsPanel';
import { ProjectWorkspacePanel, WorkspaceStatusDock } from '../../components/ProjectWorkspacePanel';
import { CanvasNavigator } from '../../components/CanvasNavigator';
import { ViewBookmarksPanel } from '../../components/ViewBookmarksPanel';
import { CanvasFinderPanel } from '../../components/CanvasFinderPanel';
import manifest from './manifest.json';

const useBridge = (kernel: Kernel): WorkspaceUiBridgeService =>
  kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService;

const DockWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const bridge = useBridge(kernel);
  return <WorkspaceStatusDock {...bridge.current.dock} />;
};

const FinderWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const bridge = useBridge(kernel);
  return <CanvasFinderPanel {...bridge.current.finder} />;
};

const BookmarksWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const bridge = useBridge(kernel);
  return <ViewBookmarksPanel {...bridge.current.bookmarks} />;
};

const NavigatorWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const bridge = useBridge(kernel);
  return <CanvasNavigator {...bridge.current.navigator} />;
};

const ProjectPanelWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const bridge = useBridge(kernel);
  return <ProjectWorkspacePanel {...bridge.current.projectPanel} />;
};

const ImportJobsWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const bridge = useBridge(kernel);
  if (!bridge.current.importJobs.isAvailable) return null;
  return <ImportJobsPanel {...bridge.current.importJobs} />;
};

export const workspacePanelsPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const disposers = [
      ctx.contributions.register('canvas_widgets', {
        id: 'builtin.workspace-panels.dock',
        pluginId: 'builtin.workspace-panels',
        priority: 60,
        value: { title: '工作台状态 Dock', bridgeKey: 'dock', component: DockWidget },
      }),
      ctx.contributions.register('canvas_widgets', {
        id: 'builtin.workspace-panels.finder',
        pluginId: 'builtin.workspace-panels',
        priority: 50,
        value: { title: '当前板查找', bridgeKey: 'finder', component: FinderWidget },
      }),
      ctx.contributions.register('canvas_widgets', {
        id: 'builtin.workspace-panels.bookmarks',
        pluginId: 'builtin.workspace-panels',
        priority: 40,
        value: { title: '视图书签', bridgeKey: 'bookmarks', component: BookmarksWidget },
      }),
      ctx.contributions.register('canvas_widgets', {
        id: 'builtin.workspace-panels.navigator',
        pluginId: 'builtin.workspace-panels',
        priority: 30,
        value: { title: '画布导航器', bridgeKey: 'navigator', component: NavigatorWidget },
      }),
      ctx.contributions.register('canvas_widgets', {
        id: 'builtin.workspace-panels.project-panel',
        pluginId: 'builtin.workspace-panels',
        priority: 20,
        value: { title: '项目工作台', bridgeKey: 'projectPanel', component: ProjectPanelWidget },
      }),
      ctx.contributions.register('canvas_widgets', {
        id: 'builtin.workspace-panels.import-jobs',
        pluginId: 'builtin.workspace-panels',
        priority: 10,
        value: { title: '导入任务', bridgeKey: 'importJobs', component: ImportJobsWidget },
      }),
    ];
    return () => disposers.forEach(dispose => dispose());
  },
});
