
import React, { useCallback, useRef } from 'react';
import type { 
    ImageElement,
    TextElement,
    VideoElement, 
    AudioElement, 
    MarkdownElement, 
    CodeElement,
    ReaderElement,
    ComicElement,
    BookmarkElement, 
    FontElement, 
    Model3DElement,
    FileElement, 
    Element, 
    GroupElement,
    FileCardCategory,
    PluginNodeElement,
} from '../types';
import { generateId, getCanvasScreenRect } from '../utils/canvasUtils';
import { tryKernel } from '../plugin-runtime/instance';
import {
    resolveFormatHandler,
    loadedItemFromCard,
    type FormatImageResult,
    type FormatReaderResult,
    type FormatComicResult,
    type FormatParseResult,
    type PsdParseResult,
} from '../plugin-runtime/format-handlers';
import { getFileCategory, isSupportedFile } from '../utils/formatDetector';
import { assessImageImportBudget, type ImportHeapSnapshot } from '../utils/image-import-budget';
import { createImportMasonry, shouldFlushImportBatch, IMPORT_BATCH_MAX_ITEMS, IMPORT_BATCH_TARGET_BYTES } from '../utils/batchImport';
import {
    ImportStructureError,
    importFailureFrom,
    isNonEmptyString,
    isUsableImageAsset,
    summarizeImportFailures,
    type ImportFileFailure,
} from '../utils/importFailures';
import { waitForImportCommit } from '../utils/importScheduling';
import type { CanvasDocumentStateStore } from '../utils/canvas-document-state';
import { classifyFileCategory } from '../utils/docUtils';

const readAndCompressImage = async (file: File) => {
    const module = await import('../utils/fileUtils');
    return module.readAndCompressImage(file);
};

const yieldToPaint = (): Promise<void> => new Promise(resolve => {
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        resolve();
    };
    // A tab can become hidden after scheduling rAF; don't stall the import
    // indefinitely while the browser suspends animation callbacks.
    const fallback = setTimeout(finish, 120);
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
        requestAnimationFrame(() => setTimeout(finish, 0));
    } else {
        setTimeout(finish, 0);
    }
});

type LoadedAsset =
    | { type: 'image'; name: string; width: number; height: number; dataUrl: string; thumbnailDataUrl?: string; mediumDataUrl?: string; originalDataUrl?: string; mimeType: string }
    | { type: 'text'; name: string; width: number; height: number; text: string; fontSize: number; fontColor: string }
    | { type: 'video'; name: string; width: number; height: number; dataUrl: string; mimeType: string; fileSize?: number }
    | { type: 'audio'; name: string; width: number; height: number; dataUrl: string; mimeType: string; duration?: number }
    | { type: 'markdown'; name: string; width: number; height: number; content: string }
    | { type: 'code'; name: string; width: number; height: number; code: string; language: string }
    | { type: 'reader'; name: string; width: number; height: number; content: string; sourceFormat: FormatReaderResult['sourceFormat']; characterCount: number; isTruncated: boolean; chapters?: FormatReaderResult['chapters'] }
    | { type: 'comic'; name: string; width: number; height: number; pages?: string[]; archiveRef?: string; pageNames?: string[]; sourceFormat: FormatComicResult['sourceFormat'] }
    | { type: 'bookmark'; name: string; width: number; height: number; url: string; title: string; domain: string }
    | { type: 'font'; name: string; width: number; height: number; fontFamily: string; fontUrl: string; format: string; fileSize: number }
    | { type: 'model3d'; name: string; width: number; height: number; fileUrl: string; fileExtension: string; fileSize: number }
    | { type: 'file'; name: string; width: number; height: number; fileUrl: string; fileSize: number; fileExtension: string; category: FileCardCategory; mimeType: string }
    | { type: 'plugin-node'; name: string; width: number; height: number; nodeType: string; data: Record<string, unknown> };

type LoadedItem = LoadedAsset & {
    rotation?: number;
    layout?: { x: number; y: number; width: number; height: number };
};

