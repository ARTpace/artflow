/**
 * ProjectRepository is the Node-side Phase 2a storage seam.
 * ponytail: it owns immutable originals + metadata snapshots. Renderer IPC and
 * derivative generation stay outside this file. Unreferenced rows can be reclaimed
 * only through reclaimUnreferencedAssets, which keeps saved-document and in-flight imports.
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  throw new Error(`Artflow storage requires Node's node:sqlite runtime: ${error.message}`);
}

const STORAGE_SCHEMA_VERSION = 6;
const PROJECT_DOCUMENT_FORMAT = 'artflow-project';
const PROJECT_DOCUMENT_VERSION = 2;
const STORAGE_REF_PREFIX = 'artflow-asset://sha256/';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_KINDS = new Set(['image', 'video', 'audio', 'font', 'model3d', 'file']);
const DERIVATIVE_JOB_STATUSES = new Set(['queued', 'running', 'completed', 'cancelled', 'failed']);
const DERIVATIVE_JOB_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMPORT_JOB_STATUSES = new Set(['queued', 'running', 'completed', 'cancelled', 'failed']);
const IMPORT_JOB_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_IMPORT_JOB_DRAFT_BYTES = 64 * 1024;
const DEFAULT_VIEWPORT_QUERY_LIMIT = 500;
const MAX_VIEWPORT_QUERY_LIMIT = 5000;
const MAX_SPATIAL_COORDINATE = 1e30;
const SAFE_MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const ASSET_NODE_PROPERTY_FIELDS = {
  image: ['href', 'originalHref', 'mimeType'],
  video: ['href', 'mimeType'],
  audio: ['href', 'mimeType'],
  font: ['fontUrl', 'format', 'fileSize'],
  model3d: ['fileUrl', 'fileExtension', 'fileSize'],
  file: ['fileUrl', 'fileExtension', 'fileSize', 'mimeType'],
};

class ProjectStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectStorageError';
  }
}

class StorageIntegrityError extends ProjectStorageError {
  constructor(message) {
    super(message);
    this.name = 'StorageIntegrityError';
  }
}

const cloneJson = value => JSON.parse(JSON.stringify(value));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return Buffer.from(bytes);
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (bytes instanceof ArrayBuffer) return Buffer.from(new Uint8Array(bytes));
  throw new ProjectStorageError('asset bytes must be a Buffer, Uint8Array or ArrayBuffer');
}

function assertAssetId(assetId) {
  if (typeof assetId !== 'string' || assetId.trim().length === 0) {
    throw new ProjectStorageError('asset id must be a non-empty string');
  }
  return assetId;
}

function assertHash(contentHash) {
  if (typeof contentHash !== 'string' || !SHA256_PATTERN.test(contentHash)) {
    throw new ProjectStorageError('content hash must be a lower-case SHA-256 hex digest');
  }
  return contentHash;
}

function assertDerivativeJobId(jobId) {
  if (typeof jobId !== 'string' || !DERIVATIVE_JOB_ID_PATTERN.test(jobId)) {
    throw new ProjectStorageError('derivative job id must be a lower-case UUID');
  }
  return jobId;
}

function assertDerivativeJobStatus(status) {
  if (!DERIVATIVE_JOB_STATUSES.has(status)) throw new ProjectStorageError(`unsupported derivative job status: ${String(status)}`);
  return status;
}

function assertDerivativeJobProgress(progress) {
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new ProjectStorageError('derivative job progress must be a finite number from 0 through 1');
  }
  return progress;
}

function assertImportJobId(jobId) {
  if (typeof jobId !== 'string' || !IMPORT_JOB_ID_PATTERN.test(jobId)) {
    throw new ProjectStorageError('import job id must be a lower-case UUID');
  }
  return jobId;
}

function assertImportJobStatus(status) {
  if (!IMPORT_JOB_STATUSES.has(status)) throw new ProjectStorageError(`unsupported import job status: ${String(status)}`);
  return status;
}

function assertImportJobProgress(progress) {
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new ProjectStorageError('import job progress must be a finite number from 0 through 1');
  }
  return progress;
}

function createStorageRef(contentHash) {
  return `${STORAGE_REF_PREFIX}${assertHash(contentHash)}`;
}

function contentHashFromStorageRef(reference) {
  if (typeof reference !== 'string' || !reference.startsWith(STORAGE_REF_PREFIX)) return null;
  const contentHash = reference.slice(STORAGE_REF_PREFIX.length);
  return SHA256_PATTERN.test(contentHash) ? contentHash : null;
}

function assertAssetRecord(asset) {
  if (!asset || typeof asset !== 'object') throw new ProjectStorageError('asset record is required');
  assertAssetId(asset.id);
  if (!ASSET_KINDS.has(asset.kind)) throw new ProjectStorageError(`unsupported asset kind: ${String(asset.kind)}`);
  if (!asset.locator || typeof asset.locator !== 'object' || Array.isArray(asset.locator)) {
    throw new ProjectStorageError(`asset ${asset.id} must include a locator object`);
  }
  if (asset.metadata !== undefined && (!asset.metadata || typeof asset.metadata !== 'object' || Array.isArray(asset.metadata))) {
    throw new ProjectStorageError(`asset ${asset.id} metadata must be an object`);
  }
}

function managedLocator(asset, storageRef, byteSize) {
  const source = asset.locator;
  const metadata = {
    ...(typeof source.mimeType === 'string' ? { mimeType: source.mimeType } : {}),
    ...(typeof source.extension === 'string' ? { extension: source.extension } : {}),
    ...(typeof source.format === 'string' ? { format: source.format } : {}),
    byteSize,
  };
  return asset.kind === 'image'
    ? { ...metadata, previewRef: storageRef, originalRef: storageRef }
    : { ...metadata, fileRef: storageRef };
}

function managedAssetRecord(asset, contentHash, byteSize) {
  const storageRef = createStorageRef(contentHash);
  return {
    id: asset.id,
    kind: asset.kind,
    sourceKind: 'managed-store',
    locator: managedLocator(asset, storageRef, byteSize),
    metadata: cloneJson(asset.metadata || {}),
  };
}

/** Strip renderer references before a raw import draft becomes durable metadata. */
function importDraftFromAsset(asset) {
  assertAssetRecord(asset);
  let metadata;
  try {
    metadata = cloneJson(asset.metadata || {});
  } catch (error) {
    throw new ProjectStorageError(`import asset ${asset.id} metadata must be JSON serializable: ${error.message}`);
  }
  const locator = {};
  for (const key of ['mimeType', 'extension', 'format']) {
    if (typeof asset.locator[key] === 'string') locator[key] = asset.locator[key];
  }
  const draft = { id: asset.id, kind: asset.kind, locator, metadata };
  let serialized;
  try {
    serialized = JSON.stringify(draft);
  } catch (error) {
    throw new ProjectStorageError(`import asset ${asset.id} draft must be JSON serializable: ${error.message}`);
  }
  if (Buffer.byteLength(serialized) > MAX_IMPORT_JOB_DRAFT_BYTES) {
    throw new ProjectStorageError(`import asset ${asset.id} draft exceeds the ${MAX_IMPORT_JOB_DRAFT_BYTES} byte limit`);
  }
  return { draft, serialized };
}

function importDraftFromJson(serialized) {
  let draft;
  try {
    draft = JSON.parse(serialized);
  } catch (error) {
    throw new StorageIntegrityError(`import job draft is not valid JSON: ${error.message}`);
  }
  try {
    assertAssetRecord(draft);
  } catch (error) {
    throw new StorageIntegrityError(`import job draft is invalid: ${error.message}`);
  }
  const allowed = new Set(['mimeType', 'extension', 'format']);
  if (Object.keys(draft.locator).some(key => !allowed.has(key))) {
    throw new StorageIntegrityError('import job draft contains a renderer reference');
  }
  try {
    return importDraftFromAsset(draft).draft;
  } catch (error) {
    throw new StorageIntegrityError(`import job draft is invalid: ${error.message}`);
  }
}

