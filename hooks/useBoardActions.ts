import React, { useCallback } from 'react';
import type { Board } from '../types';
import { generateId, createNewBoard } from '../utils/canvasUtils';

interface BoardActionsProps {
    boards: Board[];
    setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
    activeBoardId: string;
    setActiveBoardId: (id: string) => void;
    updateActiveBoard: (updater: (board: Board) => Board) => void;
}

export const useBoardActions = ({
    boards,
    setBoards,
    activeBoardId,
    setActiveBoardId,
    updateActiveBoard,
}: BoardActionsProps) => {

    const handleAddBoard = useCallback(() => {
        const newBoard = createNewBoard(`Board ${boards.length + 1}`);
        setBoards(prev => [...prev, newBoard]);
        setActiveBoardId(newBoard.id);
    }, [boards.length, setBoards, setActiveBoardId]);

    const handleDuplicateBoard = useCallback((boardId: string) => {
        const boardToDuplicate = boards.find(b => b.id === boardId);
        if (!boardToDuplicate) return;
        const { history: _legacyHistory, historyIndex: _legacyHistoryIndex, operationHistory: _operationHistory, operationHistoryIndex: _operationHistoryIndex, ...boardContent } = boardToDuplicate;
        const newBoard: Board = {
            ...boardContent,
            id: generateId(),
            name: `${boardToDuplicate.name} Copy`,
            // A duplicated board starts with its current elements, not the source board's undo stack.
            operationHistory: [],
            operationHistoryIndex: -1,
        };
        setBoards(prev => [...prev, newBoard]);
        setActiveBoardId(newBoard.id);
    }, [boards, setBoards, setActiveBoardId]);
    
    const handleDeleteBoard = useCallback((boardId: string) => {
        if (boards.length <= 1) return; // Can't delete the last board
        setBoards(prev => prev.filter(b => b.id !== boardId));
        if (activeBoardId === boardId) {
            setActiveBoardId(boards.find(b => b.id !== boardId)!.id);
        }
    }, [boards, activeBoardId, setBoards, setActiveBoardId]);

    const handleRenameBoard = useCallback((boardId: string, newName: string) => {
        setBoards(prev => prev.map(b => b.id === boardId ? { ...b, name: newName } : b));
    }, [setBoards]);

    const handleCanvasBackgroundColorChange = useCallback((color: string) => {
        updateActiveBoard(b => ({ ...b, canvasBackgroundColor: color }));
    }, [updateActiveBoard]);

    return {
        handleAddBoard,
        handleDuplicateBoard,
        handleDeleteBoard,
        handleRenameBoard,
        handleCanvasBackgroundColorChange,
    };
};
