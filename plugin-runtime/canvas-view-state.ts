/**
 * canvas-view-state.ts —— 画布视图状态服务（本体 → 插件的单向通道）。
 * 去色/暗化非选中/背景网格：状态归 App（渲染 + 持久化），插件经此只做切换。
 */

export const CANVAS_VIEW_STATE_SERVICE = 'canvas.view-state';

export interface CanvasViewStateService {
  toggleDesaturate(): void;
  isDesaturate(): boolean;
  toggleDimUnselected(): void;
  isDimUnselected(): boolean;
  toggleGrid(): void;
  isGridVisible(): boolean;
  toggleGridSnap(): void;
  isGridSnap(): boolean;
  adjustGridSize(delta: number): void;
  gridSize(): number;
}
