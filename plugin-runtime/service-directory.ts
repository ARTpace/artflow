import type { ScopedPluginContext } from './scoped-context';
export const SERVICE_DIRECTORY = 'platform.services';
export const CORE_SERVICE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'canvas.document', major: 1, providerId: 'core.canvas-document' }),
  Object.freeze({ id: 'canvas.operations', major: 1, providerId: 'core.canvas-document' }),
]);
export type ServiceBindings = Readonly<Record<string, string>>;
/** Reuses ordered profile layers. V2 minimum: core provider is the only supported binding. */
export function resolveServiceBindings(layers: readonly { serviceBindings?: ServiceBindings }[]): ServiceBindings {
  const bindings: Record<string, string> = Object.fromEntries(CORE_SERVICE_DEFINITIONS.map(def => [def.id, def.providerId]));
  for (const layer of layers) {
    if (layer.serviceBindings === undefined) continue;
    if (!layer.serviceBindings || typeof layer.serviceBindings !== 'object' || Array.isArray(layer.serviceBindings)) throw new Error('Invalid profile serviceBindings');
    for (const [id, providerId] of Object.entries(layer.serviceBindings)) {
      const definition = CORE_SERVICE_DEFINITIONS.find(def => def.id === id);
      if (!definition || providerId !== definition.providerId) throw new Error(`Unsupported startup service binding: ${id} -> ${providerId}`);
      bindings[id] = providerId;
    }
  }
  return Object.freeze(bindings);
}
export function createServiceDirectory(bindings: ServiceBindings = resolveServiceBindings([])) {
  const resolved = resolveServiceBindings([{ serviceBindings: bindings }]);
  const providers = new Map<string, { major: number; providerId: string; create: (consumer: ScopedPluginContext) => unknown }>();
  return Object.freeze({
    bindings: resolved,
    list: () => CORE_SERVICE_DEFINITIONS.map(def => Object.freeze({ ...def, available: providers.has(def.id) })),
    provide: (id: string, major: number, providerId: string, create: (consumer: ScopedPluginContext) => unknown) => {
      const definition = CORE_SERVICE_DEFINITIONS.find(def => def.id === id);
      if (!definition || definition.major !== major || resolved[id] !== providerId) throw new Error(`Service binding/version mismatch: ${id}@${major}`);
      if (providers.has(id)) throw new Error(`Service already provided: ${id}`);
      const entry = { major, providerId, create }; providers.set(id, entry);
      return () => { if (providers.get(id) === entry) providers.delete(id); };
    },
    resolve: <T>(consumer: ScopedPluginContext, id: string, major: number): T => {
      consumer.assertWritable();
      const entry = providers.get(id);
      if (!entry || entry.major !== major) throw new Error(`Service unavailable or incompatible: ${id}@${major}`);
      return entry.create(consumer) as T;
    },
  });
}
export type ServiceDirectory = ReturnType<typeof createServiceDirectory>;
/** Identity is read from the loader-created scope, never from an operation request. Trusted code only. */
export function usePluginService<T>(consumer: ScopedPluginContext, id: string, major = 1): T {
  return consumer.use<ServiceDirectory>(SERVICE_DIRECTORY).resolve<T>(consumer, id, major);
}
