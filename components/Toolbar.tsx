import React, { useState, useRef, useEffect } from 'react';
import type { Tool } from '../types';
import { ACCEPTED_FILE_TYPES_STRING } from '../utils/formatDetector';
import { BpIcon } from './BpIcon';

interface ToolbarProps {
    // Updated t signature to match useSettings hook for better type compatibility
    t: (key: string, ...args: any[]) => any;
    activeTool: Tool;
    setActiveTool: (tool: Tool) => void;
    drawingOptions: { strokeColor: string; strokeWidth: number; opacity: number };
    setDrawingOptions: (options: { strokeColor: string; strokeWidth: number; opacity: number }) => void;
    onUpload: (files: File[]) => void;
    isCropping: boolean;
    onConfirmCrop: () => void;
    onCancelCrop: () => void;
    onUndo: () => void;
    onRedo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    position: 'left' | 'right';
}

const ToolButton: React.FC<{
    label: string;
    icon: React.ReactNode;
    isActive?: boolean;
    onClick: () => void;
    disabled?: boolean;
    className?: string;
}> = ({ label, icon, isActive = false, onClick, disabled = false, className = '' }) => (
    <button
        onClick={onClick}
        aria-label={label}
        title={label}
        disabled={disabled}
        style={isActive ? { backgroundColor: 'var(--bp-accent-soft)', boxShadow: 'inset 2px 0 0 var(--bp-accent)' } : undefined}
        className={`w-10 h-10 flex items-center justify-center rounded-[10px] transition-colors text-[var(--ui-text)] ${
            isActive
                ? 'hover:brightness-110'
                : 'hover:bg-[var(--ui-hover)]'
        } disabled:text-[var(--ui-text)]/40 disabled:hover:bg-transparent disabled:cursor-not-allowed ${className}`}
    >
        {icon}
    </button>
);


const ToolGroupButton: React.FC<{
    activeTool: Tool;
    setActiveTool: (tool: Tool) => void;
    tools: { id: Tool; label: string; icon: React.ReactNode }[];
    groupIcon: React.ReactNode;
    groupLabel: string;
    position: 'left' | 'right';
}> = ({ activeTool, setActiveTool, tools, groupIcon, groupLabel, position }) => {
    const [isOpen, setIsOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);

    const activeToolInGroup = tools.find(t => t.id === activeTool);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleToolSelect = (toolId: Tool) => {
        setActiveTool(toolId);
        setIsOpen(false);
    };

    const menuPositionClass = position === 'left' ? 'left-full ml-2' : 'right-full mr-2';

    return (
        <div className="relative flex-shrink-0" ref={wrapperRef}>
            <ToolButton
                label={activeToolInGroup ? activeToolInGroup.label : groupLabel}
                icon={activeToolInGroup ? activeToolInGroup.icon : groupIcon}
                isActive={!!activeToolInGroup}
                onClick={() => setIsOpen(prev => !prev)}
            />
            {isOpen && (
                <div data-bp-ui-floating-shell="" style={{ backgroundColor: 'var(--ui-bg-color)' }} className={`absolute top-0 z-30 flex flex-col gap-1 rounded-xl border border-[var(--ui-border)] p-1 ${menuPositionClass}`}>
                    {tools.map(tool => (
                        <ToolButton
                            key={tool.id}
                            label={tool.label}
                            icon={tool.icon}
                            isActive={activeTool === tool.id}
                            onClick={() => handleToolSelect(tool.id)}
                            className="bg-white/10"
                        />
                    ))}
                </div>
            )}
        </div>
    );
};


