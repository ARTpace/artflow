import type { Kernel } from './kernel';
import { freeze, invariant, plain } from './extension-package';
export interface ToolCall { id: string; actor: string; args: Readonly<Record<string, unknown>> }
export interface OperationHook {
  phase: 'before' | 'guard' | 'wrap' | 'after';
  run?: (call: ToolCall, signal: AbortSignal) => unknown | Promise<unknown>;
  wrap?: (call: ToolCall, next: () => Promise<unknown>, signal: AbortSignal) => unknown | Promise<unknown>;
}
/** Notifications cannot grant authority. Every invocation crosses the final guard after all wrappers. */
export async function executeGuardedTool<T>(kernel: Kernel, call: ToolCall, execute: (signal: AbortSignal) => T | Promise<T>, options: { authorize: () => void; signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  options.authorize(); invariant(plain(call.args) && JSON.stringify(call.args).length <= 65536, 'Invalid/big tool arguments');
  const frozen = freeze(JSON.parse(JSON.stringify(call)) as ToolCall);
  const controller = new AbortController(); const abort = () => controller.abort();
  if (options.signal?.aborted) throw new Error('Tool cancelled'); options.signal?.addEventListener('abort', abort, { once: true });
  const hooks = kernel.contributions.list<OperationHook>('hooks');
  let timer: ReturnType<typeof setTimeout>; let result: T; let committed = false;
  const check = () => { if (controller.signal.aborted) throw new Error('Tool cancelled/timed out'); options.authorize(); };
  const work = async () => {
    for (const { value } of hooks.filter(h => h.value.phase === 'before')) { check(); await value.run?.(frozen, controller.signal); }
    let called = false;
    let next = async (): Promise<unknown> => {
      check(); invariant(!called, 'Tool execution can only run once'); called = true;
      for (const { value } of hooks.filter(h => h.value.phase === 'guard')) {
        check(); const verdict = await value.run?.(frozen, controller.signal);
        if (verdict === false || (plain(verdict) && (verdict.allow === false || typeof verdict.deny === 'string'))) {
          const reason = plain(verdict) ? (typeof verdict.deny === 'string' ? verdict.deny : typeof verdict.reason === 'string' ? verdict.reason : 'guard denial') : 'guard denial';
          throw new Error(`Tool denied: ${reason}`);
        }
      }
      check(); result = await execute(controller.signal); committed = true; return result;
    };
    for (const { value } of [...hooks].reverse().filter(h => h.value.phase === 'wrap')) {
      const inner = next; next = async () => { check(); return value.wrap ? value.wrap(frozen, inner, controller.signal) : inner(); };
    }
    await next(); invariant(called && committed, 'Execution wrapper did not execute the guarded operation');
    for (const { value } of hooks.filter(h => h.value.phase === 'after')) { check(); await value.run?.(frozen, controller.signal); }
    return result;
  };
  const timeout = options.timeoutMs ?? 10000;
  invariant(Number.isFinite(timeout) && timeout >= 1 && timeout <= 60000, 'Invalid tool timeout');
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      const fail = () => reject(new Error('Tool cancelled/timed out'));
      controller.signal.addEventListener('abort', fail, { once: true });
      timer = setTimeout(() => controller.abort(), timeout);
    })]);
  } catch (error) {
    if (committed) { console.warn('[tools] post-execution observer failed; committed result preserved', error); return result; }
    throw error;
  } finally { clearTimeout(timer!); options.signal?.removeEventListener('abort', abort); controller.abort(); }
}
export function validateToolArguments(args: unknown, properties: Record<string, { type: string }>, required: readonly string[] = []): Record<string, unknown> {
  invariant(plain(args) && JSON.stringify(args).length <= 65536, 'Tool arguments must be a small object');
  invariant(Object.keys(args).every(key => Object.hasOwn(properties, key)) && required.every(key => Object.hasOwn(args, key)), 'Unknown/missing tool arguments');
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key].type;
    invariant(type === 'array' ? Array.isArray(value) : type === 'object' ? plain(value) : typeof value === type, `Wrong argument type: ${key}`);
    if (typeof value === 'number') invariant(Number.isFinite(value), 'Non-finite tool number');
  }
  return freeze(JSON.parse(JSON.stringify(args)));
}
