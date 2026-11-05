import type { Kernel, Effect } from './kernel';
/** Stable method facade over a render-updated ref. Cached method handles stay live too. */
export function createLiveServiceLease<T extends object>(ref: { current: T }): { value: T; dispose: Effect } {
  let disposed = false;
  const value: Record<string, (...args: unknown[]) => unknown> = {};
  for (const key of Object.keys(ref.current)) {
    if (typeof (ref.current as Record<string, unknown>)[key] !== 'function') throw new Error(`Live service requires method-only shape: ${key}`);
    value[key] = (...args: unknown[]) => {
      if (disposed) throw new Error('Live service lease disposed');
      const current = ref.current;
      const method = (current as Record<string, unknown>)[key];
      if (typeof method !== 'function') throw new Error(`Live service method missing: ${key}`);
      return Reflect.apply(method, current, args);
    };
  }
  return { value: Object.freeze(value) as T, dispose: () => { disposed = true; } };
}
export function provideLiveService<T extends object>(kernel: Kernel, name: string, ref: { current: T }): Effect {
  const lease = createLiveServiceLease(ref);
  try {
    const remove = kernel.provide(name, lease.value);
    return () => { lease.dispose(); remove(); };
  } catch (error) { lease.dispose(); throw error; }
}
