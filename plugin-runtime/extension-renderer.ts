import type { ExtensionRuntime } from './extension-registry';
import type { ExtensionNodeSchema, ExtensionSchemaProvider } from './document-contract';

export type ExtensionNodeAvailability = 'available' | 'disabled' | 'unknown';
export interface ExtensionRendererSnapshot { version: number }

let runtime: ExtensionRuntime | null = null;
let unsubscribeRuntime: (() => void) | null = null;
let version = 0;
let snapshot: ExtensionRendererSnapshot = { version };
const listeners = new Set<() => void>();
const bump = () => {
  version += 1; snapshot = { version };
  for (const listener of [...listeners]) { try { listener(); } catch { /* observation only */ } }
};
const schemaFromDefinition = (definition: {
  id: string; version: number; title: string; width: number; height: number;
  fields: Record<string, { type: 'string' | 'number' | 'boolean'; default: string | number | boolean }>;
  migrations?: { from: number; to: number; rename: Record<string, string> }[];
}): ExtensionNodeSchema =>
  ({ typeId: definition.id, version: definition.version, title: definition.title, defaultWidth: definition.width, defaultHeight: definition.height, fields: definition.fields, migrations: definition.migrations });

/** Bootstrap entry: at most one live runtime per host; pass null to unbind. */
export function bindExtensionRuntime(next: ExtensionRuntime | null): void {
  unsubscribeRuntime?.(); unsubscribeRuntime = null; runtime = null;
  if (next) { runtime = next; unsubscribeRuntime = next.subscribe(() => bump()); }
  bump();
}
export function subscribeExtensionRenderer(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const getExtensionRendererSnapshot = (): ExtensionRendererSnapshot => snapshot;
export const extensionSchemaProvider: ExtensionSchemaProvider = typeId => {
  const entry = runtime?.registry.get(typeId);
  return entry ? schemaFromDefinition(entry.definition) : undefined;
};
export const getExtensionNodeAvailability = (typeId: string): ExtensionNodeAvailability => {
  if (!runtime) return 'unknown';
  if (runtime.registry.get(typeId)) return 'available';
  return runtime.installed().some(entry => entry.package.node.id === typeId) ? 'disabled' : 'unknown';
};
