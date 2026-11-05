/**
 * Check the *next* image against the renderer heap at the time it is read.
 * The full drop is intentionally never size-capped: the importer releases its
 * temporary batch and rechecks memory before advancing to the next file.
 * A hard heap guard is still necessary when even one image cannot fit.
 */
const MiB = 1024 * 1024;

export interface ImportHeapSnapshot {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface ImageImportBudget {
  allowed: boolean;
  sourceBytes: number;
  reason?: 'low-heap';
  message?: string;
}

/** Pass only the next image (not the entire drop). An unavailable heap API cannot be trusted as a limit. */
export const assessImageImportBudget = (
  images: readonly Pick<File, 'size'>[],
  heap?: ImportHeapSnapshot | null,
): ImageImportBudget => {
  const sourceBytes = images.reduce((sum, file) => sum + (Number.isFinite(file.size) && file.size > 0 ? file.size : 0), 0);
  const limit = heap?.jsHeapSizeLimit ?? 0;
  const used = heap?.usedJSHeapSize ?? 0;
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && used > 0 && sourceBytes > 0) {
    const free = limit - used;
    // FileReader's base64 and decoded image/derivative preparation need headroom
    // beyond the compressed file itself. This is free-heap based, not a fixed
    // permitted import or drop size. Keep room for React to render the result.
    const needed = Math.max(256 * MiB, sourceBytes * 2.2 + 96 * MiB);
    if (free < needed) {
      return {
        allowed: false,
        sourceBytes,
        reason: 'low-heap',
        message: `Browser memory is nearly full (${Math.round(used / MiB)}/${Math.round(limit / MiB)} MB). Import stopped before reading the next image; images already placed remain on the canvas. Save your work and free memory before retrying the remaining files.`,
      };
    }
  }
  return { allowed: true, sourceBytes };
};
