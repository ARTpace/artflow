/**
 * AI Orchestration & Registry-to-Agent Tool Projection (REQ-004 / R37).
 * Exposes runtime kernel contributions (commands, ai_providers, asset_sources)
 * as clean, declarative JSON-schema tool definitions for LLM / AI agent execution.
 */

import type { Kernel } from './kernel';
import { listCommandContributions, resolveCommandText } from './commands';
import { listAIProviderContributions, resolveAIProviderText } from './ai-providers';
import { listAssetSourceContributions, resolveAssetSourceText } from './asset-sources';
import { executeGuardedTool, validateToolArguments } from './guarded-tools';

/**
 * MCP 工具面固定使用英文：这些 description 是给外部 AI 客户端读的（工具名/描述进模型上下文），
 * 不能随界面语言漂移，否则同一套工具在不同语言下行为描述不一致。
 */
const MCP_TEXT_LANGUAGE = 'en' as const;

export interface AgentToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  enum?: readonly string[];
}

export interface AgentToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, AgentToolParameterProperty>;
    required?: readonly string[];
  };
  handler: (args: Record<string, unknown>, kernel: Kernel) => Promise<unknown>;
}

/** Host-provided projection of active declarative extensions into guarded agent tools. */
export interface ExtensionAgentTool {
  packageId: string;
  toolId: string;
  title: string;
  field: string;
  parameter: string;
  parameterType: 'string' | 'number' | 'boolean';
  /** Document operations the tool will submit; the guard evaluates this list. */
  operationKinds: readonly string[];
  active: boolean;
  permissions: readonly string[];
}
export interface AgentToolContext {
  extensions?: () => readonly ExtensionAgentTool[];
  /** Host executor: applies the validated tool argument through the document SDK with a trusted actor. */
  invoke?: (packageId: string, toolId: string, value: string | number | boolean, actor: string) => Promise<unknown>;
}

/** Regex rejecting dangerous words from tool names */
const FORBIDDEN_TOOL_NAME_REGEX = /(?:eval|shell|sql|fs|exec|net|process)/i;

/**
 * Projects registered kernel contributions into agent-callable tools.
 * Dynamically adapts as plugins are registered or unregistered.
 */
export function projectRegistryAsAgentTools(kernel: Kernel, context?: AgentToolContext): readonly AgentToolDeclaration[] {
  const tools: AgentToolDeclaration[] = [];

  // 1. Project Commands into Tools
  const commands = listCommandContributions(kernel);
  for (const cmd of commands) {
    const toolName = `command_${cmd.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    if (FORBIDDEN_TOOL_NAME_REGEX.test(toolName)) {
      continue;
    }
    const commandText = resolveCommandText(cmd.value, MCP_TEXT_LANGUAGE);
    tools.push({
      name: toolName,
      description: commandText.description || commandText.title,
      parameters: {
        type: 'object',
        properties: {},
      },
      handler: async (_, k) => {
        await cmd.value.run(k);
        return { ok: true, executedCommandId: cmd.id };
      },
    });
  }

  // 2. Project AI Providers into Tools
  const providers = listAIProviderContributions(kernel);
  for (const provider of providers) {
    const toolName = `ai_${provider.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    if (FORBIDDEN_TOOL_NAME_REGEX.test(toolName)) {
      continue;
    }
    const providerText = resolveAIProviderText(provider.value, MCP_TEXT_LANGUAGE);
    tools.push({
      name: toolName,
      description: providerText.description || `Generate assets using ${providerText.title}`,
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt text for generation' },
          negativePrompt: { type: 'string', description: 'Negative prompt instructions' },
        },
        required: ['prompt'],
      },
      handler: async (args, k) => {
        const prompt = String(args.prompt || '');
        const negativePrompt = args.negativePrompt ? String(args.negativePrompt) : undefined;
        return provider.value.run({ prompt, negativePrompt }, k);
      },
    });
  }

  // 3. Project Asset Sources into Tools
  const sources = listAssetSourceContributions(kernel);
  for (const source of sources) {
    const toolName = `source_${source.id.replace(/[^a-zA-Z0-9_]/g, '_')}_probe`;
    if (FORBIDDEN_TOOL_NAME_REGEX.test(toolName)) {
      continue;
    }
    const sourceText = resolveAssetSourceText(source.value, MCP_TEXT_LANGUAGE);
    tools.push({
      name: toolName,
      description: `Probe status of external tool ${sourceText.title} (${source.value.endpoint})`,
      parameters: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        return source.value.probeStatus();
      },
    });
  }

  // 4. Project declarative extension tools (V5). They always cross the kernel `hooks` guard chain.
  for (const extension of context?.extensions?.() ?? []) {
    const toolName = `extension_${extension.toolId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    if (FORBIDDEN_TOOL_NAME_REGEX.test(toolName)) continue;
    if (!extension.active) continue;
    if (!extension.permissions.includes('agent.invoke')) continue;
    tools.push({
      name: toolName,
      description: `${extension.title} (extension ${extension.packageId})`,
      parameters: {
        type: 'object',
        properties: {
          [extension.parameter]: { type: extension.parameterType, description: `Extension field "${extension.field}" value` },
        },
        required: [extension.parameter],
      },
      handler: async (args, k) => {
        const validated = validateToolArguments(args, { [extension.parameter]: { type: extension.parameterType } }, [extension.parameter]);
        const value = validated[extension.parameter] as string | number | boolean;
        return executeGuardedTool(k, {
          id: `${extension.packageId}.${extension.toolId}`,
          actor: 'agent',
          args: { ...validated, packageId: extension.packageId, toolId: extension.toolId, surface: 'agent', operationKinds: extension.operationKinds },
        }, async () => {
          if (!context?.invoke) throw new Error('No extension tool executor available');
          return context.invoke(extension.packageId, extension.toolId, value, 'agent');
        }, {
          authorize: () => {
            const current = (context?.extensions?.() ?? []).find(item => item.packageId === extension.packageId && item.toolId === extension.toolId);
            if (!current?.active) throw new Error(`Extension no longer active: ${extension.packageId}`);
            if (!current.permissions.includes('agent.invoke')) throw new Error('Extension lost agent.invoke grant');
          },
          timeoutMs: 15000,
        });
      },
    });
  }

  return tools;
}
