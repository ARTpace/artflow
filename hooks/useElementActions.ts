
import { useCallback, useRef } from 'react';
// 修复：补全 ShapeElement 导入
import type { Element, ImageElement, Rect, Point, GroupElement, VideoElement, FrameElement, ShapeElement } from '../types';
import { 
    generateId, 
    getDescendants, 
    getElementBounds, 
    rasterizeElement, 
    rasterizeElements,
    getFlattenedSelection,
    getSelectionBounds,
} from '../utils/canvasUtils';
import { imageArtifacts, textArtifact, type InvokeAIProvider } from './useAIHandlers';

interface ElementActionsProps {
    elements: Element[];
    selectedElementIds: string[];
    setSelectedElementIds: (ids: string[]) => void;
    commitAction: (updater: (prev: Element[]) => Element[]) => void;
    addElementsWithParenting: (elementsToAdd: Element[], commit?: boolean) => void;
    zoom: number;
    invokeProvider: InvokeAIProvider;
    setIsLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
    setProgressMessage: (message: string) => void;
    setActiveTool: (tool: any) => void;
    setAiRotationState: (state: any) => void;
    setCroppingState: (state: any) => void;
    croppingState: any;
    setContextMenu: (state: { x: number; y: number; elementId: string | null } | null) => void;
    setDrawingOptions: (updater: (prev: { strokeColor: string; strokeWidth: number; opacity: number }) => { strokeColor: string; strokeWidth: number; opacity: number }) => void;
}

