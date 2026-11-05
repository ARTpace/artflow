/**
 * builtin/ai-providers/index.ts —— AI 与外部工具接入内置插件 (REQ-004 / R37).
 *
 * Provides:
 * 1. `gemini.image-generator`: 云端出站生成（text-to-image / image-to-image / inpainting / prompt-enhancement / video）
 * 2. `comfyui.local-engine`（ai_providers 槽）: 本机 ComfyUI 抠图（image-matting）
 * 3. `comfyui.local-engine`（asset_sources 槽）: 外部工具连接状态 + 工作流提交，带 <comfyui.> 元数据
 * 4. `image.ai-repaint`: 选中图片的节点操作
 * 5. Workspace command: `ai.generate-image`
 *
 * 通道一（Gemini）与通道二（ComfyUI）现在都是真实现：
 * - Gemini 走注入的 GeminiTransport（生产 = @google/genai，自检注入 fake transport），renderer 直连云端；
 * - ComfyUI 经主进程代发执行，renderer 不直连（§12.2 进程原则）。
 */

import type { Kernel, Effect } from '../../plugin-runtime/kernel';
import {
  AI_GENERATION_OP,
  type AIProviderDefinition,
  type AIProviderRequest,
  type AiGenerationOp,
} from '../../plugin-runtime/ai-providers';
import type { AssetSourceDefinition } from '../../plugin-runtime/asset-sources';
import type { NodeActionDefinition } from '../../plugin-runtime/node-actions';
import type { CommandDefinition } from '../../plugin-runtime/commands';
import { AI_SESSION_SERVICE, type AiSession } from '../../plugin-runtime/ai-session';
import { readSecret } from '../../plugin-runtime/secrets-store';
import type { ImageAspectRatio } from '../../types';
import {
  COMFY_ENDPOINT,
  DEFAULT_MATTING_MODEL,
  MATTING_MODELS,
  createBridgeTransport,
  createComfyClient,
  type ComfyClient,
  type ComfyTransport,
} from './comfy-client';
import {
  GEMINI_EDIT_MODEL,
  GEMINI_IMAGE_MODEL,
  GEMINI_TEXT_MODEL,
  GEMINI_VIDEO_MODEL,
  defaultGeminiTransport,
  type GeminiTransport,
} from './gemini-client';
import {
  listProviderProfiles,
  secretKeyForProfile,
  subscribeProviderProfiles,
} from '../../plugin-runtime/ai-provider-profiles';
import {
  createFetchTransport,
  createOpenAICompatibleProvider,
  type OpenAICompatibleTransport,
} from './openai-compatible-provider';
import type { PluginPanelContribution } from '../../plugin-runtime/panel-contributions';
import type { SettingsSectionContribution } from '../../plugin-runtime/settings-contributions';
import { AiModelsPanel, AiModelsSettingsSection } from './AiModelsPanel';
import { PromptBarWidget } from './PromptBarWidget';
import manifest from './manifest.json';
import { bi } from '../../plugin-runtime/i18n';

/** 两个槽位各持一份，语义分别是「出站生成」与「外部工具连接」，故 id 相同不冲突（槽位内唯一即可）。 */
export const COMFY_PROVIDER_ID = 'comfyui.local-engine';
export const COMFY_ASSET_SOURCE_ID = 'comfyui.local-engine';
export const GEMINI_PROVIDER_ID = 'gemini.image-generator';
/** Gemini API Key 在密钥卷中的键名（与 useSettings / secrets-store 保持一致）。 */
export const GEMINI_API_KEY_SECRET = 'ai.geminiApiKey';

const resolveMattingModel = (value: unknown): string =>
  typeof value === 'string' && MATTING_MODELS.includes(value) ? value : DEFAULT_MATTING_MODEL;

/** data URL → mimeType：`referenceImages` 只传字符串，需自行还原类型。 */
const mimeTypeOf = (value: string): string => {
  const match = /^data:([^;,]+)[;,]/.exec(value);
  return match ? match[1] : 'image/png';
};

const toInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
};

const toAspectRatio = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const GEMINI_OPS: readonly AiGenerationOp[] = [
  'text-to-image',
  'image-to-image',
  'inpainting',
  'prompt-enhancement',
  'video',
];

/** 无 op 时按有无参考图推断，保证 MCP 工具面「只有 prompt」的最简调用仍可用。 */
const resolveGeminiOp = (request: AIProviderRequest): AiGenerationOp => {
  const raw = request.parameters?.[AI_GENERATION_OP];
  if (typeof raw === 'string' && (GEMINI_OPS as readonly string[]).includes(raw)) {
    return raw as AiGenerationOp;
  }
  return request.referenceImages && request.referenceImages.length > 0 ? 'image-to-image' : 'text-to-image';
};

