
import { Point, Element, ImageElement, VideoElement, FrameElement, PathElement, Board, Rect, ImageAspectRatio } from '../types';
import React from 'react';
import { DEFAULT_CANVAS_BACKGROUND } from '../plugin-runtime/ui-theme-settings';

export const generateId = () => `id_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const rotatePoint = (point: Point, center: Point, angleDegrees: number): Point => {
    const angleRad = (angleDegrees * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const translatedX = point.x - center.x;
    const translatedY = point.y - center.y;
    const rotatedX = translatedX * cos - translatedY * sin;
    const rotatedY = translatedX * sin + translatedY * cos;
    return { x: rotatedX + center.x, y: rotatedY + center.y };
};

/**
 * 画布屏幕坐标盒（屏幕坐标 ↔ 世界坐标换算的统一基准）。
 *
 * 相机 transform 挂在 <svg> 元素自身上（GPU 合成优化，见 ADR-049），
 * 因此 <svg> 的 getBoundingClientRect() 返回的是**变换后**的盒子，
 * 位置/尺寸随 pan/zoom 漂移。所有坐标换算必须改用外层容器
 * （未变换，其盒子与 <svg> 未变换时的盒子重合）作基准，
 * 否则相机一动，换算出的世界坐标就跟着偏。
 */
export const getCanvasScreenRect = (svg: SVGSVGElement | null | undefined): DOMRect | null => {
    const container = svg?.parentElement as HTMLElement | null;
    return container ? container.getBoundingClientRect() : null;
};

/** Rectangular cards, including ones registered by plugins. Path, arrow and line are not boxes. */
export const isBoxElement = (element: { type: string; x?: unknown; y?: unknown; width?: unknown; height?: unknown }): element is { type: string; x: number; y: number; width: number; height: number } => {
    if (element.type === 'path' || element.type === 'arrow' || element.type === 'line') return false;
    return typeof element.x === 'number' && typeof element.y === 'number'
        && typeof element.width === 'number' && typeof element.height === 'number';
};

export const getElementBounds = (element: Element, allElements: Element[] = []): { x: number; y: number; width: number; height: number } => {
    if (!element) return { x: 0, y: 0, width: 0, height: 0 };
    if (element.type === 'group') {
        const children = (allElements || []).filter(el => el && el.parentId === element.id);
        if (children.length === 0) {
            return { x: element.x, y: element.y, width: element.width, height: element.height };
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        children.forEach(child => {
            const bounds = getElementBounds(child, allElements);
            minX = Math.min(minX, bounds.x);
            minY = Math.min(minY, bounds.y);
            maxX = Math.max(maxX, bounds.x + bounds.width);
            maxY = Math.max(maxY, bounds.y + bounds.height);
        });
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    if (isBoxElement(element)) {
        return { x: element.x, y: element.y, width: element.width, height: element.height };
    }
    if (element.type === 'arrow' || element.type === 'line') {
        const { points } = element;
        if (!points || points.length < 2) return { x: element.x || 0, y: element.y || 0, width: 10, height: 10 };
        const minX = Math.min(points[0].x, points[1].x);
        const maxX = Math.max(points[0].x, points[1].x);
        const minY = Math.min(points[0].y, points[1].y);
        const maxY = Math.max(points[0].y, points[1].y);
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    if (element.type === 'path') {
        const { points } = element;
        if (!points || points.length === 0) return { x: element.x || 0, y: element.y || 0, width: 0, height: 0 };
        let minX = points[0].x, maxX = points[0].x;
        let minY = points[0].y, maxY = points[0].y;
        for (const p of points) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    return { x: (element as any).x || 0, y: (element as any).y || 0, width: (element as any).width || 0, height: (element as any).height || 0 };
};

export const isElementInViewport = (element: Element, elements: Element[], viewport: Rect): boolean => {
    const bounds = getElementBounds(element, elements);
    // 稍微增加一点 padding，防止边缘闪烁
    const padding = 50;
    return !(
        bounds.x + bounds.width < viewport.x - padding ||
        bounds.x > viewport.x + viewport.width + padding ||
        bounds.y + bounds.height < viewport.y - padding ||
        bounds.y > viewport.y + viewport.height + padding
    );
};

export const isPointInPolygon = (point: Point, polygon: Point[]): boolean => {
    let isInside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersect = ((yi > point.y) !== (yj > point.y)) &&
            (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
        if (intersect) isInside = !isInside;
    }
    return isInside;
};

export const rasterizeElement = (element: Exclude<Element, ImageElement | VideoElement | FrameElement>): Promise<{ href: string; mimeType: 'image/png' }> => {
    return new Promise((resolve, reject) => {
        const bounds = getElementBounds(element);
        if (bounds.width <= 0 || bounds.height <= 0) {
            return reject(new Error('Cannot rasterize an element with zero or negative dimensions.'));
        }

        const padding = 10;
        const svgWidth = bounds.width + padding * 2;
        const svgHeight = bounds.height + padding * 2;
        
        const offsetX = -bounds.x + padding;
        const offsetY = -bounds.y + padding;

        let elementSvgString = '';
        
        switch (element.type) {
            case 'path': {
                const pointsWithOffset = element.points.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }));
                const pathData = pointsWithOffset.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
                elementSvgString = `<path d="${pathData}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${element.opacity || 1}" />`;
                break;
            }
            case 'shape': {
                const shapeProps = `transform="translate(${element.x + offsetX}, ${element.y + offsetY})" fill="${element.fillColor}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" opacity="${element.opacity || 1}"`;
                if (element.shapeType === 'rectangle') elementSvgString = `<rect width="${element.width}" height="${element.height}" rx="${element.borderRadius || 0}" ry="${element.borderRadius || 0}" ${shapeProps} />`;
                else if (element.shapeType === 'circle') elementSvgString = `<ellipse cx="${element.width/2}" cy="${element.height/2}" rx="${element.width/2}" ry="${element.height/2}" ${shapeProps} />`;
                else if (element.shapeType === 'triangle') elementSvgString = `<polygon points="${element.width/2},0 0,${element.height} ${element.width},${element.height}" ${shapeProps} />`;
                break;
            }
            case 'arrow': {
                 const [start, end] = element.points;
                 const angle = Math.atan2(end.y - start.y, end.x - start.x);
                 const headLength = element.strokeWidth * 4;

                 const arrowHeadHeight = headLength * Math.cos(Math.PI / 6);
                 const lineEnd = {
                     x: end.x - arrowHeadHeight * Math.cos(angle),
                     y: end.y - arrowHeadHeight * Math.sin(angle),
                 };

                 const headPoint1 = { x: end.x - headLength * Math.cos(angle - Math.PI / 6), y: end.y - headLength * Math.sin(angle - Math.PI / 6) };
                 const headPoint2 = { x: end.x - headLength * Math.cos(angle + Math.PI / 6), y: end.y - headLength * Math.sin(angle + Math.PI / 6) };
                 elementSvgString = `
                    <line x1="${start.x + offsetX}" y1="${start.y + offsetY}" x2="${lineEnd.x + offsetX}" y2="${lineEnd.y + offsetY}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" stroke-linecap="round" />
                    <polygon points="${end.x + offsetX},${end.y + offsetY} ${headPoint1.x + offsetX},${headPoint1.y + offsetY} ${headPoint2.x + offsetX},${headPoint2.y + offsetY}" fill="${element.strokeColor}" />
                 `;
                break;
            }
            case 'line': {
                 const [start, end] = element.points;
                 elementSvgString = `<line x1="${start.x + offsetX}" y1="${start.y + offsetY}" x2="${end.x + offsetX}" y2="${end.y + offsetY}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" stroke-linecap="round" />`;
                break;
            }
            case 'text': {
                 elementSvgString = `
                    <foreignObject x="${offsetX}" y="${offsetY}" width="${element.width}" height="${element.height}">
                        <div xmlns="http://www.w3.org/1999/xhtml" style="font-size: ${element.fontSize}px; color: ${element.fontColor}; width: 100%; height: 100%; word-break: break-word; font-family: sans-serif; padding:0; margin:0; line-height: 1.2;">
                            ${element.text.replace(/\n/g, '<br />')}
                        </div>
                    </foreignObject>
                 `;
                 // Note: Text is rasterized from its top-left corner (x,y), not the bounds' corner
                 elementSvgString = elementSvgString.replace(`x="${offsetX}"`, `x="${element.x + offsetX}"`).replace(`y="${offsetY}"`, `y="${element.y + offsetY}"`);
                break;
            }
            case 'group': {
                elementSvgString = '';
                break;
            }
        }

        const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">${elementSvgString}</svg>`;
        
        const img = new Image();
        img.crossOrigin = "anonymous";
        const svgDataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(fullSvg)))}`;

        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = svgWidth;
            canvas.height = svgHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.drawImage(img, 0, 0);
                resolve({ href: canvas.toDataURL('image/png'), mimeType: 'image/png' });
            } else {
                reject(new Error('Could not get canvas context.'));
            }
        };
        img.onerror = (err) => {
            reject(new Error(`Failed to load SVG into image: ${err}`));
        };
        img.src = svgDataUrl;
    });
};

export const rasterizeElements = (elementsToRasterize: Exclude<Element, ImageElement | VideoElement | FrameElement>[]): Promise<{ href: string; mimeType: 'image/png', width: number, height: number }> => {
    return new Promise((resolve, reject) => {
        if (elementsToRasterize.length === 0) {
            return reject(new Error("No elements to rasterize."));
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        elementsToRasterize.forEach(element => {
            const bounds = getElementBounds(element);
            minX = Math.min(minX, bounds.x);
            minY = Math.min(minY, bounds.y);
            maxX = Math.max(maxX, bounds.x + bounds.width);
            maxY = Math.max(maxY, bounds.y + bounds.height);
        });

        const combinedWidth = maxX - minX;
        const combinedHeight = maxY - minY;

        if (combinedWidth <= 0 || combinedHeight <= 0) {
            return reject(new Error('Cannot rasterize elements with zero or negative dimensions.'));
        }

        const padding = 10;
        const svgWidth = combinedWidth + padding * 2;
        const svgHeight = combinedHeight + padding * 2;
        
        const elementSvgStrings = elementsToRasterize.map(element => {
            const offsetX = -minX + padding;
            const offsetY = -minY + padding;

            let elementSvgString = '';
            switch (element.type) {
                 case 'path': {
                    const pointsWithOffset = element.points.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }));
                    const pathData = pointsWithOffset.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
                    elementSvgString = `<path d="${pathData}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${element.opacity || 1}" />`;
                    break;
                 }
                case 'shape': {
                    const shapeProps = `transform="translate(${element.x + offsetX}, ${element.y + offsetY})" fill="${element.fillColor}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" opacity="${element.opacity || 1}"`;
                    if (element.shapeType === 'rectangle') elementSvgString = `<rect width="${element.width}" height="${element.height}" rx="${element.borderRadius || 0}" ry="${element.borderRadius || 0}" ${shapeProps} />`;
                    else if (element.shapeType === 'circle') elementSvgString = `<ellipse cx="${element.width/2}" cy="${element.height/2}" rx="${element.width/2}" ry="${element.height/2}" ${shapeProps} />`;
                    else if (element.shapeType === 'triangle') elementSvgString = `<polygon points="${element.width/2},0 0,${element.height} ${element.width},${element.height}" ${shapeProps} />`;
                    break;
                }
                case 'arrow': {
                     const [start, end] = element.points;
                     const angle = Math.atan2(end.y - start.y, end.x - start.x);
                     const headLength = element.strokeWidth * 4;

                     const arrowHeadHeight = headLength * Math.cos(Math.PI / 6);
                     const lineEnd = {
                        x: end.x - arrowHeadHeight * Math.cos(angle),
                        y: end.y - arrowHeadHeight * Math.sin(angle),
                     };

                     const headPoint1 = { x: end.x - headLength * Math.cos(angle - Math.PI / 6), y: end.y - headLength * Math.sin(angle - Math.PI / 6) };
                     const headPoint2 = { x: end.x - headLength * Math.cos(angle + Math.PI / 6), y: end.y - headLength * Math.sin(angle + Math.PI / 6) };
                     elementSvgString = `
                        <line x1="${start.x + offsetX}" y1="${start.y + offsetY}" x2="${lineEnd.x + offsetX}" y2="${lineEnd.y + offsetY}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" stroke-linecap="round" />
                        <polygon points="${end.x + offsetX},${end.y + offsetY} ${headPoint1.x + offsetX},${headPoint1.y + offsetY} ${headPoint2.x + offsetX},${headPoint2.y + offsetY}" fill="${element.strokeColor}" />
                     `;
                    break;
                }
                 case 'line': {
                     const [start, end] = element.points;
                     elementSvgString = `<line x1="${start.x + offsetX}" y1="${start.y + offsetY}" x2="${end.x + offsetX}" y2="${end.y + offsetY}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" stroke-linecap="round" />`;
                    break;
                 }
                case 'text': {
                     elementSvgString = `
                        <foreignObject x="${element.x + offsetX}" y="${element.y + offsetY}" width="${element.width}" height="${element.height}">
                            <div xmlns="http://www.w3.org/1999/xhtml" style="font-size: ${element.fontSize}px; color: ${element.fontColor}; width: 100%; height: 100%; word-break: break-word; font-family: sans-serif; padding:0; margin:0; line-height: 1.2;">
                                ${element.text.replace(/\n/g, '<br />')}
                            </div>
                        </foreignObject>
                     `;
                    break;
                }
                case 'group': {
                    elementSvgString = '';
                    break;
                }
            }
            return elementSvgString;
        }).join('');

        const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">${elementSvgStrings}</svg>`;
        
        const img = new Image();
        img.crossOrigin = "anonymous";
        const svgDataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(fullSvg)))}`;

        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = svgWidth;
            canvas.height = svgHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.drawImage(img, 0, 0);
                resolve({ 
                    href: canvas.toDataURL('image/png'), 
                    mimeType: 'image/png',
                    width: svgWidth,
                    height: svgHeight
                });
            } else {
                reject(new Error('Could not get canvas context.'));
            }
        };
        img.onerror = (err) => {
            reject(new Error(`Failed to load SVG into image: ${err}`));
        };
        img.src = svgDataUrl;
    });
};

export const rasterizeMask = (
    maskPaths: PathElement[],
    baseImage: ImageElement
): Promise<{ href: string; mimeType: 'image/png' }> => {
    return new Promise((resolve, reject) => {
        const { width, height, x: imageX, y: imageY } = baseImage;
        if (width <= 0 || height <= 0) {
            return reject(new Error('Base image has invalid dimensions.'));
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return reject(new Error('Could not get canvas context for mask.'));
        }

        // Black background for areas to be kept
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, width, height);

        // White for areas to be inpainted
        ctx.strokeStyle = 'white';
        ctx.fillStyle = 'white';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        maskPaths.forEach(path => {
            ctx.lineWidth = path.strokeWidth;
            ctx.beginPath();
            
            if (path.points.length === 1) {
                const point = path.points[0];
                ctx.arc(point.x - imageX, point.y - imageY, path.strokeWidth / 2, 0, 2 * Math.PI);
                ctx.fill();
            } else if (path.points.length > 1) {
                const startPoint = path.points[0];
                ctx.moveTo(startPoint.x - imageX, startPoint.y - imageY);
                for (let i = 1; i < path.points.length; i++) {
                    const point = path.points[i];
                    ctx.lineTo(point.x - imageX, point.y - imageY);
                }
                ctx.stroke();
            }
        });

        resolve({ href: canvas.toDataURL('image/png'), mimeType: 'image/png' });
    });
};

export const createNewBoard = (name: string): Board => {
    const id = generateId();
    return {
        id,
        name,
        elements: [],
        operationHistory: [],
        operationHistoryIndex: -1,
        panOffset: { x: 0, y: 0 },
        zoom: 1,
        viewBookmarks: [],
        canvasBackgroundColor: DEFAULT_CANVAS_BACKGROUND,
    };
};

export const getSelectableElement = (elementId: string, allElements: Element[]): Element | null => {
    const element = allElements.find(el => el.id === elementId);
    if (!element) return null;
    if (element.isLocked) return null;

    let current = element;
    while (current.parentId) {
        const parent = allElements.find(el => el.id === current.parentId);
        if (!parent) return current; // Orphaned, treat as top-level
        if (parent.isLocked) return null; // Parent is locked, nothing inside is selectable
        if (parent.type === 'frame') break; // Can select items inside a frame
        current = parent;
    }
    return current;
};

export const getDescendants = (elementId: string, allElements: Element[]): Element[] => {
    const descendants: Element[] = [];
    const children = allElements.filter(el => el.parentId === elementId);
    for (const child of children) {
        descendants.push(child);
        if (child.type === 'group' || child.type === 'frame') {
            descendants.push(...getDescendants(child.id, allElements));
        }
    }
    return descendants;
};

export const isHotkeyMatch = (e: KeyboardEvent | React.KeyboardEvent, hotkey: { key: string; metaOrCtrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean => {
    if (!hotkey || !hotkey.key) return false;
    
    let eventKey = e.key;
    if (eventKey === ' ') eventKey = 'Space';

    let hotkeyKey = hotkey.key;
    if (hotkeyKey === ' ') hotkeyKey = 'Space';

    return eventKey.toLowerCase() === hotkeyKey.toLowerCase() &&
        (e.metaKey || e.ctrlKey) === hotkey.metaOrCtrlKey &&
        e.shiftKey === hotkey.shiftKey &&
        e.altKey === hotkey.altKey;
};

export const getFlattenedSelection = (selectionIds: string[], allElements: Element[]): Element[] => {
    const flattened: Element[] = [];
    const selectionSet = new Set(selectionIds);
    
    allElements.forEach(el => {
        if (selectionSet.has(el.id)) {
            flattened.push(el);
            if (el.type === 'group' || el.type === 'frame') {
                flattened.push(...getDescendants(el.id, allElements));
            }
        }
    });
    
    return Array.from(new Set(flattened)); // Remove duplicates
};

export const isElementVisible = (element: Element, viewportBounds: { x: number; y: number; width: number; height: number }, allElements: Element[]): boolean => {
    const bounds = getElementBounds(element, allElements);
    return !(
        bounds.x + bounds.width < viewportBounds.x ||
        bounds.x > viewportBounds.x + viewportBounds.width ||
        bounds.y + bounds.height < viewportBounds.y ||
        bounds.y > viewportBounds.y + viewportBounds.height
    );
};

// Immutable document arrays make unchanged-board previews reusable without retaining old boards.
const boardThumbnailCache = new WeakMap<Element[], { bgColor: string; thumbnail: string }>();

export const generateBoardThumbnail = (elements: Element[], bgColor: string): string => {
    const cached = elements && boardThumbnailCache.get(elements);
    if (cached?.bgColor === bgColor) return cached.thumbnail;
    const thumbnail = renderBoardThumbnail(elements, bgColor);
    if (elements) boardThumbnailCache.set(elements, { bgColor, thumbnail });
    return thumbnail;
};

const renderBoardThumbnail = (elements: Element[], bgColor: string): string => {
    const THUMB_WIDTH = 120;
    const THUMB_HEIGHT = 80;

   if (!elements || elements.length === 0) {
       const emptySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}"><rect width="100%" height="100%" fill="${bgColor}" /></svg>`;
       return `data:image/svg+xml;base64,${btoa(emptySvg)}`;
   }
   
   let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
   elements.forEach(el => {
       if (!el) return;
       const bounds = getElementBounds(el, elements);
       minX = Math.min(minX, bounds.x);
       minY = Math.min(minY, bounds.y);
       maxX = Math.max(maxX, bounds.x + bounds.width);
       maxY = Math.max(maxY, bounds.y + bounds.height);
   });

   const contentWidth = maxX - minX;
   const contentHeight = maxY - minY;

   if (contentWidth <= 0 || contentHeight <= 0 || !isFinite(contentWidth) || !isFinite(contentHeight)) {
       const emptySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}"><rect width="100%" height="100%" fill="${bgColor}" /></svg>`;
       return `data:image/svg+xml;base64,${btoa(emptySvg)}`;
   }

   const scale = Math.min(THUMB_WIDTH / contentWidth, THUMB_HEIGHT / contentHeight) * 0.9;
   const dx = (THUMB_WIDTH - contentWidth * scale) / 2 - minX * scale;
   const dy = (THUMB_HEIGHT - contentHeight * scale) / 2 - minY * scale;

   const svgContent = elements.map(el => {
        if (!el) return '';
        if (el.type === 'path' && (el as PathElement).points) {
           const pathData = (el as PathElement).points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
           return `<path d="${pathData}" stroke="${el.strokeColor}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${el.opacity || 1}" />`;
        }
        if (el.type === 'image') {
            return `<image href="${el.thumbnailHref || el.mediumHref || el.href}" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" opacity="${el.opacity ?? 1}"/>`;
        }
        return '';
   }).join('');

   const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}"><rect width="100%" height="100%" fill="${bgColor}" /><g transform="translate(${dx} ${dy}) scale(${scale})">${svgContent}</g></svg>`;
   return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(fullSvg)))}`;
};

/**
 * id → 元素 的索引缓存（按 allElements 引用）。
 * 只有 1 槽：元素一变就重建，避免持有过期几何。
 */
let elementIndexCache: { allElements: Element[]; byId: Map<string, Element> } | null = null;

const getElementIndex = (allElements: Element[]): Map<string, Element> => {
    if (elementIndexCache && elementIndexCache.allElements === allElements) return elementIndexCache.byId;
    const byId = new Map<string, Element>();
    for (const el of allElements) {
        if (el && el.id !== undefined) byId.set(el.id, el);
    }
    elementIndexCache = { allElements, byId };
    return byId;
};

/**
 * 选区边界。
 *
 * 旧口径是"每个选中 id 做一次 allElements.find" —— O(选中数 × 全量数)：
 * 导入即全选 5000 张时是 12,502,500 次比较（实测约 40ms 一次），
 * 而它在渲染路径上有 10 个调用点（SelectionHandles / ToolbarOverlay /
 * useSmartToolbar / 拖动帧 …），相机一更新就要重复付。
 *
 * 现在：id → 元素 走一次 Map（O(全量 + 选中)），再按引用缓存整次结果。
 * 缓存前提与 viewportIndexCache 一致：元素几何改动都会产生新的数组/对象引用，
 * 因此 (allElements, selectedElementsOrIds) 两个引用都没变时结果必然相同。
 *
 * 返回的 Rect 视为只读（命中缓存时会复用同一个对象）。
 */
const selectionBoundsCache: {
    allElements: Element[] | null;
    selection: readonly (Element | string)[] | null;
    bounds: Rect;
} = { allElements: null, selection: null, bounds: { x: 0, y: 0, width: 0, height: 0 } };

export const getSelectionBounds = (selectedElementsOrIds: (Element | string)[], allElements: Element[]): Rect => {
    if (
        selectionBoundsCache.allElements === allElements
        && selectionBoundsCache.selection === selectedElementsOrIds
    ) {
        return selectionBoundsCache.bounds;
    }

    const byId = selectedElementsOrIds.some(item => typeof item === 'string')
        ? getElementIndex(allElements)
        : null;
    const selectedElements: Element[] = [];
    for (const item of selectedElementsOrIds) {
        if (typeof item === 'string') {
            const found = byId!.get(item);
            if (found) selectedElements.push(found);
        } else if (item) {
            selectedElements.push(item);
        }
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    selectedElements.forEach(el => {
        const unrotatedBounds = getElementBounds(el, allElements);
        if(unrotatedBounds.width === 0 && unrotatedBounds.height === 0) return;

        const center = { x: unrotatedBounds.x + unrotatedBounds.width / 2, y: unrotatedBounds.y + unrotatedBounds.height / 2 };
        const rotation = ('rotation' in el && el.rotation) ? el.rotation : 0;
        
        const corners: Point[] = [
            { x: unrotatedBounds.x, y: unrotatedBounds.y },
            { x: unrotatedBounds.x + unrotatedBounds.width, y: unrotatedBounds.y },
            { x: unrotatedBounds.x + unrotatedBounds.width, y: unrotatedBounds.y + unrotatedBounds.height },
            { x: unrotatedBounds.x, y: unrotatedBounds.y + unrotatedBounds.height },
        ];

        corners.forEach(corner => {
            const rotated = rotatePoint(corner, center, rotation);
            minX = Math.min(minX, rotated.x);
            minY = Math.min(minY, rotated.y);
            maxX = Math.max(maxX, rotated.x);
            maxY = Math.max(maxY, rotated.y);
        });
    });

    const bounds: Rect = minX === Infinity
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

    selectionBoundsCache.allElements = allElements;
    selectionBoundsCache.selection = selectedElementsOrIds;
    selectionBoundsCache.bounds = bounds;
    return bounds;
};

export const getClosestAspectRatio = (width: number, height: number): ImageAspectRatio => {
    const ratio = width / height;
    const ratios: { r: number, s: ImageAspectRatio }[] = [
        { r: 1, s: '1:1' },
        { r: 16/9, s: '16:9' },
        { r: 9/16, s: '9:16' },
        { r: 4/3, s: '4:3' },
        { r: 3/4, s: '3:4' },
    ];
    return ratios.reduce((prev, curr) => 
        Math.abs(curr.r - ratio) < Math.abs(prev.r - ratio) ? curr : prev
    ).s;
};
