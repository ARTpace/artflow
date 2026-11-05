/**
 * projectDocument.ts —— Project Document v2 persistence adapter.
 *
 * This is a schema bridge: AssetRecord separates locators from BoardNodeRecord.
 * ponytail: binary content deliberately remains in existing data/blob/external locators;
 * a later storage contract can replace it without a renderer rewrite.
 */

import type {
  AssetKind,
  AssetLocator,
  AssetRecord,
  AssetSourceKind,
  Board,
  BoardNodeChange,
  BoardNodeRecord,
  CanvasElementChange,
  CanvasOperation,
  Element,
  NodeOperation,
  ProjectBoardRecord,
  ProjectDocumentV2,
} from '../types';
import { migrateLegacyBoardHistory } from './operationHistory';
import { normalizeViewBookmarks } from './viewBookmarks';
import { normalizeElementTags } from './elementTags';

export const PROJECT_DOCUMENT_FORMAT = 'artflow-project' as const;
export const PROJECT_DOCUMENT_VERSION = 2 as const;

export class ProjectDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectDocumentError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const assetFieldsByNodeType: Record<string, readonly string[]> = {
  image: ['href', 'originalHref', 'thumbnailHref', 'mediumHref', 'mimeType', 'fileSize'],
  video: ['href', 'mimeType', 'fileSize'],
  audio: ['href', 'mimeType', 'fileSize'],
  font: ['fontUrl', 'format', 'fileSize'],
  model3d: ['fileUrl', 'fileExtension', 'fileSize'],
  file: ['fileUrl', 'fileExtension', 'fileSize', 'mimeType'],
};

const isAssetBacked = (element: Element): element is Extract<Element, { type: AssetKind }> =>
  Object.prototype.hasOwnProperty.call(assetFieldsByNodeType, element.type);

function sourceKindFor(locator: AssetLocator): AssetSourceKind {
  const reference = locator.previewRef ?? locator.fileRef ?? locator.originalRef ?? '';
  if (reference.startsWith('data:')) return 'legacy-inline';
  if (reference.startsWith('blob:')) return 'runtime-url';
  if (reference.startsWith('artflow-asset://sha256/')) return 'managed-store';
  return 'external-reference';
}

function locatorForElement(element: Extract<Element, { type: AssetKind }>): AssetLocator {
  switch (element.type) {
    case 'image': {
      const locator: AssetLocator = {
        previewRef: element.href,
        mimeType: element.mimeType,
      };
      if (element.thumbnailHref) locator.thumbnailRef = element.thumbnailHref;
      if (element.mediumHref) locator.mediumRef = element.mediumHref;
      if (element.originalHref) locator.originalRef = element.originalHref;
      if (element.fileSize !== undefined) locator.byteSize = element.fileSize;
      return locator;
    }
    case 'video':
    case 'audio': {
      const locator: AssetLocator = { fileRef: element.href, mimeType: element.mimeType };
      if (element.fileSize !== undefined) locator.byteSize = element.fileSize;
      return locator;
    }
    case 'font':
      return { fileRef: element.fontUrl, format: element.format, byteSize: element.fileSize };
    case 'model3d':
      return { fileRef: element.fileUrl, extension: element.fileExtension, byteSize: element.fileSize };
    case 'file':
      return {
        fileRef: element.fileUrl,
        extension: element.fileExtension,
        byteSize: element.fileSize,
        mimeType: element.mimeType,
      };
  }
}

class AssetRegistry {
  readonly assets: AssetRecord[] = [];
  // Key by an existing locator string; never concatenate/JSON.stringify full image data URLs.
  private readonly assetsBySource = new Map<AssetKind, Map<string, AssetRecord[]>>();
  private readonly assetById = new Map<string, AssetRecord>();
  private sequence = 0;

  private nextGeneratedId(): string {
    let id: string;
    do id = `asset-${(++this.sequence).toString(36)}`;
    while (this.assetById.has(id));
    return id;
  }

