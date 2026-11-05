/**
 * Bounded, dependency-free plain reader normalization for the trusted builtin format plugin.
 * Source HTML is never rendered as markup; this module emits only React-text-safe strings.
 */

import type { FormatReaderResult } from '../../plugin-runtime/format-handlers';
import { FORMAT_LIMITS, limitBytes, limitMessage } from '../../plugin-runtime/format-limits';

/**
 * 源文件上限（可调）：插件参数 `maxTextMiB`。旧值写死 1 MiB —— Z-Library 的 txt
 * 小说动辄上兆，被 1 MiB 卡掉很常见。纯文本没有任何解压步骤，所以这里仍然最严
 * （8 MiB 默认，远低于 EPUB/MOBI），但不再小到挡住正常文件。
 * 注意 MAX_READER_CHARACTERS（12 万字符截断）是**有意的 UI 行为**，不在可调范围。
 */
export const MAX_READER_CHARACTERS = 120_000;

export class BookFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookFormatError';
  }
}

const BLOCK_END_TAG = /<\/(?:article|aside|blockquote|div|figure|figcaption|footer|h[1-6]|header|li|main|p|pre|section|table|tr|ul|ol)\s*>/gi;
const BLOCK_START_TAG = /<(?:article|aside|blockquote|div|figure|figcaption|footer|h[1-6]|header|main|p|pre|section|table|tr|ul|ol)\b[^>]*>/gi;
const BREAK_TAG = /<br\s*\/?>/gi;
const LIST_START_TAG = /<li\b[^>]*>/gi;
const STRIPPED_TAG = /<[^>]*>/g;
const REMOVED_CONTENT = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]+));/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', apos: "'", copy: '©', gt: '>', hellip: '…', laquo: '«', ldquo: '“', lsquo: '‘', lt: '<',
  mdash: '—', middot: '·', nbsp: ' ', ndash: '–', quot: '"', raquo: '»', rdquo: '”', reg: '®', rsquo: '’',
  trade: '™', bull: '•', eacute: 'é', aacute: 'á', oacute: 'ó', uacute: 'ú',
});

function decodeEntity(_match: string, hex: string | undefined, decimal: string | undefined, named: string | undefined): string {
  if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? `&${named};`;
  const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '�';
  try { return String.fromCodePoint(codePoint); } catch { return '�'; }
}

export function htmlToPlainText(source: string): string {
  return source
    .replace(COMMENTS, '')
    .replace(REMOVED_CONTENT, '')
    .replace(BREAK_TAG, '\n')
    .replace(BLOCK_END_TAG, '\n')
    .replace(LIST_START_TAG, '\n• ')
    .replace(BLOCK_START_TAG, '\n')
    .replace(STRIPPED_TAG, '')
    .replace(ENTITY, decodeEntity);
}

function normalizeParagraphs(source: string): string {
  return source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ \u00a0]+\n/g, '\n')
    .replace(/\n[ \u00a0]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateCodePoints(value: string, maximum: number): { value: string; isTruncated: boolean } {
  const points = Array.from(value);
  if (points.length <= maximum) return { value, isTruncated: false };
  return { value: points.slice(0, maximum).join(''), isTruncated: true };
}

export function normalizeBookContent(source: string, sourceFormat: 'text' | 'html'): Pick<FormatReaderResult, 'content' | 'characterCount' | 'isTruncated'> {
  const normalized = normalizeParagraphs(sourceFormat === 'html' ? htmlToPlainText(source) : source);
  const bounded = truncateCodePoints(normalized, MAX_READER_CHARACTERS);
  const content = bounded.value || 'This document is empty.';
  return { content, characterCount: Array.from(content).length, isTruncated: bounded.isTruncated };
}

function titleFromFileName(name: string): string {
  const title = name.replace(/\.[^/.]+$/, '').trim();
  return title || 'Untitled reader';
}

export function sourceFormatForFile(file: Pick<File, 'name' | 'type'>): 'text' | 'html' {
  const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  return extension === 'html' || extension === 'htm' || file.type.toLowerCase() === 'text/html' ? 'html' : 'text';
}

export async function parseBookFile(file: File): Promise<FormatReaderResult> {
  const limit = limitBytes(FORMAT_LIMITS.bookTextMiB);
  if (file.size > limit) {
    throw new BookFormatError(limitMessage(FORMAT_LIMITS.bookTextMiB, limit));
  }
  const source = await file.text();
  const sourceFormat = sourceFormatForFile(file);
  return {
    kind: 'reader',
    title: titleFromFileName(file.name),
    sourceFormat,
    ...normalizeBookContent(source, sourceFormat),
  };
}
