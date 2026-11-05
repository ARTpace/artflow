
import React, { useState, useEffect, useCallback } from 'react';
import type { Element, Rect } from '../types';
import { getSelectionBounds, getCanvasScreenRect } from '../utils/canvasUtils';

interface SmartToolbarProps {
    selectedElementIds: string[];
    elements: Element[];
    zoom: number;
    panOffset: { x: number; y: number };
    croppingState: any;
    editingElement: any;
    aiRotationState: any;
    svgRef: React.RefObject<SVGSVGElement>;
}

export const useSmartToolbar = ({
    selectedElementIds,
    elements,
    zoom,
    panOffset,
    croppingState,
    editingElement,
    aiRotationState,
    svgRef,
}: SmartToolbarProps) => {
    const [smartToolbarState, setSmartToolbarState] = useState<{
        top: number;
        left: number;
        show: boolean;
        selectionType: 'single-image' | 'multi-image' | 'none';
    }>({ top: 0, left: 0, show: false, selectionType: 'none' });

    useEffect(() => {
        if (selectedElementIds.length > 0 && !croppingState && !editingElement && !aiRotationState) {
            const selectionHasImages = elements.some(
                el => selectedElementIds.includes(el.id) && el.type === 'image'
            );
    
            if (selectionHasImages) {
                const bounds = getSelectionBounds(selectedElementIds, elements);
                const svgBounds = getCanvasScreenRect(svgRef.current);
                if (!svgBounds) {
                    setSmartToolbarState(prev => ({ ...prev, show: false }));
                    return;
                }
    
                const screenRight = (bounds.x + bounds.width) * zoom + panOffset.x + svgBounds.left;
                const screenCenterY = bounds.y * zoom + panOffset.y + (bounds.height * zoom / 2) + svgBounds.top;
    
                let type: 'single-image' | 'multi-image' | 'none' = 'none';
                if (selectedElementIds.length === 1 && elements.find(el => el.id === selectedElementIds[0])?.type === 'image') {
                    type = 'single-image';
                } else if (selectedElementIds.length > 1) {
                    type = 'multi-image';
                }
    
                if (type !== 'none') {
                    setSmartToolbarState({
                        top: screenCenterY,
                        left: screenRight + 10,
                        show: true,
                        selectionType: type,
                    });
                } else {
                    setSmartToolbarState(prev => ({ ...prev, show: false }));
                }
            } else {
                setSmartToolbarState(prev => ({ ...prev, show: false }));
            }
        } else {
            setSmartToolbarState(prev => ({ ...prev, show: false }));
        }
    }, [selectedElementIds, elements, zoom, panOffset, croppingState, editingElement, aiRotationState, svgRef]);

    return { smartToolbarState, setSmartToolbarState };
};
