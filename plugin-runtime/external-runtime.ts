/**
 * Registers sandboxed third-party contributions.
 * The plugin functions stay in the guest window; this module only stores their catalog.
 */

import type { Kernel } from './kernel';
import type { CommandDefinition } from './commands';
import type { FormatHandler, FormatParseResult } from './format-handlers';
import type { AssetSourceDefinition, AssetSourceGenerationResult } from './asset-sources';
import { materializeRendererContributions } from './renderer-materialization';
import React from 'react';
import { evaluateClientSource } from '../sandbox/client-module';
import { isExternalPluginEnabledById } from './external-plugin-prefs';

export const EXTERNAL_PANELS_SERVICE = 'external.panels';

export interface ExternalPanel {
  id: string;
  title: string;
  html?: string;
  /** 声明式交互面板（api.ui.registerPanel）：宿主渲染控件，动作回调回沙箱。 */
  schema?: {
    controls: Array<{
      type: 'text' | 'textarea' | 'toggle' | 'number' | 'select' | 'button' | 'note';
      key?: string;
      label?: string;
      text?: string;
      placeholder?: string;
      action?: string;
      options?: Array<{ value: string; label: string }>;
      min?: number; max?: number; step?: number;
      default?: string | number | boolean;
    }>;
    content?: string;
  };
  pluginId?: string;
  component?: React.ComponentType<{ library: import('./asset-library-client').AssetLibraryClient }>;
  allowRename?: boolean;
}

export interface ExternalPanels {
  readonly current: ExternalPanel[];
  subscribe(listener: () => void): () => void;
  replace(next: ExternalPanel[]): void;
}