const elementFromLoaded = (
    asset: LoadedItem,
    pos: { x: number; y: number; w: number; h: number },
    offsetX: number,
    offsetY: number,
): Element => {
    const common = {
        id: generateId(),
        x: offsetX + pos.x,
        y: offsetY + pos.y,
        width: pos.w,
        height: pos.h,
        name: asset.name,
        rotation: asset.rotation ?? 0,
    };

    if (asset.type === 'image') {
        return {
            ...common,
            type: 'image',
            href: asset.dataUrl,
            thumbnailHref: asset.thumbnailDataUrl,
            mediumHref: asset.mediumDataUrl,
            mimeType: asset.mimeType,
            opacity: 1,
            borderRadius: 0,
            originalHref: asset.originalDataUrl,
            originalPixelWidth: asset.width,
            originalPixelHeight: asset.height,
        } as ImageElement;
    }
    if (asset.type === 'text') {
        return {
            ...common,
            type: 'text',
            text: asset.text,
            fontSize: asset.fontSize,
            fontColor: asset.fontColor,
        } as TextElement;
    }
    if (asset.type === 'audio') {
        return {
            ...common,
            type: 'audio',
            href: asset.dataUrl,
            mimeType: asset.mimeType,
            duration: asset.duration,
        } as AudioElement;
    }
    if (asset.type === 'video') {
        return {
            ...common,
            type: 'video',
            href: asset.dataUrl,
            mimeType: asset.mimeType,
            ...(asset.fileSize !== undefined ? { fileSize: asset.fileSize } : {}),
        } as VideoElement;
    }
    if (asset.type === 'markdown') {
        return { ...common, type: 'markdown', content: asset.content } as MarkdownElement;
    }
    if (asset.type === 'code') {
        return { ...common, type: 'code', code: asset.code, language: asset.language } as CodeElement;
    }
    if (asset.type === 'reader') {
        return {
            ...common,
            type: 'reader',
            content: asset.content,
            sourceFormat: asset.sourceFormat,
            characterCount: asset.characterCount,
            isTruncated: asset.isTruncated,
            ...(asset.chapters && asset.chapters.length > 0 ? { chapters: asset.chapters } : {}),
        } as ReaderElement;
    }
    if (asset.type === 'comic') {
        return { ...common, type: 'comic', pages: asset.pages, sourceFormat: asset.sourceFormat } as ComicElement;
    }
    if (asset.type === 'bookmark') {
        return { ...common, type: 'bookmark', url: asset.url, title: asset.title, domain: asset.domain } as BookmarkElement;
    }
    if (asset.type === 'font') {
        return {
            ...common,
            type: 'font',
            fontFamily: asset.fontFamily,
            fontUrl: asset.fontUrl,
            format: asset.format,
            fileSize: asset.fileSize,
        } as FontElement;
    }
    if (asset.type === 'model3d') {
        return {
            ...common,
            type: 'model3d',
            fileUrl: asset.fileUrl,
            fileExtension: asset.fileExtension,
            fileSize: asset.fileSize,
            autoRotate: true,
            wireframe: false,
            theme: 'studio',
        } as Model3DElement;
    }
    if (asset.type === 'plugin-node') {
        return { ...common, type: 'plugin-node', nodeType: asset.nodeType, data: asset.data } as PluginNodeElement;
    }
    return {
        ...common,
        type: 'file',
        fileUrl: asset.fileUrl,
        fileSize: asset.fileSize,
        fileExtension: asset.fileExtension,
        category: asset.category,
        mimeType: asset.mimeType,
    } as FileElement;
};

const asLoadedImage = (image: FormatImageResult): LoadedItem => ({
    type: 'image',
    name: image.name,
    width: image.width,
    height: image.height,
    dataUrl: image.dataUrl,
    thumbnailDataUrl: image.thumbnailDataUrl,
    mediumDataUrl: image.mediumDataUrl,
    originalDataUrl: image.originalDataUrl,
    mimeType: image.mimeType,
});

const resolveRegisteredFormatHandler = (file: File) => {
    const kernel = tryKernel();
    return kernel ? resolveFormatHandler(kernel, file) : undefined;
};

interface FileHandlersProps {
    getCanvasPoint: (x: number, y: number) => { x: number; y: number };
    addElementsWithParenting: (elements: Element[], commit?: boolean, importGroupId?: string) => void;
    endImportHistoryGroup?: (importGroupId: string) => void;
    documentState?: Pick<CanvasDocumentStateStore, 'getSnapshot'>;
    /** Live gesture state: never publish a new canvas document during a drag, edit or pan/zoom. */
    isCanvasBusy?: () => boolean;
    /** Stage an ephemeral reveal before the canvas document is committed. */
    onImportElementsReady?: (elements: Element[]) => void;
    setSelectedElementIds: (ids: string[]) => void;
    setActiveTool: (tool: any) => void;
    setError: (error: string | null) => void;
    svgRef: React.RefObject<SVGSVGElement>;
    updateActiveBoard: (updater: (board: any) => any) => void;
    openPsdModal?: (psdData: PsdParseResult, dropPoint?: { x: number; y: number }) => void;
    setIsLoading?: (loading: boolean) => void;
    setProgressMessage?: (msg: string) => void;
    /** Declarative extension import (V3): returns true when every file was routed to a managed extension batch. */
    importExtensionFiles?: (files: File[], dropPoint?: { x: number; y: number }) => Promise<boolean>;
}

