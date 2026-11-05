import React, { useEffect, useMemo, useState } from 'react';
import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import {
  PLUGIN_PROFILE_MANAGER_SERVICE,
  type PluginProfileManager,
  type PluginProfileManagerSnapshot,
} from '../../plugin-runtime/plugin-profile-manager';
import type { SettingsSectionProps, SettingsSectionContribution } from '../../plugin-runtime/settings-contributions';
import type { PluginPanelContribution, PluginPanelProps } from '../../plugin-runtime/panel-contributions';
import { useLanguage } from '../../utils/language-store';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import {
  clearBrowserDisabledExternalPlugins,
  readBrowserDisabledExternalPluginIds,
  readStartupDisabledExternalPluginIds,
  setBrowserExternalPluginEnabled,
} from '../../plugin-runtime/external-plugin-prefs';
import { EXTENSION_RUNTIME_SERVICE, type ExtensionRuntimeService } from '../../plugin-runtime/extension-service';
import { CompactPluginRow, HoverInfoButton } from './compact-row';
import { InlinePluginDetails } from './details-dialog';
import { PluginSettingsForm, type SettingsTab } from './settings-form';
import { resolveManifestText, type LocalizedManifestText } from '../../plugin-runtime/i18n';
import type { InstalledPackage } from '../../plugin-runtime/extension-package';
import { filterPluginCatalog, isEditableMode, isInfrastructureBuiltin, needsPluginReload, sourceBucketOf, type CatalogSourceFilter, type CatalogStatusFilter, type PluginCatalogEntry } from './catalog';
import { PackageInstaller, PackageRows } from './extension-packages';
import { PluginDevGuide } from './dev-guide';

const copyFor = (language: SettingsSectionProps['language']) => language === 'zho' ? {
  label: '插件与扩展',
  heading: '插件与扩展',
  panelHint: '悬浮管理窗口：查看已安装、开关状态和安装操作',
  help: '悬停查看插件管理说明',
  lastAction: '最近完成的操作',
  details: '查看详情与设置',
  closeDetails: '关闭插件详情',
  pendingShort: '待重载',
  reloadShort: '重新加载',
  intro: '本体基础功能不列入插件开关。可选插件开关和设置即时保存。内置与外部插件要重新加载才会按新设置装载；JSON 扩展包的操作即时生效。“本次启动”显示启动时的设置，不保证插件已成功运行。',
  allSources: '全部',
  builtinTab: '内置插件',
  externalTab: '外部插件',
  packageTab: 'JSON 扩展包',
  builtinGroup: '内置插件',
  editableGroup: '可编辑插件',
  advancedGroup: '平台组件 · 高级',
  advancedHint: '这里仅列可选能力；基础设置、恢复入口和界面外壳属于本体，不参与插件启停。',
  advancedToggle: '平台组件',
  sourceFilter: '按来源筛选',
  showAdvanced: '展开平台组件',
  hideAdvanced: '收起平台组件',
  statusFilter: '状态筛选',
  allStatuses: '全部状态',
  pendingOnly: '待重新加载',
  countSummary: (total: number, enabled: number, pending: number) => `已安装 ${total} · 开关开启 ${enabled} · 待重载 ${pending}`,
  startupEnabled: '本次启动：设为启用',
  startupDisabled: '本次启动：设为停用',
  packageLive: '即时生效',
  packageInstall: '安装 JSON 扩展包',
  devGuide: '插件开发指南',
  noPackages: '还没有安装 JSON 扩展包',
  packageUnavailable: '当前无法读取 JSON 扩展包：',
  packageHostDisabled: '核心扩展宿主本次启动未启用。JSON 包可管理，但关联命令等能力需启用宿主并重新加载。',
  externalLoading: '正在读取外部插件…',
  externalUnavailable: '当前无法读取外部插件：',
  installReloads: '安装或卸载外部插件后会自动重新加载。',
  modeSandbox: '沙箱',
  modeDeclarative: '声明式',
  permissions: '权限',
  active: '当前已启用',
  inactive: '当前未启用',
  nextEnable: '重新加载后启用',
  nextDisable: '重新加载后停用',
  enabled: '已启用',
  disabled: '已停用',
  protected: '保留以确保可恢复管理',
  needsReload: '开关/设置已保存，重新加载后生效（JSON 扩展包已即时生效）',
  reload: '重新加载以生效',
  resetBuiltin: '清除内置开关覆盖',
  resetBuiltinShort: '↺ 内置',
  resetExternal: '清除第三方开关覆盖',
  resetExternalShort: '↺ 三方',
  more: '更多操作',
  search: '搜索插件、扩展包或标识…',
  expand: '展开详情',
  collapse: '收起详情',
  host: '宿主',
  capabilities: '能力',
  requires: '依赖',
  requiredBy: '被依赖于',
  includes: '整合了',
  disableConfirm: (name: string, dependents: string) => `停用「${name}」将同时停用以下依赖插件：${dependents}。\n画布节点数据会保留，重新加载后生效。确定继续？`,
  budget: '资源预算',
  type: '类型',
  maintainer: '维护者',
  file: '文件',
  openFolder: '打开插件文件夹',
  pathUnavailable: '浏览器模式不可用',
  noDescription: '无简介',
  none: '无',
  noBudget: '未声明',
  storageWarning: '已忽略无效的已保存插件配置：',
  failedToLoad: '加载失败的插件',
  staged: '已暂存；重新加载后生效。',
  noMatch: '没有匹配的插件',
  categoryOther: '其他',
  config: '配置',
  configLive: '配置已立即保存。',
  configStaged: '配置已立即保存；重新加载后插件将按新配置装载。',
  configFailed: '配置保存失败：',
  install: '安装插件',
  uninstall: '卸载',
  uninstallConfirm: (id: string) => `确定卸载 ${id}？画布上已有的节点数据会保留。`,
  settingsSaved: '已保存',
  settingsSaveFailed: '保存失败',
  settingsRun: '运行',
  installed: '第三方',
  installHint: '选择含 manifest.json 的文件夹；安装完成会重新加载。第三方开关即时保存，重新加载后生效。',
  noExternal: '还没有外部插件',
} : {
  label: 'Plugins & extensions',
  heading: 'Plugins & extensions',
  panelHint: 'Floating manager: installed items, switch states and installation',
  help: 'Hover for plugin management help',
  lastAction: 'Most recent completed action',
  details: 'View details and settings',
  closeDetails: 'Close plugin details',
  pendingShort: 'Reload needed',
  reloadShort: 'Reload',
  intro: 'Host foundations are not plugin switches. Optional plugin switches and settings save immediately. Builtin and external plugins load with new settings after a reload; JSON package changes apply immediately. “At startup” describes the startup preference, not a guarantee that code loaded successfully.',
  allSources: 'All',
  builtinTab: 'Builtin plugins',
  externalTab: 'External plugins',
  packageTab: 'JSON packages',
  builtinGroup: 'Builtin plugins',
  editableGroup: 'Editable plugins',
  advancedGroup: 'Platform components · advanced',
  advancedHint: 'Only optional capabilities are listed. Settings, recovery and the base UI belong to the host.',
  advancedToggle: 'Platform',
  sourceFilter: 'Filter by source',
  showAdvanced: 'Show platform components',
  hideAdvanced: 'Hide platform components',
  statusFilter: 'Filter by status',
  allStatuses: 'All statuses',
  pendingOnly: 'Reload required',
  countSummary: (total: number, enabled: number, pending: number) => `${total} installed · ${enabled} switches on · ${pending} awaiting reload`,
  startupEnabled: 'At startup: set to enabled',
  startupDisabled: 'At startup: set to disabled',
  packageLive: 'Applies immediately',
  packageInstall: 'Install JSON package',
  devGuide: 'Plugin dev guide',
  noPackages: 'No JSON packages installed yet',
  packageUnavailable: 'Cannot read JSON packages:',
  packageHostDisabled: 'The core extension host was off at startup. Packages remain manageable, but their commands require enabling the host and reloading.',
  externalLoading: 'Loading external plugins…',
  externalUnavailable: 'Cannot read external plugins:',
  installReloads: 'Installing or uninstalling an external plugin reloads the app.',
  modeSandbox: 'Sandbox',
  modeDeclarative: 'Declarative',
  permissions: 'Permissions',
  active: 'Active now',
  inactive: 'Inactive now',
  nextEnable: 'Enables after reload',
  nextDisable: 'Disables after reload',
  enabled: 'Enabled',
  disabled: 'Disabled',
  protected: 'Kept available for recovery',
  needsReload: 'Switches/settings saved; reload to apply them (JSON packages already applied)',
  reload: 'Reload to apply',
  resetBuiltin: 'Clear builtin switch overrides',
  resetBuiltinShort: '↺ Builtin',
  resetExternal: 'Clear third-party switch overrides',
  resetExternalShort: '↺ Third-party',
  more: 'More actions',
  search: 'Search plugins, packages or IDs…',
  expand: 'Expand details',
  collapse: 'Collapse details',
  host: 'Host',
  capabilities: 'Capabilities',
  requires: 'Requires',
  requiredBy: 'Required by',
  includes: 'Includes',
  disableConfirm: (name: string, dependents: string) => `Disabling ${name} also disables these dependent plugins: ${dependents}.\nCanvas node data is retained. Changes apply after reload. Continue?`,
  budget: 'Resource budget',
  type: 'Type',
  maintainer: 'Maintainer',
  file: 'File',
  openFolder: 'Open plugin folder',
  pathUnavailable: 'Unavailable in browser mode',
  noDescription: 'No description',
  none: 'None',
  noBudget: 'Not declared',
  storageWarning: 'An invalid saved plugin preference was ignored:',
  failedToLoad: 'Plugins that failed to load',
  staged: 'Staged. Reload to apply it.',
  noMatch: 'No matching plugins',
  categoryOther: 'Other',
  config: 'Configuration',
  configLive: 'Configuration saved immediately.',
  configStaged: 'Configuration saved immediately. Reload to load the plugin with these settings.',
  configFailed: 'Could not save configuration:',
  install: 'Install plugin',
  uninstall: 'Uninstall',
  uninstallConfirm: (id: string) => `Uninstall ${id}? Nodes already on the canvas will keep their data.`,
  settingsSaved: 'Saved',
  settingsSaveFailed: 'Save failed',
  settingsRun: 'Run',
  installed: 'Third-party',
  installHint: 'Choose a folder containing manifest.json; installation reloads the app. Third-party switches save immediately and apply after reload.',
  noExternal: 'No external plugins yet',
};

