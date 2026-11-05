/**
 * Typed contract for external tool connections via the `asset_sources` slot (REQ-004 / R37).
 * Connects external generation tools (ComfyUI, SD-WebUI, NAS, Figma) to Artflow.
 */

import type { Contribution, Kernel } from './kernel';
import { resolveLocalizedText, type LocalizedText, type UiLanguage } from './i18n';

export interface ExternalAssetSourceStatus {
  online: boolean;
  endpoint: string;
  device?: string;
  vramFree?: number;
  message?: string;
}

export interface AssetSourceWorkflowSubmission {
  workflowId?: string;
  prompt: string;
  parameters?: Readonly<Record<string, unknown>>;
  inputImages?: readonly string[];
}

export interface AssetSourceGenerationResult {
  assetDataUrl: string;
  mimeType: string;
  width?: number;
  height?: number;
  /** Namespace metadata: e.g. `<comfyui.seed>`, `<comfyui.workflowId>`, etc. */
  metadata: Readonly<Record<string, unknown>>;
}

export interface AssetSourceDefinition {
  /** 展示文案：字符串（各语言同文案）或按语言的解析函数。 */
  title: LocalizedText;
  description?: LocalizedText;
  endpoint: string;
  namespacePrefix: string; // e.g. 'comfyui.'
  probeStatus: () => Promise<ExternalAssetSourceStatus>;
  submitWorkflow?: (submission: AssetSourceWorkflowSubmission, kernel: Kernel) => Promise<AssetSourceGenerationResult>;
}

export type AssetSourceContribution = Contribution<AssetSourceDefinition>;

export function listAssetSourceContributions(kernel: Kernel): readonly AssetSourceContribution[] {
  return kernel.contributions.list<AssetSourceDefinition>('asset_sources');
}

export function resolveAssetSource(kernel: Kernel, id: string): AssetSourceContribution | undefined {
  return listAssetSourceContributions(kernel).find(s => s.id === id);
}

/** 解析资产源展示文案。MCP 工具面固定传 'en'：工具描述是给 AI 读的，不跟界面语言走。 */
export function resolveAssetSourceText(
  definition: AssetSourceDefinition,
  language: UiLanguage,
): { title: string; description?: string } {
  return {
    title: resolveLocalizedText(definition.title, language) ?? '',
    description: resolveLocalizedText(definition.description, language),
  };
}

/**
 * Validates that all metadata keys carry the declared namespace prefix (e.g. `comfyui.seed`).
 */
export function validateNamespaceMetadata(
  prefix: string,
  metadata: Readonly<Record<string, unknown>>
): boolean {
  for (const key of Object.keys(metadata)) {
    if (!key.startsWith(prefix)) {
      return false;
    }
  }
  return true;
}