export const Toolbar: React.FC<ToolbarProps> = ({
    t,
    activeTool,
    setActiveTool,
    drawingOptions,
    setDrawingOptions,
    onUpload,
    isCropping,
    onConfirmCrop,
    onCancelCrop,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    position,
}) => {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const handleUploadClick = () => fileInputRef.current?.click();
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onUpload(Array.from(e.target.files));
            e.target.value = '';
        }
    };

    const containerStyle: React.CSSProperties = {
        backgroundColor: `var(--ui-bg-color)`,
    };

    const positionClasses = position === 'left' ? 'left-4' : 'right-4';

    if (isCropping) {
        return (
            <div
                style={containerStyle}
                data-bp-ui-floating-shell="" className={`absolute top-1/2 -translate-y-1/2 z-20 flex w-[88px] flex-col items-center space-y-2 rounded-[18px] border border-[var(--ui-border)] px-2 py-3 ${positionClasses}`}
            >
                <span className="text-sm font-medium text-[var(--ui-text)]">{t('toolbar.crop.title')}</span>
                <div className="w-full h-px bg-[var(--ui-border)] my-2"></div>
                <button onClick={onCancelCrop} className="px-4 py-1.5 text-sm rounded-md bg-[var(--ui-hover)] text-[var(--ui-text)] hover:brightness-110 border border-[var(--ui-border)] w-full">{t('toolbar.crop.cancel')}</button>
                <button onClick={onConfirmCrop} data-bp-ui-action="primary" style={{ backgroundColor: 'var(--bp-accent)', color: 'var(--ui-bg-color)' }} className="w-full rounded-md px-4 py-1.5 text-sm hover:brightness-110">{t('toolbar.crop.confirm')}</button>
            </div>
        )
    }

    const mainTools: { id: Tool; label: string; icon: React.ReactNode }[] = [
        { id: 'select', label: t('toolbar.select'), icon: <BpIcon name="tool.select" size={24} /> },
        { id: 'pan', label: t('toolbar.pan'), icon: <BpIcon name="tool.pan" size={24} /> },
    ];

     const shapeTools: { id: Tool; label: string; icon: React.ReactNode }[] = [
        { id: 'rectangle', label: t('toolbar.rectangle'), icon: <BpIcon name="tool.rectangle" size={24} /> },
        { id: 'circle', label: t('toolbar.circle'), icon: <BpIcon name="tool.circle" size={24} /> },
        { id: 'triangle', label: t('toolbar.triangle'), icon: <BpIcon name="tool.triangle" size={24} /> },
        { id: 'line', label: t('toolbar.line'), icon: <BpIcon name="tool.line" size={24} /> },
        { id: 'arrow', label: t('toolbar.arrow'), icon: <BpIcon name="tool.arrow" size={24} /> },
    ];

     const drawingTools: { id: Tool; label: string; icon: React.ReactNode }[] = [
        { id: 'draw', label: t('toolbar.draw'), icon: <BpIcon name="tool.pen" size={24} /> },
        { id: 'highlighter', label: t('toolbar.highlighter'), icon: <BpIcon name="tool.highlighter" size={24} />},
        { id: 'lasso', label: t('toolbar.lasso'), icon: <BpIcon name="tool.lasso" size={24} />},
        { id: 'erase', label: t('toolbar.erase'), icon: <BpIcon name="tool.erase" size={24} /> },
    ];

    const miscTools: { id: Tool; label: string; icon: React.ReactNode }[] = [
        { id: 'frame', label: t('toolbar.frame'), icon: <BpIcon name="tool.frame" size={24} /> },
        { id: 'text', label: t('toolbar.text'), icon: <BpIcon name="tool.text" size={24} /> },
    ];

    return (
        <div
            style={containerStyle}
            data-bp-ui-floating-shell="" className={`absolute top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1.5 rounded-[18px] border border-[var(--ui-border)] px-2 py-3 ${positionClasses}`}
        >
            <div className="flex flex-col items-center gap-2 flex-grow">
                 {mainTools.map(tool => (
                    <ToolButton key={tool.id} label={tool.label} icon={tool.icon} isActive={activeTool === tool.id} onClick={() => setActiveTool(tool.id)} />
                ))}

                <ToolGroupButton
                    activeTool={activeTool}
                    setActiveTool={setActiveTool}
                    tools={shapeTools}
                    groupLabel={t('toolbar.shapes')}
                    groupIcon={<BpIcon name="tool.shapes" size={24} />}
                    position={position}
                />

                <ToolGroupButton
                    activeTool={activeTool}
                    setActiveTool={setActiveTool}
                    tools={drawingTools}
                    groupLabel={t('toolbar.drawingTools')}
                    groupIcon={<BpIcon name="tool.pen-group" size={24} />}
                    position={position}
                />

                {miscTools.map(tool => (
                    <ToolButton key={tool.id} label={tool.label} icon={tool.icon} isActive={activeTool === tool.id} onClick={() => setActiveTool(tool.id)} />
                ))}

                <div className="w-10 h-px bg-[var(--ui-border)]"></div>
                <div className="relative w-8 h-8">
                    <div
                        className="w-full h-full rounded-full border border-[var(--ui-border)]"
                        style={{ backgroundColor: drawingOptions.strokeColor }}
                    />
                    <input
                        type="color"
                        aria-label={t('toolbar.strokeColor')}
                        title={t('toolbar.strokeColor')}
                        value={drawingOptions.strokeColor}
                        onChange={(e) => setDrawingOptions({ ...drawingOptions, strokeColor: e.target.value })}
                        className="absolute inset-0 w-full h-full p-0 rounded-full cursor-pointer opacity-0"
                    />
                </div>
                <input type="range" min="1" max="50" value={drawingOptions.strokeWidth} aria-label={t('toolbar.strokeWidth')} title={t('toolbar.strokeWidth')} onChange={(e) => setDrawingOptions({ ...drawingOptions, strokeWidth: parseInt(e.target.value, 10) })} className="w-10 cursor-pointer" />
                <span className="text-sm text-[var(--ui-text)] w-6 text-center">{drawingOptions.strokeWidth}</span>
                <div className="w-10 h-px bg-[var(--ui-border)]"></div>
                <input
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.05"
                    value={drawingOptions.opacity ?? 1}
                    aria-label={t('toolbar.opacity')}
                    title={t('toolbar.opacity')}
                    onChange={(e) => setDrawingOptions({ ...drawingOptions, opacity: parseFloat(e.target.value) })}
                    className="w-10 cursor-pointer"
                />
                <span className="text-sm text-[var(--ui-text)] w-6 text-center">{Math.round((drawingOptions.opacity ?? 1) * 100)}%</span>
                <div className="w-10 h-px bg-[var(--ui-border)]"></div>
                <input type="file" ref={fileInputRef} onChange={handleFileChange} accept={ACCEPTED_FILE_TYPES_STRING} multiple className="hidden" />
                <ToolButton label={t('toolbar.upload')} onClick={handleUploadClick} icon={<BpIcon name="tool.upload" size={24} />} />
            </div>

            <div className="w-10 h-px bg-[var(--ui-border)]"></div>
            <ToolButton label={t('toolbar.undo')} onClick={onUndo} disabled={!canUndo} icon={<BpIcon name="tool.undo" size={24} />} />
            <ToolButton label={t('toolbar.redo')} onClick={onRedo} disabled={!canRedo} icon={<BpIcon name="tool.redo" size={24} />} />
        </div>
    );
};
