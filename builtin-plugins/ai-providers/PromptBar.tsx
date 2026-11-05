
import React from 'react';
import { QuickPrompts } from './QuickPrompts';
import type { UserEffect, GenerationMode, ImageAspectRatio, Hotkey } from '../../types';

interface PromptBarProps {
    t: (key: string, ...args: any[]) => string;
    prompt: string;
    setPrompt: (prompt: string) => void;
    onGenerate: () => void;
    isLoading: boolean;
    isSelectionActive: boolean;
    selectedElementCount: number;
    userEffects: UserEffect[];
    onAddUserEffect: (effect: UserEffect) => void;
    onDeleteUserEffect: (id: string) => void;
    generationMode: GenerationMode;
    setGenerationMode: (mode: GenerationMode) => void;
    videoAspectRatio: '16:9' | '9:16';
    setVideoAspectRatio: (ratio: '16:9' | '9:16') => void;
    imageAspectRatio: ImageAspectRatio;
    setImageAspectRatio: (ratio: ImageAspectRatio) => void;
    numberOfImages: number;
    setNumberOfImages: (num: number) => void;
    numberOfVideos: number;
    setNumberOfVideos: (num: number) => void;
    generateHotkey: Hotkey;
}

/* ── 视觉常量（对齐 Uiverse 参考：浅色胶囊 + 聚焦展开 + 缓动）───────────────── */

// 聚焦时旁侧元素的「退场」过渡（参考里的旁侧淡出 + 模糊）。
const SIDE_TRANSITION = 'transition-all duration-500 ease-[cubic-bezier(0.175,0.885,0.32,1.05)]';
const PILL_TRANSITION = 'transition-all duration-500 ease-[cubic-bezier(0.175,0.885,0.32,1.05)]';

// 深色工具栏背景上的中性细线按钮（参数/模式），保持克制。
const CHIP = 'flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-all duration-200 ease-out hover:bg-white/[0.14] hover:text-white active:scale-95';
const CHIP_DISABLED = 'opacity-35 cursor-not-allowed hover:bg-white/[0.06] hover:text-white/70';
// 下拉：深色浮层，贴合工具栏背景。
const MENU = 'absolute bottom-full z-50 mb-3 flex flex-col gap-1 rounded-2xl border border-white/10 bg-[var(--ui-bg-color)] p-1.5 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.6)] backdrop-blur-2xl';
const MENU_ITEM = 'flex items-center justify-center rounded-lg transition-all duration-200';

