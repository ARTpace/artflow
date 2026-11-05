import type { AssetRecord, ArtflowStorageApi, ManagedImportJob, ProjectDocumentV2 } from '../types';

type ManagedImportStorage = Pick<ArtflowStorageApi, 'importAsset'>
  & Partial<Pick<ArtflowStorageApi, 'requestImport' | 'getImportJob'>>;

const IMPORT_JOB_POLL_INTERVAL_MS = 50;
const ACTIVE_IMPORT_JOB_STATUSES = new Set<ManagedImportJob['status']>(['queued', 'running']);
const TERMINAL_IMPORT_JOB_STATUSES = new Set<ManagedImportJob['status']>(['completed', 'cancelled', 'failed']);

export interface ManagedImportJobUpdate {
  assetId: string;
  /** One-based document asset ordinal, suitable for user-visible progress. */
  assetOrdinal: number;
  assetCount: number;
  job: ManagedImportJob;
}

export interface ManagedProjectMaterializeOptions {
  /** Observation only: callback failures must not change import/save correctness. */
  onImportJobUpdate?: (update: ManagedImportJobUpdate) => void;
}

const isImportableRuntimeLocator = (reference: unknown): reference is string =>
  typeof reference === 'string' && (reference.startsWith('data:') || reference.startsWith('blob:'));

const importCandidates = (asset: AssetRecord): Array<string | undefined> =>
  asset.kind === 'image'
    ? [asset.locator.originalRef, asset.locator.previewRef]
    : [asset.locator.fileRef];

const originalNameFor = (asset: AssetRecord): string | undefined => {
  const originalName = asset.metadata.originalName;
  return typeof originalName === 'string' ? originalName : undefined;
};

const supportsDurableImportJobs = (
  storage: ManagedImportStorage,
): storage is ManagedImportStorage & Required<Pick<ArtflowStorageApi, 'requestImport' | 'getImportJob'>> =>
  typeof storage.requestImport === 'function' && typeof storage.getImportJob === 'function';

const waitForImportJob = async (
  storage: ManagedImportStorage & Required<Pick<ArtflowStorageApi, 'requestImport' | 'getImportJob'>>,
  job: ManagedImportJob,
  assetId: string,
  report?: (job: ManagedImportJob) => void,
): Promise<AssetRecord> => {
  let current = job;
  let lastObservation = '';
  const observe = (candidate: ManagedImportJob) => {
    const signature = `${candidate.status}:${candidate.progress}:${candidate.errorCode ?? ''}:${candidate.result?.contentHash ?? ''}`;
    if (signature === lastObservation) return;
    lastObservation = signature;
    report?.(candidate);
  };
  if (current.assetId !== assetId) throw new Error(`Asset ${assetId} import job ${current.id} returned a mismatched asset`);
  observe(current);
  while (ACTIVE_IMPORT_JOB_STATUSES.has(current.status)) {
    await new Promise<void>(resolve => setTimeout(resolve, IMPORT_JOB_POLL_INTERVAL_MS));
    const next = await storage.getImportJob(current.id);
    if (!next) throw new Error(`Asset ${assetId} import job ${current.id} is no longer available`);
    if (next.assetId !== assetId) throw new Error(`Asset ${assetId} import job ${current.id} returned a mismatched asset`);
    current = next;
    observe(current);
  }
  if (!TERMINAL_IMPORT_JOB_STATUSES.has(current.status)) {
    throw new Error(`Asset ${assetId} import job ${current.id} returned an unsupported status`);
  }
  if (current.status !== 'completed') {
    const reason = current.errorCode ? ` (${current.errorCode})` : '';
    throw new Error(`Asset ${assetId} import job ${current.id} did not complete: ${current.status}${reason}`);
  }
  if (!current.result || current.result.asset.id !== assetId) {
    throw new Error(`Asset ${assetId} import job ${current.id} completed without a matching managed result`);
  }
  return current.result.asset;
};

async function importAssetRecord(
  asset: AssetRecord,
  storage: ManagedImportStorage,
  report?: (job: ManagedImportJob) => void,
): Promise<AssetRecord> {
  if (asset.sourceKind === 'managed-store') return asset;
  const reference = importCandidates(asset).find(isImportableRuntimeLocator);
  // ponytail: only in-memory renderer-owned data/blob URLs are eligible; external fetch is deliberately not implicit.
  if (!reference) throw new Error(`Asset ${asset.id} must be data/blob backed before it can enter the managed project store`);
  const response = await fetch(reference);
  if (!response.ok) throw new Error(`Asset ${asset.id} could not be read for managed storage (${response.status})`);
  const request = {
    asset,
    bytes: await response.arrayBuffer(),
    originalName: originalNameFor(asset),
  };
  if (!supportsDurableImportJobs(storage)) {
    return (await storage.importAsset(request)).asset;
  }
  // ponytail: save awaits one terminal job; transaction recovery and batch scheduling stay separate work.
  return waitForImportJob(storage, await storage.requestImport(request), asset.id, report);
}

/** Convert existing R3 locator assets to R4 managed asset records before privileged project save. */
export async function materializeManagedProjectDocument(
  document: ProjectDocumentV2,
  storage: ManagedImportStorage,
  options: ManagedProjectMaterializeOptions = {},
): Promise<ProjectDocumentV2> {
  const assets: AssetRecord[] = [];
  for (const [index, asset] of document.assets.entries()) {
    const report = options.onImportJobUpdate
      ? (job: ManagedImportJob) => {
        try {
          options.onImportJobUpdate?.({
            assetId: asset.id,
            assetOrdinal: index + 1,
            assetCount: document.assets.length,
            job,
          });
        } catch (error) {
          // UI observation cannot turn an otherwise valid managed save into a failed materialization.
          console.warn('Ignored managed import progress observer error:', error);
        }
      }
      : undefined;
    assets.push(await importAssetRecord(asset, storage, report));
  }
  return { ...document, assets };
}

export const hasManagedProjectStorage = (): boolean =>
  typeof window !== 'undefined' && window.artflowStorage !== undefined;
