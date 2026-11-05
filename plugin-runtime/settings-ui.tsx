/**
 * settings-ui.tsx —— Settings 面板共享 UI 原语（Blender 风格）。
 * 通用宿主（CanvasSettings）与插件 section（builtin.core-settings 等）共用，
 * 避免插件反向 import components/。
 */
import React, { useState } from 'react';

/** Blender 风格可折叠区块：▼ 标题条 + 内容。 */
export const SectionBlock: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
    const [open, setOpen] = useState(true);
    return (
        <section data-bp-ui-section="" className="overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(prev => !prev)}
                className="flex w-full items-center gap-2 bg-black/20 px-3 py-2 text-left text-sm font-medium text-neutral-200 hover:bg-white/[0.05]"
            >
                <svg viewBox="0 0 12 12" aria-hidden className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-90' : ''}`}>
                    <path d="M4 2 L8.5 6 L4 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {title}
            </button>
            {open && <div className="space-y-2.5 px-4 pb-3.5 pt-2.5">{children}</div>}
        </section>
    );
};

/** Blender 风格设置行：右对齐标签 + 控件。 */
export const SettingsRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div data-bp-ui-row="" className="flex items-center justify-end gap-3">
        <span className="text-sm text-neutral-300">{label}</span>
        {children}
    </div>
);

/** 分段选择（互斥选项，violet 高亮）。 */
export const Segmented: React.FC<{ options: { value: string; label: string }[]; active: string; onSelect: (value: string) => void }> = ({ options, active, onSelect }) => (
    <div data-bp-ui-segmented="" className="flex items-center gap-1 rounded-md bg-black/25 p-0.5">
        {options.map(option => (
            <button
                key={option.value}
                type="button"
                data-bp-ui-active={active === option.value}
                onClick={() => onSelect(option.value)}
                className={`min-w-[5.5rem] rounded px-3 py-1 text-sm ${active === option.value ? 'bg-[var(--bp-ui-selected-bg)] text-[var(--bp-ui-text)] ring-1 ring-[var(--bp-ui-selected-border)]' : 'text-neutral-300 hover:bg-white/10'}`}
            >
                {option.label}
            </button>
        ))}
    </div>
);
