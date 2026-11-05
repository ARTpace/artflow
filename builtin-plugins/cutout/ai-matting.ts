/**
 * builtin/cutout/ai-matting.ts —— AI 抠图接入层（本机 ComfyUI / BiRefNet 家族）。
 *
 * 职责边界：
 * 1. 把工作分辨率的源图交给 ai_providers 槽里注册的 comfyui 抠图 provider，拿回带软边 alpha 的 PNG；
 * 2. 解出该 PNG 的 alpha 通道并缩放回工作分辨率，作为「软边基底」交给编辑器；
 * 3. 二进制化只服务于可视化与笔刷编辑，真实软边由 matting.composeAiAlpha 在合成时生效 ——
 *    所以 AI 结果与手动笔刷可以叠加，而不是互相覆盖。
 *
 * 降级路径：浏览器模式（无 preload 主进程桥）或 ComfyUI 离线时，provider 返回 ok:false，
 * 这里统一抛出可读错误，由编辑器置灰按钮并提示；纯本地算法路径不受任何影响。
 */

import type { Kernel } from '../../plugin-runtime/kernel';
import { invokeAIProvider, resolveAIProvider } from '../../plugin-runtime/ai-providers';
import { COMFY_PROVIDER_ID } from '../ai-providers';
import { DEFAULT_MATTING_MODEL, MATTING_MODELS } from '../ai-providers/comfy-client';

export { DEFAULT_MATTING_MODEL };
export const AI_MATTING_MODELS = MATTING_MODELS;
export const AI_MATTING_CAPABILITY = 'image-matting' as const;

/** provider 是否已注册且声明了抠图能力 —— 决定「AI 一键抠图」按钮是否可用。 */
export const isAiMattingAvailable = (kernel: Kernel): boolean => {
  const provider = resolveAIProvider(kernel, COMFY_PROVIDER_ID);
  return Boolean(provider && provider.value.capabilities.includes(AI_MATTING_CAPABILITY));
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解码 AI 返回的图像'));
    image.src = src;
  });

/** 取图像 alpha 通道并缩放到工作分辨率（AI 输出尺寸通常等于输入，仍兜底缩放）。 */
export const readAlphaChannel = async (dataUrl: string, width: number, height: number): Promise<Uint8Array> => {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法创建解码画布');
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = pixels[i * 4 + 3];
  return alpha;
};

export interface AiMattingOutcome {
  alpha: Uint8Array;
  metadata: Readonly<Record<string, unknown>>;
}

export const requestAiMatting = async (
  kernel: Kernel,
  sourceCanvas: HTMLCanvasElement,
  model: string,
  width: number,
  height: number,
): Promise<AiMattingOutcome> => {
  // 走 JPEG 传输：抠图对压缩伪影不敏感，但体积比 PNG 小数倍 ——
  // 这份 base64 要整体过 IPC，还会内联进 ComfyUI 工作流，体积直接决定往返耗时。
  const sourceDataUrl = sourceCanvas.toDataURL('image/jpeg', 0.95);
  const response = await invokeAIProvider(kernel, COMFY_PROVIDER_ID, {
    prompt: 'matting',
    referenceImages: [sourceDataUrl],
    parameters: { op: 'matting', model },
  });
  if (!response.ok) throw new Error(response.error ?? 'AI 抠图失败');
  const artifact = response.artifacts.find(item => item.kind === 'image' && item.dataUrl);
  if (!artifact || !artifact.dataUrl) throw new Error('AI 抠图没有返回图像');
  const alpha = await readAlphaChannel(artifact.dataUrl, width, height);
  return { alpha, metadata: artifact.metadata ?? {} };
};
