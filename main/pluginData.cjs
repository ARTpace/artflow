/**
 * Plugin-owned key-value persistence — the `api.storage.load()/save()` pair,
 * artflow's equivalent of Obsidian's `loadData()/saveData()`.
 *
 * The data file is fixed at `<plugin dir>/data.json`. The plugin cannot choose
 * the path, so there is no traversal risk and **no permission is required**:
 * it is the plugin's own directory, capped at 256 KB. `files.write` cannot
 * reach this file either — `data.json` is in `PROTECTED_FILES`.
 *
 * Semantics mirror Obsidian:
 *  - `load()` on a missing/corrupt-free missing file returns `null` (first run);
 *  - `save(data)` accepts anything JSON-serializable (top-level object expected).
 */

const path = require('node:path');
const fs = require('node:fs');

const MAX_PLUGIN_DATA_BYTES = 256 * 1024;
const DATA_FILE_NAME = 'data.json';

function pluginDataPath(pluginDir) {
  return path.join(pluginDir, DATA_FILE_NAME);
}

/**
 * Read one plugin's persisted data. Returns `null` when there is no file yet;
 * throws a readable error when the file exists but is not valid JSON (a corrupt
 * file must fail loudly — silently returning null would wipe plugin state on
 * the next save).
 */
function loadPluginData(pluginDir) {
  let text;
  try {
    text = fs.readFileSync(pluginDataPath(pluginDir), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`plugin data could not be read: ${error?.message || error}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('plugin data.json is corrupted (not valid JSON); fix or delete it before saving again');
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written data.json. */
function savePluginData(pluginDir, data) {
  let encoded;
  try {
    encoded = JSON.stringify(data ?? null);
  } catch {
    throw new Error('plugin data must be JSON serializable');
  }
  if (encoded.length > MAX_PLUGIN_DATA_BYTES) {
    throw new Error(`plugin data exceeds the ${MAX_PLUGIN_DATA_BYTES} byte limit`);
  }
  const target = pluginDataPath(pluginDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = `${target}.tmp`;
  fs.writeFileSync(tempPath, encoded);
  try {
    fs.renameSync(tempPath, target);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw new Error(`plugin data could not be written: ${error?.message || error}`);
  }
  return { bytes: Buffer.byteLength(encoded) };
}

module.exports = {
  loadPluginData,
  savePluginData,
  pluginDataPath,
  MAX_PLUGIN_DATA_BYTES,
  DATA_FILE_NAME,
};
