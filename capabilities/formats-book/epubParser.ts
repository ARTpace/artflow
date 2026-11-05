/**
 * Bounded EPUB-to-plain-text normalization for the trusted book plugin.
 * ponytail: this intentionally supports only the common OCF/OPF spine subset; rich EPUB layout stays out of this renderer path.
 */

import { unzip } from 'fflate';
import type { FormatReaderResult } from '../../plugin-runtime/format-handlers';
import {
  FORMAT_LIMITS,
  limitBytes,
  limitMessage,
} from '../../plugin-runtime/format-limits';
import {
  BookFormatError,
  MAX_READER_CHARACTERS,
  normalizeBookContent,
} from './bookParser';

/**
 * 源文件上限（可调）：插件参数 `maxEpubMiB`，见 plugins/format-limits.ts。
 * 下面这些**条目数/单条目字节/总文本字节护栏一律不动** —— 它们才是真正的内存闸门，
 * 放宽源文件上限只影响「读多少 ZIP 容器字节」，不影响解压后的内存上界。
 */
const epubSourceLimitBytes = () => limitBytes(FORMAT_LIMITS.epubSourceMiB);
export const MAX_EPUB_ARCHIVE_ENTRIES = 160;
export const MAX_EPUB_TEXT_ENTRIES = 64;
export const MAX_EPUB_TEXT_ENTRY_BYTES = 512 * 1024;
export const MAX_EPUB_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_EPUB_CHAPTERS = 32;

const CONTAINER_PATH = 'meta-inf/container.xml';
const TEXT_EXTENSIONS = new Set(['html', 'htm', 'opf', 'xhtml']);
const decoder = new TextDecoder('utf-8');

export interface EpubTextEntry {
  path: string;
  bytes: Uint8Array;
}

interface ParsedEpubContent {
  title?: string;
  content: string;
  characterCount: number;
  isTruncated: boolean;
  chapters: readonly { title: string; start: number }[];
}

const fileNameTitle = (name: string): string => name.replace(/\.epub$/i, '').trim() || 'Untitled book';

const extensionFor = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
};

const isTextCandidate = (path: string): boolean =>
  path.toLowerCase() === CONTAINER_PATH || TEXT_EXTENSIONS.has(extensionFor(path));

/** Rejects paths that could make package references ambiguous or point outside the archive. */
export const normalizeEpubPath = (rawPath: string, allowDirectory = false): string | null => {
  if (!rawPath || rawPath.includes('\0') || rawPath.includes('\\') || rawPath.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(rawPath)) return null;
  const hasTrailingSlash = rawPath.endsWith('/');
  if (hasTrailingSlash && !allowDirectory) return null;
  const candidate = hasTrailingSlash ? rawPath.slice(0, -1) : rawPath;
  const parts = candidate.split('/');
  if (parts.length === 0 || parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
};

const decodeXmlAttribute = (value: string): string => value.replace(/&(amp|apos|quot|lt|gt);/gi, (_match, entity: string) => ({
  amp: '&', apos: "'", quot: '"', lt: '<', gt: '>',
}[entity.toLowerCase()] ?? ''));

const readAttribute = (source: string, name: string): string | undefined => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(source);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : decodeXmlAttribute(value).trim();
};

const packageSection = (source: string, tag: string): string | undefined =>
  new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(source)?.[1];

