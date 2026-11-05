/**
 * Comic archive store: content-addressed CBZ/ZIP vault with random-access page extraction.
 * The archive file itself never reaches the renderer; pages are inflated on demand and
 * bounded by two LRU layers (open file handles + inflated page bytes).
 *
 * ZIP 随机访问采用自研 central-directory 解析（~120 行，Zip 规范是公开的），
 * 生产路径（FileHandle 分段读）与测试路径（全量 Buffer）共用同一组纯函数，不养两份真相。
 * ZIP64 / 加密条目 / 非 store+deflate 压缩一律拒收 —— 200MB 内的长篇用不到 ZIP64。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// zip 的 deflate 是 raw deflate：Node 内置 zlib 原生实现（fflate 的 CJS 主入口不导出 raw inflate）。
const { inflateRawSync } = require('node:zlib');

const MAX_COMIC_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_COMIC_PAGE_COUNT = 2000;
const MAX_COMIC_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_COMIC_ARCHIVE_ENTRIES = 20000;
const MAX_OPEN_HANDLES = 6;
const MAX_PAGE_CACHE_BYTES = 64 * 1024 * 1024;
/** EOCD + comment 的搜索窗口：EOCD 结构 22 字节 + comment 上限 65535。 */
const EOCD_SCAN_BYTES = 22 + 65535 + 64;

const EOCD_SIGNATURE = 0x06054b50;
const CDE_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;

const PAGE_MIME_BY_EXTENSION = Object.freeze({
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

const REF_PATTERN = /^[0-9a-f]{64}$/;
const naturalPageOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

class ComicArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComicArchiveError';
  }
}

const extensionFor = name => {
  const clean = String(name).split('/').pop() ?? String(name);
  const dot = clean.lastIndexOf('.');
  return dot < 0 ? '' : clean.slice(dot + 1).toLowerCase();
};

const pageMimeFor = name => PAGE_MIME_BY_EXTENSION[extensionFor(name)];

const isMetadataEntry = name =>
  name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').some(part => part === '.DS_Store');

const isPageEntry = name => !isMetadataEntry(name) && Boolean(pageMimeFor(name));

/** 读一个 LE 无符号整数；越界抛 ComicArchiveError（不可信输入的第一道闸）。
 * 手写小端而非 Buffer.readUInt32LE —— 纯函数必须同时吃 Buffer（生产句柄路径）与 Uint8Array（测试全量路径）。 */
function readU32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) throw new ComicArchiveError('comic archive is truncated');
  return ((buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0);
}

function readU16(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) throw new ComicArchiveError('comic archive is truncated');
  return buffer[offset] | (buffer[offset + 1] << 8);
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * 在文件尾窗口里定位 EOCD。EOCD 固定 22 字节（无 comment 时）+ 可变 comment，
 * 从后往前扫签名，回推 CD 的绝对偏移与尺寸。
 */
function findEOCD(tail, tailStartOffset) {
  // 最小 EOCD：签名(4) + disk(2+2) + count(2+2) + size(4) + offset(4) + commentLen(2) = 22。
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (readU32(tail, i) !== EOCD_SIGNATURE) continue;
    const cdSize = readU32(tail, i + 12);
    const cdOffset = readU32(tail, i + 16);
    const commentLength = readU16(tail, i + 20);
    if (i + 22 + commentLength !== tail.length) continue; // comment 必须恰好收尾，否则不是真 EOCD
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new ComicArchiveError('ZIP64 comic archives are not supported.');
    }
    return { cdOffset, cdSize, cdStartInTail: i, tailStartOffset };
  }
  throw new ComicArchiveError('Could not read this comic archive.');
}

/**
 * 解析 central directory。cdBuffer 是从 cdOffset 开始的 CD 区切片；
 * base 是 cdBuffer[0] 在文件里的绝对偏移（全量 Buffer 测试路径传 0）。
 */
function parseCentralDirectory(cdBuffer, base) {
  const entries = [];
  let cursor = 0;
  while (cursor + 46 <= cdBuffer.length) {
    if (readU32(cdBuffer, cursor) !== CDE_SIGNATURE) break;
    const flags = readU16(cdBuffer, cursor + 8);
    const method = readU16(cdBuffer, cursor + 10);
    const compressedSize = readU32(cdBuffer, cursor + 20);
    const uncompressedSize = readU32(cdBuffer, cursor + 24);
    const nameLength = readU16(cdBuffer, cursor + 28);
    const extraLength = readU16(cdBuffer, cursor + 30);
    const commentLength = readU16(cdBuffer, cursor + 32);
    const localHeaderOffset = readU32(cdBuffer, cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > cdBuffer.length) throw new ComicArchiveError('comic archive is truncated');
    const name = utf8Decoder.decode(cdBuffer.subarray(cursor + 46, nameEnd));
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset: base + localHeaderOffset });
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** 单条目解压。compBytes 是压缩后的原始字节。 */
function inflateComicEntry(entry, compBytes) {
  if (entry.flags & 0x1) throw new ComicArchiveError('Encrypted comic archives are not supported.');
  if (entry.uncompressedSize > MAX_COMIC_PAGE_BYTES) {
    throw new ComicArchiveError(`Each comic page is limited to ${MAX_COMIC_PAGE_BYTES / 1024 / 1024} MiB.`);
  }
  if (entry.method === 0) return compBytes.subarray(0, entry.uncompressedSize);
  if (entry.method !== 8) throw new ComicArchiveError('Unsupported compression inside the comic archive.');
  const inflated = inflateRawSync(compBytes);
  if (inflated.length !== entry.uncompressedSize) throw new ComicArchiveError('comic page inflate size mismatch');
  return inflated;
}

