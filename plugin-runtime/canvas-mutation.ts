/**
 * canvas-mutation.ts —— 元素批量修改服务（本体 → 插件的单向通道）。
 * 排列命令/图像工具经此改元素：走 App 的 setElements(committed) 管道，撤销历史自动入账。
 */

import type { Element } from '../types';

export const CANVAS_MUTATION_SERVICE = 'canvas.mutation';

export interface ElementPatch {
  id: string;
  patch: Record<string, unknown>;
}

export interface CanvasMutationService {
  /** 批量按 id 合并 patch；未命中的 id 忽略。committed：入撤销历史。 */
  /**
   * `history: 'skip'` writes the element but does not open an undo step.
   * Used for reading position and font size.
   */
  patchElements(patches: readonly ElementPatch[], options?: { committed?: boolean; history?: 'record' | 'skip' }): boolean;
  /** 当前活动板元素快照（只读）。 */
  getElements(): readonly Element[];
}
