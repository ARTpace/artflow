import type { Element, TextElement } from '../types';
import {
  DocumentServiceError, MAX_OPERATION_NODES,
  type DocumentOperation, type ExtensionNodeCreateInput, type ExtensionNodeFieldSchema, type ExtensionNodeSchema, type ExtensionScalarValue, type ExtensionSchemaProvider, type GeometryPatch, type TextNodeInput,
} from './document-contract';
const fail = (message: string): never => { throw new DocumentServiceError('INVALID_REQUEST', message); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const newId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) fail('Unexpected operation fields'); };
const safeDataKey = (key: string) => /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key);
const scalarValue = (value: unknown): value is ExtensionScalarValue =>
  typeof value === 'boolean'
  || (typeof value === 'string' && value.length > 0 && value.length <= 8192)
  || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9);
const extensionTypeId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('ext.') && /^[a-z0-9_.-]{4,128}$/.test(value);
const MAX_EXTENSION_DATA_BYTES = 16 * 1024;

function validateExtensionData(value: unknown, budget: { used: number }): Record<string, ExtensionScalarValue> {
  if (!plain(value)) fail('Extension data must be an object');
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 32) fail('Extension data requires 1..32 keys');
  const data: Record<string, ExtensionScalarValue> = {};
  for (const [key, entry] of entries) {
    if (!safeDataKey(key)) fail('Invalid extension data key');
    if (Object.hasOwn(data, key)) fail('Duplicate extension data key');
    if (!scalarValue(entry)) fail(`Invalid extension data value: ${key}`);
    data[key] = entry;
  }
  const bytes = JSON.stringify(data).length;
  if (bytes > MAX_EXTENSION_DATA_BYTES) throw new DocumentServiceError('LIMIT_EXCEEDED', 'Extension data exceeds 16K characters');
  budget.used += bytes;
  if (budget.used > MAX_EXTENSION_DATA_BYTES) throw new DocumentServiceError('LIMIT_EXCEEDED', 'Transaction extension data budget exceeded');
  return data;
}
/** Validate and detach input before dedupe or state-dependent planning. */
export function normalizeDocumentOperations(raw: unknown): DocumentOperation[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPERATION_NODES) throw new DocumentServiceError('LIMIT_EXCEEDED', 'Operations require 1..1000 nodes');
  const seen = new Set<string>(); let points = 0, textLength = 0; const extensionBudget = { used: 0 };
  return raw.map(value => {
    if (!plain(value)) fail('Operation must be an object');
    const nodeId = (value.kind === 'node.createText' || value.kind === 'extension.node.create') && plain(value.node) ? value.node.id : value.id;
    if (!(value.kind === 'node.createText' || value.kind === 'extension.node.create' ? newId(nodeId) : id(nodeId)) || seen.has(nodeId as string)) fail('Invalid or duplicate operation node id');
    const operationId = nodeId as string;
    seen.add(operationId);
    if (value.kind === 'node.createText') {
      keys(value, ['kind', 'node']); const node = value.node;
      if (!plain(node)) fail('Text node must be an object');
      keys(node, ['id', 'text', 'x', 'y', 'width', 'height', 'fontSize', 'fontColor', 'parentId']);
      if (typeof node.text !== 'string' || node.text.length > 65536 || !finite(node.x) || !finite(node.y) || !finite(node.width) || node.width <= 0 || !finite(node.height) || node.height <= 0) fail('Invalid text/geometry');
      if (node.fontSize !== undefined && (!finite(node.fontSize) || node.fontSize < 1 || node.fontSize > 1024)) fail('Invalid font size');
      if (node.fontColor !== undefined && (typeof node.fontColor !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(node.fontColor))) fail('Font color must be a hex color');
      if (node.parentId !== undefined && !id(node.parentId)) fail('Invalid parent id');
      textLength += node.text.length;
      if (textLength > 131072) throw new DocumentServiceError('LIMIT_EXCEEDED', 'Transaction text exceeds 128K characters');
      return { kind: 'node.createText', node: { ...node } as unknown as TextNodeInput };
    }
    if (value.kind === 'node.delete') { keys(value, ['kind', 'id']); return { kind: 'node.delete', id: operationId }; }
    if (value.kind === 'node.reparent') {
      keys(value, ['kind', 'id', 'parentId']);
      if (value.parentId !== null && !id(value.parentId)) fail('Invalid parent id');
      return { kind: 'node.reparent', id: operationId, parentId: value.parentId as string | null };
    }
    if (value.kind === 'extension.node.create') {
      keys(value, ['kind', 'node']); const node = value.node;
      if (!plain(node)) fail('Extension node must be an object');
      keys(node, ['id', 'typeId', 'x', 'y', 'width', 'height', 'parentId', 'data']);
      if (!extensionTypeId(node.typeId)) fail('Extension type id must be ext.*');
      if (node.x !== undefined && !finite(node.x)) fail('Invalid extension x');
      if (node.y !== undefined && !finite(node.y)) fail('Invalid extension y');
      for (const field of ['width', 'height'] as const) if (node[field] !== undefined && (!finite(node[field]) || (node[field] as number) < 1 || (node[field] as number) > 2000)) fail(`Invalid extension ${field}`);
      if (node.parentId !== undefined && !id(node.parentId)) fail('Invalid parent id');
      const data = node.data === undefined ? undefined : validateExtensionData(node.data, extensionBudget);
      const input: ExtensionNodeCreateInput = {
        id: operationId, typeId: node.typeId,
        ...(node.x === undefined ? {} : { x: node.x }),
        ...(node.y === undefined ? {} : { y: node.y }),
        ...(node.width === undefined ? {} : { width: node.width }),
        ...(node.height === undefined ? {} : { height: node.height }),
        ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
        ...(data === undefined ? {} : { data }),
      };
      return { kind: 'extension.node.create', node: input };
    }
    if (value.kind === 'extension.node.update') {
      keys(value, ['kind', 'id', 'data']);
      return { kind: 'extension.node.update', id: operationId, data: validateExtensionData(value.data, extensionBudget) };
    }
    if (value.kind !== 'node.patchGeometry' || !plain(value.patch)) fail('Unsupported document operation');
    keys(value, ['kind', 'id', 'patch']); const patch: GeometryPatch = {};
    for (const [key, entry] of Object.entries(value.patch)) {
      if (key === 'points') {
        if (!Array.isArray(entry) || entry.length > 4096 || entry.some(point => !plain(point) || Object.keys(point).some(k => k !== 'x' && k !== 'y') || !finite(point.x) || !finite(point.y))) fail('Invalid point geometry');
        const validated = entry as { x: number; y: number }[];
        points += validated.length; if (points > 32768) throw new DocumentServiceError('LIMIT_EXCEEDED', 'Transaction point budget exceeded');
        patch.points = validated.map(point => ({ x: point.x, y: point.y }));
      } else {
        if (!['x', 'y', 'width', 'height'].includes(key) || !finite(entry) || ((key === 'width' || key === 'height') && entry <= 0)) fail(`Unsupported geometry patch: ${key}`);
        (patch as Record<string, unknown>)[key] = entry;
      }
    }
    if (!Object.keys(patch).length) fail('Empty patch');
    return { kind: 'node.patchGeometry', id: operationId, patch };
  });
}
function editable(node: Element, nodes: Map<string, Element>) {
  const visited = new Set<string>(); let current: Element | undefined = node;
  while (current) {
    if (visited.has(current.id)) fail('Existing parent cycle'); visited.add(current.id);
    if (current.isLocked) fail('Node or ancestor is locked');
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
}
function schemaFor(schemas: ExtensionSchemaProvider | undefined, typeId: string): ExtensionNodeSchema {
  const schema = schemas?.(typeId);
  if (!schema || schema.typeId !== typeId) throw new DocumentServiceError('NOT_FOUND', `Node type unavailable (extension disabled or not installed): ${typeId}`);
  return schema;
}
function dataMatchesSchema(schema: ExtensionNodeSchema, data: Record<string, ExtensionScalarValue>): void {
  for (const [key, value] of Object.entries(data)) {
    const field: ExtensionNodeFieldSchema | undefined = (schema.fields as Record<string, ExtensionNodeFieldSchema>)[key];
    if (!field) fail(`Unknown extension field: ${key}`);
    if (typeof value !== field.type) fail(`Extension field ${key} expects ${field.type}`);
  }
}
function elementDataRecord(element: Element): { data: Record<string, ExtensionScalarValue>; version: number } | undefined {
  const record = element as unknown as Record<string, unknown>;
  if (!plain(record.extensionData)) return undefined;
  const version = record.extensionSchemaVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return undefined;
  const data: Record<string, ExtensionScalarValue> = {};
  for (const [key, value] of Object.entries(record.extensionData)) if (scalarValue(value)) data[key] = value;
  return { data, version };
}
/** Pure plan: no live mutation or asset disposal; one eventual history entry owns the whole batch. */
export function planDocumentOperations(before: readonly Element[], operations: readonly DocumentOperation[], schemas?: ExtensionSchemaProvider) {
  const original = new Map(before.map(node => [node.id, node]));
  if (original.size !== before.length) fail('Duplicate node identity in document');
  const next = new Map(original); let topologyChanged = false;
  for (const operation of operations) {
    if (operation.kind === 'node.createText') {
      if (next.has(operation.node.id)) fail('Node id already exists');
      const node: TextElement = { ...operation.node, type: 'text', fontSize: operation.node.fontSize ?? 20, fontColor: operation.node.fontColor ?? '#ffffff' };
      next.set(node.id, node); topologyChanged = true; continue;
    }
    if (operation.kind === 'extension.node.create') {
      if (next.has(operation.node.id)) fail('Node id already exists');
      const schema = schemaFor(schemas, operation.node.typeId);
      const data = operation.node.data ? { ...operation.node.data } : {};
      dataMatchesSchema(schema, data);
      const node = {
        id: operation.node.id,
        type: operation.node.typeId,
        x: operation.node.x ?? 0,
        y: operation.node.y ?? 0,
        width: operation.node.width ?? schema.defaultWidth,
        height: operation.node.height ?? schema.defaultHeight,
        ...(operation.node.parentId ? { parentId: operation.node.parentId } : {}),
        extensionData: data,
        extensionSchemaVersion: schema.version,
      };
      next.set(node.id, node as unknown as Element); topologyChanged = true; continue;
    }
    if (operation.kind === 'extension.node.update') {
      const node = original.get(operation.id);
      if (!node) throw new DocumentServiceError('NOT_FOUND', `Node not found: ${operation.id}`);
      const stored = elementDataRecord(node);
      if (!stored) fail('Target is not a schema-managed extension node');
      const schema = schemaFor(schemas, node.type);
      const data = { ...stored.data }; let version = stored.version;
      // Lazy migration on first touch: old stored versions are upgraded in place, never dropped.
      if (version < schema.version) {
        for (let step = version; step < schema.version; step++) {
          const migration = schema.migrations?.find(candidate => candidate.from === step);
          if (!migration) fail(`Missing schema migration ${step}→${step + 1} for stale extension node`);
          for (const [from, to] of Object.entries(migration.rename)) {
            if (from in data && !(to in data)) { data[to] = data[from]; delete data[from]; }
          }
        }
        version = schema.version;
      }
      if (version !== schema.version) fail('Extension node schema is newer than the installed package; data is preserved');
      dataMatchesSchema(schema, operation.data);
      editable(node, original);
      next.set(node.id, { ...node, extensionData: { ...data, ...operation.data }, extensionSchemaVersion: version } as unknown as Element);
      continue;
    }
    const node = original.get(operation.id);
    if (!node) throw new DocumentServiceError('NOT_FOUND', `Node not found: ${operation.id}`);
    editable(node, original);
    if (operation.kind === 'node.delete') { next.delete(node.id); topologyChanged = true; continue; }
    if (operation.kind === 'node.reparent') {
      const parentId = operation.parentId ?? undefined;
      if (parentId !== node.parentId) next.set(node.id, { ...node, parentId });
      topologyChanged = true; continue;
    }
    const patch = operation.patch;
    if (node.type === 'group') fail('Group transforms require a dedicated descendant-aware operation');
    for (const key of Object.keys(patch)) if (!(key in node)) fail(`Unsupported geometry field: ${key}`);
    if (patch.points && (!('points' in node) || patch.points.length !== node.points.length)) fail('Point count must remain unchanged');
    if (!Object.entries(patch).every(([key, value]) => JSON.stringify((node as unknown as Record<string, unknown>)[key]) === JSON.stringify(value))) next.set(node.id, { ...node, ...patch } as Element);
  }
  if (topologyChanged) {
    // No implicit cascade or orphan promotion: callers explicitly delete/reparent descendants.
    for (const node of next.values()) {
      if (!node.parentId) continue;
      const parent = next.get(node.parentId);
      if (!parent || (parent.type !== 'group' && parent.type !== 'frame')) fail('Parent must be an existing group/frame; detach children before deleting their parent');
      if (original.get(node.id)?.parentId !== node.parentId) editable(parent, original);
    }
    // Iterative coloring avoids stack overflow for deeply nested documents.
    const done = new Set<string>();
    for (const node of next.values()) {
      const path = new Set<string>(); let cursor: Element | undefined = node;
      while (cursor && !done.has(cursor.id)) {
        if (path.has(cursor.id)) fail('Reparent would create a cycle');
        path.add(cursor.id); cursor = cursor.parentId ? next.get(cursor.parentId) : undefined;
      }
      for (const visited of path) done.add(visited);
    }
  }
  const affectedIds = [...new Set([...original.keys(), ...next.keys()])].filter(id => original.get(id) !== next.get(id));
  return { next: [...next.values()], affectedIds, deletedIds: [...original.keys()].filter(id => !next.has(id)) };
}
