import React, { useState, useRef, useEffect } from 'react';
import type { AudioElement } from '../types';

interface AudioCanvasPlayerProps {
    element: AudioElement;
    isSelected?: boolean;
}

export const AudioCanvasPlayer: React.FC<AudioCanvasPlayerProps> = ({ element, isSelected }) => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const progressInputRef = useRef<HTMLInputElement | null>(null);
    const currentTimeLabelRef = useRef<HTMLSpanElement | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [duration, setDuration] = useState(element.duration || 0);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [isLooping, setIsLooping] = useState(false);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);

    const formatTime = (secs: number) => {
        if (isNaN(secs) || secs < 0) return '0:00';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    // 性能：timeupdate 每秒 ~4 次，若走 setState 会整卡重渲（几十个节点 diff），
    // 多张音频卡同时播放时成倍放大。进度条与时间文本改为 ref 直写 DOM，
    // React state 只保留低频信号（播放态/时长/音量等）。
    const paintProgress = (time: number, total: number) => {
        const input = progressInputRef.current;
        if (input) {
            input.value = String(time);
            const percent = total > 0 ? Math.min(100, (time / total) * 100) : 0;
            input.style.background = `linear-gradient(to right, var(--bp-card-accent-audio, var(--bp-accent)) 0%, var(--bp-card-accent-audio, var(--bp-accent)) ${percent}%, rgba(255,255,255,0.12) ${percent}%, rgba(255,255,255,0.12) 100%)`;
        }
        if (currentTimeLabelRef.current) {
            currentTimeLabelRef.current.textContent = formatTime(time);
        }
    };

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const updateTime = () => paintProgress(audio.currentTime, audio.duration || 0);
        const updateDuration = () => {
            if (audio.duration && !isNaN(audio.duration)) {
                setDuration(audio.duration);
            }
        };
        const handleEnded = () => {
            if (!isLooping) {
                setIsPlaying(false);
            }
        };

        audio.addEventListener('timeupdate', updateTime);
        audio.addEventListener('loadedmetadata', updateDuration);
        audio.addEventListener('ended', handleEnded);

        return () => {
            audio.removeEventListener('timeupdate', updateTime);
            audio.removeEventListener('loadedmetadata', updateDuration);
            audio.removeEventListener('ended', handleEnded);
        };
    }, [isLooping]);

    const togglePlay = (e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation();
        }
        const audio = audioRef.current;
        if (!audio) return;

        if (isPlaying) {
            audio.pause();
            setIsPlaying(false);
        } else {
            audio.play().then(() => setIsPlaying(true)).catch(console.error);
        }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.stopPropagation();
        const newTime = parseFloat(e.target.value);
        if (audioRef.current) {
            audioRef.current.currentTime = newTime;
            paintProgress(newTime, duration);
        }
    };

    const cyclePlaybackRate = (e: React.MouseEvent) => {
        e.stopPropagation();
        const rates = [1, 1.25, 1.5, 2, 0.8];
        const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
        const nextRate = rates[nextIdx];
        setPlaybackRate(nextRate);
        if (audioRef.current) {
            audioRef.current.playbackRate = nextRate;
        }
    };

    const toggleLoop = (e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !isLooping;
        setIsLooping(next);
        if (audioRef.current) {
            audioRef.current.loop = next;
        }
    };

    const toggleMute = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (audioRef.current) {
            audioRef.current.muted = !isMuted;
            setIsMuted(!isMuted);
        }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.stopPropagation();
        const val = parseFloat(e.target.value);
        setVolume(val);
        setIsMuted(val === 0);
        if (audioRef.current) {
            audioRef.current.volume = val;
            audioRef.current.muted = val === 0;
        }
    };

    const accent = 'var(--bp-card-accent-audio, var(--bp-accent))';
    const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();
    const controlEvents = {
        onPointerDown: stopPropagation, onPointerMove: stopPropagation, onPointerUp: stopPropagation,
        onMouseDown: stopPropagation, onMouseMove: stopPropagation, onMouseUp: stopPropagation,
        onTouchStart: stopPropagation, onTouchMove: stopPropagation, onTouchEnd: stopPropagation,
        onClick: stopPropagation, onDoubleClick: stopPropagation, onWheel: stopPropagation,
        onKeyDown: stopPropagation, onKeyUp: stopPropagation,
    };

    return (
        <div data-audio-player data-selected={isSelected || undefined}
            className="w-full h-full rounded-lg border p-3 flex items-center gap-3 select-none cursor-grab active:cursor-grabbing"
            style={{ background: 'var(--bp-card-bg, #18181b)', color: 'var(--bp-text-primary, #fff)', borderColor: 'var(--bp-border, #444)' }}
            draggable={false}>
            <audio ref={audioRef} src={element.href} preload="none" />
            {/* No cover is supplied by AudioElement: use an honest, quiet music glyph. */}
            <div aria-hidden="true" className="w-12 h-12 shrink-0 rounded-md flex items-center justify-center"
                style={{ background: 'var(--bp-surface, rgba(127,127,127,0.08))', color: accent }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13M9 8l12-2" /><ellipse cx="6" cy="18" rx="3" ry="3" /><ellipse cx="18" cy="16" rx="3" ry="3" />
                </svg>
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="truncate text-xs font-medium" title={element.name || 'Audio Track'}>{element.name || 'Audio Track'}</div>
                <div data-audio-controls className="flex flex-col gap-1 cursor-default" {...controlEvents}>
                    <input ref={progressInputRef} aria-label="播放进度" type="range" min={0} max={duration || 100}
                        step={0.1} defaultValue={0} onChange={handleSeek}
                        className="w-full h-1 rounded-full cursor-pointer" style={{ accentColor: accent }} />
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 shrink-0">
                            <button type="button" onClick={togglePlay} aria-label={isPlaying ? '暂停' : '播放'}
                                className="w-7 h-7 rounded-full flex items-center justify-center cursor-pointer" style={{ background: accent, color: 'var(--bp-card-bg, #18181b)' }}>
                                {isPlaying ? <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
                                    : <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="m7 4 14 8-14 8z" /></svg>}
                            </button>
                            <span className="text-[10px] tabular-nums opacity-60"><span ref={currentTimeLabelRef}>0:00</span> / {formatTime(duration)}</span>
                        </div>
                        <div className="flex items-center gap-1 min-w-0">
                            <button type="button" onClick={cyclePlaybackRate} aria-label="切换播放倍速" className="text-[10px] px-1 py-1 cursor-pointer">{playbackRate}x</button>
                            <button type="button" onClick={toggleLoop} aria-label="循环播放" aria-pressed={isLooping}
                                className="p-1 cursor-pointer" style={{ color: isLooping ? accent : 'inherit', opacity: isLooping ? 1 : 0.5 }}>
                                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3" /></svg>
                            </button>
                            <button type="button" onClick={toggleMute} aria-label={isMuted ? '取消静音' : '静音'} aria-pressed={isMuted} className="p-1 cursor-pointer">
                                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m11 5-5 4H2v6h4l5 4z" />{isMuted || volume === 0 ? <path d="m17 9 5 6m0-6-5 6" /> : <path d="M16 8a6 6 0 0 1 0 8" />}</svg>
                            </button>
                            <input aria-label="音量" type="range" min="0" max="1" step="0.05" value={isMuted ? 0 : volume}
                                onChange={handleVolumeChange} className="w-12 min-w-0 h-1 cursor-pointer" style={{ accentColor: accent }} />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
