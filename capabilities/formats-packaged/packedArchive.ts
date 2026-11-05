/**
 * Bounded CBR / CB7 / 7Z page import.
 * ZIP containers reuse the bounded page extractor below. RAR and 7Z are accepted when
 * pages are stored without compression; compressed payloads are rejected.
 *
 * v0.2 note: CBZ 主路径已迁去主进程档案仓（main/comicArchiveController，懒加载）；
 * 这套全量 data URL 通道只服务 CBR/CB7/7Z 的 stored-only 场景。
 *
 * 源文件上限（可调）：插件参数 `maxComicMiB`，默认 128 MiB。
 * 它**刻意不与主进程档案仓的 512 MiB 对齐** —— 两条路径的内存模型根本不同：
 * 主进程按需读单页句柄（MAX_OPEN_HANDLES=6，页缓存 64 MiB），本路径把每一页都
 * 解成 data URL 全量进渲染层。此前这里写死 16 MiB、与主进程差 32 倍却无任何说明，
 * 现在统一为「同一配置缝下的两个独立档位」，至少范围一致、语义可查。
 * 真正的内存闸门是下面这三条，**不随源文件上限放宽**：页数、单页字节、总页字节。
 */
import { unzip } from 'fflate';
import type { FormatComicResult } from '../../plugin-runtime/format-handlers';
import { FORMAT_LIMITS, limitBytes, limitMessage } from '../../plugin-runtime/format-limits';
import { ComicFormatError } from '../formats-comic/comicParser';

const comicSourceLimitBytes = () => limitBytes(FORMAT_LIMITS.comicSourceMiB);
export const MAX_COMIC_ARCHIVE_ENTRIES = 96;
export const MAX_COMIC_PAGE_COUNT = 24;
export const MAX_COMIC_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_COMIC_TOTAL_PAGE_BYTES = 12 * 1024 * 1024;

export interface ExtractedComicPage {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

const PAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

const RAR4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const RAR5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const SEVEN_Z = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

export type PackedComicFormat = 'cbr' | 'cb7' | '7z';

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[index] === value);

const extensionFor = (name: string): string => {
  const clean = name.split('/').pop() ?? name;
  const dot = clean.lastIndexOf('.');
  return dot < 0 ? '' : clean.slice(dot + 1).toLowerCase();
};

const pageMimeFor = (name: string): string | undefined => PAGE_MIME_BY_EXTENSION[extensionFor(name)];

const titleFromFileName = (name: string): string => name.replace(/\.[^/.]+$/, '').trim() || 'Untitled comic';

const formatFor = (name: string): PackedComicFormat => {
  const extension = extensionFor(name);
  if (extension === 'cb7') return 'cb7';
  if (extension === '7z') return '7z';
  return 'cbr';
};

const bytesToDataUrl = (bytes: Uint8Array, mimeType: string): string => {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    let binary = '';
    const end = Math.min(bytes.length, start + chunkSize);
    for (let index = start; index < end; index += 1) binary += String.fromCharCode(bytes[index]);
    chunks.push(binary);
  }
  return `data:${mimeType};base64,${btoa(chunks.join(''))}`;
};