/**
 * Gemini 云端 provider：一次 run 按 `parameters.op` 分派
 * 文生图 / 图生图 / 抠图重绘 / 提示词增强 / 文生视频。
 * 真实网络调用全部下沉到注入的 `transport`（生产 = @google/genai，自检 = fake）。
 */
const geminiProvider = (transport: GeminiTransport, getApiKey: () => string | null): AIProviderDefinition => ({
  title: bi('Gemini AI 生成器', 'Gemini AI Generator'),
  description: bi(
    '由 Gemini API 驱动的云端多模态生成器（文生图 / 图生图 / 抠图重绘 / 提示词增强 / 文生视频）',
    'Cloud multimodal generator powered by Gemini API (text-to-image / image-to-image / prompt-enhancement / text-to-video)',
  ),
  providerType: 'cloud',
  capabilities: ['text-to-image', 'image-to-image', 'inpainting', 'prompt-enhancement', 'video'],
  async run(request) {
    const apiKey = getApiKey();
    if (!apiKey) {
      return {
        ok: false,
        artifacts: [],
        error: 'Gemini API Key 未配置，请在设置的 AI 面板中填写',
      };
    }

    const op = resolveGeminiOp(request);
    try {
      switch (op) {
        case 'prompt-enhancement': {
          const source = request.referenceImages?.[0];
          if (!source) {
            return { ok: false, artifacts: [], error: 'prompt-enhancement requires referenceImages[0]' };
          }
          const text = await transport.describeImage({
            apiKey,
            image: { href: source, mimeType: mimeTypeOf(source) },
          });
          return {
            ok: true,
            artifacts: [{
              kind: 'text',
              content: text,
              mimeType: 'text/plain',
              metadata: { model: GEMINI_TEXT_MODEL, op },
            }],
          };
        }

        case 'video': {
          const aspectRatio = toAspectRatio(request.parameters?.aspectRatio, ['16:9', '9:16'] as const, '16:9');
          const numberOfVideos = toInt(request.parameters?.numberOfVideos, 1, 1, 2);
          const reference = request.referenceImages?.[0];
          const videos = await transport.generateVideo({
            apiKey,
            prompt: request.prompt,
            aspectRatio,
            numberOfVideos,
            image: reference ? { href: reference, mimeType: mimeTypeOf(reference) } : undefined,
            onProgress: request.onProgress ?? (() => {}),
          });
          return {
            ok: true,
            artifacts: videos.map(video => ({
              kind: 'video' as const,
              dataUrl: `data:${video.mimeType};base64,${video.base64}`,
              mimeType: video.mimeType,
              metadata: { model: GEMINI_VIDEO_MODEL, op },
            })),
          };
        }

        case 'text-to-image': {
          const aspectRatio = toAspectRatio(
            request.parameters?.aspectRatio,
            ['1:1', '16:9', '9:16', '4:3', '3:4'] as const,
            '1:1',
          ) as ImageAspectRatio;
          const numberOfImages = toInt(request.parameters?.numberOfImages, 1, 1, 4);
          const images = await transport.generateImages({
            apiKey,
            prompt: request.prompt,
            aspectRatio,
            numberOfImages,
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
              metadata: { model: GEMINI_IMAGE_MODEL, op },
            })),
          };
        }

        // image-to-image / inpainting 共用编辑通道：有 mask 即重绘。
        default: {
          const images = (request.referenceImages ?? []).map(href => ({ href, mimeType: mimeTypeOf(href) }));
          const maskHref = request.parameters?.mask;
          const mask = typeof maskHref === 'string'
            ? { href: maskHref, mimeType: mimeTypeOf(maskHref) }
            : undefined;
          const result = await transport.editImage({ apiKey, images, prompt: request.prompt, mask });
          if (result.image) {
            return {
              ok: true,
              artifacts: [{
                kind: 'image',
                dataUrl: `data:${result.image.mimeType};base64,${result.image.base64}`,
                mimeType: result.image.mimeType,
                metadata: { model: GEMINI_EDIT_MODEL, op },
              }],
            };
          }
          return {
            ok: true,
            artifacts: [{ kind: 'text', content: result.text ?? 'No image was generated.', mimeType: 'text/plain' }],
          };
        }
      }
    } catch (error) {
      return { ok: false, artifacts: [], error: error instanceof Error ? error.message : String(error) };
    }
  },
  async checkHealth() {
    const available = Boolean(getApiKey());
    return {
      available,
      latencyMs: available ? 25 : undefined,
      message: available ? 'Gemini API Key 已配置' : 'Gemini API Key 未配置',
    };
  },
});

