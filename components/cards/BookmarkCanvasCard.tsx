import React, { useState } from 'react';
import type { BookmarkElement } from '../../types';
import { CanvasCardShell } from './CanvasCardShell';

interface BookmarkCanvasCardProps {
    element: BookmarkElement;
}

export const BookmarkCanvasCard: React.FC<BookmarkCanvasCardProps> = ({ element }) => {
    const [copied, setCopied] = useState(false);
    const url = element.url || 'https://';
    
    let domain = element.domain;
    if (!domain) {
        try {
            const parsed = new URL(url);
            domain = parsed.hostname;
        } catch {
            domain = url.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split('/')[0] || 'website';
        }
    }

    const faviconUrl = element.favicon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

    const handleCopyUrl = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error(err);
        }
    };

    const handleOpenLink = (e: React.MouseEvent) => {
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
    };

    // 皮肤 token：个性强调色可被皮肤覆盖（--bp-card-accent-bookmark），未定义回落全局 accent
    const accent = 'var(--bp-card-accent-bookmark, var(--bp-accent))';

    return (
        <CanvasCardShell
            className="rounded-2xl shadow-[0_12px_36px_rgba(0,0,0,0.6)] justify-between backdrop-blur-xl relative group cursor-grab active:cursor-grabbing transition-all p-3"
            style={{ background: 'var(--bp-card-bg)', borderColor: 'var(--bp-border)', borderRadius: 'var(--bp-radius-card)', color: 'var(--bp-text-primary)' }}
            draggable={false}
            decoration={<>
                <div className="absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />
                <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />
            </>}
            headerClassName="justify-between pb-2 border-b relative z-10"
            headerStyle={{ borderColor: 'var(--bp-border)' }}
            header={<div className="flex items-center gap-2 pointer-events-none">
                    <span className="px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide"
                        style={{ background: 'var(--bp-accent-soft)', borderColor: accent, color: accent }}>
                        WEB LINK
                    </span>
                    <span className="text-[11px] font-mono truncate max-w-[170px]" style={{ color: 'var(--bp-text-muted)' }}>
                        {domain}
                    </span>
                </div>}
            actionsClassName="flex items-center gap-1.5"
            actions={<>
                    <button
                        onClick={handleCopyUrl}
                        className={`p-1 rounded-md text-[10px] transition-colors cursor-pointer ${copied ? 'bg-emerald-500/30' : 'bg-white/10 hover:bg-white/20'}`}
                        style={{ color: copied ? 'var(--bp-success)' : 'var(--bp-text-primary)' }}
                        title={copied ? "已复制链接" : "复制网址"}
                    >
                        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={copied ? 'm5 12 4 4L19 6' : 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'} /></svg>
                    </button>
                    <button
                        onClick={handleOpenLink}
                        className="px-2 py-0.5 rounded-md hover:opacity-90 text-white text-[10px] font-medium transition-all shadow cursor-pointer flex items-center gap-1"
                        style={{ background: accent }}
                        title="在新标签页中打开网页"
                    >
                        <span>访问</span>
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10" /></svg>
                    </button>
            </>}
            contentClassName="flex items-center gap-3 my-2 relative z-10"
            footer={<div className="flex items-center justify-between text-[9px] pt-1.5 border-t relative z-10 pointer-events-none" style={{ borderColor: 'var(--bp-border)', color: 'var(--bp-text-muted)' }}>
                <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--bp-success)' }} />
                    HTTPS READY
                </span>
                <span className="font-mono" style={{ color: accent }}>BOOKMARK</span>
            </div>}
        >
                {/* Favicon / Icon Orb */}
                <div className="w-12 h-12 rounded-xl border flex items-center justify-center p-2 flex-shrink-0 shadow-inner"
                    style={{ background: 'var(--bp-card-bg-alt)', borderColor: accent }}>
                    <img
                        src={faviconUrl}
                        alt="favicon"
                        className="w-7 h-7 object-contain rounded"
                        onError={(e) => {
                            // Fallback to cute globe icon
                            (e.target as HTMLElement).style.display = 'none';
                        }}
                    />
                </div>

                {/* Title & snippet */}
                <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                    <h4 className="text-xs font-bold truncate leading-snug" style={{ color: 'var(--bp-text-primary)' }} title={element.title || url}>
                        {element.title || domain}
                    </h4>
                    <p className="text-[10px] truncate font-mono" style={{ color: 'var(--bp-text-muted)' }}>
                        {url}
                    </p>
                    {element.description && (
                        <p className="text-[9px] line-clamp-1" style={{ color: 'var(--bp-text-muted)' }}>
                            {element.description}
                        </p>
                    )}
                </div>
        </CanvasCardShell>
    );
};