export function createExternalPanels(): ExternalPanels {
  let current: ExternalPanel[] = [];
  const listeners = new Set<() => void>();
  return {
    get current() { return current; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    replace(next) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface SandboxedPluginCatalog {
  id: string;
  name: string;
  error?: string;
  formats: Array<{ id: string; extensions: string[] }>;
  commands: Array<{ id: string; title: string; description?: string }>;
  assets?: Array<{ id: string; title: string; canSubmit: boolean }>;
  panels: ExternalPanel[];
}

const invoke = (message: Record<string, unknown>) => window.artflowApp?.invokeSandboxedPlugin?.(message);

/**
 * 上一轮激活注册过、尚未回收的贡献 disposer，按注册顺序累积。
 * 崩溃重建后必须先全部回收再重新注册 —— 理由见 disposeExternalContributions。
 */
let contributionDisposers: Array<() => void> = [];

/** 记录一次注册的回收器（注册点分散在 client / catalog 两条路径上，统一收在一处）。 */
function trackContribution(dispose: () => void): void {
  contributionDisposers.push(dispose);
}

/**
 * 回收上一轮注册的全部沙箱贡献。
 *
 * 为什么必须先回收再重新激活：ContributionRegistry.register 撞到重复 id 会**抛错**
 * （实现级查重闸），而 catalog 侧的注册整批没有逐项兜底 —— 沙箱宿主崩溃重建后若直接
 * 重放激活，第一个撞 id 的格式处理器就会让整批（格式处理器 / 命令 / 资产源）一个都
 * 注册不上，表现是"插件崩溃过一次之后，命令和格式支持就永久消失了"。
 * client 侧的注册虽然有 per-client try/catch，但同一插件的卡片/覆盖层也会整体退化。
 */
function disposeExternalContributions(): void {
  const disposers = contributionDisposers;
  contributionDisposers = [];
  for (const dispose of disposers) {
    try {
      dispose();
    } catch (error) {
      console.warn('[external-plugins] contribution dispose failed', error);
    }
  }
}

async function loadClientPanels(kernel: Kernel): Promise<ExternalPanel[]> {
  const readClients = window.artflowApp?.readPluginClients;
  if (!readClients) return [];
  const { clients } = await readClients();
  const collected: ExternalPanel[] = [];
  for (const client of clients) {
    if (!isExternalPluginEnabledById(client.id)) continue;
    try {
      // unrestricted 存储服务：按插件绑定 pluginId（跨插件互读被主进程拒绝），ref 是内容寻址哈希。
      // 显式比较窄化：项目未开 strictNullChecks，`!response.ok` 真值窄化不可用（TS#12745）。
      const storage = {
        read: async (ref: string) => {
          const response = await window.artflowApp?.readStored?.({ pluginId: client.id, ref });
          if (!response) throw new Error('storage bridge is unavailable');
          if (response.ok === false) throw new Error(response.message);
          return response.bytes;
        },
        readPage: async (ref: string, index: number) => {
          const response = await window.artflowApp?.readPluginPage?.({ pluginId: client.id, ref, index });
          if (!response) throw new Error('storage bridge is unavailable');
          if (response.ok === false) throw new Error(response.message);
          return { bytes: response.bytes, mimeType: response.mimeType };
        },
      };
      const evaluated = evaluateClientSource(client.source, client.id, React, storage);
      for (const card of evaluated.cards) {
        trackContribution(kernel.contributions.register('canvas_node_types', {
          id: card.nodeType,
          pluginId: client.id,
          priority: 10,
          value: { nodeType: card.nodeType, component: card.component },
        }));
      }
      for (const overlay of evaluated.overlays) {
        trackContribution(kernel.contributions.register('canvas_overlays', {
          id: overlay.id,
          pluginId: client.id,
          priority: 10,
          value: { component: overlay.component },
        }));
      }
      for (const panel of evaluated.panels) {
        collected.push({
          id: panel.id,
          title: panel.title,
          component: panel.component,
          allowRename: client.library === true,
          // 归属插件：外部面板的实际渲染点在宿主壳里，失败占位/日志要靠它指认是哪个插件。
          pluginId: client.id,
        });
      }
    } catch (error) {
      console.warn(`[external-plugins] ${client.id} client.js failed`, error);
    }
  }
  if (clients.length > 0) materializeRendererContributions(kernel);
  return collected;
}

/**
 * 激活串行链。两个入口（启动装载 / 宿主换代重放）可能重叠：并行跑时后一次开头的
 * disposeExternalContributions 会把前一次刚注册的贡献回收掉，前一次的注册随后又会
 * 撞 duplicate id 抛错 —— 队列化让"回收 → 重新注册"始终成对出现。
 */
let activationChain: Promise<void> = Promise.resolve();

export function activateExternalPlugins(kernel: Kernel, panels: ExternalPanels): Promise<void> {
  const task = activationChain.then(() => runActivation(kernel, panels));
  // 链上只关心"排完队"，单次失败不能把后续激活一起卡死（失败已各自 console.warn）。
  activationChain = task.then(() => undefined, () => undefined);
  return task;
}

async function runActivation(kernel: Kernel, panels: ExternalPanels): Promise<void> {
  // 先回收上一轮注册的贡献：这一句是"沙箱宿主崩溃后重新激活"能成立的前提，
  // 缺了它，重放注册会撞 duplicate contribution 抛错并让整批贡献丢失。
  disposeExternalContributions();
  const clientTask = loadClientPanels(kernel).catch(error => {
    console.warn('[external-plugins] client panels skipped', error);
    return [] as ExternalPanel[];
  });
  const catalogTask = loadSandboxCatalog(kernel).catch(error => {
    console.warn('[external-plugins] sandbox catalog skipped', error);
    return [] as ExternalPanel[];
  });
  const clientPanels = await clientTask;
  const catalogPanels = await catalogTask;
  // 统一用并集覆盖（而不是"catalog 为空就不覆盖"）：宿主崩溃重建期间 catalog 可能先返回空，
  // 若沿用旧写法，渲染层会继续展示上一代宿主留下的面板 —— 点下去是死引用。
  panels.replace(catalogPanels.length > 0 ? [...catalogPanels, ...clientPanels] : clientPanels);
}

/**
 * 订阅"沙箱宿主换代"通知（主进程在宿主渲染进程崩溃重建后推送），并自动重新激活一遍。
 * 返回退订函数；宿主不存在该桥（浏览器 harness / 旧 preload）时返回空退订函数。
 *
 * 为什么渲染层必须参与：沙箱窗口换了之后，面板的组件、命令的 run()、格式处理器的 parse()
 * 全是往旧窗口发消息的死引用 —— 主进程侧重建完，渲染层不重放激活，用户看到的就是
 * "插件崩溃过一次之后，它的面板和命令就再也没反应了"。
 *
 * 重入保护：主进程同一时间窗内最多自动重建 MAX_AUTO_REBUILDS 次，但通知仍可能连续到达；
 * 而两次激活并行跑会互相回收对方刚注册的贡献，所以这里串行化，丢掉的后续通知由
 * "最后那次激活读到的就是最新宿主"兜住。
 */
export function watchSandboxHostRestart(kernel: Kernel, panels: ExternalPanels): () => void {
  const subscribe = window.artflowApp?.onSandboxHostRestarted;
  if (!subscribe) return () => {};
  let inFlight = false;
  return subscribe(info => {
    const reason = info?.reason || 'unknown';
    if (inFlight) {
      console.warn(`[external-plugins] sandbox host restart (${reason}) coalesced into the running re-activation`);
      return;
    }
    inFlight = true;
    console.warn(`[external-plugins] sandbox host restarted (${reason}); re-activating contributions`);
    void activateExternalPlugins(kernel, panels)
      .catch(error => {
        console.warn('[external-plugins] re-activation after host restart failed', error);
      })
      .then(() => {
        inFlight = false;
      });
  });
}

async function loadSandboxCatalog(kernel: Kernel): Promise<ExternalPanel[]> {
  const list = window.artflowApp?.listSandboxedPlugins;
  if (!list) return [];
  const result = await list();
  const collected: ExternalPanel[] = [];
    for (const plugin of result.plugins) {
      if (!isExternalPluginEnabledById(plugin.id)) continue;
      if (plugin.error) {
        console.warn(`[external-plugins] ${plugin.id} did not activate: ${plugin.error}`);
      }
      for (const format of plugin.formats) {
        const handler: FormatHandler = {
          id: format.id,
          extensions: format.extensions,
          outputKind: 'card',
          category: 'document',
          parse: async file => {
            const response = await invoke({
              pluginId: plugin.id,
              op: 'parse',
              handlerId: format.id,
              name: file.name,
              mimeType: file.type,
              bytes: new Uint8Array(await file.arrayBuffer()),
            });
            if (!response?.ok || !response.result) throw new Error(response?.message || 'sandboxed parse failed');
            return response.result as FormatParseResult;
          },
        };
        trackContribution(kernel.contributions.register<FormatHandler>('format_handlers', {
          id: format.id,
          pluginId: plugin.id,
          priority: 30,
          value: handler,
        }));
      }
      for (const command of plugin.commands) {
        const definition: CommandDefinition = {
          title: command.title,
          description: command.description,
          group: plugin.name,
          run: async () => {
            const response = await invoke({ pluginId: plugin.id, op: 'command', commandId: command.id });
            if (!response?.ok) console.warn(`[external-plugins] ${command.id}: ${response?.message || 'failed'}`);
          },
        };
        trackContribution(kernel.contributions.register<CommandDefinition>('commands', {
          id: command.id,
          pluginId: plugin.id,
          priority: 15,
          value: definition,
        }));
      }
      for (const asset of plugin.assets ?? []) {
        const definition: AssetSourceDefinition = {
          title: asset.title,
          endpoint: `sandbox:${asset.id}`,
          namespacePrefix: `${plugin.id}.`,
          probeStatus: async () => {
            const response = await invoke({ pluginId: plugin.id, op: 'asset-probe', sourceId: asset.id });
            const status = response?.result as { online?: boolean; endpoint?: string; message?: string } | undefined;
            if (!response?.ok || !status) {
              return { online: false, endpoint: `sandbox:${asset.id}`, message: response?.message || 'probe failed' };
            }
            return {
              online: Boolean(status.online),
              endpoint: status.endpoint || `sandbox:${asset.id}`,
              message: status.message,
            };
          },
          ...(asset.canSubmit ? {
            submitWorkflow: async submission => {
              const response = await invoke({
                pluginId: plugin.id,
                op: 'asset-submit',
                sourceId: asset.id,
                submission: { prompt: submission.prompt, parameters: submission.parameters },
              });
              if (!response?.ok || !response.result) throw new Error(response?.message || 'submit failed');
              return response.result as AssetSourceGenerationResult;
            },
          } : {}),
        };
        trackContribution(kernel.contributions.register<AssetSourceDefinition>('asset_sources', {
          id: asset.id,
          pluginId: plugin.id,
          priority: 10,
          value: definition,
        }));
      }
      collected.push(...plugin.panels.map(panel => ({ ...panel, pluginId: plugin.id })));
    }
  return collected;
}
