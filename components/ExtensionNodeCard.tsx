import React, { useSyncExternalStore } from 'react';
import {
  getExtensionNodeAvailability, getExtensionRendererSnapshot, subscribeExtensionRenderer,
} from '../plugin-runtime/extension-renderer';
import { extensionSchemaProvider } from '../plugin-runtime/extension-renderer';
import type { Element } from '../types';

const displayValue = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
};

/**
 * Generic schema-driven preview for declarative extension nodes.
 * No per-extension component: the host renders whatever the installed schema declares.
 */
export const ExtensionNodeCard: React.FC<{ element: Element; isSelected?: boolean }> = ({ element, isSelected }) => {
  useSyncExternalStore(subscribeExtensionRenderer, getExtensionRendererSnapshot);
  const record = element as unknown as Record<string, unknown>;
  const availability = getExtensionNodeAvailability(element.type);
  const stored = record.extensionData as Record<string, unknown> | undefined;
  const storedVersion = typeof record.extensionSchemaVersion === 'number' ? record.extensionSchemaVersion : undefined;
  const schema = extensionSchemaProvider(element.type);
  const width = typeof record.width === 'number' ? record.width : 200;
  const height = typeof record.height === 'number' ? record.height : 120;

  const frame: React.CSSProperties = {
    width: '100%', height: '100%', borderRadius: 10, border: `2px solid ${isSelected ? '#8b5cf6' : '#3f3f46'}`,
    background: availability === 'available' ? 'linear-gradient(160deg, #1c1917 0%, #292524 100%)' : 'repeating-linear-gradient(45deg, #18181b, #18181b 12px, #1f1f23 12px, #1f1f23 24px)',
    color: '#e4e4e7', padding: '10px 12px', boxSizing: 'border-box', overflow: 'hidden',
    display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  };

  if (availability !== 'available') {
    return (
      <div style={frame} data-extension-missing={availability}>
        <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden>⚠️</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{element.type}</span>
        </div>
        <div style={{ fontSize: 11, color: '#a1a1aa' }}>
          {availability === 'disabled' ? 'Extension is installed but disabled — node data is preserved.' : 'Extension is not installed — node data is preserved.'}
        </div>
        {stored && Object.keys(stored).length > 0 && (
          <pre style={{ margin: 0, fontSize: 10, color: '#71717a', overflow: 'hidden', whiteSpace: 'pre-wrap', maxHeight: '40%' }}>{JSON.stringify(stored).slice(0, 220)}</pre>
        )}
      </div>
    );
  }

  const entries = Object.entries(schema.fields);
  return (
    <div style={frame} data-extension-node={schema.typeId} data-schema-version={schema.version}>
      <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {schema.title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, overflow: 'hidden' }}>
        {entries.slice(0, 6).map(([key, field]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
            <span style={{ color: '#a1a1aa', flexShrink: 0 }}>{key}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stored && key in stored ? displayValue(stored[key]) : field.default !== undefined ? displayValue(field.default) : '—'}</span>
          </div>
        ))}
      </div>
      {storedVersion !== undefined && storedVersion !== schema.version && (
        <div style={{ fontSize: 10, color: '#fbbf24' }}>v{storedVersion} → v{schema.version} (migrates on next edit)</div>
      )}
    </div>
  );
};
