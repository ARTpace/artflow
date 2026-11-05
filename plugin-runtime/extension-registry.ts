import {
  ExtensionNodeRegistry, invariant, readInstalled, validateData, validateExtensionPackage, writeInstalled,
  type ExtensionData, type InstalledPackage,
} from './extension-package';
import { createWorkerParser, type ParseProgress } from './extension-parser';
import { createPreferenceStorage } from './preference-storage';
import type { Kernel } from './kernel';
import { resolveFormatHandler } from './format-handlers';
import { describeImportError } from '../utils/importFailures';

export interface ImportBatchEntry {
  id: string;
  name: string;
  status: 'parsing' | 'parsed' | 'committed' | 'failed' | 'cancelled';
  progress: { stage: 'reading' | 'parsing' | 'committing' | 'idle'; done: number; total: number };
  records?: ExtensionData[];
  error?: string;
}
export interface ExternalImportBatch {
  id: string;
  packageId: string;
  boardId: string;
  status: 'parsing' | 'committing' | 'completed' | 'failed' | 'cancelled';
  entries: ImportBatchEntry[];
}
export interface ExtensionRuntime {
  registry: ExtensionNodeRegistry;
  /** UI observation only; firing failures never affect install/enable correctness. */
  subscribe(listener: () => void): () => void;
  installed: () => readonly InstalledPackage[];
  install(input: unknown): void;
  uninstall(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  replaceVersion(id: string, input: unknown): void;
  parseFile(id: string, file: File, signal: AbortSignal, onProgress: (progress: ParseProgress) => void): Promise<ExtensionData[]>;
  beginBatch(id: string, boardId: string): string;
  addFileEntry(batchId: string, entry: { id: string; name: string }): void;
  updateBatchProgress(batchId: string, entryId: string, progress: ParseProgress): void;
  completeFileEntry(batchId: string, entryId: string, records: ExtensionData[]): void;
  markBatchEntryFailed(batchId: string, entryId: string, error: string): void;
  commitBatch(batchId: string, boardId: string, commit: (entries: { id: string; name: string; records: ExtensionData[] }[]) => void): void;
  cancelBatch(batchId: string): void;
  batches(): readonly ExternalImportBatch[];
  matchFormat(file: Pick<File, 'name'>): string | undefined;
  resolveFileHandler(kernel: Kernel, file: File): string | undefined;
  dispose(): void;
}
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const MAX_BATCHES = 8;
const MAX_FILE_ENTRIES = 64;
/** One commit is one document transaction; the document SDK caps operations at 1000. */
const MAX_BATCH_RECORDS = 1000;
const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * 扩展包（installed 列表）的存储：从 localStorage 搬到主进程 config/preferences.json，
 * 键 `extensions.installed`。`readInstalled` / `writeInstalled` 的 `Pick<Storage, ...>`
 * 注入契约原样保留 —— 换的只是默认实现。
 * 顺带修掉一个隐患：原来的默认值 `globalThis.localStorage` 在无 DOM 环境（SSR 自检 /
 * 单元测试）里是 `undefined`，会在首次读盘时炸；适配器在无桥时会自动退回内存卷。
 */
export const extensionStorage: Pick<Storage, 'getItem' | 'setItem'> = createPreferenceStorage({
  namespace: 'extensions',
  toPreferenceKey: () => 'extensions.installed',
});

export function createExtensionRuntime(storage: Pick<Storage, 'getItem' | 'setItem'> = extensionStorage): ExtensionRuntime {
  const registry = new ExtensionNodeRegistry();
  const batches = new Map<string, ExternalImportBatch>();
  let disposed = false;
  const live = () => { if (disposed) throw new Error('Extension runtime disposed'); };
  const parser = createWorkerParser();
  const entries = (): InstalledPackage[] => readInstalled(storage);
  const find = (id: string): InstalledPackage => {
    const entry = entries().find(item => item.package.id === id);
    invariant(entry, `Extension not installed: ${id}`);
    return entry;
  };
  const checkDependencies = (pkg: { id: string; requires?: readonly string[] }) => {
    const all = entries();
    for (const dep of pkg.requires ?? []) {
      invariant(dep !== pkg.id, 'Extension cannot depend on itself');
      invariant(all.find(item => item.package.id === dep)?.enabled, `Dependency not enabled: ${dep}`);
    }
  };
  const dependentsOf = (id: string) => entries().filter(item => item.enabled && item.package.id !== id && (item.package.requires ?? []).includes(id));
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of [...listeners]) { try { listener(); } catch { /* observation only */ } } };
  const syncRegistry = (changed: boolean): void => {
    for (const { owner } of registry.all()) registry.unregister(owner);
    for (const entry of entries()) if (entry.enabled) registry.register(entry.package.id, entry.package.node);
    if (changed) notify();
  };
  const recordCount = (batch: ExternalImportBatch) => batch.entries.reduce((total, entry) => total + (entry.records?.length ?? 0), 0);
  syncRegistry(false);
  return {
    registry,
    subscribe: (listener) => {
      live(); listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    installed: () => { live(); return entries(); },
    install(input: unknown) {
      live(); const pkg = validateExtensionPackage(input); checkDependencies(pkg);
      invariant(!entries().some(item => item.package.id === pkg.id), 'Extension already installed; use replaceVersion to upgrade');
      writeInstalled(storage, [...entries(), { package: pkg, enabled: true, grants: [...pkg.permissions] }]);
      syncRegistry(true);
    },
    uninstall(id: string) {
      live(); find(id);
      invariant(dependentsOf(id).length === 0, 'Another enabled extension depends on it');
      writeInstalled(storage, entries().filter(item => item.package.id !== id));
      syncRegistry(true);
    },
    setEnabled(id: string, enabled: boolean) {
      live(); const all = entries(); const entry = all.find(item => item.package.id === id);
      invariant(entry, `Extension not installed: ${id}`);
      if (entry.enabled === enabled) return;
      if (enabled) {
        checkDependencies(entry.package);
      } else {
        invariant(dependentsOf(id).length === 0, 'Another enabled extension depends on it');
        invariant([...batches.values()].every(batch => batch.packageId !== id || TERMINAL.includes(batch.status)), 'Wait for active extension imports to finish');
      }
      entry.enabled = enabled;
      writeInstalled(storage, all);
      syncRegistry(true);
    },
    replaceVersion(id: string, input: unknown) {
      live(); const next = validateExtensionPackage(input); const all = entries();
      const entry = all.find(item => item.package.id === id);
      invariant(entry, `Extension not installed: ${id}`);
      invariant(next.version !== entry.package.version, 'Same version cannot be replaced');
      invariant((next.requires ?? []).every(dep => dep === id || all.find(item => item.package.id === dep)), 'Replacement requires installed dependencies');
      entry.previous = entry.package;
      entry.package = next;
      entry.grants = entry.grants.filter(grant => (next.permissions as readonly string[]).includes(grant));
      writeInstalled(storage, all);
      syncRegistry(true);
    },
    async parseFile(id, file, signal, onProgress) {
      live(); const entry = find(id);
      invariant(entry.enabled, `Extension disabled: ${id}`);
      const definition = entry.package.node;
      const data = await parser.parse(file, signal, onProgress);
      for (const record of data) validateData(record, definition, true);
      return data;
    },
    beginBatch(id: string, boardId: string) {
      live(); const entry = find(id);
      invariant(entry.enabled, `Extension disabled: ${id}`);
      invariant(typeof boardId === 'string' && boardId.length > 0 && boardId.length <= 128, 'Invalid board id');
      if (batches.size >= MAX_BATCHES) {
        const stale = [...batches.entries()].find(([, b]) => TERMINAL.includes(b.status));
        invariant(stale, 'Too many import batches'); batches.delete(stale[0]);
      }
      const batch: ExternalImportBatch = { id: nextId('batch'), packageId: id, boardId, status: 'parsing', entries: [] };
      batches.set(batch.id, batch);
      return batch.id;
    },
    addFileEntry(batchId, entry) {
      live(); const batch = batches.get(batchId); invariant(batch, 'Unknown batch');
      invariant(batch.status === 'parsing' && !batch.entries.some(item => item.id === entry.id) && batch.entries.length < MAX_FILE_ENTRIES, 'Batch entry invalid or full');
      batch.entries = [...batch.entries, { id: entry.id, name: entry.name, status: 'parsing', progress: { stage: 'reading', done: 0, total: 1 } }];
      notify();
    },
    updateBatchProgress(batchId, entryId, progress) {
      live(); const batch = batches.get(batchId); invariant(batch, 'Unknown batch');
      const target = batch.entries.find(item => item.id === entryId); invariant(target, 'Unknown entry');
      batch.entries = batch.entries.map(item => item.id === entryId ? { ...item, progress } : item);
      notify();
    },
    completeFileEntry(batchId, entryId, records) {
      live(); const batch = batches.get(batchId); invariant(batch, 'Unknown batch');
      invariant(batch.status === 'parsing', 'Batch is not open');
      invariant(Array.isArray(records) && records.length > 0 && records.length <= 1000, 'File must parse into 1..1000 records');
      invariant(recordCount(batch) + records.length <= MAX_BATCH_RECORDS, 'Batch record limit reached (1000 per commit transaction)');
      batch.entries = batch.entries.map(item => item.id === entryId
        ? { ...item, status: 'parsed' as const, records: [...records], progress: { stage: 'idle', done: 1, total: 1 } }
        : item);
      notify();
    },
    markBatchEntryFailed(batchId, entryId, error) {
      live(); const batch = batches.get(batchId); invariant(batch, 'Unknown batch');
      batch.entries = batch.entries.map(item => item.id === entryId ? { ...item, status: 'failed' as const, error } : item);
      notify();
    },
    commitBatch(batchId, boardId, commit) {
      live(); const batch = batches.get(batchId); invariant(batch, 'Unknown batch');
      if (TERMINAL.includes(batch.status)) return;
      invariant(batch.boardId === boardId, 'Batch target board changed; batch cannot commit');
      const ready = batch.entries.filter(entry => entry.status === 'parsed' && entry.records?.length);
      invariant(ready.length > 0, 'Batch has no parsed entries to commit');
      batch.status = 'committing';
      notify();
      try {
        commit(ready.map(entry => ({ id: entry.id, name: entry.name, records: entry.records! })));
        batch.entries = batch.entries.map(entry => entry.status === 'parsed'
          ? { ...entry, status: 'committed' as const, progress: { stage: 'committing', done: 1, total: 1 } }
          : entry);
        batch.status = batch.entries.every(entry => entry.status === 'committed') ? 'completed' : 'failed';
      } catch (error) {
        batch.status = 'failed';
        batch.entries = batch.entries.map(entry => entry.status === 'parsed'
          ? { ...entry, status: 'failed' as const, error: describeImportError(error) }
          : entry);
      }
      notify();
    },
    cancelBatch(batchId) {
      live(); const batch = batches.get(batchId); if (!batch || TERMINAL.includes(batch.status)) return;
      batch.status = 'cancelled';
      batch.entries = batch.entries.map(entry => TERMINAL.includes(entry.status) ? entry : { ...entry, status: 'cancelled' as const, error: 'Batch cancelled' });
      notify();
    },
    batches: () => { live(); return [...batches.values()]; },
    matchFormat: (file: Pick<File, 'name'>) => {
      live();
      const dot = file.name.lastIndexOf('.');
      if (dot < 0) return undefined;
      const extension = file.name.slice(dot + 1).toLowerCase();
      return entries().find(entry => entry.enabled && entry.package.formats.some(f => f.extension.toLowerCase() === extension))?.package.id ?? undefined;
    },
    resolveFileHandler: (kernel, file) => { live(); const handler = resolveFormatHandler(kernel, file); return handler ? handler.pluginId : undefined; },
    dispose() {
      if (disposed) return; disposed = true;
      for (const { owner } of registry.all()) registry.unregister(owner);
      batches.clear();
      listeners.clear();
    },
  };
}
