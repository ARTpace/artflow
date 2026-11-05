/**
 * builtin/cutout —— 本地抠图插件。
 *
 * 入口三件套（都在插件侧，不碰本体）：
 * 1. canvas_widgets 浮层：选中单张图片时右下角浮出「抠图」按钮；打开后挂载 CutoutEditor 模态；
 * 2. commands：命令面板「抠图（本地算法）」（Alt+Shift+K），选中非单张图片时自动置灰；
 * 3. kernel 事件总线（cutout:open）：命令与浮层按钮共用同一个打开通道。
 *
 * 算法与 UI 分工：matting.ts 是纯函数核心（可 node self-check），CutoutEditor.tsx 只管交互与画布。
 */

import React from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import { CANVAS_EXPORT_SOURCE_SERVICE, type CanvasExportSource } from '../../plugin-runtime/canvas-export-source';
import type { CommandDefinition } from '../../plugin-runtime/commands';
import type { WorkspaceWidgetProps } from '../../plugin-runtime/widget-contributions';
import type { ImageElement } from '../../types';
import manifest from './manifest.json';

/** 编辑器与算法只在真正打开抠图时才进包，启动路径只留这个薄壳。 */
const CutoutEditor = React.lazy(() => import('./CutoutEditor').then(module => ({ default: module.CutoutEditor })));

export const CUTOUT_OPEN_TOPIC = 'cutout:open';

/**
 * 恰好选中一张图片时返回它，否则 null（多选/非图片一律不开）。
 *
 * ⚠️ 必须先用 kernel.has 探针：canvas.export-source 由 App 在 useEffect 内注册，
 * widget 首帧渲染时服务还不存在，直接 use() 会抛 "service not provided" 把整个 App
 * 渲染打崩（表现为白屏 + App 二次挂载再撞 workspace.ui-bridge already provided）。
 */
const selectedSingleImage = (kernel: Kernel): ImageElement | null => {
  if (!kernel.has(CANVAS_EXPORT_SOURCE_SERVICE)) return null;
  const scope = kernel.use<CanvasExportSource>(CANVAS_EXPORT_SOURCE_SERVICE).getExportScope();
  if (!scope) return null;
  const ids = new Set(scope.selectionIds);
  const selected = scope.elements.filter(element => ids.has(element.id));
  if (selected.length !== 1) return null;
  const target = selected[0];
  return target.type === 'image' ? (target as unknown as ImageElement) : null;
};

const CutoutWidget: React.FC<WorkspaceWidgetProps> = ({ kernel }) => {
  const [target, setTarget] = React.useState<ImageElement | null>(null);

  React.useEffect(
    () =>
      kernel.on(CUTOUT_OPEN_TOPIC, () => {
        const image = selectedSingleImage(kernel);
        if (image) setTarget(image);
      }),
    [kernel],
  );

  const single = selectedSingleImage(kernel);

  return (
    <>
      {single && target === null && (
        <div data-bp-ui-floating-shell="" className="fixed bottom-4 right-4 z-40">
          <button
            type="button"
            onClick={() => setTarget(single)}
            title="抠图（魔法棒选中 + 涂抹/恢复羽化 + 缩放/平移）"
            className="rounded-2xl border border-white/15 bg-neutral-950/85 px-3 py-2 text-xs font-medium text-white shadow-2xl backdrop-blur-xl transition hover:border-white/30 hover:bg-neutral-900/95"
          >
            抠图
          </button>
        </div>
      )}
      {target && (
        <React.Suspense fallback={null}>
          <CutoutEditor key={target.id} kernel={kernel} element={target} onClose={() => setTarget(null)} />
        </React.Suspense>
      )}
    </>
  );
};

const cutoutCommand: CommandDefinition = {
  title: '抠图（本地算法）',
  description: '对选中的单张图片打开本地抠图编辑器：魔术棒按颜色选区、擦除/恢复笔刷、收缩与羽化边缘，输出带 alpha 的 PNG。',
  group: '图像',
  keywords: ['抠图', '抠像', '去背景', '背景移除', '透明', 'cutout', 'matting', 'alpha', 'png', '透明背景'],
  shortcut: { key: 'k', alt: true, shift: true },
  isEnabled: kernel => selectedSingleImage(kernel) !== null,
  run: kernel => kernel.emit(CUTOUT_OPEN_TOPIC),
};

export const cutoutPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const disposeWidget = ctx.contributions.register('canvas_widgets', {
      id: 'builtin.cutout.editor',
      pluginId: manifest.id,
      priority: 70,
      value: {
        title: '本地抠图编辑器',
        bridgeKey: 'diagnostics' as const,
        placement: 'workspace' as const,
        component: CutoutWidget,
      },
    });

    const disposeCommand = ctx.contributions.register('commands', {
      id: 'builtin.cutout.open',
      pluginId: manifest.id,
      priority: 10,
      value: cutoutCommand,
    });

    return () => {
      disposeCommand();
      disposeWidget();
    };
  },
});
