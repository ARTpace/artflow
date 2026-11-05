import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import type { Element, FrameElement } from '../types';
import { flattenLayerElements, getVirtualRowWindow } from '../utils/layerPanelModel';

const PANEL_ROW_HEIGHT = 34;
const PANEL_ROW_OVERSCAN = 8;
const PANEL_FALLBACK_VIEWPORT_HEIGHT = 480;

interface SidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    activeTab: 'layers' | 'frames';
    setActiveTab: (tab: 'layers' | 'frames') => void;
    elements: Element[];
    selectedElementIds: string[];
    onSelectElement: (id: string | null) => void;
    onToggleVisibility: (id: string) => void;
    onToggleLock: (id: string) => void;
    onRenameElement: (id: string, name: string) => void;
    onReorder: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
    frames: FrameElement[];
    onSelectFrame: (id: string) => void;
    onDeleteFrame: (id: string) => void;
    // Updated t signature to match useSettings hook for better type compatibility
    t: (key: string, ...args: any[]) => any;
}


const getElementIcon = (element: Element): React.ReactNode => {
    const commonProps = {
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2",
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
    };

    switch (element.type) {
        case 'image': 
            return <svg {...commonProps}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>;
        case 'video': 
            return <svg {...commonProps}><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/></svg>;
        case 'audio':
            return <svg {...commonProps}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
        case 'markdown':
            return <svg {...commonProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>;
        case 'code':
            return <svg {...commonProps}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
        case 'bookmark':
            return <svg {...commonProps}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>;
        case 'font':
            return <svg {...commonProps}><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>;
        case 'model3d':
            return <svg {...commonProps}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>;
        case 'file':
            return <svg {...commonProps}><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>;
        case 'text': 
            return <svg {...commonProps}><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>;
        case 'shape':
            switch (element.shapeType) {
                case 'rectangle': return <svg {...commonProps}><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /></svg>;
                case 'circle': return <svg {...commonProps}><circle cx="12" cy="12" r="10" /></svg>;
                case 'triangle': return <svg {...commonProps}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>;
            }
            break;
        case 'group': 
            return <svg {...commonProps}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>;
        case 'frame': 
            return <svg {...commonProps} strokeDasharray="2 4"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>;
        case 'path': 
            return <svg {...commonProps}><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>;
        case 'arrow': 
            return <svg {...commonProps}><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>;
        case 'line': 
            return <svg {...commonProps}><line x1="5" y1="19" x2="19" y2="5"></line></svg>;
        default: 
            return <svg {...commonProps}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>;
    }
    return <svg {...commonProps}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>;
};

const LayerItem: React.FC<{
    element: Element;
    level: number;
    isSelected: boolean;
    onSelect: () => void;
    onToggleVisibility: () => void;
    onToggleLock: () => void;
    onRename: (name: string) => void;
    onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
    onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
}> = ({ element, level, isSelected, onSelect, onToggleVisibility, onToggleLock, onRename, ...dragProps }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [name, setName] = useState(element.name || element.type);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setName(element.name || element.type);
    }, [element.name, element.type]);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);
    
    const handleBlur = () => {
        setIsEditing(false);
        if (name.trim() === '') {
            setName(element.name || element.type);
        } else {
            onRename(name);
        }
    };
    
    const iconProps = {
        width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", 
        stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" as const, strokeLinejoin: "round" as const
    };

    return (
        <div
            draggable
            {...dragProps}
            onClick={onSelect}
            onDoubleClick={() => setIsEditing(true)}
            className={`flex h-full items-center space-x-2 p-1.5 rounded-md cursor-pointer text-sm transition-colors group ${
                isSelected ? '' : 'hover:bg-[var(--ui-hover)]'
            } ${element.isVisible === false ? 'opacity-50' : ''}`}
            style={{ paddingLeft: `${10 + level * 20}px`, ...(isSelected ? { backgroundColor: 'var(--bp-accent-soft)', boxShadow: 'inset 2px 0 0 var(--bp-accent)' } : {}) }}
        >
            <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-gray-400">{getElementIcon(element)}</span>
            {isEditing ? (
                <input
                    ref={inputRef}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={handleBlur}
                    onKeyDown={(e) => e.key === 'Enter' && handleBlur()}
                    className="flex-grow bg-transparent border-b border-[var(--bp-accent)] outline-none text-[var(--ui-text)]"
                    onClick={e => e.stopPropagation()}
                />
            ) : (
                <span className="flex-grow truncate">{name}</span>
            )}
            <div className="flex-shrink-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleLock(); }}
                    className={`p-1 rounded-full hover:bg-white/20 ${element.isLocked ? 'text-[var(--ui-text)]' : 'text-[var(--bp-text-muted)]'}`}
                    title={element.isLocked ? "Unlock" : "Lock"}
                >
                    {element.isLocked ? 
                        <svg {...iconProps}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> : 
                        <svg {...iconProps}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>
                    }
                </button>
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleVisibility(); }}
                    className="p-1 rounded-full hover:bg-white/20 text-gray-400"
                    title={element.isVisible === false ? "Show" : "Hide"}
                >
                    {element.isVisible === false ? 
                        <svg {...iconProps}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg> : 
                        <svg {...iconProps}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    }
                </button>
            </div>
        </div>
    );
};

