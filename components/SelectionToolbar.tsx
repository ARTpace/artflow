import React from 'react';
import { Element } from '../types';

interface SelectionToolbarProps {
    zoom: number;
    selectedElementIds: string[];
    elements: Element[];
    handleCopySelection: () => void;
    handleGroup: () => void;
    handleRasterizeSelection: () => void;
    handleSelectionPropertyChange: (props: Partial<Element>) => void;
    handleAlignSelection: (alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
    handleMasonryLayout: () => void;
    // Updated t signature to match useSettings hook for better type compatibility
    t: (key: string, ...args: any[]) => any;
}

/**
 * Single source of truth for the multi-selection toolbar footprint (screen px).
 * ToolbarOverlay uses it to size the foreignObject hit area, so the toolbar's
 * pointer-blocking box always matches the visible toolbar instead of the whole canvas.
 */
export const getSelectionToolbarScreenSize = (selectedElements: Element[]): { width: number; height: number } => {
    const hasRasterizableElements = selectedElements.some(el => {
        switch (el.type) {
            case 'image':
            case 'video':
            case 'audio':
            case 'group':
            case 'frame':
                return false;
            default:
                return true;
        }
    });

    const hasArrangeableElements = selectedElements.some(el =>
        el.type === 'image' || el.type === 'video' || el.type === 'audio' || el.type === 'shape'
    );

    const hasBorderRadiusElements = selectedElements.some(el => el.type === 'image' || (el.type === 'shape' && el.shapeType === 'rectangle'));

    let width = 323;
    if (hasRasterizableElements) width += 36;
    if (hasBorderRadiusElements) width += 156;
    if (hasArrangeableElements) width += 36;

    return { width, height: 48 };
};

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
    zoom,
    selectedElementIds,
    elements,
    handleCopySelection,
    handleGroup,
    handleRasterizeSelection,
    handleSelectionPropertyChange,
    handleAlignSelection,
    handleMasonryLayout,
    t,
}) => {
    const selectedElements = elements.filter(el => selectedElementIds.includes(el.id));
    const hasRasterizableElements = selectedElements.some(el => {
        switch (el.type) {
            case 'image':
            case 'video':
            case 'audio':
            case 'group':
            case 'frame':
                return false;
            default:
                return true;
        }
    });

    const hasArrangeableElements = selectedElements.some(el => 
        el.type === 'image' || el.type === 'video' || el.type === 'audio' || el.type === 'shape'
    );

    const hasBorderRadiusElements = selectedElements.some(el => el.type === 'image' || (el.type === 'shape' && el.shapeType === 'rectangle'));

    const { width: toolbarScreenWidth, height: toolbarScreenHeight } = getSelectionToolbarScreenSize(selectedElements);

    return (
        <div
            style={{ 
                transform: `scale(${1 / zoom})`, 
                transformOrigin: 'top left', 
                width: `${toolbarScreenWidth}px`, 
                height: `${toolbarScreenHeight}px` 
            }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div style={{ backgroundColor: 'var(--ui-bg-color)' }} data-bp-ui-surface="" className="h-full p-1 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl flex items-center justify-center gap-1 text-white">
                <button title={t('contextMenu.copy')} onClick={handleCopySelection} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                </button>
                <button title={t('contextMenu.group')} onClick={handleGroup} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                </button>
                {hasArrangeableElements && (
                    <button title={t('contextMenu.masonryLayout')} onClick={handleMasonryLayout} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="12" rx="1"/>
                            <rect x="14" y="3" width="7" height="8" rx="1"/>
                            <rect x="14" y="14" width="7" height="7" rx="1"/>
                            <rect x="3" y="18" width="7" height="3" rx="1"/>
                        </svg>
                    </button>
                )}
                {hasRasterizableElements && (
                    <button title={t('contextMenu.rasterize')} onClick={handleRasterizeSelection} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m3 16 7-7"/><path d="m21 3-7.873 7.873a4 4 0 0 0-1.127 2.828V22"/>
                        </svg>
                    </button>
                )}
                {hasBorderRadiusElements && (
                    <>
                        <div className="h-5 w-px bg-white/20"></div>
                        <div title={t('contextMenu.borderRadius')} className="flex items-center gap-1 p-1">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
                                <path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M16 4h4a1 1 0 0 1 1 1v4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M16 20h4a1 1 0 0 0 1-1v-4"/>
                            </svg>
                            <input type="range" min="0" max="200" defaultValue="0" onChange={e => handleSelectionPropertyChange({ borderRadius: parseInt(e.target.value, 10) })} className="w-12 accent-blue-500" />
                            <input type="number" min="0" defaultValue="0" onBlur={e => handleSelectionPropertyChange({ borderRadius: parseInt(e.target.value, 10) || 0 })} className="w-14 p-0.5 text-xs text-center border border-white/20 rounded bg-black/20 text-white"/>
                        </div>
                    </>
                )}
                <div className="h-5 w-px bg-white/20"></div>
                <button title={t('contextMenu.alignment.alignLeft')} onClick={() => handleAlignSelection('left')} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="4" y1="21" x2="4" y2="3"></line><rect x="8" y="6" width="8" height="4" rx="1"></rect><rect x="8" y="14" width="12" height="4" rx="1"></rect>
                    </svg>
                </button>
                <button title={t('contextMenu.alignment.alignCenter')} onClick={() => handleAlignSelection('center')} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="21" x2="12" y2="3"></line><rect x="4" y="6" width="16" height="4" rx="1"></rect><rect x="6" y="14" width="12" height="4" rx="1"></rect>
                    </svg>
                </button>
                <button title={t('contextMenu.alignment.alignRight')} onClick={() => handleAlignSelection('right')} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="20" y1="21" x2="20" y2="3"></line><rect x="8" y="6" width="8" height="4" rx="1"></rect><rect x="4" y="14" width="12" height="4" rx="1"></rect>
                    </svg>
                </button>
                <div className="h-5 w-px bg-white/20"></div>
                <button title={t('contextMenu.alignment.alignTop')} onClick={() => handleAlignSelection('top')} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="3" y1="4" x2="21" y2="4"></line><rect x="6" y="8" width="4" height="8" rx="1"></rect><rect x="14" y="8" width="4" height="12" rx="1"></rect>
                    </svg>
                </button>
                <button title={t('contextMenu.alignment.alignMiddle')} onClick={() => handleAlignSelection('middle')} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="3" y1="12" x2="21" y2="12"></line><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="6" width="4" height="12" rx="1"></rect>
                    </svg>
                </button>
                <button title={t('contextMenu.alignment.alignBottom')} onClick={() => handleAlignSelection('bottom')} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="3" y1="20" x2="21" y2="20"></line><rect x="6" y="8" width="4" height="8" rx="1"></rect><rect x="14" y="4" width="4" height="12" rx="1"></rect>
                    </svg>
                </button>
            </div>
        </div>
    );
};