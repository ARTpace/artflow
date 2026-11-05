
import React, { useEffect } from 'react';
import { isHotkeyMatch, generateId } from '../utils/canvasUtils';
import { parseClipboardText } from '../plugin-runtime/clipboard-handlers';
import type { Tool, PresentationHotkeys, Element, Point, BookmarkElement, MarkdownElement, CodeElement } from '../types';

interface KeyboardShortcutsProps {
    presentationState: { isActive: boolean; currentFrameIndex: number; } | null;
    presentationHotkeys: PresentationHotkeys;
    handleNavigateWithTransition: (direction: 'next' | 'prev', transition: 'smooth' | 'direct') => void;
    handleExitPresentation: () => void;
    aiRotationState: any;
    setAiRotationState: (state: any) => void;
    editingElement: any;
    handleStopEditing: () => void;
    activeTool: Tool;
    setActiveTool: (tool: Tool) => void;
    shiftEraseOriginalTool: React.MutableRefObject<Tool | null>;
    handleUndo: () => void;
    handleRedo: () => void;
    selectedElementIds: string[];
    handleDeleteSelected: () => void;
    handleFocusSelection: () => void;
    handleCopy: () => void;
    handlePasteElements?: (pastedElements: Element[], pasteCenter: Point) => void;
    handleAddFiles?: (files: File[], dropPoint?: { x: number; y: number }) => Promise<void>;
    addElementsWithParenting?: (elements: Element[]) => void;
    getCanvasCenterPoint?: () => Point;
}

