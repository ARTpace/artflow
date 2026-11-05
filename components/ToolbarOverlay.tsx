import React from 'react';
import { Element, ImageElement, Rect } from '../types';
import { getElementBounds, getSelectionBounds } from '../utils/canvasUtils';
import { SelectionToolbar, getSelectionToolbarScreenSize } from './SelectionToolbar';
import { ElementToolbar } from './ElementToolbar';

interface ToolbarOverlayProps {
    zoom: number;
    selectedElementIds: string[];
    elements: Element[];
    singleSelectedElement: Element | null;
    croppingState: any;
    editingElement: any;
    aiRotationState: any;
    handleCopySelection: () => void;
    handleGroup: () => void;
    handleRasterizeSelection: () => void;
    handleSelectionPropertyChange: (updates: { [key: string]: any }) => void;
    handleAlignSelection: (alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
    handleMasonryLayout: () => void;
    handleCopyElement: (el: Element) => void;
    handleFrameAspectRatioChange: (id: string, ratio: string) => void;
    handleUngroup: () => void;
    handleMergeGroup: () => void;
    handleDownloadImage: (el: ImageElement) => void;
    handleStartCrop: (el: ImageElement) => void;
    handlePropertyChange: (id: string, updates: Partial<Element>) => void;
    handleDeleteElement: (id: string) => void;
    // Updated t signature to match useSettings hook for better type compatibility
    t: (key: string, ...args: any[]) => any;
}

export const ToolbarOverlay: React.FC<ToolbarOverlayProps> = ({
    zoom,
    selectedElementIds,
    elements,
    singleSelectedElement,
    croppingState,
    editingElement,
    aiRotationState,
    handleCopySelection,
    handleGroup,
    handleRasterizeSelection,
    handleSelectionPropertyChange,
    handleAlignSelection,
    handleMasonryLayout,
    handleCopyElement,
    handleFrameAspectRatioChange,
    handleUngroup,
    handleMergeGroup,
    handleDownloadImage,
    handleStartCrop,
    handlePropertyChange,
    handleDeleteElement,
    t,
}) => {
    if (selectedElementIds.length === 0 || croppingState || editingElement || aiRotationState) {
        return null;
    }

    if (selectedElementIds.length > 1) {
        const bounds = getSelectionBounds(selectedElementIds, elements);
        const selectedElements = elements.filter(el => selectedElementIds.includes(el.id));
        const { width: toolbarScreenWidth, height: toolbarScreenHeight } = getSelectionToolbarScreenSize(selectedElements);
        const toolbarCanvasWidth = toolbarScreenWidth / zoom;
        const toolbarCanvasHeight = toolbarScreenHeight / zoom;
        const x = bounds.x + bounds.width / 2 - toolbarCanvasWidth / 2;
        const y = bounds.y - toolbarCanvasHeight - (10 / zoom);

        return (
            <g transform={`translate(${x}, ${y})`}>
                {/* Hit area must cover only the toolbar itself: a percentage-sized foreignObject
                    would span the whole viewport and swallow clicks on every element it covers. */}
                <foreignObject width={toolbarCanvasWidth} height={toolbarCanvasHeight} style={{ overflow: 'visible' }}>
                    <SelectionToolbar
                        zoom={zoom}
                        selectedElementIds={selectedElementIds}
                        elements={elements}
                        handleCopySelection={handleCopySelection}
                        handleGroup={handleGroup}
                        handleRasterizeSelection={handleRasterizeSelection}
                        handleSelectionPropertyChange={handleSelectionPropertyChange}
                        handleAlignSelection={handleAlignSelection}
                        handleMasonryLayout={handleMasonryLayout}
                        t={t}
                    />
                </foreignObject>
            </g>
        );
    } else if (singleSelectedElement) {
        const element = singleSelectedElement;
        const bounds = getElementBounds(element, elements);
        
        // Calculate toolbar dimensions for foreignObject
        let toolbarScreenWidth = 120; // Default
        if (element.type === 'shape') {
            toolbarScreenWidth = 502 + 37 + (element.shapeType === 'rectangle' ? 156 : 0);
        } else if (element.type === 'text') {
            toolbarScreenWidth = 178 + 37;
        } else if (element.type === 'arrow' || element.type === 'line') {
            toolbarScreenWidth = 251 + 37;
        } else if (element.type === 'image') {
            toolbarScreenWidth = 315 + 156;
        } else if (element.type === 'video') {
            toolbarScreenWidth = 115;
        } else if (element.type === 'group') {
            toolbarScreenWidth = 160;
        } else if (element.type === 'path') {
            toolbarScreenWidth = 331 + 37;
        } else if (element.type === 'frame') {
            toolbarScreenWidth = 270;
        }

        const isMedia = ['image', 'video', 'audio'].includes(element.type);
        // Keep selected-media actions inside the picture, including small cards at low zoom.
        if (isMedia) toolbarScreenWidth = element.type === 'image' ? 192 : 112;
        const toolbarZoom = isMedia ? Math.max(zoom, (toolbarScreenWidth + 16) / Math.max(bounds.width, 1), 56 / Math.max(bounds.height, 1)) : zoom;
        const toolbarScreenHeight = isMedia ? 40 : 48;
        const toolbarCanvasWidth = toolbarScreenWidth / toolbarZoom;
        const toolbarCanvasHeight = toolbarScreenHeight / toolbarZoom;
        
        const x = isMedia ? bounds.x + bounds.width - toolbarCanvasWidth - 8 / toolbarZoom : bounds.x + bounds.width / 2 - (toolbarCanvasWidth / 2);
        const y = isMedia ? bounds.y + 8 / toolbarZoom : bounds.y - toolbarCanvasHeight - (35 / zoom);

        return (
            <foreignObject x={x} y={y} width={toolbarCanvasWidth} height={toolbarCanvasHeight} style={{ overflow: 'visible' }}>
                <ElementToolbar
                    zoom={toolbarZoom}
                    element={element}
                    handleCopyElement={handleCopyElement}
                    handleFrameAspectRatioChange={handleFrameAspectRatioChange}
                    handleUngroup={handleUngroup}
                    handleMergeGroup={handleMergeGroup}
                    handleDownloadImage={handleDownloadImage as any}
                    handleStartCrop={handleStartCrop as any}
                    handlePropertyChange={handlePropertyChange}
                    handleDeleteElement={handleDeleteElement}
                    t={t}
                />
            </foreignObject>
        );
    }

    return null;
};