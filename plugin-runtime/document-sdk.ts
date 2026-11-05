/** Version 1 narrow geometry SDK. No assets, state setters or arbitrary reducers. */
import type { Element } from '../types';
import type { CanvasDocumentStateStore } from '../utils/canvas-document-state';
import { commitCanvasOperation } from '../utils/operationHistory';
import { getElementBounds } from '../utils/canvasUtils';

export * from './document-contract';
import { DocumentServiceError, type DocumentErrorCode, type DocumentToken, type DocumentService, type OperationsService, type OperationRequest, type OperationResult, type GeometryPatch, MAX_OPERATION_NODES } from './document-contract';
import { normalizeDocumentOperations, planDocumentOperations } from './document-operations';

const fail = (code: DocumentErrorCode, message: string): never => { throw new DocumentServiceError(code, message); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export interface DocumentSDKExtensions {
  /** Live resolver over installed, enabled extension node schemas. Uninstalled/disabled types never resolve. */
  schemas: import('./document-contract').ExtensionSchemaProvider;
}
export function createDocumentSDK(store: CanvasDocumentStateStore, host: { selection: () => readonly string[]; isBusy: () => boolean; onDeleted?: (boardId: string, ids: readonly string[]) => void }, extensions?: DocumentSDKExtensions) {
  let session = store.getSnapshot().sessionId;
  let completedBytes = 0;
  const completed = new Map<string, { fingerprint: string; result: OperationResult; bytes: number }>();
  const check = (token: DocumentToken, signal: AbortSignal) => {
    if (signal.aborted) fail('ABORTED', 'Plugin scope has closed');
    const state = store.getSnapshot();
    if (state.sessionId !== session) { session = state.sessionId; completed.clear(); completedBytes = 0; }
    if (!plain(token) || token.sessionId !== state.sessionId) fail('SESSION_MISMATCH', 'Project session changed');
    if (token.boardId !== state.activeBoardId) fail('BOARD_MISMATCH', 'Target is not the active board');
    const board = state.boards.find(board => board.id === token.boardId);
    if (!board) fail('NOT_FOUND', 'Board not found');
    return board;
  };
  return {
    forConsumer(actor: string, signal: AbortSignal): { document: DocumentService; operations: OperationsService } {
      const document: DocumentService = Object.freeze({
        getContext: () => {
          if (signal.aborted) fail('ABORTED', 'Plugin scope has closed');
          const state = store.getSnapshot();
          const board = state.boards.find(board => board.id === state.activeBoardId);
          if (!board) fail('NOT_FOUND', 'No active board');
          const selection = host.selection();
          if (selection.length > MAX_OPERATION_NODES) fail('LIMIT_EXCEEDED', 'Selection exceeds SDK batch limit (1000)');
          return freeze({ sessionId: state.sessionId, boardId: state.activeBoardId, revision: store.revision(state.activeBoardId), totalNodes: board.elements.length, selectionIds: [...selection] });
        },
        query: (token: DocumentToken, options: { offset?: number; limit?: number; ids?: readonly string[] } = {}) => {
          const board = check(token, signal);
          if (store.revision(board.id) !== token.revision) fail('CONFLICT', 'Document revision changed');
          const offset = options.offset ?? 0, limit = options.limit ?? 100;
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('LIMIT_EXCEEDED', 'Query requires offset >= 0 and limit 1..500');
          if (options.ids && (!Array.isArray(options.ids) || options.ids.length > MAX_OPERATION_NODES || options.ids.some(id => typeof id !== 'string'))) fail('LIMIT_EXCEEDED', 'Invalid bounded node selection');
          const ids = options.ids ? new Set(options.ids) : null;
          const nodes = ids ? board.elements.filter(element => ids.has(element.id)) : board.elements;
          return freeze(nodes.slice(offset, offset + limit).map(element => {
            if ('points' in element && element.points.length > 4096) fail('LIMIT_EXCEEDED', 'Node exceeds geometry point limit');
            const geometry: GeometryPatch = {};
            for (const key of ['x', 'y', 'width', 'height'] as const) if (key in element) geometry[key] = (element as unknown as Record<string, number>)[key];
            if ('points' in element) geometry.points = element.points.map(point => ({ x: point.x, y: point.y }));
            return { id: element.id, type: element.type, parentId: element.parentId, isLocked: Boolean(element.isLocked), bounds: { ...getElementBounds(element, board.elements) }, geometry };
          }));
        },
        subscribe: (listener: () => void) => {
          if (signal.aborted) fail('ABORTED', 'Plugin scope has closed');
          let previous = store.getSnapshot(); let revision = store.revision(previous.activeBoardId); let live = true;
          const off = store.subscribe(() => {
            if (!live || signal.aborted) return;
            const next = store.getSnapshot(); const nextRevision = store.revision(next.activeBoardId);
            const changed = previous.sessionId !== next.sessionId || previous.activeBoardId !== next.activeBoardId || revision !== nextRevision;
            previous = next; revision = nextRevision;
            if (changed) listener();
          });
          const dispose = () => { if (!live) return; live = false; off(); signal.removeEventListener('abort', dispose); };
          signal.addEventListener('abort', dispose, { once: true });
          return dispose;
        },
      });
      const operations: OperationsService = Object.freeze({ apply: (request: OperationRequest): OperationResult => {
        let requestId = ''; let revision = -1;
        try {
          if (!plain(request)) fail('INVALID_REQUEST', 'Operation request must be an object');
          requestId = typeof request.requestId === 'string' ? request.requestId : '';
          if (!requestId || requestId.length > 128 || typeof request.label !== 'string' || !request.label.trim() || request.label.length > 160 || !Number.isSafeInteger(request.revision) || request.revision < 0) fail('INVALID_REQUEST', 'Invalid request identity, label or revision');
          if (Object.keys(request).some(key => !['sessionId', 'boardId', 'revision', 'requestId', 'label', 'operations'].includes(key))) fail('INVALID_REQUEST', 'Unexpected request fields (actor is injected)');
          const board = check(request, signal); revision = store.revision(board.id);
          const normalized = normalizeDocumentOperations(request.operations);
          const fingerprint = JSON.stringify({ ...request, operations: normalized });
          const key = JSON.stringify([actor, requestId]); const previous = completed.get(key);
          if (previous) {
            if (previous.fingerprint !== fingerprint) fail('REQUEST_ID_REUSED', 'requestId was used with a different payload');
            return previous.result;
          }
          if (request.revision !== revision) fail('CONFLICT', 'Document revision changed; re-read before retrying');
          if (host.isBusy()) fail('BUSY', 'Finish the current interaction before applying plugin edits');
          const { next, affectedIds, deletedIds } = planDocumentOperations(board.elements, normalized, extensions?.schemas);
          const journal = affectedIds.length ? commitCanvasOperation(board.operationHistory, board.operationHistoryIndex, board.elements, next) : null;
          // Capture result/dedupe before notifying observers. Reentrant calls see the committed revision.
          const result: OperationResult = freeze({ status: journal ? 'applied' : 'noop', revision: revision + (journal ? 1 : 0), requestId, actor, affectedIds });
          const bytes = 2 * (fingerprint.length + key.length + JSON.stringify(result).length);
          completed.set(key, { fingerprint, result, bytes }); completedBytes += bytes;
          while (completed.size > 256 || completedBytes > 8 * 1024 * 1024) {
            const oldest = completed.keys().next().value!;
            completedBytes -= completed.get(oldest)!.bytes; completed.delete(oldest);
          }
          if (journal) store.setBoards(boards => boards.map(current => current.id === board.id ? { ...current, elements: next, ...journal } : current));
          if (deletedIds.length && host.onDeleted) {
            try { host.onDeleted(board.id, Object.freeze(deletedIds)); } catch (error) { console.error('[document] selection cleanup failed', error); }
          }
          return result;
        } catch (error) {
          if (!(error instanceof DocumentServiceError)) throw error;
          return freeze({ status: error.code === 'CONFLICT' ? 'conflict' : 'rejected', revision, requestId, actor, affectedIds: [], code: error.code, message: error.message });
        }
      } });
      return { document, operations };
    },
  };
}
