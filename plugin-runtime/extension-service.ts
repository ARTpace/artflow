import type { ExtensionRuntime } from './extension-registry';
/** Trusted in-process handle to the declarative extension host. Provided by App at bootstrap. */
export const EXTENSION_RUNTIME_SERVICE = 'platform.extension-runtime';
export type ExtensionScalar = string | number | boolean;
export interface ExtensionRuntimeService {
  runtime: ExtensionRuntime;
  /** Guarded tool execution (V5): actor identifies the trusted surface, never the payload. */
  invokeTool: (packageId: string, toolId: string, value: ExtensionScalar, actor: string) => Promise<unknown>;
  /** UI property panel commit for one extension node (actor 'ui'). */
  updateNode: (elementId: string, data: Record<string, ExtensionScalar>) => { ok: boolean; error?: string };
}