export const useElementActions = ({
    elements,
    selectedElementIds,
    setSelectedElementIds,
    commitAction,
    addElementsWithParenting,
    zoom,
    invokeProvider,
    setIsLoading,
    setError,
    setProgressMessage,
    setActiveTool,
    setAiRotationState,
    setCroppingState,
    croppingState,
    setContextMenu,
    setDrawingOptions,
}: ElementActionsProps) => {

    const handleDeleteElement = useCallback((id: string) => {
        commitAction(prev => {
            const idsToDelete = new Set([id]);
            getDescendants(id, prev).forEach(desc => idsToDelete.add(desc.id));
            return prev.filter(el => !idsToDelete.has(el.id));
        });
        setSelectedElementIds(selectedElementIds.filter(selId => selId !== id));
    }, [commitAction, selectedElementIds, setSelectedElementIds]);

    const handleDeleteSelection = useCallback(() => {
        if (selectedElementIds.length === 0) return;
        commitAction(prev => {
            const idsToDelete = new Set(selectedElementIds);
            selectedElementIds.forEach(id => {
                getDescendants(id, prev).forEach(desc => idsToDelete.add(desc.id));
            });
            return prev.filter(el => !idsToDelete.has(el.id));
        });
        setSelectedElementIds([]);
    }, [selectedElementIds, commitAction, setSelectedElementIds]);

    const handleCopy = useCallback(async () => {
        if (selectedElementIds.length === 0) return;
        
        const elementsToCopy = getFlattenedSelection(selectedElementIds, elements);
        const clipboardData = {
            type: 'artflow-elements',
            elements: elementsToCopy,
        };

        try {
            await navigator.clipboard.writeText(JSON.stringify(clipboardData));
        } catch (e) {
            console.error('Failed to copy to clipboard', e);
        }
    }, [selectedElementIds, elements]);

    const handlePasteElements = useCallback((pastedElements: Element[], pasteCenter: Point) => {
        if (!pastedElements || pastedElements.length === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pastedElements.forEach(el => {
            if (el.parentId && pastedElements.some(e => e.id === el.parentId)) return; 
            const bounds = getElementBounds(el, pastedElements); 
            minX = Math.min(minX, bounds.x);
            minY = Math.min(minY, bounds.y);
            maxX = Math.max(maxX, bounds.x + bounds.width);
            maxY = Math.max(maxY, bounds.y + bounds.height);
        });

        const centerX = minX + (maxX - minX) / 2;
        const centerY = minY + (maxY - minY) / 2;

        const dx = pasteCenter.x - centerX;
        const dy = pasteCenter.y - centerY;

        const idMap = new Map<string, string>();
        pastedElements.forEach(el => idMap.set(el.id, generateId()));

        const newElements = pastedElements.map(el => {
            const newId = idMap.get(el.id)!;
            const newParentId = el.parentId ? idMap.get(el.parentId) : undefined;
            const updatedEl = { ...el, id: newId, parentId: newParentId };

            if (updatedEl.type === 'path') {
                updatedEl.points = updatedEl.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
            } else if (updatedEl.type === 'arrow' || updatedEl.type === 'line') {
                updatedEl.points = [
                    { x: updatedEl.points[0].x + dx, y: updatedEl.points[0].y + dy },
                    { x: updatedEl.points[1].x + dx, y: updatedEl.points[1].y + dy }
                ];
                updatedEl.x += dx; 
                updatedEl.y += dy;
            } else {
                updatedEl.x += dx;
                updatedEl.y += dy;
            }
            return updatedEl;
        });

        addElementsWithParenting(newElements);
        const newTopLevelIds = newElements
            .filter(el => !el.parentId || !idMap.has(pastedElements.find(e => e.id === Array.from(idMap.entries()).find(entry => entry[1] === el.id)?.[0])?.parentId || ''))
            .map(el => el.id);
        setSelectedElementIds(newTopLevelIds);

    }, [addElementsWithParenting, setSelectedElementIds]);

    const handleCopyElement = useCallback((elementToCopy: Element) => {
        commitAction(prev => {
            const elementsToCopy = [elementToCopy, ...getDescendants(elementToCopy.id, prev)];
            const idMap = new Map<string, string>();
            const newElements: Element[] = elementsToCopy.map((el: Element): Element => {
                const newId = generateId();
                idMap.set(el.id, newId);
                const dx = 20 / zoom;
                const dy = 20 / zoom;
                
                switch (el.type) {
                    case 'path':
                        return { ...el, id: newId, points: el.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
                    case 'arrow':
                    case 'line': {
                        const newPoints: [Point, Point] = [
                            { x: el.points[0].x + dx, y: el.points[0].y + dy },
                            { x: el.points[1].x + dx, y: el.points[1].y + dy }
                        ];
                        return { ...el, id: newId, x: el.x + dx, y: el.y + dy, points: newPoints };
                    }
                    case 'frame':
                        return { ...el, id: newId, x: el.x + dx, y: el.y + dy, name: `${el.name} Copy` };
                    default:
                        return { ...el, id: newId, x: el.x + dx, y: el.y + dy };
                }
            });
            const finalNewElements: Element[] = newElements.map((el: Element): Element => {
                const parentId = el.parentId ? idMap.get(el.parentId) : undefined;
                return { ...el, parentId } as Element;
            });
            setSelectedElementIds([idMap.get(elementToCopy.id)!]);
            return [...prev, ...finalNewElements];
        });
    }, [commitAction, zoom, setSelectedElementIds]);

    const handleCopySelection = useCallback(() => {
        if (selectedElementIds.length === 0) return;
        commitAction(prev => {
            const elementsToCopy: Element[] = [];
            const selectionSet = new Set(selectedElementIds);
            const topLevelSelected = prev.filter(el => selectionSet.has(el.id));
            const allDescendants = topLevelSelected.flatMap(el => getDescendants(el.id, prev));
            elementsToCopy.push(...topLevelSelected, ...allDescendants);
            const idMap = new Map<string, string>();
            const newTopLevelIds: string[] = [];
            const newElementsUnmapped = elementsToCopy.map((el): Element => {
                const newId = generateId();
                idMap.set(el.id, newId);
                if (selectionSet.has(el.id)) newTopLevelIds.push(newId);
                const dx = 20 / zoom;
                const dy = 20 / zoom;
                switch (el.type) {
                    case 'path':
                        return { ...el, id: newId, points: el.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
                    case 'arrow':
                    case 'line':
                        return { ...el, id: newId, x: el.x + dx, y: el.y + dy, points: el.points.map(p => ({ x: p.x + dx, y: p.y + dy })) as [Point, Point] };
                    case 'frame':
                        return { ...el, id: newId, x: el.x + dx, y: el.y + dy, name: `${el.name} Copy` };
                    default:
                        return { ...el, id: newId, x: el.x + dx, y: el.y + dy };
                }
            });
            const finalNewElements = newElementsUnmapped.map(el => {
                if (el.parentId && idMap.has(el.parentId)) return { ...el, parentId: idMap.get(el.parentId) };
                return el;
            }) as Element[];
            setSelectedElementIds(newTopLevelIds);
            return [...prev, ...finalNewElements];
        });
    }, [selectedElementIds, commitAction, zoom, setSelectedElementIds]);

    const handleDownloadImage = useCallback((element: ImageElement) => {
        const link = document.createElement('a');
        link.href = element.href;
        link.download = `canvas-image-${element.id}.${element.mimeType.split('/')[1] || 'png'}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }, []);

    const handleStartCrop = useCallback((element: ImageElement) => {
        setActiveTool('select');
        setAiRotationState(null);
        setCroppingState({
            elementId: element.id,
            originalElement: { ...element },
            cropBox: { x: element.x, y: element.y, width: element.width, height: element.height },
        });
    }, [setActiveTool, setAiRotationState, setCroppingState]);

    const handleCancelCrop = useCallback(() => setCroppingState(null), [setCroppingState]);

    const handleConfirmCrop = useCallback(() => {
        if (!croppingState) return;
        const { elementId, cropBox } = croppingState;
        const elementToCrop = elements.find(el => el.id === elementId) as ImageElement;
        if (!elementToCrop) { handleCancelCrop(); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = cropBox.width;
            canvas.height = cropBox.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) { setError("Failed to create canvas context for cropping."); handleCancelCrop(); return; }
            const sx = cropBox.x - elementToCrop.x;
            const sy = cropBox.y - elementToCrop.y;
            ctx.drawImage(img, sx, sy, cropBox.width, cropBox.height, 0, 0, cropBox.width, cropBox.height);
            const newHref = canvas.toDataURL(elementToCrop.mimeType);
            commitAction(prev => prev.map(el => {
                if (el.id === elementId && el.type === 'image') {
                    return { ...el, href: newHref, x: cropBox.x, y: cropBox.y, width: cropBox.width, height: cropBox.height };
                }
                return el;
            }));
            handleCancelCrop();
        };
        img.onerror = () => { setError("Failed to load image for cropping."); handleCancelCrop(); }
        img.src = elementToCrop.href;
    }, [croppingState, elements, handleCancelCrop, setError, commitAction]);

    const handleGroup = useCallback(() => {
        const selectedElements = elements.filter(el => selectedElementIds.includes(el.id));
        if (selectedElements.length < 2) return;
        const bounds = getSelectionBounds(selectedElementIds, elements);
        const newGroupId = generateId();
        const newGroup: GroupElement = {
            id: newGroupId, type: 'group', name: 'Group',
            x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, rotation: 0,
        };
        commitAction(prev => {
            const updatedElements = prev.map(el => 
                selectedElementIds.includes(el.id) ? { ...el, parentId: newGroupId } : el
            );
            return [...updatedElements, newGroup];
        });
        setSelectedElementIds([newGroupId]);
    }, [elements, selectedElementIds, commitAction, setSelectedElementIds]);

    const handleUngroup = useCallback(() => {
        if (selectedElementIds.length !== 1) return;
        const groupId = selectedElementIds[0];
        const group = elements.find(el => el.id === groupId);
        if (!group || group.type !== 'group') return;
        const childrenIds: string[] = [];
        commitAction(prev => {
            return prev.map(el => {
                if (el.parentId === groupId) {
                    childrenIds.push(el.id);
                    const { parentId, ...rest } = el;
                    return rest as Element;
                }
                return el;
            }).filter(el => el.id !== groupId);
        });
        setSelectedElementIds(childrenIds);
    }, [selectedElementIds, elements, commitAction, setSelectedElementIds]);

    const handleMergeGroup = useCallback(async () => {
        if (selectedElementIds.length !== 1) return;
        const groupId = selectedElementIds[0];
        const group = elements.find(el => el.id === groupId);
        if (!group || group.type !== 'group') return;
        setIsLoading(true);
        setProgressMessage('Merging layers...');
        setError(null);
        try {
            const allElementsMap = new Map<string, { el: Element, index: number }>(elements.map((el, index) => [el.id, { el, index }]));
            const elementsToMerge = getDescendants(groupId, elements).sort((a, b) =>
                (allElementsMap.get(a.id)?.index ?? 0) - (allElementsMap.get(b.id)?.index ?? 0)
            );
            if (elementsToMerge.length === 0) { handleDeleteElement(groupId); setIsLoading(false); return; }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            elementsToMerge.forEach(el => {
                if (el.type === 'group') return;
                const bounds = getElementBounds(el, elements);
                minX = Math.min(minX, bounds.x); minY = Math.min(minY, bounds.y);
                maxX = Math.max(maxX, bounds.x + bounds.width); maxY = Math.max(maxY, bounds.y + bounds.height);
            });
            const width = maxX - minX;
            const height = maxY - minY;
            if (width <= 0 || height <= 0) throw new Error('Group content has no dimensions.');
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Could not get canvas context.');
            for (const el of elementsToMerge) {
                if (el.type === 'group' || el.type === 'frame' || el.type === 'video') continue;
                const elBounds = getElementBounds(el, elements);
                if (elBounds.width <= 0 || elBounds.height <= 0) continue;
                await new Promise<void>((resolve, reject) => {
                    if (el.type === 'image') {
                        const img = new Image(); img.crossOrigin = 'anonymous';
                        img.onload = () => {
                            const relativeX = el.x - minX; const relativeY = el.y - minY;
                            ctx.globalAlpha = el.opacity ?? 1; ctx.drawImage(img, relativeX, relativeY, el.width, el.height);
                            ctx.globalAlpha = 1.0; resolve();
                        };
                        img.onerror = reject; img.src = el.href;
                    } else {
                        rasterizeElement(el).then(({ href }) => {
                            const img = new Image(); img.crossOrigin = 'anonymous';
                            img.onload = () => {
                                const relativeX = elBounds.x - minX - 10; const relativeY = elBounds.y - minY - 10;
                                ctx.drawImage(img, relativeX, relativeY); resolve();
                            };
                            img.onerror = reject; img.src = href;
                        }).catch(reject);
                    }
                });
            }
            const mergedImageHref = canvas.toDataURL('image/png');
            const newImage: ImageElement = {
                id: generateId(), type: 'image', name: `${group.name || 'Group'} Merged`,
                x: minX, y: minY, width, height, href: mergedImageHref, mimeType: 'image/png', rotation: 0,
            };
            const idsToRemove = new Set(elementsToMerge.map(e => e.id).concat(groupId));
            commitAction(prev => {
                const remainingElements = prev.filter(el => !idsToRemove.has(el.id));
                return [...remainingElements, newImage];
            });
            setSelectedElementIds([newImage.id]);
        } catch (err) {
            const error = err as Error; setError(`Failed to merge group: ${error.message}`);
        } finally { setIsLoading(false); setProgressMessage(''); }
    }, [selectedElementIds, elements, setIsLoading, setProgressMessage, setError, handleDeleteElement, commitAction, setSelectedElementIds]);

    const handleMasonryLayout = useCallback(() => {
        if (selectedElementIds.length < 2) return;

        commitAction(prev => {
            const assetsToArrange = prev.filter((el): el is ImageElement | VideoElement | ShapeElement => 
                selectedElementIds.includes(el.id) && 
                (el.type === 'image' || el.type === 'video' || el.type === 'shape')
            );
            if (assetsToArrange.length < 2) return prev;

            // 增加排序：按当前在画布上的大概位置排序（从上到下，从左到右）
            assetsToArrange.sort((a, b) => (a.y + a.x / 10) - (b.y + b.x / 10));

            const GAP = 15;
            const assetCount = assetsToArrange.length;
            const colCount = Math.max(1, Math.ceil(Math.sqrt(assetCount)));
            
            // 使用选择物品的平均宽度作为列宽
            const avgWidth = assetsToArrange.reduce((sum, el) => sum + (el.width || 400), 0) / assetCount;
            const COLUMN_WIDTH = Math.min(600, Math.max(250, avgWidth));

            const colHeights = new Array(colCount).fill(0);
            const selectionBounds = getSelectionBounds(selectedElementIds, prev);
            const anchorPoint = { x: selectionBounds.x + selectionBounds.width / 2, y: selectionBounds.y + selectionBounds.height / 2 };

            const updates = new Map<string, { x: number, y: number, w: number, h: number }>();
            
            assetsToArrange.forEach(asset => {
                const minH = Math.min(...colHeights);
                const colIdx = colHeights.indexOf(minH);
                
                const scale = COLUMN_WIDTH / asset.width;
                const scaledH = asset.height * scale;

                updates.set(asset.id, {
                    x: colIdx * (COLUMN_WIDTH + GAP),
                    y: colHeights[colIdx],
                    w: COLUMN_WIDTH,
                    h: scaledH
                });

                colHeights[colIdx] += scaledH + GAP;
            });

            const totalW = colCount * COLUMN_WIDTH + (colCount - 1) * GAP;
            const totalH = Math.max(...colHeights) - GAP;
            const offsetX = anchorPoint.x - totalW / 2;
            const offsetY = anchorPoint.y - totalH / 2;

            return prev.map(el => {
                const up = updates.get(el.id);
                if (up) {
                    // 类型安全地更新
                    return { ...el, x: offsetX + up.x, y: offsetY + up.y, width: up.w, height: up.h } as Element;
                }
                return el;
            });
        });
    }, [selectedElementIds, commitAction]);

    const handleAutoCombine = useCallback(async () => {
        if (selectedElementIds.length < 2) return;
        setIsLoading(true); setError(null); setProgressMessage('Combining elements...');
        try {
            const flattenedSelection = getFlattenedSelection(selectedElementIds, elements);
            const elementsToProcess = flattenedSelection.filter(el => el.type !== 'video' && el.type !== 'frame' && el.type !== 'group');
            const imagePromises = elementsToProcess.map(el => {
                if (el.type === 'image') return Promise.resolve({ href: el.href, mimeType: el.mimeType });
                return rasterizeElement(el as Exclude<Element, ImageElement | VideoElement | FrameElement | GroupElement>);
            });
            const imagesToProcess = await Promise.all(imagePromises);
            const response = await invokeProvider({
                prompt: 'Combine these elements into a single cohesive, realistic image.',
                referenceImages: imagesToProcess.map(item => item.href),
                parameters: { op: 'image-to-image' },
            });
            const [generated] = imageArtifacts(response);
            if (generated) {
                const img = new Image();
                img.onload = () => {
                    const selectionBounds = getSelectionBounds(selectedElementIds, elements);
                    const PADDING = 20 / zoom;
                    const newImage: ImageElement = {
                        id: generateId(), type: 'image', name: 'Combined Image',
                        x: selectionBounds.x + selectionBounds.width + PADDING,
                        y: selectionBounds.y + (selectionBounds.height / 2) - (img.height / 2),
                        width: img.width, height: img.height,
                        href: generated.href, mimeType: generated.mimeType, rotation: 0,
                    };
                    addElementsWithParenting([newImage]); setSelectedElementIds([newImage.id]);
                };
                img.src = generated.href;
            } else { setError(textArtifact(response) || 'Failed to combine elements.'); }
        } catch (err) { const error = err as Error; setError(`Failed to combine: ${error.message}`); console.error(err); }
        finally { setIsLoading(false); setProgressMessage(''); }
    }, [selectedElementIds, elements, setIsLoading, setError, setProgressMessage, invokeProvider, zoom, addElementsWithParenting, setSelectedElementIds]);

    const handleAlignSelection = useCallback((alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
        const selectedElements = elements.filter(el => selectedElementIds.includes(el.id));
        if (selectedElements.length < 2) return;
        const bounds = getSelectionBounds(selectedElementIds, elements);
        const { x: minX, y: minY, width, height } = bounds;
        const maxX = minX + width; const maxY = minY + height;
        const selectionCenterX = minX + width / 2; const selectionCenterY = minY + height / 2;
        commitAction(prev => {
            const elementsToUpdate = new Map<string, { dx: number; dy: number }>();
            selectedElements.forEach(el => {
                const bounds = getElementBounds(el, prev);
                let dx = 0; let dy = 0;
                switch (alignment) {
                    case 'left':   dx = minX - bounds.x; break;
                    case 'center': dx = selectionCenterX - (bounds.x + bounds.width / 2); break;
                    case 'right':  dx = maxX - (bounds.x + bounds.width); break;
                    case 'top':    dy = minY - bounds.y; break;
                    case 'middle': dy = selectionCenterY - (bounds.y + bounds.height / 2); break;
                    case 'bottom': dy = maxY - (bounds.y + bounds.height); break;
                }
                if (dx !== 0 || dy !== 0) {
                    const elementsToMove = [el, ...getDescendants(el.id, prev)];
                    elementsToMove.forEach(elementToMove => { if (!elementsToUpdate.has(elementToMove.id)) elementsToUpdate.set(elementToMove.id, { dx, dy }); });
                }
            });
            return prev.map(el => {
                const update = elementsToUpdate.get(el.id);
                if (update) {
                    if (el.type === 'path') return { ...el, points: el.points.map(p => ({ x: p.x + update.dx, y: p.y + update.dy })) };
                    if (el.type === 'arrow' || el.type === 'line') return { ...el, x: el.x + update.dx, y: el.y + update.dy, points: el.points.map(p => ({ x: p.x + update.dx, y: p.y + update.dy })) as [Point, Point] };
                    return { ...el, x: el.x + update.dx, y: el.y + update.dy };
                }
                return el;
            });
        });
    }, [elements, selectedElementIds, commitAction]);

    const handlePropertyChange = useCallback((elementId: string, updates: Partial<Element>) => {
        commitAction(prev => prev.map((el): Element => { if (el.id === elementId) return { ...el, ...updates } as Element; return el; }));
    }, [commitAction]);

    const handleSelectionPropertyChange = useCallback((updates: { [key: string]: any }) => {
        commitAction(prev => {
            const selectionSet = new Set(selectedElementIds);
            return prev.map((el): Element => {
                if (selectionSet.has(el.id)) {
                    if ('borderRadius' in updates && (el.type === 'image' || (el.type === 'shape' && el.shapeType === 'rectangle'))) {
                        return { ...el, borderRadius: updates.borderRadius } as ImageElement | ShapeElement;
                    }
                    return el;
                }
                return el;
            });
        });
    }, [selectedElementIds, commitAction]);

    const handleLayerAction = useCallback((elementId: string, action: 'front' | 'back' | 'forward' | 'backward') => {
        commitAction(prev => {
            const elementsCopy = [...prev];
            const index = elementsCopy.findIndex(el => el.id === elementId);
            if (index === -1) return elementsCopy;
            const [element] = elementsCopy.splice(index, 1);
            if (action === 'front') elementsCopy.push(element);
            else if (action === 'back') elementsCopy.unshift(element);
            else if (action === 'forward') { const newIndex = Math.min(elementsCopy.length, index + 1); elementsCopy.splice(newIndex, 0, element); }
            else if (action === 'backward') { const newIndex = Math.max(0, index - 1); elementsCopy.splice(newIndex, 0, element); }
            return elementsCopy;
        });
        setContextMenu(null);
    }, [commitAction, setContextMenu]);

    const handleReorderElements = useCallback((draggedId: string, targetId: string, position: 'before' | 'after') => {
        commitAction(prev => {
            const elementsCopy = [...prev];
            const draggedIndex = elementsCopy.findIndex(el => el.id === draggedId);
            if (draggedIndex === -1) return prev;
            const [element] = elementsCopy.splice(draggedIndex, 1);
            const targetIndex = elementsCopy.findIndex(el => el.id === targetId);
            if (targetIndex === -1) { elementsCopy.push(element); return elementsCopy; }
            const finalIndex = position === 'before' ? targetIndex : targetIndex + 1;
            elementsCopy.splice(finalIndex, 0, element);
            return elementsCopy;
        });
    }, [commitAction]);

    const handleSetActiveTool = useCallback((tool: any) => {
        setActiveTool(tool); setAiRotationState(null);
        if (tool === 'highlighter') setDrawingOptions(o => ({...o, opacity: 0.5}));
        else if (tool === 'draw') setDrawingOptions(o => ({...o, opacity: 1.0}));
    }, [setActiveTool, setAiRotationState, setDrawingOptions]);

    const handleFrameAspectRatioChange = useCallback((frameId: string, aspectRatio: string) => {
        const frame = elements.find(el => el.id === frameId && el.type === 'frame') as FrameElement;
        if (!frame) return;
        const [w, h] = aspectRatio.split(':').map(Number);
        const targetRatio = w / h;
        const currentWidth = frame.width; const currentHeight = frame.height;
        const currentRatio = currentWidth / currentHeight;
        const centerX = frame.x + currentWidth / 2; const centerY = frame.y + currentHeight / 2;
        let newWidth, newHeight;
        if (currentRatio > targetRatio) { newWidth = currentHeight * targetRatio; newHeight = currentHeight; }
        else { newHeight = currentWidth / targetRatio; newWidth = currentWidth; }
        const newX = centerX - newWidth / 2; const newY = centerY - newHeight / 2;
        commitAction(prev => prev.map(el => {
            if (el.id === frameId && el.type === 'frame') return { ...el, width: newWidth, height: newHeight, x: newX, y: newY };
            return el;
        }));
    }, [elements, commitAction]);

    const handleStartAIRotate = useCallback(() => {
        const singleSelectedElement = selectedElementIds.length === 1 ? elements.find(el => el.id === selectedElementIds[0]) : null;
        if (singleSelectedElement && singleSelectedElement.type === 'image') {
            const element = singleSelectedElement;
            const bounds = getElementBounds(element, elements);
            setAiRotationState({
                element, center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
                currentAngle: 0, dragDirection: null,
            });
            setSelectedElementIds([]); setCroppingState(null);
        }
    }, [selectedElementIds, elements, setAiRotationState, setSelectedElementIds, setCroppingState]);

    const handleStopEditing = useCallback((editingElement: { id: string; text: string } | null, setEditingElement: (el: { id: string; text: string } | null) => void) => {
        if (!editingElement) return;
        commitAction(prev => prev.map(el => {
            if (el.id === editingElement.id) {
                if (el.type === 'text') return { ...el, text: editingElement.text };
                if (el.type === 'frame') return { ...el, name: editingElement.text || 'Frame' };
            }
            return el;
        }));
        setEditingElement(null);
    }, [commitAction]);

    // parent 可见性用 Map 查（原实现每层 allElements.find 是 O(N)，在热路径上会被放大）。
    const visibleParentLookupRef = useRef<{ elements: Element[]; byId: Map<string, Element> } | null>(null);

    const isElementVisible = useCallback((element: Element, allElements: Element[]): boolean => {
        if (element.isVisible === false) return false;
        let parentId = element.parentId;
        if (!parentId) return true;
        let lookup = visibleParentLookupRef.current;
        if (!lookup || lookup.elements !== allElements) {
            lookup = { elements: allElements, byId: new Map(allElements.map(el => [el.id, el])) };
            visibleParentLookupRef.current = lookup;
        }
        const visited = new Set<string>();
        while (parentId) {
            if (visited.has(parentId)) return true; // 依赖成环时保持旧的"继续向上找不到就可见"结果
            visited.add(parentId);
            const parent = lookup.byId.get(parentId);
            if (!parent) return true;
            if (parent.isVisible === false) return false;
            parentId = parent.parentId;
        }
        return true;
    }, []);

    return {
        handleDeleteElement,
        handleDeleteSelection,
        handleCopyElement,
        handleCopySelection,
        handleCopy,
        handlePasteElements,
        handleDownloadImage,
        handleStartCrop,
        handleCancelCrop,
        handleConfirmCrop,
        handleGroup,
        handleUngroup,
        handleMergeGroup,
        handleAutoCombine,
        handleAlignSelection,
        handlePropertyChange,
        handleSelectionPropertyChange,
        handleLayerAction,
        handleReorderElements,
        handleSetActiveTool,
        handleFrameAspectRatioChange,
        handleStartAIRotate,
        handleStopEditing,
        handleMasonryLayout,
        isElementVisible,
    };
};
