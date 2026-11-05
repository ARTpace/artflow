/**
 * Renderer-side module table for client.js.
 * The component closes over React, Artflow and (for unrestricted plugins) a
 * plugin-scoped Storage service. Node, files, and IPC are not provided directly.
 */
const LOCKED_GLOBALS = [
  'window', 'document', 'globalThis', 'global', 'self', 'process', 'require', 'module', 'exports',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage', 'indexedDB',
  'navigator', 'parent', 'top', 'frames', 'Function', 'importScripts',
];

function fail(message: string): never {
  throw new Error(message);
}

export function evaluateClientSource(
  source: string,
  pluginId: string,
  React: { createElement: (...args: unknown[]) => unknown },
  storage?: {
    read(ref: string): Promise<ArrayBuffer>;
    readPage(ref: string, index: number): Promise<{ bytes: ArrayBuffer; mimeType: string }>;
  },
) {
  if (typeof source !== 'string' || source.length === 0 || source.length > 131072) fail('client source is empty or too large');
  if (typeof pluginId !== 'string' || !/^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(pluginId)) fail('plugin id is invalid');
  if (!React || typeof React.createElement !== 'function') fail('React is required');
  const cards: Array<{ nodeType: string; component: unknown }> = [];
  const overlays: Array<{ id: string; component: unknown }> = [];
  const     panels: Array<{ id: string; title: string; component: unknown }> = [];
  const owns = (id: unknown) => typeof id === 'string' && id.startsWith(`${pluginId}.`) && id.length <= 80;
  const api = Object.freeze({
    /** 插件私有数据仓（与 plugin.js 的 files.storeInput/store 配对）：按 ref 读回大字节。 */
    storage: Object.freeze({
      read(ref: unknown) {
        if (typeof ref !== 'string' || !/^[0-9a-f]{64}$/.test(ref)) fail('stored data reference is invalid');
        if (!storage) fail('storage service is not available');
        return storage.read(ref);
      },
      /** 插件漫画页：按 (ref, index) 拉单页（主进程 ZIP 引擎，原生 zlib + LRU）。 */
      readPage(ref: unknown, index: unknown) {
        if (typeof ref !== 'string' || !/^[0-9a-f]{64}$/.test(ref)) fail('stored data reference is invalid');
        if (!Number.isInteger(index) || (index as number) < 0) fail('page index is invalid');
        if (!storage) fail('storage service is not available');
        return storage.readPage(ref, index as number);
      },
    }),
    cards: Object.freeze({
      register(definition: { nodeType?: unknown; component?: unknown }) {
        if (!definition || !owns(definition.nodeType)) fail('card type must start with the plugin id');
        if (typeof definition.component !== 'function') fail('card component is required');
        if (cards.length >= 8) fail('too many cards');
        cards.push({ nodeType: definition.nodeType as string, component: definition.component });
      },
    }),
    overlays: Object.freeze({
      register(definition: { id?: unknown; component?: unknown }) {
        if (!definition || !owns(definition.id)) fail('overlay id must start with the plugin id');
        if (typeof definition.component !== 'function') fail('overlay component is required');
        if (overlays.length >= 8) fail('too many overlays');
        overlays.push({ id: definition.id as string, component: definition.component });
      },
    }),
    panels: Object.freeze({
      register(definition: { id?: unknown; title?: unknown; component?: unknown }) {
        if (!definition || !owns(definition.id)) fail('panel id must start with the plugin id');
        if (typeof definition.title !== 'string' || definition.title.length === 0 || definition.title.length > 80) fail('panel title is invalid');
        if (typeof definition.component !== 'function') fail('panel component is required');
        if (panels.length >= 4) fail('too many panels');
        panels.push({ id: definition.id as string, title: definition.title, component: definition.component });
      },
    }),
  });
  const table = Object.freeze({
    modules: Object.freeze({
      definePlugin(setup: unknown) {
        if (typeof setup !== 'function') fail('definePlugin expects a function');
        setup(api);
      },
    }),
  });
  const runner = new Function('Artflow', 'React', 'Storage', ...LOCKED_GLOBALS, `"use strict";\n${source}`);
  runner(table, React, storage, ...LOCKED_GLOBALS.map(() => undefined));
  return { cards, overlays, panels };
}
