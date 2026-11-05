import type { Board } from '../types';

type Update<T> = T | ((previous: T) => T);
export interface CanvasDocumentState {
  boards: Board[];
  activeBoardId: string;
  sessionId: string;
}
let sequence = 0;
const sessionId = () => `document-${Date.now().toString(36)}-${++sequence}`;
/** Sole live Board[] owner. React subscribes; history remains operationHistory.ts. */
export function createCanvasDocumentState(initial: Board[]) {
  let current: CanvasDocumentState = { boards: initial, activeBoardId: initial[0]?.id ?? '', sessionId: sessionId() };
  let revisions = new Map(initial.map(board => [board.id, 0]));
  const listeners = new Set<() => void>();
  const publish = (next: CanvasDocumentState) => {
    current = next;
    for (const notify of [...listeners]) { try { notify(); } catch (error) { console.error('[document] subscriber failed', error); } }
  };
  const setBoards = (update: Update<Board[]>) => {
    const next = typeof update === 'function' ? update(current.boards) : update;
    if (next === current.boards) return;
    const previous = new Map(current.boards.map(board => [board.id, board]));
    // Retain tombstone revisions so deleting/recreating the same board id cannot revive a stale token.
    for (const board of next) {
      const old = previous.get(board.id);
      if (!old || old.elements !== board.elements || old.operationHistoryIndex !== board.operationHistoryIndex) {
        revisions.set(board.id, (revisions.get(board.id) ?? -1) + 1);
      }
    }
    publish({ ...current, boards: next });
  };
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    revision: (boardId: string) => revisions.get(boardId) ?? -1,
    setBoards,
    setActiveBoardId: (update: Update<string>) => {
      const next = typeof update === 'function' ? update(current.activeBoardId) : update;
      if (next !== current.activeBoardId) publish({ ...current, activeBoardId: next });
    },
    replaceProject: (boards: Board[]) => {
      revisions = new Map(boards.map(board => [board.id, 0]));
      publish({ boards, activeBoardId: boards[0]?.id ?? '', sessionId: sessionId() });
    },
  };
}
export type CanvasDocumentStateStore = ReturnType<typeof createCanvasDocumentState>;
