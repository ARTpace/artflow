/** A read-only projection of the three existing plugin stores. No loading/persistence lives here. */
/**
 * `editable` 曾单独成一档，现并入「外部插件」：这些包的 id 仍是 `builtin.*`
 * （改了会破坏用户的 profile / 收藏 / 启用状态），
 * 但源码在工程 plugins/ 下、运行副本在 userData/plugins/builtin/，装完可以直接改 —— 属于第三方，
 * 不再是"编译进本体"的内置功能。判定看插件 manifest 里自报的 `runtime.mode`。
 */
export type CatalogSource = 'builtin' | 'editable' | 'external' | 'package';
/**
 * 界面只分两档（2026-10-11）：内置 = 编译进本体；外部 = 其余全部
 * （`editable` 可编辑包、`external` 声明式/沙箱包、`package` JSON 扩展包）。
 * 插件 manifest 自报的 `runtime.mode` 仍是档内判据，只是不再各占一个下拉档位。
 */
export type CatalogBucket = 'builtin' | 'external';
export type CatalogSourceFilter = 'all' | CatalogBucket;
/** 把内部四值来源折叠成界面上的两档。 */
export const sourceBucketOf = (source: CatalogSource): CatalogBucket =>
  source === 'builtin' ? 'builtin' : 'external';
export type CatalogStatusFilter = 'all' | 'enabled' | 'disabled' | 'pending';

export interface PluginCatalogEntry {
  id: string;
  source: CatalogSource;
  name: string;
  description?: string;
  /** Saved preference for builtins/third-party; live runtime state for JSON packages. */
  enabled: boolean;
  /** The preference used to load this session, absent for immediately applied packages. */
  startupEnabled?: boolean;
}

/** 可编辑（第三方）插件的判据：插件 manifest 自报 `runtime.mode === 'editable'`。 */
export const isEditableMode = (mode: string | undefined): boolean => mode === 'editable';

// Infrastructure remains manageable, but does not crowd out tools and formats by default.
// 只列**真正编译进本体**的基础组件。曾经的 commands-edit / commands-workspace 已并入
// builtin.commands-core（可编辑），core-extensions 也已外置为可编辑包 —— 它们走 `editable` 档。
const INFRASTRUCTURE_BUILTINS = new Set([
  'builtin.cards-files',
  'builtin.cards-media',
  'builtin.cards-reader',
  'builtin.external-plugins',
  'builtin.headless',
  'builtin.studio-chrome',
  'builtin.workspace-panels',
]);

export const isInfrastructureBuiltin = (id: string): boolean => INFRASTRUCTURE_BUILTINS.has(id);

export const needsPluginReload = (entry: PluginCatalogEntry): boolean =>
  entry.startupEnabled !== undefined && entry.enabled !== entry.startupEnabled;

/** Filter every source by the same search, saved switch state and reload state. */
export const filterPluginCatalog = (
  entries: readonly PluginCatalogEntry[],
  filters: { source: CatalogSourceFilter; status: CatalogStatusFilter; query: string },
): PluginCatalogEntry[] => {
  const query = filters.query.trim().toLocaleLowerCase();
  return entries.filter(entry => {
    if (filters.source !== 'all' && sourceBucketOf(entry.source) !== filters.source) return false;
    if (filters.status === 'enabled' && !entry.enabled) return false;
    if (filters.status === 'disabled' && entry.enabled) return false;
    if (filters.status === 'pending' && !needsPluginReload(entry)) return false;
    return !query || `${entry.name} ${entry.id} ${entry.description ?? ''}`.toLocaleLowerCase().includes(query);
  });
};
