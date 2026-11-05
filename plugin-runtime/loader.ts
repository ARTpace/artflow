/** Trusted builtin loader. Scoped ownership is not isolation from arbitrary JS. */
import type { Kernel, Effect } from './kernel';
import { ScopedPluginContext } from './scoped-context';
import { assertManifestHostCompatibility, PluginCompatibilityError, validateManifest, type PluginManifest } from './manifest';
import type { SkinTokens } from './contributions';

export interface BuiltinPluginModule {
  manifest: unknown;
  activate?: (ctx: ScopedPluginContext) => Effect | void;
}
export interface AsyncBuiltinPluginModule {
  manifest: unknown;
  activate?: (ctx: ScopedPluginContext) => Effect | void | Promise<Effect | void>;
}
export interface LoadedPlugin {
  manifest: PluginManifest;
  dispose: Effect;
  disposeAsync: (options?: { timeoutMs?: number }) => Promise<{ timedOut: boolean }>;
}
type RecordEntry = { scope: ScopedPluginContext; dependencies: readonly string[] };
const records = new WeakMap<Kernel, Map<string, RecordEntry>>();
function registry(root: Kernel): Map<string, RecordEntry> {
  let map = records.get(root);
  if (!map) { map = new Map(); records.set(root, map); }
  return map;
}
function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0 || result > 2147483647) throw new Error('invalid lifecycle timeout');
  return result;
}
function begin(root: Kernel, mod: AsyncBuiltinPluginModule) {
  const manifest = validateManifest(mod.manifest);
  assertManifestHostCompatibility(manifest);
  const map = registry(root);
  const id = manifest.id;
  if (map.has(id)) throw new Error(`duplicate plugin id: ${id}`);
  for (const dep of manifest.requires) if (map.get(dep)?.scope.status !== 'active') throw new Error(`plugin ${id} requires active ${dep}`);
  const scope = new ScopedPluginContext(root, id);
  const record = { scope, dependencies: [...manifest.requires] };
  map.set(id, record); // Reserve BEFORE any plugin activation code runs.
  const release = () => { if (map.get(id) === record) map.delete(id); };
  const fail = () => { scope.close(); release(); };
  const assertUnloadable = () => {
    for (const [other, value] of map) if (other !== id && value.dependencies.includes(id)) throw new Error(`cannot unload ${id}: dependent ${other}`);
  };
  let disposing: Promise<{ timedOut: boolean }> | undefined;
  const loaded: LoadedPlugin = {
    manifest,
    dispose: () => {
      if (scope.status === 'disposed') return;
      assertUnloadable();
      if (disposing || scope.pendingCalls) throw new Error(`use disposeAsync for plugin ${id} with in-flight calls`);
      fail();
    },
    disposeAsync: (options = {}) => {
      if (disposing) return disposing;
      if (scope.status === 'disposed') return Promise.resolve({ timedOut: false });
      const timeout = duration(options.timeoutMs, 5000);
      assertUnloadable();
      scope.quiesce();
      disposing = (async () => {
        const timedOut = await scope.drain(timeout);
        fail();
        return { timedOut };
      })();
      return disposing;
    },
  };
  const stageSkins = () => {
    for (const skin of manifest.contributes?.skins ?? []) scope.contributions.register('skins', {
      id: skin.id,
      value: {
        name: skin.name,
        mode: skin.mode ?? 'dark',
        tokens: (skin.tokens ?? {}) as SkinTokens,
        // v1 扩展元数据原样透传（manifest 校验已保证形状合法）
        preview: skin.preview,
        gallery: skin.gallery,
        tags: skin.tags,
        order: skin.order,
        customization: skin.customization,
      },
    });
  };
  /**
   * manifest 内联的语言包补丁 → locales 槽位（对标 stageSkins）。
   * 与皮肤的区别是这里**不做加工**：LocaleBundle 本身就是最终形态，manifest 校验已递归
   * 保证表体只含字符串与嵌套对象；多包同名语言码由 resolveLocaleTable 按注册顺序叠加。
   *
   * ★id 必须**按插件前缀**而非按语言码下键：不同插件各带一份 jpn 补丁是常态
   * （每个插件只需翻译自己的那几条），按语言码下键会让第二个插件撞 duplicate 而整插件装载失败。
   */
  const stageLocales = () => {
    for (const bundle of manifest.contributes?.locales ?? []) scope.contributions.register('locales', {
      id: `${id}.locale.${bundle.language.toLowerCase()}`,
      value: bundle,
    });
  };
  const finish = (effect: Effect | void) => {
    if (scope.signal.aborted) { lateCleanup(effect); throw new Error('plugin activation aborted'); }
    if (typeof effect === 'function') scope.effects.defer(effect);
    scope.commit();
    root.emit('plugin:activated', { id, slots: Object.keys(manifest.contributes ?? {}) });
    return loaded;
  };
  return { scope, stageSkins, stageLocales, finish, fail };
}
function lateCleanup(value: Effect | void): void {
  if (typeof value === 'function') { try { value(); } catch (error) { console.error('[loader] late cleanup failed', error); } }
}
export function loadBuiltinPlugin(root: Kernel, mod: BuiltinPluginModule): LoadedPlugin {
  const tx = begin(root, mod);
  try {
    tx.stageSkins();
    tx.stageLocales();
    const value = mod.activate?.(tx.scope);
    if (value && typeof (value as unknown as Promise<unknown>).then === 'function') {
      void Promise.resolve(value).then(lateCleanup, () => {});
      throw new Error('async activation requires loadBuiltinPluginAsync');
    }
    return tx.finish(value);
  } catch (error) { tx.fail(); throw error; }
}
export async function loadBuiltinPluginAsync(root: Kernel, mod: AsyncBuiltinPluginModule, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LoadedPlugin> {
  const timeout = duration(options.timeoutMs, 10000);
  if (options.signal?.aborted) throw new Error('plugin activation aborted');
  const tx = begin(root, mod);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let settled = false;
  try {
    tx.stageSkins();
    tx.stageLocales();
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => { if (!settled) { tx.fail(); reject(new Error('plugin activation aborted')); } };
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { if (!settled) { tx.fail(); reject(new Error('plugin activation timed out')); } }, timeout);
    });
    const activation = Promise.resolve().then(() => {
      if (tx.scope.signal.aborted) throw new Error('plugin activation aborted');
      return mod.activate?.(tx.scope);
    }).then(value => {
      if (tx.scope.signal.aborted) { lateCleanup(value); throw new Error('late plugin activation discarded'); }
      return value;
    });
    const effect = await Promise.race([activation, interrupted]);
    return tx.finish(effect);
  } catch (error) { tx.fail(); throw error; }
  finally { settled = true; if (timer !== undefined) clearTimeout(timer); if (abort) options.signal?.removeEventListener('abort', abort); }
}
export function loadBuiltinPlugins(root: Kernel, mods: BuiltinPluginModule[]): LoadedPlugin[] {
  const loaded: LoadedPlugin[] = [];
  const seen = new Set<string>();
  const pending: { mod: BuiltinPluginModule; manifest: PluginManifest }[] = [];
  const report = (mod: BuiltinPluginModule, error: unknown) => {
    const id = (mod.manifest as { id?: unknown } | undefined)?.id ?? '<unknown>';
    if (error instanceof PluginCompatibilityError) console.warn(`[loader] skipped incompatible plugin: ${error.message}`);
    else console.error(`[loader] plugin failed to load and was skipped: ${id}:`, error);
    root.emit('plugin:load-failed', { id, reason: error instanceof Error ? error.message : String(error) });
  };
  for (const mod of mods) {
    try {
      const manifest = validateManifest(mod.manifest);
      assertManifestHostCompatibility(manifest);
      if (seen.has(manifest.id)) throw new Error(`duplicate plugin id: ${manifest.id}`);
      seen.add(manifest.id);
      pending.push({ mod, manifest });
    } catch (error) { report(mod, error); }
  }
  while (pending.length) {
    const index = pending.findIndex(({ manifest }) => manifest.requires.every(dep => registry(root).get(dep)?.scope.status === 'active'));
    if (index < 0) {
      for (const { mod } of pending) report(mod, new Error('missing, failed or cyclic required dependency'));
      break;
    }
    const [{ mod }] = pending.splice(index, 1);
    try { loaded.push(loadBuiltinPlugin(root, mod)); } catch (error) { report(mod, error); }
  }
  return loaded;
}
