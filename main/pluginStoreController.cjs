/**
 * Per-plugin content-addressed byte vault (unrestricted plugin data channel).
 * plugin.js stores raw bytes during parse (e.g. a 200MB CBZ) and gets a ref;
 * the matching client.js component reads them back by ref. Cross-plugin reads
 * are rejected: the pluginId is bound at both write and read time.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_STORED_BYTES = 512 * 1024 * 1024;
const PLUGIN_ID_PATTERN = /^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const REF_PATTERN = /^[0-9a-f]{64}$/;

class PluginStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginStoreError';
  }
}

class PluginStoreController {
  constructor({ dir, maxStoredBytes = MAX_STORED_BYTES } = {}) {
    if (!dir) throw new PluginStoreError('plugin store requires a storage dir');
    this.dir = dir;
    this.maxStoredBytes = maxStoredBytes;
  }

  #assertId(pluginId) {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new PluginStoreError('plugin id was rejected');
    }
  }

  pluginPath(pluginId, ref) {
    this.#assertId(pluginId);
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) throw new PluginStoreError('stored data reference was rejected');
    // 双层锚定：pluginId 子目录 + ref 文件名，任何穿越尝试都会被两个正则与 join 语义拒掉。
    return path.join(this.dir, pluginId, `${ref}.bin`);
  }

  /** 内容寻址落盘：同字节去重，写入原子（wx 失败视为已存在）。 */
  async store({ pluginId, bytes } = {}) {
    this.#assertId(pluginId);
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? 0);
    if (source.byteLength === 0) throw new PluginStoreError('stored bytes are empty');
    if (source.byteLength > this.maxStoredBytes) {
      throw new PluginStoreError(`stored bytes are limited to ${this.maxStoredBytes / 1024 / 1024} MiB.`);
    }
    const ref = crypto.createHash('sha256').update(source).digest('hex');
    const target = this.pluginPath(pluginId, ref);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, source, { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    return { ref, byteSize: source.byteLength };
  }

  /** 按 ref 读回（强制调用方 pluginId 与落盘时的子目录一致）。 */
  async read({ pluginId, ref } = {}) {
    const target = this.pluginPath(pluginId, ref);
    let stat;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      throw new PluginStoreError('stored data is missing');
    }
    if (!stat.isFile() || stat.size > this.maxStoredBytes) throw new PluginStoreError('stored data is missing or too large');
    const bytes = await fs.promises.readFile(target);
    return { bytes, byteSize: bytes.byteLength };
  }
}

module.exports = { PluginStoreController, PluginStoreError, MAX_STORED_BYTES, PLUGIN_ID_PATTERN, REF_PATTERN };
