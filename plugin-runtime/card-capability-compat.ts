/** In-memory migration for seeded manifests; never overwrite users' editable files. */
const LEGACY_CARD_DEPENDENCIES: Readonly<Record<string, string>> = {
  'builtin.media': 'builtin.cards-media',
  'builtin.formats-files': 'builtin.cards-files',
  'builtin.formats-reader': 'builtin.cards-reader',
};

/** Apply before both startup profile resolution and actual editable-plugin loading. */
export function normalizeCardCapabilityManifest(manifest: unknown): unknown {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return manifest;
  const record = manifest as Record<string, unknown>;
  const replacement = typeof record.id === 'string' ? LEGACY_CARD_DEPENDENCIES[record.id] : undefined;
  if (!replacement || !Array.isArray(record.requires) || !record.requires.includes('builtin.cards')) return manifest;
  return { ...record, requires: [...new Set(record.requires.map(id => id === 'builtin.cards' ? replacement : id))] };
}