/** 分组标签（manifest.category）；与 plugins/manifest.ts PLUGIN_CATEGORIES 对齐。 */
const CATEGORY_LABELS: Record<string, { zho: string; en: string }> = {
  format: { zho: '格式解析', en: 'Formats' },
  canvas: { zho: '画布内容', en: 'Canvas' },
  ui: { zho: '界面与外壳', en: 'Interface' },
  ai: { zho: 'AI 生成', en: 'AI' },
  skin: { zho: '皮肤主题', en: 'Skins' },
  workspace: { zho: '工作台', en: 'Workspace' },
  other: { zho: '其他', en: 'Other' },
};

const CATEGORY_ORDER = ['format', 'canvas', 'ui', 'ai', 'skin', 'workspace', 'other'] as const;

const categoryLabel = (category: string, language: SettingsSectionProps['language']): string => {
  const entry = CATEGORY_LABELS[category] ?? CATEGORY_LABELS.other;
  return language === 'zho' ? entry.zho : entry.en;
};

const budgetLabel = (budget: { maxActiveInstances?: number; maxConcurrentJobs?: number; maxMemoryMB?: number } | undefined, language: SettingsSectionProps['language']): string => {
  if (!budget) return language === 'zho' ? '未声明' : 'Not declared';
  const values = [
    budget.maxActiveInstances && (language === 'zho' ? `${budget.maxActiveInstances} 实例` : `${budget.maxActiveInstances} instances`),
    budget.maxConcurrentJobs && (language === 'zho' ? `${budget.maxConcurrentJobs} 任务` : `${budget.maxConcurrentJobs} jobs`),
    budget.maxMemoryMB && `${budget.maxMemoryMB} MB`,
  ].filter(Boolean);
  return values.join(' · ') || (language === 'zho' ? '未声明' : 'Not declared');
};

