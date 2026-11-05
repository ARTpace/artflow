import React from 'react';
import type { Kernel } from '../plugin-runtime/kernel';
import { listWorkspaceWidgetContributions, type WorkspaceWidgetPlacement } from '../plugin-runtime/widget-contributions';
import { PluginErrorBoundary } from '../plugin-runtime/plugin-error-boundary';

interface WorkspaceWidgetHostProps {
  kernel: Kernel;
  /** 只渲染声明了该挂载位的组件；缺省 workspace。 */
  placement?: WorkspaceWidgetPlacement;
}

/**
 * `canvas_widgets` 通用宿主：按注册表顺序渲染指定挂载位的组件，零业务知识。
 * 组件自取 workspace.ui-bridge 服务；本宿主只做“投影”。
 * 每个挂载位外裹局部错误边界：单个插件 widget 抛错只降级为占位（含 pluginId），
 * 同挂载位的其他组件与工作台主体不受影响。
 */
export const WorkspaceWidgetHost: React.FC<WorkspaceWidgetHostProps> = ({ kernel, placement = 'workspace' }) => {
  const widgets = listWorkspaceWidgetContributions(kernel).filter(
    entry => (entry.value.placement ?? 'workspace') === placement,
  );
  return (
    <>
      {widgets.map(widget => {
        const Widget = widget.value.component;
        return (
          <PluginErrorBoundary key={widget.id} slot="canvas_widgets" pluginId={widget.pluginId} label={widget.id} fill minHeight={32}>
            <Widget kernel={kernel} />
          </PluginErrorBoundary>
        );
      })}
    </>
  );
};
