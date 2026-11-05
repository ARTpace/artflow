import React from 'react';
import type { Kernel } from '../../plugin-runtime/kernel';
import { WORKSPACE_UI_BRIDGE_SERVICE, type WorkspaceUiBridgeService } from '../../plugin-runtime/workspace-bridge';
import { PromptBar } from './PromptBar';

/**
 * 底部提示词栏 widget：本插件产出的生成入口。
 * props 经 `workspace-bridge` 的 `promptBar` 分片由 App 注入；组件本体已迁入本插件目录。
 */
export const PromptBarWidget: React.FC<{ kernel: Kernel }> = ({ kernel }) => {
  const bridge = kernel.use(WORKSPACE_UI_BRIDGE_SERVICE) as WorkspaceUiBridgeService;
  return <PromptBar {...bridge.current.promptBar} />;
};
