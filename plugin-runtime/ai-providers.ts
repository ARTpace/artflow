/**
 * Typed contract and pure dispatch for the `ai_providers` contribution slot (REQ-004 / R37).
 * Outbound AI generation slot for cloud and local models (Gemini, ComfyUI, etc.).
 */

import type { Contribution, Kernel } from './kernel';
import { resolveLocalizedText, type LocalizedText, type UiLanguage } from './i18n';

export type AIProviderCapability =
  | 'text-to-image'
  | 'image-to-image'
  | 'inpainting'
  | 'prompt-enhancement'
  | 'text-generation'
  /** 文生视频 / 图生视频：产物是 mp4（Veo 等）。 */
  | 'video'
  /** 抠图/去背景：图进图出，产物是带软边 alpha 的 PNG（REQ-004 通道二扩展）。 */
  | 'image-matting';

export interface AIProviderRequest {
  prompt: string;
  negativePrompt?: string;
  referenceImages?: readonly string[]; // Data URLs or artflow-asset:// references
  /** 生成参数：`op` 选择操作（见 AI_GENERATION_OP），其余键随操作而定（aspectRatio / numberOfImages / mask …）。 */
  parameters?: Readonly<Record<string, unknown>>;
  /** 长任务（尤其视频）的进度回传；消息已本地化，直接展示即可。 */
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * `parameters.op` 的取值约定：让同一个云端 provider 用一次 run 分派多种操作。
 * 不传时按 referenceImages 有无推断（无图→文生图，有图→图生图），保证 MCP 工具面
 * 只带 prompt 的最简调用仍可用。
 */
export type AiGenerationOp =
  | 'text-to-image'
  | 'image-to-image'
  | 'inpainting'
  | 'prompt-enhancement'
  | 'video';

export const AI_GENERATION_OP = 'op';

export interface AIProviderArtifact {
  kind: 'image' | 'text' | 'video';
  dataUrl?: string;
  content?: string;
  mimeType: string;
  width?: number;
  height?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AIProviderResponse {
  ok: boolean;
  artifacts: readonly AIProviderArtifact[];
  durationMs?: number;
  error?: string;
}

export interface AIProviderDefinition {
  /** 展示文案：字符串（各语言同文案）或按语言的解析函数。 */
  title: LocalizedText;
  description?: LocalizedText;
  providerType: 'local' | 'cloud';
  capabilities: readonly AIProviderCapability[];
  run: (request: AIProviderRequest, kernel: Kernel) => Promise<AIProviderResponse>;
  checkHealth?: () => Promise<{ available: boolean; latencyMs?: number; message?: string }>;
}

export type AIProviderContribution = Contribution<AIProviderDefinition>;

export function listAIProviderContributions(kernel: Kernel): readonly AIProviderContribution[] {
  return kernel.contributions.list<AIProviderDefinition>('ai_providers');
}

export function resolveAIProvider(kernel: Kernel, id: string): AIProviderContribution | undefined {
  return listAIProviderContributions(kernel).find(p => p.id === id);
}

export function filterAIProvidersByCapability(
  kernel: Kernel,
  capability: AIProviderCapability
): readonly AIProviderContribution[] {
  return listAIProviderContributions(kernel).filter(p => p.value.capabilities.includes(capability));
}

/** 解析 provider 展示文案。MCP 工具面固定传 'en'：工具描述是给 AI 读的，不跟界面语言走。 */
export function resolveAIProviderText(
  definition: AIProviderDefinition,
  language: UiLanguage,
): { title: string; description?: string } {
  return {
    title: resolveLocalizedText(definition.title, language) ?? '',
    description: resolveLocalizedText(definition.description, language),
  };
}

export async function invokeAIProvider(
  kernel: Kernel,
  providerId: string,
  request: AIProviderRequest
): Promise<AIProviderResponse> {
  const provider = resolveAIProvider(kernel, providerId);
  if (!provider) {
    return { ok: false, artifacts: [], error: `AI provider not found: ${providerId}` };
  }
  const startTime = Date.now();
  try {
    const response = await provider.value.run(request, kernel);
    return {
      ...response,
      durationMs: response.durationMs ?? (Date.now() - startTime),
    };
  } catch (error) {
    return {
      ok: false,
      artifacts: [],
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