  ensure(element: Element): string | undefined {
    if (!isAssetBacked(element)) return undefined;
    const kind = element.type as AssetKind;
    const locator = locatorForElement(element);
    const source = locator.previewRef ?? locator.fileRef ?? locator.originalRef ?? '';
    let bySource = this.assetsBySource.get(kind);
    if (!bySource) {
      bySource = new Map();
      this.assetsBySource.set(kind, bySource);
    }
    const candidates = bySource.get(source) ?? [];
    for (const candidate of candidates) {
      const previous = candidate.locator;
      if (previous.previewRef === locator.previewRef
        && previous.thumbnailRef === locator.thumbnailRef
        && previous.mediumRef === locator.mediumRef
        && previous.originalRef === locator.originalRef
        && previous.fileRef === locator.fileRef
        && previous.mimeType === locator.mimeType
        && previous.extension === locator.extension
        && previous.byteSize === locator.byteSize
        && previous.format === locator.format) return candidate.id;
    }

    const preferredId = element.assetId;
    const id = preferredId && !this.assetById.has(preferredId)
      ? preferredId
      : this.nextGeneratedId();
    const asset: AssetRecord = {
      id,
      kind,
      sourceKind: sourceKindFor(locator),
      locator: { ...locator }, // A new locator; string payloads are immutable and safe to share.
      metadata: {},
    };
    this.assets.push(asset);
    this.assetById.set(id, asset);
    candidates.push(asset);
    bySource.set(source, candidates);
    return id;
  }
}

function asRecord(element: Element): Record<string, unknown> {
  return element as unknown as Record<string, unknown>;
}

function nodeFromElement(element: Element, boardId: string, zIndex: number, assets: AssetRegistry): BoardNodeRecord {
  const record = asRecord(element);
  const excluded = new Set([
    'id', 'type', 'x', 'y', 'width', 'height', 'rotation', 'parentId', 'assetId',
    ...(assetFieldsByNodeType[element.type] ?? []),
  ]);
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (excluded.has(key) || value === undefined) continue;
    if (key === 'tags') {
      const tags = normalizeElementTags(value);
      if (tags.length > 0) properties.tags = tags;
      continue;
    }
    properties[key] = jsonClone(value);
  }
  const width = typeof record.width === 'number' ? record.width : undefined;
  const height = typeof record.height === 'number' ? record.height : undefined;
  const rotation = typeof record.rotation === 'number' ? record.rotation : undefined;
  const assetId = assets.ensure(element);
  return {
    id: element.id,
    boardId,
    assetId,
    nodeType: element.type,
    x: element.x,
    y: element.y,
    width,
    height,
    rotation,
    zIndex,
    parentId: element.parentId,
    properties,
  };
}

function requireLocator(asset: AssetRecord, field: keyof AssetLocator): string {
  const value = asset.locator[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProjectDocumentError(`asset ${asset.id} is missing locator.${field}`);
  }
  return value;
}

function assetFieldsForNode(node: BoardNodeRecord, asset: AssetRecord): Record<string, unknown> {
  if (asset.kind !== node.nodeType) {
    throw new ProjectDocumentError(`node ${node.id} (${node.nodeType}) references incompatible asset ${asset.id} (${asset.kind})`);
  }
  switch (asset.kind) {
    case 'image': {
      const fields: Record<string, unknown> = {
        href: requireLocator(asset, 'previewRef'),
        mimeType: requireLocator(asset, 'mimeType'),
      };
      if (asset.locator.thumbnailRef) fields.thumbnailHref = asset.locator.thumbnailRef;
      if (asset.locator.mediumRef) fields.mediumHref = asset.locator.mediumRef;
      if (asset.locator.originalRef) fields.originalHref = asset.locator.originalRef;
      if (asset.locator.byteSize !== undefined) fields.fileSize = asset.locator.byteSize;
      return fields;
    }
    case 'video':
    case 'audio': {
      const fields: Record<string, unknown> = {
        href: requireLocator(asset, 'fileRef'),
        mimeType: requireLocator(asset, 'mimeType'),
      };
      if (asset.locator.byteSize !== undefined) fields.fileSize = asset.locator.byteSize;
      return fields;
    }
    case 'font':
      return {
        fontUrl: requireLocator(asset, 'fileRef'),
        format: requireLocator(asset, 'format'),
        ...(asset.locator.byteSize === undefined ? {} : { fileSize: asset.locator.byteSize }),
      };
    case 'model3d':
      return {
        fileUrl: requireLocator(asset, 'fileRef'),
        fileExtension: requireLocator(asset, 'extension'),
        ...(asset.locator.byteSize === undefined ? {} : { fileSize: asset.locator.byteSize }),
      };
    case 'file':
      return {
        fileUrl: requireLocator(asset, 'fileRef'),
        fileExtension: requireLocator(asset, 'extension'),
        fileSize: asset.locator.byteSize ?? 0,
        ...(asset.locator.mimeType ? { mimeType: asset.locator.mimeType } : {}),
      };
  }
}

