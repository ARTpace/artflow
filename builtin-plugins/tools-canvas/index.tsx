/**
 * builtin.tools-canvas —— 聚合插件：画布操作与导出工具集。
 * 整合自 arrange-tools、image-tools、view-tools、window-tools、canvas-export、exporters。
 * 旧插件目录保留但不再注册；本插件统一注册全部命令/菜单/设置。
 * 纯逻辑函数仍复用旧目录实现（见下方 import）。
 */

import React from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import type { CommandDefinition } from '../../plugin-runtime/commands';
import type { ContextMenuItem, ContextMenuContext } from '../../plugin-runtime/menu-contributions';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import { CANVAS_EXPORT_SOURCE_SERVICE, type CanvasExportSource } from '../../plugin-runtime/canvas-export-source';
import { CANVAS_MUTATION_SERVICE, type CanvasMutationService, type ElementPatch } from '../../plugin-runtime/canvas-mutation';
import { CANVAS_VIEW_STATE_SERVICE, type CanvasViewStateService } from '../../plugin-runtime/canvas-view-state';
import { DOCUMENT_SERVICE, OPERATIONS_SERVICE, MAX_OPERATION_NODES, type DocumentService, type OperationsService, type GeometryNode, type GeometryPatch, type DocumentContext } from '../../plugin-runtime/document-sdk';
import { usePluginService } from '../../plugin-runtime/service-directory';
import type { ScopedPluginContext } from '../../plugin-runtime/scoped-context';
import { SectionBlock, SettingsRow } from '../../plugin-runtime/settings-ui';
import type { SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import type { ImageElement } from '../../types';
import { composeExportPng } from '../../capabilities/canvas-export/compose';
import { imageFileExtension } from '../../utils/nativeDragOut';
import { uiText } from '../../utils/language-store';
import { bi } from '../../plugin-runtime/i18n';
import manifest from './manifest.json';

const hostPlatform = (kernel: Kernel): HostPlatformService => kernel.use<HostPlatformService>(HOST_PLATFORM_SERVICE);
const exportSource = (kernel: Kernel): CanvasExportSource => kernel.use<CanvasExportSource>(CANVAS_EXPORT_SOURCE_SERVICE);
const mutation = (kernel: Kernel): CanvasMutationService => kernel.use<CanvasMutationService>(CANVAS_MUTATION_SERVICE);

// ==================== Arrange Tools（原 arrange-tools） ====================
const arrangeDocument = (ctx: ScopedPluginContext) => usePluginService<DocumentService>(ctx, DOCUMENT_SERVICE);
const arrangeSelectedCount = (ctx: ScopedPluginContext): number => {
  try { return arrangeDocument(ctx).getContext().selectionIds.length; } catch { return 0; }
};
const arrangeSelectedImageCount = (ctx: ScopedPluginContext): number => {
  try { return readArrange(ctx).nodes.filter(node => node.type === 'image').length; } catch { return 0; }
};
function readArrange(ctx: ScopedPluginContext, allIfUnselected = false) {
  const service = arrangeDocument(ctx); const token = service.getContext();
  const selected = token.selectionIds;
  const count = selected.length || (allIfUnselected ? token.totalNodes : 0);
  if (count > MAX_OPERATION_NODES) throw new Error('Arrangement supports up to 1000 nodes per transaction; select a smaller batch.');
  const nodes: GeometryNode[] = [];
  for (let offset = 0; offset < count; offset += 500) nodes.push(...service.query(token, { offset, limit: 500, ids: selected.length ? selected : undefined }));
  return { token, nodes };
}
let requestSequence = 0;
function submitArrange(ctx: ScopedPluginContext, token: DocumentContext, patches: { id: string; patch: GeometryPatch }[], label: string) {
  if (!patches.length) return;
  const result = usePluginService<OperationsService>(ctx, OPERATIONS_SERVICE).apply({
    sessionId: token.sessionId, boardId: token.boardId, revision: token.revision,
    requestId: `arrange-${Date.now().toString(36)}-${++requestSequence}`, label,
    operations: patches.map(patch => ({ kind: 'node.patchGeometry' as const, ...patch })),
  });
  if (result.status === 'rejected' || result.status === 'conflict') throw new Error(`${result.code}: ${result.message}`);
}
function translateNode(node: GeometryNode, dx: number, dy: number): GeometryPatch {
  if (node.geometry.points) return { points: node.geometry.points.map(point => ({ x: point.x + dx, y: point.y + dy })) };
  if (node.geometry.x === undefined || node.geometry.y === undefined) throw new Error(`Node ${node.id} needs a dedicated group/geometry operation`);
  return { x: node.geometry.x + dx, y: node.geometry.y + dy };
}
function distribute(ctx: ScopedPluginContext, axis: 'x' | 'y') {
  const { token, nodes } = readArrange(ctx); if (nodes.length < 3) return;
  const size = axis === 'x' ? 'width' : 'height';
  const sorted = [...nodes].sort((a, b) => (a.bounds[axis] + a.bounds[size] / 2) - (b.bounds[axis] + b.bounds[size] / 2));
  const first = sorted[0].bounds, last = sorted[sorted.length - 1].bounds;
  const start = first[axis] + first[size] / 2;
  const step = (last[axis] + last[size] / 2 - start) / (sorted.length - 1);
  submitArrange(ctx, token, sorted.slice(1, -1).map((node, index) => {
    const delta = start + step * (index + 1) - node.bounds[axis] - node.bounds[size] / 2;
    return { id: node.id, patch: translateNode(node, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0) };
  }), 'Distribute nodes');
}
function arrangeRandomly(ctx: ScopedPluginContext) {
  const { token, nodes } = readArrange(ctx, true); if (!nodes.length) return;
  const minX = Math.min(...nodes.map(n => n.bounds.x)), minY = Math.min(...nodes.map(n => n.bounds.y));
  const width = Math.max(1, Math.max(...nodes.map(n => n.bounds.x + n.bounds.width)) - minX);
  const height = Math.max(1, Math.max(...nodes.map(n => n.bounds.y + n.bounds.height)) - minY);
  submitArrange(ctx, token, nodes.map(node => ({ id: node.id, patch: translateNode(node,
    minX + Math.random() * (width - node.bounds.width) - node.bounds.x,
    minY + Math.random() * (height - node.bounds.height) - node.bounds.y) })), 'Arrange nodes randomly');
}
function normalizeArea(ctx: ScopedPluginContext) {
  const { token, nodes } = readArrange(ctx); const images = nodes.filter(node => node.type === 'image'); if (images.length < 2) return;
  const areas = images.map(node => Math.max(1, node.bounds.width * node.bounds.height)).sort((a, b) => a - b);
  const area = areas[Math.floor(areas.length / 2)];
  submitArrange(ctx, token, images.map(node => {
    const { width, height } = node.geometry;
    if (!(width > 0) || !(height > 0)) throw new Error('Invalid image geometry');
    const scale = Math.sqrt(area / (width * height));
    return { id: node.id, patch: { width: width * scale, height: height * scale } };
  }), 'Normalize image areas');
}
const arrangeCommands = (ctx: ScopedPluginContext): readonly { id: string; value: CommandDefinition }[] => [
  { id: 'arrange.distribute-h', value: { title: bi('水平等距分布', 'Distribute horizontally'), description: bi('把所选卡片在水平轴等距排开。', 'Space the selected cards evenly on the horizontal axis.'), group: 'Arrange', keywords: ['分布', '水平', 'distribute', 'spacing', '等距'], isEnabled: () => arrangeSelectedCount(ctx) >= 3, run: () => distribute(ctx, 'x') } },
  { id: 'arrange.distribute-v', value: { title: bi('垂直等距分布', 'Distribute vertically'), description: bi('把所选卡片在垂直轴等距排开。', 'Space the selected cards evenly on the vertical axis.'), group: 'Arrange', keywords: ['分布', '垂直', 'distribute', 'spacing', '等距'], isEnabled: () => arrangeSelectedCount(ctx) >= 3, run: () => distribute(ctx, 'y') } },
  { id: 'arrange.random', value: { title: bi('随机排列', 'Arrange randomly'), description: bi('把所选卡片（或整块画板）打散到随机位置。', 'Shuffle the selected cards (or the whole board) to random positions.'), group: 'Arrange', keywords: ['随机', '打散', 'random', 'shuffle', '散开'], run: () => arrangeRandomly(ctx) } },
  { id: 'arrange.normalize-area', value: { title: bi('面积归一', 'Normalize image areas'), description: bi('把所选图像缩放到相同显示面积，保持宽高比。', 'Scale selected images to the same display area, keeping aspect ratios.'), group: 'Arrange', keywords: ['面积', '归一', 'normalize', 'area', '统一大小'], isEnabled: () => arrangeSelectedImageCount(ctx) >= 2, run: () => normalizeArea(ctx) } },
];

// ==================== Image Tools（原 image-tools） ====================
const selectedImages = (kernel: Kernel): ImageElement[] => {
  const scope = exportSource(kernel).getExportScope();
  if (!scope) return [];
  const ids = new Set(scope.selectionIds);
  return scope.elements.filter(element => ids.has(element.id) && element.type === 'image') as unknown as ImageElement[];
};
const pickImageFile = (): Promise<File | null> => new Promise(resolve => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => resolve(input.files?.[0] ?? null);
  input.oncancel = () => resolve(null);
  input.style.display = 'none';
  document.body.appendChild(input);
  input.click();
  input.remove();
});
const newAssetId = () => `asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
interface ManagedImportResult {
  asset?: { id: string; locator: { previewRef?: string; originalRef?: string; fileRef?: string; mimeType?: string } };
  ok?: boolean;
  message?: string;
}
const replaceImage = async (kernel: Kernel, element: { type?: string; id: string; assetId?: string; href?: string; originalHref?: string; width?: number; height?: number }) => {
  if (element.type !== 'image') return;
  const file = await pickImageFile();
  if (!file) return;
  try {
    const bytes = await file.arrayBuffer();
    const result = await hostPlatform(kernel).importAsset({
      asset: { id: newAssetId(), kind: 'image', locator: { mimeType: file.type || 'image/png' }, metadata: { originalName: file.name } },
      bytes,
      originalName: file.name,
    }) as ManagedImportResult;
    const managed = result?.asset;
    if (!managed?.locator) throw new Error(result?.message ?? 'import returned no managed asset');
    const patch: Record<string, unknown> = {
      assetId: managed.id,
      href: managed.locator.previewRef ?? managed.locator.fileRef,
      originalHref: managed.locator.originalRef ?? managed.locator.previewRef,
      mimeType: managed.locator.mimeType ?? (file.type || 'image/png'),
      width: (element as ImageElement).width,
      height: (element as ImageElement).height,
    };
    mutation(kernel).patchElements([{ id: element.id, patch }], { committed: true });
  } catch (error) {
    console.error('[image-tools] replace image failed:', error);
  }
};
const DOWNSCALE_MAX_EDGE = 2048;
const downscaleImage = async (kernel: Kernel, element: ImageElement) => {
  const source = element.originalHref ?? element.href;
  const image = await new Promise<HTMLImageElement | null>(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = source;
  });
  if (!image) return null;
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  if (longest <= DOWNSCALE_MAX_EDGE) return null;
  const scale = DOWNSCALE_MAX_EDGE / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (!blob) return null;
  const bytes = await blob.arrayBuffer();
  const assetId = element.assetId ?? newAssetId();
  const result = await hostPlatform(kernel).importAsset({
    asset: { id: assetId, kind: 'image', locator: { mimeType: 'image/webp' }, metadata: { originalName: `downscaled-${DOWNSCALE_MAX_EDGE}px.webp` } },
    bytes,
    originalName: `downscaled-${DOWNSCALE_MAX_EDGE}px.webp`,
  }) as ManagedImportResult;
  const managed = result?.asset;
  if (!managed?.locator) throw new Error(result?.message ?? 'import returned no managed asset');
  return { patch: { assetId: managed.id, href: managed.locator.previewRef ?? managed.locator.fileRef, originalHref: managed.locator.originalRef ?? managed.locator.previewRef, mimeType: 'image/webp' } as Record<string, unknown> };
};
const downscaleSelection = async (kernel: Kernel) => {
  const elements = selectedImages(kernel);
  if (elements.length === 0) return;
  const patches: ElementPatch[] = [];
  for (const element of elements) {
    try {
      const result = await downscaleImage(kernel, element);
      if (result) patches.push({ id: element.id, patch: result.patch });
    } catch (error) { console.warn(`[image-tools] downscale skipped for ${element.id}:`, error); }
  }
  if (patches.length > 0) mutation(kernel).patchElements(patches, { committed: true });
};
const isSingleImage = (ctx: { element: { type?: string } | null }): boolean => ctx.element?.type === 'image';
const imageCommands: readonly { id: string; value: CommandDefinition }[] = [
  { id: 'image-tools.replace-image', value: { title: bi('替换图像', 'Replace image'), description: bi('置换所选图像的内容，位置与尺寸保持不变。', 'Swap the selected image content; position and size are kept.'), group: 'Image Tools', keywords: ['替换', '图像', 'replace', '换图'], isEnabled: kernel => selectedImages(kernel).length === 1, run: async kernel => { const [element] = selectedImages(kernel); if (element) await replaceImage(kernel, element as unknown as { type?: string; id: string }); } } },
  { id: 'image-tools.downscale-selection', value: { title: bi('批量降分辨率', 'Downscale selected images'), description: bi(`重新编码所选图像，使最长边不超过 ${DOWNSCALE_MAX_EDGE}px。`, `Re-encode selected images so the longest edge is at most ${DOWNSCALE_MAX_EDGE}px.`), group: 'Image Tools', keywords: ['降分辨率', '批处理', 'downscale', 'optimize', '压缩'], isEnabled: kernel => selectedImages(kernel).length >= 1, run: kernel => downscaleSelection(kernel) } },
];
const imageMenuItems: readonly { id: string; priority: number; value: Omit<ContextMenuItem, 'run'> & { run: (ctx: Parameters<ContextMenuItem['run']>[0], kernel: Kernel) => void } }[] = [
  { id: 'replace-image', priority: 50, value: { label: language => (language === 'zho' ? '替换图像…' : 'Replace image…'), group: 'image-tools', visible: ctx => isSingleImage(ctx), run: (ctx, kernel) => { if (ctx.element) void replaceImage(kernel, ctx.element as unknown as { type?: string; id: string }); } } },
  { id: 'downscale-selection', priority: 49, value: { label: language => (language === 'zho' ? '批量降分辨率' : 'Downscale images'), group: 'image-tools', visible: ctx => ctx.selectedElements.filter(element => element.type === 'image').length >= 2, run: (_ctx, kernel) => void downscaleSelection(kernel) } },
];

// ==================== View Tools（原 view-tools） ====================
const viewState = (kernel: Kernel): CanvasViewStateService => kernel.use<CanvasViewStateService>(CANVAS_VIEW_STATE_SERVICE);
const ToggleButton: React.FC<{ on: boolean; onClick: () => void; labelOn: string; labelOff: string }> = ({ on, onClick, labelOn, labelOff }) => (
  <button type="button" onClick={onClick} className={`min-w-[4.5rem] rounded px-3 py-1 text-sm ${on ? 'bg-violet-500 text-white' : 'bg-black/25 text-neutral-300 hover:bg-white/10'}`}>{on ? labelOn : labelOff}</button>
);
const ViewSettingsSection: React.FC<SettingsSectionProps> = ({ kernel }) => {
  const state = viewState(kernel);
  const [, force] = React.useReducer(count => count + 1, 0);
  return (
    <div className="space-y-3">
      <SectionBlock title="视图辅助（PureRef 对齐）">
        <SettingsRow label="一键去色"><ToggleButton on={state.isDesaturate()} onClick={() => { state.toggleDesaturate(); force(); }} labelOn="已去色" labelOff="原色" /></SettingsRow>
        <SettingsRow label="暗化非选中"><ToggleButton on={state.isDimUnselected()} onClick={() => { state.toggleDimUnselected(); force(); }} labelOn="已暗化" labelOff="关闭" /></SettingsRow>
      </SectionBlock>
      <SectionBlock title="背景网格">
        <SettingsRow label="显示网格"><ToggleButton on={state.isGridVisible()} onClick={() => { state.toggleGrid(); force(); }} labelOn="显示中" labelOff="隐藏" /></SettingsRow>
        <SettingsRow label="吸附网格"><ToggleButton on={state.isGridSnap()} onClick={() => { state.toggleGridSnap(); force(); }} labelOn="吸附中" labelOff="关闭" /></SettingsRow>
        <SettingsRow label="格距">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { state.adjustGridSize(-8); force(); }} className="rounded bg-black/25 px-2 py-1 text-sm text-neutral-300 hover:bg-white/10">−</button>
            <span className="w-12 text-center text-sm text-neutral-200">{state.gridSize()}</span>
            <button type="button" onClick={() => { state.adjustGridSize(8); force(); }} className="rounded bg-black/25 px-2 py-1 text-sm text-neutral-300 hover:bg-white/10">+</button>
          </div>
        </SettingsRow>
      </SectionBlock>
    </div>
  );
};
const viewCommands: readonly { id: string; value: CommandDefinition }[] = [
  { id: 'view.toggle-desaturate', value: { title: bi('切换去色', 'Toggle desaturate'), description: bi('以灰度显示整块画布，便于检查明度关系。', 'Show the whole canvas in grayscale for value checking.'), group: 'View', keywords: ['去色', '灰度', 'desaturate', 'grayscale', '素描关系'], shortcut: { key: 'd', alt: true, shift: true }, run: kernel => viewState(kernel).toggleDesaturate() } },
  { id: 'view.toggle-dim-unselected', value: { title: bi('切换暗化非选中', 'Toggle dim unselected'), description: bi('压暗除当前选中之外的所有卡片。', 'Dim every card except the current selection.'), group: 'View', keywords: ['暗化', '非选中', 'dim', 'focus', '聚焦'], shortcut: { key: 'h', alt: true, shift: true }, run: kernel => viewState(kernel).toggleDimUnselected() } },
  { id: 'view.toggle-grid', value: { title: bi('切换背景网格', 'Toggle background grid'), description: bi('显示或隐藏画布背景网格。', 'Show or hide the canvas background grid.'), group: 'View', keywords: ['网格', 'grid', '背景', '参考线'], shortcut: { key: 'g', mod: true, alt: true }, run: kernel => viewState(kernel).toggleGrid() } },
  { id: 'view.toggle-grid-snap', value: { title: bi('切换网格吸附', 'Toggle snap to grid'), description: bi('让拖动的卡片吸附到背景网格。', 'Snap dragged cards to the background grid.'), group: 'View', keywords: ['吸附', '网格', 'snap', 'grid'], shortcut: { key: 's', mod: true, alt: true }, run: kernel => viewState(kernel).toggleGridSnap() } },
  { id: 'view.grid-smaller', value: { title: bi('缩小网格', 'Smaller grid cells'), description: bi('减小背景网格的格子尺寸。', 'Decrease the background grid cell size.'), group: 'View', keywords: ['网格', '格距', '缩小'], run: kernel => viewState(kernel).adjustGridSize(-8) } },
  { id: 'view.grid-larger', value: { title: bi('放大网格', 'Larger grid cells'), description: bi('增大背景网格的格子尺寸。', 'Increase the background grid cell size.'), group: 'View', keywords: ['网格', '格距', '放大'], run: kernel => viewState(kernel).adjustGridSize(8) } },
];

// ==================== Window Tools（原 window-tools） ====================
const OPACITY_STEP = 0.1;
const MIN_OPACITY = 0.2;
const isRejected = <T,>(result: T | string): result is string => typeof result === 'string';
const windowToolsState = { alwaysOnTop: false, opacity: 1, clickThrough: false };
const windowCommands: readonly { id: string; value: CommandDefinition }[] = [
  { id: 'window.toggle-always-on-top', value: { title: bi('切换窗口置顶', 'Toggle always on top'), description: bi('让画布窗口悬浮在其它应用之上。', 'Float the canvas above every other application.'), group: 'Window', keywords: ['置顶', '悬浮', 'always on top', 'pin', 'float'], shortcut: { key: 't', alt: true, shift: true }, isEnabled: kernel => hostPlatform(kernel).canWindowControls, run: async kernel => { const result = await hostPlatform(kernel).setAlwaysOnTop(!(windowToolsState.alwaysOnTop)); if (typeof result === 'boolean') windowToolsState.alwaysOnTop = result; else console.warn('[window-tools] always-on-top rejected:', result); } } },
  { id: 'window.opacity-up', value: { title: bi('提高窗口不透明度', 'Increase window opacity'), description: bi('把画布窗口的不透明度提高 10%。', 'Make the canvas window more opaque by 10%.'), group: 'Window', keywords: ['不透明度', 'opacity', '半透明'], shortcut: { key: 'arrowup', alt: true, shift: true }, isEnabled: kernel => hostPlatform(kernel).canWindowControls, run: async kernel => { const next = Math.min(1, Math.round((windowToolsState.opacity + OPACITY_STEP) * 10) / 10); const result = await hostPlatform(kernel).setWindowOpacity(next); if (isRejected(result)) console.warn('[window-tools] opacity rejected:', result); else windowToolsState.opacity = result; } } },
  { id: 'window.opacity-down', value: { title: bi('降低窗口不透明度', 'Decrease window opacity'), description: bi('把画布窗口的不透明度降低 10%。', 'Make the canvas window more transparent by 10%.'), group: 'Window', keywords: ['不透明度', 'opacity', '半透明'], shortcut: { key: 'arrowdown', alt: true, shift: true }, isEnabled: kernel => hostPlatform(kernel).canWindowControls, run: async kernel => { const next = Math.max(MIN_OPACITY, Math.round((windowToolsState.opacity - OPACITY_STEP) * 10) / 10); const result = await hostPlatform(kernel).setWindowOpacity(next); if (isRejected(result)) console.warn('[window-tools] opacity rejected:', result); else windowToolsState.opacity = result; } } },
  { id: 'window.toggle-click-through', value: { title: bi('切换鼠标穿透', 'Toggle mouse click-through'), description: bi('让鼠标点击穿透画布窗口。再次使用同一快捷键可恢复。', 'Let mouse clicks pass through the canvas window. Toggle again with the same shortcut.'), group: 'Window', keywords: ['穿透', 'click through', '鼠标穿透', '不挡鼠标'], shortcut: { key: 'x', alt: true, shift: true }, isEnabled: kernel => hostPlatform(kernel).canWindowControls, run: async kernel => { const result = await hostPlatform(kernel).setIgnoreMouseEvents(!windowToolsState.clickThrough); if (isRejected(result)) console.warn('[window-tools] click-through rejected:', result); else windowToolsState.clickThrough = result; } } },
];

// ==================== Canvas Export（原 canvas-export） ====================
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
  const result = await hostPlatform(kernel).saveBytes({ title: uiText('导出画布为 PNG', 'Export canvas as PNG'), defaultName: `artflow-${timestampName()}.png`, bytes });
  if (!result.ok && result.message !== 'canceled') console.warn('[canvas-export] save failed:', result.message);
};
const copyToClipboard = async (kernel: Kernel, selectionOnly: boolean) => {
  const scope = exportSource(kernel).getExportScope();
  if (!scope) return;
  const composed = await composeExportPng(scope, selectionOnly);
  if (!composed) return;
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': composed.blob })]); } catch (error) { console.warn('[canvas-export] clipboard write failed:', error); }
};
const canvasExportCommands: readonly { id: string; value: CommandDefinition }[] = [
  { id: 'canvas.export-png', value: { title: bi('导出画布为 PNG', 'Export canvas as PNG'), description: bi('把画板上的全部卡片栅格化为 PNG 文件。', 'Rasterize all cards on the board into a PNG file.'), group: 'Export', keywords: ['导出', 'png', 'export', 'image', '图片'], shortcut: { key: 'e', mod: true, alt: true }, isEnabled: kernel => (exportSource(kernel).getExportScope()?.elements.length ?? 0) > 0, run: kernel => exportToPng(kernel, false) } },
  { id: 'canvas.export-selection-png', value: { title: bi('导出选区为 PNG', 'Export selection as PNG'), description: bi('把所选卡片栅格化为 PNG 文件。', 'Rasterize the selected cards into a PNG file.'), group: 'Export', keywords: ['导出', 'selection', '选区', 'png'], shortcut: { key: 'e', mod: true, alt: true, shift: true }, isEnabled: kernel => (exportSource(kernel).getExportScope()?.selectionIds.length ?? 0) > 0, run: kernel => exportToPng(kernel, true) } },
  { id: 'canvas.copy-image', value: { title: bi('复制画布图像到剪贴板', 'Copy canvas image to clipboard'), description: bi('把整块画板作为 PNG 图像复制到系统剪贴板。', 'Copy the whole board as a PNG image to the system clipboard.'), group: 'Export', keywords: ['复制', '剪贴板', 'clipboard', 'copy', '粘贴'], shortcut: { key: 'c', mod: true, alt: true }, isEnabled: kernel => (exportSource(kernel).getExportScope()?.elements.length ?? 0) > 0, run: kernel => copyToClipboard(kernel, false) } },
  { id: 'canvas.copy-selection-image', value: { title: bi('复制选区图像到剪贴板', 'Copy selection image to clipboard'), description: bi('把所选卡片作为 PNG 图像复制到系统剪贴板。', 'Copy the selected cards as a PNG image to the system clipboard.'), group: 'Export', keywords: ['复制', '选区', 'clipboard', 'selection'], shortcut: { key: 'c', mod: true, alt: true, shift: true }, isEnabled: kernel => (exportSource(kernel).getExportScope()?.selectionIds.length ?? 0) > 0, run: kernel => copyToClipboard(kernel, true) } },
];

// ==================== Exporters（原 exporters） ====================
const copyComposedAsFile = async (kernel: Kernel, selectionOnly: boolean, label: string) => {
  const scope = exportSource(kernel).getExportScope();
  if (!scope) return;
  const composed = await composeExportPng(scope, selectionOnly);
  if (!composed) return;
  const bytes = await composed.blob.arrayBuffer();
  const result = await hostPlatform(kernel).copyFileToClipboard({ name: `artflow-${label}-${timestampName()}.png`, bytes });
  if (!result.ok) console.warn('[exporters] copy file failed:', result.message);
};
const copyImageOriginalAsFile = async (kernel: Kernel, element: ImageElement) => {
  const url = element.originalHref || element.href;
  const fetched = await hostPlatform(kernel).fetchBytes(url);
  if (!fetched.ok || !fetched.bytes) { console.warn('[exporters] fetch original failed:', fetched.message); return; }
  const ext = imageFileExtension(element);
  const result = await hostPlatform(kernel).copyFileToClipboard({ name: `image-${element.id.slice(0, 8)}.${ext}`, bytes: fetched.bytes });
  if (!result.ok) console.warn('[exporters] copy file failed:', result.message);
};
const exportersCommands: readonly { id: string; value: CommandDefinition }[] = [
  { id: 'exporters.copy-canvas-file', value: { title: bi('复制画布为文件', 'Copy canvas as file'), description: bi('栅格化整块画板，把 PNG 文件放进剪贴板。', 'Rasterize the whole board and put the PNG file on the clipboard.'), group: 'Export', keywords: ['复制', '文件', 'file', 'clipboard', '导出'], isEnabled: kernel => (exportSource(kernel).getExportScope()?.elements.length ?? 0) > 0, run: kernel => copyComposedAsFile(kernel, false, 'canvas') } },
  { id: 'exporters.copy-selection-file', value: { title: bi('复制选区为文件', 'Copy selection as file'), description: bi('栅格化选区，把 PNG 文件放进剪贴板。', 'Rasterize the selection and put the PNG file on the clipboard.'), group: 'Export', keywords: ['复制', '选区', '文件', 'selection'], isEnabled: kernel => (exportSource(kernel).getExportScope()?.selectionIds.length ?? 0) > 0, run: kernel => copyComposedAsFile(kernel, true, 'selection') } },
];

export const toolsCanvasPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const disposers = [
      // Arrange
      ...arrangeCommands(ctx as unknown as ScopedPluginContext).map(({ id, value }) => ctx.contributions.register<CommandDefinition>('commands', { id, pluginId: manifest.id, priority: 20, value })),
      // Image
      ...imageCommands.map(({ id, value }) => ctx.contributions.register<CommandDefinition>('commands', { id, pluginId: manifest.id, priority: 20, value })),
      ...imageMenuItems.map(item => ctx.contributions.register<ContextMenuItem>('ui_menus', {
        id: `builtin.image-tools.${item.id}`, pluginId: manifest.id, priority: item.priority,
        value: { ...item.value, run: menuCtx => item.value.run(menuCtx, ctx) },
      })),
      // View
      ...viewCommands.map(({ id, value }) => ctx.contributions.register<CommandDefinition>('commands', { id, pluginId: manifest.id, priority: 20, value })),
      ctx.contributions.register('settings_sections', {
        id: 'builtin.view-tools.view', pluginId: manifest.id, priority: 45,
        value: { label: language => language === 'zho' ? '视图与网格' : 'View & Grid', component: ViewSettingsSection, navGroup: 'core' },
      }),
      // Window
      ...windowCommands.map(({ id, value }) => ctx.contributions.register<CommandDefinition>('commands', { id, pluginId: manifest.id, priority: 20, value })),
      // Canvas export
      ...canvasExportCommands.map(({ id, value }) => ctx.contributions.register<CommandDefinition>('commands', { id, pluginId: manifest.id, priority: 20, value })),
      // Exporters
      ...exportersCommands.map(({ id, value }) => ctx.contributions.register<CommandDefinition>('commands', { id, pluginId: manifest.id, priority: 20, value })),
      ...(() => {
        const buildMenuItems = (): readonly ContextMenuItem[] => [
          { label: language => (language === 'zho' ? '复制图片为文件（原画质）' : 'Copy image as file (original quality)'), group: 'clipboard', visible: menuCtx => menuCtx.element?.type === 'image', run: menuCtx => { void copyImageOriginalAsFile(ctx, menuCtx.element as ImageElement); } },
          { label: language => (language === 'zho' ? '复制选区为图片文件' : 'Copy selection as image file'), group: 'clipboard', visible: menuCtx => menuCtx.isMultiSelection && menuCtx.selectedElements.length > 0, run: () => { void copyComposedAsFile(ctx, true, 'selection'); } },
          { label: language => (language === 'zho' ? '复制画布为图片文件' : 'Copy canvas as image file'), group: 'clipboard', visible: menuCtx => menuCtx.element === null && !menuCtx.isMultiSelection, run: () => { void copyComposedAsFile(ctx, false, 'canvas'); } },
        ];
        return buildMenuItems().map((item, index) => ctx.contributions.register<ContextMenuItem>('ui_menus', { id: `builtin.exporters.file-${index}`, pluginId: manifest.id, priority: 55 - index, value: item }));
      })(),
    ];
    return () => {
      // 卸载时恢复窗口状态
      if (windowToolsState.clickThrough) void hostPlatform(ctx).setIgnoreMouseEvents(false);
      if (windowToolsState.opacity !== 1) void hostPlatform(ctx).setWindowOpacity(1);
      if (windowToolsState.alwaysOnTop) void hostPlatform(ctx).setAlwaysOnTop(false);
      for (const dispose of disposers.reverse()) dispose();
    };
  },
});
