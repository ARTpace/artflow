import React from 'react';

/**
 * Declarative settings form for sandboxed plugins (`api.ui.registerSettingsTab`).
 *
 * The plugin only declares controls; this component renders them, seeds values
 * from the plugin's own `data.json` (via the main process) and persists every
 * change back — artflow's equivalent of Obsidian's `PluginSettingTab`, with
 * zero UI code on the plugin side. Values live at `<plugin dir>/data.json`,
 * the same file `api.storage.load()/save()` reads and writes.
 */

export interface SettingsControl {
  type: 'text' | 'password' | 'toggle' | 'number' | 'select' | 'button' | 'note';
  key?: string;
  label?: string;
  text?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
  commandId?: string;
}

export interface SettingsTab {
  id: string;
  title: string;
  controls: SettingsControl[];
}

const SAVE_DEBOUNCE_MS = 400;

function seedValue(control: SettingsControl, data: Record<string, unknown> | null): string | number | boolean {
  const stored = data && typeof data[control.key as string] !== 'undefined' ? data[control.key as string] : control.default;
  if (typeof stored !== 'undefined') return stored as string | number | boolean;
  return control.type === 'toggle' ? false : control.type === 'number' ? '' : '';
}

export const PluginSettingsForm: React.FC<{
  pluginId: string;
  tab: SettingsTab;
  runCommand: (commandId: string) => void;
  labels: { saved: string; saveFailed: string; run: string };
}> = ({ pluginId, tab, runCommand, labels }) => {
  const [values, setValues] = React.useState<Record<string, string | number | boolean>>({});
  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = React.useRef<Record<string, string | number | boolean>>({});

  React.useEffect(() => {
    let alive = true;
    (window.artflowApp?.pluginDataLoad?.(pluginId) ?? Promise.resolve({ ok: false })).then(response => {
      if (!alive) return;
      const data = response?.ok && response.data && typeof response.data === 'object' && !Array.isArray(response.data)
        ? response.data as Record<string, unknown>
        : null;
      const seeded: Record<string, string | number | boolean> = {};
      for (const control of tab.controls) {
        if (control.type === 'note' || control.type === 'button') continue;
        seeded[control.key as string] = seedValue(control, data);
      }
      latest.current = seeded;
      setValues(seeded);
      setLoaded(true);
    });
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [pluginId, tab]);

  const persist = React.useCallback(() => {
    const bridge = window.artflowApp?.pluginDataSave;
    if (!bridge) return;
    bridge({ pluginId, data: { ...(latest.current) } }).then(response => {
      setStatus(response?.ok ? labels.saved : `${labels.saveFailed} ${response?.message || ''}`.trim());
      if (response?.ok) setTimeout(() => setStatus(null), 1500);
    });
  }, [pluginId, labels.saved, labels.saveFailed]);

  const update = (key: string, value: string | number | boolean) => {
    latest.current = { ...latest.current, [key]: value };
    setValues(latest.current);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persist, SAVE_DEBOUNCE_MS);
  };

  const inputClass = 'min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-xs text-neutral-100 focus:border-sky-300/40 focus:outline-none';

  if (!loaded) return null;
  return (
    <div className="border-t border-white/[0.06] pt-1.5" data-bp-plugin-settings={tab.id}>
      <h4 className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        <span>{tab.title}</span>
        {status && <span className="font-normal normal-case text-neutral-400">{status}</span>}
      </h4>
      <ul className="space-y-1.5">
        {tab.controls.map((control, index) => {
          const controlKey = `${tab.id}:${control.key ?? index}`;
          if (control.type === 'note') {
            return (
              <li key={controlKey} className="text-[11px] leading-4 text-neutral-500">{control.text}</li>
            );
          }
          if (control.type === 'button') {
            return (
              <li key={controlKey} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => runCommand(control.commandId as string)}
                  className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-white/10 hover:text-neutral-100"
                >
                  {control.label}
                </button>
              </li>
            );
          }
          return (
            <li key={controlKey}>
              <div className="flex items-center gap-2">
                <label htmlFor={controlKey} className="w-36 shrink-0 truncate text-[11px] text-neutral-300" title={control.label}>
                  {control.label}
                </label>
                {control.type === 'toggle' ? (
                  <input
                    id={controlKey}
                    type="checkbox"
                    checked={values[control.key as string] === true}
                    onChange={event => update(control.key as string, event.target.checked)}
                    className="h-3.5 w-3.5 accent-emerald-400"
                  />
                ) : control.type === 'number' ? (
                  <input
                    id={controlKey}
                    type="number"
                    value={typeof values[control.key as string] === 'number' ? values[control.key as string] as number : ''}
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    onChange={event => update(control.key as string, event.target.valueAsNumber)}
                    className={inputClass}
                  />
                ) : control.type === 'select' ? (
                  <select
                    id={controlKey}
                    value={String(values[control.key as string] ?? '')}
                    onChange={event => update(control.key as string, event.target.value)}
                    className={inputClass}
                  >
                    {(control.options ?? []).map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={controlKey}
                    type={control.type === 'password' ? 'password' : 'text'}
                    value={String(values[control.key as string] ?? '')}
                    onChange={event => update(control.key as string, event.target.value)}
                    className={inputClass}
                  />
                )}
              </div>
              {control.description && <p className="ml-[9.5rem] text-[10px] leading-3.5 text-neutral-500">{control.description}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