export const useFileHandlers = ({
    getCanvasPoint,
    addElementsWithParenting,
    endImportHistoryGroup,
    documentState,
    isCanvasBusy,
    onImportElementsReady,
    setSelectedElementIds,
    setActiveTool,
    setError,
    svgRef,
    updateActiveBoard,
    openPsdModal,
    setIsLoading,
    setProgressMessage,
    importExtensionFiles,
}: FileHandlersProps) => {
    const importingRef = useRef(false);

    const handleImportPsdMerged = useCallback((psdData: PsdParseResult, dropPoint?: { x: number; y: number }) => {
        let anchorPoint;
        if (dropPoint) {
            anchorPoint = dropPoint;
        } else if (svgRef.current) {
            const svgBounds = getCanvasScreenRect(svgRef.current);
            if (svgBounds) {
                const screenCenter = { x: svgBounds.left + svgBounds.width / 2, y: svgBounds.top + svgBounds.height / 2 };
                anchorPoint = getCanvasPoint(screenCenter.x, screenCenter.y);
            } else {
                anchorPoint = { x: 0, y: 0 };
            }
        } else {
            anchorPoint = { x: 0, y: 0 };
        }

        const maxDimension = 1200;
        let width = psdData.width;
        let height = psdData.height;
        if (width > maxDimension || height > maxDimension) {
            const ratio = Math.min(maxDimension / width, maxDimension / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
        }

        const id = generateId();
        const newElement: ImageElement = {
            id,
            type: 'image',
            name: psdData.fileName,
            x: anchorPoint.x - width / 2,
            y: anchorPoint.y - height / 2,
            width,
            height,
            href: psdData.compositeDataUrl,
            thumbnailHref: psdData.compositeDataUrl,
            originalHref: psdData.compositeDataUrl,
            mimeType: 'image/png',
            opacity: 1,
            borderRadius: 0,
            rotation: 0,
        };

        addElementsWithParenting([newElement]);
        setSelectedElementIds([id]);
        setActiveTool('select');
    }, [svgRef, getCanvasPoint, addElementsWithParenting, setSelectedElementIds, setActiveTool]);

    const handleImportPsdLayers = useCallback((
        psdData: PsdParseResult, 
        dropPoint: { x: number; y: number } | undefined, 
        options: { autoGroup: boolean; onlyVisible: boolean }
    ) => {
        let anchorPoint;
        if (dropPoint) {
            anchorPoint = dropPoint;
        } else if (svgRef.current) {
            const svgBounds = getCanvasScreenRect(svgRef.current);
            if (svgBounds) {
                const screenCenter = { x: svgBounds.left + svgBounds.width / 2, y: svgBounds.top + svgBounds.height / 2 };
                anchorPoint = getCanvasPoint(screenCenter.x, screenCenter.y);
            } else {
                anchorPoint = { x: 0, y: 0 };
            }
        } else {
            anchorPoint = { x: 0, y: 0 };
        }

        const maxDimension = 1200;
        let scale = 1;
        if (psdData.width > maxDimension || psdData.height > maxDimension) {
            scale = Math.min(maxDimension / psdData.width, maxDimension / psdData.height);
        }

        const totalWidth = Math.round(psdData.width * scale);
        const totalHeight = Math.round(psdData.height * scale);
        const originX = anchorPoint.x - totalWidth / 2;
        const originY = anchorPoint.y - totalHeight / 2;

        const layersToImport = options.onlyVisible 
            ? psdData.layers.filter(l => !l.hidden) 
            : psdData.layers;

        if (layersToImport.length === 0) {
            handleImportPsdMerged(psdData, dropPoint);
            return;
        }

        const groupId = options.autoGroup ? generateId() : undefined;
        const layerElements: ImageElement[] = layersToImport.map(layer => {
            const layerWidth = Math.max(1, Math.round(layer.width * scale));
            const layerHeight = Math.max(1, Math.round(layer.height * scale));
            const layerX = Math.round(originX + layer.left * scale);
            const layerY = Math.round(originY + layer.top * scale);

            return {
                id: generateId(),
                parentId: groupId,
                type: 'image',
                name: layer.name || 'Layer',
                x: layerX,
                y: layerY,
                width: layerWidth,
                height: layerHeight,
                href: layer.dataUrl,
                originalHref: layer.dataUrl,
                mimeType: 'image/png',
                opacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
                isVisible: !layer.hidden,
                rotation: 0,
                borderRadius: 0,
            };
        });

        const elementsToAdd: Element[] = [...layerElements];

        if (groupId) {
            const groupElement: GroupElement = {
                id: groupId,
                type: 'group',
                name: psdData.fileName.replace(/\.[^/.]+$/, ''),
                x: originX,
                y: originY,
                width: totalWidth,
                height: totalHeight,
                rotation: 0,
            };
            elementsToAdd.push(groupElement);
        }

        addElementsWithParenting(elementsToAdd);
        setSelectedElementIds(groupId ? [groupId] : layerElements.map(el => el.id));
        setActiveTool('select');
    }, [svgRef, getCanvasPoint, handleImportPsdMerged, addElementsWithParenting, setSelectedElementIds, setActiveTool]);

    const handleAddFiles = useCallback(async (files: File[], dropPoint?: { x: number, y: number }) => {
        if (!files || files.length === 0) return;
        if (importingRef.current) {
            setError('An import is already running. Please wait for it to finish.');
            return;
        }
        importingRef.current = true;
        const importGroupId = generateId();
        // If the user works on the canvas while import runs, don't replace
        // their selection or active tool with the newly imported items later.
        let userInteracted = false;
        let pointerHeld = false;
        let lastUserInputAt = -Infinity;
        const noteUserInput = () => { userInteracted = true; lastUserInputAt = Date.now(); };
        const onPointerDown = () => { noteUserInput(); pointerHeld = true; };
        const onPointerEnd = () => { pointerHeld = false; lastUserInputAt = Date.now(); };
        const importCanvasBusy = () => pointerHeld || Boolean(isCanvasBusy?.()) || Date.now() - lastUserInputAt < 120;
        if (typeof window !== 'undefined') {
            window.addEventListener('pointerdown', onPointerDown, true);
            window.addEventListener('pointerup', onPointerEnd, true);
            window.addEventListener('pointercancel', onPointerEnd, true);
            window.addEventListener('blur', onPointerEnd);
            window.addEventListener('wheel', noteUserInput, true);
            window.addEventListener('keydown', noteUserInput, true);
        }
        try {

        const validFiles = files.filter(isSupportedFile);
        if (validFiles.length === 0) {
            setError('Unsupported file format.');
            return;
        }
        setError(null);

        // V3: files matching installed declarative extensions go to a managed background batch, not the legacy sync path.
        if (importExtensionFiles) {
            try {
                if (await importExtensionFiles(validFiles, dropPoint)) return;
            } catch (err) {
                console.error('Failed to start extension import:', err);
                setError('Failed to start extension import.');
                return;
            }
        }

        // No total-drop limit. The browser fallback still stores image data URLs,
        // so check live heap headroom immediately before reading each image.

        // PSD retains its existing modal flow, but parser selection now comes from the registry.
        const singleHandler = validFiles.length === 1 ? resolveRegisteredFormatHandler(validFiles[0]) : undefined;
        if (singleHandler?.value.outputKind === 'psd') {
            try {
                setIsLoading?.(true);
                setProgressMessage?.('Parsing PSD file...');
                const heap = typeof performance === 'undefined'
                    ? undefined
                    : (performance as Performance & { memory?: ImportHeapSnapshot }).memory;
                const budget = assessImageImportBudget([validFiles[0]], heap);
                if (!budget.allowed) throw new Error(budget.message);
                const parsed = await singleHandler.value.parse(validFiles[0]);
                if (parsed.kind !== 'psd') throw new Error(`PSD handler returned ${parsed.kind}`);
                const psdResult = parsed.psd;
                setIsLoading?.(false);
                setProgressMessage?.('');

                if (psdResult.hasMultipleLayers && psdResult.layers.length > 1 && openPsdModal) {
                    openPsdModal(psdResult, dropPoint);
                    return;
                }
                handleImportPsdMerged(psdResult, dropPoint);
                return;
            } catch (err) {
                setIsLoading?.(false);
                setProgressMessage?.('');
                console.error('Failed to parse PSD:', err);
                setError(err instanceof Error && err.message.startsWith('Browser memory is nearly full')
                    ? err.message : 'Failed to parse PSD file.');
                return;
            }
        }

        const loadedAssets: LoadedItem[] = [];
        const importNotices: string[] = [];
        // 加固项④：失败明细逐文件记账；单个文件出问题不影响同一批里的其它文件。
        const importFailures: ImportFileFailure[] = [];
        const noteImportFailure = (file: File, error: unknown): void => {
            const failure = importFailureFrom(generateId(), file.name, error);
            importFailures.push(failure);
            console.warn(`[import] skipped "${failure.name}" (${failure.stage}): ${failure.error}`);
        };
        /** 部分成功的统一口径：入库了多少 + 跳过了谁、为什么。 */
        const reportImportFailures = (importedFiles: number, placedItems: number): string => {
            const details = summarizeImportFailures(importFailures);
            if (importedFiles === 0) return `Could not import files. No files were placed. ${details}`;
            return `Imported ${importedFiles}/${validFiles.length} files (${placedItems} items). ${details}`;
        };
        const sourceBytes = validFiles.reduce((sum, file) => sum + file.size, 0);
        const hasScene = validFiles.some(file => resolveRegisteredFormatHandler(file)?.value.outputKind === 'scene');
        // Small and single-file imports keep the familiar centered layout. A
        // multi-file drop switches to bounded batches once file count or bytes
        // make retaining everything until the end unsafe.
        const streamedImport = !hasScene && validFiles.length > 1
            && (validFiles.length >= IMPORT_BATCH_MAX_ITEMS * 2 || sourceBytes >= IMPORT_BATCH_TARGET_BYTES);
        if (streamedImport && !svgRef.current) {
            setError('Canvas is not ready for importing files.');
            return;
        }
        const originalDocument = documentState?.getSnapshot();
        const targetBoardId = originalDocument?.activeBoardId;
        const canSelectOnTargetBoard = () => !userInteracted && !importCanvasBusy()
            && (!originalDocument || (
                documentState?.getSnapshot().sessionId === originalDocument.sessionId
                && documentState?.getSnapshot().activeBoardId === targetBoardId
            ));
        const isImportTargetAvailable = () => {
            if (!originalDocument) return true;
            const current = documentState!.getSnapshot();
            return current.sessionId === originalDocument.sessionId
                && current.boards.some(board => board.id === targetBoardId);
        };
        const assertImportTarget = () => {
            if (!isImportTargetAvailable()) throw new Error('The project or destination board changed while importing.');
        };
        let placedFiles = 0;
        let currentFileName: string | undefined;
        let pendingFiles = 0;
        let pendingSourceBytes = 0;
        const placedIds: string[] = [];
        let streamedMasonry: ReturnType<typeof createImportMasonry> | null = null;
        if (streamedImport && svgRef.current) {
            let anchor = dropPoint;
            if (!anchor) {
                const bounds = getCanvasScreenRect(svgRef.current);
                anchor = bounds
                    ? getCanvasPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
                    : { x: 0, y: 0 };
            }
            streamedMasonry = createImportMasonry(validFiles.length, anchor);
        }

        // Commit only the current working batch. All earlier image payloads are
        // owned by the canvas document, not retained in a second loadedAssets list.
        const flushPending = async () => {
            if (!streamedMasonry || loadedAssets.length === 0) return;
            // A chunk is already bounded. Keep it in memory while the user
            // drags/zooms rather than invalidating React's canvas mid-gesture.
            await waitForImportCommit(importCanvasBusy);
            assertImportTarget();
            const chunk = loadedAssets.splice(0);
            const elements = chunk.map(asset => elementFromLoaded(asset, streamedMasonry!.place(asset), 0, 0));
            onImportElementsReady?.(elements);
            addElementsWithParenting(elements, true, importGroupId);
            placedIds.push(...elements.map(element => element.id));
            placedFiles += pendingFiles;
            pendingFiles = 0;
            pendingSourceBytes = 0;
            setProgressMessage?.(`Imported ${placedFiles}/${validFiles.length} files · ${placedIds.length} canvas items`);
            // Wait until after a paint opportunity instead of monopolizing a
            // renderer task with all files/React commits back to back.
            await yieldToPaint();
        };

        /**
         * 加固项④：单个文件的解析 + 装载。
         * 这个函数允许抛错 —— 异常由调用点记账后只跳过当前文件，同一批里的其它文件照常继续。
         * 解析器跑通了但结果没法用时抛 ImportStructureError，与解析器直接抛错分开记账。
         */
        const loadAssetsFromFile = async (file: File): Promise<void> => {
            const registeredHandler = resolveRegisteredFormatHandler(file);
            if (registeredHandler) {
                const parsed = await registeredHandler.value.parse(file) as FormatParseResult | null | undefined;
                if (!parsed || typeof parsed !== 'object' || typeof (parsed as { kind?: unknown }).kind !== 'string') {
                    throw new ImportStructureError('format handler returned no usable result');
                }
                if (parsed.kind === 'image') {
                    if (!isUsableImageAsset(parsed)) throw new ImportStructureError('image result has no usable size or data URL');
                    loadedAssets.push(asLoadedImage(parsed));
                } else if (parsed.kind === 'image-pages') {
                    if (!Array.isArray(parsed.pages)) throw new ImportStructureError('page result has no page list');
                    parsed.pages.forEach(page => {
                        if (!isUsableImageAsset(page)) throw new ImportStructureError('page result has no usable size or data URL');
                        loadedAssets.push(asLoadedImage(page));
                    });
                } else if (parsed.kind === 'audio') {
                    if (!isNonEmptyString(parsed.dataUrl)) throw new ImportStructureError('audio result has no data URL');
                    loadedAssets.push({
                        type: 'audio',
                        name: parsed.name,
                        width: parsed.width,
                        height: parsed.height,
                        dataUrl: parsed.dataUrl,
                        mimeType: parsed.mimeType,
                        duration: parsed.duration,
                    });
                } else if (parsed.kind === 'video') {
                    if (!isNonEmptyString(parsed.dataUrl)) throw new ImportStructureError('video result has no data URL');
                    loadedAssets.push({
                        type: 'video',
                        name: parsed.name,
                        width: parsed.width,
                        height: parsed.height,
                        dataUrl: parsed.dataUrl,
                        mimeType: parsed.mimeType,
                        fileSize: parsed.fileSize,
                    });
                } else if (parsed.kind === 'reader') {
                    if (!isNonEmptyString(parsed.content)) throw new ImportStructureError('reader result has no readable content');
                    loadedAssets.push({
                        type: 'reader',
                        name: parsed.title,
                        width: 420,
                        height: 520,
                        content: parsed.content,
                        sourceFormat: parsed.sourceFormat,
                        characterCount: parsed.characterCount,
                        isTruncated: parsed.isTruncated,
                        ...(parsed.chapters && parsed.chapters.length > 0 ? { chapters: parsed.chapters } : {}),
                    });
                } else if (parsed.kind === 'comic') {
                    if (!isNonEmptyString(parsed.archiveRef) && !(parsed.pages && parsed.pages.length > 0)) {
                        throw new ImportStructureError('comic result has no readable pages');
                    }
                    loadedAssets.push({
                        type: 'comic',
                        name: parsed.title,
                        width: 420,
                        height: 560,
                        // 新导入走主进程档案仓懒加载；parsed.pages 只在旧夹具/兼容路径出现。
                        ...(parsed.pages ? { pages: parsed.pages } : {}),
                        ...(parsed.archiveRef
                        ? { archiveRef: parsed.archiveRef, pageNames: parsed.pageNames ?? [] }
                        : {}),
                        sourceFormat: parsed.sourceFormat,
                    });
                } else if (parsed.kind === 'card') {
                    const cardAsset = loadedItemFromCard(parsed) as LoadedItem | null | undefined;
                    if (!cardAsset || typeof cardAsset !== 'object' || typeof (cardAsset as { type?: unknown }).type !== 'string') {
                        throw new ImportStructureError('card result is not an importable asset');
                    }
                    loadedAssets.push(cardAsset);
                } else if (parsed.kind === 'scene') {
                    if (streamedMasonry) throw new ImportStructureError('a scene result cannot be streamed in a bounded batch');
                    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
                        throw new ImportStructureError('scene result has no items');
                    }
                    if (parsed.notice) importNotices.push(parsed.notice);
                    parsed.items.forEach(item => {
                        if (item.kind === 'image') {
                            if (!isUsableImageAsset(item)) throw new ImportStructureError('scene image has no usable size or data URL');
                            loadedAssets.push({
                                type: 'image',
                                name: item.name,
                                width: item.width,
                                height: item.height,
                                dataUrl: item.dataUrl,
                                mimeType: item.mimeType,
                                rotation: item.rotation,
                                layout: { x: item.x, y: item.y, width: item.width, height: item.height },
                            });
                            return;
                        }
                        if (item.kind !== 'text' || !isNonEmptyString(item.text)) {
                            throw new ImportStructureError(`scene item is not importable: kind "${String((item as { kind?: unknown }).kind)}"`);
                        }
                        loadedAssets.push({
                            type: 'text',
                            name: item.name,
                            width: item.width,
                            height: item.height,
                            text: item.text,
                            fontSize: item.fontSize,
                            fontColor: item.fontColor,
                            rotation: item.rotation,
                            layout: { x: item.x, y: item.y, width: item.width, height: item.height },
                        });
                    });
                } else if (parsed.kind === 'psd') {
                    // Multi-file PSD retains a safe composite image fallback; the one-file modal returned above.
                    if (!isNonEmptyString(parsed.psd?.compositeDataUrl)) {
                        throw new ImportStructureError('PSD result has no composite image');
                    }
                    loadedAssets.push({
                        type: 'image',
                        name: parsed.psd.fileName,
                        width: parsed.psd.width,
                        height: parsed.psd.height,
                        dataUrl: parsed.psd.compositeDataUrl,
                        thumbnailDataUrl: parsed.psd.compositeDataUrl,
                        originalDataUrl: parsed.psd.compositeDataUrl,
                        mimeType: 'image/png',
                    });
                } else {
                    // 未知 kind：宁可只跳过这个文件，也不把渲染不出来的资产塞进画布。
                    throw new ImportStructureError(`format handler returned an unsupported result: kind "${String((parsed as { kind?: unknown }).kind)}"`);
                }
            } else {
                const category = getFileCategory(file);
                const ext = file.name.split('.').pop()?.toLowerCase() || '';

                if (category === 'image') {
                    // All images: PSD, SVG, TIFF, TGA, EXR, RAW, DNG, CR2, NEF, ARW, PNG, JPG, etc.
                    const res = await readAndCompressImage(file);
                    loadedAssets.push({
                        type: 'image',
                        name: file.name,
                        width: res.width,
                        height: res.height,
                        dataUrl: res.dataUrl,
                        thumbnailDataUrl: res.thumbnailDataUrl,
                        mediumDataUrl: res.mediumDataUrl,
                        originalDataUrl: res.originalDataUrl,
                        mimeType: res.mimeType,
                    });
                } else {
                    // Universal file category fallback (3D models, archives, docs, design files, executables, etc.)
                    const fileUrl = URL.createObjectURL(file);
                    const fileCategory = classifyFileCategory(ext);
                    loadedAssets.push({
                        type: 'file',
                        name: file.name,
                        width: 340,
                        height: 130,
                        fileUrl,
                        fileSize: file.size,
                        fileExtension: ext,
                        category: fileCategory,
                        mimeType: file.type || `${ext.toUpperCase()} File`,
                    });
                }
            }
        };

        try {
            setIsLoading?.(true);
            setProgressMessage?.('Importing assets...');

            for (const [fileIndex, file] of validFiles.entries()) {
                currentFileName = file.name;
                assertImportTarget();
                // Continue decoding between gestures, but do not start a large
                // renderer-side FileReader while the canvas is actively moving.
                if (importCanvasBusy()) await waitForImportCommit(importCanvasBusy);
                assertImportTarget();
                if (fileIndex % 4 === 0) {
                    setProgressMessage?.(`Importing ${fileIndex + 1}/${validFiles.length}: ${file.name}`);
                    // Give the spinner and canvas a paint opportunity during long drops.
                    await yieldToPaint();
                }
                if (importCanvasBusy()) await waitForImportCommit(importCanvasBusy);
                assertImportTarget();
                if (getFileCategory(file) === 'image') {
                    const heap = typeof performance === 'undefined'
                        ? undefined
                        : (performance as Performance & { memory?: ImportHeapSnapshot }).memory;
                    const budget = assessImageImportBudget([file], heap);
                    if (!budget.allowed) {
                        // Previously decoded but not yet painted items still belong
                        // to this drop. Preserve them before stopping for low memory.
                        if (streamedMasonry) await flushPending();
                        throw new Error(budget.message ?? 'Not enough memory for the next image.');
                    }
                }
                // 加固项④：单个文件的解析失败 / 结构非法只跳过该文件，其余文件继续导入；
                // 收齐失败明细后按「部分成功」的结果入库并上报。
                const assetCountBeforeFile = loadedAssets.length;
                const noticesBeforeFile = importNotices.length;
                let fileSkipped = false;
                try {
                    await loadAssetsFromFile(file);
                } catch (error) {
                    fileSkipped = true;
                    // 丢掉这个文件已经塞进去的半成品，避免脏资产进画布。
                    loadedAssets.length = assetCountBeforeFile;
                    importNotices.length = noticesBeforeFile;
                    noteImportFailure(file, error);
                }
                if (!fileSkipped && loadedAssets.length === assetCountBeforeFile) {
                    // 解析器没抛错却什么都没产出，同样只跳过这个文件。
                    importNotices.length = noticesBeforeFile;
                    noteImportFailure(file, new ImportStructureError('format handler produced no importable asset'));
                }
                if (streamedMasonry && loadedAssets.length > assetCountBeforeFile) {
                    pendingFiles += 1;
                    pendingSourceBytes += file.size;
                    if (shouldFlushImportBatch(loadedAssets.length, pendingSourceBytes)) await flushPending();
                }
            }

            if (streamedMasonry) {
                await flushPending();
                if (placedIds.length > 0 && canSelectOnTargetBoard()) {
                    setSelectedElementIds(placedIds);
                    setActiveTool('select');
                }
                setIsLoading?.(false);
                // 部分成功也照常入库：跳过的文件按明细报出来，其余文件的结果已经在画布上。
                setProgressMessage?.(importFailures.length > 0
                    ? `Imported ${placedFiles}/${validFiles.length} files · ${placedIds.length} canvas items · ${importFailures.length} skipped`
                    : '');
                setError(importFailures.length > 0
                    ? reportImportFailures(placedFiles, placedIds.length)
                    : null);
                return;
            }

            setIsLoading?.(false);
            setProgressMessage?.('');

            if (loadedAssets.length === 0 || !svgRef.current) {
                // 所有文件都被跳过时同样要如实上报，而不是静默返回。
                if (importFailures.length > 0) setError(reportImportFailures(0, 0));
                return;
            }
            
            // 2. 确定锚点（鼠标位置或画布中心）
            let anchorPoint;
            if (dropPoint) {
                anchorPoint = dropPoint;
            } else {
                const svgBounds = getCanvasScreenRect(svgRef.current);
                if (svgBounds) {
                    const screenCenter = { x: svgBounds.left + svgBounds.width / 2, y: svgBounds.top + svgBounds.height / 2 };
                    anchorPoint = getCanvasPoint(screenCenter.x, screenCenter.y);
                } else {
                    anchorPoint = { x: 0, y: 0 };
                }
            }

            const sceneAssets = loadedAssets.filter(asset => asset.layout);
            const looseAssets = loadedAssets.filter(asset => !asset.layout);
            const newElements: Element[] = [];

            if (sceneAssets.length > 0) {
                const boxes = sceneAssets.map(asset => asset.layout!);
                const minX = Math.min(...boxes.map(box => box.x));
                const minY = Math.min(...boxes.map(box => box.y));
                const maxX = Math.max(...boxes.map(box => box.x + box.width));
                const maxY = Math.max(...boxes.map(box => box.y + box.height));
                const sceneOffsetX = anchorPoint.x - (minX + maxX) / 2;
                const sceneOffsetY = anchorPoint.y - (minY + maxY) / 2;
                sceneAssets.forEach(asset => {
                    const box = asset.layout!;
                    newElements.push(elementFromLoaded(asset, { x: box.x, y: box.y, w: box.width, h: box.height }, sceneOffsetX, sceneOffsetY));
                });
            }

            // 3. 瀑布流（Masonry）核心算法。带坐标的场景元素已经按原位置放下。
            const GAP = 15; // 间距
            const COLUMN_WIDTH = 400; // 固定列宽，实现瀑布流的关键
            const assetCount = looseAssets.length;
            const colCount = Math.max(1, Math.ceil(Math.sqrt(assetCount))); // 动态列数
            
            // 初始化每列高度记录器
            const colHeights = new Array(colCount).fill(0);
            const positions: { x: number; y: number; w: number; h: number }[] = [];

            looseAssets.forEach(asset => {
                // 寻找当前最“矮”的列
                const minHeight = Math.min(...colHeights);
                const colIdx = colHeights.indexOf(minHeight);
                
                // 计算等宽缩放后的高度
                let scaledHeight = (COLUMN_WIDTH / asset.width) * asset.height;
                if (asset.type === 'audio') {
                    scaledHeight = 96;
                } else if (asset.type === 'bookmark' || asset.type === 'file') {
                    scaledHeight = 130;
                } else if (asset.type === 'font') {
                    scaledHeight = 180;
                } else if (asset.type === 'markdown') {
                    scaledHeight = 260;
                } else if (asset.type === 'code') {
                    scaledHeight = 280;
                } else if (asset.type === 'reader') {
                    scaledHeight = 520;
                } else if (asset.type === 'comic') {
                    scaledHeight = 560;
                } else if (asset.type === 'model3d') {
                    scaledHeight = 320;
                }

                positions.push({
                    x: colIdx * (COLUMN_WIDTH + GAP),
                    y: colHeights[colIdx],
                    w: COLUMN_WIDTH,
                    h: scaledHeight
                });

                // 更新该列高度（累加高度 + 间距）
                colHeights[colIdx] += scaledHeight + GAP;
            });

            // 4. 计算布局总边界以便整体居中平移
            const totalWidth = colCount * COLUMN_WIDTH + (colCount - 1) * GAP;
            const totalHeight = Math.max(...colHeights) - GAP;

            let offsetX = anchorPoint.x - totalWidth / 2;
            let offsetY = anchorPoint.y - totalHeight / 2;
            if (sceneAssets.length > 0 && looseAssets.length > 0) {
                const sceneHeight = Math.max(...sceneAssets.map(asset => asset.layout!.y + asset.layout!.height))
                    - Math.min(...sceneAssets.map(asset => asset.layout!.y));
                offsetY += sceneHeight / 2 + totalHeight / 2 + GAP;
            }

            looseAssets.forEach((asset, index) => {
                newElements.push(elementFromLoaded(asset, positions[index], offsetX, offsetY));
            });

            if (newElements.length === 0) return;

            // 6. 执行添加
            onImportElementsReady?.(newElements);
            addElementsWithParenting(newElements);
            setSelectedElementIds(newElements.map(el => el.id));
            setActiveTool('select');
            if (importFailures.length > 0) {
                // 部分成功：照常把可用资产放进画布，同时把跳过的文件明细报出来。
                importNotices.push(reportImportFailures(validFiles.length - importFailures.length, newElements.length));
            }
            if (importNotices.length > 0) setError(importNotices.join(' '));

        } catch (err) {
            // A bad image or low heap stops only the remaining files, not the
            // images already committed by earlier batches. Finish a partial
            // working batch when possible and report the actual placed count.
            if (streamedMasonry && loadedAssets.length > 0 && isImportTargetAvailable()) {
                try { await flushPending(); } catch (flushError) { console.error('Failed to finish import batch:', flushError); }
            }
            if (streamedMasonry && placedIds.length > 0 && canSelectOnTargetBoard()) {
                setSelectedElementIds(placedIds);
                setActiveTool('select');
            }
            setIsLoading?.(false);
            setProgressMessage?.('');
            const reason = err instanceof Error ? err.message : 'Unknown import error.';
            const destinationLost = !isImportTargetAvailable();
            const failedAt = currentFileName ? `Stopped at "${currentFileName.slice(0, 80)}". ` : '';
            // 整批被中断时，把此前已跳过的文件明细一并报出来，避免「部分成功」被误读成全成或全败。
            const skippedDetail = importFailures.length > 0 ? ` ${summarizeImportFailures(importFailures)}` : '';
            setError(destinationLost
                ? `Import stopped because the destination project or board changed. No items were added to the new destination.${skippedDetail}`
                : streamedMasonry
                    ? `Imported ${placedFiles}/${validFiles.length} files (${placedIds.length} items). ${validFiles.length - placedFiles} files were not imported. ${failedAt}${reason}${skippedDetail}`
                    : `Could not import files. No files were placed. ${failedAt}${reason}${skippedDetail}`);
            console.error(err);
        }
        } finally {
            if (typeof window !== 'undefined') {
                window.removeEventListener('pointerdown', onPointerDown, true);
                window.removeEventListener('pointerup', onPointerEnd, true);
                window.removeEventListener('pointercancel', onPointerEnd, true);
                window.removeEventListener('blur', onPointerEnd);
                window.removeEventListener('wheel', noteUserInput, true);
                window.removeEventListener('keydown', noteUserInput, true);
            }
            endImportHistoryGroup?.(importGroupId);
            importingRef.current = false;
        }
    }, [getCanvasPoint, addElementsWithParenting, endImportHistoryGroup, documentState, isCanvasBusy, onImportElementsReady, setSelectedElementIds, setActiveTool, setError, svgRef, openPsdModal, setIsLoading, setProgressMessage, handleImportPsdMerged, importExtensionFiles]);

    const handleCanvasBackgroundImageChange = useCallback(async (file: File) => {
        if (!isSupportedFile(file)) {
            setError('Unsupported image file format.');
            return;
        }
        try {
            // 背景图片也使用压缩逻辑，防止大图作为背景卡顿
            const { dataUrl } = await readAndCompressImage(file);
            updateActiveBoard(b => ({ ...b, canvasBackgroundColor: `url(${dataUrl})` }));
        } catch (err) {
            setError('Failed to load background image.');
            console.error(err);
        }
    }, [setError, updateActiveBoard]);

    return {
        handleAddFiles,
        handleImportPsdMerged,
        handleImportPsdLayers,
        handleCanvasBackgroundImageChange,
    };
};

