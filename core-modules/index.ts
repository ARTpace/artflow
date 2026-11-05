/** Required host UI: deliberately absent from optional manifests and plugin loader records. */
import type { Effect, Kernel } from '../plugin-runtime/kernel';
import { activateCoreSettings } from '../builtin-plugins/core-settings';
import { activateConfigManager } from '../builtin-plugins/config-manager';
import { activateUiShell } from '../builtin-plugins/ui-shell';
import { activatePluginManager } from '../builtin-plugins/ui-plugin-manager';

/** Legacy preference IDs only; retained to safely discard pre-migration plugin patches. */
export const CORE_MODULE_IDS = [
  'builtin.ui-plugin-manager',
  'builtin.core-settings',
  'builtin.config-manager',
  'builtin.ui-shell',
] as const;

/** Called once per host kernel, independently of the selected optional plugin profile. */
export function activateCoreModules(kernel: Kernel): Effect {
  const disposers: Effect[] = [];
  try {
    for (const activate of [activatePluginManager, activateCoreSettings, activateConfigManager, activateUiShell]) {
      disposers.push(activate(kernel));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
