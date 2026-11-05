import React from 'react';
import type { Kernel } from './kernel';
import { listCanvasToolbarContributions, type CanvasToolbarPlacement } from './toolbar-contributions';
import { PluginErrorBoundary } from './plugin-error-boundary';

/** Renders every toolbar a plugin registered for this placement. Empty when none are enabled. */
export const CanvasToolbarHost: React.FC<{ kernel: Kernel; placement: CanvasToolbarPlacement }> = ({ kernel, placement }) => {
  const entries = listCanvasToolbarContributions(kernel, placement);
  return (
    <>
      {entries.map(entry => {
        const Toolbar = entry.value.component;
        // 局部错误边界：单个插件工具条抛错只坏它自己（占位含 pluginId），另一条工具条与画布照常。
        return (
          <PluginErrorBoundary key={entry.id} slot="ui_toolbar" pluginId={entry.pluginId} label={entry.id} fill minHeight={40}>
            <Toolbar kernel={kernel} />
          </PluginErrorBoundary>
        );
      })}
    </>
  );
};
