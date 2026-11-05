import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BpIcon } from '../../components/BpIcon';

type TooltipAnchor = { left: number; edge: number; above: boolean };

/** Hover/focus help lives outside the scroll container so bottom rows never clip it. */
export const HoverInfoButton: React.FC<{
  label: string;
  lines: readonly string[];
  onClick?: () => void;
  warning?: boolean;
  success?: boolean;
}> = ({ label, lines, onClick, warning = false, success = false }) => {
  const ref = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);
  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(304, window.innerWidth - 16);
    setAnchor({
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      edge: rect.bottom > window.innerHeight * 0.55 ? window.innerHeight - rect.top + 6 : rect.bottom + 6,
      above: rect.bottom > window.innerHeight * 0.55,
    });
  };
  useEffect(() => {
    if (!anchor) return;
    const hide = () => setAnchor(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [anchor]);
  return <>
    <button ref={ref} type="button" aria-label={label} aria-describedby={anchor ? tooltipId : undefined}
      onMouseEnter={show} onMouseLeave={() => setAnchor(null)}
      onFocus={show} onBlur={() => setAnchor(null)}
      onClick={() => { setAnchor(null); if (onClick) onClick(); else show(); }}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-offset-1 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 ${warning ? 'text-amber-200' : success ? 'text-emerald-200' : 'text-neutral-400 hover:text-neutral-100'}`}>
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="10" cy="10" r="7.25" /><path d="M10 8.8v4.6M10 6.1h.01" strokeLinecap="round" />
      </svg>
    </button>
    {anchor && typeof document !== 'undefined' && createPortal(
      <div id={tooltipId} role="tooltip" data-bp-plugin-hint=""
        style={{ left: anchor.left, ...(anchor.above ? { bottom: anchor.edge } : { top: anchor.edge }),
          backgroundColor: 'var(--bp-ui-surface-strong)', color: 'var(--bp-ui-text)', borderColor: 'var(--bp-ui-border)' }}
        className="pointer-events-none fixed z-[90] max-h-[min(20rem,calc(100vh-1rem))] w-[min(19rem,calc(100vw-1rem))] overflow-hidden rounded-xl border p-3 text-[11px] leading-5 shadow-2xl">
        {lines.filter(Boolean).map((line, index) => <p key={index} className={index === 0 ? 'font-medium' : 'mt-1 text-neutral-300'}>{line}</p>)}
      </div>, document.body,
    )}
  </>;
};

/** A stable one-line row for every source; any interactive details open outside the list. */
export const CompactPluginRow: React.FC<{
  id: string;
  name: string;
  enabled: boolean;
  enabledLabel: string;
  disabledLabel: string;
  helpLabel: string;
  helpLines: readonly string[];
  onDetails: () => void;
  onToggle: () => void;
  protectedReason?: string;
  warning?: boolean;
}> = ({ id, name, enabled, enabledLabel, disabledLabel, helpLabel, helpLines, onDetails, onToggle, protectedReason, warning }) => (
  <li data-bp-plugin-row={id} className="flex h-7 min-w-0 items-center gap-1.5 border-b border-white/[0.05] px-2 last:border-b-0 hover:bg-white/[0.035]">
    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${warning ? 'bg-amber-300' : enabled ? 'bg-emerald-300/70' : 'bg-neutral-600'}`} />
    <button type="button" onClick={onDetails} title={name}
      className={`min-w-0 flex-1 truncate text-left text-xs ${enabled ? 'text-neutral-100' : 'text-neutral-400'} hover:text-white`}>
      {name}
    </button>
    <HoverInfoButton label={`${name}: ${helpLabel}`} lines={helpLines} onClick={onDetails} warning={warning} />
    <button type="button" role="switch" aria-checked={enabled}
      aria-label={`${id}: ${enabled ? enabledLabel : disabledLabel}`}
      disabled={!!protectedReason} title={protectedReason || undefined} onClick={onToggle}
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40`}>
      <span className={`flex h-4 w-4 items-center justify-center rounded border ${enabled ? 'border-emerald-300 bg-emerald-300' : 'border-neutral-500'}`}>
        {enabled && <BpIcon name="ui.check" size={10} strokeWidth={2.6} className="text-emerald-950" />}
      </span>
    </button>
  </li>
);
