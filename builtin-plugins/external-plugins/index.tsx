/**
 * Install command and sandboxed panel host.
 * Third-party code is not imported by this file.
 */
import React from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import type { CommandDefinition } from '../../plugin-runtime/commands';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import { PLUGIN_PROFILE_MANAGER_SERVICE, type PluginProfileManager } from '../../plugin-runtime/plugin-profile-manager';
import { EXTERNAL_PANELS_SERVICE, type ExternalPanel, type ExternalPanels } from '../../plugin-runtime/external-runtime';
import { PluginErrorBoundary } from '../../plugin-runtime/plugin-error-boundary';
import { CANVAS_MUTATION_SERVICE, type CanvasMutationService } from '../../plugin-runtime/canvas-mutation';
import { createAssetLibraryClient, patchAssetDisplayNames } from '../../plugin-runtime/asset-library-client';
import manifest from './manifest.json';
import { bi } from '../../plugin-runtime/i18n';

const controlInputClass =
  'w-full rounded-md border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-white/25';

/** 声明式交互面板：宿主画控件，按钮动作经主进程回推沙箱 onAction，返回值更新内容区。 */
const PluginSchemaPanelView: React.FC<{ panel: ExternalPanel }> = ({ panel }) => {
  const schema = panel.schema!;
  const [values, setValues] = React.useState<Record<string, string | number | boolean>>(() => {
    const seeded: Record<string, string | number | boolean> = {};
    for (const control of schema.controls) {
      if (control.type !== 'button' && control.type !== 'note' && control.key && control.default !== undefined) {
        seeded[control.key] = control.default;
      }
    }
    return seeded;
  });
  const [content, setContent] = React.useState(schema.content ?? '');
  const [status, setStatus] = React.useState<{ kind: 'notice' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const runAction = async (action: string) => {
    if (!panel.pluginId || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await window.artflowApp?.invokeSandboxedPlugin?.({
        pluginId: panel.pluginId,
        op: 'panel-action',
        panelId: panel.id,
        actionId: action,
        values,
      });
      if (!response?.ok) {
        setStatus({ kind: 'error', text: response?.message || 'panel action failed' });
        return;
      }
      const result = response.result as { notice?: string; error?: string; content?: string } | undefined;
      if (result?.error) setStatus({ kind: 'error', text: result.error });
      else if (result?.notice) setStatus({ kind: 'notice', text: result.notice });
      if (typeof result?.content === 'string') setContent(result.content);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-white/10 bg-zinc-950 p-3 text-neutral-200">
      <div className="text-xs font-medium">{panel.title}</div>
      <div className="flex flex-col gap-2">
        {schema.controls.map(control => {
          if (control.type === 'note') {
            return <div key={control.text} className="text-[11px] leading-relaxed text-neutral-400">{control.text}</div>;
          }
          if (control.type === 'button') {
            return (
              <button
                key={control.key}
                type="button"
                disabled={busy}
                onClick={() => { void runAction(control.action!); }}
                className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
              >{busy ? '…' : control.label}</button>
            );
          }
          const value = control.key ? values[control.key] : undefined;
          const setValue = (next: string | number | boolean) => {
            if (!control.key) return;
            setValues(previous => ({ ...previous, [control.key!]: next }));
          };
          if (control.type === 'toggle') {
            return (
              <label key={control.key} className="flex items-center justify-between gap-2 text-xs">
                <span>{control.label}</span>
                <input type="checkbox" checked={value === true} onChange={event => setValue(event.target.checked)} />
              </label>
            );
          }
          if (control.type === 'select') {
            return (
              <label key={control.key} className="flex flex-col gap-1 text-xs">
                <span>{control.label}</span>
                <select className={controlInputClass} value={String(value ?? '')} onChange={event => setValue(event.target.value)}>
                  {(control.options ?? []).map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            );
          }
          if (control.type === 'number') {
            return (
              <label key={control.key} className="flex flex-col gap-1 text-xs">
                <span>{control.label}</span>
                <input
                  type="number"
                  className={controlInputClass}
                  value={typeof value === 'number' ? value : ''}
                  min={control.min} max={control.max} step={control.step}
                  onChange={event => setValue(event.target.value === '' ? '' : Number(event.target.value))}
                />
              </label>
            );
          }
          const commonProps = {
            className: controlInputClass,
            placeholder: control.placeholder,
            value: typeof value === 'string' ? value : '',
            onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(event.target.value),
          };
          return (
            <label key={control.key} className="flex flex-col gap-1 text-xs">
              <span>{control.label}</span>
              {control.type === 'textarea'
                ? <textarea {...commonProps} rows={3} />
                : <input type="text" {...commonProps} />}
            </label>
          );
        })}
      </div>
      {status && (
        <div className={status.kind === 'error' ? 'text-[11px] text-red-300' : 'text-[11px] text-emerald-300'}>{status.text}</div>
      )}
      {content && (
        <iframe
          title={`${panel.id}-content`}
          sandbox="allow-scripts"
          srcDoc={content}
          className="h-48 w-full rounded-lg border border-white/10 bg-zinc-950"
        />
      )}
    </div>
  );
};

const ExternalPanelView: React.FC<{ kernel: Kernel; panel: ExternalPanel }> = ({ kernel, panel }) => {
  // 无 hooks 的分发壳：schema 面板与 client 面板各自的 hooks 都在自己的组件里。
  if (panel.schema) return <PluginSchemaPanelView panel={panel} />;
  return <ExternalClientPanelView kernel={kernel} panel={panel} />;
};

const ExternalClientPanelView: React.FC<{ kernel: Kernel; panel: ExternalPanel }> = ({ kernel, panel }) => {
  const library = React.useMemo(() => {
    const host = kernel.use(HOST_PLATFORM_SERVICE) as HostPlatformService;
    const mutation = kernel.has(CANVAS_MUTATION_SERVICE)
      ? kernel.use(CANVAS_MUTATION_SERVICE) as CanvasMutationService
      : null;
    return createAssetLibraryClient({
      allowRename: panel.allowRename === true,
      listInventory: request => host.listAssetInventory(request),
      renameNames: request => host.renameAssetNames(request),
      patchCanvasNames: names => {
        if (mutation) patchAssetDisplayNames(mutation, names);
      },
    });
  }, [kernel, panel.allowRename]);
  if (panel.component) {
    const View = panel.component;
    return (
      <div data-bp-ui-panel="" className="max-h-[32rem] w-full overflow-auto rounded-xl border border-white/10 bg-zinc-950 p-3 text-neutral-200">
        <View library={library} />
      </div>
    );
  }
  if (!panel.html) return null;
  return (
    <iframe
      title={panel.title}
      sandbox="allow-scripts"
      srcDoc={panel.html}
      className="h-40 w-full rounded-xl border border-white/10 bg-zinc-950"
    />
  );
};

const EMPTY_PANELS: ExternalPanel[] = [];
const emptySubscribe = () => () => {};

const ExternalPanelsWidget: React.FC<{ kernel: Kernel }> = ({ kernel }) => {
  const service = kernel.has(EXTERNAL_PANELS_SERVICE)
    ? kernel.use(EXTERNAL_PANELS_SERVICE) as ExternalPanels
    : null;
  const panels = React.useSyncExternalStore(
    service ? service.subscribe : emptySubscribe,
    () => service?.current ?? EMPTY_PANELS,
    () => service?.current ?? EMPTY_PANELS,
  );
  if (panels.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-4 z-40 flex w-80 flex-col gap-2">
      {panels.map(panel => (
        // 局部错误边界：外部面板投影处（沙箱面板 / 客户端面板组件）抛错只让这一块面板显示失败占位，
        // 其他外部面板与画布内容不受影响。
        <PluginErrorBoundary key={panel.id} slot="external_panels" pluginId={panel.pluginId} label={panel.id}>
          <ExternalPanelView kernel={kernel} panel={panel} />
        </PluginErrorBoundary>
      ))}
    </div>
  );
};

const installCommand: CommandDefinition = {
  title: bi('安装插件', 'Install plugin'),
  description: bi('把本地插件文件夹复制进沙箱，重新加载后生效。', 'Copy a local plugin folder into the sandbox. Reload applies it.'),
  group: 'Plugins',
  keywords: ['install', 'sandbox', 'external'],
  run: async kernel => {
    if (!kernel.has(HOST_PLATFORM_SERVICE) || !kernel.has(PLUGIN_PROFILE_MANAGER_SERVICE)) return;
    const host = kernel.use(HOST_PLATFORM_SERVICE) as HostPlatformService;
    if (typeof host.installExternalPlugin !== 'function') return;
    const result = await host.installExternalPlugin();
    if (!result.ok) return;
    (kernel.use(PLUGIN_PROFILE_MANAGER_SERVICE) as PluginProfileManager).reload();
  },
};

export const externalPluginsPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    const disposeCommand = ctx.contributions.register<CommandDefinition>('commands', {
      id: 'plugin.install-external',
      pluginId: manifest.id,
      priority: 20,
      value: installCommand,
    });
    const disposeWidget = ctx.contributions.register('canvas_widgets', {
      id: 'builtin.external-plugins.panels',
      pluginId: manifest.id,
      priority: 5,
      value: {
        title: bi('外部扩展面板', 'External panels'),
        bridgeKey: 'diagnostics' as const,
        placement: 'workspace' as const,
        component: ExternalPanelsWidget,
      },
    });
    return () => {
      disposeWidget();
      disposeCommand();
    };
  },
});