export const LayerPanel: React.FC<SidePanelProps> = ({ 
    isOpen, onClose, activeTab, setActiveTab,
    elements, selectedElementIds, onSelectElement, onToggleVisibility, onToggleLock, onRenameElement, onReorder,
    frames, onSelectFrame, onDeleteFrame, t
}) => {
    const [, setDragOverId] = useState<string | null>(null);
    const listViewportRef = useRef<HTMLDivElement>(null);
    const [viewportHeight, setViewportHeight] = useState(PANEL_FALLBACK_VIEWPORT_HEIGHT);
    const [layerScrollTop, setLayerScrollTop] = useState(0);
    const [frameScrollTop, setFrameScrollTop] = useState(0);

    const flattenedLayers = useMemo(() => flattenLayerElements(elements), [elements]);
    const layerWindow = useMemo(() => getVirtualRowWindow(
        flattenedLayers.length,
        layerScrollTop,
        viewportHeight,
        PANEL_ROW_HEIGHT,
        PANEL_ROW_OVERSCAN,
    ), [flattenedLayers.length, layerScrollTop, viewportHeight]);
    const frameWindow = useMemo(() => getVirtualRowWindow(
        frames.length,
        frameScrollTop,
        viewportHeight,
        PANEL_ROW_HEIGHT,
        PANEL_ROW_OVERSCAN,
    ), [frames.length, frameScrollTop, viewportHeight]);
    const visibleLayerRows = flattenedLayers.slice(layerWindow.start, layerWindow.end);
    const visibleFrames = frames.slice(frameWindow.start, frameWindow.end);

    useLayoutEffect(() => {
        if (!isOpen) return;
        const viewport = listViewportRef.current;
        if (!viewport) return;
        const measure = () => {
            const next = viewport.clientHeight || PANEL_FALLBACK_VIEWPORT_HEIGHT;
            setViewportHeight(previous => previous === next ? previous : next);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [activeTab, isOpen]);

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const target = e.currentTarget;
        const id = target.getAttribute('data-id');
        setDragOverId(id);
        target.style.background = 'rgba(255,255,255,0.2)';
    };
    
    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.currentTarget.style.background = '';
        setDragOverId(null);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetId: string) => {
        e.preventDefault();
        e.currentTarget.style.background = '';
        setDragOverId(null);
        const draggedId = e.dataTransfer.getData('text/plain');

        const rect = e.currentTarget.getBoundingClientRect();
        const position = e.clientY - rect.top > rect.height / 2 ? 'after' : 'before';

        if (draggedId && targetId && draggedId !== targetId) {
            onReorder(draggedId, targetId, position);
        }
    };


    if (!isOpen) return null;

    return (
        <div 
            data-bp-layer-panel=""
            data-bp-ui-floating-shell="" className="absolute right-4 top-16 z-20 flex h-[min(40rem,calc(100vh-8rem))] w-64 flex-col overflow-hidden rounded-[18px] border border-[var(--ui-border)] text-[var(--ui-text)]"
            style={{ backgroundColor: 'var(--ui-bg-color)' }}
        >
            <div className="flex-shrink-0 flex justify-between items-center p-3 border-b border-[var(--ui-border)]">
                <div className="flex items-center gap-1 rounded-lg border border-[var(--ui-border)] p-1">
                    <button 
                        onClick={() => setActiveTab('layers')}
                        className={`px-3 py-1 text-sm rounded ${activeTab === 'layers' ? 'bg-[var(--bp-accent-soft)] text-[var(--ui-text)]' : 'hover:bg-[var(--ui-hover)]'}`}
                    >
                        {t('sidePanel.layers')}
                    </button>
                    <button 
                        onClick={() => setActiveTab('frames')}
                        className={`px-3 py-1 text-sm rounded ${activeTab === 'frames' ? 'bg-[var(--bp-accent-soft)] text-[var(--ui-text)]' : 'hover:bg-[var(--ui-hover)]'}`}
                    >
                        {t('sidePanel.frames')}
                    </button>
                </div>
                <button onClick={onClose} className="rounded-lg p-1 text-[var(--bp-text-muted)] hover:bg-[var(--ui-hover)] hover:text-[var(--ui-text)]">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
            {activeTab === 'layers' ? (
                <div
                    ref={listViewportRef}
                    className="min-h-0 flex-grow overflow-y-auto p-2"
                    onScroll={event => setLayerScrollTop(event.currentTarget.scrollTop)}
                >
                    <div className="relative" style={{ height: layerWindow.totalHeight }}>
                        {visibleLayerRows.map((row, visibleIndex) => {
                            const rowIndex = layerWindow.start + visibleIndex;
                            const { element, level } = row;
                            return (
                                <div
                                    key={element.id}
                                    data-id={element.id}
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={(event) => handleDrop(event, element.id)}
                                    className="absolute left-0 right-0"
                                    style={{ top: rowIndex * PANEL_ROW_HEIGHT, height: PANEL_ROW_HEIGHT }}
                                >
                                    <LayerItem
                                        element={element}
                                        level={level}
                                        isSelected={selectedElementIds.includes(element.id)}
                                        onSelect={() => onSelectElement(element.id)}
                                        onToggleLock={() => onToggleLock(element.id)}
                                        onToggleVisibility={() => onToggleVisibility(element.id)}
                                        onRename={name => onRenameElement(element.id, name)}
                                        onDragStart={event => handleDragStart(event, element.id)}
                                        onDragOver={handleDragOver}
                                        onDragLeave={handleDragLeave}
                                        onDrop={(event) => handleDrop(event, element.id)}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <div
                    ref={listViewportRef}
                    className="min-h-0 flex-grow overflow-y-auto p-2"
                    onScroll={event => setFrameScrollTop(event.currentTarget.scrollTop)}
                >
                    {frames.length > 0 ? (
                        <div className="relative" style={{ height: frameWindow.totalHeight }}>
                            {visibleFrames.map((frame, visibleIndex) => {
                                const rowIndex = frameWindow.start + visibleIndex;
                                return (
                                    <div 
                                        key={frame.id}
                                        draggable
                                        onDragStart={(event) => handleDragStart(event, frame.id)}
                                        onDragOver={handleDragOver}
                                        onDrop={(event) => handleDrop(event, frame.id)}
                                        onDragLeave={handleDragLeave}
                                        data-id={frame.id}
                                        className="group absolute left-0 right-0 flex items-center justify-between rounded-md p-2 hover:bg-white/10"
                                        style={{ top: rowIndex * PANEL_ROW_HEIGHT, height: PANEL_ROW_HEIGHT }}
                                    >
                                        <button
                                            onClick={() => onSelectFrame(frame.id)}
                                            className="flex flex-grow items-center gap-2 truncate text-left text-sm text-[var(--ui-text)] transition-colors"
                                        >
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0"><path d="M6 9V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v4"/><path d="M3 13h18"/><path d="M18 17v4a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4"/></svg>
                                            <span className="truncate">{frame.name}</span>
                                        </button>
                                        <button
                                            onClick={(event) => { event.stopPropagation(); onDeleteFrame(frame.id); }}
                                            title={t('sidePanel.deleteFrame')}
                                            className="ml-2 flex-shrink-0 rounded-full p-1 text-red-300 opacity-0 transition-opacity hover:bg-red-500/50 group-hover:opacity-100"
                                        >
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="px-2 py-4 text-center text-xs text-gray-500">{t('sidePanel.noFrames')}</p>
                    )}
                </div>
            )}
        </div>
    );
};