function elementFromNode(node: BoardNodeRecord, assetsById: ReadonlyMap<string, AssetRecord>): Element {
  const element: Record<string, unknown> = {
    ...jsonClone(node.properties),
    id: node.id,
    type: node.nodeType,
    x: node.x,
    y: node.y,
    ...(node.width === undefined ? {} : { width: node.width }),
    ...(node.height === undefined ? {} : { height: node.height }),
    ...(node.rotation === undefined ? {} : { rotation: node.rotation }),
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
  };
  if (node.assetId) {
    const asset = assetsById.get(node.assetId);
    if (!asset) throw new ProjectDocumentError(`node ${node.id} references missing asset ${node.assetId}`);
    Object.assign(element, assetFieldsForNode(node, asset), { assetId: node.assetId });
  }
  const tags = normalizeElementTags(element.tags);
  if (tags.length > 0) element.tags = tags;
  else delete element.tags;
  return element as unknown as Element;
}

function orderIndex(order: readonly string[] | undefined, fallback: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  if (!order) return fallback;
  return new Map(order.map((id, index) => [id, index]));
}

function nodeChangeFromElementChange(
  change: CanvasElementChange,
  boardId: string,
  assets: AssetRegistry,
  beforeIndexes: ReadonlyMap<string, number>,
  afterIndexes: ReadonlyMap<string, number>,
): BoardNodeChange {
  return {
    id: change.id,
    before: change.before ? nodeFromElement(change.before, boardId, beforeIndexes.get(change.id) ?? -1, assets) : undefined,
    after: change.after ? nodeFromElement(change.after, boardId, afterIndexes.get(change.id) ?? -1, assets) : undefined,
  };
}

function nodeOperationFromCanvasOperation(
  operation: CanvasOperation,
  boardId: string,
  assets: AssetRegistry,
  currentIndexes: ReadonlyMap<string, number>,
): NodeOperation {
  const beforeIndexes = orderIndex(operation.beforeOrder, currentIndexes);
  const afterIndexes = orderIndex(operation.afterOrder, currentIndexes);
  return {
    id: operation.id,
    createdAt: operation.createdAt,
    beforeOrder: operation.beforeOrder ? [...operation.beforeOrder] : undefined,
    afterOrder: operation.afterOrder ? [...operation.afterOrder] : undefined,
    changes: operation.changes.map(change => nodeChangeFromElementChange(change, boardId, assets, beforeIndexes, afterIndexes)),
  };
}

function canvasOperationFromNodeOperation(operation: NodeOperation, assetsById: ReadonlyMap<string, AssetRecord>): CanvasOperation {
  return {
    id: operation.id,
    createdAt: operation.createdAt,
    beforeOrder: operation.beforeOrder ? [...operation.beforeOrder] : undefined,
    afterOrder: operation.afterOrder ? [...operation.afterOrder] : undefined,
    changes: operation.changes.map(change => ({
      id: change.id,
      before: change.before ? elementFromNode(change.before, assetsById) : undefined,
      after: change.after ? elementFromNode(change.after, assetsById) : undefined,
    })),
  };
}

/** Persist current renderer boards as normalized v2 project data. */
export function serializeProjectDocument(boards: readonly Board[]): ProjectDocumentV2 {
  const assets = new AssetRegistry();
  const nodes: BoardNodeRecord[] = [];
  const projectBoards: ProjectBoardRecord[] = boards.map(rawBoard => {
    const board = migrateLegacyBoardHistory(rawBoard);
    const currentIndexes = new Map(board.elements.map((element, index) => [element.id, index]));
    nodes.push(...board.elements.map((element, index) => nodeFromElement(element, board.id, index, assets)));
    return {
      id: board.id,
      name: board.name,
      panOffset: { ...board.panOffset },
      zoom: board.zoom,
      viewBookmarks: normalizeViewBookmarks(board.viewBookmarks),
      canvasBackgroundColor: board.canvasBackgroundColor,
      operationHistory: board.operationHistory.map(operation =>
        nodeOperationFromCanvasOperation(operation, board.id, assets, currentIndexes)),
      operationHistoryIndex: board.operationHistoryIndex,
    };
  });
  return {
    format: PROJECT_DOCUMENT_FORMAT,
    version: PROJECT_DOCUMENT_VERSION,
    assets: assets.assets,
    boards: projectBoards,
    nodes,
  };
}