export const PromptBar: React.FC<PromptBarProps> = ({
    t,
    prompt,
    setPrompt,
    onGenerate,
    isLoading,
    isSelectionActive,
    selectedElementCount,
    userEffects,
    onAddUserEffect,
    onDeleteUserEffect,
    generationMode,
    setGenerationMode,
    videoAspectRatio,
    setVideoAspectRatio,
    imageAspectRatio,
    setImageAspectRatio,
    numberOfImages,
    setNumberOfImages,
    numberOfVideos,
    setNumberOfVideos,
    generateHotkey,
}) => {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const [isAspectRatioMenuOpen, setIsAspectRatioMenuOpen] = React.useState(false);
    const [isNumberMenuOpen, setIsNumberMenuOpen] = React.useState(false);
    const [isVidAspectRatioMenuOpen, setIsVidAspectRatioMenuOpen] = React.useState(false);
    const [isVidNumberMenuOpen, setIsVidNumberMenuOpen] = React.useState(false);
    /** 输入聚焦 —— 驱动「聚焦展开 + 旁侧淡出」动效。 */
    const [isFocused, setIsFocused] = React.useState(false);

    const aspectRatioRef = React.useRef<HTMLDivElement>(null);
    const numberRef = React.useRef<HTMLDivElement>(null);
    const vidAspectRatioRef = React.useRef<HTMLDivElement>(null);
    const vidNumberRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'; // Reset height
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        }
    }, [prompt]);

    React.useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (aspectRatioRef.current && !aspectRatioRef.current.contains(event.target as Node)) {
                setIsAspectRatioMenuOpen(false);
            }
            if (numberRef.current && !numberRef.current.contains(event.target as Node)) {
                setIsNumberMenuOpen(false);
            }
            if (vidAspectRatioRef.current && !vidAspectRatioRef.current.contains(event.target as Node)) {
                setIsVidAspectRatioMenuOpen(false);
            }
            if (vidNumberRef.current && !vidNumberRef.current.contains(event.target as Node)) {
                setIsVidNumberMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const getPlaceholderText = () => {
        if (!isSelectionActive) {
            return generationMode === 'video' ? t('promptBar.placeholderDefaultVideo') : t('promptBar.placeholderDefault');
        }
        if (selectedElementCount === 1) {
            return t('promptBar.placeholderSingle');
        }
        return t('promptBar.placeholderMultiple', selectedElementCount);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!generateHotkey) return;
        const { key, metaOrCtrlKey, shiftKey, altKey } = generateHotkey;

        if (
            e.key.toLowerCase() === key.toLowerCase() &&
            (e.metaKey || e.ctrlKey) === metaOrCtrlKey &&
            e.shiftKey === shiftKey &&
            e.altKey === altKey
        ) {
            e.preventDefault();
            if (!isLoading && prompt.trim()) {
                onGenerate();
            }
        }
    };

    const handleSaveEffect = () => {
        const name = window.prompt(t('myEffects.saveEffectPrompt'), t('myEffects.defaultName'));
        if (name && prompt.trim()) {
            onAddUserEffect({ id: `user_${Date.now()}`, name, value: prompt });
        }
    };

    const containerStyle: React.CSSProperties = {
        backgroundColor: `var(--ui-bg-color)`,
    };

    // 聚焦时旁侧元素退场（淡出 + 模糊 + 微位移），对齐参考。
    const sideClass = isFocused
        ? 'pointer-events-none -translate-x-3 opacity-0 blur-[2px]'
        : 'translate-x-0 opacity-100';

    const aspectRatios: { value: ImageAspectRatio; label: string; icon: React.ReactNode }[] = [
        { value: '1:1', label: t('promptBar.aspectRatioSquare'), icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg> },
        { value: '16:9', label: t('promptBar.aspectRatioLandscapeW'), icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="10" rx="2" ry="2"></rect></svg> },
        { value: '9:16', label: t('promptBar.aspectRatioPortraitT'), icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2" width="10" height="20" rx="2" ry="2"></rect></svg> },
        { value: '4:3', label: t('promptBar.aspectRatioLandscape'), icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" ry="2"></rect></svg> },
        { value: '3:4', label: t('promptBar.aspectRatioPortrait'), icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3" width="14" height="18" rx="2" ry="2"></rect></svg> },
    ];

    const videoAspectRatios: { value: '16:9' | '9:16'; label: string; icon: React.ReactNode }[] = [
        { value: '16:9', label: t('promptBar.aspectRatioHorizontal'), icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="10" rx="2" ry="2"></rect></svg> },
        { value: '9:16', label: t('promptBar.aspectRatioVertical'), icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2" width="10" height="20" rx="2" ry="2"></rect></svg> },
    ];

    return (
        <div data-bp-ui-prompt="" className="absolute bottom-4 left-1/2 z-40 w-full max-w-3xl -translate-x-1/2 px-4">
            <div className="flex items-center justify-center gap-3">

                {/* ── 左：参数 + 快捷提示（聚焦时淡出）── */}
                <div
                    style={containerStyle}
                    data-bp-ui-surface=""
                    className={`flex flex-shrink-0 items-center gap-1.5 rounded-full border border-white/10 p-1.5 text-white backdrop-blur-2xl ${SIDE_TRANSITION} ${sideClass}`}
                >
                    {generationMode === 'image' ? (
                        <>
                            <div ref={numberRef} className="relative">
                                <button onClick={() => setIsNumberMenuOpen(p => !p)} title={t('promptBar.numberOfImages')} className={CHIP}>
                                    <span className="text-sm font-semibold">{numberOfImages}</span>
                                </button>
                                {isNumberMenuOpen && (
                                    <div className={MENU}>
                                        {[1, 2, 3, 4].map(num => (
                                            <button
                                                key={num}
                                                onClick={() => { setNumberOfImages(num); setIsNumberMenuOpen(false); }}
                                                className={`h-10 w-10 text-sm font-semibold ${MENU_ITEM} ${numberOfImages === num ? 'bg-[var(--bp-ui-prompt-action)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]' : 'text-white/80 hover:bg-white/10'}`}
                                            >
                                                {num}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div ref={aspectRatioRef} className="relative">
                                <button
                                    onClick={() => setIsAspectRatioMenuOpen(p => !p)}
                                    title={t('promptBar.aspectRatio')}
                                    disabled={isSelectionActive}
                                    className={`${CHIP} ${isSelectionActive ? CHIP_DISABLED : ''}`}
                                >
                                    {aspectRatios.find(r => r.value === imageAspectRatio)?.icon}
                                </button>
                                {isAspectRatioMenuOpen && (
                                    <div className={MENU}>
                                        {aspectRatios.map(ratio => (
                                            <button
                                                key={ratio.value}
                                                onClick={() => { setImageAspectRatio(ratio.value); setIsAspectRatioMenuOpen(false); }}
                                                title={ratio.label}
                                                className={`w-full p-2 ${MENU_ITEM} ${imageAspectRatio === ratio.value ? 'bg-[var(--bp-ui-prompt-action)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]' : 'text-white/80 hover:bg-white/10'}`}
                                            >
                                                {ratio.icon}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <div ref={vidNumberRef} className="relative">
                                <button onClick={() => setIsVidNumberMenuOpen(p => !p)} title={t('promptBar.numberOfVideos')} className={CHIP}>
                                    <span className="text-sm font-semibold">{numberOfVideos}</span>
                                </button>
                                {isVidNumberMenuOpen && (
                                    <div className={MENU}>
                                        {[1, 2].map(num => (
                                            <button
                                                key={num}
                                                onClick={() => { setNumberOfVideos(num); setIsVidNumberMenuOpen(false); }}
                                                className={`h-10 w-10 text-sm font-semibold ${MENU_ITEM} ${numberOfVideos === num ? 'bg-[var(--bp-ui-prompt-action)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]' : 'text-white/80 hover:bg-white/10'}`}
                                            >
                                                {num}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div ref={vidAspectRatioRef} className="relative">
                                <button onClick={() => setIsVidAspectRatioMenuOpen(p => !p)} title={t('promptBar.aspectRatio')} className={CHIP}>
                                    {videoAspectRatios.find(r => r.value === videoAspectRatio)?.icon}
                                </button>
                                {isVidAspectRatioMenuOpen && (
                                    <div className={MENU}>
                                        {videoAspectRatios.map(ratio => (
                                            <button
                                                key={ratio.value}
                                                onClick={() => { setVideoAspectRatio(ratio.value); setIsVidAspectRatioMenuOpen(false); }}
                                                title={ratio.label}
                                                className={`w-full p-2 ${MENU_ITEM} ${videoAspectRatio === ratio.value ? 'bg-[var(--bp-ui-prompt-action)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]' : 'text-white/80 hover:bg-white/10'}`}
                                            >
                                                {ratio.icon}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                    <div className="mx-0.5 h-8 w-px bg-white/12" />
                    <QuickPrompts
                        t={t}
                        setPrompt={setPrompt}
                        disabled={!isSelectionActive || isLoading}
                        userEffects={userEffects}
                        onDeleteUserEffect={onDeleteUserEffect}
                    />
                </div>

                {/* ── 模式切换（聚焦时淡出）── */}
                <button
                    onClick={() => setGenerationMode(generationMode === 'image' ? 'video' : 'image')}
                    title={generationMode === 'image' ? t('promptBar.switchToVideo') : t('promptBar.switchToImage')}
                    data-bp-ui-prompt-action=""
                    className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] ${SIDE_TRANSITION} ${sideClass} hover:scale-[1.04] hover:brightness-110 active:scale-95`}
                    style={{ backgroundColor: 'var(--bp-ui-prompt-action)' }}
                >
                    {generationMode === 'image'
                        ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                        : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/></svg>
                    }
                </button>

                {/* ── 浅色胶囊输入（本体即输入框，聚焦时展开/发光）── */}
                <div
                    className={`flex flex-grow items-center gap-1.5 rounded-full bg-[#e9e9e9] px-2 py-1 pl-4 ${PILL_TRANSITION} ${isFocused
                        ? 'shadow-[0_18px_50px_-12px_rgba(0,0,0,0.65)] ring-2 ring-white/50'
                        : 'shadow-[0_10px_34px_-12px_rgba(0,0,0,0.5)] ring-1 ring-black/5'}`}
                >
                    <textarea
                        ref={textareaRef}
                        rows={1}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={() => setIsFocused(true)}
                        onBlur={() => setIsFocused(false)}
                        placeholder={getPlaceholderText()}
                        className="max-h-32 flex-grow resize-none overflow-y-auto bg-transparent py-2.5 text-[15px] leading-snug text-[#4c4c4c] placeholder-[#959595] focus:outline-none"
                        disabled={isLoading}
                    />
                    {prompt.trim() && !isLoading && (
                        <button
                            onClick={handleSaveEffect}
                            title={t('myEffects.saveEffectTooltip')}
                            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[#6b6b6b] transition-all duration-200 ease-out hover:bg-black/10 hover:text-[#4c4c4c] active:scale-95"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
                        </button>
                    )}
                    <button
                        onClick={onGenerate}
                        disabled={isLoading || !prompt.trim()}
                        aria-label={t('promptBar.generate')}
                        title={t('promptBar.generate')}
                        data-bp-ui-prompt-action=""
                        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_22px_-6px_rgba(0,0,0,0.45)] transition-all duration-200 ease-out hover:scale-[1.04] hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:scale-100"
                        style={{ background: 'linear-gradient(to top right, #9147ff, #ff4141)' }}
                    >
                        {isLoading ? (
                            <svg className="h-5 w-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                        ) : (
                        generationMode === 'image'
                            ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                            : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/></svg>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};