const PluginManagerSettingsSection: React.FC<SettingsSectionProps> = ({ kernel, language }) => {
  const manager = kernel.use(PLUGIN_PROFILE_MANAGER_SERVICE) as PluginProfileManager;
  const hostPlatform = kernel.use(HOST_PLATFORM_SERVICE) as HostPlatformService;
  const packageService = kernel.has(EXTENSION_RUNTIME_SERVICE)
    ? kernel.use(EXTENSION_RUNTIME_SERVICE) as ExtensionRuntimeService : null;
  const [snapshot, setSnapshot] = useState<PluginProfileManagerSnapshot>(() => manager.getSnapshot());
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSuccess, setLastSuccess] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CatalogStatusFilter>('all');
  const [source, setSource] = useState<Exclude<CatalogSourceFilter, 'all'>>('builtin');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPackageInstaller, setShowPackageInstaller] = useState(false);
  const [showDevGuide, setShowDevGuide] = useState(false);
  const [activeDetails, setActiveDetails] = useState<{ source: 'builtin' | 'external'; id: string } | null>(null);
  const [externalPlugins, setExternalPlugins] = useState<Array<{ id: string; name: string; mode: 'declarative' | 'sandboxed'; description?: string; permissions?: string[] }>>([]);
  const [externalLoad, setExternalLoad] = useState<{ status: 'loading' | 'ok' | 'error'; message?: string }>({ status: 'loading' });
  const [, refreshPackages] = useState(0);
  const [disabledIds, setDisabledIds] = useState<string[]>(() => readBrowserDisabledExternalPluginIds());
  // Captured in index.tsx at bootstrap; never re-derived from a changed preference on navigation.
  const appliedDisabled = readStartupDisabledExternalPluginIds();
  const copy = copyFor(language);

  // 插件名/简介按当前语言解析：manifest 的 name / description 是中文基准，
  // nameI18n / descriptionI18n 提供其它语言覆盖；第三方插件没有覆盖表时自然回落。
  // 必须声明在上面的 useMemo 之前 —— useMemo 回调在本次 render 内立即执行，否则会撞 TDZ。
  const displayName = (plugin: { name: string; nameI18n?: LocalizedManifestText }) =>
    resolveManifestText(plugin.name, plugin.nameI18n, language);
  const displayDescription = (plugin: { description?: string; descriptionI18n?: LocalizedManifestText }) => {
    const override = plugin.descriptionI18n?.[language];
    return typeof override === 'string' && override.trim().length > 0 ? override : plugin.description;
  };
  /** 聚合插件的子模块元数据（contributes.builtinModules）。 */
  const displayModules = (plugin: { contributes?: { builtinModules?: Array<{ id: string; name: string; nameI18n?: LocalizedManifestText; description?: string; descriptionI18n?: LocalizedManifestText }> } }) =>
    plugin.contributes?.builtinModules ?? [];
  const moduleName = (module: { name: string; nameI18n?: LocalizedManifestText }) =>
    resolveManifestText(module.name, module.nameI18n, language);

  useEffect(() => {
    setSnapshot(manager.getSnapshot());
    setNotice(null);
  }, [manager]);

  useEffect(() => {
    let mounted = true;
    setExternalLoad({ status: 'loading' });
    void hostPlatform.listExternalPlugins().then(result => {
      if (!mounted) return;
      if (result.ok) {
        setExternalPlugins(result.plugins);
        setExternalLoad({ status: 'ok' });
      } else setExternalLoad({ status: 'error', message: 'message' in result ? result.message : '' });
    }).catch(error => {
      if (mounted) setExternalLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return () => { mounted = false; };
  }, [hostPlatform]);

  useEffect(() => packageService?.runtime.subscribe(() => refreshPackages(tick => tick + 1)), [packageService]);

  // —— 沙箱插件的声明式设置页（api.ui.registerSettingsTab）——
  // 打开某个外部插件详情时按需拉一次运行时 catalog：settingsTabs 是激活期贡献，
  // 不在 manifest 里。listSandboxedPlugins 会触发全量重激活，所以只在打开详情时调。
  const [sandboxSettingsTab, setSandboxSettingsTab] = useState<{ pluginId: string; tab: SettingsTab } | null>(null);
  useEffect(() => {
    if (activeDetails?.source !== 'external') {
      setSandboxSettingsTab(null);
      return;
    }
    const target = externalPlugins.find(plugin => plugin.id === activeDetails.id);
    if (!target || target.mode !== 'sandboxed') {
      setSandboxSettingsTab(null);
      return;
    }
    let alive = true;
    void window.artflowApp?.listSandboxedPlugins?.().then(result => {
      if (!alive) return;
      const found = result?.plugins?.find(plugin => plugin.id === activeDetails.id);
      const tab = found?.settingsTabs?.[0];
      setSandboxSettingsTab(tab ? { pluginId: activeDetails.id, tab: tab as SettingsTab } : null);
    });
    return () => { alive = false; };
  }, [activeDetails, externalPlugins]);

  const runSandboxCommand = (pluginId: string, commandId: string) => {
    void window.artflowApp?.invokeSandboxedPlugin?.({ pluginId, op: 'command', commandId }).then(response => {
      if (!response?.ok) setNotice(`${commandId}: ${response?.message || 'command failed'}`);
    });
  };
  // The runtime is the source of truth for JSON packages; subscribe above refreshes this read.
  let installedPackages: readonly InstalledPackage[] = [];
  let packageError: string | null = null;
  try { installedPackages = packageService?.runtime.installed() ?? []; }
  catch (error) { packageError = error instanceof Error ? error.message : String(error); }

  const installExternal = async () => {
    if (typeof hostPlatform.installExternalPlugin !== 'function') return;
    const result = await hostPlatform.installExternalPlugin();
    if (!result.ok) {
      if (result.message && result.message !== 'cancelled') setNotice(result.message);
      return;
    }
    manager.reload();
  };

  const uninstallExternal = async (id: string) => {
    if (typeof hostPlatform.uninstallExternalPlugin !== 'function') return;
    if (!window.confirm(copy.uninstallConfirm(id))) return;
    try {
      const result = await hostPlatform.uninstallExternalPlugin(id);
      if (!result.ok) {
        setNotice(result.message ?? copy.configFailed);
        return;
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : copy.configFailed);
      return;
    }
    manager.reload();
  };

  const activeById = useMemo(
    () => new Map(snapshot.activeProfile.plugins.map(plugin => [plugin.id, plugin])),
    [snapshot.activeProfile],
  );
  const requiredBy = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const plugin of snapshot.pendingProfile.plugins) {
      for (const requiredId of plugin.requires) {
        const entries = result.get(requiredId) ?? [];
        entries.push(plugin.id);
        result.set(requiredId, entries);
      }
    }
    return result;
  }, [snapshot.pendingProfile]);

  // One catalog/filter for all three sources; grouping is presentation, not navigation.
  const catalog: PluginCatalogEntry[] = useMemo(() => [
    // profile 里的插件按 manifest 自报的 runtime.mode 再分一道：editable 的源码在
    // userData/plugins/builtin/ 下，用户能直接改，归入「可编辑插件」；其余（builtin）才是编译进本体的内置功能。
    ...snapshot.pendingProfile.plugins.map(plugin => ({
      id: plugin.id, source: isEditableMode(plugin.runtimeMode) ? ('editable' as const) : ('builtin' as const),
      name: displayName(plugin),
      description: displayDescription(plugin), enabled: plugin.enabled,
      startupEnabled: activeById.get(plugin.id)?.enabled ?? false,
    })),
    ...externalPlugins.map(plugin => ({
      id: plugin.id, source: 'external' as const, name: displayName(plugin),
      description: plugin.description, enabled: !disabledIds.includes(plugin.id),
      startupEnabled: !appliedDisabled.includes(plugin.id),
    })),
    ...installedPackages.map(entry => ({
      id: entry.package.id, source: 'package' as const, name: entry.package.name,
      enabled: entry.enabled,
    })),
  ], [snapshot.pendingProfile, activeById, externalPlugins, disabledIds, installedPackages, language]);
  const filtered = filterPluginCatalog(catalog, { source, status: statusFilter, query });
  const visibleKeys = new Set(filtered.map(entry => `${entry.source}:${entry.id}`));
  // 「内置插件」与「外部插件」共用同一份 profile 插件列表，只是档位不同。
  const visiblePlugins = snapshot.pendingProfile.plugins.filter(plugin =>
    visibleKeys.has(`builtin:${plugin.id}`) || visibleKeys.has(`editable:${plugin.id}`));
  // 「平台组件 · 高级」只在真·内置档里折叠；外部档要一次看完可编辑包，不做折叠。
  const isEditableTab = source === 'external';
  const mainPlugins = isEditableTab ? visiblePlugins : visiblePlugins.filter(plugin => !isInfrastructureBuiltin(plugin.id));
  const advancedPlugins = isEditableTab ? [] : visiblePlugins.filter(plugin => isInfrastructureBuiltin(plugin.id));
  const visibleExternal = externalPlugins.filter(plugin => visibleKeys.has(`external:${plugin.id}`));
  const visiblePackages = installedPackages.filter(entry => visibleKeys.has(`package:${entry.package.id}`));
  const pendingCount = catalog.filter(needsPluginReload).length;
  // 两档计数（2026-10-11）：外部档 = 可编辑包 + 声明式/沙箱包 + JSON 扩展包。
  const sourceCount = (selected: CatalogSourceFilter) => selected === 'all'
    ? catalog.length : catalog.filter(entry => sourceBucketOf(entry.source) === selected).length;

  const groupedPlugins = useMemo(() => {
    const groups = new Map<string, typeof mainPlugins>();
    for (const plugin of mainPlugins) {
      const key = plugin.category ?? 'other';
      const entries = groups.get(key) ?? [];
      entries.push(plugin);
      groups.set(key, entries);
    }
    return CATEGORY_ORDER
      .filter(category => groups.has(category))
      .map(category => ({ category, plugins: groups.get(category)!.sort((a, b) => displayName(a).localeCompare(displayName(b))) }));
  }, [mainPlugins, language]);
  const builtinGroups = [
    ...groupedPlugins,
    ...(advancedPlugins.length > 0 ? [{ category: '__advanced__', plugins: [...advancedPlugins].sort((a, b) => displayName(a).localeCompare(displayName(b))) }] : []),
  ];
  const advancedForced = query.trim().length > 0 || statusFilter !== 'all';

  const pluginName = (id: string) => {
    const plugin = snapshot.pendingProfile.plugins.find(entry => entry.id === id);
    return plugin ? displayName(plugin) : id;
  };

  const applyEnabled = (id: string, enabled: boolean) => {
    const dependentIds = enabled ? [] : manager.getDisableDependents(id);
    if (dependentIds.length > 0 && !hostPlatform.confirm(copy.disableConfirm(
      pluginName(id), dependentIds.map(pluginName).join('、'),
    ))) return;
    const result = manager.setPluginEnabled(id, enabled,
      dependentIds.length > 0 ? { confirmedDependentIds: dependentIds } : undefined);
    setSnapshot(result.snapshot);
    setNotice('message' in result ? result.message : null);
  };

  const sameIds = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every(id => right.includes(id));

  const clearBuiltinOverrides = () => {
    const result = manager.clearEnabledOverrides();
    setSnapshot(result.snapshot);
    setNotice('message' in result ? result.message : null);
  };

  const clearExternalOverrides = () => {
    try {
      clearBrowserDisabledExternalPlugins();
      setDisabledIds([]);
      setNotice(null);
    } catch (error) { setNotice(`${copy.configFailed} ${error instanceof Error ? error.message : String(error)}`); }
  };

  const applyExternalEnabled = (id: string, enabled: boolean) => {
    try {
      const next = setBrowserExternalPluginEnabled(id, enabled);
      setDisabledIds(next);
      setNotice(null);
    } catch (error) { setNotice(`${copy.configFailed} ${error instanceof Error ? error.message : String(error)}`); }
  };

  const externalDirty = !sameIds(disabledIds, appliedDisabled);
  const summaryText = copy.countSummary(catalog.length, catalog.filter(entry => entry.enabled).length, pendingCount);
  const [menuOpen, setMenuOpen] = useState(false);
  const packageFeedback = (message: string | null, kind?: 'success' | 'error') => {
    if (kind === 'success' && message) {
      setLastSuccess(message);
      setNotice(null);
    } else {
      if (kind === 'error') setLastSuccess(null);
      setNotice(message);
    }
  };

  return (
    <div data-bp-plugin-manager="" className="space-y-1.5">
      {/* 单行工具栏：标题·来源切换·搜索·状态·安装动作全部压缩在同一行（窄屏才 flex-wrap 换行） */}
      <div data-bp-plugin-toolbar="" className="flex flex-wrap items-center gap-1.5">
        <div className="flex shrink-0 items-center gap-1">
          <h2 className="text-[13px] font-semibold leading-7 text-neutral-100">{copy.heading}</h2>
          <HoverInfoButton label={copy.help} lines={[copy.intro, summaryText,
            ...(source === 'external' ? [copy.installHint] : []),
            ...(source === 'external' ? [copy.packageLive] : []),
            ...(lastSuccess ? [`${copy.lastAction}：${lastSuccess}`] : [])]} />
        </div>
        <select aria-label={copy.sourceFilter} value={source} onChange={event => { setSource(event.target.value as Exclude<CatalogSourceFilter, 'all'>); setActiveDetails(null); }}
          className="h-7 shrink-0 rounded-lg border border-white/10 bg-[var(--bp-ui-surface-strong)] px-1.5 text-[11px] text-neutral-100 focus:border-sky-300/40 focus:outline-none">
          {/* 只分两档：内置（编译进本体）/ 外部（可编辑包 + 声明式包 + JSON 扩展包）。 */}
          <option value="builtin">{copy.builtinTab} · {sourceCount('builtin')}</option>
          <option value="external">{copy.externalTab} · {sourceCount('external')}</option>
        </select>
        <div className="relative min-w-[7.5rem] flex-1">
          <svg viewBox="0 0 16 16" aria-hidden className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input type="search" value={query} onChange={event => { setQuery(event.target.value); setActiveDetails(null); }}
            placeholder={copy.search} aria-label={copy.search}
            className="h-7 w-full rounded-lg border border-white/10 bg-white/[0.05] py-0 pl-7 pr-2 text-[11px] text-neutral-100 placeholder:text-neutral-500 focus:border-sky-300/40 focus:outline-none" />
        </div>
        <select value={statusFilter} onChange={event => { setStatusFilter(event.target.value as CatalogStatusFilter); setActiveDetails(null); }}
          aria-label={copy.statusFilter}
          className="h-7 shrink-0 rounded-lg border border-white/10 bg-[var(--bp-ui-surface-strong)] px-1.5 text-[11px] text-neutral-100 focus:border-sky-300/40 focus:outline-none">
          <option value="all">{copy.allStatuses}</option>
          <option value="enabled">{copy.enabled}</option>
          <option value="disabled">{copy.disabled}</option>
          <option value="pending">{copy.pendingOnly}</option>
        </select>
        {source === 'builtin' && !advancedForced && (
          <button type="button" onClick={() => setShowAdvanced(value => !value)} aria-expanded={showAdvanced} title={copy.advancedHint}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-lg border px-1.5 text-[11px] ${showAdvanced
              ? 'border-sky-300/30 bg-sky-400/10 text-sky-100 hover:bg-sky-400/15'
              : 'border-white/10 bg-white/[0.05] text-neutral-400 hover:bg-white/10 hover:text-neutral-100'}`}>
            <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="5.5" cy="4.5" r="1.5" fill="currentColor" stroke="none" /><circle cx="10" cy="8" r="1.5" fill="currentColor" stroke="none" /><circle cx="6.8" cy="11.5" r="1.5" fill="currentColor" stroke="none" /></svg>
            <span className="whitespace-nowrap">{copy.advancedToggle}</span>
            <span className="text-[10px] opacity-70">{advancedPlugins.length}</span>
          </button>
        )}
        {(snapshot.restartRequired || externalDirty) && (
          <span role="status" title={copy.needsReload} className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-amber-300/25 bg-amber-300/[0.10] py-0 pl-1.5 pr-0.5">
            <span className="whitespace-nowrap text-[11px] font-medium text-amber-100">{copy.pendingShort}</span>
            <button type="button" onClick={() => manager.reload()} className="whitespace-nowrap rounded-md bg-amber-200 px-1.5 py-0.5 text-[11px] font-semibold text-amber-950 hover:bg-amber-100">{copy.reloadShort}</button>
          </span>
        )}
        <div className="relative flex shrink-0 items-center">
          <button type="button" onClick={() => { void installExternal(); }}
            className="flex h-7 items-center gap-1 rounded-l-lg border border-r-0 border-white/10 bg-white/[0.07] px-2 text-[11px] text-neutral-100 hover:bg-white/10">
            <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5"><path d="M8 2.8v7M4.8 6.6 8 9.8l3.2-3.2M2.8 12.8h10.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="whitespace-nowrap">{copy.install}</span>
          </button>
          <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={copy.more} onClick={() => setMenuOpen(value => !value)}
            className="flex h-7 items-center rounded-r-lg border border-white/10 bg-white/[0.07] px-1.5 text-neutral-300 hover:bg-white/10 hover:text-neutral-100">
            <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3"><path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {menuOpen && <>
            <div role="presentation" className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div role="menu" data-bp-plugin-manager-menu="" className="absolute right-0 top-8 z-20 w-44 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-xl backdrop-blur">
              {packageService && <button role="menuitem" type="button" aria-expanded={showPackageInstaller} onClick={() => { setMenuOpen(false); setShowPackageInstaller(value => !value); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-violet-100 hover:bg-violet-300/15">
                <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-80"><path d="M8 1.8 13.6 4.6 8 7.4 2.4 4.6Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M2.4 8 8 10.8 13.6 8M2.4 11.2 8 14l5.6-2.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                <span className="min-w-0 truncate">{copy.packageInstall}</span>
              </button>}
              <button role="menuitem" type="button" aria-expanded={showDevGuide} onClick={() => { setMenuOpen(false); setShowDevGuide(value => !value); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-teal-100 hover:bg-teal-300/15">
                <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-80"><path d="M3 3.4h4.2c.9 0 1.4.5 1.4 1.3v7.9c0-.7-.5-1.2-1.4-1.2H3ZM13 3.4H8.8c-.9 0-1.4.5-1.4 1.3v7.9c0-.7.5-1.2 1.4-1.2H13Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
                <span className="min-w-0 truncate">{copy.devGuide}</span>
              </button>
              <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); clearBuiltinOverrides(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/[0.07]">
                <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-70"><path d="M3.4 8a4.6 4.6 0 1 0 1.6-3.5M3 3v2.4h2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span className="min-w-0 truncate">{copy.resetBuiltin}</span>
              </button>
              <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); clearExternalOverrides(); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/[0.07]">
                <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-70"><path d="M3.4 8a4.6 4.6 0 1 0 1.6-3.5M3 3v2.4h2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span className="min-w-0 truncate">{copy.resetExternal}</span>
              </button>
            </div>
          </>}
        </div>
      </div>
      {showPackageInstaller && packageService && (
        <PackageInstaller runtime={packageService.runtime} language={language} onNotice={packageFeedback}
          onClose={() => setShowPackageInstaller(false)}
          onInstalled={() => { setShowPackageInstaller(false); setSource('package'); setStatusFilter('all'); setQuery(''); }} />
      )}
      {showDevGuide && <PluginDevGuide language={language === 'en' ? 'en' : 'zh'} onClose={() => setShowDevGuide(false)} />}
      {snapshot.warning && (
        <p role="status" className="rounded-lg border border-amber-300/20 bg-amber-300/[0.08] px-2.5 py-1 text-[11px] leading-4 text-amber-100">
          {copy.storageWarning} {snapshot.warning}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border border-white/10 bg-white/[0.045] px-2.5 py-1 text-[11px] leading-4 text-neutral-200">
          {notice}
        </p>
      )}

      {snapshot.activeProfile.rejected.length > 0 && (
        <section aria-label={copy.failedToLoad} className="rounded-lg border border-rose-300/20 bg-rose-400/[0.06] px-2.5 py-1.5">
          <h3 className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-200">{copy.failedToLoad}</h3>
          <ul className="space-y-0.5">
            {snapshot.activeProfile.rejected.map((rejection, index) => (
              <li key={index} className="text-[11px] leading-4 text-rose-100/90">
                <span className="font-medium">{resolveManifestText(rejection.name, rejection.nameI18n, language) || rejection.id || '未知插件'}</span>
                {rejection.id && rejection.name ? <span className="text-rose-200/60"> ({rejection.id})</span> : null}
                <span className="mx-1 text-rose-300/50">—</span>
                <span className="text-rose-100/70">{rejection.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {externalLoad.status === 'error' && (
        <p role="status" className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-100">
          {copy.externalUnavailable} {externalLoad.message}
        </p>
      )}
      {packageError && (
        <p role="status" className="rounded-lg border border-rose-300/20 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-100">
          {copy.packageUnavailable} {packageError}
        </p>
      )}
      {packageService && !activeById.get('builtin.core-extensions')?.enabled && (
        <p role="status" className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-100">
          {copy.packageHostDisabled}
        </p>
      )}
      {source === 'external' && (
        <section aria-label={copy.externalTab} className="space-y-1">
          {visibleExternal.length > 0 && <ul className="overflow-hidden rounded-lg border border-white/[0.08]">
          {visibleExternal.map(plugin => {
            const pending = !disabledIds.includes(plugin.id);
            const active = !appliedDisabled.includes(plugin.id);
            const pendingChange = active !== pending;
            const isOpen = activeDetails?.source === 'external' && activeDetails.id === plugin.id;
            const modeLabel = plugin.mode === 'sandboxed' ? copy.modeSandbox : copy.modeDeclarative;
            return <React.Fragment key={plugin.id}>
              <CompactPluginRow
                id={plugin.id} name={displayName(plugin)} enabled={pending}
                enabledLabel={copy.enabled} disabledLabel={copy.disabled}
                helpLabel={copy.details} warning={pendingChange}
                helpLines={[
                  `${modeLabel} · ${plugin.id}`,
                  displayDescription(plugin) ?? copy.noDescription,
                  `${active ? copy.startupEnabled : copy.startupDisabled} · ${pendingChange ? (pending ? copy.nextEnable : copy.nextDisable) : (pending ? copy.enabled : copy.disabled)}`,
                  `${copy.permissions}: ${plugin.permissions?.join(', ') || copy.none}`,
                  copy.details,
                ]}
                onDetails={() => { setNotice(null); setActiveDetails({ source: 'external', id: plugin.id }); }}
                onToggle={() => applyExternalEnabled(plugin.id, !pending)}
              />
              {isOpen && <InlinePluginDetails id={plugin.id} title={displayName(plugin)} closeLabel={copy.closeDetails} onClose={() => setActiveDetails(null)}>
                {notice && <p role="alert" className="rounded-md bg-rose-500/10 px-2 py-1 text-rose-200">{notice}</p>}
                <p className="text-xs leading-4 text-neutral-300">{displayDescription(plugin) ?? copy.noDescription}</p>
                <dl className="grid gap-x-2 gap-y-0.5 text-[11px] leading-4 sm:grid-cols-[auto_1fr]">
                  <dt className="text-right text-neutral-500">{copy.type}</dt><dd>{modeLabel}</dd>
                  <dt className="text-right text-neutral-500">{copy.permissions}</dt><dd>{plugin.permissions?.join(', ') || copy.none}</dd>
                  <dt className="text-right text-neutral-500">{copy.host}</dt><dd className="break-all font-mono">{plugin.id} · {active ? copy.startupEnabled : copy.startupDisabled}</dd>
                  {pendingChange && <><dt className="text-right text-amber-200">{copy.pendingShort}</dt><dd className="text-amber-100">{pending ? copy.nextEnable : copy.nextDisable}</dd></>}
                </dl>
                {sandboxSettingsTab?.pluginId === plugin.id && (
                  <PluginSettingsForm
                    pluginId={plugin.id}
                    tab={sandboxSettingsTab.tab}
                    runCommand={commandId => runSandboxCommand(plugin.id, commandId)}
                    labels={{
                      saved: copy.settingsSaved,
                      saveFailed: copy.settingsSaveFailed,
                      run: copy.settingsRun,
                    }}
                  />
                )}
                <button type="button" onClick={() => { void uninstallExternal(plugin.id); }}
                  className="rounded-md px-2 py-1 text-xs text-red-300 hover:bg-red-500/10">{copy.uninstall}</button>
              </InlinePluginDetails>}
            </React.Fragment>;
          })}
          </ul>}
          {externalLoad.status === 'loading' && (
            <p className="px-1 text-xs text-neutral-500">{copy.externalLoading}</p>
          )}
          {/* 空态只在整档都没有外部内容时出现，避免和可编辑包列表叠着显示。 */}
          {externalLoad.status === 'ok' && externalPlugins.length === 0 && !visiblePlugins.length && !query.trim() && statusFilter === 'all' && (
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-2 text-center text-[11px] text-neutral-500">{copy.noExternal}</p>
          )}
        </section>
      )}
      {source === 'external' && packageService && (
        <section aria-label={copy.packageTab} className="space-y-1">
          {visiblePackages.length > 0 && <PackageRows runtime={packageService.runtime} installed={visiblePackages} language={language} onNotice={packageFeedback} />}
          {installedPackages.length === 0 && !packageError && !visiblePlugins.length && !visibleExternal.length && !query.trim() && statusFilter === 'all' && (
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-2 text-center text-[11px] text-neutral-500">{copy.noPackages}</p>
          )}
        </section>
      )}
      {(source === 'builtin' || source === 'external') && visiblePlugins.length > 0 && (
        <section aria-label={isEditableTab ? copy.editableGroup : copy.builtinGroup}>
          <ul className="overflow-hidden rounded-lg border border-white/[0.08]">
            {builtinGroups
              .filter(group => group.category !== '__advanced__' || showAdvanced || advancedForced)
              .flatMap(({ plugins }) => plugins.map(plugin => {
              const active = activeById.get(plugin.id)?.enabled ?? false;
              const pending = plugin.enabled;
              const protectedPlugin = snapshot.protectedPluginIds.includes(plugin.id);
              const dependents = requiredBy.get(plugin.id) ?? [];
              const pendingChange = active !== pending;
              const isOpen = activeDetails?.source === 'builtin' && activeDetails.id === plugin.id;
              return <React.Fragment key={plugin.id}>
                <CompactPluginRow
                  id={plugin.id} name={displayName(plugin)} enabled={pending}
                  enabledLabel={copy.enabled} disabledLabel={copy.disabled}
                  helpLabel={copy.details} warning={pendingChange}
                  protectedReason={protectedPlugin ? copy.protected : undefined}
                  helpLines={[
                    `${plugin.id} · v${plugin.version} · ${categoryLabel(plugin.category ?? 'other', language)}`,
                    `${active ? copy.startupEnabled : copy.startupDisabled}${pendingChange ? ` → ${pending ? copy.nextEnable : copy.nextDisable}` : ''}`,
                    displayDescription(plugin) ?? copy.noDescription,
                    ...(displayModules(plugin).length > 0
                      ? [`${copy.includes}: ${displayModules(plugin).map(moduleName).join('、')}`]
                      : []),
                    ...(plugin.requires.length ? [`${copy.requires}: ${plugin.requires.map(pluginName).join('、')}`] : []),
                    ...(dependents.length ? [`${copy.requiredBy}: ${dependents.map(pluginName).join('、')}`] : []),
                    ...(protectedPlugin ? [copy.protected] : []),
                    copy.details,
                  ]}
                  onDetails={() => { setNotice(null); setActiveDetails({ source: 'builtin', id: plugin.id }); }}
                  onToggle={() => applyEnabled(plugin.id, !pending)}
                />
                  {isOpen && (() => {
                    const canOpen = hostPlatform.canOpenDirs && Boolean(plugin.sourceDir);
                    const openFolder = () => {
                      if (!plugin.sourceDir) return;
                      void hostPlatform.openPluginDir(plugin.sourceDir);
                    };
                    const folderIcon = (
                      <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5">
                        <path d="M1.5 4.5 a1 1 0 0 1 1-1 h3.2 l1.4 1.6 h6.4 a1 1 0 0 1 1 1 v6.4 a1 1 0 0 1 -1 1 h-11 a1 1 0 0 1 -1 -1 z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                      </svg>
                    );
                    return (
                       <InlinePluginDetails id={plugin.id} title={displayName(plugin)} closeLabel={copy.closeDetails} onClose={() => setActiveDetails(null)}>
                         <div className="space-y-1.5">
                         <div className="flex items-start justify-between gap-2">
                           <p className="min-w-0 flex-1 text-[11px] leading-4 text-neutral-300">
                             {displayDescription(plugin) ?? <span className="text-neutral-500">{copy.noDescription}</span>}
                           </p>
                           {canOpen && (
                             <button
                               type="button"
                               onClick={openFolder}
                               title={copy.openFolder}
                               aria-label={`${displayName(plugin)}: ${copy.openFolder}`}
                               className="shrink-0 rounded-md border border-white/10 bg-white/[0.05] p-1 text-neutral-300 hover:bg-white/10 hover:text-neutral-100"
                             >
                               {folderIcon}
                             </button>
                           )}
                         </div>
                         {displayModules(plugin).length > 0 && (
                           <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                             <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                               {copy.includes} <span className="font-normal text-neutral-600">{displayModules(plugin).length}</span>
                             </h4>
                             <ul className="space-y-0.5">
                               {displayModules(plugin).map(module => (
                                 <li key={module.name} className="truncate text-[11px] leading-4">
                                   <span className="font-medium text-neutral-200">{moduleName(module)}</span>
                                   <span className="ml-1 text-neutral-500">{module.id}</span>
                                 </li>
                               ))}
                             </ul>
                           </div>
                         )}
                         <dl className="grid gap-x-2 gap-y-0.5 text-[11px] leading-4 sm:grid-cols-[auto_1fr]">
                          <dt className="text-right text-neutral-500">{copy.type}</dt>
                          <dd className="text-neutral-200">{categoryLabel(plugin.category ?? 'other', language)}</dd>
                          <dt className="text-right text-neutral-500">{copy.maintainer}</dt>
                          <dd className="text-neutral-200">{plugin.author}</dd>
                          <dt className="text-right text-neutral-500">{copy.capabilities}</dt>
                          <dd className="text-neutral-200">{plugin.capabilities.join(', ') || copy.none}</dd>
                          <dt className="text-right text-neutral-500">{copy.requires}</dt>
                          <dd className="text-neutral-200">{plugin.requires.map(pluginName).join('、') || copy.none}</dd>
                          <dt className="text-right text-neutral-500">{copy.requiredBy}</dt>
                          <dd className="text-neutral-200">{dependents.map(pluginName).join('、') || copy.none}</dd>
                          <dt className="text-right text-neutral-500">{copy.budget}</dt>
                          <dd className="text-neutral-200">{budgetLabel(plugin.resourceBudget, language)}</dd>
                          <dt className="text-right text-neutral-500">{copy.file}</dt>
                          <dd className="min-w-0">
                            {plugin.sourceDir ? (
                              <span className="flex min-w-0 items-center gap-1.5">
                                <code className="min-w-0 flex-1 truncate rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-neutral-300" title={plugin.sourceDir}>{plugin.sourceDir}</code>
                                {canOpen && (
                                  <button
                                    type="button"
                                    onClick={openFolder}
                                    title={copy.openFolder}
                                    aria-label={`${plugin.sourceDir}: ${copy.openFolder}`}
                                    className="shrink-0 rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
                                  >
                                    {folderIcon}
                                  </button>
                                )}
                              </span>
                            ) : (
                              <span className="text-neutral-500">{copy.pathUnavailable}</span>
                            )}
                          </dd>
                          <dt className="text-right text-neutral-500">{copy.host}</dt>
                          <dd className="font-mono text-[10px] text-neutral-500">{plugin.id} · {plugin.host} · v{plugin.version} · {active ? copy.startupEnabled : copy.startupDisabled}</dd>
                        </dl>
                        {protectedPlugin && <p className="mt-1 text-[11px] text-amber-100">{copy.protected}</p>}
                        {/* schema 驱动的配置表单：manifest.configSchema 声明的键才可编辑，改动即落 user 层 patch。 */}
                        {plugin.configSchema && Object.keys(plugin.configSchema).length > 0 && (() => {
                          const applyConfig = (key: string, value: unknown) => {
                            const result = manager.setPluginConfig(plugin.id, { [key]: value });
                            setSnapshot(result.snapshot);
                            if ('message' in result && !result.ok) {
                              setNotice(`${copy.configFailed} ${result.message}`);
                              return;
                            }
                            setNotice(null);
                            kernel.emit('plugin:config-changed', { id: plugin.id, key, value, config: result.snapshot.pendingProfile.plugins.find(p => p.id === plugin.id)?.config });
                          };
                          return (
                            <div className="border-t border-white/[0.06] pt-1.5">
                              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{copy.config}</h4>
                              <ul className="space-y-1">
                                {Object.entries(plugin.configSchema).map(([key, kind]) => {
                                  const value = plugin.config[key];
                                  const inputClass = 'min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-xs text-neutral-100 focus:border-sky-300/40 focus:outline-none';
                                  return (
                                    <li key={key} className="flex items-center gap-2">
                                      <code className="w-40 shrink-0 truncate font-mono text-[10px] text-neutral-400" title={key}>{key}</code>
                                      {kind === 'boolean' ? (
                                        <input
                                          type="checkbox"
                                          checked={value === true}
                                          onChange={event => applyConfig(key, event.target.checked)}
                                          aria-label={`${plugin.id}: ${key}`}
                                          className="h-3.5 w-3.5 accent-emerald-400"
                                        />
                                      ) : kind === 'number' ? (
                                        <input
                                          type="number"
                                          value={typeof value === 'number' ? value : ''}
                                          onChange={event => applyConfig(key, event.target.valueAsNumber)}
                                          aria-label={`${plugin.id}: ${key}`}
                                          className={inputClass}
                                        />
                                      ) : (
                                        <input
                                          type="text"
                                          value={typeof value === 'string' ? value : ''}
                                          onChange={event => applyConfig(key, event.target.value)}
                                          aria-label={`${plugin.id}: ${key}`}
                                          className={inputClass}
                                        />
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          );
                        })()}
                       </div>
                       </InlinePluginDetails>
                     );
                   })()}
              </React.Fragment>;
            }))}
          </ul>
        </section>
      )}
      {filtered.length === 0 && (query.trim() || statusFilter !== 'all' || source === 'builtin' || source === 'external') && (
        <p role="status" className="rounded-lg border border-dashed border-white/10 px-3 py-2 text-center text-[11px] text-neutral-500">{copy.noMatch}</p>
      )}
    </div>
  );
};

/** 悬浮窗入口：复用设置页同款组件；宿主只给 kernel/onClose，语言走全局 store。 */
const PluginManagerFloatingPanel: React.FC<PluginPanelProps> = ({ kernel }) => {
  const language = useLanguage();
  return <PluginManagerSettingsSection kernel={kernel} language={language} />;
};

export function activatePluginManager(ctx: Kernel): Effect {
    const disposers = [
      ctx.contributions.register<PluginPanelContribution>('ui_panels', {
        id: 'builtin.panel-plugin-manager',
        pluginId: 'builtin.ui-plugin-manager',
        priority: 20,
        value: {
          title: language => copyFor(language).label,
          description: language => copyFor(language).panelHint,
          component: PluginManagerFloatingPanel,
          presentation: 'floating',
          floatingWidth: 'lg',
        },
      }),
      // 设置页 section：与悬浮面板共用同一内容组件，插件管理统一入口在设置里。
      ctx.contributions.register<SettingsSectionContribution>('settings_sections', {
        id: 'builtin.settings-plugins',
        pluginId: 'builtin.ui-plugin-manager',
        priority: 20,
        value: {
          label: language => copyFor(language).label,
          component: PluginManagerSettingsSection,
          navGroup: 'extensions',
        },
      }),
    ];
    return () => disposers.forEach(dispose => dispose());
}
