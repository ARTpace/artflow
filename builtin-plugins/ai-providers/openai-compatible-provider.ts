/**
 * openai-compatible-provider.ts —— 把「OpenAI 兼容协议」封装成一个 `AIProviderDefinition`。
 *
 * 定位：**加一条档案就多一家模型**。只要某家兼容 OpenAI 的 `/v1` 协议，就不必写新代码 ——
 * 本工厂按档案产出 provider；不兼容的协议（volcengine / jimeng 等）才需要在别处单独适配。
 *
 * 与 `gemini-client.ts` 同风格：纯逻辑（`aspectRatioToSize` / `stripDataUrlBase64` / `resolveOp`）
 * + 可注入 `transport`（生产用 `createFetchTransport`，自检注入 fake），网络请求全部下沉，
 * 因此本模块可被离线自检直接 require。
 *
 * v1 范围：文生图（text-to-image）+ 连通性探测（listModels）。图生图 / 异步 / 视频留待 P2。
 */

import type { AIProviderDefinition, AIProviderRequest } from '../../plugin-runtime/ai-providers';
import { AI_GENERATION_OP, type AiGenerationOp } from '../../plugin-runtime/ai-providers';
import type { AIProviderProfile } from '../../plugin-runtime/ai-provider-profiles';

export interface OpenAIImageBytes {
  base64: string;
  mimeType: string;
}

export interface OpenAIGenerateInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  aspectRatio?: string;
  count: number;
  referenceImages?: readonly string[];
  signal?: AbortSignal;
}

/** 网络边界：默认走 fetch，自检注入 fake。 */
export interface OpenAICompatibleTransport {
  generateImages(input: OpenAIGenerateInput): Promise<OpenAIImageBytes[]>;
  listModels(input: { apiKey: string; baseUrl: string; signal?: AbortSignal }): Promise<string[]>;
}

// ── 纯函数区 ────────────────────────────────────────────────────────────────

/** 宽高比 → 上游 `size`。未知比例回退 1024x1024（多数 OpenAI 兼容服务认得）。 */
const ASPECT_SIZES: Readonly<Record<string, string>> = Object.freeze({
  '1:1': '1024x1024',
  '16:9': '1536x864',
  '9:16': '864x1536',
  '4:3': '1152x864',
  '3:4': '864x1152',
});

export const aspectRatioToSize = (ratio: unknown): string =>
  (typeof ratio === 'string' && ASPECT_SIZES[ratio]) || '1024x1024';

export const stripDataUrlBase64 = (value: string): string => {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
};

/**
 * 拼接 base 与 `/v1/...` 路径，容忍 base 末尾斜杠，并**避免重复 `/v1`**：
 * 用户习惯把 baseUrl 填成含版本段的（如 `.../v1`，ModelScope / Agnes 皆是），
 * 若再无脑拼 `/v1/...` 会得到 `/v1/v1/...` → 上游 404。故 base 已带版本段时，去掉路径里的版本段。
 */
export const joinEndpoint = (base: string, path: string): string => {
  const trimmed = base.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (/\/v\d+$/i.test(trimmed) && /^\/v\d+\//i.test(suffix)) {
    return `${trimmed}${suffix.replace(/^\/v\d+/i, '')}`;
  }
  return `${trimmed}${suffix}`;
};

const GENERATION_OPS: readonly AiGenerationOp[] = [
  'text-to-image',
  'image-to-image',
  'inpainting',
  'prompt-enhancement',
  'video',
];

/** 无 op 时按有无参考图推断，保证 MCP 工具面「只有 prompt」的最简调用仍可用。 */
export const resolveCompatibleOp = (request: AIProviderRequest): AiGenerationOp => {
  const raw = request.parameters?.[AI_GENERATION_OP];
  if (typeof raw === 'string' && (GENERATION_OPS as readonly string[]).includes(raw)) {
    return raw as AiGenerationOp;
  }
  return request.referenceImages && request.referenceImages.length > 0 ? 'image-to-image' : 'text-to-image';
};

