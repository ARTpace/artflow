import React from 'react';

interface PresentationUIProps {
    onPrev: () => void;
    onNext: () => void;
    onExit: () => void;
    onToggleTransition: () => void;
    transition: 'direct' | 'smooth';
    isPrevDisabled: boolean;
    isNextDisabled: boolean;
    // Updated t signature to match useSettings hook for better type compatibility
    t: (key: string, ...args: any[]) => any;
}

export const PresentationUI: React.FC<PresentationUIProps> = ({
    onPrev,
    onNext,
    onExit,
    onToggleTransition,
    transition,
    isPrevDisabled,
    isNextDisabled,
    t
}) => {
    return (
        <div className="absolute inset-x-0 bottom-4 z-50 flex items-center justify-center">
            <div 
                data-bp-ui-surface="" className="flex items-center gap-2 p-2 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl text-white"
                style={{ backgroundColor: 'var(--ui-bg-color)' }}
            >
                <button onClick={onExit} title={t('presentation.exit')} className="p-3 rounded-full hover:bg-white/20 transition-colors">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
                <div className="w-px h-6 bg-white/20"></div>
                <button onClick={onPrev} disabled={isPrevDisabled} title={t('presentation.prev')} className="p-3 rounded-full hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                </button>
                 <button onClick={onNext} disabled={isNextDisabled} title={t('presentation.next')} className="p-3 rounded-full hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </button>
                 <div className="w-px h-6 bg-white/20"></div>
                 <div className="flex items-center gap-1 p-1 bg-black/20 rounded-full text-sm">
                    <button onClick={onToggleTransition} className={`px-3 py-1.5 rounded-full transition-colors ${transition === 'smooth' ? 'bg-blue-500' : ''}`}>
                        {t('presentation.smooth')}
                    </button>
                    <button onClick={onToggleTransition} className={`px-3 py-1.5 rounded-full transition-colors ${transition === 'direct' ? 'bg-blue-500' : ''}`}>
                        {t('presentation.direct')}
                    </button>
                 </div>
            </div>
        </div>
    );
};