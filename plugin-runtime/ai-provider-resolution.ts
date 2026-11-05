/**
 * ai-provider-resolution.ts —— 生成时「用哪个 provider」的**运行时决议**（本体去耦）。
 *
 * 目的：把「选哪个 provider」从 `App.tsx` 的一行硬编码，变成一次可配置的决议 ——
 * 之后插件侧增删 provider，本体不再改动。
 *
 * 优先级（自上而下，逐级回退）：
 *  1. 请求显式指定（`request.parameters.providerId`）—— 高级用法 / 同参重生成；
 *  2. 档案里的唯一默认（`isDefault`）；
 *  3. 内置 Gemini；
 *  4. 任意支持该能力的 provider（按 op 推导出的能力过滤）；
 *  5. 兜底仍回 Gemini —— 即便它不支持，也让调用方拿到明确结果而非静默失败。
 *
 * 边界：决议**只返回 id**，不构造请求、不落画布 —— 那些仍是本体职责（见方案文档的四节三层划分）。
 */

import type { Kernel } from './kernel';
import type { AIProviderRequest, AIProviderCapability } from './ai-providers';
import { AI_GENERATION_OP, filterAIProvidersByCapability, listAIProviderContributions } from './ai-providers';
import { listProviderProfiles, secretKeyForProfile } from './ai-provider-profiles';
import { maskSecret } from './secrets-store';

/** 内置云端 provider：零配置时的兜底（行为与迁移前一致）。 */
export const FALLBACK_PROVIDER_ID = 'gemini.image-generator';

/** 该 provider 是否已配置凭据：内置 Gemini 读 `ai.geminiApiKey`，配置化 provider 读分桶键。 */
const hasCredentials = (providerId: string): boolean => {
  const secretKey = providerId === FALLBACK_PROVIDER_ID ? 'ai.geminiApiKey' : secretKeyForProfile(providerId);
  return maskSecret(secretKey).hasKey;
};

/** op → 能力。op 缺省时按有无参考图推断，与各 provider 内部口径一致。 */
const OP_CAPABILITY: Readonly<Record<string, AIProviderCapability>> = Object.freeze({
  'text-to-image': 'text-to-image',
  'image-to-image': 'image-to-image',
  inpainting: 'inpainting',
  'prompt-enhancement': 'prompt-enhancement',
  video: 'video',
});

/** 从请求推导所需能力（缺省按参考图有无推断）。 */
export const capabilityForRequest = (request: AIProviderRequest): AIProviderCapability => {
  const raw = request.parameters?.[AI_GENERATION_OP];
  const op = typeof raw === 'string'
    ? raw
    : (request.referenceImages && request.referenceImages.length > 0 ? 'image-to-image' : 'text-to-image');
  return OP_CAPABILITY[op] ?? 'text-to-image';
};

/** 解析出本次生成应使用的 provider id。 */
export const resolveProviderId = (kernel: Kernel, request: AIProviderRequest): string => {
  const capability = capabilityForRequest(request);
  const contributions = listAIProviderContributions(kernel);
  const supports = (id: string): boolean =>
    contributions.some(item => item.id === id && item.value.capabilities.includes(capability));

  // 1. 请求显式指定（仅当该 provider 已注册且支持所需能力）
  const explicit = request.parameters?.providerId;
  if (typeof explicit === 'string' && supports(explicit)) return explicit;

  // 2. 档案里的唯一默认（用户主动指定，尊重其选择）
  const defaultProfile = listProviderProfiles().find(profile => profile.enabled && profile.isDefault);
  if (defaultProfile && supports(defaultProfile.id)) return defaultProfile.id;

  // 3. 其它「已配好 Key 且支持该能力」的配置化 provider ——
  //    避免在用户只配了某一家时，仍回退到没配 Key 的内置 Gemini 而报错。
  const configured = listProviderProfiles().find(
    profile => profile.enabled && supports(profile.id) && hasCredentials(profile.id),
  );
  if (configured) return configured.id;

  // 4. 内置 Gemini（同样要求已配 Key）
  if (supports(FALLBACK_PROVIDER_ID) && hasCredentials(FALLBACK_PROVIDER_ID)) return FALLBACK_PROVIDER_ID;

  // 5. 任意支持该能力的 provider（可能没配 Key，交给调用方拿明确错误）
  const candidates = filterAIProvidersByCapability(kernel, capability);
  if (candidates.length > 0) return candidates[0].id;

  // 6. 兜底：仍返回 Gemini
  return FALLBACK_PROVIDER_ID;
};
