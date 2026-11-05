import React from 'react';
import type { ResolvedSkinTokens } from '../../plugin-runtime/contributions';

interface ThemeArtworkProps {
  title: string;
  poster?: string;
  tokens: ResolvedSkinTokens;
  compact?: boolean;
  subtitle?: string;
}

/** Static, non-interactive cover art: no SVG canvas filters, timers or workspace rendering. */
export const ThemeArtwork: React.FC<ThemeArtworkProps> = ({ title, poster, tokens, compact, subtitle }) => (
  <div
    data-bp-theme-artwork="" className={`relative isolate overflow-hidden rounded-lg border border-white/10 ${compact ? 'h-24' : 'h-44 sm:h-56'}`}
    style={{ background: tokens.canvas.background ?? tokens.color.cardBgAlt }}
  >
    {poster ? <img src={poster} alt="" draggable={false} loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : (
      <div className="absolute inset-0 flex items-center justify-end pr-8" aria-hidden="true">
        <div className="h-[76%] w-[35%] rounded-t-lg border border-b-0 opacity-60" style={{ backgroundColor: tokens.color.cardBgAlt, borderColor: tokens.color.border }} />
        <div className="-ml-2 h-[62%] w-[19%] rounded-t-lg border border-b-0 opacity-80" style={{ backgroundColor: tokens.color.cardBg, borderColor: tokens.color.border }} />
      </div>
    )}
    <div className="absolute inset-0 bg-gradient-to-r from-slate-950/75 via-slate-950/35 to-transparent" />
    <div className="absolute bottom-0 left-0 right-0 p-3 text-slate-50">
      <h3 className={`${compact ? 'text-[15px]' : 'text-xl sm:text-2xl'} font-semibold leading-tight`}>{title}</h3>
      {subtitle && !compact && <p className="mt-1 line-clamp-1 text-xs text-slate-50/80">{subtitle}</p>}
    </div>
  </div>
);

interface ThemeSceneProps {
  tokens: ResolvedSkinTokens;
  poster?: string;
  compact?: boolean;
  label: string;
}

/** Isolated illustration of the host's chrome, canvas and cards. Never mounts the real board. */
export const ThemeScene: React.FC<ThemeSceneProps> = ({ tokens, poster, compact, label }) => {
  const c = tokens.color;
  const chrome = tokens.chrome;
  // Render a whitelisted SVG path only; never inject contributed icon markup into a preview.
  const iconPath = /<path\s+d="([A-Za-z0-9.,\s+\-]+)"/.exec(tokens.icons['topbar.boards'] ?? '')?.[1];
  return (
    <div
      role="img"
      aria-label={label}
      className={`relative isolate overflow-hidden rounded-xl border border-white/10 ${compact ? 'h-40' : 'h-52 sm:h-64'}`}
      style={{ background: tokens.canvas.background ?? c.cardBgAlt, fontFamily: tokens.typography.ui ?? undefined }}
    >
      {poster && <img src={poster} alt="" draggable={false} loading="lazy" className="absolute inset-0 h-full w-full object-cover opacity-35" />}
      <div className="absolute inset-0 bg-gradient-to-b from-black/5 to-black/20" />
      <div className="absolute inset-3 flex overflow-hidden rounded-[12px] border border-white/20 shadow-2xl sm:inset-4" style={{ color: chrome.panelText ?? c.textPrimary }}>
        <div className="flex w-12 shrink-0 flex-col items-center gap-3 border-r border-white/10 px-2 py-3 sm:w-16" style={{ background: chrome.panelBg ?? c.cardBg }}>
          <span className="flex h-6 w-6 items-center justify-center rounded-lg" style={{ background: c.accent, color: c.cardBg }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              {iconPath ? <path d={iconPath} /> : <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>}
            </svg>
          </span>
          <span className="mt-1 h-2 w-5 rounded-full opacity-70" style={{ background: c.accent }} />
          <span className="h-2 w-4 rounded-full opacity-40" style={{ background: c.textMuted }} />
          <span className="h-2 w-5 rounded-full opacity-40" style={{ background: c.textMuted }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex h-8 items-center gap-2 border-b border-white/10 px-3" style={{ background: chrome.panelBg ?? c.cardBg }}>
            <span className="h-1.5 w-16 rounded-full opacity-70" style={{ background: chrome.panelText ?? c.textPrimary }} />
            <span className="ml-auto h-3 w-3 rounded-full" style={{ background: c.accent }} />
          </div>
          <div className="flex h-[calc(100%-2rem)] items-center justify-center gap-2 p-3 sm:gap-3 sm:p-5">
            <div className="w-[43%] max-w-40 -rotate-3 rounded-xl border p-2 shadow-xl sm:p-3" style={{ background: c.cardBg, borderColor: c.border, borderRadius: tokens.radius.card, color: c.textPrimary }}>
              <span className="mb-1 block text-xs font-semibold leading-none" style={{ color: c.accent, fontFamily: tokens.typography.content ?? undefined }}>Aa</span>
              <span className="mb-1.5 block h-1 w-full rounded-full opacity-50" style={{ background: c.textMuted }} />
              <span className="block h-1 w-4/5 rounded-full opacity-50" style={{ background: c.textMuted }} />
              <span className="mt-3 block h-5 w-1/2 rounded-md" style={{ background: c.accentSoft }} />
            </div>
            <div className="w-[40%] max-w-36 rotate-3 rounded-xl border p-2 shadow-xl sm:p-3" style={{ background: c.cardBgAlt, borderColor: c.border, borderRadius: tokens.radius.card }}>
              <span className="mb-2 block h-1.5 w-3/5 rounded-full" style={{ background: c.accent }} />
              <span className="mb-1.5 block h-1 w-full rounded-full opacity-50" style={{ background: c.textMuted }} />
              <span className="mb-1.5 block h-1 w-2/3 rounded-full opacity-50" style={{ background: c.textMuted }} />
              <span className="block h-3 w-3 rounded-full" style={{ background: c.accent }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
