/**
 * Comic import is a thin IPC client now: archive bytes go straight to the main-process
 * vault (content-addressed, main/comicArchiveController.cjs), which parses the central
 * directory and returns the page manifest. The renderer never holds the full archive
 * nor all pages at once — pages are pulled one by one through the same bridge.
 */

import type { FormatComicResult } from '../../plugin-runtime/format-handlers';

export class ComicFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComicFormatError';
  }
}

const titleFromFileName = (name: string): string => name.replace(/\.cbz$/i, '').trim() || 'Untitled comic';

export async function parseComicFile(file: File): Promise<FormatComicResult> {
  // globalThis 探测：门禁测试在 Node 里直接调用本函数，那里没有 window。
  const bridge = typeof window !== 'undefined' ? window.artflowComic : undefined;
  if (!bridge) throw new ComicFormatError('The comic archive vault is unavailable in this environment.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await bridge.importArchive({ bytes, name: file.name });
  // 显式比较窄化：本项目未开 strictNullChecks，`!result.ok` 的真值窄化不可用（TS#12745）。
  if (result.ok === false) throw new ComicFormatError(result.message);
  return {
    kind: 'comic',
    title: titleFromFileName(file.name),
    sourceFormat: 'cbz',
    archiveRef: result.ref,
    pageNames: result.pageNames,
  };
}
