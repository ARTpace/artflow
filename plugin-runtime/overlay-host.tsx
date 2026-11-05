/**
 * Plugin overlays inside the camera group. They pan and zoom with the board.
 * They do not replace culling, LOD, or the camera transform.
 */
import React from 'react';
import type { Kernel } from './kernel';
import { PluginErrorBoundary } from './plugin-error-boundary';

interface OverlayProps {
  zoom: number;
}

interface OverlayContribution {
  component: React.ComponentType<OverlayProps>;
}

export const PluginOverlayHost: React.FC<{ kernel: Kernel; zoom: number }> = ({ kernel, zoom }) => {
  const overlays = kernel.contributions.list('canvas_overlays') as ReadonlyArray<{ id: string; pluginId?: string; value: OverlayContribution }>;
  if (overlays.length === 0) return null;
  const width = Math.max(1, 1600 / Math.max(zoom, 0.02));
  const height = Math.max(1, 1000 / Math.max(zoom, 0.02));
  return (
    <g>
      {overlays.map(entry => {
        const Overlay = entry.value.component;
        return (
          <foreignObject key={entry.id} x={0} y={0} width={width} height={height} style={{ overflow: 'visible' }}>
            {/* 本地错误边界：单个插件的画布浮层抛错只在该 foreignObject 内降级为占位，
                画布本体、相机变换与其他浮层不受影响（不再冒泡到根边界整页报错）。 */}
            <PluginErrorBoundary slot="canvas_overlays" pluginId={entry.pluginId} label={entry.id} fill minHeight={80}>
              <Overlay zoom={zoom} />
            </PluginErrorBoundary>
          </foreignObject>
        );
      })}
    </g>
  );
};
