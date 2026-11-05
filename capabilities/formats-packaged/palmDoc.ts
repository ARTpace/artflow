/**
 * Bounded PalmDOC reader for MOBI / AZW / AZW3.
 * Uncompressed and PalmDOC-compressed text become plain reader content.
 * Huff/CDIC and encrypted records are rejected instead of guessed.
 */

import type { FormatReaderResult } from '../../plugin-runtime/format-handlers';
import {
  FORMAT_LIMITS,
  limitBytes,
  limitMessage,
} from '../../plugin-runtime/format-limits';
import { BookFormatError, normalizeBookContent } from '../formats-book/bookParser';
import { chaptersFromPlainText } from '../formats-book/readerOutline';

/**
 * 源文件上限（可调）：插件参数 `maxPalmMiB`。
 * 旧值是写死的 8 MiB —— 比 EPUB 还严，却没有任何安全理由支撑：真正的内存闸门是下面
 * 的 MAX_TEXT_BYTES（解压后文本 4 MiB）与 MAX_TEXT_RECORDS，源文件上限卡 8 MiB
 * 反而把大量正常中文 mobi 挡在门外。现在默认 32 MiB，可调至 256 MiB。
 */
const palmSourceLimitBytes = () => limitBytes(FORMAT_LIMITS.palmSourceMiB);
/** 以下护栏不动：它们才是解压后内存的真正上界。 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_RECORDS = 512;

const HEADING_TAG = /<h([1-6])\b[^>]*>/gi;

const readU16 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const readU32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)) >>> 0;

const sourceFormatFor = (name: string): 'mobi' | 'azw' | 'azw3' => {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'azw') return 'azw';
  if (extension === 'azw3') return 'azw3';
  return 'mobi';
};

const titleFromFileName = (name: string): string => name.replace(/\.[^/.]+$/, '').trim() || 'Untitled reader';

function decompressPalmDoc(input: Uint8Array, expectedBytes: number): Uint8Array {
  const out = new Uint8Array(expectedBytes);
  let written = 0;
  let index = 0;
  const push = (value: number) => {
    if (written < expectedBytes) out[written++] = value & 0xff;
  };
  while (index < input.length && written < expectedBytes) {
    const code = input[index++];
    if (code >= 1 && code <= 8) {
      const end = Math.min(input.length, index + code);
      while (index < end && written < expectedBytes) push(input[index++]);
    } else if (code <= 0x7f) {
      push(code);
    } else if (code >= 0xc0) {
      push(0x20);
      push(code ^ 0x80);
    } else {
      if (index >= input.length) break;
      const next = input[index++];
      const distance = (((code << 8) | next) >> 3) & 0x7ff;
      const length = (next & 0x07) + 3;
      if (distance === 0 || distance > written) break;
      for (let copy = 0; copy < length && written < expectedBytes; copy += 1) {
        push(out[written - distance]);
      }
    }
  }
  return out.subarray(0, written);
}

/** Strip MOBI per-record trailers so back-references stay inside the real text. */
function stripMobiTrailers(record: Uint8Array, extraFlags: number): Uint8Array {
  let data = record;
  let flag = extraFlags >>> 1;
  let entries = 0;
  while (flag) {
    if (flag & 1) entries += 1;
    flag >>>= 1;
  }
  for (let entry = 0; entry < entries && data.length > 0; entry += 1) {
    let size = 0;
    for (let shift = 0; data.length > 0; shift += 7) {
      const marker = data[data.length - 1];
      data = data.subarray(0, data.length - 1);
      size |= (marker & 0x7f) << shift;
      if ((marker & 0x80) === 0) break;
    }
    if (size > data.length) return record.subarray(0, 0);
    data = data.subarray(0, data.length - size);
  }
  if ((extraFlags & 1) && data.length > 0) {
    const overlap = data[data.length - 1];
    const cut = 1 + overlap;
    if (cut <= data.length) data = data.subarray(0, data.length - cut);
  }
  return data;
}

function readRecord(bytes: Uint8Array, offsets: readonly number[], index: number): Uint8Array {
  const start = offsets[index];
  const end = index + 1 < offsets.length ? offsets[index + 1] : bytes.length;
  if (start === undefined || end < start || end > bytes.length) {
    throw new BookFormatError('This Palm document has a broken record table.');
  }
  return bytes.subarray(start, end);
}