const unzipEligiblePages = async (archive: Uint8Array): Promise<Record<string, Uint8Array>> => {
  let entryCount = 0;
  let acceptedPages = 0;
  let declaredTotal = 0;
  let rejected: string | null = null;

  return new Promise((resolve, reject) => {
    unzip(archive, {
      filter: entry => {
        entryCount += 1;
        if (entryCount > MAX_COMIC_ARCHIVE_ENTRIES) {
          rejected ??= `Comic archives are limited to ${MAX_COMIC_ARCHIVE_ENTRIES} entries.`;
          return false;
        }
        const mimeType = pageMimeFor(entry.name);
        if (entry.name.endsWith('/') || entry.name.startsWith('__MACOSX/') || entry.name.split('/').some(part => part === '.DS_Store') || !mimeType) return false;
        if (!Number.isFinite(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > MAX_COMIC_PAGE_BYTES) {
          rejected ??= `Each comic page is limited to ${MAX_COMIC_PAGE_BYTES / 1024 / 1024} MiB.`;
          return false;
        }
        if (acceptedPages >= MAX_COMIC_PAGE_COUNT) {
          rejected ??= `Comic archives are limited to ${MAX_COMIC_PAGE_COUNT} supported image pages.`;
          return false;
        }
        if (declaredTotal + entry.originalSize > MAX_COMIC_TOTAL_PAGE_BYTES) {
          rejected ??= `Comic pages are limited to ${MAX_COMIC_TOTAL_PAGE_BYTES / 1024 / 1024} MiB in total.`;
          return false;
        }
        acceptedPages += 1;
        declaredTotal += entry.originalSize;
        return true;
      },
    }, (error, files) => {
      if (rejected) {
        reject(new ComicFormatError(rejected));
        return;
      }
      if (error) {
        reject(new ComicFormatError('Could not read this comic archive.'));
        return;
      }
      resolve(files);
    });
  });
};

/** Bounded ZIP-container extraction for the packaged-format family (CBR/CB7/7Z path). */
export async function extractComicPages(archive: Uint8Array): Promise<ExtractedComicPage[]> {
  try {
    const files = await unzipEligiblePages(archive);
    const pages = Object.entries(files)
      .map(([name, bytes]) => ({ name, bytes, mimeType: pageMimeFor(name) }))
      .filter((page): page is ExtractedComicPage => Boolean(page.mimeType))
      .sort((left, right) => new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare(left.name, right.name));
    if (pages.length === 0) throw new ComicFormatError('Comic archives need at least one JPG, PNG, WEBP, GIF, or AVIF page.');

    let actualTotal = 0;
    for (const page of pages) {
      if (page.bytes.byteLength > MAX_COMIC_PAGE_BYTES) {
        throw new ComicFormatError(`Each comic page is limited to ${MAX_COMIC_PAGE_BYTES / 1024 / 1024} MiB.`);
      }
      actualTotal += page.bytes.byteLength;
      if (actualTotal > MAX_COMIC_TOTAL_PAGE_BYTES) {
        throw new ComicFormatError(`Comic pages are limited to ${MAX_COMIC_TOTAL_PAGE_BYTES / 1024 / 1024} MiB in total.`);
      }
    }
    return pages;
  } catch (error) {
    if (error instanceof ComicFormatError) throw error;
    throw new ComicFormatError('Could not read this comic archive.');
  }
}

const readU16 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

const readU32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)) >>> 0;

const readU64 = (bytes: Uint8Array, offset: number): number => {
  const low = readU32(bytes, offset);
  const high = readU32(bytes, offset + 4);
  return high * 0x100000000 + low;
};

function readVint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let next = offset;
  for (let shift = 0; shift <= 63; shift += 7) {
    if (next >= bytes.length) throw new ComicFormatError('Could not read this RAR archive.');
    const byte = bytes[next++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, next };
  }
  throw new ComicFormatError('Could not read this RAR archive.');
}

function acceptPage(name: string, bytes: Uint8Array, pages: ExtractedComicPage[], total: { bytes: number }): void {
  const mimeType = pageMimeFor(name);
  if (!mimeType || name.endsWith('/') || name.split('/').some(part => part === '__MACOSX' || part === '.DS_Store')) return;
  if (bytes.byteLength > MAX_COMIC_PAGE_BYTES) {
    throw new ComicFormatError(`Each comic page is limited to ${MAX_COMIC_PAGE_BYTES / 1024 / 1024} MiB.`);
  }
  if (pages.length >= MAX_COMIC_PAGE_COUNT) {
    throw new ComicFormatError(`Comic archives are limited to ${MAX_COMIC_PAGE_COUNT} supported image pages.`);
  }
  if (total.bytes + bytes.byteLength > MAX_COMIC_TOTAL_PAGE_BYTES) {
    throw new ComicFormatError(`Comic pages are limited to ${MAX_COMIC_TOTAL_PAGE_BYTES / 1024 / 1024} MiB in total.`);
  }
  total.bytes += bytes.byteLength;
  pages.push({ name, mimeType, bytes });
}

