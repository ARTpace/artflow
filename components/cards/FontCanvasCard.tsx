import React, { useState } from 'react';
import type { FontElement } from '../../types';
import { formatBytes } from '../../utils/docUtils';

interface FontCanvasCardProps {
    element: FontElement;
}

const PRESETS = [
    '灵感无限 空间画布 2026',
    'Sphinx of black quartz, judge my vow.',
    'Aa Bb Cc Dd Ee 0123456789',
    'THE QUICK BROWN FOX JUMPS OVER 123',
];

export const FontCanvasCard: React.FC<FontCanvasCardProps> = ({ element }) => {
    const [sampleText, setSampleText] = useState(element.sampleText || PRESETS[0]);
    const [presetIdx, setPresetIdx] = useState(0);
    const [fontSize, setFontSize] = useState(24);

    const stopEvents = {
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    };

    const cyclePreset = (e: React.MouseEvent) => {
        e.stopPropagation();
        const next = (presetIdx + 1) % PRESETS.length;
        setPresetIdx(next);
        setSampleText(PRESETS[next]);
    };

    // 皮肤 token：个性强调色可被皮肤覆盖（--bp-card-accent-font），未定义回落全局 accent
    const accent = 'var(--bp-card-accent-font, var(--bp-accent))';

    return (
        <div
            className="w-full h-full rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.6)] flex flex-col justify-between select-none backdrop-blur-xl relative overflow-hidden group cursor-grab active:cursor-grabbing transition-all p-3"
            style={{ background: 'var(--bp-card-bg)', borderColor: 'var(--bp-border)', borderRadius: 'var(--bp-radius-card)', color: 'var(--bp-text-primary)' }}
            draggable={false}
        >
            {/* Ambient Background Glow */}
            <div className="absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />
            <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />

            {/* Top Bar */}
            <div className="flex items-center justify-between gap-2 pb-2 border-b relative z-10" style={{ borderColor: 'var(--bp-border)' }}>
                <div className="flex items-center gap-2 pointer-events-none">
                    <span className="px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide"
                        style={{ background: 'var(--bp-accent-soft)', borderColor: accent, color: accent }}>
                        {element.format || 'FONT'}
                    </span>
                    <span className="text-xs font-semibold truncate max-w-[160px]" style={{ color: 'var(--bp-text-primary)' }}>
                        {element.name || 'Custom Font'}
                    </span>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-1.5" {...stopEvents}>
                    <button
                        onClick={cyclePreset}
                        className="px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-[10px] font-medium transition-colors cursor-pointer flex items-center gap-1"
                        style={{ color: 'var(--bp-text-primary)' }}
                        title="切换样章文案"
                    >
                        <span>🔄</span> 样例文案
                    </button>
                </div>
            </div>

            {/* Font Specimen Preview Area */}
            <div
                className="flex-1 my-2 flex flex-col justify-center items-center text-center p-2 rounded-xl bg-black/25 border border-white/5 relative z-10 overflow-hidden"
                style={{ fontFamily: element.fontFamily }}
            >
                <div
                    className="transition-all select-text font-normal leading-tight break-words max-w-full"
                    style={{ fontSize: `${fontSize}px`, color: 'var(--bp-text-primary)' }}
                >
                    {sampleText}
                </div>
            </div>

            {/* Bottom Footer Controls */}
            <div className="flex items-center justify-between text-[9px] pt-1.5 border-t relative z-10" style={{ borderColor: 'var(--bp-border)', color: 'var(--bp-text-muted)' }}>
                <div className="flex items-center gap-2 pointer-events-none">
                    <span>{element.fileSize ? formatBytes(element.fileSize) : 'Vector Glyph'}</span>
                </div>

                {/* Font Size Adjuster */}
                <div className="flex items-center gap-1.5" {...stopEvents}>
                    <span className="text-[9px] pointer-events-none" style={{ color: 'var(--bp-text-muted)' }}>字号</span>
                    <input
                        type="range"
                        min={14}
                        max={42}
                        step={2}
                        value={fontSize}
                        onChange={(e) => setFontSize(parseInt(e.target.value))}
                        className="w-16 h-1 bg-white/20 rounded appearance-none cursor-pointer"
                        style={{ accentColor: accent }}
                    />
                    <span className="text-[9px] font-mono pointer-events-none w-4" style={{ color: accent }}>{fontSize}</span>
                </div>
            </div>
        </div>
    );
};