function decodeText(bytes: Uint8Array, encoding: number): string {
  if (encoding === 65001 || encoding === 0) return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return new TextDecoder('windows-1252', { fatal: false }).decode(bytes);
}

function withHeadingMarkers(source: string): string {
  return source.replace(HEADING_TAG, (_match, level: string) => `\n${'#'.repeat(Number(level))} `);
}

export function parsePalmDocBytes(bytes: Uint8Array, fileName: string): FormatReaderResult {
  const limit = palmSourceLimitBytes();
  if (bytes.byteLength < 80 || bytes.byteLength > limit) {
    throw new BookFormatError(limitMessage(FORMAT_LIMITS.palmSourceMiB, limit));
  }
  const recordCount = readU16(bytes, 76);
  if (recordCount < 2 || recordCount > 4096 || 78 + recordCount * 8 > bytes.length) {
    throw new BookFormatError('This Palm document has a broken record table.');
  }
  const offsets: number[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    offsets.push(readU32(bytes, 78 + index * 8));
  }
  const header = readRecord(bytes, offsets, 0);
  if (header.length < 16) throw new BookFormatError('This Palm document has no text header.');
  const compression = readU16(header, 0);
  const textLength = readU32(header, 4);
  const textRecords = readU16(header, 8);
  const encryption = readU16(header, 12);
  if (encryption !== 0) throw new BookFormatError('Encrypted Palm documents are not supported.');
  if (compression !== 1 && compression !== 2) {
    throw new BookFormatError('This file uses Huff/CDIC or KF8 compression, which this reader does not decode.');
  }
  if (textRecords < 1 || textRecords > MAX_TEXT_RECORDS || textLength > MAX_TEXT_BYTES || 1 + textRecords > offsets.length) {
    throw new BookFormatError('This Palm document exceeds the reader text limit.');
  }

  let encoding = 65001;
  let extraFlags = 0;
  let fullName = '';
  if (header.length >= 20 && String.fromCharCode(header[16], header[17], header[18], header[19]) === 'MOBI') {
    const mobiLength = readU32(header, 20);
    if (mobiLength >= 16 && 16 + 12 < header.length) encoding = readU32(header, 16 + 12);
    if (mobiLength >= 76 && 16 + 68 + 8 <= header.length) {
      const nameOffset = readU32(header, 16 + 68);
      const nameLength = readU32(header, 16 + 72);
      if (nameLength > 0 && nameLength <= 512 && nameOffset + nameLength <= header.length) {
        fullName = new TextDecoder('utf-8', { fatal: false }).decode(header.subarray(nameOffset, nameOffset + nameLength)).replace(/\0/g, '').trim();
      }
    }
    if (mobiLength >= 0xf4 && header.length >= 0xf4) extraFlags = readU16(header, 0xf2);
  }

  const parts: Uint8Array[] = [];
  let produced = 0;
  for (let index = 1; index <= textRecords; index += 1) {
    let record = readRecord(bytes, offsets, index);
    if (extraFlags) record = stripMobiTrailers(record, extraFlags);
    const chunk = compression === 2 ? decompressPalmDoc(record, textLength - produced) : record.subarray(0, Math.max(0, textLength - produced));
    parts.push(chunk);
    produced += chunk.length;
    if (produced >= textLength) break;
  }
  const joined = new Uint8Array(Math.min(produced, textLength));
  let cursor = 0;
  for (const part of parts) {
    const take = Math.min(part.length, joined.length - cursor);
    joined.set(part.subarray(0, take), cursor);
    cursor += take;
  }
  const raw = decodeText(joined.subarray(0, cursor), encoding);
  const looksLikeHtml = /<\s*(?:html|body|p|div|h[1-6]|br)\b/i.test(raw);
  const sourceFormat = sourceFormatFor(fileName);
  const normalized = normalizeBookContent(looksLikeHtml ? withHeadingMarkers(raw) : raw, looksLikeHtml ? 'html' : 'text');
  const chapters = chaptersFromPlainText(normalized.content);
  return {
    kind: 'reader',
    title: fullName || titleFromFileName(fileName),
    sourceFormat,
    ...normalized,
    ...(chapters.length >= 2 ? { chapters } : {}),
  };
}

export async function parsePalmFile(file: File): Promise<FormatReaderResult> {
  const limit = palmSourceLimitBytes();
  if (file.size > limit) {
    throw new BookFormatError(limitMessage(FORMAT_LIMITS.palmSourceMiB, limit));
  }
  return parsePalmDocBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}