const comfyMattingProvider = (client: ComfyClient): AIProviderDefinition => ({
  title: bi('ComfyUI 本机抠图', 'ComfyUI Local Matting'),
  description: bi(
    `BiRefNet 系列抠图，本机 ComfyUI（${COMFY_ENDPOINT}）经主进程代发执行，输出带软边 alpha 的 PNG`,
    `BiRefNet matting executed by local ComfyUI (${COMFY_ENDPOINT}) through the main-process proxy, returning a PNG with a soft alpha edge`,
  ),
  providerType: 'local',
  capabilities: ['image-matting', 'image-to-image'],
  async run(request) {
    const source = request.referenceImages?.[0];
    if (!source) {
      return { ok: false, artifacts: [], error: '抠图需要一张原图（referenceImages[0]）' };
    }
    const result = await client.submitMatting(source, resolveMattingModel(request.parameters?.model));
    return {
      ok: true,
      artifacts: [{
        kind: 'image',
        dataUrl: result.imageDataUrl,
        mimeType: 'image/png',
        metadata: result.metadata,
      }],
    };
  },
  async checkHealth() {
    const probe = await client.probeStatus();
    return { available: probe.online, message: probe.message };
  },
});

const comfyAssetSource = (client: ComfyClient): AssetSourceDefinition => ({
  title: bi('ComfyUI 本机工作台', 'ComfyUI Local Studio'),
  description: bi(
    `本机节点式引擎（${COMFY_ENDPOINT}）；当前接入的是 BiRefNet 抠图工作流，产物为带 alpha 的 PNG`,
    `Local node-graph engine (${COMFY_ENDPOINT}); the wired workflow is BiRefNet matting, producing a PNG with alpha`,
  ),
  endpoint: COMFY_ENDPOINT,
  namespacePrefix: 'comfyui.',
  async probeStatus() {
    const probe = await client.probeStatus();
    return {
      online: probe.online,
      endpoint: COMFY_ENDPOINT,
      device: probe.device,
      vramFree: probe.vramFree,
      message: probe.message,
    };
  },
  async submitWorkflow(submission) {
    const source = submission.inputImages?.[0];
    if (!source) throw new Error('submission.inputImages 需要提供一张原图');
    const result = await client.submitMatting(source, resolveMattingModel(submission.parameters?.model));
    return {
      assetDataUrl: result.imageDataUrl,
      mimeType: 'image/png',
      metadata: {
        ...result.metadata,
        'comfyui.prompt': submission.prompt ?? '',
        'comfyui.workflowId': submission.workflowId ?? 'matting-birefnet',
      },
    };
  },
});

const repaintAction: NodeActionDefinition = {
  title: bi('AI 重绘 / 扩图', 'AI Repaint (重绘/扩图)'),
  description: bi('调用已注册的 AI 提供方，重绘或增强所选图像', 'Invoke registered AI provider to repaint or enhance the selected image'),
  icon: 'sparkles',
  targetTypes: ['image'],
  async run(ctx) {
    console.log(`[ai-providers] Repainting element: ${ctx.element.id}`);
  },
};

const generateCommand: CommandDefinition = {
  title: bi('AI 生成画布图像', 'AI Generate Canvas Image'),
  description: bi('通过已注册的 AI 提供方执行文生图', 'Trigger text-to-image generation via registered AI providers'),
  group: 'AI Generation',
  keywords: ['ai', 'generate', 'gemini', 'comfyui', 'image'],
  shortcut: { key: 'g', alt: true, shift: true },
  run(kernel) {
    if (!kernel.has(AI_SESSION_SERVICE)) return;
    kernel.use<AiSession>(AI_SESSION_SERVICE).generate();
  },
};

/**
 * 工厂形态：transport 可注入，让 self-check 能在 ComfyUI 离线时验证真实探测/提交链路。
 * 生产路径用默认构造的 aiProvidersPlugin（transport = 主进程桥）。
 */
