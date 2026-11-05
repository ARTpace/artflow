import React, { useEffect, useState } from 'react';
import type { Element } from '../types';
import { extensionSchemaProvider } from '../plugin-runtime/extension-renderer';

interface ExtensionNodePropertiesProps {
  elements: readonly Element[];
  onCommit: (elementId: string, data: Record<string, string | number | boolean>) => { ok: boolean; error?: string };
  disabled?: boolean;
}
type FieldValue = string | number | boolean;

/** Generic schema-driven editor for selected extension nodes. One panel entry per field per node. */
export const ExtensionNodeProperties: React.FC<ExtensionNodePropertiesProps> = ({ elements, onCommit, disabled }) => {
  const [drafts, setDrafts] = useState<Record<string, Record<string, FieldValue>>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const scoped = elements.filter(element => extensionSchemaProvider(element.type));

  useEffect(() => {
    const next: Record<string, Record<string, FieldValue>> = {};
    for (const element of scoped) {
      const schema = extensionSchemaProvider(element.type)!;
      const record = element as unknown as Record<string, unknown>;
      const stored = (record.extensionData ?? {}) as Record<string, FieldValue>;
      const draft: Record<string, FieldValue> = {};
      for (const [key, field] of Object.entries(schema.fields)) draft[key] = key in stored ? stored[key] : field.default;
      next[element.id] = draft;
    }
    setDrafts(next);
    // Resync when the node identity or stored data changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements.map(element => `${element.id}:${JSON.stringify((element as unknown as Record<string, unknown>).extensionData)}`).join('|')]);

  if (scoped.length === 0) return null;

  const commit = () => {
    for (const element of scoped) {
      const schema = extensionSchemaProvider(element.type)!;
      const record = element as unknown as Record<string, unknown>;
      const stored = (record.extensionData ?? {}) as Record<string, FieldValue>;
      const draft = drafts[element.id] ?? {};
      const data: Record<string, FieldValue> = {};
      let changed = false;
      for (const [key, field] of Object.entries(schema.fields)) {
        const value = draft[key] ?? field.default;
        if (value !== stored[key]) { data[key] = value; changed = true; }
      }
      if (!changed) continue;
      const result = onCommit(element.id, data);
      if (!result.ok) { setMessage({ ok: false, text: result.error ?? 'Update rejected' }); return; }
    }
    setMessage({ ok: true, text: 'Extension node updated' });
  };

  return (
    <div className="flex flex-col gap-3 text-sm text-neutral-200">
      {scoped.map(element => {
        const schema = extensionSchemaProvider(element.type)!;
        const draft = drafts[element.id] ?? {};
        return (
          <div key={element.id} className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="truncate text-xs font-semibold text-neutral-400">{schema.title}</div>
            {Object.entries(schema.fields).map(([key, field]) => (
              <label key={key} className="block">
                <span className="mb-1 block text-[11px] text-neutral-400">{key} <span className="text-neutral-600">({field.type})</span></span>
                {field.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-violet-500"
                    checked={Boolean(draft[key])}
                    disabled={disabled}
                    onChange={event => setDrafts(previous => ({ ...previous, [element.id]: { ...previous[element.id], [key]: event.target.checked } }))}
                  />
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-violet-500"
                    value={typeof draft[key] === 'number' ? draft[key] : ''}
                    disabled={disabled}
                    onChange={event => setDrafts(previous => ({ ...previous, [element.id]: { ...previous[element.id], [key]: event.target.value === '' ? 0 : Number(event.target.value) } }))}
                  />
                ) : (
                  <input
                    type="text"
                    className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-violet-500"
                    value={typeof draft[key] === 'string' ? draft[key] : ''}
                    disabled={disabled}
                    onChange={event => setDrafts(previous => ({ ...previous, [element.id]: { ...previous[element.id], [key]: event.target.value } }))}
                  />
                )}
              </label>
            ))}
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-2">
        <span className={`truncate text-[11px] ${message ? (message.ok ? 'text-emerald-400' : 'text-rose-400') : 'text-transparent'}`}>{message?.text ?? ' '}</span>
        <button
          type="button"
          onClick={commit}
          disabled={disabled}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </div>
  );
};
