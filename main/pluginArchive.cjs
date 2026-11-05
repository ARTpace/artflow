/**
 * Plugin archive extraction: read a .zip dropped/selected by the user and unpack it
 * into a temp directory so the existing directory-based installer can take over.
 *
 * Reuses the project's self-written ZIP central-directory parser from
 * comicArchiveController.cjs (store + raw-deflate only, no ZIP64 / encryption).
 * Plugin archives are small, so the whole file is read into memory once; the
 * per-file cap is the same 1 MiB used by the sandbox installer for plugin files.
 */

const fs = require('node:fs');
const path = require('node:path');
// 复用漫画档案的自研 ZIP 解析：findEOCD / parseCentralDirectory / inflateComicEntry。
const { findEOCD, parseCentralDirectory, inflateComicEntry } = require('./comicArchiveController.cjs');

// 与 sandboxedPlugins.cjs 的 MAX_FILE_BYTES 对齐：插件文件上限 1 MiB。
const MAX_PLUGIN_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_PLUGIN_ENTRY_BYTES = 1024 * 1024;
const MAX_PLUGIN_ENTRIES = 4000;

class PluginArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginArchiveError';
  }
}

/** 跳过 macOS 资源叉与隐藏文件：解出来也是噪音，不如直接忽略。 */
const isNoiseEntry = name =>
  name.startsWith('__MACOSX/') || name.split('/').some(part => part === '.DS_Store');

/**
 * 解压插件 zip 到 destDir。destDir 必须是调用方创建的空目录（用完自行清理）。
 * 返回 destDir；若不是合法插件包（缺 manifest / 含不安全路径）则抛 PluginArchiveError。
 */
function extractPluginZip(zipPath, destDir) {
  let stat;
  try { stat = fs.statSync(zipPath); } catch { throw new PluginArchiveError('plugin archive is not accessible'); }
  if (!stat.isFile()) throw new PluginArchiveError('plugin archive is not a file');
  if (stat.size > MAX_PLUGIN_ARCHIVE_BYTES) throw new PluginArchiveError('plugin archive is too large');

  const archive = fs.readFileSync(zipPath);
  // EOCD 固定 22 字节 + 可变 comment（上限 65535）+ 64 余量。
  const tailStart = Math.max(0, archive.length - (22 + 65535 + 64));
  const eocd = findEOCD(archive.subarray(tailStart), tailStart);
  const entries = parseCentralDirectory(
    archive.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize),
    0,
  );
  if (entries.length === 0) throw new PluginArchiveError('plugin archive is empty');
  if (entries.length > MAX_PLUGIN_ENTRIES) throw new PluginArchiveError('plugin archive has too many entries');

  let manifestFound = false;
  for (const entry of entries) {
    if (isNoiseEntry(entry.name)) continue;
    const normalized = path.normalize(entry.name);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw new PluginArchiveError('plugin archive contains an unsafe path');
    }
    if (entry.flags & 0x1) throw new PluginArchiveError('encrypted plugin archives are not supported');
    if (entry.method !== 0 && entry.method !== 8) {
      throw new PluginArchiveError('plugin archive uses an unsupported compression method');
    }
    if (entry.uncompressedSize > MAX_PLUGIN_ENTRY_BYTES) {
      throw new PluginArchiveError(`plugin file is too large: ${entry.name}`);
    }
    if (path.basename(entry.name) === 'manifest.json' && entry.name.split('/').length <= 2) {
      manifestFound = true;
    }
  }
  if (!manifestFound) {
    throw new PluginArchiveError('archive does not contain an Artflow plugin (manifest.json not found)');
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    if (isNoiseEntry(entry.name)) continue;
    const normalized = path.normalize(entry.name);
    const target = path.join(destDir, normalized);
    // 二次防御：normalize 后再确认不出界（entry 名里可能藏着 `..`）。
    if (target !== destDir && !target.startsWith(destDir + path.sep)) {
      throw new PluginArchiveError('plugin archive contains an unsafe path');
    }
    if (entry.name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    // local header：签名(4) + 元数据(22) + nameLen(2) + extraLen(2) = 30；extra 长度取 local 自己的。
    const lfh = archive.subarray(entry.localHeaderOffset, entry.localHeaderOffset + 30);
    if (lfh.readUInt32LE(0) !== 0x04034b50) throw new PluginArchiveError('plugin archive is corrupted');
    const nameLength = lfh.readUInt16LE(26);
    const extraLength = lfh.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const compBytes = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
    const bytes = inflateComicEntry(entry, compBytes);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return destDir;
}

/**
 * 从解压目录推导插件源目录：优先找根目录的 manifest.json；
 * 否则若只有一个顶层子目录且它含 manifest.json（"把插件文件夹整个打包"的常见形态），用子目录。
 * 都不是 → 返回 null（不是合法插件包）。
 */
function resolvePluginSourceDir(extractedDir) {
  if (fs.existsSync(path.join(extractedDir, 'manifest.json'))) return extractedDir;
  let entries;
  try { entries = fs.readdirSync(extractedDir, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter(entry => entry.isDirectory());
  if (dirs.length === 1 && fs.existsSync(path.join(extractedDir, dirs[0].name, 'manifest.json'))) {
    return path.join(extractedDir, dirs[0].name);
  }
  return null;
}

module.exports = { extractPluginZip, resolvePluginSourceDir, PluginArchiveError, MAX_PLUGIN_ENTRY_BYTES, isPluginSourcePath };

/**
 * 轻量判别：落点是不是一个「插件来源」（可直接交给 installFromSourcePath）。
 * 用于画布拖拽时区分「插件」与「要导入为画布资产的文件/文件夹」——
 * 避免把普通素材误装成插件，也避免把插件当素材吃进去。
 * 失败（路径不可读 / 不是 zip / 缺 manifest）一律返回 false，不抛错。
 */
function isPluginSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || sourcePath.length > 4000) return false;
  let stat;
  try { stat = fs.statSync(sourcePath); } catch { return false; }
  if (stat.isFile()) {
    if (!/\.zip$/i.test(sourcePath)) return false;
    try {
      const archive = fs.readFileSync(sourcePath);
      if (archive.length > MAX_PLUGIN_ARCHIVE_BYTES) return false;
      const tailStart = Math.max(0, archive.length - (22 + 65535 + 64));
      const eocd = findEOCD(archive.subarray(tailStart), tailStart);
      if (!eocd) return false;
      const entries = parseCentralDirectory(
        archive.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize),
        0,
      );
      // manifest.json 出现在根目录或单嵌套子目录（≤2 段路径）即视为插件包。
      return entries.some(entry => {
        if (entry.name.split('/').length > 2) return false;
        return path.basename(entry.name) === 'manifest.json';
      });
    } catch { return false; }
  }
  if (stat.isDirectory()) {
    if (fs.existsSync(path.join(sourcePath, 'manifest.json'))) return true;
    let dirs;
    try {
      dirs = fs.readdirSync(sourcePath, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch { return false; }
    if (dirs.length === 1 && fs.existsSync(path.join(sourcePath, dirs[0].name, 'manifest.json'))) return true;
    return false;
  }
  return false;
}