function extractRar4(bytes: Uint8Array): ExtractedComicPage[] {
  const pages: ExtractedComicPage[] = [];
  const total = { bytes: 0 };
  let offset = RAR4.length;
  while (offset + 7 <= bytes.length) {
    const type = bytes[offset + 2];
    const flags = readU16(bytes, offset + 3);
    const headSize = readU16(bytes, offset + 5);
    if (headSize < 7 || offset + headSize > bytes.length) throw new ComicFormatError('Could not read this RAR archive.');
    let dataSize = 0;
    let body = offset + 7;
    if (flags & 0x8000) {
      if (headSize < 11) throw new ComicFormatError('Could not read this RAR archive.');
      dataSize = readU32(bytes, offset + 7);
      body = offset + 11;
    }
    if (type === 0x74 && (flags & 0xe0) !== 0xe0) {
      if (flags & 0x0004) throw new ComicFormatError('Encrypted RAR archives are not supported.');
      if (body + 25 > offset + headSize) throw new ComicFormatError('Could not read this RAR archive.');
      const method = bytes[body + 18];
      const nameSize = readU16(bytes, body + 19);
      let nameAt = body + 25;
      if (flags & 0x0100) nameAt += 8;
      if (nameAt + nameSize > offset + headSize) throw new ComicFormatError('Could not read this RAR archive.');
      const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(nameAt, nameAt + nameSize)).replace(/\0/g, '');
      const dataStart = offset + headSize;
      if (dataStart + dataSize > bytes.length) throw new ComicFormatError('Could not read this RAR archive.');
      if (pageMimeFor(name)) {
        if (method !== 0x30) {
          throw new ComicFormatError('This RAR archive uses compression. Save it as CBZ, or store the pages without compression.');
        }
        acceptPage(name, bytes.subarray(dataStart, dataStart + dataSize), pages, total);
      }
    }
    offset += headSize + dataSize;
  }
  return pages;
}

function extractRar5(bytes: Uint8Array): ExtractedComicPage[] {
  const pages: ExtractedComicPage[] = [];
  const total = { bytes: 0 };
  let offset = RAR5.length;
  while (offset + 5 <= bytes.length) {
    const sizeField = readVint(bytes, offset + 4);
    const bodyStart = sizeField.next;
    const bodyEnd = bodyStart + sizeField.value;
    if (bodyEnd > bytes.length || sizeField.value < 2) throw new ComicFormatError('Could not read this RAR archive.');
    const typeField = readVint(bytes, bodyStart);
    const flagsField = readVint(bytes, typeField.next);
    let cursor = flagsField.next;
    if (flagsField.value & 0x0001) cursor = readVint(bytes, cursor).next;
    let dataSize = 0;
    if (flagsField.value & 0x0002) {
      const data = readVint(bytes, cursor);
      dataSize = data.value;
      cursor = data.next;
    }
    if (typeField.value === 4) throw new ComicFormatError('Encrypted RAR archives are not supported.');
    if (typeField.value === 2) {
      const fileFlags = readVint(bytes, cursor);
      const unpacked = readVint(bytes, fileFlags.next);
      const attributes = readVint(bytes, unpacked.next);
      cursor = attributes.next;
      if (fileFlags.value & 0x0002) cursor += 4;
      if (fileFlags.value & 0x0004) cursor += 4;
      if (cursor >= bodyEnd) throw new ComicFormatError('Could not read this RAR archive.');
      const compression = readVint(bytes, cursor);
      const host = readVint(bytes, compression.next);
      const nameLength = readVint(bytes, host.next);
      const nameEnd = nameLength.next + nameLength.value;
      if (nameEnd > bodyEnd) throw new ComicFormatError('Could not read this RAR archive.');
      const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(nameLength.next, nameEnd));
      if ((fileFlags.value & 0x0001) === 0 && pageMimeFor(name)) {
        if ((compression.value & 0x3f) !== 0) {
          throw new ComicFormatError('This RAR archive uses compression. Save it as CBZ, or store the pages without compression.');
        }
        if (bodyEnd + dataSize > bytes.length) throw new ComicFormatError('Could not read this RAR archive.');
        acceptPage(name, bytes.subarray(bodyEnd, bodyEnd + dataSize), pages, total);
      }
    }
    if (typeField.value === 5) break;
    offset = bodyEnd + dataSize;
  }
  return pages;
}

function read7zNumber(bytes: Uint8Array, offset: number): { value: number; next: number } {
  if (offset >= bytes.length) throw new ComicFormatError('Could not read this 7Z archive.');
  const first = bytes[offset];
  if (first < 0x80) return { value: first, next: offset + 1 };
  let mask = 0x80;
  let value = 0;
  let next = offset + 1;
  for (let index = 0; index < 8; index += 1) {
    if ((first & mask) === 0) {
      value += (first & (mask - 1)) * (2 ** (8 * index));
      return { value, next };
    }
    if (next >= bytes.length) throw new ComicFormatError('Could not read this 7Z archive.');
    value += bytes[next++] * (2 ** (8 * index));
    mask >>= 1;
  }
  return { value, next };
}

