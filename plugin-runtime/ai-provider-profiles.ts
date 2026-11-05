/**
 * ai-provider-profiles.ts —— 云端 AI provider 的**配置化档案**（只存元数据，不存密钥）。
 *
 * 对标 art-canvas 的「provider 元数据 / 密钥」分离：
 *  - 元数据（id / 名称 / 协议 / baseUrl / 模型列表 / 能力 / 默认标记）落在独立配置卷 `ai-providers`；
 *  - 密钥本体按 `ai.provider.<id>.apiKey` 分桶存进**密钥卷**（secrets-store），
 *    这样导出 / 分享 provider 档案时不会顺带把密钥带出去。
 *
 * `builtin.ai-providers` 插件在 activate 时读本模块，为每个 `enabled` 档案注册一个云端 provider；
 * 配置变更时（本模块的 volume 有订阅）重新注册。本模块**纯逻辑 + 配置卷**，可被离线自检直接 require。
 */

import { createConfigVolume } from './config-volume';
import type { AIProviderCapability } from './ai-providers';

/** 配置卷里承载档案数组的键。 */
export const AI_PROVIDER_PROFILES_KEY = 'profiles';

/** v1 支持：OpenAI 兼容协议 + 原生 Gemini（Gemini 走内置 provider，通常不在此建档）。 */
export type AIProviderProtocol = 'openai' | 'gemini';

export interface AIProviderProfile {
  /** 全局唯一 id；约定 `config.<vendor>` 前缀，避免与内置 `gemini.image-generator` 等冲突。 */
  id: string;
  name: string;
  protocol: AIProviderProtocol;
  baseUrl: string;
  imageModels: string[];
  videoModels: string[];
  capabilities: AIProviderCapability[];
  /** 'openai' = 同步单次请求；'async' = 提交后轮询（P2）。 */
  requestMode: 'openai' | 'async';
  enabled: boolean;
  /** 唯一默认项（供 provider 决议在「用户未显式选择」时兜底）。 */
  isDefault: boolean;
}

/** 运行时能力白名单（AIProviderCapability 是纯类型，运行时需要一份可校验的值表）。 */
const CAPABILITIES: readonly AIProviderCapability[] = [
  'text-to-image',
  'image-to-image',
  'inpainting',
  'prompt-enhancement',
  'text-generation',
  'video',
  'image-matting',
];

const ID_PATTERN = /^[a-z][a-z0-9._-]*$/i;

/** 密钥卷键名：按 provider 分桶（与内置 `ai.geminiApiKey` 并列）。 */
export const secretKeyForProfile = (profileId: string): string => `ai.provider.${profileId}.apiKey`;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asString).filter(item => item.length > 0) : [];

const asCapabilities = (value: unknown): AIProviderCapability[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is AIProviderCapability =>
          typeof item === 'string' && (CAPABILITIES as readonly string[]).includes(item),
      )
    : [];

/**
 * 规范化一条档案；字段不合法返回 null（坏档案丢弃，不拖垮整张列表）。
 * 幂等：`normalize(normalize(x))` 与 `normalize(x)` 等值。
 */
export const normalizeProviderProfile = (input: unknown): AIProviderProfile | null => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const id = asString(raw.id);
  const name = asString(raw.name);
  const baseUrl = asString(raw.baseUrl);
  const protocol: AIProviderProtocol = raw.protocol === 'gemini' ? 'gemini' : 'openai';
  if (!ID_PATTERN.test(id) || id.length > 64) return null;
  if (name.length === 0 || name.length > 80) return null;
  if (baseUrl.length === 0 || baseUrl.length > 300) return null;
  const capabilities = asCapabilities(raw.capabilities);
  return {
    id,
    name,
    protocol,
    baseUrl,
    imageModels: asStringArray(raw.imageModels),
    videoModels: asStringArray(raw.videoModels),
    // 一条没有能力的档案没有意义：兜底为最基本的文生图。
    capabilities: capabilities.length > 0 ? capabilities : ['text-to-image'],
    requestMode: raw.requestMode === 'async' ? 'async' : 'openai',
    enabled: raw.enabled !== false,
    isDefault: raw.isDefault === true,
  };
};

const volume = createConfigVolume('ai-providers');

/** 读全部档案（已规范化；坏项丢弃、id 去重）。 */
export const listProviderProfiles = (): AIProviderProfile[] => {
  const stored = volume.read<unknown>(AI_PROVIDER_PROFILES_KEY, []);
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const out: AIProviderProfile[] = [];
  for (const item of stored) {
    const profile = normalizeProviderProfile(item);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
};

/**
 * 覆写全部档案：先规范化、id 去重、并保证「最多一个默认」。
 * 落盘失败会同步抛出并回滚（config-volume 语义）。
 */
export const saveProviderProfiles = (profiles: readonly unknown[]): AIProviderProfile[] => {
  const seen = new Set<string>();
  const normalized: AIProviderProfile[] = [];
  for (const item of profiles) {
    const profile = normalizeProviderProfile(item);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    normalized.push(profile);
  }
  // 唯一默认：取最后一个被标记的（对标 art-canvas 的 primary 去重口径）。
  const defaultIndex = normalized.reduce((acc, profile, index) => (profile.isDefault ? index : acc), -1);
  normalized.forEach((profile, index) => { profile.isDefault = index === defaultIndex; });
  volume.write(AI_PROVIDER_PROFILES_KEY, normalized);
  return normalized;
};

export const subscribeProviderProfiles = (listener: () => void): (() => void) =>
  volume.subscribe(AI_PROVIDER_PROFILES_KEY, listener);
