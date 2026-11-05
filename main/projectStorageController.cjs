/**
 * Narrow Node-side controller used by Electron IPC and the custom asset protocol.
 * ponytail: exactly one current project is owned here; multi-window/project sessions,
 * streaming media and import jobs are deliberately deferred to a later worker phase.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const {
  ProjectRepository,
  ProjectStorageError,
  contentHashFromStorageRef,
} = require('../storage/projectRepository.cjs');
const { AssetDerivativeController } = require('./assetDerivativeController.cjs');
const { AssetImportController } = require('./assetImportController.cjs');

const MAX_IMPORT_BYTES = 128 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_VIEWPORT_QUERY_BYTES = 4 * 1024;
const MAX_ASSET_INVENTORY_BYTES = 4 * 1024;
const MAX_ASSET_RECLAIM_BYTES = 256 * 1024;
const SAFE_MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*charset=[A-Za-z0-9._-]+)?$/;

function normalizeMimeType(mimeType) {
  return typeof mimeType === 'string' && SAFE_MIME_TYPE.test(mimeType)
    ? mimeType
    : 'application/octet-stream';
}

function asTransferBytes(bytes, maxBytes) {
  let view;
  if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
  else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  else throw new ProjectStorageError('import bytes must be an ArrayBuffer or typed array');
  if (view.byteLength > maxBytes) {
    throw new ProjectStorageError(`asset import exceeds the ${maxBytes} byte IPC limit`);
  }
  return view;
}

function assertOriginalName(originalName) {
  if (originalName === undefined) return undefined;
  if (typeof originalName !== 'string' || originalName.length > 255) {
    throw new ProjectStorageError('original name must be a string no longer than 255 characters');
  }
  return originalName;
}

function serializedByteLength(value, label, limit) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ProjectStorageError(`${label} must be JSON serializable: ${error.message}`);
  }
  if (typeof serialized !== 'string') throw new ProjectStorageError(`${label} must be JSON serializable`);
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength > limit) throw new ProjectStorageError(`${label} exceeds the ${limit} byte IPC limit`);
  return byteLength;
}

class ProjectStorageController {
  constructor({
    openRepository = ProjectRepository.open,
    createDerivativeController = options => new AssetDerivativeController(options),
    createImportController = options => new AssetImportController(options),
    maxImportBytes = MAX_IMPORT_BYTES,
    maxDocumentBytes = MAX_DOCUMENT_BYTES,
    sessionFilePath = null,
  } = {}) {
    this.openRepository = openRepository;
    this.createDerivativeController = createDerivativeController;
    this.createImportController = createImportController;
    this.maxImportBytes = maxImportBytes;
    this.maxDocumentBytes = maxDocumentBytes;
    this.sessionFilePath = sessionFilePath;
    this.repository = null;
    this.derivativeController = null;
    this.importController = null;
    this.projectRoot = null;
  }

  async persistSession(projectRoot) {
    if (!this.sessionFilePath || !projectRoot) return;
    try {
      await fsPromises.mkdir(path.dirname(this.sessionFilePath), { recursive: true });
      await fsPromises.writeFile(
        this.sessionFilePath,
        JSON.stringify({ lastProjectRoot: projectRoot, savedAt: Date.now() }, null, 2),
        'utf8',
      );
    } catch (error) {
      console.warn('Failed to persist Artflow project session:', error.message);
    }
  }

  async readPersistedSession() {
    if (!this.sessionFilePath) return null;
    try {
      const text = await fsPromises.readFile(this.sessionFilePath, 'utf8');
      const data = JSON.parse(text);
      return typeof data?.lastProjectRoot === 'string' && data.lastProjectRoot.trim().length > 0
        ? data.lastProjectRoot.trim()
        : null;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Failed to read Artflow project session:', error.message);
      }
      return null;
    }
  }

  async clearPersistedSession() {
    if (!this.sessionFilePath) return;
    try {
      await fsPromises.rm(this.sessionFilePath, { force: true });
    } catch (error) {
      console.warn('Failed to clear Artflow project session:', error.message);
    }
  }

  async restoreLastSession() {
    const lastRoot = await this.readPersistedSession();
    if (!lastRoot) return null;
    try {
      if (!fs.existsSync(lastRoot)) {
        await this.clearPersistedSession();
        return null;
      }
      return await this.openProject(lastRoot);
    } catch (error) {
      console.warn('Failed to restore project from last session:', error.message);
      return null;
    }
  }

  #requireRepository() {
    if (!this.repository) throw new ProjectStorageError('no managed project is open');
    return this.repository;
  }

  status() {
    return {
      isOpen: this.repository !== null,
      projectName: this.projectRoot ? path.basename(this.projectRoot) || this.projectRoot : null,
    };
  }

  async openProject(projectRoot) {
    const nextRepository = await this.openRepository(projectRoot);
    let nextDerivativeController;
    let nextImportController;
    try {
      nextDerivativeController = this.createDerivativeController({ repository: nextRepository });
      nextImportController = this.createImportController({ repository: nextRepository });
      nextDerivativeController.restore?.();
      nextImportController.restore?.();
    } catch (error) {
      nextImportController?.close();
      nextDerivativeController?.close();
      nextRepository.close();
      throw error;
    }
    const previousRepository = this.repository;
    const previousDerivativeController = this.derivativeController;
    const previousImportController = this.importController;
    this.repository = nextRepository;
    this.derivativeController = nextDerivativeController;
    this.importController = nextImportController;
    this.projectRoot = nextRepository.projectRoot || projectRoot;
    if (this.sessionFilePath) {
      await this.persistSession(this.projectRoot);
    }
    try {
      previousImportController?.close();
      previousDerivativeController?.close();
      previousRepository?.close();
    } catch (error) {
      // The newly opened repository remains usable; close failures are non-authoritative here.
      console.warn('Failed to close previous Artflow project repository:', error);
    }
    return this.status();
  }

  async importAsset(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new ProjectStorageError('asset import request must be an object');
    }
    const bytes = asTransferBytes(request.bytes, this.maxImportBytes);
    const originalName = assertOriginalName(request.originalName);
    serializedByteLength(request.asset, 'asset metadata', 64 * 1024);
    return this.#requireRepository().putAsset({
      asset: request.asset,
      bytes,
      originalName,
    });
  }

  saveProject(document) {
    serializedByteLength(document, 'project document', this.maxDocumentBytes);
    this.#requireRepository().saveProjectDocument(document);
  }

  loadProject() {
    return this.#requireRepository().loadProjectDocument();
  }

  // ponytail: saved-snapshot query only; live renderer state remains on the R11 local index.
  queryViewport(request) {
    serializedByteLength(request, 'viewport query request', MAX_VIEWPORT_QUERY_BYTES);
    return this.#requireRepository().queryViewport(request);
  }

  listAssetInventory(request) {
    serializedByteLength(request ?? {}, 'asset inventory request', MAX_ASSET_INVENTORY_BYTES);
    return this.#requireRepository().listAssetInventory(request ?? {});
  }

  reclaimUnreferencedAssets(request) {
    serializedByteLength(request, 'asset reclaim request', MAX_ASSET_RECLAIM_BYTES);
    return this.#requireRepository().reclaimUnreferencedAssets(request);
  }

  renameAssetNames(request) {
    serializedByteLength(request, 'asset rename request', 16 * 1024);
    return this.#requireRepository().renameAssetNames(request ?? {});
  }

  #requireDerivativeController() {
    this.#requireRepository();
    if (!this.derivativeController) throw new ProjectStorageError('no derivative controller is available');
    return this.derivativeController;
  }

  #requireImportController() {
    this.#requireRepository();
    if (!this.importController) throw new ProjectStorageError('no import controller is available');
    return this.importController;
  }

  async requestImport(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new ProjectStorageError('import job request must be an object');
    }
    const bytes = asTransferBytes(request.bytes, this.maxImportBytes);
    const originalName = assertOriginalName(request.originalName);
    return this.#requireImportController().requestImport({ asset: request.asset, bytes, originalName });
  }

  getImportJob(jobId) {
    return this.#requireImportController().getJob(jobId);
  }

  listImportJobs() {
    return this.#requireImportController().listJobs();
  }

  cancelImportJob(jobId) {
    return this.#requireImportController().cancelJob(jobId);
  }

  requestPreview(assetId) {
    return this.#requireDerivativeController().requestPreview(assetId);
  }

  getPreviewJob(jobId) {
    return this.#requireDerivativeController().getJob(jobId);
  }

  cancelPreviewJob(jobId) {
    return this.#requireDerivativeController().cancelJob(jobId);
  }

  async resolveAssetRequest(storageUrl) {
    if (typeof storageUrl !== 'string') throw new ProjectStorageError('asset protocol URL must be a string');
    let parsed;
    try {
      parsed = new URL(storageUrl);
    } catch {
      throw new ProjectStorageError('asset protocol URL is invalid');
    }
    if (parsed.protocol !== 'artflow-asset:' || parsed.hostname !== 'sha256' || parsed.search || parsed.hash) {
      throw new ProjectStorageError('asset protocol URL is not a canonical storage reference');
    }
    const contentHash = contentHashFromStorageRef(storageUrl);
    if (!contentHash || parsed.pathname !== `/${contentHash}`) {
      throw new ProjectStorageError('asset protocol URL is not a canonical storage reference');
    }
    const repository = this.#requireRepository();
    const stored = repository.getAssetByContentHash(contentHash);
    if (!stored) throw new ProjectStorageError('asset protocol reference is not registered');
    const bytes = await repository.readBlob(contentHash);
    return {
      bytes,
      contentHash,
      mimeType: normalizeMimeType(stored.asset.locator.mimeType),
    };
  }

  close() {
    const repository = this.repository;
    const derivativeController = this.derivativeController;
    const importController = this.importController;
    this.repository = null;
    this.derivativeController = null;
    this.importController = null;
    this.projectRoot = null;
    importController?.close();
    derivativeController?.close();
    repository?.close();
  }
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  MAX_IMPORT_BYTES,
  MAX_VIEWPORT_QUERY_BYTES,
  MAX_ASSET_INVENTORY_BYTES,
  MAX_ASSET_RECLAIM_BYTES,
  ProjectStorageController,
  normalizeMimeType,
};
