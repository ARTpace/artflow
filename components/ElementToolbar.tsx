import React from 'react';
import { Element, PathElement } from '../types';

interface ElementToolbarProps {
    zoom: number;
    element: Element;
    handleCopyElement: (element: Element) => void;
    handleFrameAspectRatioChange: (id: string, ratio: string) => void;
    handleUngroup: () => void;
    handleMergeGroup: () => void;
    handleDownloadImage: (element: Element) => void;
    handleStartCrop: (element: Element) => void;
    handlePropertyChange: (id: string, properties: Partial<Element>) => void;
    handleDeleteElement: (id: string) => void;
    // Updated t signature to match useSettings hook for better type compatibility
    t: (key: string, ...args: any[]) => any;
}

export const ElementToolbar: React.FC<ElementToolbarProps> = ({
    zoom,
    element,
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
    const isMedia = ['image', 'video', 'audio'].includes(element.type);
    const mediaIcon = (path: string) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
    if (isMedia) {
        const actionClass = 'w-8 h-8 grid place-items-center rounded-md hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 transition-colors';
        return (
            <div data-media-toolbar style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'top left', width: element.type === 'image' ? 192 : 112 }}
                onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}
                onDoubleClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onKeyUp={e => e.stopPropagation()}>
                <div className="flex items-center gap-1 p-1 rounded-lg text-white" style={{ background: 'rgba(24,24,27,.9)' }}>
                    <button type="button" title={t('contextMenu.copy')} aria-label={t('contextMenu.copy')} onClick={() => handleCopyElement(element)} className={actionClass}>{mediaIcon('M9 9h11v11H9z M5 15H3V3h12v2')}</button>
                    {element.type === 'image' ? <>
                        <button type="button" title={t('contextMenu.download')} aria-label={t('contextMenu.download')} onClick={() => handleDownloadImage(element)} className={actionClass}>{mediaIcon('M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4')}</button>
                        <button type="button" title={t('contextMenu.crop')} aria-label={t('contextMenu.crop')} onClick={() => handleStartCrop(element)} className={actionClass}>{mediaIcon('M6 3v15h15M3 6h15v15')}</button>
                        <details className="relative">
                            <summary title={t('contextMenu.borderRadius')} aria-label={t('contextMenu.borderRadius')} className={`${actionClass} cursor-pointer list-none`}>{mediaIcon('M4 10V7a3 3 0 0 1 3-3h3m4 0h6v6m0 4v6h-6m-4 0H4v-6')}</summary>
                            <div className="absolute right-0 top-10 p-2 rounded-lg bg-zinc-900 text-xs flex items-center gap-2">
                                <input aria-label={t('contextMenu.borderRadius')} type="range" min="0" max="200" value={element.borderRadius || 0} onChange={e => handlePropertyChange(element.id, { borderRadius: parseInt(e.target.value, 10) })} className="w-16 accent-white" />
                                <input aria-label={`${t('contextMenu.borderRadius')} px`} type="number" min="0" value={element.borderRadius || 0} onChange={e => handlePropertyChange(element.id, { borderRadius: parseInt(e.target.value, 10) || 0 })} className="w-12 p-1 rounded bg-white/10" />
                            </div>
                        </details>
                    </> : ('href' in element && <a title={t('contextMenu.download')} aria-label={t('contextMenu.download')} href={element.href as string} download={`${element.type}-${element.id}`} className={actionClass}>{mediaIcon('M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4')}</a>)}
                    <button type="button" title={t('contextMenu.delete')} aria-label={t('contextMenu.delete')} onClick={() => handleDeleteElement(element.id)} className={`${actionClass} hover:text-red-300`}>{mediaIcon('M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7')}</button>
                </div>
            </div>
        );
    }
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

    const toolbarScreenHeight = 48;

    return (
        <div
            style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'top left', width: `${toolbarScreenWidth}px`, height: `${toolbarScreenHeight}px` }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div style={{ backgroundColor: 'var(--ui-bg-color)' }} data-bp-ui-surface="" className="h-full p-1 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl flex items-center justify-center gap-1 text-white">
                <button title={t('contextMenu.copy')} onClick={() => handleCopyElement(element)} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors flex items-center justify-center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
                {element.type === 'frame' && (
                    <>
                        <div className="h-5 w-px bg-white/20"></div>
                        {['3:4', '4:3', '1:1', '16:9', '9:16'].map(ratio => {
                            const [w, h] = ratio.split(':').map(Number);
                            const targetRatio = w / h;
                            const isCurrentRatio = Math.abs((element.width / element.height) - targetRatio) < 0.01;
                            return (
                                <button 
                                    key={ratio}
                                    onClick={() => handleFrameAspectRatioChange(element.id, ratio)} 
                                    className={`px-2 py-1.5 rounded-lg transition-colors text-xs ${isCurrentRatio ? 'bg-blue-500' : 'hover:bg-white/20'}`}
                                    title={`Set aspect ratio to ${ratio}`}
                                >
                                    {ratio}
                                </button>
                            )
                        })}
                    </>
                )}
                {element.type === 'group' && <button title={t('contextMenu.ungroup')} onClick={handleUngroup} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="14" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><path d="M17.5 14 14 17.5"/><path d="M6.5 7 10 3.5"/></svg></button>}
                {element.type === 'group' && <button title={t('contextMenu.mergeGroup')} onClick={handleMergeGroup} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m3 16 7-7"/><path d="m21 3-7.873 7.873a4 4 0 0 0-1.127 2.828V22"/></svg></button>}
                {element.type === 'image' && <button title={t('contextMenu.download')} onClick={() => handleDownloadImage(element)} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors flex items-center justify-center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></button>}
                {element.type === 'video' && <a title={t('contextMenu.download')} href={element.href} download={`video-${element.id}.mp4`} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors flex items-center justify-center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></a>}
                {element.type === 'image' && <button title={t('contextMenu.crop')} onClick={() => handleStartCrop(element)} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors flex items-center justify-center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"></path><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"></path></svg></button>}
                {(element.type === 'image' || (element.type === 'shape' && element.shapeType === 'rectangle')) && (
                    <>
                        <div className="h-5 w-px bg-white/20"></div>
                        <div title={t('contextMenu.borderRadius')} className="flex items-center gap-1 p-1">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400"><path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M16 4h4a1 1 0 0 1 1 1v4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M16 20h4a1 1 0 0 0 1-1v-4"/></svg>
                            <input type="range" min="0" max="200" value={element.borderRadius || 0} onChange={e => handlePropertyChange(element.id, { borderRadius: parseInt(e.target.value, 10) })} className="w-12 accent-blue-500" />
                            <input type="number" min="0" value={element.borderRadius || 0} onChange={e => handlePropertyChange(element.id, { borderRadius: parseInt(e.target.value, 10) || 0})} className="w-14 p-0.5 text-xs text-center border border-white/20 rounded bg-black/20 text-white"/>
                        </div>
                    </>
                )}
                {['path', 'arrow', 'line', 'shape'].includes(element.type) && (
                    <>
                        <div className="h-5 w-px bg-white/20"></div>
                        <div title={t('contextMenu.strokeColor')} className="relative p-1.5 rounded-lg hover:bg-white/20 transition-colors flex items-center justify-center">
                            <div className="w-4 h-4 rounded-full border border-white/30" style={{backgroundColor: (element as PathElement).strokeColor}}></div>
                            <input type="color" value={(element as PathElement).strokeColor} onChange={e => handlePropertyChange(element.id, { strokeColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer"/>
                        </div>
                        <div title={t('contextMenu.strokeWidth')} className="flex items-center gap-1 p-1">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400"><line x1="4" y1="12" x2="20" y2="12"></line></svg>
                            <input type="range" min="1" max="50" value={(element as PathElement).strokeWidth} onChange={e => handlePropertyChange(element.id, { strokeWidth: parseInt(e.target.value, 10) })} className="w-12 accent-blue-500" />
                            <input type="number" min="1" value={(element as PathElement).strokeWidth} onChange={e => handlePropertyChange(element.id, { strokeWidth: parseInt(e.target.value, 10) || 1 })} className="w-14 p-0.5 text-xs text-center border border-white/20 rounded bg-black/20 text-white"/>
                        </div>
                    </>
                )}
                {element.type === 'shape' && (
                    <>
                        <div className="h-5 w-px bg-white/20"></div>
                        <div title={t('contextMenu.fillColor')} className="relative p-1.5 rounded-lg hover:bg-white/20 transition-colors flex items-center justify-center">
                            <div className="w-4 h-4 rounded-full border border-white/30" style={{backgroundColor: element.fillColor}}></div>
                            <input type="color" value={element.fillColor} onChange={e => handlePropertyChange(element.id, { fillColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer"/>
                        </div>
                        <div title={t('contextMenu.strokeStyle')} className="flex items-center">
                            <button onClick={() => handlePropertyChange(element.id, { strokeDashArray: undefined })} className={`p-1.5 rounded-l-lg hover:bg-white/20 ${!element.strokeDashArray ? 'bg-blue-500' : 'bg-white/10'}`}><svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
                            <button onClick={() => handlePropertyChange(element.id, { strokeDashArray: [10, 10] })} className={`p-1.5 hover:bg-white/20 ${element.strokeDashArray?.toString() === '10,10' ? 'bg-blue-500' : 'bg-white/10'}`}><svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><line x1="4" y1="12" x2="8" y2="12"></line><line x1="12" y1="12" x2="16" y2="12"></line><line x1="20" y1="12" x2="22" y2="12"></line></svg></button>
                            <button onClick={() => handlePropertyChange(element.id, { strokeDashArray: [3, 4] })} className={`p-1.5 rounded-r-lg hover:bg-white/20 ${element.strokeDashArray?.toString() === '3,4' ? 'bg-blue-500' : 'bg-white/10'}`}><svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><line x1="4" y1="12" x2="5" y2="12"></line><line x1="9" y1="12" x2="11" y2="12"></line><line x1="15" y1="12" x2="18" y2="12"></line><line x1="22" y1="12" x2="22" y2="12"></line></svg></button>
                        </div>
                    </>
                )}
                 {['path', 'shape', 'image', 'video'].includes(element.type) && (
                    <>
                        <div className="h-5 w-px bg-white/20"></div>
                        <div title={t('contextMenu.opacity')} className="flex items-center gap-1 p-1">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a7 7 0 1 0 10 10"></path></svg>
                            <input type="range" min="0.1" max="1" step="0.05" value={(element as any).opacity || 1} onChange={e => handlePropertyChange(element.id, { opacity: parseFloat(e.target.value) })} className="w-12 accent-blue-500" />
                        </div>
                    </>
                )}
                {element.type === 'text' && (
                    <>
                        <div className="h-5 w-px bg-white/20"></div>
                        <div title={t('contextMenu.fontColor')} className="relative p-1.5 rounded-lg hover:bg-white/20 transition-colors flex items-center justify-center">
                            <div className="w-4 h-4 rounded-full border border-white/30" style={{backgroundColor: element.fontColor}}></div>
                            <input type="color" value={element.fontColor} onChange={e => handlePropertyChange(element.id, { fontColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer"/>
                        </div>
                        <div title={t('contextMenu.fontSize')} className="flex items-center gap-1 p-1">
                             <input type="range" min="8" max="128" value={element.fontSize} onChange={e => handlePropertyChange(element.id, { fontSize: parseInt(e.target.value, 10) })} className="w-12 accent-blue-500" />
                             <input type="number" min="1" value={element.fontSize} onChange={e => handlePropertyChange(element.id, { fontSize: parseInt(e.target.value, 10) || 1 })} className="w-14 p-0.5 text-xs text-center border border-white/20 rounded bg-black/20 text-white"/>
                        </div>
                    </>
                )}
                <div className="h-5 w-px bg-white/20"></div>
                <button title={t('contextMenu.delete')} onClick={() => handleDeleteElement(element.id)} className="p-1.5 rounded-lg hover:bg-red-500/30 transition-colors flex items-center justify-center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </div>
        </div>
    );
};