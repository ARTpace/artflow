/**
 * nativeDragOut.ts —— Alt+拖拽图片元素 → 原生拖出（PureRef 对齐：把图直接拖进 PS/资源管理器/聊天窗口）。
 * 原理：Alt 按下时在光标下放一个可拖拽的透明 img，Chromium 会把进行中的拖拽"收养"为原生拖动；
 * dragstart 时写入 DownloadURL，落地即可保存原画质文件。
 * 交互热路径上只做一次 altKey 判断，未命中零开销。
 */

import type { Element, ImageElement } from '../types';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

export const imageFileExtension = (element: ImageElement): string => {
  const fromMime = EXT_BY_MIME[element.mimeType?.toLowerCase() ?? ''];
  if (fromMime) return fromMime;
  const href = element.originalHref ?? element.href;
  const match = /\.(png|jpe?g|webp|gif|svg|bmp|avif)(?:[?#]|$)/i.exec(href);
  return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
};

/** 判定该 mousedown 是否可发起拖出（只查，不动 DOM）。 */
export const findDragOutImage = (elementIdsAtTarget: string | null, elements: readonly Element[]): ImageElement | null => {
  if (!elementIdsAtTarget) return null;
  const element = elements.find(candidate => candidate.id === elementIdsAtTarget);
  return element && element.type === 'image' ? element : null;
};

/**
 * 发起原生拖出。返回 true = 已接管（调用方应阻止画布交互继续）。
 * @param url 使用 originalHref（原画质）；托管资产协议为 privileged scheme，DownloadURL 可取。
 */
export const beginNativeDragOut = (element: ImageElement, clientX: number, clientY: number): boolean => {
  const url = element.originalHref || element.href;
  const fetchable = !!url && (url.startsWith('blob:') || url.startsWith('data:') || url.includes('://'));
  if (!fetchable) return false;
  const ghost = document.createElement('img');
  ghost.src = element.href; // 视觉源：用显示版本，加载快
  ghost.style.cssText = `position:fixed;left:${clientX - 12}px;top:${clientY - 12}px;width:24px;height:24px;opacity:0;pointer-events:auto;z-index:2147483647;`;
  ghost.draggable = true;
  ghost.addEventListener('dragstart', dragEvent => {
    if (!dragEvent.dataTransfer) return;
    const name = `image-${element.id.slice(0, 8)}.${imageFileExtension(element)}`;
    dragEvent.dataTransfer.setData('DownloadURL', `image/png:${name}:${url}`);
    dragEvent.dataTransfer.setData('text/uri-list', url);
    dragEvent.dataTransfer.setData('text/plain', url);
    dragEvent.dataTransfer.effectAllowed = 'copy';
  });
  document.body.appendChild(ghost);
  const cleanup = () => {
    ghost.remove();
    window.removeEventListener('dragend', cleanup, true);
    window.removeEventListener('mouseup', cleanup, true);
  };
  window.addEventListener('dragend', cleanup, true);
  window.addEventListener('mouseup', cleanup, true);
  return true;
};