function skip7zProperty(bytes: Uint8Array, offset: number): number {
  const size = read7zNumber(bytes, offset);
  return size.next + size.value;
}

function skipDigests(bytes: Uint8Array, offset: number, count: number): number {
  if (bytes[offset] !== 0x0a) return offset;
  let cursor = offset + 1;
  const allDefined = bytes[cursor] !== 0;
  cursor += 1;
  let defined = count;
  if (!allDefined) {
    defined = 0;
    const bitBytes = Math.ceil(count / 8);
    for (let index = 0; index < bitBytes; index += 1) {
      const bits = bytes[cursor + index] ?? 0;
      for (let bit = 0; bit < 8 && index * 8 + bit < count; bit += 1) {
        if (bits & (1 << bit)) defined += 1;
      }
    }
    cursor += bitBytes;
  }
  return cursor + defined * 4;
}

function extract7zCopy(bytes: Uint8Array): ExtractedComicPage[] {
  if (bytes.length < 32) throw new ComicFormatError('Could not read this 7Z archive.');
  const nextOffset = readU64(bytes, 12);
  const nextSize = readU64(bytes, 20);
  const headerStart = 32 + nextOffset;
  const headerEnd = headerStart + nextSize;
  if (!Number.isSafeInteger(headerEnd) || headerEnd > bytes.length) {
    throw new ComicFormatError('Could not read this 7Z archive.');
  }
  const header = bytes.subarray(headerStart, headerEnd);
  if (header[0] === 0x17) {
    throw new ComicFormatError('This 7Z archive uses a compressed header. Save it as CBZ, or use the Copy method.');
  }
  if (header[0] !== 0x01) throw new ComicFormatError('Could not read this 7Z archive.');

  let cursor = 1;
  let packPos = 0;
  const packSizes: number[] = [];
  const unpackSizes: number[] = [];
  const coderIds: number[][] = [];
  const names: string[] = [];

  const expect = (id: number) => {
    if (header[cursor] !== id) throw new ComicFormatError('Could not read this 7Z archive.');
    cursor += 1;
  };

  if (header[cursor] === 0x04) {
    cursor += 1;
    if (header[cursor] === 0x06) {
      cursor += 1;
      const pos = read7zNumber(header, cursor);
      packPos = pos.value;
      const count = read7zNumber(header, pos.next);
      cursor = count.next;
      expect(0x09);
      for (let index = 0; index < count.value; index += 1) {
        const size = read7zNumber(header, cursor);
        packSizes.push(size.value);
        cursor = size.next;
      }
      cursor = skipDigests(header, cursor, packSizes.length);
      expect(0x00);
    }
    if (header[cursor] === 0x07) {
      cursor += 1;
      expect(0x0b);
      const folders = read7zNumber(header, cursor);
      cursor = folders.next;
      if (header[cursor] !== 0x00) throw new ComicFormatError('Could not read this 7Z archive.');
      cursor += 1;
      for (let folder = 0; folder < folders.value; folder += 1) {
        const coders = read7zNumber(header, cursor);
        cursor = coders.next;
        let inStreams = 0;
        let outStreams = 0;
        for (let coder = 0; coder < coders.value; coder += 1) {
          const flags = header[cursor++];
          const idSize = flags & 0x0f;
          const id = [...header.subarray(cursor, cursor + idSize)];
          cursor += idSize;
          let coderIn = 1;
          let coderOut = 1;
          if (flags & 0x10) {
            const ins = read7zNumber(header, cursor);
            const outs = read7zNumber(header, ins.next);
            coderIn = ins.value;
            coderOut = outs.value;
            cursor = outs.next;
          }
          if (flags & 0x20) {
            const props = read7zNumber(header, cursor);
            cursor = props.next + props.value;
          }
          inStreams += coderIn;
          outStreams += coderOut;
          coderIds.push(id);
        }
        const bindPairs = inStreams - outStreams;
        for (let pair = 0; pair < bindPairs; pair += 1) {
          cursor = read7zNumber(header, cursor).next;
          cursor = read7zNumber(header, cursor).next;
        }
        const packedIndexes = inStreams - bindPairs;
        if (packedIndexes > 1) {
          for (let index = 0; index < packedIndexes; index += 1) cursor = read7zNumber(header, cursor).next;
        }
      }
      expect(0x0c);
      const unpackCount = Math.max(coderIds.length, 1);
      for (let index = 0; index < unpackCount; index += 1) {
        const size = read7zNumber(header, cursor);
        unpackSizes.push(size.value);
        cursor = size.next;
      }
      cursor = skipDigests(header, cursor, unpackSizes.length);
      expect(0x00);
    }
    if (header[cursor] === 0x08) {
      throw new ComicFormatError('This 7Z archive splits pages inside one folder. Save it as CBZ, or store each page with the Copy method.');
    }
    expect(0x00);
  }

  if (header[cursor] === 0x05) {
    cursor += 1;
    const files = read7zNumber(header, cursor);
    cursor = files.next;
    while (cursor < header.length && header[cursor] !== 0x00) {
      const property = header[cursor++];
      const size = read7zNumber(header, cursor);
      const dataStart = size.next;
      const dataEnd = dataStart + size.value;
      if (property === 0x11 && header[dataStart] === 0x00) {
        const raw = header.subarray(dataStart + 1, dataEnd);
        let name = '';
        for (let index = 0; index + 1 < raw.length; index += 2) {
          const code = raw[index] | (raw[index + 1] << 8);
          if (code === 0) {
            names.push(name);
            name = '';
          } else {
            name += String.fromCharCode(code);
          }
        }
        if (name) names.push(name);
      }
      cursor = dataEnd;
    }
  }

  if (coderIds.some(id => id.length !== 1 || id[0] !== 0x00)) {
    throw new ComicFormatError('This 7Z archive uses compression. Save it as CBZ, or use the Copy method.');
  }
  if (packSizes.length === 0 || packSizes.length !== unpackSizes.length) {
    throw new ComicFormatError('Could not read this 7Z archive.');
  }

  const pages: ExtractedComicPage[] = [];
  const total = { bytes: 0 };
  let dataCursor = 32 + packPos;
  const labels = names.length === packSizes.length ? names : packSizes.map((_size, index) => `page-${index + 1}.bin`);
  for (let index = 0; index < packSizes.length; index += 1) {
    const size = packSizes[index];
    if (size !== unpackSizes[index] || dataCursor + size > headerStart) {
      throw new ComicFormatError('Could not read this 7Z archive.');
    }
    acceptPage(labels[index] ?? `page-${index + 1}.bin`, bytes.subarray(dataCursor, dataCursor + size), pages, total);
    dataCursor += size;
  }
  return pages;
}

