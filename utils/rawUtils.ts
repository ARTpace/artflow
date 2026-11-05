import UTIF from 'utif';

const RAW_EXTENSIONS = new Set([
    'raw', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw', 'kdc', 'mrw'
]);

export const isRawFile = (file: File): boolean => {
    if (!file) return false;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    return RAW_EXTENSIONS.has(ext);
};

/**
 * Searches for embedded JPEG streams within the RAW container (CR2, CR3, NEF, ARW, RAF, ORF, RW2, DNG).
 * Selects the largest embedded JPEG (usually the full-resolution preview).
 */
export const extractEmbeddedJpegFromRaw = (buffer: ArrayBuffer): Blob | null => {
    const data = new Uint8Array(buffer);
    let largestJpeg: { start: number; end: number; size: number } | null = null;

    let i = 0;
    const len = data.length - 4;

    while (i < len) {
        // Look for JPEG SOI marker (0xFF, 0xD8, 0xFF)
        if (data[i] === 0xff && data[i + 1] === 0xd8 && data[i + 2] === 0xff) {
            const start = i;
            let end = -1;
            // Search for EOI (0xFF, 0xD9)
            for (let j = start + 4; j < data.length - 1; j++) {
                if (data[j] === 0xff && data[j + 1] === 0xd9) {
                    end = j + 2;
                    break;
                }
            }

            if (end !== -1) {
                const size = end - start;
                // Minimum size for a valid high quality preview (e.g. > 30KB)
                if (size > 30000 && (!largestJpeg || size > largestJpeg.size)) {
                    largestJpeg = { start, end, size };
                }
                i = end;
                continue;
            }
        }
        i++;
    }

    if (largestJpeg) {
        const slice = data.slice(largestJpeg.start, largestJpeg.end);
        return new Blob([slice], { type: 'image/jpeg' });
    }

    return null;
};

export const parseRawFile = async (file: File): Promise<{ dataUrl: string; width: number; height: number }> => {
    const buffer = await file.arrayBuffer();

    // 1. Try extracting largest embedded preview JPEG
    const embeddedBlob = extractEmbeddedJpegFromRaw(buffer);
    if (embeddedBlob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result as string;
                const img = new Image();
                img.onload = () => {
                    resolve({
                        dataUrl,
                        width: img.naturalWidth || img.width,
                        height: img.naturalHeight || img.height,
                    });
                };
                img.onerror = () => reject(new Error('Failed to load embedded preview image.'));
                img.src = dataUrl;
            };
            reader.onerror = reject;
            reader.readAsDataURL(embeddedBlob);
        });
    }

    // 2. Fallback to UTIF decode (especially for DNG and TIFF-based RAW)
    try {
        const ifds = UTIF.decode(buffer);
        if (ifds && ifds.length > 0) {
            // Find IFD with largest dimension
            let bestIfd = ifds[0];
            for (const ifd of ifds) {
                if ((ifd.width || 0) * (ifd.height || 0) > (bestIfd.width || 0) * (bestIfd.height || 0)) {
                    bestIfd = ifd;
                }
            }
            UTIF.decodeImage(buffer, bestIfd);
            const rgba = UTIF.toRGBA8(bestIfd);
            const width = bestIfd.width;
            const height = bestIfd.height;

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                const imgData = ctx.createImageData(width, height);
                imgData.data.set(rgba);
                ctx.putImageData(imgData, 0, 0);
                return {
                    dataUrl: canvas.toDataURL('image/png'),
                    width,
                    height,
                };
            }
        }
    } catch (e) {
        console.warn('UTIF failed to decode RAW:', e);
    }

    throw new Error(`Failed to parse RAW camera file: ${file.name}`);
};
