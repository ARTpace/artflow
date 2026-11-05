import { useSyncExternalStore, useMemo, useCallback, useRef } from 'react';
import { createCanvasDocumentState } from '../utils/canvas-document-state';
import { DEFAULT_CANVAS_BACKGROUND } from '../plugin-runtime/ui-theme-settings';
import type { Board, Element, FrameElement } from '../types';
import { createNewBoard, getElementBounds } from '../utils/canvasUtils';
import {
    applyCanvasOperation,
    commitCanvasOperation,
    commitGroupedCanvasOperation,
    migrateLegacyBoardHistory,
    type CanvasOperationGroup,
} from '../utils/operationHistory';
import { deserializeProjectDocument } from '../utils/projectDocument';

type ElementUpdate = Element[] | ((prev: Element[]) => Element[]);

const resolveElementUpdate = (previous: Element[], update: ElementUpdate): Element[] =>
    typeof update === 'function' ? update(previous) : update;

export const useCanvasState = () => {
    const documentState = useMemo(() => createCanvasDocumentState([migrateLegacyBoardHistory(createNewBoard('Board 1'))]), []);
    const { boards, activeBoardId } = useSyncExternalStore(documentState.subscribe, documentState.getSnapshot, documentState.getSnapshot);
    const { setBoards, setActiveBoardId } = documentState;
    /** 每次 interaction 的起点；mousemove 只改 elements，mouseup 才生成一条 operation。 */
    const pendingBaseElementsRef = useRef(new Map<string, Element[]>());
    const importHistoryGroupsRef = useRef(new Map<string, { boardId: string; group: CanvasOperationGroup }>());

    const activeBoard = useMemo(() => boards.find(b => b.id === activeBoardId), [boards, activeBoardId]);

    const {
        elements = [],
        operationHistory = [],
        operationHistoryIndex = -1,
        panOffset = { x: 0, y: 0 },
        zoom = 1,
        canvasBackgroundColor = DEFAULT_CANVAS_BACKGROUND
    } = activeBoard || {};

    const updateActiveBoard = useCallback((updater: (board: Board) => Board) => {
        setBoards(prevBoards => prevBoards.map(board =>
            board.id === activeBoardId ? updater(board) : board,
        ));
    }, [activeBoardId]);

    const setElements = useCallback((update: ElementUpdate, commit: boolean = true) => {
        updateActiveBoard(board => {
            const currentElements = board.elements || [];
            const nextElements = resolveElementUpdate(currentElements, update);
            if (!commit) {
                if (!pendingBaseElementsRef.current.has(board.id)) {
                    pendingBaseElementsRef.current.set(board.id, currentElements);
                }
                return { ...board, elements: nextElements };
            }

            const baseline = pendingBaseElementsRef.current.get(board.id) ?? currentElements;
            pendingBaseElementsRef.current.delete(board.id);
            const journal = commitCanvasOperation(
                board.operationHistory,
                board.operationHistoryIndex,
                baseline,
                nextElements,
            );
            return { ...board, elements: nextElements, ...journal };
        });
    }, [updateActiveBoard]);

    const commitAction = useCallback((updater: (prev: Element[]) => Element[]) => {
        setElements(updater, true);
    }, [setElements]);

    const addElementsWithParenting = useCallback((elementsToAdd: Element[], commit = true, importGroupId?: string) => {
        const updater = (previous: Element[]): Element[] => {
            const frames = previous.filter(el => el.type === 'frame') as FrameElement[];
            if (frames.length === 0) return [...previous, ...elementsToAdd];

            const updatedElementsToAdd = elementsToAdd.map(newElement => {
                if (newElement.parentId) return newElement;
                const newElementBounds = getElementBounds(newElement, [...previous, ...elementsToAdd]);
                const containingFrame = frames
                    .filter(frame =>
                        newElementBounds.x >= frame.x &&
                        newElementBounds.y >= frame.y &&
                        newElementBounds.x + newElementBounds.width <= frame.x + frame.width &&
                        newElementBounds.y + newElementBounds.height <= frame.y + frame.height
                    )
                    .sort((a, b) => (a.width * a.height) - (b.width * b.height))[0];
                return containingFrame ? { ...newElement, parentId: containingFrame.id } : newElement;
            });
            return [...previous, ...updatedElementsToAdd];
        };
        if (!importGroupId || !commit) {
            setElements(updater, commit);
            return;
        }
        updateActiveBoard(board => {
            const previous = board.elements || [];
            const next = updater(previous);
            const pending = pendingBaseElementsRef.current.get(board.id);
            const prior = importHistoryGroupsRef.current.get(importGroupId);
            const journal = commitGroupedCanvasOperation(
                board.operationHistory,
                board.operationHistoryIndex,
                pending ?? previous,
                next,
                !pending && prior?.boardId === board.id ? prior.group : null,
            );
            pendingBaseElementsRef.current.delete(board.id);
            if (journal.group) importHistoryGroupsRef.current.set(importGroupId, { boardId: board.id, group: journal.group });
            else importHistoryGroupsRef.current.delete(importGroupId);
            return { ...board, elements: next, operationHistory: journal.operationHistory, operationHistoryIndex: journal.operationHistoryIndex };
        });
    }, [setElements, updateActiveBoard]);

    const endImportHistoryGroup = useCallback((importGroupId: string) => {
        importHistoryGroupsRef.current.delete(importGroupId);
    }, []);

    const handleUndo = useCallback(() => {
        updateActiveBoard(board => {
            const index = Math.max(-1, Math.min(board.operationHistoryIndex, board.operationHistory.length - 1));
            if (index < 0) return board;
            pendingBaseElementsRef.current.delete(board.id);
            return {
                ...board,
                elements: applyCanvasOperation(board.elements, board.operationHistory[index], 'undo'),
                operationHistoryIndex: index - 1,
            };
        });
    }, [updateActiveBoard]);

    const handleRedo = useCallback(() => {
        updateActiveBoard(board => {
            const index = Math.max(-1, Math.min(board.operationHistoryIndex, board.operationHistory.length - 1));
            const nextIndex = index + 1;
            if (nextIndex >= board.operationHistory.length) return board;
            pendingBaseElementsRef.current.delete(board.id);
            return {
                ...board,
                elements: applyCanvasOperation(board.elements, board.operationHistory[nextIndex], 'redo'),
                operationHistoryIndex: nextIndex,
            };
        });
    }, [updateActiveBoard]);

    /** Legacy Board[] and Project Document v2 are both accepted at the renderer ingress. */
    const loadBoardData = useCallback((serializedProject: unknown): boolean => {
        const normalizedBoards = deserializeProjectDocument(serializedProject);
        if (normalizedBoards.length === 0) return false;
        pendingBaseElementsRef.current.clear();
        importHistoryGroupsRef.current.clear();
        documentState.replaceProject(normalizedBoards);
        return true;
    }, [documentState]);

    const canUndo = operationHistoryIndex >= 0;
    const canRedo = operationHistoryIndex < operationHistory.length - 1;

    return {
        documentState,
        isDocumentInteractionPending: () => pendingBaseElementsRef.current.has(documentState.getSnapshot().activeBoardId),
        boards,
        setBoards,
        activeBoardId,
        setActiveBoardId,
        activeBoard,
        elements,
        operationHistory,
        operationHistoryIndex,
        canUndo,
        canRedo,
        panOffset,
        zoom,
        canvasBackgroundColor,
        updateActiveBoard,
        setElements,
        commitAction,
        addElementsWithParenting,
        endImportHistoryGroup,
        handleUndo,
        handleRedo,
        loadBoardData,
    };
};