/** 选模型：优先请求里显式指定的，否则用档案的第一个图像模型。 */
const pickModel = (profile: AIProviderProfile, request: AIProviderRequest): string => {
  const requested = request.parameters?.model;
  if (typeof requested === 'string' && requested.trim().length > 0) return requested.trim();
  return profile.imageModels[0] ?? '';
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

// ── 默认 transport（fetch，动态不需要 SDK）────────────────────────────────────

export const createFetchTransport = (): OpenAICompatibleTransport => ({
  async generateImages(input) {
    const response = await fetch(joinEndpoint(input.baseUrl, '/v1/images/generations'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        n: input.count,
        size: aspectRatioToSize(input.aspectRatio),
        response_format: 'b64_json',
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new Error(`上游返回 ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { data?: Array<{ b64_json?: unknown; url?: unknown }> };
    const items = Array.isArray(payload.data) ? payload.data : [];
    const out: OpenAIImageBytes[] = [];
    for (const item of items) {
      if (typeof item?.b64_json === 'string' && item.b64_json.length > 0) {
        out.push({ base64: item.b64_json, mimeType: 'image/png' });
        continue;
      }
      // 有些 OpenAI 兼容服务（如 Agnes）不认 response_format，默认返回图片 URL：拉回来自己转 base64。
      if (typeof item?.url === 'string' && item.url.length > 0) {
        const imageResponse = await fetch(item.url, { signal: input.signal });
        if (!imageResponse.ok) throw new Error(`下载生成图失败：${imageResponse.status}`);
        const bytes = new Uint8Array(await imageResponse.arrayBuffer());
        out.push({
          base64: bytesToBase64(bytes),
          mimeType: imageResponse.headers.get('content-type') ?? 'image/png',
        });
      }
    }
    return out;
  },

  async listModels(input) {
    const response = await fetch(joinEndpoint(input.baseUrl, '/v1/models'), {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    });
    if (!response.ok) {
      throw new Error(`上游返回 ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const items = Array.isArray(payload.data) ? payload.data : [];
    return items.map(item => (typeof item?.id === 'string' ? item.id : '')).filter(id => id.length > 0);
  },
});

// ── provider 工厂 ───────────────────────────────────────────────────────────

export interface OpenAICompatibleDeps {
  /** 读取该 provider 的 API Key（由调用方按分桶键从密钥卷取）。 */
  getApiKey: () => string | null;
  transport: OpenAICompatibleTransport;
}

export const createOpenAICompatibleProvider = (
  profile: AIProviderProfile,
  deps: OpenAICompatibleDeps,
): AIProviderDefinition => ({
  title: profile.name,
  description: `${profile.protocol === 'openai' ? 'OpenAI 兼容' : profile.protocol} · ${profile.baseUrl}`,
  providerType: 'cloud',
  capabilities: profile.capabilities,
  async run(request) {
    const apiKey = deps.getApiKey();
    if (!apiKey) {
      return { ok: false, artifacts: [], error: `${profile.name} 的 API Key 未配置` };
    }
    const op = resolveCompatibleOp(request);
    // v1：仅文生图走通；图生图 / 异步 / 视频在 P2 补齐。
    if (op !== 'text-to-image') {
      return { ok: false, artifacts: [], error: `provider ${profile.id} 暂不支持 ${op}（P0 仅文生图）` };
    }
    const model = pickModel(profile, request);
    if (!model) {
      return { ok: false, artifacts: [], error: `provider ${profile.id} 未配置图像模型` };
    }
    const count = Math.min(4, Math.max(1, Math.round(Number(request.parameters?.numberOfImages) || 1)));
    try {
      const images = await deps.transport.generateImages({
        apiKey,
        baseUrl: profile.baseUrl,
        model,
        prompt: request.prompt,
        aspectRatio: typeof request.parameters?.aspectRatio === 'string' ? request.parameters.aspectRatio : undefined,
        count,
        signal: request.signal,
      });
      if (images.length === 0) {
        return { ok: true, artifacts: [{ kind: 'text', content: 'No images were generated.', mimeType: 'text/plain' }] };
      }
      return {
        ok: true,
        artifacts: images.map(image => ({
          kind: 'image' as const,
          dataUrl: `data:${image.mimeType};base64,${image.base64}`,
          mimeType: image.mimeType,
          metadata: { model, provider: profile.id, op },
        })),
      };
    } catch (error) {
      return { ok: false, artifacts: [], error: error instanceof Error ? error.message : String(error) };
    }
  },
  async checkHealth() {
    const apiKey = deps.getApiKey();
    if (!apiKey) return { available: false, message: `${profile.name} 未配置 API Key` };
    try {
      const models = await deps.transport.listModels({ apiKey, baseUrl: profile.baseUrl });
      return { available: true, message: `OK · ${models.length} models` };
    } catch (error) {
      return { available: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
});
