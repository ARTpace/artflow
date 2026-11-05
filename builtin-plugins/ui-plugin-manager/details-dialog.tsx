import React from 'react';

/** Inline accordion details: expands as one list row directly under the plugin, never a modal overlay. */
export const InlinePluginDetails: React.FC<{
  id: string;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ id, title, closeLabel, onClose, children }) => (
  <li data-bp-plugin-details={id} className="border-b border-white/[0.06] bg-black/[0.18]">
    <div className="flex items-start gap-2 px-2.5 py-1.5">
      <span aria-hidden="true" className="mt-[5px] h-4 w-[3px] shrink-0 rounded-full bg-[var(--bp-ui-accent-soft)] ring-1 ring-[var(--bp-ui-selected-border)]" />
      <div className="min-w-0 flex-1 space-y-1 text-xs text-neutral-200">
        <p className="truncate text-[11px] font-medium text-neutral-300">{title}</p>
        {children}
      </div>
      <button type="button" onClick={onClose} aria-label={closeLabel} title={closeLabel}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-white/10 hover:text-neutral-100">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m5 5 10 10M15 5 5 15" /></svg>
      </button>
    </div>
  </li>
);
