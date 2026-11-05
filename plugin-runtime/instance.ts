/**
 * instance.ts —— 内核单例存取。
 * index.tsx 启动时 setKernel(kernel)；运行期任意模块（如 CanvasElement 的卡片注册表查询）
 * 通过 getKernel() 取用。未启动即访问视为架构错误。
 */

import type { Kernel } from './kernel';

let current: Kernel | null = null;

export function setKernel(kernel: Kernel): void {
  current = kernel;
}

export function getKernel(): Kernel {
  if (!current) throw new Error('[kernel] not bootstrapped: call setKernel() in app entry first');
  return current;
}

/** 容错版：内核未启动时返回 null（用于非关键路径）。 */
export function tryKernel(): Kernel | null {
  return current;
}
