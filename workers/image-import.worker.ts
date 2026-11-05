/* Dedicated worker: decode and build the three LOD proxies without occupying
 * the renderer's event loop. Only small proxy data URLs cross the boundary;
 * the original File is read later, asynchronously, after the bitmap is closed.
 */

export interface ImageProxyWorkerRequest {
  id: number;
  file: File;
  mimeType: string;
}

export interface ImageProxyWorkerResult {
  width: number;
  height: number;
  proxyDataUrl?: string;
  mediumDataUrl?: string;
  thumbnailDataUrl?: string;
}

export type ImageProxyWorkerResponse =
  | { id: number; status: 'ready'; result: ImageProxyWorkerResult }
  | { id: number; status: 'unsupported' | 'decode-failed' | 'failed'; message: string };

interface ImageWorkerScope {
  onmessage: ((event: MessageEvent<ImageProxyWorkerRequest>) => void) | null;
  postMessage(message: ImageProxyWorkerResponse): void;
  FileReaderSync?: new () => { readAsDataURL(blob: Blob): string };
}

const scope = self as unknown as ImageWorkerScope;
const dimensions = (width: number, height: number, max: number) => {
  if (width <= max && height <= max) return null;
  const scale = Math.min(max / width, max / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

async function createProxies({ file, mimeType }: ImageProxyWorkerRequest): Promise<ImageProxyWorkerResult> {
  const reader = new scope.FileReaderSync!();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    // Some browser codecs support <img> but not createImageBitmap. Let the
    // established main-thread decoder handle only these unsupported cases.
    throw { status: 'decode-failed', message: String(error) };
  }
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const targetMime = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'image/jpeg' : 'image/png';
    const drawTier = async (max: number, quality: number, label: string): Promise<string | undefined> => {
      const size = dimensions(width, height, max);
      if (!size) return undefined;
      try {
        const canvas = new OffscreenCanvas(size.width, size.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2D canvas context unavailable');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, size.width, size.height);
        const blob = await canvas.convertToBlob({ type: targetMime, quality });
        return reader.readAsDataURL(blob);
      } catch (error) {
        // Keep the same per-tier best-effort behaviour as generateProxyDataUrls.
        console.warn(`Failed to generate ${label} in image worker:`, error);
        return undefined;
      }
    };
    const proxyDataUrl = await drawTier(1024, 0.85, '1024px proxy');
    const mediumDataUrl = await drawTier(512, 0.85, '512px medium proxy');
    const thumbnailDataUrl = await drawTier(256, 0.75, '256px thumbnail');
    return { width, height, proxyDataUrl, mediumDataUrl, thumbnailDataUrl };
  } finally {
    bitmap.close();
  }
}

// Serial work within this worker: a paste/background request must not decode
// concurrently with a multi-file drop and multiply peak bitmap allocations.
let queued: Promise<void> = Promise.resolve();
scope.onmessage = (event: MessageEvent<ImageProxyWorkerRequest>) => {
  const request = event.data;
  queued = queued.catch(() => {}).then(async () => {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined'
        || typeof scope.FileReaderSync !== 'function') {
      scope.postMessage({ id: request.id, status: 'unsupported', message: 'Offscreen image APIs are unavailable' });
      return;
    }
    try {
      scope.postMessage({ id: request.id, status: 'ready', result: await createProxies(request) });
    } catch (error) {
      const typed = error as { status?: ImageProxyWorkerResponse['status']; message?: string };
      scope.postMessage({
        id: request.id,
        status: typed?.status === 'decode-failed' ? 'decode-failed' : 'failed',
        message: typed?.message ?? String(error),
      });
    }
  });
};
