/* Bounded working set for a single drop. These are flush targets, never limits on
 * how much a user may drop or how many items a project may contain. A file larger
 * than the target is processed alone, subject only to actual memory headroom. */
const MiB = 1024 * 1024;
export const IMPORT_BATCH_TARGET_BYTES = 24 * MiB;
export const IMPORT_BATCH_MAX_ITEMS = 8;

export const shouldFlushImportBatch = (assetCount: number, sourceBytes: number): boolean =>
  assetCount >= IMPORT_BATCH_MAX_ITEMS || sourceBytes >= IMPORT_BATCH_TARGET_BYTES;

type Anchor = { x: number; y: number };
type Position = { x: number; y: number; w: number; h: number };
type ImportItem = { type: string; width: number; height: number };

/**
 * Incremental, non-overlapping masonry. Column count is fixed by the number of
 * incoming files, not by accumulated image data; page-producing handlers may
 * add more than one item per file. Top anchoring avoids shifting already placed
 * elements (and rewriting undo history) whenever a later image finishes decoding.
 */
export function createImportMasonry(fileCount: number, anchor: Anchor): { place: (item: ImportItem) => Position } {
  const GAP = 15;
  const COLUMN_WIDTH = 400;
  const columns = Math.max(1, Math.ceil(Math.sqrt(fileCount)));
  const heights = new Array<number>(columns).fill(0);
  const totalWidth = columns * COLUMN_WIDTH + (columns - 1) * GAP;
  const left = anchor.x - totalWidth / 2;
  const top = anchor.y - COLUMN_WIDTH / 2;

  return {
    place(item) {
      const lowest = Math.min(...heights);
      const column = heights.indexOf(lowest);
      let height = COLUMN_WIDTH * Math.max(1, item.height) / Math.max(1, item.width);
      switch (item.type) {
        case 'audio': height = 96; break;
        case 'bookmark':
        case 'file': height = 130; break;
        case 'font': height = 180; break;
        case 'markdown': height = 260; break;
        case 'code': height = 280; break;
        case 'reader': height = 520; break;
        case 'comic': height = 560; break;
        case 'model3d': height = 320; break;
      }
      const position = { x: left + column * (COLUMN_WIDTH + GAP), y: top + lowest, w: COLUMN_WIDTH, h: height };
      heights[column] += height + GAP;
      return position;
    },
  };
}
