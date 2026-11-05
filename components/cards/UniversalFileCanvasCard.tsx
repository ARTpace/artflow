import React from 'react';
import type { FileElement, FileCardCategory } from '../../types';
import { formatBytes } from '../../utils/docUtils';
import { useTranslation } from '../../utils/language-store';

interface UniversalFileCanvasCardProps {
    element: FileElement;
}

interface CategoryVisual {
    gradient: string;
    border: string;
    badgeBg: string;
    badgeText: string;
    glow: string;
    icon: (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
}

/** Category visuals carry no copy: labels resolve through `fileCard.category.*`. */
const CATEGORY_MAP: Record<FileCardCategory, CategoryVisual> = {
    '3d': {
        gradient: 'from-[#0d1c24]/95 via-[#132838]/95 to-[#0b1720]/95',
        border: 'border-cyan-500/30 hover:border-cyan-400/50',
        badgeBg: 'from-cyan-500/20 to-blue-500/20 border-cyan-400/30',
        badgeText: 'text-cyan-300',
        glow: 'bg-cyan-500/10',
        icon: (props) => (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
        ),
    },
    'design': {
        gradient: 'from-[#22101e]/95 via-[#2d162a]/95 to-[#1c0c19]/95',
        border: 'border-pink-500/30 hover:border-pink-400/50',
        badgeBg: 'from-pink-500/20 to-rose-500/20 border-pink-400/30',
        badgeText: 'text-pink-300',
        glow: 'bg-pink-500/10',
        icon: (props) => (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
                <circle cx="12" cy="12" r="10" />
                <path d="m4.93 4.93 4.24 4.24" />
                <path d="m14.83 9.17 4.24-4.24" />
                <path d="m14.83 14.83 4.24 4.24" />
                <path d="m9.17 14.83-4.24 4.24" />
                <circle cx="12" cy="12" r="4" />
            </svg>
        ),
    },
    'archive': {
        gradient: 'from-[#241a0d]/95 via-[#332514]/95 to-[#1c1409]/95',
        border: 'border-amber-500/30 hover:border-amber-400/50',
        badgeBg: 'from-amber-500/20 to-yellow-500/20 border-amber-400/30',
        badgeText: 'text-amber-300',
        glow: 'bg-amber-500/10',
        icon: (props) => (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
        ),
    },
    'doc': {
        gradient: 'from-[#0e1726]/95 via-[#142238]/95 to-[#0b1320]/95',
        border: 'border-blue-500/30 hover:border-blue-400/50',
        badgeBg: 'from-blue-500/20 to-indigo-500/20 border-blue-400/30',
        badgeText: 'text-blue-300',
        glow: 'bg-blue-500/10',
        icon: (props) => (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
            </svg>
        ),
    },
    'executable': {
        gradient: 'from-[#0d2218]/95 via-[#133023]/95 to-[#0a1a12]/95',
        border: 'border-emerald-500/30 hover:border-emerald-400/50',
        badgeBg: 'from-emerald-500/20 to-teal-500/20 border-emerald-400/30',
        badgeText: 'text-emerald-300',
        glow: 'bg-emerald-500/10',
        icon: (props) => (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
        ),
    },
    'data': {
        gradient: 'from-[#1a1226]/95 via-[#251a37]/95 to-[#140e1e]/95',
        border: 'border-purple-500/30 hover:border-purple-400/50',
        badgeBg: 'from-purple-500/20 to-indigo-500/20 border-purple-400/30',
        badgeText: 'text-purple-300',
        glow: 'bg-purple-500/10',
        icon: (props) => (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
        ),
    },
    'general': {
        gradient: 'from-[#14151b]/95 via-[#1c1e26]/95 to-[#101116]/95',
        border: 'border-slate-500/30 hover:border-slate-400/50',
        badgeBg: 'from-slate-500/20 to-gray-500/20 border-slate-400/30',
        badgeText: 'text-slate-300',
        glow: 'bg-slate-500/10',
        icon: (props) => (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
            </svg>
        ),
    },
};

export const UniversalFileCanvasCard: React.FC<UniversalFileCanvasCardProps> = ({ element }) => {
    const category = element.category || 'general';
    const visual = CATEGORY_MAP[category] || CATEGORY_MAP.general;
    const IconComponent = visual.icon;
    const ext = (element.fileExtension || element.name.split('.').pop() || 'FILE').toUpperCase();
    const { t } = useTranslation();

    const stopEvents = {
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    };

    const handleDownload = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!element.fileUrl) return;
        const a = document.createElement('a');
        a.href = element.fileUrl;
        a.download = element.name || `download.${ext.toLowerCase()}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    return (
        <div
            className={`w-full h-full rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.6)] flex flex-col justify-between select-none backdrop-blur-xl relative overflow-hidden group cursor-grab active:cursor-grabbing transition-all p-3`}
            style={{ background: 'var(--bp-card-bg)', borderColor: 'var(--bp-border)', borderRadius: 'var(--bp-radius-card)', color: 'var(--bp-text-primary)' }}
            draggable={false}
        >
            {/* Cute Ambient Background Light */}
            <div className={`absolute -top-8 -right-8 w-28 h-28 ${visual.glow} rounded-full blur-2xl pointer-events-none`} />

            {/* Top Bar */}
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-white/10 relative z-10" style={{ borderColor: 'var(--bp-border)' }}>
                <div className="flex items-center gap-2 pointer-events-none">
                    <span className={`px-2 py-0.5 rounded-full bg-gradient-to-r ${visual.badgeBg} border text-[10px] font-bold ${visual.badgeText} uppercase tracking-wide shadow-sm`}>
                        {ext}
                    </span>
                    <span className="text-[10px] font-medium" style={{ color: 'var(--bp-text-muted)' }}>
                        {t(`fileCard.category.${category}`)}
                    </span>
                </div>

                {/* Download Button */}
                <div className="flex items-center gap-1.5" {...stopEvents}>
                    <button
                        onClick={handleDownload}
                        className="px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-[10px] font-medium text-gray-200 transition-colors flex items-center gap-1 cursor-pointer"
                        title={t('fileCard.download')}
                    >
                        <span>📥</span> {t('fileCard.export')}
                    </button>
                </div>
            </div>

            {/* Center Area: Large Icon + File Name + File Size */}
            <div className="flex items-center gap-3 my-2 relative z-10">
                {/* Visual Icon Container */}
                <div className={`w-12 h-12 rounded-xl bg-black/40 border border-white/10 flex items-center justify-center p-2.5 flex-shrink-0 shadow-inner text-gray-200 group-hover:scale-105 transition-transform`}>
                    <IconComponent className="w-6 h-6" />
                </div>

                {/* File details */}
                <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                    <h4 className="text-xs font-bold truncate" style={{ color: 'var(--bp-text-primary)' }} title={element.name}>
                        {element.name}
                    </h4>
                    <p className="text-[10px] font-mono" style={{ color: 'var(--bp-text-muted)' }}>
                        {formatBytes(element.fileSize)}
                    </p>
                </div>
            </div>

            {/* Bottom Footer */}
            <div className="flex items-center justify-between text-[9px] pt-1.5 border-t border-white/10 relative z-10 pointer-events-none" style={{ borderColor: 'var(--bp-border)', color: 'var(--bp-text-muted)' }}>
                <span>{element.mimeType || t('fileCard.asset', ext)}</span>
                <span className="font-mono" style={{ color: 'var(--bp-text-muted)' }}>{t('fileCard.canvasNode')}</span>
            </div>
        </div>
    );
};
