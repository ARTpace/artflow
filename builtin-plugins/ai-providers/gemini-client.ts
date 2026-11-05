/**
 * builtin/ai-providers/gemini-client.ts —— Gemini 云端生成本体（REQ-004 / R37 通道一）。
 *
 * 分层原则（与 comfy-client.ts 同风格）：
 * 1. 纯逻辑区（normalizeOp / buildEditParts / extractImageFromResponse / blobToBase64）
 *    不依赖 DOM 与网络，可被 node self-check 直接 require；
 * 2. 网络怎么发被外置成 GeminiTransport 依赖 —— 生产用 @google/genai 的默认实现，
 *    自检注入 fake transport，因此自检在无网络 / 无 API key 时也能完整跑过；
 * 3. 真实 SDK 走 **动态 import**：默认 transport 只在真正发起调用时才加载 @google/genai，
 *    这样 require 本模块做纯逻辑断言时不会拉起重型 SDK。
 *
 * 这里是从原 services/geminiService.ts 平移过来的：endpoint / 模型名 / 结果解析口径保持原样，
 * 只是把「取图」「取文」「生视频」抽象成 transport 方法，便于注入与离线自检。
 */

import type { ImageAspectRatio } from '../../types';

export const GEMINI_IMAGE_MODEL = 'imagen-4.0-generate-001';
export const GEMINI_EDIT_MODEL = 'gemini-2.5-flash-image';
export const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
export const GEMINI_VIDEO_MODEL = 'veo-2.0-generate-001';

export interface GeminiImageBytes {
  base64: string;
  mimeType: string;
}

export interface GeminiImageInput {
  apiKey: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  numberOfImages: number;
}

export interface GeminiEditInput {
  apiKey: string;
  images: readonly { href: string; mimeType: string }[];
  prompt: string;
  mask?: { href: string; mimeType: string };
}

export interface GeminiDescribeInput {
  apiKey: string;
  image: { href: string; mimeType: string };
}

export interface GeminiVideoInput {
  apiKey: string;
  prompt: string;
  aspectRatio: '16:9' | '9:16';
  numberOfVideos: number;
  image?: { href: string; mimeType: string };
  onProgress: (message: string) => void;
}

/** 网络边界的抽象：默认走 @google/genai，自检注入 fake。 */
export interface GeminiTransport {
  generateImages(input: GeminiImageInput): Promise<GeminiImageBytes[]>;
  editImage(input: GeminiEditInput): Promise<{ image?: GeminiImageBytes; text?: string }>;
  describeImage(input: GeminiDescribeInput): Promise<string>;
  generateVideo(input: GeminiVideoInput): Promise<GeminiImageBytes[]>;
}

// ── 纯函数区 ────────────────────────────────────────────────────────────────

/** data URL → 生成所需的一段 inlineData part（裸 base64 + mimeType）。 */
export const dataUrlToPart = (dataUrl: string, mimeType: string): { inlineData: { data: string; mimeType: string } } => {
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return { inlineData: { data: base64, mimeType } };
};

/** 组编辑请求的 parts 顺序：参考图（可多张）→ 文本提示 → 可选蒙版。与原实现一致。 */
export const buildEditParts = (input: GeminiEditInput): unknown[] => {
  const parts: unknown[] = [
    ...input.images.map(image => dataUrlToPart(image.href, image.mimeType)),
    { text: input.prompt },
  ];
  if (input.mask) parts.push(dataUrlToPart(input.mask.href, input.mask.mimeType));
  return parts;
};

/** 从 generateContent 的响应里取第一段 inlineData 图像。 */
export const extractImageFromResponse = (response: unknown): GeminiImageBytes | undefined => {
  const candidates = (response as { candidates?: unknown[] } | undefined)?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const parts = (candidates[0] as { content?: { parts?: unknown[] } })?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    const inline = (part as { inlineData?: { data?: string; mimeType?: string } })?.inlineData;
    if (inline && typeof inline.data === 'string') {
      return { base64: inline.data, mimeType: inline.mimeType ?? 'image/png' };
    }
  }
  return undefined;
};