const resolveManifestHref = (opfPath: string, rawHref: string): string | null => {
  const href = decodeXmlAttribute(rawHref).trim();
  if (!href || href.startsWith('/') || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const localHref = href.split(/[?#]/, 1)[0];
  if (!localHref) return null;
  const parent = opfPath.split('/').slice(0, -1);
  const segments = localHref.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return normalizeEpubPath([...parent, ...segments].join('/'));
};

const textFrom = (entry: EpubTextEntry): string => decoder.decode(entry.bytes);

const firstRootfilePath = (containerXml: string): string | null => {
  const rootfile = /<rootfile\b([^>]*)\/?>/i.exec(containerXml)?.[1];
  const path = rootfile ? readAttribute(rootfile, 'full-path') : undefined;
  return path ? normalizeEpubPath(path) : null;
};

const parseSpinePaths = (opfPath: string, opfXml: string): string[] => {
  const manifestXml = packageSection(opfXml, 'manifest');
  const spineXml = packageSection(opfXml, 'spine');
  if (!manifestXml || !spineXml) throw new BookFormatError('EPUB needs an OPF manifest and spine.');

  const manifest = new Map<string, string | null>();
  for (const match of manifestXml.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const id = readAttribute(match[1], 'id');
    const href = readAttribute(match[1], 'href');
    if (!id) continue;
    if (manifest.has(id)) throw new BookFormatError('EPUB manifest contains duplicate item ids.');
    const path = href ? resolveManifestHref(opfPath, href) : null;
    manifest.set(id, path && ['xhtml', 'html', 'htm'].includes(extensionFor(path)) ? path : null);
  }

  const paths: string[] = [];
  const seenPaths = new Set<string>();
  for (const match of spineXml.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const id = readAttribute(match[1], 'idref');
    if (!id || !manifest.has(id)) throw new BookFormatError('EPUB spine references a missing manifest chapter.');
    const path = manifest.get(id);
    if (!path) throw new BookFormatError('EPUB spine references an unsafe or unsupported chapter.');
    if (seenPaths.has(path)) throw new BookFormatError('EPUB spine contains duplicate chapter references.');
    seenPaths.add(path);
    paths.push(path);
    if (paths.length > MAX_EPUB_CHAPTERS) {
      throw new BookFormatError(`EPUB books are limited to ${MAX_EPUB_CHAPTERS} spine chapters.`);
    }
  }
  if (paths.length === 0) throw new BookFormatError('EPUB needs at least one XHTML or HTML spine chapter.');
  return paths;
};

const metadataTitle = (opfXml: string): string | undefined => {
  const match = /<(?:dc:)?title\b[^>]*>([\s\S]*?)<\/(?:dc:)?title\s*>/i.exec(opfXml);
  if (!match) return undefined;
  const title = normalizeBookContent(match[1], 'html').content;
  return title === 'This document is empty.' ? undefined : title;
};

const chapterHeading = (source: string, index: number): string => {
  const match = /<(?:h1|title)\b[^>]*>([\s\S]*?)<\/(?:h1|title)\s*>/i.exec(source);
  const title = match ? normalizeBookContent(match[1], 'html').content : '';
  return title && title !== 'This document is empty.' ? title : `Chapter ${index + 1}`;
};

const appendBounded = (current: string, addition: string): { content: string; truncated: boolean } => {
  const used = Array.from(current).length;
  const points = Array.from(addition);
  const remaining = MAX_READER_CHARACTERS - used;
  if (remaining <= 0) return { content: current, truncated: points.length > 0 };
  if (points.length <= remaining) return { content: current + addition, truncated: false };
  return { content: current + points.slice(0, remaining).join(''), truncated: true };
};

const unzipEpubTextEntries = async (archive: Uint8Array): Promise<Record<string, Uint8Array>> => {
  let entryCount = 0;
  let acceptedCount = 0;
  let declaredTotal = 0;
  const seenPaths = new Set<string>();
  let rejected: string | null = null;

  return new Promise((resolve, reject) => {
    unzip(archive, {
      filter: entry => {
        entryCount += 1;
        if (entryCount > MAX_EPUB_ARCHIVE_ENTRIES) {
          rejected ??= `EPUB archives are limited to ${MAX_EPUB_ARCHIVE_ENTRIES} entries.`;
          return false;
        }
        const directory = entry.name.endsWith('/');
        const normalizedPath = normalizeEpubPath(entry.name, directory);
        if (!normalizedPath) {
          rejected ??= 'EPUB archive contains an unsafe path.';
          return false;
        }
        if (seenPaths.has(normalizedPath)) {
          rejected ??= 'EPUB archive contains duplicate package paths.';
          return false;
        }
        seenPaths.add(normalizedPath);
        if (directory || !isTextCandidate(normalizedPath)) return false;
        if (!Number.isFinite(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > MAX_EPUB_TEXT_ENTRY_BYTES) {
          rejected ??= `EPUB text entries are limited to ${MAX_EPUB_TEXT_ENTRY_BYTES / 1024} KiB.`;
          return false;
        }
        if (acceptedCount >= MAX_EPUB_TEXT_ENTRIES) {
          rejected ??= `EPUB archives are limited to ${MAX_EPUB_TEXT_ENTRIES} readable package entries.`;
          return false;
        }
        if (declaredTotal + entry.originalSize > MAX_EPUB_TEXT_BYTES) {
          rejected ??= `EPUB package text is limited to ${MAX_EPUB_TEXT_BYTES / 1024 / 1024} MiB.`;
          return false;
        }
        acceptedCount += 1;
        declaredTotal += entry.originalSize;
        return true;
      },
    }, (error, files) => {
      if (rejected) {
        reject(new BookFormatError(rejected));
        return;
      }
      if (error) {
        reject(new BookFormatError('Could not read this EPUB archive.'));
        return;
      }
      resolve(files);
    });
  });
};

/** Pure bounded archive step: used by parser and binary fixtures without a browser DOM. */
export async function extractEpubTextEntries(archive: Uint8Array): Promise<EpubTextEntry[]> {
  try {
    const files = await unzipEpubTextEntries(archive);
    let actualTotal = 0;
    const entries = Object.entries(files).map(([rawPath, bytes]) => {
      const path = normalizeEpubPath(rawPath);
      if (!path || !isTextCandidate(path)) throw new BookFormatError('EPUB archive contains an unsafe package entry.');
      if (bytes.byteLength > MAX_EPUB_TEXT_ENTRY_BYTES) {
        throw new BookFormatError(`EPUB text entries are limited to ${MAX_EPUB_TEXT_ENTRY_BYTES / 1024} KiB.`);
      }
      actualTotal += bytes.byteLength;
      if (actualTotal > MAX_EPUB_TEXT_BYTES) {
        throw new BookFormatError(`EPUB package text is limited to ${MAX_EPUB_TEXT_BYTES / 1024 / 1024} MiB.`);
      }
      return { path, bytes };
    });
    return entries;
  } catch (error) {
    if (error instanceof BookFormatError) throw error;
    throw new BookFormatError('Could not read this EPUB archive.');
  }
}

export async function parseEpubArchive(archive: Uint8Array): Promise<ParsedEpubContent> {
  const entries = await extractEpubTextEntries(archive);
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
  const container = entries.find(entry => entry.path.toLowerCase() === CONTAINER_PATH);
  if (!container) throw new BookFormatError('EPUB archive is missing META-INF/container.xml.');

  const opfPath = firstRootfilePath(textFrom(container));
  const opf = opfPath ? entriesByPath.get(opfPath) : undefined;
  if (!opf || extensionFor(opf.path) !== 'opf') throw new BookFormatError('EPUB container has no readable OPF rootfile.');
  const opfXml = textFrom(opf);
  const spinePaths = parseSpinePaths(opf.path, opfXml);

  let content = '';
  let isTruncated = false;
  let readableChapters = 0;
  const chapters: { title: string; start: number }[] = [];
  for (const [index, chapterPath] of spinePaths.entries()) {
    const chapter = entriesByPath.get(chapterPath);
    if (!chapter) throw new BookFormatError('EPUB spine references a missing chapter.');
    const chapterSource = textFrom(chapter);
    const normalized = normalizeBookContent(chapterSource, 'html');
    if (normalized.content === 'This document is empty.') continue;
    const addition = `${readableChapters > 0 ? '\n\n' : ''}${chapterHeading(chapterSource, index)}\n\n${normalized.content}`;
    const appended = appendBounded(content, addition);
    if (appended.content.length > content.length) {
      chapters.push({ title: chapterHeading(chapterSource, index), start: content.length });
    }
    content = appended.content;
    isTruncated = isTruncated || normalized.isTruncated || appended.truncated;
    readableChapters += 1;
    if (appended.truncated) break;
  }
  if (readableChapters === 0 || !content.trim()) throw new BookFormatError('EPUB spine has no readable text chapters.');

  return {
    title: metadataTitle(opfXml),
    content,
    characterCount: Array.from(content).length,
    isTruncated,
    chapters,
  };
}

export async function parseEpubFile(file: File): Promise<FormatReaderResult> {
  const limit = epubSourceLimitBytes();
  if (file.size > limit) {
    throw new BookFormatError(limitMessage(FORMAT_LIMITS.epubSourceMiB, limit));
  }
  const archive = new Uint8Array(await file.arrayBuffer());
  if (archive.byteLength > limit) {
    throw new BookFormatError(limitMessage(FORMAT_LIMITS.epubSourceMiB, limit));
  }
  const parsed = await parseEpubArchive(archive);
  return {
    kind: 'reader',
    title: parsed.title ?? fileNameTitle(file.name),
    sourceFormat: 'epub',
    content: parsed.content,
    characterCount: parsed.characterCount,
    isTruncated: parsed.isTruncated,
    chapters: parsed.chapters,
  };
}
