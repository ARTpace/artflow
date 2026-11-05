import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { trySkinEngine } from '../plugin-runtime/skin-engine';
import { DEFAULT_UI_THEME_SETTINGS, resolveUiChrome, type UiThemeSettings } from '../plugin-runtime/ui-theme-settings';
import { chooseWallpaper, themeWallpaperStore, wallpaperRotation, type WallpaperEntry } from '../plugin-runtime/theme-wallpaper';
import { useLanguage } from '../utils/language-store';

function useWallpaperState(): [UiThemeSettings, WallpaperEntry[], 'light' | 'dark', number] {
  const engine = trySkinEngine();
  const [settings, setSettings] = useState<UiThemeSettings>(() => engine?.getUiSettings() ?? DEFAULT_UI_THEME_SETTINGS);
  useEffect(() => {
    if (!engine) return;
    setSettings(engine.getUiSettings());
    return engine.subscribeUiSettings(setSettings);
  }, [engine]);
  const entries = useSyncExternalStore(themeWallpaperStore.subscribe, themeWallpaperStore.snapshot, themeWallpaperStore.snapshot);
  const step = useSyncExternalStore(wallpaperRotation.subscribe, wallpaperRotation.snapshot, wallpaperRotation.snapshot);
  const mode = engine ? resolveUiChrome(engine.currentTokens(), settings).mode : 'dark';
  return [settings, entries, mode, step];
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false));
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const update = () => setReduced(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/** The heavy Blob is loaded only for the ONE wallpaper currently on screen. */
const WallpaperMedia: React.FC<{ entry: WallpaperEntry; blur: number; motionOff: boolean }> = ({ entry, blur, motionOff }) => {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (entry.src) return;
    let disposed = false;
    let url: string | null = null;
    setFileUrl(null);
    setFailed(false);
    void themeWallpaperStore.blob(entry.id).then(blob => {
      if (!blob || disposed) return;
      url = URL.createObjectURL(blob);
      setFileUrl(url);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [entry.id, entry.source, entry.src]);
  const src = entry.src ?? fileUrl;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (motionOff) video.pause();
    else void video.play().catch(() => { /* autoplay may be blocked; poster remains */ });
  }, [src, motionOff]);
  const style: React.CSSProperties = {
    position: 'absolute', inset: blur ? '-4%' : 0, width: blur ? '108%' : '100%', height: blur ? '108%' : '100%',
    objectFit: 'cover', filter: blur ? `blur(${blur}px)` : undefined,
  };
  if (entry.kind === 'video') return failed || motionOff
    ? entry.poster ? <img data-bp-wallpaper-still="" src={entry.poster} alt="" style={style} draggable={false} /> : null
    : <video data-bp-wallpaper-video="" ref={videoRef} src={src ?? undefined} poster={entry.poster}
        muted loop playsInline autoPlay preload="metadata" aria-hidden="true" style={style}
        onError={() => setFailed(true)} />;
  // GIF / animated WebP / APNG cannot be paused by CSS. Use their decoded first frame instead.
  const still = motionOff && entry.source !== 'builtin' && ['image/gif', 'image/png', 'image/webp'].includes(entry.mime);
  const image = still ? entry.poster : src;
  return image ? <img data-bp-wallpaper-image="" src={image} alt="" draggable={false} decoding="async" style={style} /> : null;
};

/** Entire workspace, behind the SVG/controls, no hit-testing and no camera transforms.
 * App suppresses it on a personal board background and during presentation mode.
 */
