import { createExtensionRuntime, extensionStorage } from './extension-registry';
import { bindExtensionRuntime } from './extension-renderer';
import type { ExtensionRuntimeService } from './extension-service';
import type { ExtensionRuntime } from './extension-registry';

let host: ExtensionRuntimeService | null = null;

/**
 * Bootstrap entry (index.tsx, before builtin activation): creates the one declarative
 * extension runtime, binds the renderer lookup and exposes a stable service handle.
 * App later stages the document-backed invokeTool/updateNode on the same handle.
 *
 * `storage` 默认走主进程配置卷（`extensions.installed`），不再依赖 `window.localStorage`
 * —— 扩展安装列表从此与 dev origin / 打包方式无关。
 */
export function createExtensionHost(storage: Pick<Storage, 'getItem' | 'setItem'> = extensionStorage): ExtensionRuntimeService {
  if (host) return host;
  const runtime = createExtensionRuntime(storage);
  bindExtensionRuntime(runtime);
  const handle: ExtensionRuntimeService = {
    runtime,
    invokeTool: async () => { throw new Error('Extension tool surface is staged by App after document bootstrap'); },
    updateNode: () => ({ ok: false, error: 'Extension document surface not ready' }),
  };
  host = handle;
  return handle;
}
export const getExtensionHost = (): ExtensionRuntimeService | null => host;
export const getExtensionRuntime = (): ExtensionRuntime | null => host?.runtime ?? null;
