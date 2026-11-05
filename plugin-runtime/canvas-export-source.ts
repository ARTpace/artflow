/**
 * canvas-export-source.ts —— 画布导出快照服务（本体 → 插件的单向通道）。
 * 导出插件据此合成 PNG：拿活动板元素+背景+选区，不反向依赖 App 组件。
 */

import type { Element } from '../types';

export const CANVAS_EXPORT_SOURCE_SERVICE = 'canvas.export-source';

export interface CanvasExportScope {
  elements: readonly Element[];
  background: string | null;
  selectionIds: readonly string[];
}

export interface CanvasExportSource {
  /** 当前无活动板时返回 null。快照为只读；合成器不得修改元素。 */
  getExportScope(): CanvasExportScope | null;
}