export const WorkspaceWallpaper: React.FC<{ active: boolean }> = React.memo(({ active }) => {
  const [settings, entries, mode, step] = useWallpaperState();
  const reduced = useReducedMotion();
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  // Reset only when selection/automation changes, not on each blur/overlay slider movement.
  useEffect(() => wallpaperRotation.reset(), [settings.wallpaperId, settings.wallpaperLightId, settings.wallpaperDarkId, settings.wallpaperAuto, settings.wallpaperIntervalMinutes, mode]);
  useEffect(() => {
    if (!active || (settings.wallpaperAuto !== 'interval' && settings.wallpaperAuto !== 'both')) return;
    const timer = window.setInterval(() => { if (!document.hidden) wallpaperRotation.next(); }, settings.wallpaperIntervalMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [active, settings.wallpaperAuto, settings.wallpaperIntervalMinutes]);
  const id = chooseWallpaper(settings, entries, mode, step);
  const entry = themeWallpaperStore.get(id);
  // An author skin may also paint its own static CSS wallpaper. While user media
  // is visible, keep its base gradient but stop painting/decoding the covered image.
  // App's board marker prevents this rule from ever overriding a personal backdrop.
  const replacesAuthorBackdrop = active && (!!entry || settings.wallpaperBlur > 0);
  useEffect(() => {
    const root = document.getElementById('root');
    if (replacesAuthorBackdrop) root?.setAttribute('data-bp-wallpaper-media', 'true');
    else root?.removeAttribute('data-bp-wallpaper-media');
    return () => { root?.removeAttribute('data-bp-wallpaper-media'); };
  }, [replacesAuthorBackdrop]);
  if (!active) return null;
  if (!entry && !settings.wallpaperDim && !settings.wallpaperBlur) return null; // exact author original, no duplicate wallpaper
  return (
    <div data-bp-workspace-wallpaper="" data-wallpaper-id={id ?? 'theme'} aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden" style={{ contain: 'layout style paint' }}>
      {entry ? <WallpaperMedia key={entry.id} entry={entry} blur={settings.wallpaperBlur} motionOff={reduced || hidden} /> : settings.wallpaperBlur > 0 ? (
        <div data-bp-wallpaper-theme="" className="absolute inset-[-4%] h-[108%] w-[108%]"
          style={{ background: 'var(--bp-canvas-bg-image, var(--bp-canvas-bg, #111827)) center / cover no-repeat',
            filter: `blur(${settings.wallpaperBlur}px)` }} />
      ) : null}
      {settings.wallpaperDim > 0 && <div data-bp-wallpaper-mask="" className="absolute inset-0"
        style={{ backgroundColor: mode === 'light' ? `rgba(255,255,255,${settings.wallpaperDim / 100})` : `rgba(0,0,0,${settings.wallpaperDim / 100})` }} />}
    </div>
  );
});

/** A workspace-only quick switch; it never touches the Windows desktop wallpaper.
 * While Studio is open it is hidden so it cannot interfere with the preview transaction.
 */
export const WorkspaceWallpaperSwitch: React.FC<{ active: boolean }> = React.memo(({ active }) => {
  const [settings, entries, mode, step] = useWallpaperState();
  const zh = useLanguage() === 'zho';
  if (!active || !settings.wallpaperSwitchButton || entries.length === 0) return null;
  const next = themeWallpaperStore.get(chooseWallpaper(settings, entries, mode, step + 1));
  return <button type="button" data-bp-wallpaper-switch="" data-bp-ui-action="primary"
    onClick={() => wallpaperRotation.next()}
    aria-label={zh ? '切换工作区壁纸' : 'Next workspace wallpaper'}
    title={zh ? `切换工作区壁纸${next ? `：${next.name}` : '：跟随主题'}（仅当前工作区）` : `Next workspace wallpaper${next ? `: ${next.name}` : ': Follow theme'} (app only)`}
    className="fixed right-5 top-[5.25rem] z-[25] flex items-center gap-2 rounded-full border px-3 py-2 text-xs shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70">
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3" width="19" height="17" rx="2.5" /><path d="m4.5 16 4.6-4 3.4 2.6 4.3-5.1 3.7 4.3M16 6.8h.01" />
    </svg>
    <span>{zh ? '换壁纸' : 'Next wallpaper'}</span>
  </button>;
});
