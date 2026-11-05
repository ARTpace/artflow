import React, { useState } from 'react';
import type { PsdParseResult } from '../plugin-runtime/format-handlers';

interface PsdImportModalProps {
    isOpen: boolean;
    psdData: PsdParseResult | null;
    onClose: () => void;
    onImportMerged: (psdData: PsdParseResult) => void;
    onImportLayers: (psdData: PsdParseResult, options: { autoGroup: boolean; onlyVisible: boolean }) => void;
    t: (key: string, ...args: any[]) => any;
}

export const PsdImportModal: React.FC<PsdImportModalProps> = ({
    isOpen,
    psdData,
    onClose,
    onImportMerged,
    onImportLayers,
    t,
}) => {
    const [importMode, setImportMode] = useState<'merged' | 'layers'>('merged');
    const [autoGroup, setAutoGroup] = useState<boolean>(true);
    const [onlyVisible, setOnlyVisible] = useState<boolean>(false);

    if (!isOpen || !psdData) return null;

    const visibleLayersCount = psdData.layers.filter(l => !l.hidden).length;

    const handleConfirm = () => {
        if (importMode === 'merged') {
            onImportMerged(psdData);
        } else {
            onImportLayers(psdData, { autoGroup, onlyVisible });
        }
    };

    return (
        <div 
            data-bp-ui-scrim="" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div 
                data-bp-ui-surface="" className="relative max-w-xl w-full bg-[var(--ui-bg-color)] border border-white/10 rounded-2xl shadow-2xl p-6 text-white overflow-hidden flex flex-col gap-5"
                style={{ backgroundColor: 'var(--ui-bg-color, #171717)' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-sm tracking-wider">
                            PSD
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-white tracking-tight">
                                {t('psdImport.title')}
                            </h3>
                            <p className="text-xs text-neutral-400 truncate max-w-xs sm:max-w-md">
                                {psdData.fileName}
                            </p>
                        </div>
                    </div>
                    <button 
                        onClick={onClose}
                        className="p-1.5 rounded-full text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
                        aria-label={t('common.close')}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>

                {/* Preview and Stats */}
                <div className="flex flex-col sm:flex-row gap-4 items-center bg-black/30 border border-white/5 p-4 rounded-xl">
                    <div className="w-28 h-28 flex-shrink-0 bg-neutral-950/80 rounded-lg border border-white/10 overflow-hidden flex items-center justify-center checkerboard-bg">
                        {psdData.compositeDataUrl ? (
                            <img 
                                src={psdData.compositeDataUrl} 
                                alt={psdData.fileName} 
                                className="max-w-full max-h-full object-contain"
                            />
                        ) : (
                            <span className="text-xs text-neutral-500">{t('psdImport.noPreview')}</span>
                        )}
                    </div>

                    <div className="flex flex-col justify-center space-y-1.5 flex-grow text-xs text-neutral-300">
                        <div className="flex items-center justify-between">
                            <span className="text-neutral-400">{t('psdImport.resolution')}:</span>
                            <span className="font-mono text-neutral-200">{psdData.width} × {psdData.height} px</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-neutral-400">{t('sidePanel.layers')}:</span>
                            <span className="font-medium text-blue-400">{t('psdImport.layersBadge', psdData.layers.length)} ({t('psdImport.visibleCount', visibleLayersCount)})</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-neutral-400">{t('psdImport.format')}</span>
                            <span className="text-neutral-200 uppercase font-mono">Adobe Photoshop</span>
                        </div>
                    </div>
                </div>

                {/* Import Mode Options */}
                <div className="space-y-3">
                    {/* Option 1: Merged */}
                    <div 
                        onClick={() => setImportMode('merged')}
                        className={`cursor-pointer border rounded-xl p-4 transition-all flex items-start gap-3.5 ${
                            importMode === 'merged' 
                                ? 'bg-blue-600/15 border-blue-500 text-white ring-1 ring-blue-500/50' 
                                : 'bg-white/5 border-white/10 text-neutral-300 hover:bg-white/10'
                        }`}
                    >
                        <div className={`mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${
                            importMode === 'merged' ? 'border-blue-500 bg-blue-500' : 'border-neutral-500'
                        }`}>
                            {importMode === 'merged' && (
                                <div className="w-2 h-2 rounded-full bg-white" />
                            )}
                        </div>
                        <div className="space-y-0.5">
                            <div className="text-sm font-semibold flex items-center gap-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400">
                                    <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                                    <circle cx="9" cy="9" r="2"/>
                                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                                </svg>
                                {t('psdImport.importMerged')}
                            </div>
                            <p className="text-xs text-neutral-400 leading-relaxed">
                                {t('psdImport.importMergedDesc')}
                            </p>
                        </div>
                    </div>

                    {/* Option 2: Split layers */}
                    <div 
                        onClick={() => setImportMode('layers')}
                        className={`cursor-pointer border rounded-xl p-4 transition-all flex items-start gap-3.5 ${
                            importMode === 'layers' 
                                ? 'bg-blue-600/15 border-blue-500 text-white ring-1 ring-blue-500/50' 
                                : 'bg-white/5 border-white/10 text-neutral-300 hover:bg-white/10'
                        }`}
                    >
                        <div className={`mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${
                            importMode === 'layers' ? 'border-blue-500 bg-blue-500' : 'border-neutral-500'
                        }`}>
                            {importMode === 'layers' && (
                                <div className="w-2 h-2 rounded-full bg-white" />
                            )}
                        </div>
                        <div className="space-y-1 w-full">
                            <div className="text-sm font-semibold flex items-center gap-2">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400">
                                    <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                                    <polyline points="2 17 12 22 22 17"></polyline>
                                    <polyline points="2 12 12 17 22 12"></polyline>
                                </svg>
                                {t('psdImport.importLayers')}
                                <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300">
                                    {t('psdImport.layersBadge', psdData.layers.length)}
                                </span>
                            </div>
                            <p className="text-xs text-neutral-400 leading-relaxed">
                                {t('psdImport.importLayersDesc')}
                            </p>

                            {/* Options for layer import */}
                            {importMode === 'layers' && (
                                <div className="mt-3 pt-2.5 border-t border-white/10 space-y-2 flex flex-col text-xs text-neutral-300">
                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                        <input 
                                            type="checkbox"
                                            checked={autoGroup}
                                            onChange={e => setAutoGroup(e.target.checked)}
                                            className="rounded accent-blue-500 cursor-pointer"
                                        />
                                        <span>{t('psdImport.groupLayers')}</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                        <input 
                                            type="checkbox"
                                            checked={onlyVisible}
                                            onChange={e => setOnlyVisible(e.target.checked)}
                                            className="rounded accent-blue-500 cursor-pointer"
                                        />
                                        <span>{t('psdImport.onlyVisibleLayers')}</span>
                                    </label>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer Buttons */}
                <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm rounded-lg bg-white/10 hover:bg-white/20 text-neutral-200 transition-colors font-medium"
                    >
                        {t('psdImport.cancel')}
                    </button>
                    <button
                        onClick={handleConfirm}
                        className="px-5 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-lg shadow-blue-600/30 transition-colors flex items-center gap-1.5"
                    >
                        <span>{t('psdImport.confirm')}</span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
};