function assertV2Document(input: unknown): ProjectDocumentV2 {
  if (!isObject(input) || input.format !== PROJECT_DOCUMENT_FORMAT || input.version !== PROJECT_DOCUMENT_VERSION) {
    throw new ProjectDocumentError('unsupported project document; expected legacy Board[] or artflow-project v2');
  }
  if (!Array.isArray(input.assets) || !Array.isArray(input.boards) || !Array.isArray(input.nodes)) {
    throw new ProjectDocumentError('project v2 must contain assets, boards and nodes arrays');
  }
  return input as unknown as ProjectDocumentV2;
}

function hydrateV2Project(document: ProjectDocumentV2): Board[] {
  const assetsById = new Map<string, AssetRecord>();
  for (const asset of document.assets) {
    if (!asset?.id || assetsById.has(asset.id)) throw new ProjectDocumentError(`duplicate or invalid asset id: ${String(asset?.id)}`);
    assetsById.set(asset.id, asset);
  }
  const nodesByBoardId = new Map<string, BoardNodeRecord[]>();
  for (const node of document.nodes) {
    if (!node?.id || !node.boardId || !node.nodeType || !isObject(node.properties)) {
      throw new ProjectDocumentError('project v2 contains an invalid node');
    }
    const nodes = nodesByBoardId.get(node.boardId) ?? [];
    nodes.push(node);
    nodesByBoardId.set(node.boardId, nodes);
  }

  return document.boards.map(projectBoard => {
    if (!projectBoard?.id || !projectBoard.name || !Array.isArray(projectBoard.operationHistory)) {
      throw new ProjectDocumentError('project v2 contains an invalid board');
    }
    const nodes = [...(nodesByBoardId.get(projectBoard.id) ?? [])].sort((a, b) => a.zIndex - b.zIndex);
    const operationHistory = projectBoard.operationHistory.map(operation => canvasOperationFromNodeOperation(operation, assetsById));
    return {
      id: projectBoard.id,
      name: projectBoard.name,
      elements: nodes.map(node => elementFromNode(node, assetsById)),
      operationHistory,
      operationHistoryIndex: Math.max(-1, Math.min(projectBoard.operationHistoryIndex, operationHistory.length - 1)),
      panOffset: { ...projectBoard.panOffset },
      zoom: projectBoard.zoom,
      viewBookmarks: normalizeViewBookmarks(projectBoard.viewBookmarks),
      canvasBackgroundColor: projectBoard.canvasBackgroundColor,
    } satisfies Board;
  });
}

const normalizeElementTagMetadata = (element: Element): Element => {
  const record = asRecord(element);
  if (!Object.prototype.hasOwnProperty.call(record, 'tags')) return element;
  const tags = normalizeElementTags(record.tags);
  if (tags.length > 0) return { ...element, tags };
  const { tags: _discardedTags, ...withoutTags } = record;
  return withoutTags as unknown as Element;
};

const normalizeLegacyBoardTagMetadata = (board: Board): Board => ({
  ...board,
  elements: board.elements.map(normalizeElementTagMetadata),
  operationHistory: board.operationHistory.map(operation => ({
    ...operation,
    changes: operation.changes.map(change => ({
      ...change,
      ...(change.before ? { before: normalizeElementTagMetadata(change.before) } : {}),
      ...(change.after ? { after: normalizeElementTagMetadata(change.after) } : {}),
    })),
  })),
});

/** Read v2 documents and prior Board[] saves. Legacy history is normalized by the R2 migration boundary. */
export function deserializeProjectDocument(input: unknown): Board[] {
  if (Array.isArray(input)) return input.map(board => {
    const migrated = migrateLegacyBoardHistory(board as Board);
    return normalizeLegacyBoardTagMetadata({ ...migrated, viewBookmarks: normalizeViewBookmarks(migrated.viewBookmarks) });
  });
  return hydrateV2Project(assertV2Document(input));
}

