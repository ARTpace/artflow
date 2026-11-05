/** Small typed authoring helper; runtime validation still belongs to loader/manifest.ts. */
import type { BuiltinPluginModule } from './loader';

export function definePlugin<T extends BuiltinPluginModule>(plugin: T): T {
  return plugin;
}
