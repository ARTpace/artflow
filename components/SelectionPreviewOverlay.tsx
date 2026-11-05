/**
 * 框选/套索"将被选中"高亮的呈现层（P0-3）。
 *
 * 这条链路上没有一次 React 渲染：组件只在挂载时建一个空 <g>，之后按通道快照**增量**
 * 写 <rect> 属性。之所以可以这么写，是因为高亮是纯呈现 —— 不参与命中与布局
 * （pointer-events: none），也不被任何组件读回去。
 *
 * 复用节点而不是每帧重建：一次拖动会发几十份快照，节点增删会比"改几个属性"贵得多。
 */
import React, { useEffect, useRef } from 'react';
import {
  NO_SELECTION_PREVIEW,
  type SelectionPreviewItem,
  type SelectionPreviewMode,
  type SelectionPreviewStore,
} from '../utils/selection-preview-store';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 与 CanvasOverlays 的框选强调色保持一致：预览看起来就是"还没落地的选框结果"。 */
const ADD_STROKE = 'rgb(59, 130, 246)';
const ADD_FILL = 'rgba(59, 130, 246, 0.10)';
const SUBTRACT_STROKE = 'rgb(248, 113, 113)';
const SUBTRACT_FILL = 'rgba(248, 113, 113, 0.12)';
/** 屏幕像素下的描边宽度（世界单位靠 zoom 反算），比选框的 1px 略粗一点以示"结果"。 */
const STROKE_SCREEN_PX = 2;

interface PreviewEntry {
  node: SVGRectElement;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeWidth: number;
  tone: SelectionPreviewMode | '';
  hidden: boolean;
}

interface SelectionPreviewOverlayProps {
  store?: SelectionPreviewStore;
  /** 相机缩放：几何是世界坐标，只有描边宽度需要按缩放反算。 */
  zoom: number;
}

export const SelectionPreviewOverlay: React.FC<SelectionPreviewOverlayProps> = ({ store, zoom }) => {
  const layerRef = useRef<SVGGElement | null>(null);
  const poolRef = useRef<PreviewEntry[]>([]);
  const repaintRef = useRef<() => void>(() => {});

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const pool = poolRef.current;

    const paint = () => {
      const snapshot = store ? store.getSnapshot() : NO_SELECTION_PREVIEW;
      const { items, mode } = snapshot;
      const stroke = mode === 'subtract' ? SUBTRACT_STROKE : ADD_STROKE;
      const fill = mode === 'subtract' ? SUBTRACT_FILL : ADD_FILL;
      const strokeWidth = STROKE_SCREEN_PX / Math.max(zoomRef.current, 0.0001);

      for (let index = 0; index < items.length; index += 1) {
        const item: SelectionPreviewItem = items[index];
        let entry = pool[index];
        if (!entry) {
          const node = layer.ownerDocument.createElementNS(SVG_NS, 'rect');
          node.setAttribute('pointer-events', 'none');
          node.setAttribute('rx', '2');
          layer.appendChild(node);
          entry = {
            node,
            id: '',
            x: NaN,
            y: NaN,
            width: NaN,
            height: NaN,
            strokeWidth: NaN,
            tone: '',
            hidden: false,
          };
          pool[index] = entry;
        }
        if (entry.hidden) {
          entry.node.style.display = '';
          entry.hidden = false;
        }
        // 逐项比对后再写属性：DOM 写入本身不贵，但"没变也写"会让浏览器每次都快照样式。
        if (entry.id !== item.id) {
          entry.node.setAttribute('data-bp-selection-preview', item.id);
          entry.id = item.id;
        }
        if (entry.tone !== mode) {
          entry.node.setAttribute('fill', fill);
          entry.node.setAttribute('stroke', stroke);
          entry.tone = mode;
        }
        if (entry.strokeWidth !== strokeWidth) {
          entry.node.setAttribute('stroke-width', String(strokeWidth));
          entry.strokeWidth = strokeWidth;
        }
        if (entry.x !== item.x) {
          entry.node.setAttribute('x', String(item.x));
          entry.x = item.x;
        }
        if (entry.y !== item.y) {
          entry.node.setAttribute('y', String(item.y));
          entry.y = item.y;
        }
        if (entry.width !== item.width) {
          entry.node.setAttribute('width', String(item.width));
          entry.width = item.width;
        }
        if (entry.height !== item.height) {
          entry.node.setAttribute('height', String(item.height));
          entry.height = item.height;
        }
      }

      for (let index = items.length; index < pool.length; index += 1) {
        const entry = pool[index];
        if (entry.hidden) continue;
        entry.hidden = true;
        entry.node.style.display = 'none';
      }
    };

    repaintRef.current = paint;
    paint();
    const unsubscribe = store ? store.subscribe(paint) : undefined;

    return () => {
      unsubscribe?.();
      repaintRef.current = () => {};
      for (const entry of pool) entry.node.remove();
      pool.length = 0;
    };
  }, [store]);

  // 缩放变化只影响描边宽度（几何是世界坐标）：重算一次，不重建节点。
  // 首次挂载时上面的 effect 已经画过一次，这里重复一次是无副作用的幂等写入。
  useEffect(() => {
    repaintRef.current();
  }, [zoom]);

  return <g ref={layerRef} data-bp-selection-preview-layer="" pointerEvents="none" aria-hidden="true" />;
};
