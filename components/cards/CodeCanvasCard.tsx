import React, { useState } from 'react';
import type { CodeElement } from '../../types';

interface CodeCanvasCardProps {
    element: CodeElement;
}

const LANGUAGE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    typescript: { bg: 'from-blue-500/20 to-indigo-500/20', text: 'text-blue-400', border: 'border-blue-400/30' },
    javascript: { bg: 'from-yellow-500/20 to-amber-500/20', text: 'text-yellow-300', border: 'border-yellow-400/30' },
    python: { bg: 'from-emerald-500/20 to-teal-500/20', text: 'text-emerald-400', border: 'border-emerald-400/30' },
    html: { bg: 'from-orange-500/20 to-red-500/20', text: 'text-orange-400', border: 'border-orange-400/30' },
    css: { bg: 'from-cyan-500/20 to-blue-500/20', text: 'text-cyan-300', border: 'border-cyan-400/30' },
    json: { bg: 'from-amber-500/20 to-orange-500/20', text: 'text-amber-300', border: 'border-amber-400/30' },
    rust: { bg: 'from-red-500/20 to-orange-600/20', text: 'text-red-400', border: 'border-red-400/30' },
    go: { bg: 'from-cyan-500/20 to-teal-500/20', text: 'text-teal-300', border: 'border-teal-400/30' },
    sql: { bg: 'from-purple-500/20 to-pink-500/20', text: 'text-purple-300', border: 'border-purple-400/30' },
    bash: { bg: 'from-gray-500/20 to-slate-500/20', text: 'text-green-400', border: 'border-green-400/30' },
};

export const CodeCanvasCard: React.FC<CodeCanvasCardProps> = ({ element }) => {
    const [copied, setCopied] = useState(false);
    const code = element.code || '';
    const lines = code.split('\n');
    const lang = (element.language || 'code').toLowerCase();
    const langStyle = LANGUAGE_COLORS[lang] || {
        bg: 'from-purple-500/20 to-pink-500/20',
        text: 'text-purple-300',
        border: 'border-purple-400/30',
    };

    const stopEvents = {
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    };

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy code:', err);
        }
    };

    // 皮肤 token：个性强调色可被皮肤覆盖（--bp-card-accent-code），未定义回落全局 accent
    const accent = 'var(--bp-card-accent-code, var(--bp-accent))';

    return (
        <div
            className="w-full h-full rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.6)] flex flex-col justify-between select-none backdrop-blur-xl relative overflow-hidden group cursor-grab active:cursor-grabbing transition-all p-3 font-mono"
            style={{ background: 'var(--bp-card-bg)', borderColor: 'var(--bp-border)', borderRadius: 'var(--bp-radius-card)', color: 'var(--bp-text-primary)' }}
            draggable={false}
        >
            {/* Ambient Background Glow */}
            <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full blur-2xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />
            <div className="absolute -bottom-10 -left-10 w-32 h-32 rounded-full blur-2xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />

            {/* Top Bar */}
            <div className="flex items-center justify-between gap-2 pb-2 border-b relative z-10 font-sans" style={{ borderColor: 'var(--bp-border)' }}>
                {/* Traffic dots + Lang pill + Name */}
                <div className="flex items-center gap-2 pointer-events-none">
                    <div className="flex items-center gap-1">
                        <div className="w-2.5 h-2.5 rounded-full bg-red-500/80 shadow-sm" />
                        <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80 shadow-sm" />
                        <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 shadow-sm" />
                    </div>

                    <span className={`px-2 py-0.5 rounded-full bg-gradient-to-r ${langStyle.bg} border ${langStyle.border} text-[10px] font-bold ${langStyle.text} uppercase tracking-wider`}>
                        {element.language || 'CODE'}
                    </span>

                    <span className="text-xs font-semibold truncate max-w-[160px]" style={{ color: 'var(--bp-text-primary)' }}>
                        {element.name || 'snippet'}
                    </span>
                </div>

                {/* Copy Button */}
                <div className="flex items-center gap-1.5" {...stopEvents}>
                    <button
                        onClick={handleCopy}
                        className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all flex items-center gap-1 cursor-pointer border ${copied ? 'bg-emerald-500/30 border-emerald-400/40' : 'bg-white/10 hover:bg-white/20 border-transparent'}`}
                        style={{ color: copied ? 'var(--bp-success)' : 'var(--bp-text-primary)' }}
                        title="复制代码"
                    >
                        {copied ? (
                            <>
                                <span>✓</span> 已复制
                            </>
                        ) : (
                            <>
                                <span>📋</span> 复制
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Code Body with Line Numbers */}
            <div
                className="flex-1 my-2 overflow-auto bg-[#07090e]/80 rounded-xl p-2.5 border select-text text-xs leading-5 relative z-10 scrollbar-thin"
                style={{ borderColor: 'var(--bp-border)' }}
                {...stopEvents}
            >
                <div className="flex">
                    {/* Line numbers column */}
                    <div className="select-none text-[10px] text-gray-600 text-right pr-3 font-mono border-r border-white/5 mr-2.5">
                        {lines.map((_, idx) => (
                            <div key={idx}>{idx + 1}</div>
                        ))}
                    </div>

                    {/* Code lines */}
                    <pre className="flex-1 overflow-x-auto text-[11px] font-mono text-gray-200">
                        {lines.map((line, idx) => (
                            <div key={idx} className="whitespace-pre">
                                {line || '\n'}
                            </div>
                        ))}
                    </pre>
                </div>
            </div>

            {/* Bottom Footer Stats */}
            <div className="flex items-center justify-between text-[9px] pt-1.5 border-t relative z-10 pointer-events-none font-sans" style={{ borderColor: 'var(--bp-border)', color: 'var(--bp-text-muted)' }}>
                <span>{lines.length} 行 · {code.length} 字符</span>
                <span className="flex items-center gap-1 font-mono" style={{ color: accent }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: accent }} />
                    SYNTAX SNIPPET
                </span>
            </div>
        </div>
    );
};
