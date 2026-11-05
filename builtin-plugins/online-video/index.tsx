import React from 'react';
import manifest from './manifest.json';
import type { BuiltinPluginModule } from '../../plugin-runtime/loader';
import type { CanvasCardContribution } from '../../plugin-runtime/card-contributions';
import { registerClipboardTextHandler } from '../../plugin-runtime/clipboard-handlers';
import { generateId } from '../../utils/canvasUtils';
import { findVideoLink, ONLINE_VIDEO_NODE } from './links';

const Card = React.lazy(() => import('./OnlineVideoCard').then(module => ({ default: module.OnlineVideoCard })));
export const onlineVideoPlugin: BuiltinPluginModule = {
  manifest,
  activate(ctx) {
    const disposeCard = ctx.contributions.register<CanvasCardContribution>('canvas_node_types', {
      id: ONLINE_VIDEO_NODE, pluginId: manifest.id,
      value: { nodeType: ONLINE_VIDEO_NODE, component: Card },
    });
    const disposePaste = registerClipboardTextHandler((text, center) => {
      const link = findVideoLink(text);
      if (!link) return null;
      return [{ id: generateId(), type: 'plugin-node', nodeType: ONLINE_VIDEO_NODE,
        name: link.label, data: { sourceUrl: link.sourceUrl },
        x: center.x - 240, y: center.y - 157, width: 480, height: 314, rotation: 0 }];
    });
    return () => { disposePaste(); disposeCard(); };
  },
};