function assertAssetDisplayName(name) {
  if (typeof name !== 'string') throw new ProjectStorageError('asset name must be a string');
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 180) {
    throw new ProjectStorageError('asset name must be 1 to 180 characters');
  }
  if (/[\u0000-\u001f\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new ProjectStorageError('asset name cannot include a path');
  }
  return trimmed;
}

function assertImportOriginalName(originalName) {
  if (originalName === undefined || originalName === null || originalName === '') return null;
  if (typeof originalName !== 'string' || originalName.length > 255) {
    throw new ProjectStorageError('import original name must be a string no longer than 255 characters');
  }
  return originalName;
}

function assertV2Document(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.format !== PROJECT_DOCUMENT_FORMAT || document.version !== PROJECT_DOCUMENT_VERSION
    || !Array.isArray(document.assets) || !Array.isArray(document.boards) || !Array.isArray(document.nodes)) {
    throw new ProjectStorageError('expected a artflow-project v2 document');
  }
}

function operationAssetIds(operation, target) {
  if (!operation || !Array.isArray(operation.changes)) return;
  for (const change of operation.changes) {
    for (const node of [change?.before, change?.after]) {
      if (node?.assetId) target.add(node.assetId);
    }
  }
}

function referencedAssetIds(document) {
  const ids = new Set();
  for (const node of document.nodes) if (node?.assetId) ids.add(node.assetId);
  for (const board of document.boards) {
    for (const operation of board?.operationHistory || []) operationAssetIds(operation, ids);
  }
  return ids;
}

function assertManagedNode(node, assetById, context) {
  if (!node || typeof node !== 'object') throw new ProjectStorageError(`${context} is not a node record`);
  const assetFields = ASSET_NODE_PROPERTY_FIELDS[node.nodeType];
  if (!assetFields) {
    if (node.assetId) throw new ProjectStorageError(`${context} has an asset id but is not an asset-backed node`);
    return;
  }
  if (!node.assetId || !assetById.has(node.assetId)) {
    throw new ProjectStorageError(`${context} references an unmanaged asset`);
  }
  if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
    throw new ProjectStorageError(`${context} must contain a properties object`);
  }
  for (const key of assetFields) {
    if (Object.prototype.hasOwnProperty.call(node.properties, key)) {
      throw new ProjectStorageError(`${context} leaks asset field ${key} into node properties`);
    }
  }
}


function assertSpatialString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectStorageError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertSpatialNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_SPATIAL_COORDINATE) {
    throw new ProjectStorageError(`${label} must be a finite number within the supported R-tree range`);
  }
  return value;
}

function assertSpatialDimension(value, label) {
  const dimension = value === undefined ? 0 : assertSpatialNumber(value, label);
  if (dimension < 0) throw new ProjectStorageError(`${label} must be non-negative`);
  return dimension;
}

function spatialBounds(x, y, width, height, label) {
  const minX = assertSpatialNumber(x, `${label}.x`);
  const minY = assertSpatialNumber(y, `${label}.y`);
  const safeWidth = assertSpatialDimension(width, `${label}.width`);
  const safeHeight = assertSpatialDimension(height, `${label}.height`);
  const maxX = assertSpatialNumber(minX + safeWidth, `${label}.x + width`);
  const maxY = assertSpatialNumber(minY + safeHeight, `${label}.y + height`);
  return { minX, minY, maxX, maxY };
}

function pointBounds(points, label) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [index, point] of points.entries()) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      throw new ProjectStorageError(`${label}[${index}] must be a point object`);
    }
    const x = assertSpatialNumber(point.x, `${label}[${index}].x`);
    const y = assertSpatialNumber(point.y, `${label}[${index}].y`);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function ownSpatialBounds(node, label) {
  const properties = node.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new ProjectStorageError(`${label}.properties must be an object`);
  }
  const fallback = () => spatialBounds(node.x, node.y, node.width, node.height, label);
  if (node.nodeType !== 'path' && node.nodeType !== 'arrow' && node.nodeType !== 'line') return fallback();

  const points = properties.points;
  if (points === undefined) {
    return node.nodeType === 'path'
      ? spatialBounds(node.x, node.y, 0, 0, label)
      : spatialBounds(node.x, node.y, 10, 10, label);
  }
  if (!Array.isArray(points)) throw new ProjectStorageError(`${label}.properties.points must be an array`);
  const minimum = node.nodeType === 'path' ? 1 : 2;
  if (points.length < minimum) {
    return node.nodeType === 'path'
      ? spatialBounds(node.x, node.y, 0, 0, label)
      : spatialBounds(node.x, node.y, 10, 10, label);
  }
  return pointBounds(node.nodeType === 'path' ? points : points.slice(0, 2), `${label}.properties.points`);
}

function spatialEntriesFromDocument(document) {
  const boardIds = new Set();
  for (const board of document.boards) {
    const boardId = assertSpatialString(board?.id, 'board id');
    if (boardIds.has(boardId)) throw new ProjectStorageError(`duplicate board id: ${boardId}`);
    boardIds.add(boardId);
  }

  const keyFor = (boardId, nodeId) => `${boardId}\u0000${nodeId}`;
  const nodesByKey = new Map();
  const childrenByKey = new Map();
  for (const node of document.nodes) {
    const label = `node ${String(node?.id)}`;
    const boardId = assertSpatialString(node?.boardId, `${label}.boardId`);
    const nodeId = assertSpatialString(node?.id, `${label}.id`);
    if (!boardIds.has(boardId)) throw new ProjectStorageError(`${label} references an unknown board: ${boardId}`);
    const nodeType = assertSpatialString(node?.nodeType, `${label}.nodeType`);
    const zIndex = assertSpatialNumber(node?.zIndex, `${label}.zIndex`);
    if (!Number.isInteger(zIndex)) throw new ProjectStorageError(`${label}.zIndex must be an integer`);
    const parentId = node.parentId === undefined ? undefined : assertSpatialString(node.parentId, `${label}.parentId`);
    const key = keyFor(boardId, nodeId);
    if (nodesByKey.has(key)) throw new ProjectStorageError(`duplicate node id for board ${boardId}: ${nodeId}`);
    nodesByKey.set(key, { node, boardId, nodeId, nodeType, zIndex, parentId, key, label });
  }

  for (const entry of nodesByKey.values()) {
    if (entry.parentId === undefined) continue;
    const parent = nodesByKey.get(keyFor(entry.boardId, entry.parentId));
    if (!parent || parent.nodeType !== 'group') continue;
    const children = childrenByKey.get(parent.key) ?? [];
    children.push(entry);
    childrenByKey.set(parent.key, children);
  }

  const states = new Map();
  const resolved = new Map();
  const resolveBounds = entry => {
    const state = states.get(entry.key);
    if (state === 'visiting') throw new ProjectStorageError(`group parent cycle includes node ${entry.nodeId}`);
    if (state === 'resolved') return resolved.get(entry.key);
    states.set(entry.key, 'visiting');
    let bounds;
    const children = childrenByKey.get(entry.key);
    if (entry.nodeType === 'group' && children?.length) {
      const childBounds = children.map(resolveBounds);
      bounds = {
        minX: Math.min(...childBounds.map(child => child.minX)),
        minY: Math.min(...childBounds.map(child => child.minY)),
        maxX: Math.max(...childBounds.map(child => child.maxX)),
        maxY: Math.max(...childBounds.map(child => child.maxY)),
      };
    } else {
      bounds = ownSpatialBounds(entry.node, entry.label);
    }
    states.set(entry.key, 'resolved');
    resolved.set(entry.key, bounds);
    return bounds;
  };

  return [...nodesByKey.values()].map(entry => ({
    boardId: entry.boardId,
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
    parentId: entry.parentId,
    zIndex: entry.zIndex,
    ...resolveBounds(entry),
  }));
}