/** 从 generateContent 的响应里取文本。 */
export const extractTextFromResponse = (response: unknown): string | undefined => {
  const text = (response as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' && text.length > 0 ? text : undefined;
};

/** Blob → 裸 base64（视频产物经 artifact.dataUrl 回传，需先转 base64）。 */
export const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

// ── 默认 transport（@google/genai，动态 import）────────────────────────────────

/**
 * 默认 transport：真正调用 @google/genai。
 * 用动态 import 延迟加载 SDK —— 让纯逻辑自检（require 本模块）不拉起重型依赖。
 */
export const createGeminiTransport = (): GeminiTransport => ({
  async generateImages(input) {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const response = await ai.models.generateImages({
      model: GEMINI_IMAGE_MODEL,
      prompt: input.prompt,
      config: {
        numberOfImages: input.numberOfImages,
        outputMimeType: 'image/png',
        aspectRatio: input.aspectRatio,
      },
    });
    const generated = response.generatedImages ?? [];
    return generated.map(img => ({ base64: img.image.imageBytes, mimeType: 'image/png' }));
  },

  async editImage(input) {
    const { GoogleGenAI, Modality } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const response = await ai.models.generateContent({
      model: GEMINI_EDIT_MODEL,
      contents: { parts: buildEditParts(input) as never },
      config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
    });
    const image = extractImageFromResponse(response);
    if (image) return { image };
    return { text: extractTextFromResponse(response) };
  },

  async describeImage(input) {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const response = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: {
        parts: [
          dataUrlToPart(input.image.href, input.image.mimeType),
          {
            text: 'Describe this image in detail. Provide a descriptive prompt that could be used to generate a similar image with an AI image generator. Focus on visual elements, style, composition, colors, and lighting. The description should be professional and concise.',
          },
        ] as never,
      },
    });
    const text = extractTextFromResponse(response);
    if (!text) throw new Error('API returned an empty prompt.');
    return text;
  },

  async generateVideo(input) {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    input.onProgress('Sending request to generate video...');

    let imagePart;
    if (input.image) {
      const comma = input.image.href.indexOf(',');
      const base64 = input.image.href.startsWith('data:') && comma >= 0
        ? input.image.href.slice(comma + 1)
        : input.image.href;
      imagePart = { imageBytes: base64, mimeType: input.image.mimeType };
    }

    let operation = await ai.models.generateVideos({
      model: GEMINI_VIDEO_MODEL,
      prompt: input.prompt,
      image: imagePart,
      config: { numberOfVideos: input.numberOfVideos },
    });

    input.onProgress('Video generation in progress... this may take a few minutes.');
    let checkCount = 0;
    while (!operation.done) {
      checkCount += 1;
      await new Promise(resolve => setTimeout(resolve, 10000));
      input.onProgress(`Checking status... (${checkCount * 10}s elapsed)`);
      operation = await ai.operations.getVideosOperation({ operation });
    }

    input.onProgress('Video generation complete. Downloading...');

    const generated = operation.response?.generatedVideos ?? [];
    if (generated.length === 0) {
      throw new Error('Video generation finished but no videos were returned.');
    }

    const results: GeminiImageBytes[] = [];
    for (const videoInfo of generated) {
      const downloadLink = videoInfo.video?.uri;
      if (!downloadLink) {
        throw new Error('Video generation succeeded but no download link was provided.');
      }
      const response = await fetch(`${downloadLink}&key=${input.apiKey}`);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.statusText}`);
      }
      const blob = await response.blob();
      results.push({ base64: await blobToBase64(blob), mimeType: 'video/mp4' });
    }
    return results;
  },
});

export const defaultGeminiTransport = createGeminiTransport();