export const createAiProvidersPlugin = (options: {
  comfyTransport?: ComfyTransport;
  geminiTransport?: GeminiTransport;
  getGeminiApiKey?: () => string | null;
  openaiTransport?: OpenAICompatibleTransport;
} = {}) => {
  const comfyClient = createComfyClient(options.comfyTransport ?? createBridgeTransport());
  const geminiTransport = options.geminiTransport ?? defaultGeminiTransport;
  const getGeminiApiKey = options.getGeminiApiKey ?? (() => readSecret(GEMINI_API_KEY_SECRET));
  const openaiTransport = options.openaiTransport ?? createFetchTransport();

  const activate = (kernel: Kernel): Effect => {
    const disposers: Effect[] = [];

    disposers.push(
      kernel.contributions.register('ai_providers', {
        id: GEMINI_PROVIDER_ID,
        pluginId: manifest.id,
        priority: 10,
        value: geminiProvider(geminiTransport, getGeminiApiKey),
      })
    );

    disposers.push(
      kernel.contributions.register('ai_providers', {
        id: COMFY_PROVIDER_ID,
        pluginId: manifest.id,
        priority: 20,
        value: comfyMattingProvider(comfyClient),
      })
    );

    disposers.push(
      kernel.contributions.register('asset_sources', {
        id: COMFY_ASSET_SOURCE_ID,
        pluginId: manifest.id,
        priority: 20,
        value: comfyAssetSource(comfyClient),
      })
    );

    disposers.push(
      kernel.contributions.register('node_actions', {
        id: 'image.ai-repaint',
        pluginId: manifest.id,
        priority: 15,
        value: repaintAction,
      })
    );

    disposers.push(
      kernel.contributions.register('commands', {
        id: 'ai.generate-image',
        pluginId: manifest.id,
        priority: 5,
        value: generateCommand,
      })
    );

    // —— 配置化云端 provider（P0）：读档案，为每个 enabled 项注册一条 ai_providers 贡献。——
    // 档案是「元数据」，密钥按 ai.provider.<id>.apiKey 分桶从密钥卷取。
    // 档案变更（设置面板保存）时整批 dispose 再重建，避免残留已被删除/停用的 provider。
    const profileDisposers: Effect[] = [];
    const syncProfileProviders = (): void => {
      for (const dispose of profileDisposers.splice(0)) dispose();
      for (const profile of listProviderProfiles()) {
        if (!profile.enabled) continue;
        profileDisposers.push(
          kernel.contributions.register('ai_providers', {
            id: profile.id,
            pluginId: manifest.id,
            priority: 30,
            value: createOpenAICompatibleProvider(profile, {
              getApiKey: () => readSecret(secretKeyForProfile(profile.id)),
              transport: openaiTransport,
            }),
          }),
        );
      }
    };
    syncProfileProviders();
    disposers.push(subscribeProviderProfiles(syncProfileProviders));
    disposers.push(() => { for (const dispose of profileDisposers.splice(0)) dispose(); });

    // 「AI 模型」设置面板：非模态、可拖拽的悬浮窗（配置化 provider 的可视化入口）。
    disposers.push(
      kernel.contributions.register<PluginPanelContribution>('ui_panels', {
        id: 'builtin.panel-ai-models',
        pluginId: manifest.id,
        priority: 25,
        value: {
          title: bi('AI 模型', 'AI Models'),
          description: bi('管理云端 AI 供应商、API Key 与模型列表。', 'Manage cloud AI providers, API keys and models.'),
          component: AiModelsPanel,
          presentation: 'floating',
          floatingWidth: 'lg',
        },
      })
    );

    // 设置页入口（与插件管理同款）：设置 → 扩展 → 「AI 模型」，复用同一面板组件。
    disposers.push(
      kernel.contributions.register<SettingsSectionContribution>('settings_sections', {
        id: 'builtin.settings-ai-models',
        pluginId: manifest.id,
        priority: 30,
        value: {
          label: bi('AI 模型', 'AI Models'),
          component: AiModelsSettingsSection,
          navGroup: 'extensions',
        },
      })
    );

    // 底部提示词栏（PromptBar）：AI 生成入口。组件本体已从本体 components/ 迁入本插件目录，
    // props 仍经 workspace-bridge 的 promptBar 分片由 App 注入（生成编排状态在本体）。
    disposers.push(
      kernel.contributions.register('canvas_widgets', {
        id: 'builtin.ai-providers.prompt',
        pluginId: manifest.id,
        priority: 20,
        value: {
          title: bi('提示词', 'Prompt'),
          bridgeKey: 'promptBar' as const,
          placement: 'prompt' as const,
          component: PromptBarWidget,
        },
      })
    );

    return () => {
      for (const dispose of disposers.reverse()) {
        dispose();
      }
    };
  };

  return { manifest, activate };
};

export const aiProvidersPlugin = createAiProvidersPlugin();
export const activate = aiProvidersPlugin.activate;
