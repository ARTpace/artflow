
import React from 'react';

interface SmartToolbarProps {
    isVisible: boolean;
    top: number;
    left: number;
    selectionType: 'single-image' | 'multi-image' | 'none';
    onRemoveBackground: () => void;
    onGetPrompt: () => void;
    onAutoCombine: () => void;
    onAIRotate: () => void;
    t: (key: string) => string;
}

export const SmartToolbar: React.FC<SmartToolbarProps> = ({
    isVisible,
    top,
    left,
    selectionType,
    onRemoveBackground,
    onGetPrompt,
    onAutoCombine,
    onAIRotate,
    t
}) => {
    if (!isVisible) return null;

    const containerStyle: React.CSSProperties = {
        position: 'fixed',
        top: `${top}px`,
        left: `${left}px`,
        transform: 'translateY(-50%)',
        zIndex: 30,
        backgroundColor: 'var(--ui-bg-color)',
    };

    return (
        <div
            style={containerStyle}
            data-bp-ui-surface="" className="bg-[var(--ui-bg-color)] p-2 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl flex flex-col items-center gap-2"
            onMouseDown={(e) => e.stopPropagation()}
        >
            {selectionType === 'single-image' && (
                <>
                    <button title={t('contextMenu.aiRotate')} onClick={onAIRotate} className="p-2 rounded-full hover:bg-white/20 text-white transition-colors">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M22 4h-4v4"/><path d="m12 6-1.9 4.8-4.8 1.9 4.8 1.9L12 18l1.9-4.8 4.8-1.9-4.8-1.9L12 6Z"/></svg>
                    </button>
                    <button title={t('contextMenu.removeBackground')} onClick={onRemoveBackground} className="p-2 rounded-full hover:bg-white/20 text-white transition-colors">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3H4a1 1 0 0 0-1 1v3" strokeDasharray="2 2"></path><path d="M21 7V4a1 1 0 0 0-1-1h-3" strokeDasharray="2 2"></path><path d="M17 21h3a1 1 0 0 0 1-1v-3" strokeDasharray="2 2"></path><path d="M3 17v3a1 1 0 0 0 1 1h3" strokeDasharray="2 2"></path><circle cx="12" cy="10" r="3"></circle><path d="M12 13c-2.5 0-5 2-5 5v1h10v-1c0-3-2.5-5-5-5z"></path></svg>
                    </button>
                    <button title={t('contextMenu.getPrompt')} onClick={onGetPrompt} className="p-2 rounded-full hover:bg-white/20 text-white transition-colors">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.9 4.8-4.8 1.9 4.8 1.9 1.9 4.8 1.9-4.8 4.8-1.9-4.8-1.9Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                    </button>
                </>
            )}
            {selectionType === 'multi-image' && (
                <>
                    <button title={t('contextMenu.autoCombine')} onClick={onAutoCombine} className="p-2 rounded-full hover:bg-white/20 text-white transition-colors">
                         <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.9 4.8-4.8 1.9 4.8 1.9 1.9 4.8 1.9-4.8 4.8-1.9-4.8-1.9Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                    </button>
                </>
            )}
        </div>
    );
};
