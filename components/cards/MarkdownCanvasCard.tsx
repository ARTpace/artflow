import React, { useState } from 'react';
import type { MarkdownElement } from '../../types';

interface MarkdownCanvasCardProps {
    element: MarkdownElement;
}

export const MarkdownCanvasCard: React.FC<MarkdownCanvasCardProps> = ({ element }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [content, setContent] = useState(element.content || '');

    const stopEvents = {
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    };

    // Simple robust markdown line parser
    const renderMarkdown = (text: string) => {
        const lines = text.split('\n');
        return lines.map((line, idx) => {
            // Headings
            if (line.startsWith('# ')) {
                return <h1 key={idx} className="text-base font-bold text-pink-300 mt-2 mb-1 border-b border-pink-500/20 pb-0.5">{line.slice(2)}</h1>;
            }
            if (line.startsWith('## ')) {
                return <h2 key={idx} className="text-sm font-bold text-purple-300 mt-1.5 mb-1">{line.slice(3)}</h2>;
            }
            if (line.startsWith('### ')) {
                return <h3 key={idx} className="text-xs font-semibold text-indigo-300 mt-1 mb-0.5">{line.slice(4)}</h3>;
            }

            // Task list checkbox
            if (/^-\s*\[([ xX])\]\s*(.*)/.test(line)) {
                const match = line.match(/^-\s*\[([ xX])\]\s*(.*)/);
                const isChecked = match ? match[1].toLowerCase() === 'x' : false;
                const taskText = match ? match[2] : '';
                return (
                    <div key={idx} className="flex items-center gap-1.5 my-0.5 text-xs text-gray-200">
                        <span className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[10px] ${isChecked ? 'bg-pink-500 text-white font-bold' : 'border border-gray-400 bg-white/5'}`}>
                            {isChecked ? '✓' : ''}
                        </span>
                        <span className={isChecked ? 'line-through text-gray-400' : ''}>{taskText}</span>
                    </div>
                );
            }

            // Bullet list
            if (line.startsWith('- ') || line.startsWith('* ')) {
                return (
                    <div key={idx} className="flex items-start gap-1.5 my-0.5 text-xs text-gray-200 pl-1">
                        <span className="text-pink-400 mt-0.5">•</span>
                        <span>{line.slice(2)}</span>
                    </div>
                );
            }

            // Blockquote
            if (line.startsWith('> ')) {
                return (
                    <blockquote key={idx} className="border-l-2 border-purple-400/60 pl-2 my-1 text-xs italic text-purple-200/80 bg-purple-500/5 py-0.5 rounded-r">
                        {line.slice(2)}
                    </blockquote>
                );
            }

            // Horizontal rule
            if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
                return <hr key={idx} className="my-2 border-purple-500/20" />;
            }

            // Code block line / plain
            if (line.startsWith('```')) {
                return <div key={idx} className="text-[10px] text-pink-400/80 font-mono my-0.5">{line}</div>;
            }

            // Empty line
            if (!line.trim()) {
                return <div key={idx} className="h-1.5" />;
            }

            // Paragraph line
            return (
                <p key={idx} className="text-xs text-gray-200 leading-relaxed my-0.5">
                    {line}
                </p>
            );
        });
    };

    const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
    const charCount = content.length;

    // 皮肤 token：个性强调色可被皮肤覆盖（--bp-card-accent-markdown），未定义回落全局 accent
    const accent = 'var(--bp-card-accent-markdown, var(--bp-accent))';

    return (
        <div
            className="w-full h-full rounded-2xl border shadow-[0_12px_36px_rgba(0,0,0,0.6)] flex flex-col justify-between select-none backdrop-blur-xl relative overflow-hidden group cursor-grab active:cursor-grabbing transition-all p-3"
            style={{ background: 'var(--bp-card-bg)', borderColor: 'var(--bp-border)', borderRadius: 'var(--bp-radius-card)', color: 'var(--bp-text-primary)' }}
            draggable={false}
        >
            {/* Cute Gradient Light Orbs */}
            <div className="absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />
            <div className="absolute -bottom-8 -left-8 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'var(--bp-accent-soft)' }} />

            {/* Top Header Bar */}
            <div className="flex items-center justify-between gap-1 pb-2 border-b relative z-10" style={{ borderColor: 'var(--bp-border)' }}>
                <div className="flex items-center gap-2 pointer-events-none">
                    <span className="px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide shadow-sm"
                        style={{ background: 'var(--bp-accent-soft)', borderColor: accent, color: accent }}>
                        MD
                    </span>
                    <span className="text-xs font-semibold truncate max-w-[180px]" style={{ color: 'var(--bp-text-primary)' }}>
                        {element.name || 'Markdown Note'}
                    </span>
                </div>

                {/* Edit / Preview Toggle */}
                <div className="flex items-center gap-1.5" {...stopEvents}>
                    <button
                        onClick={() => setIsEditing(!isEditing)}
                        className="px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-[10px] font-medium transition-colors flex items-center gap-1 cursor-pointer"
                        style={{ color: 'var(--bp-text-primary)' }}
                        title={isEditing ? '预览模式' : '编辑文本'}
                    >
                        {isEditing ? (
                            <>
                                <span>👁️</span> 预览
                            </>
                        ) : (
                            <>
                                <span>✏️</span> 编辑
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Content Body */}
            <div
                className="flex-1 my-2 overflow-y-auto pr-1 select-text scrollbar-thin relative z-10"
                {...(isEditing ? stopEvents : {})}
            >
                {isEditing ? (
                    <textarea
                        value={content}
                        onChange={(e) => {
                            setContent(e.target.value);
                            element.content = e.target.value;
                        }}
                        className="w-full h-full min-h-[140px] bg-black/30 border rounded-lg p-2 text-xs font-mono text-gray-200 focus:outline-none resize-none"
                        style={{ borderColor: 'var(--bp-border)' }}
                        placeholder="输入 Markdown 内容..."
                    />
                ) : (
                    <div className="space-y-0.5" style={{ fontFamily: 'var(--bp-font-content, inherit)' }}>
                        {renderMarkdown(content)}
                    </div>
                )}
            </div>

            {/* Bottom Footer Stats */}
            <div className="flex items-center justify-between text-[9px] pt-1.5 border-t relative z-10 pointer-events-none" style={{ borderColor: 'var(--bp-border)', color: 'var(--bp-text-muted)' }}>
                <span>{charCount} 字符 · {wordCount} 词</span>
                <span className="flex items-center gap-1 font-mono" style={{ color: accent }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: accent }} />
                    MARKDOWN
                </span>
            </div>
        </div>
    );
};
