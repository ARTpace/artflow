/**
 * builtin/canvas-export —— 画布/选区导出 PNG + 复制剪贴板（PureRef 对齐 #4）。
 * 快照经 CANVAS_EXPORT_SOURCE_SERVICE，落盘经 host.platform.saveBytes（主进程保存对话框）。
 */

import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import { CANVAS_EXPORT_SOURCE_SERVICE, type CanvasExportSource } from '../../plugin-runtime/canvas-export-source';
import type { CommandDefinition } from '../../plugin-runtime/commands';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import { composeExportPng } from './compose';
import manifest from './manifest.json';
import { uiText } from '../../utils/language-store';
import { bi } from '../../plugin-runtime/i18n';

const exportSource = (kernel: Kernel): CanvasExportSource => kernel.use<CanvasExportSource>(CANVAS_EXPORT_SOURCE_SERVICE);
const hostPlatform = (kernel: Kernel): HostPlatformService => kernel.use<HostPlatformService>(HOST_PLATFORM_SERVICE);

const timestampName = () => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

const exportToPng = async (kernel: Kernel, selectionOnly: boolean) => {
  const scope = exportSource(kernel).getExportScope();
  if (!scope) return;
  const composed = await composeExportPng(scope, selectionOnly);
  if (!composed) return;
  const bytes = await composed.blob.arrayBuffer();
  const result = await hostPlatform(kernel).saveBytes({
    title: uiText('导出画布为 PNG', 'Export canvas as PNG'),
    defaultName: `artflow-${timestampName()}.png`,
    bytes,
  });
  if (!result.ok && result.message !== 'canceled') console.warn('[canvas-export] save failed:', result.message);
};

const copyToClipboard = async (kernel: Kernel, selectionOnly: boolean) => {
  const scope = exportSource(kernel).getExportScope();
  if (!scope) return;
  const composed = await composeExportPng(scope, selectionOnly);
  if (!composed) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': composed.blob })]);
  } catch (error) {
    console.warn('[canvas-export] clipboard write failed:', error);
  }
};

const canvasExportCommands: readonly { id: string; value: CommandDefinition }[] = [
  {
    id: 'canvas.export-png',
    value: {
      title: bi('导出画布为 PNG', 'Export canvas as PNG'),
      description: bi('把画板上的全部卡片栅格化为 PNG 文件。', 'Rasterize all cards on the board into a PNG file.'),
      group: 'Export',
      keywords: ['导出', 'png', 'export', 'image', '图片'],
      shortcut: { key: 'e', mod: true, alt: true },
      isEnabled: kernel => (exportSource(kernel).getExportScope()?.elements.length ?? 0) > 0,
      run: kernel => exportToPng(kernel, false),
    },
  },
  {
    id: 'canvas.export-selection-png',
    value: {
      title: bi('导出选区为 PNG', 'Export selection as PNG'),
      description: bi('把所选卡片栅格化为 PNG 文件。', 'Rasterize the selected cards into a PNG file.'),
      group: 'Export',
      keywords: ['导出', 'selection', '选区', 'png'],
      shortcut: { key: 'e', mod: true, alt: true, shift: true },
      isEnabled: kernel => (exportSource(kernel).getExportScope()?.selectionIds.length ?? 0) > 0,
      run: kernel => exportToPng(kernel, true),
    },
  },
  {
    id: 'canvas.copy-image',
    value: {
      title: bi('复制画布图像到剪贴板', 'Copy canvas image to clipboard'),
      description: bi('把整块画板作为 PNG 图像复制到系统剪贴板。', 'Copy the whole board as a PNG image to the system clipboard.'),
      group: 'Export',
      keywords: ['复制', '剪贴板', 'clipboard', 'copy', '粘贴'],
      shortcut: { key: 'c', mod: true, alt: true },
      isEnabled: kernel => (exportSource(kernel).getExportScope()?.elements.length ?? 0) > 0,
      run: kernel => copyToClipboard(kernel, false),
    },
  },
  {
    id: 'canvas.copy-selection-image',
    value: {
      title: bi('复制选区图像到剪贴板', 'Copy selection image to clipboard'),
      description: bi('把所选卡片作为 PNG 图像复制到系统剪贴板。', 'Copy the selected cards as a PNG image to the system clipboard.'),
      group: 'Export',
      keywords: ['复制', '选区', 'clipboard', 'selection'],
      shortcut: { key: 'c', mod: true, alt: true, shift: true },
      isEnabled: kernel => (exportSource(kernel).getExportScope()?.selectionIds.length ?? 0) > 0,
      run: kernel => copyToClipboard(kernel, true),
    },
  },
];

export const canvasExportPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const disposers = canvasExportCommands.map(({ id, value }) => ctx.contributions.register<CommandDefinition>('commands', {
      id,
      pluginId: 'builtin.canvas-export',
      priority: 20,
      value,
    }));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  },
});
