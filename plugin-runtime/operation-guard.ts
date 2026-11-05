import { invariant, plain } from './extension-package';
/**
 * V5 final guard: pure verdict used by the host hook chain and by self-checks.
 * Denials here are final: later hooks and wrappers cannot approve what the guard rejected.
 */
export type ToolSurface = 'agent' | 'command' | 'ui';
export interface ToolGuardCall {
  /** Actor from the trusted scope, never from request payload. */
  actor: string;
  /** `agent` / `command` / `ui` surface that invoked the tool. */
  surface: ToolSurface;
  packageId?: string;
  toolId?: string;
  operationKinds: readonly string[];
}
export interface ToolGuardContext {
  isPackageActive: (packageId: string) => boolean;
  packagePermissions: (packageId: string) => readonly string[];
}
export type ToolGuardVerdict = { allow: true } | { allow: false; reason: string };
const READ_ONLY_KINDS = new Set(['node.patchGeometry']);
const SURFACES: readonly ToolSurface[] = ['agent', 'command', 'ui'];
const isSurface = (value: unknown): value is ToolSurface => SURFACES.includes(value as ToolSurface);

export function evaluateToolGuard(call: ToolGuardCall, context: ToolGuardContext): ToolGuardVerdict {
  if (typeof call.actor !== 'string' || call.actor.length === 0 || call.actor.length > 128) {
    return { allow: false, reason: 'missing trusted actor' };
  }
  if (!isSurface(call.surface)) return { allow: false, reason: 'invalid surface' };
  if (!Array.isArray(call.operationKinds) || call.operationKinds.length > 1000) return { allow: false, reason: 'invalid operation list' };
  const writes = call.operationKinds.some(kind => !READ_ONLY_KINDS.has(kind));
  if (call.packageId !== undefined) {
    invariant(typeof call.packageId === 'string', 'invalid package id');
    if (call.surface === 'agent' || call.surface === 'command') {
      if (!context.isPackageActive(call.packageId)) return { allow: false, reason: `extension not active: ${call.packageId}` };
      const permissions = new Set(context.packagePermissions(call.packageId));
      if (writes && !permissions.has('document.write')) return { allow: false, reason: 'extension lacks document.write grant' };
      if (call.surface === 'agent' && !permissions.has('agent.invoke')) return { allow: false, reason: 'extension lacks agent.invoke grant' };
      if (call.toolId !== undefined) invariant(typeof call.toolId === 'string' && call.toolId.length <= 128, 'invalid tool id');
    }
  }
  if (call.operationKinds.some(kind => typeof kind !== 'string' || !/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9.]*)*$/.test(kind))) return { allow: false, reason: 'unknown operation kind' };
  return { allow: true };
}
/**
 * Host-side registration payload for the kernel `hooks` slot (phase: 'guard').
 * Maps the generic guarded-tool call (actor + args) onto the declarative guard contract.
 */
export const createOperationGuardHook = (context: ToolGuardContext) => ({
  phase: 'guard' as const,
  run: (call: { actor?: string; args?: Record<string, unknown> } | null | undefined): ToolGuardVerdict => {
    try {
      const args = plain(call?.args) ? call.args : {};
      const fromArgs = args.surface;
      const surface: ToolSurface = isSurface(fromArgs) ? fromArgs : (isSurface(call?.actor) ? call?.actor : 'ui');
      return evaluateToolGuard({
        actor: typeof call?.actor === 'string' ? call.actor : '',
        surface,
        packageId: typeof args.packageId === 'string' ? args.packageId : undefined,
        toolId: typeof args.toolId === 'string' ? args.toolId : undefined,
        operationKinds: Array.isArray(args.operationKinds) ? (args.operationKinds as string[]) : [],
      }, context);
    } catch (error) {
      return { allow: false, reason: error instanceof Error ? error.message : 'guard evaluation failed' };
    }
  },
});