export const useKeyboardShortcuts = ({
    presentationState,
    presentationHotkeys,
    handleNavigateWithTransition,
    handleExitPresentation,
    aiRotationState,
    setAiRotationState,
    editingElement,
    handleStopEditing,
    activeTool,
    setActiveTool,
    shiftEraseOriginalTool,
    handleUndo,
    handleRedo,
    selectedElementIds,
    handleDeleteSelected,
    handleFocusSelection,
    handleCopy,
    handlePasteElements,
    handleAddFiles,
    addElementsWithParenting,
    getCanvasCenterPoint
}: KeyboardShortcutsProps) => {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // 演示模式
            if (presentationState?.isActive) {
                if (isHotkeyMatch(e, presentationHotkeys.nextSmooth)) {
                    e.preventDefault();
                    handleNavigateWithTransition('next', 'smooth');
                } else if (isHotkeyMatch(e, presentationHotkeys.prevSmooth)) {
                    e.preventDefault();
                    handleNavigateWithTransition('prev', 'smooth');
                } else if (isHotkeyMatch(e, presentationHotkeys.nextDirect)) {
                    e.preventDefault();
                    handleNavigateWithTransition('next', 'direct');
                } else if (isHotkeyMatch(e, presentationHotkeys.prevDirect)) {
                    e.preventDefault();
                    handleNavigateWithTransition('prev', 'direct');
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    handleExitPresentation();
                }
                return;
            }

            // 检查是否正在输入
            const target = e.target as HTMLElement;
            const isTyping = target.tagName === 'INPUT' || 
                             target.tagName === 'TEXTAREA' || 
                             target.isContentEditable;

            if (e.key === 'Escape') {
                if (aiRotationState) {
                    setAiRotationState(null);
                    return;
                }
                if (editingElement) {
                    handleStopEditing();
                    return;
                }
            }

            if (isTyping) return;

            // F键 聚焦
            if (e.key.toLowerCase() === 'f') {
                e.preventDefault();
                handleFocusSelection();
                return;
            }

            // Shift 临时橡皮擦
            if (e.key === 'Shift' && !e.repeat && (activeTool === 'draw' || activeTool === 'highlighter')) {
                shiftEraseOriginalTool.current = activeTool;
                setActiveTool('erase');
                return;
            }

            // 撤销与重做 (全平台兼容)
            const isMod = e.ctrlKey || e.metaKey;
            if (isMod && !e.shiftKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                handleUndo();
                return;
            }
            if (isMod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
                e.preventDefault();
                handleRedo();
                return;
            }

            // 复制
            if (isMod && e.key.toLowerCase() === 'c') {
                e.preventDefault();
                handleCopy();
                return;
            }
            
            // 删除
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElementIds.length > 0) {
                e.preventDefault();
                handleDeleteSelected();
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Shift' && shiftEraseOriginalTool.current) {
                setActiveTool(shiftEraseOriginalTool.current);
                shiftEraseOriginalTool.current = null;
            }
        };

        const handlePasteEvent = async (e: ClipboardEvent) => {
            const target = e.target as HTMLElement;
            const isTyping = target.tagName === 'INPUT' || 
                             target.tagName === 'TEXTAREA' || 
                             target.isContentEditable;
            if (isTyping) return;

            const center = getCanvasCenterPoint ? getCanvasCenterPoint() : { x: 0, y: 0 };

            // 1. Check if files in clipboard
            if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
                e.preventDefault();
                const files = Array.from(e.clipboardData.files);
                if (handleAddFiles) {
                    await handleAddFiles(files, center);
                }
                return;
            }

            // 2. Check text in clipboard
            const text = e.clipboardData?.getData('text/plain');
            if (text && text.trim()) {
                const trimmed = text.trim();

                // Check if canvas elements JSON
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed && parsed.type === 'artflow-elements' && Array.isArray(parsed.elements)) {
                        e.preventDefault();
                        handlePasteElements?.(parsed.elements, center);
                        return;
                    }
                } catch {
                    // Not JSON
                }

                // Optional text importers run after native canvas JSON, before bookmark/note fallback.
                const pluginElements = parseClipboardText(trimmed, center);
                if (pluginElements) {
                    e.preventDefault();
                    addElementsWithParenting?.(pluginElements);
                    return;
                }

                // Check if URL
                if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
                    e.preventDefault();
                    let domain = '';
                    try {
                        domain = new URL(trimmed).hostname;
                    } catch {
                        domain = trimmed;
                    }

                    const bookmarkEl: BookmarkElement = {
                        id: generateId(),
                        type: 'bookmark',
                        name: domain,
                        url: trimmed,
                        title: domain,
                        domain,
                        x: center.x - 180,
                        y: center.y - 65,
                        width: 360,
                        height: 130,
                        rotation: 0,
                    };

                    addElementsWithParenting?.([bookmarkEl]);
                    return;
                }

                // Check if Code
                const isCodeLike = /^(import\s|export\s|const\s|let\s|var\s|function\s|class\s|def\s|public\s|<\/|{\s*")/s.test(trimmed);
                if (isCodeLike) {
                    e.preventDefault();
                    const codeEl: CodeElement = {
                        id: generateId(),
                        type: 'code',
                        name: 'Code Snippet',
                        code: trimmed,
                        language: 'typescript',
                        x: center.x - 210,
                        y: center.y - 140,
                        width: 420,
                        height: 280,
                        rotation: 0,
                    };
                    addElementsWithParenting?.([codeEl]);
                    return;
                }

                // Paste as Markdown Card if multi-line or contains markdown tokens
                e.preventDefault();
                const mdEl: MarkdownElement = {
                    id: generateId(),
                    type: 'markdown',
                    name: 'Note',
                    content: trimmed,
                    x: center.x - 190,
                    y: center.y - 130,
                    width: 380,
                    height: 260,
                    rotation: 0,
                };
                addElementsWithParenting?.([mdEl]);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('paste', handlePasteEvent);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('paste', handlePasteEvent);
        };
    }, [
        presentationState, 
        presentationHotkeys, 
        handleNavigateWithTransition, 
        handleExitPresentation, 
        aiRotationState, 
        setAiRotationState, 
        editingElement, 
        handleStopEditing, 
        activeTool, 
        setActiveTool, 
        handleUndo, 
        handleRedo, 
        selectedElementIds, 
        handleDeleteSelected, 
        handleFocusSelection, 
        handleCopy,
        handlePasteElements,
        handleAddFiles,
        addElementsWithParenting,
        getCanvasCenterPoint,
        shiftEraseOriginalTool
    ]);
};