/**
 * 纯函数版页清单：全量档案 Buffer → 自然排序后的图片页条目。
 * 供主进程 importArchive 与门禁测试共用；生产解页走句柄按需读。
 */
function listComicPages(archive) {
  if (archive.length > MAX_COMIC_ARCHIVE_BYTES) {
    throw new ComicArchiveError(`Comic archives are limited to ${MAX_COMIC_ARCHIVE_BYTES / 1024 / 1024} MiB.`);
  }
  const tailStart = Math.max(0, archive.length - EOCD_SCAN_BYTES);
  const eocd = findEOCD(archive.subarray(tailStart), tailStart);
  const entries = parseCentralDirectory(archive.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize), 0);
  if (entries.length > MAX_COMIC_ARCHIVE_ENTRIES) {
    throw new ComicArchiveError(`Comic archives are limited to ${MAX_COMIC_ARCHIVE_ENTRIES} entries.`);
  }
  const pages = entries
    .filter(entry => isPageEntry(entry.name))
    .sort((left, right) => naturalPageOrder.compare(left.name, right.name));
  if (pages.length === 0) {
    throw new ComicArchiveError('Comic archives need at least one JPG, PNG, WEBP, GIF, or AVIF page.');
  }
  if (pages.length > MAX_COMIC_PAGE_COUNT) {
    throw new ComicArchiveError(`Comic archives are limited to ${MAX_COMIC_PAGE_COUNT} pages.`);
  }
  for (const page of pages) {
    if (page.uncompressedSize > MAX_COMIC_PAGE_BYTES) {
      throw new ComicArchiveError(`Each comic page is limited to ${MAX_COMIC_PAGE_BYTES / 1024 / 1024} MiB.`);
    }
  }
  return { pages, allEntries: entries };
}

