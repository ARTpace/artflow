/** Declarative, data-only packages. No entry points, URLs, eval or arbitrary JavaScript. */
export type Scalar = string | number | boolean;
export type ExtensionData = Record<string, Scalar>;
export interface Field { type: 'string' | 'number' | 'boolean'; default: Scalar }
export interface NodeDefinition {
  id: string; version: number; title: string; width: number; height: number;
  fields: Record<string, Field>;
  migrations?: { from: number; to: number; rename: Record<string, string> }[];
}
export interface ExtensionPackage {
  manifestVersion: 2; engine: 'declarative-v1'; id: string; name: string; version: string;
  permissions: ('document.read' | 'document.write' | 'imports.parse' | 'agent.invoke')[];
  requires?: string[];
  node: NodeDefinition;
  formats: { extension: string; recipe: 'json-lines' }[];
  tools: { id: string; title: string; field: string; parameter: string; default: Scalar }[];
}
export const EXTENSION_STORE_KEY = 'artflow.extensions.v2';
export const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
export function invariant(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const safeKey = (key: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key);
const scalar = (value: unknown): value is Scalar => typeof value === 'boolean' || (typeof value === 'string' && value.length <= 8192) || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9);
const exact = (value: Record<string, unknown>, allowed: string[]) => invariant(Object.keys(value).every(key => allowed.includes(key)), 'Unknown package field; executable entries and paths are not accepted');
export function validateData(value: unknown, definition: NodeDefinition, defaults = false): ExtensionData {
  invariant(plain(value) && Object.keys(value).length <= 32, 'Node data must be a small flat record');
  const data: ExtensionData = {};
  for (const [key, entry] of Object.entries(value)) { invariant(safeKey(key) && scalar(entry), 'Invalid data key/value'); data[key] = entry; }
  for (const [key, field] of Object.entries(definition.fields)) {
    if (!(key in data) && defaults) data[key] = field.default;
    invariant(typeof data[key] === field.type && scalar(data[key]), `Invalid/missing field: ${key}`);
  }
  invariant(JSON.stringify(data).length <= 32768, 'Node data exceeds 32K characters');
  return data;
}
export function validateExtensionPackage(raw: unknown): ExtensionPackage {
  invariant(plain(raw), 'Package must be an object');
  exact(raw, ['manifestVersion', 'engine', 'id', 'name', 'version', 'permissions', 'requires', 'node', 'formats', 'tools']);
  invariant(raw.manifestVersion === 2 && raw.engine === 'declarative-v1', 'Only V2 declarative-v1 packages are supported; JS/zip entries are not executable');
  invariant(typeof raw.id === 'string' && /^ext\.[a-z0-9][a-z0-9_.-]{0,63}$/.test(raw.id), 'External package id must start with ext.');
  invariant(typeof raw.name === 'string' && raw.name.length > 0 && raw.name.length <= 80 && typeof raw.version === 'string' && /^\d+\.\d+\.\d+$/.test(raw.version), 'Invalid package name/version');
  invariant(Array.isArray(raw.permissions) && raw.permissions.length <= 4 && new Set(raw.permissions).size === raw.permissions.length && raw.permissions.every(p => ['document.read', 'document.write', 'imports.parse', 'agent.invoke'].includes(p)), 'Unsupported permission');
  invariant(raw.requires === undefined || (Array.isArray(raw.requires) && raw.requires.length <= 8 && raw.requires.every(id => typeof id === 'string' && /^ext\.[a-z0-9_.-]+$/.test(id) && id !== raw.id)), 'Invalid dependency list');
  invariant(plain(raw.node), 'Missing node definition'); const node = raw.node;
  exact(node, ['id', 'version', 'title', 'width', 'height', 'fields', 'migrations']);
  invariant(typeof node.id === 'string' && node.id.startsWith(raw.id + '.') && /^[a-z0-9_.-]+$/.test(node.id) && node.id.length <= 128, 'Node id must belong to its package');
  invariant(Number.isSafeInteger(node.version) && Number(node.version) >= 1 && Number(node.version) <= 32 && typeof node.title === 'string' && node.title.length <= 80, 'Invalid node version/title');
  invariant(typeof node.width === 'number' && node.width >= 80 && node.width <= 2000 && typeof node.height === 'number' && node.height >= 60 && node.height <= 2000, 'Invalid default geometry');
  invariant(plain(node.fields) && Object.keys(node.fields).length > 0 && Object.keys(node.fields).length <= 16, 'Invalid node fields');
  for (const [key, field] of Object.entries(node.fields)) {
    invariant(safeKey(key) && plain(field), 'Invalid field'); exact(field, ['type', 'default']);
    invariant(['string', 'number', 'boolean'].includes(String(field.type)) && typeof field.default === field.type && scalar(field.default), 'Invalid field type/default');
  }
  if (node.migrations !== undefined) {
    invariant(Array.isArray(node.migrations) && node.migrations.length <= 31, 'Invalid migrations'); const seen = new Set();
    for (const step of node.migrations) {
      invariant(plain(step), 'Invalid migration'); exact(step, ['from', 'to', 'rename']);
      invariant(Number.isSafeInteger(step.from) && Number(step.from) >= 1 && step.to === Number(step.from) + 1 && Number(step.to) <= Number(node.version) && !seen.has(step.from) && plain(step.rename), 'Invalid migration chain'); seen.add(step.from);
      invariant(Object.entries(step.rename).length <= 16 && Object.entries(step.rename).every(([a,b]) => safeKey(a) && typeof b === 'string' && safeKey(b)), 'Invalid migration rename');
    }
  }
  invariant(Array.isArray(raw.formats) && raw.formats.length <= 8, 'Invalid formats'); const extensions = new Set();
  for (const format of raw.formats) {
    invariant(plain(format), 'Invalid format'); exact(format, ['extension', 'recipe']);
    invariant(typeof format.extension === 'string' && /^[a-z0-9]{1,16}$/.test(format.extension) && format.recipe === 'json-lines' && !extensions.has(format.extension), 'Invalid/duplicate extension or recipe'); extensions.add(format.extension);
  }
  invariant(Array.isArray(raw.tools) && raw.tools.length <= 16, 'Invalid tools'); const tools = new Set();
  for (const tool of raw.tools) {
    invariant(plain(tool), 'Invalid tool'); exact(tool, ['id', 'title', 'field', 'parameter', 'default']);
    invariant(typeof tool.id === 'string' && tool.id.startsWith(raw.id + '.') && /^[a-z0-9_.-]+$/.test(tool.id) && !tools.has(tool.id), 'Invalid tool id'); tools.add(tool.id);
    invariant(typeof tool.title === 'string' && tool.title.length <= 80 && typeof tool.field === 'string' && Object.hasOwn(node.fields, tool.field) && typeof tool.parameter === 'string' && safeKey(tool.parameter), 'Invalid tool fields');
    invariant(scalar(tool.default) && typeof tool.default === (node.fields[tool.field] as Field).type, 'Invalid tool default');
  }
  invariant(JSON.stringify(raw).length <= 65536, 'Package exceeds 64K characters');
  return freeze(JSON.parse(JSON.stringify(raw)) as ExtensionPackage);
}
export interface InstalledPackage { package: ExtensionPackage; enabled: boolean; grants: string[]; previous?: ExtensionPackage }
export function readInstalled(storage: Pick<Storage, 'getItem'>): InstalledPackage[] {
  const text = storage.getItem(EXTENSION_STORE_KEY); if (!text) return [];
  invariant(text.length <= 2 * 1024 * 1024, 'Installed package inventory too large'); const raw = JSON.parse(text);
  invariant(Array.isArray(raw) && raw.length <= 16, 'Invalid installed inventory'); const ids = new Set();
  return raw.map(entry => { invariant(plain(entry) && typeof entry.enabled === 'boolean' && Array.isArray(entry.grants), 'Invalid installed package'); const pkg = validateExtensionPackage(entry.package); invariant(!ids.has(pkg.id), 'Duplicate package id'); ids.add(pkg.id);
    invariant(entry.grants.every(g => pkg.permissions.includes(g)) && new Set(entry.grants).size === entry.grants.length, 'Invalid grants');
    return { package: pkg, enabled: entry.enabled, grants: [...entry.grants], ...(entry.previous ? { previous: validateExtensionPackage(entry.previous) } : {}) }; });
}
export function writeInstalled(storage: Pick<Storage, 'setItem'>, entries: InstalledPackage[]): void {
  const encoded = JSON.stringify(entries); readInstalled({ getItem: () => encoded }); storage.setItem(EXTENSION_STORE_KEY, encoded);
}
export class ExtensionNodeRegistry {
  private readonly definitions = new Map<string, { owner: string; definition: NodeDefinition }>();
  register(owner: string, definition: NodeDefinition): () => void {
    invariant(definition.id.startsWith(owner + '.') && !this.definitions.has(definition.id), 'Duplicate/foreign node definition');
    const entry = { owner, definition }; this.definitions.set(definition.id, entry);
    return () => this.unregister(owner);
  }
  unregister(owner: string): void {
    for (const [nodeId, entry] of this.definitions) if (entry.owner === owner) this.definitions.delete(nodeId);
  }
  all(): readonly { owner: string; definition: NodeDefinition }[] { return [...this.definitions.values()]; }
  get(id: string) { return this.definitions.get(id); }
  normalize(typeId: string, version: number, raw: unknown) {
    const entry = this.get(typeId); invariant(entry, `Node plugin unavailable: ${typeId}`);
    invariant(Number.isSafeInteger(version) && version >= 1 && version <= entry.definition.version && plain(raw), 'Unsupported node schema version/data');
    let data = JSON.parse(JSON.stringify(raw));
    for (let v = version; v < entry.definition.version; v++) {
      const step = entry.definition.migrations?.find(step => step.from === v); invariant(step, 'Missing schema migration; original node retained');
      for (const [from, to] of Object.entries(step.rename)) if (Object.hasOwn(data, from) && from !== to) {
        invariant(!Object.hasOwn(data, to), 'Migration collision; original node retained'); data[to] = data[from]; delete data[from];
      }
    }
    return { typeId, schemaVersion: entry.definition.version, data: validateData(data, entry.definition, true) };
  }
}
