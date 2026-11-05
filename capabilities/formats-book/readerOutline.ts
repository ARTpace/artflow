/** Chapter offsets inside already-normalized reader text. EPUB spine chapters stay authoritative when present. */

export interface ReaderOutlineEntry {
  title: string;
  start: number;
}

const CHAPTER_LINE = /^(?:#{1,6}\s+\S.{0,78}|第[0-9０-９一二三四五六七八九十百千零〇两]+[章节回部篇卷].{0,40}|Chapter\s+\d+\b.{0,60})$/i;

export function chaptersFromPlainText(content: string): ReaderOutlineEntry[] {
  const chapters: ReaderOutlineEntry[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    const title = line.trim().replace(/^#{1,6}\s+/, '');
    if (title.length > 0 && title.length <= 80 && CHAPTER_LINE.test(line.trim())) {
      chapters.push({ title, start: offset });
    }
    offset += line.length + 1;
    if (chapters.length >= 80) break;
  }
  return chapters;
}

export function readerChapters(
  content: string,
  stored: readonly { title: string; start: number }[] | undefined,
): ReaderOutlineEntry[] {
  if (!stored || stored.length < 2) return chaptersFromPlainText(content);
  const chapters: ReaderOutlineEntry[] = [];
  for (const chapter of stored) {
    if (typeof chapter.title !== 'string' || !chapter.title.trim()) continue;
    if (!Number.isInteger(chapter.start) || chapter.start < 0 || chapter.start > content.length) continue;
    if (chapters.length > 0 && chapter.start < chapters[chapters.length - 1].start) continue;
    chapters.push({ title: chapter.title.trim(), start: chapter.start });
    if (chapters.length >= 80) break;
  }
  return chapters.length >= 2 ? chapters : chaptersFromPlainText(content);
}
