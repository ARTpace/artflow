/**
 * Mediated asset-name access for a third-party panel.
 * The panel receives this object as props. It does not see the database or the canvas store.
 */

import type { CanvasMutationService } from './canvas-mutation';
import type { HostPlatformService } from './host-platform';

export interface AssetNameItem {
  id: string;
  name: string;
  kind: string;
  byteSize: number;
}

export interface AssetNameChange {
  id: string;
  name: string;
}

export interface AssetLibraryClient {
  list(): Promise<{ ok: true; items: AssetNameItem[] } | { ok: false; message: string }>;
  rename(changes: AssetNameChange[]): Promise<{ ok: true; renamed: string[]; missing: string[] } | { ok: false; message: string }>;
}

const PAGE = 100;
const MAX_ITEMS = 500;

export function createAssetLibraryClient(options: {
  allowRename: boolean;
  listInventory: HostPlatformService['listAssetInventory'];
  renameNames: HostPlatformService['renameAssetNames'];
  patchCanvasNames?: (names: ReadonlyMap<string, string>) => void;
}): AssetLibraryClient {
  return {
    async list() {
      if (!options.allowRename) return { ok: false, message: 'asset rename is not permitted' };
      const items: AssetNameItem[] = [];
      for (let offset = 0; offset < MAX_ITEMS; offset += PAGE) {
        const page = await options.listInventory({ offset, limit: PAGE });
        if (page.ok === false) return page;
        for (const item of page.inventory.items) {
          items.push({ id: item.id, name: item.originalName, kind: item.kind, byteSize: item.byteSize });
        }
        if (page.inventory.items.length < PAGE) break;
      }
      return { ok: true, items };
    },
    async rename(changes) {
      if (!options.allowRename) return { ok: false, message: 'asset rename is not permitted' };
      if (!Array.isArray(changes) || changes.length < 1 || changes.length > 40) {
        return { ok: false, message: 'rename requires 1 to 40 assets' };
      }
      const result = await options.renameNames({ changes });
      if (result.ok === false) return result;
      const renamed = new Set(result.renamed);
      const names = new Map<string, string>();
      for (const change of changes) {
        if (renamed.has(change.id)) names.set(change.id, change.name.trim());
      }
      options.patchCanvasNames?.(names);
      return result;
    },
  };
}

export function patchAssetDisplayNames(mutation: CanvasMutationService, names: ReadonlyMap<string, string>): void {
  if (names.size === 0) return;
  const patches = [];
  for (const element of mutation.getElements()) {
    const assetId = element.assetId;
    const name = typeof assetId === 'string' ? names.get(assetId) : undefined;
    if (!name) continue;
    patches.push({ id: element.id, patch: { name } });
  }
  if (patches.length > 0) mutation.patchElements(patches, { committed: true });
}
