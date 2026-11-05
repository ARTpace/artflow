/**
 * Selection / element / smart toolbars. Components stay in components/;
 * this plugin only changes how they are mounted.
 */
import React from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import { WORKSPACE_UI_BRIDGE_SERVICE, type WorkspaceUiBridgeService } from '../../plugin-runtime/workspace-bridge';
import { ToolbarOverlay } from '../../components/ToolbarOverlay';
import { SmartToolbar } from '../../components/SmartToolbar';
import manifest from './manifest.json';

const SelectionOverlayWidget: React.FC<{ kernel: Kernel }> = ({ kernel }) => {
  const bridge = kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService;
  const props = bridge.current.selectionOverlay;
  if (!props) return null;
  return <ToolbarOverlay {...props} />;
};

const SmartToolbarWidget: React.FC<{ kernel: Kernel }> = ({ kernel }) => {
  const bridge = kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService;
  return <SmartToolbar {...bridge.current.smartToolbar} />;
};

export const canvasToolbarsPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const disposers = [
      ctx.contributions.register('ui_toolbar', {
        id: 'builtin.canvas-toolbars.selection',
        pluginId: 'builtin.canvas-toolbars',
        priority: 20,
        value: { placement: 'selection-overlay' as const, component: SelectionOverlayWidget },
      }),
      ctx.contributions.register('ui_toolbar', {
        id: 'builtin.canvas-toolbars.smart',
        pluginId: 'builtin.canvas-toolbars',
        priority: 10,
        value: { placement: 'smart' as const, component: SmartToolbarWidget },
      }),
    ];
    return () => disposers.forEach(dispose => dispose());
  },
});
