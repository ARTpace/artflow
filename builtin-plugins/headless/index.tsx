/**
 * builtin.headless —— MCP 外壳。
 * 服务在主进程。这里只把 mcp.export 点名的命令交给它，并接住 run 请求。
 */

import React, { useState } from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import { listCommandContributions, invokeCommandContribution, resolveCommandText } from '../../plugin-runtime/commands';
import type { SettingsSectionContribution, SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import { MCP_EXPORT_REGISTRY, type McpExportRegistry } from '../../plugin-runtime/mcp-exports';
import manifest from './manifest.json';

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const UNSAFE_TOOL_NAME = /eval|shell|sql|fs|exec|net|process/i;

const toToolName = (commandId: string): string => commandId.replaceAll('.', '__');

const HeadlessSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const zho = language === 'zho';
  const host: HostPlatformService = kernel.use(HOST_PLATFORM_SERVICE);
  const [url, setUrl] = useState('');
  const [credentials, setCredentials] = useState<{ id: string; name: string; mode: string }[]>([]);
  const [name, setName] = useState('cursor');
  const [mode, setMode] = useState<'read-only' | 'full-access'>('read-only');
  const [token, setToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    const status = await host.getMcpStatus();
    if (status.ok === false) {
      setMessage(status.message);
      return;
    }
    setUrl(status.url);
    setCredentials(status.credentials);
    setMessage(null);
  };

  const copyConfig = async (id: string) => {
    const revealed = await host.revealMcpCredential(id);
    if (revealed.ok === false) {
      setMessage(revealed.message);
      return;
    }
    const config = JSON.stringify({
      mcpServers: {
        artflow: {
          url: revealed.url,
          headers: { Authorization: `Bearer ${revealed.token}` },
        },
      },
    }, null, 2);
    try {
      await navigator.clipboard.writeText(config);
      setMessage(zho ? '已复制 Cursor MCP 配置。' : 'Copied the Cursor MCP config.');
    } catch {
      setToken(revealed.token);
      setMessage(zho ? '剪贴板不可用，令牌显示在下面。' : 'Clipboard unavailable. The token is below.');
    }
  };

  return (
    <div className="space-y-3 text-sm text-neutral-300">
      <p className="leading-5 text-neutral-400">
        {zho
          ? 'MCP 服务只监听本机。工具来自各插件 manifest 里的 mcp.export，不会把未声明的命令暴露出去。'
          : 'The MCP service listens on localhost. Tools come only from each plugin manifest mcp.export list.'}
      </p>
      <button type="button" onClick={() => { void refresh(); }} className="rounded-md bg-violet-500 px-3 py-1.5 text-white">
        {zho ? '读取地址' : 'Load endpoint'}
      </button>
      {url && <p className="break-all font-mono text-xs text-neutral-200">{url}</p>}
      {credentials.length > 0 && (
        <div className="space-y-1">
          {credentials.map(item => (
            <div key={item.id} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2">
              <span className="flex-1 truncate">{item.name}</span>
              <span className="text-neutral-500">{item.mode}</span>
              <button type="button" className="text-violet-300" onClick={() => { void copyConfig(item.id); }}>
                {zho ? '复制配置' : 'Copy config'}
              </button>
              <button
                type="button"
                className="text-red-300"
                onClick={() => { void host.revokeMcpCredential(item.id).then(refresh); }}
              >
                {zho ? '撤销' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          className="rounded-md bg-black/30 px-2 py-1"
          aria-label={zho ? '凭证名称' : 'Credential name'}
        />
        <select
          value={mode}
          onChange={event => setMode(event.target.value === 'full-access' ? 'full-access' : 'read-only')}
          className="rounded-md bg-black/30 px-2 py-1"
        >
          <option value="read-only">read-only</option>
          <option value="full-access">full-access</option>
        </select>
        <button
          type="button"
          className="rounded-md px-3 py-1.5 hover:bg-white/10"
          onClick={() => {
            void host.createMcpCredential({ name, mode }).then(created => {
              if (created.ok === false) {
                setMessage(created.message);
                return;
              }
              setToken(created.token);
              void refresh();
            });
          }}
        >
          {zho ? '新建凭证' : 'New credential'}
        </button>
      </div>
      {token && <p className="break-all font-mono text-xs text-amber-200">{token}</p>}
      {message && <p className="text-amber-200/90">{message}</p>}
    </div>
  );
};

export const headlessPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    // Auxiliary PiP renderers must not own the shared main-process listener/catalog.
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#pip-panel')) return () => {};
    const host = ctx.use(HOST_PLATFORM_SERVICE) as Partial<HostPlatformService>;
    const exports: McpExportRegistry = ctx.has(MCP_EXPORT_REGISTRY)
      ? ctx.use(MCP_EXPORT_REGISTRY)
      : new Map();
    const seen = new Set<string>();
    const catalog = [];
    for (const command of listCommandContributions(ctx)) {
      const allowed = exports.get(command.pluginId);
      if (!allowed?.includes(command.id)) continue;
      const name = toToolName(command.id);
      if (!TOOL_NAME.test(name) || UNSAFE_TOOL_NAME.test(name) || seen.has(name)) continue;
      seen.add(name);
      // MCP 目录固定英文：这份 catalog 会进外部 AI 客户端的上下文，不跟界面语言走。
      const commandText = resolveCommandText(command.value, 'en');
      catalog.push({
        name,
        commandId: command.id,
        title: commandText.title,
        description: commandText.description ?? commandText.title,
        impact: command.value.mcp?.impact === 'read' ? 'read' as const : 'write' as const,
        destructive: command.value.mcp?.destructive === true,
      });
    }
    let disposed = false;
    // Re-activation (including HMR) must restore transport before publishing tools.
    void Promise.resolve(host.setMcpEnabled?.(true)).then(result => {
      if (disposed) return;
      if (result?.ok === false) throw new Error(result.message);
      return host.publishMcpCatalog?.(catalog);
    }).catch(error => console.error('[headless] MCP activation failed:', error));
    const unsubscribe = host.subscribeMcpDispatch?.(async request => {
      if (disposed) return { isError: true, message: 'MCP is disabled' };
      const command = listCommandContributions(ctx).find(item => item.id === request.commandId);
      if (!command || !exports.get(command.pluginId)?.includes(command.id)) {
        return { isError: true, message: 'command is not exported' };
      }
      const ran = await invokeCommandContribution(ctx, command);
      return ran ? { ok: true, commandId: command.id } : { isError: true, message: 'command is disabled' };
    }) ?? (() => {});
    const disposeSection = ctx.contributions.register<SettingsSectionContribution>('settings_sections', {
      id: 'builtin.headless.mcp',
      pluginId: 'builtin.headless',
      priority: 4,
      value: {
        label: lang => (lang === 'zho' ? 'MCP' : 'MCP'),
        component: HeadlessSection,
        navGroup: 'extensions',
      },
    });
    return () => {
      disposed = true;
      unsubscribe();
      void host.setMcpEnabled?.(false).catch(error => console.error('[headless] MCP shutdown failed:', error));
      disposeSection();
    };
  },
});
