/**
 * ui-shell —— 界面外壳四件套（原本体 App 硬编码的迁移）。
 * 组件本体一行不改（保护条款）：TopBar/BoardPanel/Toolbar/LayerPanel 的 props 经
 * workspace.ui-bridge 对应分片原样透传，仅挂接方式改为 canvas_widgets 贡献。
 * placement 决定 App 布局中的宿主点位。
 */
import React from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { WORKSPACE_UI_BRIDGE_SERVICE, type WorkspaceUiBridgeService } from '../../plugin-runtime/workspace-bridge';
import type { WorkspaceWidgetProps } from '../../plugin-runtime/widget-contributions';
import { TopBar } from '../../components/TopBar';
import { BoardPanel } from '../../components/BoardPanel';
import { Toolbar } from '../../components/Toolbar';
import { LayerPanel } from '../../components/LayerPanel';

const useSlice = <K extends keyof WorkspaceUiBridgeService['current']>(kernel: Kernel, key: K): WorkspaceUiBridgeService['current'][K] =>
  (kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService).current[key];

const TopBarWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => <TopBar {...useSlice(kernel, 'topbar')} />;
const BoardWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => <BoardPanel {...useSlice(kernel, 'board')} />;
const ToolbarWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => <Toolbar {...useSlice(kernel, 'toolbar')} />;
const LayerWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => <LayerPanel {...useSlice(kernel, 'layer')} />;

/** Host-owned registration; never participates in the optional plugin lifecycle. */
export function activateUiShell(ctx: Kernel): Effect {
  const disposers = [
    ctx.contributions.register('canvas_widgets', {
      id: 'builtin.ui-shell.topbar',
      pluginId: 'builtin.ui-shell',
      priority: 40,
      value: { title: '顶栏', bridgeKey: 'topbar', placement: 'topbar' as const, component: TopBarWidget },
    }),
    ctx.contributions.register('canvas_widgets', {
      id: 'builtin.ui-shell.board',
      pluginId: 'builtin.ui-shell',
      priority: 30,
      value: { title: '板列表面板', bridgeKey: 'board', placement: 'board' as const, component: BoardWidget },
    }),
    ctx.contributions.register('canvas_widgets', {
      id: 'builtin.ui-shell.toolbar',
      pluginId: 'builtin.ui-shell',
      priority: 20,
      value: { title: '工具条', bridgeKey: 'toolbar', placement: 'toolbar' as const, component: ToolbarWidget },
    }),
    ctx.contributions.register('canvas_widgets', {
      id: 'builtin.ui-shell.layer',
      pluginId: 'builtin.ui-shell',
      priority: 10,
      value: { title: '图层/帧面板', bridgeKey: 'layer', placement: 'layer' as const, component: LayerWidget },
    }),
  ];
  return () => disposers.forEach(dispose => dispose());
}