function extractPackedPages(bytes: Uint8Array): ExtractedComicPage[] {
  if (startsWith(bytes, [0x50, 0x4b])) return [];
  if (startsWith(bytes, RAR4)) return extractRar4(bytes);
  if (startsWith(bytes, RAR5)) return extractRar5(bytes);
  if (startsWith(bytes, SEVEN_Z)) return extract7zCopy(bytes);
  throw new ComicFormatError('Could not read this comic archive.');
}

const order = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export async function parsePackedComicBytes(bytes: Uint8Array, fileName: string): Promise<FormatComicResult> {
  const limit = comicSourceLimitBytes();
  if (bytes.byteLength > limit) {
    throw new ComicFormatError(limitMessage(FORMAT_LIMITS.comicSourceMiB, limit));
  }
  const pages = startsWith(bytes, [0x50, 0x4b])
    ? await extractComicPages(bytes)
    : extractPackedPages(bytes).sort((left, right) => order.compare(left.name, right.name));
  if (pages.length === 0) throw new ComicFormatError('Comic archives need at least one JPG, PNG, WEBP, GIF, or AVIF page.');
  return {
    kind: 'comic',
    title: titleFromFileName(fileName),
    pages: pages.map(page => bytesToDataUrl(page.bytes, page.mimeType)),
    sourceFormat: formatFor(fileName),
  };
}

export async function parsePackedComicFile(file: File): Promise<FormatComicResult> {
  const limit = comicSourceLimitBytes();
  if (file.size > limit) {
    throw new ComicFormatError(limitMessage(FORMAT_LIMITS.comicSourceMiB, limit));
  }
  return parsePackedComicBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}