function sameSpatialBounds(first, second) {
  return first.minX === second.minX && first.minY === second.minY
    && first.maxX === second.maxX && first.maxY === second.maxY;
}

function canonicalViewportRect(bounds) {
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}

function normalizeViewportCursor(cursor, boardId, bounds) {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new ProjectStorageError('viewport query cursor must be an object');
  }
  if (!Number.isSafeInteger(cursor.snapshotRevision) || cursor.snapshotRevision < 0) {
    throw new ProjectStorageError('viewport query cursor snapshotRevision must be a non-negative safe integer');
  }
  if (cursor.boardId !== boardId) throw new ProjectStorageError('viewport query cursor boardId does not match request');
  const cursorRect = cursor.rect;
  if (!cursorRect || typeof cursorRect !== 'object' || Array.isArray(cursorRect)) {
    throw new ProjectStorageError('viewport query cursor rect must be an object');
  }
  const cursorBounds = spatialBounds(cursorRect.x, cursorRect.y, cursorRect.width, cursorRect.height, 'viewport query cursor rect');
  if (!sameSpatialBounds(cursorBounds, bounds)) {
    throw new ProjectStorageError('viewport query cursor rect does not match request');
  }
  const after = cursor.after;
  if (!after || typeof after !== 'object' || Array.isArray(after)) {
    throw new ProjectStorageError('viewport query cursor after must be an object');
  }
  const zIndex = assertSpatialNumber(after.zIndex, 'viewport query cursor after.zIndex');
  if (!Number.isInteger(zIndex)) throw new ProjectStorageError('viewport query cursor after.zIndex must be an integer');
  return {
    snapshotRevision: cursor.snapshotRevision,
    boardId,
    rect: canonicalViewportRect(bounds),
    after: { zIndex, id: assertSpatialString(after.id, 'viewport query cursor after.id') },
  };
}

function normalizeViewportQuery(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ProjectStorageError('viewport query request must be an object');
  }
  const boardId = assertSpatialString(request.boardId, 'viewport query boardId');
  if (boardId.length > 512) throw new ProjectStorageError('viewport query boardId exceeds 512 characters');
  const rect = request.rect;
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) {
    throw new ProjectStorageError('viewport query rect must be an object');
  }
  const bounds = spatialBounds(rect.x, rect.y, rect.width, rect.height, 'viewport query rect');
  const limit = request.limit === undefined ? DEFAULT_VIEWPORT_QUERY_LIMIT : request.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VIEWPORT_QUERY_LIMIT) {
    throw new ProjectStorageError(`viewport query limit must be an integer from 1 through ${MAX_VIEWPORT_QUERY_LIMIT}`);
  }
  return {
    boardId,
    limit,
    rect: canonicalViewportRect(bounds),
    cursor: request.cursor === undefined ? undefined : normalizeViewportCursor(request.cursor, boardId, bounds),
    ...bounds,
  };
}

function rtreeEpsilon(value) {
  return Math.max(1e-6, Math.abs(value) * 1e-7);
}

function rtreeLowerBound(value) {
  const expanded = value - rtreeEpsilon(value);
  return Number.isFinite(expanded) ? expanded : value;
}

function rtreeUpperBound(value) {
  const expanded = value + rtreeEpsilon(value);
  return Number.isFinite(expanded) ? expanded : value;
}

function runInTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function runInReadTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

