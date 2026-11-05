/**
 * compose.ts —— 画布快照合成器：把元素烘焙进离屏 canvas（PNG）。
 * v1 覆盖：image（旋转/透明度）、shape、line/arrow、path、text、frame；其余卡类型画占位块。
 */

import type { Element, ImageElement, ShapeElement, TextElement, LineElement, ArrowElement, PathElement, FrameElement } from '../../types';
import { getElementBounds } from '../../utils/canvasUtils';
import type { CanvasExportScope } from '../../plugin-runtime/canvas-export-source';

const EXPORT_PADDING = 24;
const EXPORT_SCALE = 2;

const loadImage = (src: string): Promise<HTMLImageElement | null> =>
  new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });

const collectImageSrcs = (element: Element): string[] => {
  switch (element.type) {
    case 'image': return [element.href];
    case 'video':
    case 'audio':
      return element.href.startsWith('data:') ? [element.href] : [];
    default: return [];
  }
};

/** 元素包围盒并集（世界坐标）。 */
export const exportBounds = (elements: readonly Element[]): { x: number; y: number; width: number; height: number } | null => {
  if (elements.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const element of elements) {
    const bounds = getElementBounds(element, [...elements]);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const roundRectPath = (ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) => {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
};

const drawBoxElement = (ctx: CanvasRenderingContext2D, element: Element, image: HTMLImageElement | null) => {
  const record = element as unknown as { x: number; y: number; width: number; height: number; rotation?: number; name?: string };
  const hasRotation = typeof record.rotation === 'number' && record.rotation !== 0;
  ctx.save();
  if (hasRotation) {
    ctx.translate(record.x + record.width / 2, record.y + record.height / 2);
    ctx.rotate((record.rotation * Math.PI) / 180);
    ctx.translate(-(record.x + record.width / 2), -(record.y + record.height / 2));
  }
  if (image && record.width > 0 && record.height > 0) {
    ctx.drawImage(image, record.x, record.y, record.width, record.height);
  } else if (!image) {
    // 占位块：无像素可画的卡类型（音频/3D/书签等）。
    ctx.fillStyle = 'rgba(120, 120, 140, 0.25)';
    roundRectPath(ctx, record.x, record.y, record.width, record.height, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 160, 180, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (record.name || element.type) {
      ctx.fillStyle = 'rgba(220, 220, 235, 0.85)';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText(String(record.name ?? element.type), record.x + 10, record.y + 22);
    }
  }
  ctx.restore();
};

const drawShape = (ctx: CanvasRenderingContext2D, element: ShapeElement) => {
  ctx.save();
  ctx.fillStyle = element.fillColor;
  ctx.strokeStyle = element.strokeColor;
  ctx.lineWidth = element.strokeWidth;
  ctx.beginPath();
  if (element.shapeType === 'rectangle') {
    ctx.rect(element.x, element.y, element.width, element.height);
  } else if (element.shapeType === 'circle') {
    ctx.ellipse(element.x + element.width / 2, element.y + element.height / 2, element.width / 2, element.height / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(element.x + element.width / 2, element.y);
    ctx.lineTo(element.x + element.width, element.y + element.height);
    ctx.lineTo(element.x, element.y + element.height);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
};

const drawText = (ctx: CanvasRenderingContext2D, element: TextElement) => {
  ctx.save();
  ctx.fillStyle = element.fontColor;
  ctx.font = `${element.fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  element.text.split('\n').forEach((line, index) => {
    ctx.fillText(line, element.x, element.y + index * element.fontSize * 1.25);
  });
  ctx.restore();
};

const drawStrokeLine = (ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, color: string, width: number, arrowhead: boolean) => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  if (arrowhead) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(10, width * 3);
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }
  ctx.restore();
};

const drawElement = (ctx: CanvasRenderingContext2D, element: Element, images: Map<string, HTMLImageElement | null>) => {
  const opacity = (element as unknown as { opacity?: number }).opacity;
  ctx.save();
  if (typeof opacity === 'number') ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  switch (element.type) {
    case 'image':
      drawBoxElement(ctx, element, images.get((element as ImageElement).href) ?? null);
      break;
    case 'video':
    case 'audio':
      drawBoxElement(ctx, element, images.get(element.href) ?? null);
      break;
    case 'shape':
      drawShape(ctx, element);
      break;
    case 'text':
      drawText(ctx, element);
      break;
    case 'line':
    case 'arrow': {
      const line = element as LineElement | ArrowElement;
      drawStrokeLine(ctx, line.points[0], line.points[1], line.strokeColor, line.strokeWidth, element.type === 'arrow');
      break;
    }
    case 'path': {
      const path = element as PathElement;
      if (path.points.length > 1) {
        ctx.strokeStyle = path.strokeColor;
        ctx.lineWidth = path.strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(path.points[0].x, path.points[0].y);
        for (const point of path.points.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      break;
    }
    case 'frame': {
      const frame = element as FrameElement;
      ctx.save();
      if (frame.backgroundColor && frame.backgroundColor !== 'transparent') {
        ctx.fillStyle = frame.backgroundColor;
        ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
      ctx.restore();
      break;
    }
    default:
      drawBoxElement(ctx, element, null);
  }
  ctx.restore();
};

/** 合成导出 PNG。返回 null 表示无可导出内容。 */
export const composeExportPng = async (scope: CanvasExportScope, selectionOnly: boolean): Promise<{ blob: Blob; width: number; height: number } | null> => {
  const selection = new Set(scope.selectionIds);
  const included = selectionOnly
    ? scope.elements.filter(element => selection.has(element.id))
    : scope.elements;
  if (included.length === 0) return null;
  const bounds = exportBounds(included);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

  const pad = EXPORT_PADDING;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((bounds.width + pad * 2) * EXPORT_SCALE);
  canvas.height = Math.ceil((bounds.height + pad * 2) * EXPORT_SCALE);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
  ctx.translate(pad - bounds.x, pad - bounds.y);

  if (scope.background && !scope.background.startsWith('url(')) {
    ctx.fillStyle = scope.background;
    ctx.fillRect(bounds.x - pad, bounds.y - pad, bounds.width + pad * 2, bounds.height + pad * 2);
  }

  const srcs = new Set<string>();
  for (const element of included) for (const src of collectImageSrcs(element)) srcs.add(src);
  const images = new Map<string, HTMLImageElement | null>();
  await Promise.all([...srcs].map(async src => images.set(src, await loadImage(src))));

  const includedIds = new Set(included.map(element => element.id));
  for (const element of scope.elements) {
    if (!includedIds.has(element.id)) continue;
    drawElement(ctx, element, images);
  }
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return { blob, width: canvas.width, height: canvas.height };
};
