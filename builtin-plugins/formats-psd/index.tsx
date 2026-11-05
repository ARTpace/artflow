/**
 * formats-psd —— PSD 导入向导（原本体 App 内联的 PsdImportModal 挂接迁移）。
 * 分工：.psd 解析在 builtin.formats-image-doc 的 format.handler（已有）；
 * 本插件只负责导入方式的交互弹层；合并/图层导入动作经 bridge 透传给本体元素管线。
 */
import React from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import { WORKSPACE_UI_BRIDGE_SERVICE, type WorkspaceUiBridgeService } from '../../plugin-runtime/workspace-bridge';
import type { WorkspaceWidgetProps } from '../../plugin-runtime/widget-contributions';
import { bi } from '../../plugin-runtime/i18n';
import { PsdImportModal } from '../../components/PsdImportModal';
import manifest from './manifest.json';

const PsdModalWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const slice = (kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService).current.psdModal;
  return <PsdImportModal {...slice} />;
};

export const formatsPsdPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    return ctx.contributions.register('canvas_widgets', {
      id: 'builtin.formats-psd.wizard',
      pluginId: 'builtin.formats-psd',
      priority: 5,
      value: { title: bi('PSD 导入向导', 'PSD Import Wizard'), bridgeKey: 'psdModal', placement: 'workspace' as const, component: PsdModalWidget },
    });
  },
});