async function removeIfPresent(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

class ProjectRepository {
  static async open(projectRoot) {
    if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
      throw new ProjectStorageError('project root must be a non-empty path');
    }
    const resolvedProjectRoot = path.resolve(projectRoot);
    const storageRoot = path.join(resolvedProjectRoot, '.artflow');
    const blobRoot = path.join(storageRoot, 'blobs', 'sha256');
    const derivativeRoot = path.join(storageRoot, 'derivatives', 'sha256');
    const importStagingRoot = path.join(storageRoot, 'import-staging', 'sha256');
    const metadataPath = path.join(storageRoot, 'metadata.sqlite');
    await Promise.all([
      fs.mkdir(blobRoot, { recursive: true }),
      fs.mkdir(derivativeRoot, { recursive: true }),
      fs.mkdir(importStagingRoot, { recursive: true }),
    ]);

    let db;
    try {
      db = new DatabaseSync(metadataPath);
      const repository = new ProjectRepository(resolvedProjectRoot, storageRoot, blobRoot, derivativeRoot, importStagingRoot, metadataPath, db);
      repository.#migrate();
      return repository;
    } catch (error) {
      try { db?.close(); } catch { /* original error is more useful */ }
      throw error instanceof ProjectStorageError
        ? error
        : new ProjectStorageError(`failed to open project repository: ${error.message}`);
    }
  }

  constructor(projectRoot, storageRoot, blobRoot, derivativeRoot, importStagingRoot, metadataPath, db) {
    this.projectRoot = projectRoot;
    this.storageRoot = storageRoot;
    this.blobRoot = blobRoot;
    this.derivativeRoot = derivativeRoot;
    this.importStagingRoot = importStagingRoot;
    this.metadataPath = metadataPath;
    this.db = db;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) throw new ProjectStorageError('project repository is closed');
  }

  #migrate() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS asset_metadata (
        asset_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        mime_type TEXT,
        extension TEXT,
        format_name TEXT,
        original_name TEXT,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS asset_metadata_by_content_hash
        ON asset_metadata(content_hash);
      CREATE TABLE IF NOT EXISTS project_documents (
        document_key TEXT PRIMARY KEY CHECK (document_key = 'main'),
        format TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const schemaRow = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    const existingVersion = schemaRow ? Number(schemaRow.value) : null;
    if (existingVersion !== null && (!Number.isInteger(existingVersion) || existingVersion > STORAGE_SCHEMA_VERSION)) {
      throw new ProjectStorageError(`unsupported storage schema version: ${String(schemaRow.value)}`);
    }
    this.#ensureDerivativeSchema();
    this.#ensureDerivativeJobSchema();
    this.#ensureImportJobSchema();
    this.#ensureSpatialSchema();
    this.#ensureSpatialRevisionSchema();

    this.upsertAssetStatement = this.db.prepare(`
      INSERT INTO asset_metadata(
        asset_id, kind, content_hash, byte_size, mime_type, extension, format_name, original_name, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        kind = excluded.kind,
        content_hash = excluded.content_hash,
        byte_size = excluded.byte_size,
        mime_type = excluded.mime_type,
        extension = excluded.extension,
        format_name = excluded.format_name,
        original_name = excluded.original_name,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    this.assetByIdStatement = this.db.prepare(`
      SELECT asset_id, kind, content_hash, byte_size, mime_type, extension, format_name, original_name, metadata_json, created_at, updated_at
      FROM asset_metadata WHERE asset_id = ?
    `);
    this.assetByContentHashStatement = this.db.prepare(`
      SELECT asset_id, kind, content_hash, byte_size, mime_type, extension, format_name, original_name, metadata_json, created_at, updated_at
      FROM asset_metadata WHERE content_hash = ?
      ORDER BY CASE WHEN mime_type IS NULL OR mime_type = 'application/octet-stream' THEN 1 ELSE 0 END,
        updated_at DESC, asset_id ASC LIMIT 1
    `);
    this.saveDocumentStatement = this.db.prepare(`
      INSERT INTO project_documents(document_key, format, version, payload_json, updated_at)
      VALUES ('main', ?, ?, ?, ?)
      ON CONFLICT(document_key) DO UPDATE SET
        format = excluded.format,
        version = excluded.version,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    this.loadDocumentStatement = this.db.prepare(`
      SELECT format, version, payload_json, updated_at FROM project_documents WHERE document_key = 'main'
    `);
    this.upsertDerivativeStatement = this.db.prepare(`
      INSERT INTO derivative_metadata(asset_id, recipe, derivative_hash, mime_type, byte_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id, recipe) DO UPDATE SET
        derivative_hash = excluded.derivative_hash,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        updated_at = excluded.updated_at
    `);
    this.derivativeByAssetRecipeStatement = this.db.prepare(`
      SELECT asset_id, recipe, derivative_hash, mime_type, byte_size, created_at, updated_at
      FROM derivative_metadata WHERE asset_id = ? AND recipe = ?
    `);
    this.insertDerivativeJobStatement = this.db.prepare(`
      INSERT INTO derivative_job_metadata(
        job_id, asset_id, recipe, status, progress, error_code,
        derivative_hash, derivative_mime_type, derivative_byte_size, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateDerivativeJobStatement = this.db.prepare(`
      UPDATE derivative_job_metadata SET
        status = ?, progress = ?, error_code = ?, derivative_hash = ?, derivative_mime_type = ?, derivative_byte_size = ?, updated_at = ?
      WHERE job_id = ?
    `);
    this.derivativeJobByIdStatement = this.db.prepare(`
      SELECT job_id, asset_id, recipe, status, progress, error_code,
        derivative_hash, derivative_mime_type, derivative_byte_size, created_at, updated_at
      FROM derivative_job_metadata WHERE job_id = ?
    `);
    this.derivativeJobsStatement = this.db.prepare(`
      SELECT job_id, asset_id, recipe, status, progress, error_code,
        derivative_hash, derivative_mime_type, derivative_byte_size, created_at, updated_at
      FROM derivative_job_metadata ORDER BY created_at ASC, rowid ASC
    `);
    this.recoverDerivativeJobsStatement = this.db.prepare(`
      UPDATE derivative_job_metadata SET status = 'queued', progress = 0, error_code = NULL, updated_at = ?
      WHERE status = 'running'
    `);
    this.insertImportJobStatement = this.db.prepare(`
      INSERT INTO import_job_metadata(
        job_id, asset_id, asset_json, original_name, staging_hash, staging_byte_size,
        status, progress, error_code, result_content_hash, result_byte_size, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateImportJobStatement = this.db.prepare(`
      UPDATE import_job_metadata SET
        status = ?, progress = ?, error_code = ?, result_content_hash = ?, result_byte_size = ?, updated_at = ?
      WHERE job_id = ?
    `);
    this.importJobByIdStatement = this.db.prepare(`
      SELECT job_id, asset_id, asset_json, original_name, staging_hash, staging_byte_size,
        status, progress, error_code, result_content_hash, result_byte_size, created_at, updated_at
      FROM import_job_metadata WHERE job_id = ?
    `);
    this.importJobsStatement = this.db.prepare(`
      SELECT job_id, asset_id, asset_json, original_name, staging_hash, staging_byte_size,
        status, progress, error_code, result_content_hash, result_byte_size, created_at, updated_at
      FROM import_job_metadata ORDER BY created_at ASC, rowid ASC
    `);
    this.recoverImportJobsStatement = this.db.prepare(`
      UPDATE import_job_metadata SET status = 'queued', progress = 0, error_code = NULL, updated_at = ?
      WHERE status = 'running'
    `);
    this.insertSpatialMetadataStatement = this.db.prepare(`
      INSERT INTO board_node_spatial_metadata(
        spatial_id, board_id, node_id, node_type, parent_id, z_index, min_x, max_x, min_y, max_y
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertSpatialRtreeStatement = this.db.prepare(`
      INSERT INTO board_node_spatial_index(spatial_id, min_x, max_x, min_y, max_y)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.spatialRevisionStatement = this.db.prepare(`
      SELECT revision FROM spatial_projection_metadata WHERE projection_key = 'main'
    `);
    this.seedSpatialRevisionStatement = this.db.prepare(`
      INSERT OR IGNORE INTO spatial_projection_metadata(projection_key, revision) VALUES ('main', ?)
    `);
    this.updateSpatialRevisionStatement = this.db.prepare(`
      UPDATE spatial_projection_metadata SET revision = ? WHERE projection_key = 'main'
    `);
    this.queryViewportInitialStatement = this.db.prepare(`
      SELECT metadata.node_id, metadata.board_id, metadata.node_type, metadata.parent_id,
        metadata.z_index, metadata.min_x, metadata.max_x, metadata.min_y, metadata.max_y
      FROM board_node_spatial_metadata AS metadata
      INNER JOIN board_node_spatial_index AS rtree ON rtree.spatial_id = metadata.spatial_id
      WHERE metadata.board_id = ?
        AND rtree.max_x >= ? AND rtree.min_x <= ?
        AND rtree.max_y >= ? AND rtree.min_y <= ?
        AND metadata.max_x >= ? AND metadata.min_x <= ?
        AND metadata.max_y >= ? AND metadata.min_y <= ?
      ORDER BY metadata.z_index ASC, metadata.node_id ASC
      LIMIT ?
    `);
    this.queryViewportAfterStatement = this.db.prepare(`
      SELECT metadata.node_id, metadata.board_id, metadata.node_type, metadata.parent_id,
        metadata.z_index, metadata.min_x, metadata.max_x, metadata.min_y, metadata.max_y
      FROM board_node_spatial_metadata AS metadata
      INNER JOIN board_node_spatial_index AS rtree ON rtree.spatial_id = metadata.spatial_id
      WHERE metadata.board_id = ?
        AND rtree.max_x >= ? AND rtree.min_x <= ?
        AND rtree.max_y >= ? AND rtree.min_y <= ?
        AND metadata.max_x >= ? AND metadata.min_x <= ?
        AND metadata.max_y >= ? AND metadata.min_y <= ?
        AND (metadata.z_index > ? OR (metadata.z_index = ? AND metadata.node_id > ?))
      ORDER BY metadata.z_index ASC, metadata.node_id ASC
      LIMIT ?
    `);

    runInTransaction(this.db, () => {
      const row = this.loadDocumentStatement.get();
      if ((existingVersion === null || existingVersion < STORAGE_SCHEMA_VERSION) && row) {
        let document;
        try {
          document = JSON.parse(row.payload_json);
          this.#assertManagedDocument(document);
        } catch (error) {
          throw new StorageIntegrityError(`cannot backfill spatial index from stored project document: ${error.message}`);
        }
        this.#replaceSpatialIndex(spatialEntriesFromDocument(document));
      }
      this.#seedSpatialRevision(row ? 1 : 0);
      if (existingVersion === null) {
        this.db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)").run(String(STORAGE_SCHEMA_VERSION));
      } else if (existingVersion < STORAGE_SCHEMA_VERSION) {
        this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(STORAGE_SCHEMA_VERSION));
      }
    });
  }

  #ensureDerivativeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS derivative_metadata (
        asset_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        derivative_hash TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(asset_id, recipe),
        FOREIGN KEY(asset_id) REFERENCES asset_metadata(asset_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS derivative_metadata_by_hash
        ON derivative_metadata(derivative_hash);
    `);
  }

  #ensureDerivativeJobSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS derivative_job_metadata (
        job_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
        progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
        error_code TEXT,
        derivative_hash TEXT,
        derivative_mime_type TEXT,
        derivative_byte_size INTEGER CHECK (derivative_byte_size IS NULL OR derivative_byte_size >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (derivative_hash IS NULL AND derivative_mime_type IS NULL AND derivative_byte_size IS NULL)
          OR (derivative_hash IS NOT NULL AND derivative_mime_type IS NOT NULL AND derivative_byte_size IS NOT NULL)
        ),
        FOREIGN KEY(asset_id) REFERENCES asset_metadata(asset_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS derivative_job_metadata_by_status_created
        ON derivative_job_metadata(status, created_at, job_id);
    `);
  }

  #ensureImportJobSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS import_job_metadata (
        job_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        asset_json TEXT NOT NULL,
        original_name TEXT,
        staging_hash TEXT NOT NULL,
        staging_byte_size INTEGER NOT NULL CHECK (staging_byte_size >= 0),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
        progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
        error_code TEXT,
        result_content_hash TEXT,
        result_byte_size INTEGER CHECK (result_byte_size IS NULL OR result_byte_size >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (result_content_hash IS NULL AND result_byte_size IS NULL)
          OR (result_content_hash IS NOT NULL AND result_byte_size IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS import_job_metadata_by_status_created
        ON import_job_metadata(status, created_at, job_id);
    `);
  }

  #ensureSpatialSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_node_spatial_metadata (
        spatial_id INTEGER PRIMARY KEY,
        board_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        parent_id TEXT,
        z_index INTEGER NOT NULL,
        min_x REAL NOT NULL,
        max_x REAL NOT NULL,
        min_y REAL NOT NULL,
        max_y REAL NOT NULL,
        UNIQUE(board_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS board_node_spatial_by_board_order
        ON board_node_spatial_metadata(board_id, z_index, node_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS board_node_spatial_index USING rtree(
        spatial_id,
        min_x, max_x,
        min_y, max_y
      );
    `);
  }

  #ensureSpatialRevisionSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spatial_projection_metadata (
        projection_key TEXT PRIMARY KEY CHECK (projection_key = 'main'),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
    `);
  }

  #seedSpatialRevision(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new ProjectStorageError('initial spatial projection revision must be a non-negative safe integer');
    }
    this.seedSpatialRevisionStatement.run(revision);
  }

  #spatialRevision() {
    const row = this.spatialRevisionStatement.get();
    const revision = row?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new StorageIntegrityError('spatial projection revision metadata is invalid');
    }
    return revision;
  }

  #advanceSpatialRevision() {
    const current = this.#spatialRevision();
    if (current >= Number.MAX_SAFE_INTEGER) throw new ProjectStorageError('spatial projection revision exceeds the safe integer range');
    const next = current + 1;
    this.updateSpatialRevisionStatement.run(next);
    return next;
  }

  #replaceSpatialIndex(entries) {
    this.db.exec('DELETE FROM board_node_spatial_index; DELETE FROM board_node_spatial_metadata;');
    let spatialId = 0;
    for (const entry of entries) {
      spatialId += 1;
      this.insertSpatialMetadataStatement.run(
        spatialId,
        entry.boardId,
        entry.nodeId,
        entry.nodeType,
        entry.parentId ?? null,
        entry.zIndex,
        entry.minX,
        entry.maxX,
        entry.minY,
        entry.maxY,
      );
      this.insertSpatialRtreeStatement.run(spatialId, entry.minX, entry.maxX, entry.minY, entry.maxY);
    }
  }

  getBlobPath(contentHash) {
    this.#assertOpen();
    const hash = assertHash(contentHash);
    return path.join(this.blobRoot, hash.slice(0, 2), hash);
  }

  getDerivativePath(contentHash) {
    this.#assertOpen();
    const hash = assertHash(contentHash);
    return path.join(this.derivativeRoot, hash.slice(0, 2), hash);
  }

  getImportStagingPath(contentHash) {
    this.#assertOpen();
    const hash = assertHash(contentHash);
    return path.join(this.importStagingRoot, hash.slice(0, 2), hash);
  }

  #metadataFromRow(row) {
    if (!row) return null;
    let metadata;
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch (error) {
      throw new StorageIntegrityError(`metadata for asset ${row.asset_id} is not valid JSON: ${error.message}`);
    }
    const asset = managedAssetRecord({
      id: row.asset_id,
      kind: row.kind,
      locator: {
        ...(row.mime_type ? { mimeType: row.mime_type } : {}),
        ...(row.extension ? { extension: row.extension } : {}),
        ...(row.format_name ? { format: row.format_name } : {}),
      },
      metadata,
    }, row.content_hash, row.byte_size);
    return {
      asset,
      contentHash: row.content_hash,
      byteSize: row.byte_size,
      originalName: row.original_name || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getAsset(assetId) {
    this.#assertOpen();
    const row = this.assetByIdStatement.get(assertAssetId(assetId));
    return this.#metadataFromRow(row);
  }

  getAssetByContentHash(contentHash) {
    this.#assertOpen();
    const row = this.assetByContentHashStatement.get(assertHash(contentHash));
    return this.#metadataFromRow(row);
  }

  async #materializeContent(root, contentHash, bytes, label) {
    const finalPath = path.join(root, contentHash.slice(0, 2), contentHash);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      const existing = await fs.readFile(finalPath);
      if (sha256(existing) !== contentHash) {
        throw new StorageIntegrityError(`existing ${label} ${contentHash} does not match its path hash`);
      }
      return false;
    } catch (error) {
      if (error instanceof StorageIntegrityError) throw error;
      if (error?.code !== 'ENOENT') throw new ProjectStorageError(`failed to inspect ${label} ${contentHash}: ${error.message}`);
    }

    const temporaryPath = `${finalPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
    try {
      await fs.rename(temporaryPath, finalPath);
      return true;
    } catch (error) {
      try {
        const winner = await fs.readFile(finalPath);
        if (sha256(winner) === contentHash) {
          await removeIfPresent(temporaryPath);
          return false;
        }
      } catch { /* surface the original rename failure below */ }
      await removeIfPresent(temporaryPath);
      throw new ProjectStorageError(`failed to atomically materialize ${label} ${contentHash}: ${error.message}`);
    }
  }

  async #materializeBlob(contentHash, bytes) {
    return this.#materializeContent(this.blobRoot, contentHash, bytes, 'blob');
  }

  async #materializeDerivative(contentHash, bytes) {
    return this.#materializeContent(this.derivativeRoot, contentHash, bytes, 'derivative');
  }

  async #materializeImportStaging(contentHash, bytes) {
    return this.#materializeContent(this.importStagingRoot, contentHash, bytes, 'import staging');
  }

  async putAsset({ asset, bytes, originalName } = {}) {
    this.#assertOpen();
    assertAssetRecord(asset);
    const binary = asBuffer(bytes);
    const contentHash = sha256(binary);
    const blobCreated = await this.#materializeBlob(contentHash, binary);
    const now = Date.now();
    const managedAsset = managedAssetRecord(asset, contentHash, binary.byteLength);
    try {
      this.upsertAssetStatement.run(
        managedAsset.id,
        managedAsset.kind,
        contentHash,
        binary.byteLength,
        managedAsset.locator.mimeType || null,
        managedAsset.locator.extension || null,
        managedAsset.locator.format || null,
        typeof originalName === 'string' && originalName.length > 0 ? originalName : null,
        JSON.stringify(managedAsset.metadata),
        now,
        now,
      );
    } catch (error) {
      // The immutable blob is intentionally left for a later GC pass if metadata commit fails.
      throw new ProjectStorageError(`failed to record asset ${managedAsset.id}: ${error.message}`);
    }
    return { asset: managedAsset, contentHash, byteSize: binary.byteLength, blobCreated };
  }

  async readBlob(contentHash) {
    this.#assertOpen();
    const hash = assertHash(contentHash);
    let bytes;
    try {
      bytes = await fs.readFile(this.getBlobPath(hash));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new StorageIntegrityError(`blob ${hash} is missing`);
      throw new ProjectStorageError(`failed to read blob ${hash}: ${error.message}`);
    }
    if (sha256(bytes) !== hash) throw new StorageIntegrityError(`blob ${hash} failed content hash verification`);
    return bytes;
  }

  async readAssetBytes(assetId) {
    this.#assertOpen();
    const stored = this.getAsset(assetId);
    if (!stored) throw new ProjectStorageError(`unknown asset id: ${assetId}`);
    return this.readBlob(stored.contentHash);
  }

  #assertDerivativeRecipe(recipe) {
    if (typeof recipe !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(recipe)) {
      throw new ProjectStorageError('derivative recipe must be a safe identifier');
    }
    return recipe;
  }

  #derivativeFromRow(row) {
    if (!row) return null;
    return {
      assetId: row.asset_id,
      recipe: row.recipe,
      contentHash: row.derivative_hash,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getDerivative(assetId, recipe) {
    this.#assertOpen();
    const row = this.derivativeByAssetRecipeStatement.get(
      assertAssetId(assetId),
      this.#assertDerivativeRecipe(recipe),
    );
    return this.#derivativeFromRow(row);
  }

  async putDerivative({ assetId, recipe, bytes, mimeType } = {}) {
    this.#assertOpen();
    const id = assertAssetId(assetId);
    const safeRecipe = this.#assertDerivativeRecipe(recipe);
    if (!this.getAsset(id)) throw new ProjectStorageError(`unknown asset id: ${id}`);
    if (typeof mimeType !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
      throw new ProjectStorageError('derivative MIME type is invalid');
    }
    const binary = asBuffer(bytes);
    const contentHash = sha256(binary);
    const blobCreated = await this.#materializeDerivative(contentHash, binary);
    const now = Date.now();
    try {
      this.upsertDerivativeStatement.run(id, safeRecipe, contentHash, mimeType, binary.byteLength, now, now);
    } catch (error) {
      throw new ProjectStorageError(`failed to record derivative for ${id}: ${error.message}`);
    }
    return {
      assetId: id,
      recipe: safeRecipe,
      contentHash,
      mimeType,
      byteSize: binary.byteLength,
      blobCreated,
    };
  }

  async readDerivative(assetId, recipe) {
    this.#assertOpen();
    const derivative = this.getDerivative(assetId, recipe);
    if (!derivative) throw new ProjectStorageError(`unknown derivative: ${assetId}/${recipe}`);
    let bytes;
    try {
      bytes = await fs.readFile(this.getDerivativePath(derivative.contentHash));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new StorageIntegrityError(`derivative ${derivative.contentHash} is missing`);
      throw new ProjectStorageError(`failed to read derivative ${derivative.contentHash}: ${error.message}`);
    }
    if (sha256(bytes) !== derivative.contentHash) {
      throw new StorageIntegrityError(`derivative ${derivative.contentHash} failed content hash verification`);
    }
    return bytes;
  }

  #derivativeJobFromRow(row) {
    if (!row) return null;
    return {
      id: row.job_id,
      assetId: row.asset_id,
      recipe: row.recipe,
      status: row.status,
      progress: row.progress,
      errorCode: row.error_code || null,
      derivative: row.derivative_hash ? {
        assetId: row.asset_id,
        recipe: row.recipe,
        contentHash: row.derivative_hash,
        mimeType: row.derivative_mime_type,
        byteSize: row.derivative_byte_size,
      } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getDerivativeJob(jobId) {
    this.#assertOpen();
    return this.#derivativeJobFromRow(this.derivativeJobByIdStatement.get(assertDerivativeJobId(jobId)));
  }

  listDerivativeJobs() {
    this.#assertOpen();
    return this.derivativeJobsStatement.all().map(row => this.#derivativeJobFromRow(row));
  }

  #normalizeDerivativeJobDerivative(derivative, assetId, recipe) {
    if (derivative === null || derivative === undefined) return null;
    if (!derivative || typeof derivative !== 'object') throw new ProjectStorageError('derivative job result must be an object or null');
    if (derivative.assetId !== assetId || derivative.recipe !== recipe) {
      throw new ProjectStorageError('derivative job result does not match its asset/recipe');
    }
    const contentHash = assertHash(derivative.contentHash);
    if (typeof derivative.mimeType !== 'string' || !SAFE_MIME_TYPE.test(derivative.mimeType)) {
      throw new ProjectStorageError('derivative job result MIME type is invalid');
    }
    if (!Number.isInteger(derivative.byteSize) || derivative.byteSize < 0) {
      throw new ProjectStorageError('derivative job result byte size is invalid');
    }
    return { assetId, recipe, contentHash, mimeType: derivative.mimeType, byteSize: derivative.byteSize };
  }

  createDerivativeJob({ id, assetId, recipe } = {}) {
    this.#assertOpen();
    const jobId = assertDerivativeJobId(id);
    const safeAssetId = assertAssetId(assetId);
    const safeRecipe = this.#assertDerivativeRecipe(recipe);
    if (!this.getAsset(safeAssetId)) throw new ProjectStorageError(`unknown asset id: ${safeAssetId}`);
    const now = Date.now();
    try {
      this.insertDerivativeJobStatement.run(jobId, safeAssetId, safeRecipe, 'queued', 0, null, null, null, null, now, now);
    } catch (error) {
      throw new ProjectStorageError(`failed to create derivative job ${jobId}: ${error.message}`);
    }
    return this.getDerivativeJob(jobId);
  }

  updateDerivativeJob({ id, status, progress, errorCode, derivative } = {}) {
    this.#assertOpen();
    const current = this.getDerivativeJob(id);
    if (!current) throw new ProjectStorageError(`unknown derivative job: ${id}`);
    const safeStatus = assertDerivativeJobStatus(status);
    const safeProgress = assertDerivativeJobProgress(progress);
    if (errorCode !== null && errorCode !== undefined && (typeof errorCode !== 'string' || errorCode.length === 0 || errorCode.length > 128)) {
      throw new ProjectStorageError('derivative job error code is invalid');
    }
    const nextDerivative = this.#normalizeDerivativeJobDerivative(
      Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'derivative') ? derivative : current.derivative,
      current.assetId,
      current.recipe,
    );
    const now = Date.now();
    try {
      this.updateDerivativeJobStatement.run(
        safeStatus,
        safeProgress,
        errorCode ?? null,
        nextDerivative?.contentHash ?? null,
        nextDerivative?.mimeType ?? null,
        nextDerivative?.byteSize ?? null,
        now,
        current.id,
      );
    } catch (error) {
      throw new ProjectStorageError(`failed to update derivative job ${current.id}: ${error.message}`);
    }
    return this.getDerivativeJob(current.id);
  }

  recoverDerivativeJobs() {
    this.#assertOpen();
    try {
      this.recoverDerivativeJobsStatement.run(Date.now());
    } catch (error) {
      throw new ProjectStorageError(`failed to recover derivative jobs: ${error.message}`);
    }
    return this.listDerivativeJobs();
  }

  #importJobFromRow(row) {
    if (!row) return null;
    const draft = importDraftFromJson(row.asset_json);
    if (draft.id !== row.asset_id) throw new StorageIntegrityError(`import job ${row.job_id} asset id does not match its draft`);
    return {
      id: row.job_id,
      assetId: row.asset_id,
      draft,
      originalName: row.original_name || undefined,
      stagingHash: row.staging_hash,
      stagingByteSize: row.staging_byte_size,
      status: row.status,
      progress: row.progress,
      errorCode: row.error_code || null,
      result: row.result_content_hash ? {
        asset: managedAssetRecord(draft, row.result_content_hash, row.result_byte_size),
        contentHash: row.result_content_hash,
        byteSize: row.result_byte_size,
      } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getImportJob(jobId) {
    this.#assertOpen();
    return this.#importJobFromRow(this.importJobByIdStatement.get(assertImportJobId(jobId)));
  }

  listImportJobs() {
    this.#assertOpen();
    return this.importJobsStatement.all().map(row => this.#importJobFromRow(row));
  }

  async stageImport({ id, asset, bytes, originalName } = {}) {
    this.#assertOpen();
    const jobId = assertImportJobId(id);
    const { draft, serialized } = importDraftFromAsset(asset);
    const safeOriginalName = assertImportOriginalName(originalName);
    const binary = asBuffer(bytes);
    const stagingHash = sha256(binary);
    await this.#materializeImportStaging(stagingHash, binary);
    const now = Date.now();
    try {
      this.insertImportJobStatement.run(
        jobId,
        draft.id,
        serialized,
        safeOriginalName,
        stagingHash,
        binary.byteLength,
        'queued',
        0,
        null,
        null,
        null,
        now,
        now,
      );
    } catch (error) {
      // A staged file without a journal is harmless recovery debris; later GC owns reclamation.
      throw new ProjectStorageError(`failed to create import job ${jobId}: ${error.message}`);
    }
    return this.getImportJob(jobId);
  }

  #normalizeImportJobResult(result, current) {
    if (result === null || result === undefined) return null;
    if (!result || typeof result !== 'object') throw new ProjectStorageError('import job result must be an object or null');
    const contentHash = assertHash(result.contentHash);
    if (!Number.isInteger(result.byteSize) || result.byteSize < 0) {
      throw new ProjectStorageError('import job result byte size is invalid');
    }
    if (contentHash !== current.stagingHash || result.byteSize !== current.stagingByteSize) {
      throw new ProjectStorageError('import job result does not match its staged bytes');
    }
    if (result.asset && (result.asset.id !== current.assetId || result.asset.kind !== current.draft.kind)) {
      throw new ProjectStorageError('import job result asset does not match its draft');
    }
    return { contentHash, byteSize: result.byteSize };
  }

  updateImportJob({ id, status, progress, errorCode, result } = {}) {
    this.#assertOpen();
    const current = this.getImportJob(id);
    if (!current) throw new ProjectStorageError(`unknown import job: ${id}`);
    const safeStatus = assertImportJobStatus(status);
    const safeProgress = assertImportJobProgress(progress);
    if (errorCode !== null && errorCode !== undefined && (typeof errorCode !== 'string' || errorCode.length === 0 || errorCode.length > 128)) {
      throw new ProjectStorageError('import job error code is invalid');
    }
    const nextResult = this.#normalizeImportJobResult(
      Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'result') ? result : current.result,
      current,
    );
    if (safeStatus === 'completed' && (!nextResult || safeProgress !== 1 || errorCode !== null && errorCode !== undefined)) {
      throw new ProjectStorageError('completed import job must have a result, progress 1 and no error code');
    }
    if (safeStatus !== 'completed' && nextResult) {
      throw new ProjectStorageError('only a completed import job may have a result');
    }
    const now = Date.now();
    try {
      this.updateImportJobStatement.run(
        safeStatus,
        safeProgress,
        errorCode ?? null,
        nextResult?.contentHash ?? null,
        nextResult?.byteSize ?? null,
        now,
        current.id,
      );
    } catch (error) {
      throw new ProjectStorageError(`failed to update import job ${current.id}: ${error.message}`);
    }
    return this.getImportJob(current.id);
  }

  recoverImportJobs() {
    this.#assertOpen();
    try {
      this.recoverImportJobsStatement.run(Date.now());
    } catch (error) {
      throw new ProjectStorageError(`failed to recover import jobs: ${error.message}`);
    }
    return this.listImportJobs();
  }

  async readImportJobBytes(jobId) {
    this.#assertOpen();
    const job = this.getImportJob(jobId);
    if (!job) throw new ProjectStorageError(`unknown import job: ${jobId}`);
    let bytes;
    try {
      bytes = await fs.readFile(this.getImportStagingPath(job.stagingHash));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new StorageIntegrityError(`import staging ${job.stagingHash} is missing`);
      throw new ProjectStorageError(`failed to read import staging ${job.stagingHash}: ${error.message}`);
    }
    if (bytes.byteLength !== job.stagingByteSize || sha256(bytes) !== job.stagingHash) {
      throw new StorageIntegrityError(`import staging ${job.stagingHash} failed integrity verification`);
    }
    return bytes;
  }

  #assertManagedDocument(document) {
    assertV2Document(document);
    const assetById = new Map();
    for (const asset of document.assets) {
      assertAssetRecord(asset);
      if (assetById.has(asset.id)) throw new ProjectStorageError(`duplicate document asset id: ${asset.id}`);
      if (asset.sourceKind !== 'managed-store') {
        throw new ProjectStorageError(`document asset ${asset.id} is not managed by the content store`);
      }
      const reference = asset.kind === 'image' ? asset.locator.originalRef : asset.locator.fileRef;
      const contentHash = contentHashFromStorageRef(reference);
      if (!contentHash) throw new ProjectStorageError(`document asset ${asset.id} has no canonical managed storage reference`);
      const stored = this.getAsset(asset.id);
      if (!stored || stored.contentHash !== contentHash) {
        throw new ProjectStorageError(`document asset ${asset.id} is not backed by matching metadata`);
      }
      if (asset.locator.byteSize !== stored.byteSize) {
        throw new ProjectStorageError(`document asset ${asset.id} byte size does not match metadata`);
      }
      for (const locatorReference of [asset.locator.previewRef, asset.locator.originalRef, asset.locator.fileRef]) {
        if (locatorReference !== undefined && contentHashFromStorageRef(locatorReference) !== contentHash) {
          throw new ProjectStorageError(`document asset ${asset.id} contains a non-canonical storage locator`);
        }
      }
      if (asset.kind === 'image' && contentHashFromStorageRef(asset.locator.previewRef) !== contentHash) {
        throw new ProjectStorageError(`managed image ${asset.id} must use the same original and preview storage reference`);
      }
      assetById.set(asset.id, asset);
    }
    for (const node of document.nodes) assertManagedNode(node, assetById, `node ${String(node?.id)}`);
    for (const board of document.boards) {
      if (!Array.isArray(board?.operationHistory)) throw new ProjectStorageError(`board ${String(board?.id)} has invalid operation history`);
      for (const operation of board.operationHistory) {
        if (!Array.isArray(operation?.changes)) throw new ProjectStorageError(`operation ${String(operation?.id)} has invalid changes`);
        for (const change of operation.changes) {
          if (change?.before) assertManagedNode(change.before, assetById, `operation ${String(operation.id)} before node ${String(change.before.id)}`);
          if (change?.after) assertManagedNode(change.after, assetById, `operation ${String(operation.id)} after node ${String(change.after.id)}`);
        }
      }
    }
    for (const assetId of referencedAssetIds(document)) {
      if (!assetById.has(assetId)) throw new ProjectStorageError(`document references missing asset ${assetId}`);
    }
  }

  saveProjectDocument(document) {
    this.#assertOpen();
    this.#assertManagedDocument(document);
    const payload = JSON.stringify(cloneJson(document));
    const spatialEntries = spatialEntriesFromDocument(document);
    try {
      runInTransaction(this.db, () => {
        this.saveDocumentStatement.run(PROJECT_DOCUMENT_FORMAT, PROJECT_DOCUMENT_VERSION, payload, Date.now());
        this.#replaceSpatialIndex(spatialEntries);
        this.#advanceSpatialRevision();
      });
    } catch (error) {
      throw new ProjectStorageError(`failed to save project document and spatial index: ${error.message}`);
    }
  }

  queryViewport(request) {
    this.#assertOpen();
    const query = normalizeViewportQuery(request);
    return runInReadTransaction(this.db, () => {
      const snapshotRevision = this.#spatialRevision();
      if (query.cursor && query.cursor.snapshotRevision !== snapshotRevision) {
        throw new ProjectStorageError('viewport query cursor snapshot is stale; restart from the first page');
      }
      const commonBindings = [
        query.boardId,
        rtreeLowerBound(query.minX),
        rtreeUpperBound(query.maxX),
        rtreeLowerBound(query.minY),
        rtreeUpperBound(query.maxY),
        query.minX,
        query.maxX,
        query.minY,
        query.maxY,
      ];
      const rows = query.cursor
        ? this.queryViewportAfterStatement.all(...commonBindings, query.cursor.after.zIndex, query.cursor.after.zIndex, query.cursor.after.id, query.limit + 1)
        : this.queryViewportInitialStatement.all(...commonBindings, query.limit + 1);
      const pageRows = rows.slice(0, query.limit);
      const truncated = rows.length > query.limit;
      const nodes = pageRows.map(row => ({
        id: row.node_id,
        boardId: row.board_id,
        nodeType: row.node_type,
        ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
        zIndex: row.z_index,
        bounds: {
          x: row.min_x,
          y: row.min_y,
          width: row.max_x - row.min_x,
          height: row.max_y - row.min_y,
        },
      }));
      const last = pageRows.at(-1);
      return {
        nodes,
        truncated,
        snapshotRevision,
        nextCursor: truncated && last ? {
          snapshotRevision,
          boardId: query.boardId,
          rect: query.rect,
          after: { zIndex: last.z_index, id: last.node_id },
        } : null,
      };
    });
  }

  #usageSets() {
    const documentIds = new Set();
    const document = this.loadProjectDocument();
    if (document) {
      for (const asset of document.assets) documentIds.add(asset.id);
    }
    const importIds = new Set();
    const jobs = this.db.prepare(
      "SELECT asset_id FROM import_job_metadata WHERE status IN ('queued', 'running')",
    ).all();
    for (const job of jobs) importIds.add(job.asset_id);
    return { documentIds, importIds };
  }

  #fillProtectedTemp(documentIds, importIds) {
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS inventory_protected (asset_id TEXT PRIMARY KEY)');
    this.db.exec('DELETE FROM inventory_protected');
    const insert = this.db.prepare('INSERT OR IGNORE INTO inventory_protected(asset_id) VALUES (?)');
    for (const id of documentIds) insert.run(id);
    for (const id of importIds) insert.run(id);
  }

  /**
   * 管理面板用的资产清单。不返回路径、完整哈希或文件字节。
   * unreferencedOnly 只含「已保存工程和进行中的导入都没有点名」的记录。
   */
  listAssetInventory({ offset = 0, limit = 50, unreferencedOnly = false } = {}) {
    this.#assertOpen();
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) {
      throw new ProjectStorageError('asset inventory offset must be an integer from 0 to 100000');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ProjectStorageError('asset inventory limit must be an integer from 1 to 100');
    }
    if (typeof unreferencedOnly !== 'boolean') {
      throw new ProjectStorageError('asset inventory unreferencedOnly must be a boolean');
    }
    const { documentIds, importIds } = this.#usageSets();
    this.#fillProtectedTemp(documentIds, importIds);
    const where = unreferencedOnly
      ? 'WHERE NOT EXISTS (SELECT 1 FROM inventory_protected protected WHERE protected.asset_id = asset_metadata.asset_id)'
      : '';
    const totals = this.db.prepare(
      'SELECT COUNT(*) AS assets, COUNT(DISTINCT content_hash) AS blobs FROM asset_metadata',
    ).get();
    const unique = this.db.prepare(
      'SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM (SELECT MAX(byte_size) AS byte_size FROM asset_metadata GROUP BY content_hash)',
    ).get();
    const unreferenced = this.db.prepare(
      'SELECT COUNT(*) AS assets FROM asset_metadata WHERE NOT EXISTS (SELECT 1 FROM inventory_protected protected WHERE protected.asset_id = asset_metadata.asset_id)',
    ).get();
    const rows = this.db.prepare(`
      SELECT asset_id, kind, byte_size, mime_type, original_name, content_hash, updated_at
      FROM asset_metadata
      ${where}
      ORDER BY updated_at DESC, asset_id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    return {
      totalAssets: totals.assets,
      uniqueBlobs: totals.blobs,
      uniqueBytes: unique.bytes,
      unreferencedAssets: unreferenced.assets,
      items: rows.map(row => ({
        id: row.asset_id,
        kind: row.kind,
        byteSize: row.byte_size,
        mimeType: row.mime_type || '',
        originalName: row.original_name || '',
        hashPrefix: row.content_hash.slice(0, 12),
        updatedAt: row.updated_at,
        usage: documentIds.has(row.asset_id) ? 'document' : importIds.has(row.asset_id) ? 'import' : 'none',
      })),
    };
  }

  /**
   * 只改资产显示名。不移动、不改写 blob 文件。
   */
  renameAssetNames({ changes } = {}) {
    this.#assertOpen();
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 40) {
      throw new ProjectStorageError('rename requires 1 to 40 assets');
    }
    const planned = [];
    const seen = new Set();
    for (const change of changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        throw new ProjectStorageError('rename change must be an object');
      }
      const id = assertAssetId(change.id);
      if (seen.has(id)) throw new ProjectStorageError('duplicate asset id');
      seen.add(id);
      planned.push({ id, name: assertAssetDisplayName(change.name) });
    }
    const renamed = [];
    const missing = [];
    const update = this.db.prepare('UPDATE asset_metadata SET original_name = ?, updated_at = ? WHERE asset_id = ?');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const change of planned) {
        const row = this.assetByIdStatement.get(change.id);
        if (!row) {
          missing.push(change.id);
          continue;
        }
        update.run(change.name, now, change.id);
        renamed.push(change.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { renamed, missing };
  }

  /**
   * 删除未被已保存工程、进行中导入、以及调用方 protectIds 点名的资产记录。
   * 内容相同的其他记录还在时，不删 blob 文件。
   */
  async reclaimUnreferencedAssets({ assetIds, protectIds } = {}) {
    this.#assertOpen();
    if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 40) {
      throw new ProjectStorageError('reclaim requires 1 to 40 asset ids');
    }
    if (protectIds !== undefined && (!Array.isArray(protectIds) || protectIds.length > 8000)) {
      throw new ProjectStorageError('protect ids must be an array of at most 8000 ids');
    }
    const requested = assetIds.map(id => assertAssetId(id));
    const extra = new Set();
    for (const id of protectIds ?? []) extra.add(assertAssetId(id));
    const { documentIds, importIds } = this.#usageSets();
    const removed = [];
    const kept = [];
    const missing = [];
    const files = [];
    let freedBytes = 0;
    const deleteAsset = this.db.prepare('DELETE FROM asset_metadata WHERE asset_id = ?');
    const hashUsers = this.db.prepare('SELECT COUNT(*) AS total FROM asset_metadata WHERE content_hash = ?');
    const derivativeUsers = this.db.prepare('SELECT COUNT(*) AS total FROM derivative_metadata WHERE derivative_hash = ?');
    const derivativesOf = this.db.prepare('SELECT derivative_hash FROM derivative_metadata WHERE asset_id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of requested) {
        const row = this.assetByIdStatement.get(id);
        if (!row) {
          missing.push(id);
          continue;
        }
        if (documentIds.has(id) || importIds.has(id) || extra.has(id)) {
          kept.push(id);
          continue;
        }
        const derivativeHashes = derivativesOf.all(id).map(item => item.derivative_hash);
        deleteAsset.run(id);
        if (hashUsers.get(row.content_hash).total === 0) {
          files.push(this.getBlobPath(row.content_hash));
          freedBytes += row.byte_size;
        }
        for (const hash of derivativeHashes) {
          if (derivativeUsers.get(hash).total === 0) files.push(this.getDerivativePath(hash));
        }
        removed.push(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error instanceof ProjectStorageError
        ? error
        : new ProjectStorageError(`failed to reclaim assets: ${error.message}`);
    }
    for (const filePath of files) await removeIfPresent(filePath);
    return { removed, kept, missing, freedBytes };
  }

  loadProjectDocument() {
    this.#assertOpen();
    const row = this.loadDocumentStatement.get();
    if (!row) return null;
    try {
      const document = JSON.parse(row.payload_json);
      this.#assertManagedDocument(document);
      return document;
    } catch (error) {
      if (error instanceof ProjectStorageError) throw error;
      throw new StorageIntegrityError(`stored project document is not valid JSON: ${error.message}`);
    }
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

module.exports = {
  PROJECT_DOCUMENT_FORMAT,
  PROJECT_DOCUMENT_VERSION,
  STORAGE_REF_PREFIX,
  STORAGE_SCHEMA_VERSION,
  DEFAULT_VIEWPORT_QUERY_LIMIT,
  MAX_VIEWPORT_QUERY_LIMIT,
  DERIVATIVE_JOB_STATUSES,
  IMPORT_JOB_STATUSES,
  ProjectRepository,
  ProjectStorageError,
  StorageIntegrityError,
  contentHashFromStorageRef,
  createStorageRef,
};