class ComicArchiveController {
  constructor({ dir, maxOpenHandles = MAX_OPEN_HANDLES, maxPageCacheBytes = MAX_PAGE_CACHE_BYTES } = {}) {
    if (!dir) throw new ComicArchiveError('comic archive controller requires a storage dir');
    this.dir = dir;
    this.maxOpenHandles = maxOpenHandles;
    this.maxPageCacheBytes = maxPageCacheBytes;
    this.handles = new Map(); // key → { handle, pages: [{name, method, flags, compressedSize, uncompressedSize, dataOffset}] }
    this.openedPaths = new Map(); // key → 档案文件绝对路径（comic 主路径自算；插件通道由 handler 注册）
    this.pageCache = new Map(); // `key:index` → { bytes, mimeType }
    this.pageCacheBytes = 0;
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) throw new ComicArchiveError('comic archive controller is closed');
  }

  archivePath(ref) {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) throw new ComicArchiveError('comic archive reference was rejected');
    return path.join(this.dir, `${ref}.cbz`);
  }

  /** 内容寻址落盘：同字节档案天然去重。 */
  async importArchive({ bytes, name } = {}) {
    this.#assertOpen();
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? 0);
    if (source.byteLength === 0) throw new ComicArchiveError('Comic files are empty.');
    if (source.byteLength > MAX_COMIC_ARCHIVE_BYTES) {
      throw new ComicArchiveError(`Comic files are limited to ${MAX_COMIC_ARCHIVE_BYTES / 1024 / 1024} MiB.`);
    }
    await fs.promises.mkdir(this.dir, { recursive: true });
    const ref = crypto.createHash('sha256').update(source).digest('hex');
    const target = this.archivePath(ref);
    await fs.promises.writeFile(target, source, { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const { pages } = listComicPages(source);
    return {
      ref,
      pageNames: pages.map(page => page.name),
      pageCount: pages.length,
      byteSize: source.byteLength,
      originalName: typeof name === 'string' ? name.slice(0, 200) : '',
    };
  }

  /** 打开（或复用）档案句柄，并返回按自然序排列的页条目。LRU 驱逐时静默关句柄。
   * key 泛化：comic 主路径用 sha256 ref（路径自算），插件通道用 `local.xxx:<sha256>`（handler 注册路径）。 */
  async #openArchive(key) {
    const cached = this.handles.get(key);
    if (cached) {
      this.handles.delete(key);
      this.handles.set(key, cached); // 触碰 LRU 头
      return cached;
    }
    const filePath = this.openedPaths.get(key);
    if (!filePath) throw new ComicArchiveError('This comic archive is no longer available.');
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new ComicArchiveError('This comic archive is no longer available.');
    }
    if (stat.size > MAX_COMIC_ARCHIVE_BYTES) throw new ComicArchiveError('comic archive exceeds the size limit');
    const handle = await fs.promises.open(filePath, 'r');
    try {
      // 尾窗读 EOCD → CD 区读 central directory。
      const tailLength = Math.min(EOCD_SCAN_BYTES, stat.size);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, stat.size - tailLength);
      const eocd = findEOCD(tail, stat.size - tailLength);
      const cdBuffer = Buffer.alloc(eocd.cdSize);
      await handle.read(cdBuffer, 0, eocd.cdSize, eocd.cdOffset);
      const entries = parseCentralDirectory(cdBuffer, 0);
      const pages = entries
        .filter(entry => isPageEntry(entry.name))
        .sort((left, right) => naturalPageOrder.compare(left.name, right.name));
      if (pages.length === 0) throw new ComicArchiveError('This comic archive has no readable pages.');
      const opened = { handle, size: stat.size, pages };
      this.handles.set(key, opened);
      while (this.handles.size > this.maxOpenHandles) {
        const oldestKey = this.handles.keys().next().value;
        const oldest = this.handles.get(oldestKey);
        this.handles.delete(oldestKey);
        await oldest.handle.close().catch(() => {});
      }
      return opened;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  /** 注册任意路径的档案（插件通道：plugin-store 内的 .bin 即 CBZ）。幂等。 */
  registerArchivePath(key, filePath) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 300) throw new ComicArchiveError('archive key was rejected');
    if (typeof filePath !== 'string' || filePath.length === 0) throw new ComicArchiveError('archive path was rejected');
    this.openedPaths.set(key, filePath);
  }

  /** 插件通道：打开任意已注册路径的档案，返回页清单（plugin.js 用它填卡片 fields）。 */
  async openArchivePath(key, filePath) {
    this.#assertOpen();
    this.registerArchivePath(key, filePath);
    const opened = await this.#openArchive(key);
    return {
      pageNames: opened.pages.map(page => page.name),
      pageCount: opened.pages.length,
    };
  }

  /** 单页字节：句柄定位 local header → 读压缩块 → 解压 → 落页缓存。 */
  async getPage({ ref, index } = {}) {
    if (!REF_PATTERN.test(String(ref ?? ''))) throw new ComicArchiveError('comic archive reference was rejected');
    this.openedPaths.set(ref, this.archivePath(ref));
    return this.#pageByKey(ref, index);
  }

  /** 插件通道的通用页读取：key 已由调用方 registerArchivePath（或 openArchivePath）注册。 */
  async readPage(key, index) {
    this.#assertOpen();
    return this.#pageByKey(key, index);
  }

  async #pageByKey(key, index) {
    const cacheKey = `${key}:${index}`;
    const hit = this.pageCache.get(cacheKey);
    if (hit) {
      this.pageCache.delete(cacheKey);
      this.pageCache.set(cacheKey, hit);
      return { bytes: hit.bytes, mimeType: hit.mimeType };
    }
    const opened = await this.#openArchive(key);
    const pageIndex = Number(index);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= opened.pages.length) {
      throw new ComicArchiveError('comic page index is out of range');
    }
    const entry = opened.pages[pageIndex];
    // local header：签名(4) + 元数据(22) + nameLen(2) + extraLen(2) = 30；extra 长度必须读 local 自己的。
    const lfh = Buffer.alloc(30);
    await opened.handle.read(lfh, 0, 30, entry.localHeaderOffset);
    if (lfh.readUInt32LE(0) !== LFH_SIGNATURE) throw new ComicArchiveError('comic archive is corrupted');
    const nameLength = lfh.readUInt16LE(26);
    const extraLength = lfh.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const compBytes = Buffer.alloc(entry.compressedSize);
    await opened.handle.read(compBytes, 0, entry.compressedSize, dataOffset);
    const bytes = inflateComicEntry(entry, compBytes);
    const mimeType = pageMimeFor(entry.name);
    // 页缓存 LRU（字节预算）。
    while (this.pageCacheBytes + bytes.byteLength > this.maxPageCacheBytes && this.pageCache.size > 0) {
      const oldestKey = this.pageCache.keys().next().value;
      const oldest = this.pageCache.get(oldestKey);
      this.pageCache.delete(oldestKey);
      this.pageCacheBytes -= oldest.bytes.byteLength;
    }
    this.pageCache.set(cacheKey, { bytes, mimeType });
    this.pageCacheBytes += bytes.byteLength;
    return { bytes, mimeType };
  }

  async closeAll() {
    this.closed = true;
    for (const opened of this.handles.values()) await opened.handle.close().catch(() => {});
    this.handles.clear();
    this.pageCache.clear();
    this.pageCacheBytes = 0;
  }
}

module.exports = {
  ComicArchiveController,
  ComicArchiveError,
  MAX_COMIC_ARCHIVE_BYTES,
  MAX_COMIC_PAGE_COUNT,
  MAX_COMIC_PAGE_BYTES,
  MAX_COMIC_ARCHIVE_ENTRIES,
  MAX_PAGE_CACHE_BYTES,
  findEOCD,
  parseCentralDirectory,
  listComicPages,
  inflateComicEntry,
  isPageEntry,
  pageMimeFor,
};