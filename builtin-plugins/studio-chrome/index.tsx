/**
 * Tag panel and presentation chrome.
 * Components stay in components/; this plugin only changes how they are mounted.
 *
 * 注：底部提示词栏（PromptBar）已迁至 builtin.ai-providers —— 组件本体与挂载一并归该插件。
 */
import React from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import { WORKSPACE_UI_BRIDGE_SERVICE, type WorkspaceUiBridgeService } from '../../plugin-runtime/workspace-bridge';
import { bi } from '../../plugin-runtime/i18n';
import { ElementTagsPanel } from '../../components/ElementTagsPanel';
import { PresentationUI } from '../../components/PresentationUI';
import manifest from './manifest.json';

const TagsWidget: React.FC<{ kernel: Kernel }> = ({ kernel }) => {
  const bridge = kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService;
  return <ElementTagsPanel {...bridge.current.tags} />;
};

const PresentationWidget: React.FC<{ kernel: Kernel }> = ({ kernel }) => {
  const bridge = kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService;
  const { active, ...props } = bridge.current.presentation;
  if (!active) return null;
  return <PresentationUI {...props} />;
};

export const studioChromePlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const disposers = [
      ctx.contributions.register('canvas_widgets', {
        id: 'builtin.studio-chrome.tags',
        pluginId: manifest.id,
        priority: 20,
        value: { title: bi('标签', 'Tags'), bridgeKey: 'tags' as const, placement: 'tags' as const, component: TagsWidget },
      }),
      ctx.contributions.register('canvas_widgets', {
        id: 'builtin.studio-chrome.presentation',
        pluginId: manifest.id,
        priority: 20,
        value: { title: bi('放映', 'Presentation'), bridgeKey: 'presentation' as const, placement: 'presentation' as const, component: PresentationWidget },
      }),
    ];
    return () => disposers.forEach(dispose => dispose());
  },
});
