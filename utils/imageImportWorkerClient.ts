import type {
  ImageProxyWorkerRequest,
  ImageProxyWorkerResponse,
  ImageProxyWorkerResult,
} from '../workers/image-import.worker';
import ImageImportWorker from '../workers/image-import.worker.ts?worker&inline';

/** One decoder for the renderer. Files are structured-cloned as Blob handles,
 * not expanded into ArrayBuffers before postMessage. The worker sends only
 * bounded-size LOD previews back, never a multi-megabyte original data URL. */
let worker: Worker | null = null;
let unavailable = false;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, {
  resolve: (value: ImageProxyWorkerResult | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
const TIMEOUT_MS = 120_000;
const IDLE_TERMINATE_MS = 30_000;

function stopWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  worker?.terminate();
  worker = null;
}

function finishAll(error: Error, fallBack: boolean): void {
  stopWorker();
  unavailable = fallBack;
  for (const [id, task] of pending) {
    clearTimeout(task.timer);
    pending.delete(id);
    if (fallBack) task.resolve(null);
    else task.reject(error);
  }
}

function scheduleIdleTermination(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (pending.size) return;
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stopWorker();
  }, IDLE_TERMINATE_MS);
}

function ensureWorker(): Worker | null {
  if (unavailable || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  if (worker) return worker;
  try {
    // Inline worker avoids Vite's absolute /assets URL, which cannot resolve
    // from the packaged Electron application's file:// entry page.
    worker = new ImageImportWorker();
  } catch (error) {
    console.warn('Image import worker unavailable; using the original decoder:', error);
    unavailable = true;
    return null;
  }
  worker.onmessage = (event: MessageEvent<ImageProxyWorkerResponse>) => {
    const response = event.data;
    if (response.status === 'unsupported') {
      finishAll(new Error(response.message), true);
      return;
    }
    const task = pending.get(response.id);
    if (!task) return; // Stale completion after timeout/worker replacement.
    clearTimeout(task.timer);
    pending.delete(response.id);
    if (response.status === 'ready') task.resolve(response.result);
    else if (response.status === 'decode-failed') task.resolve(null); // Existing <img> decoder may support this format.
    else task.reject(new Error(`Image worker could not prepare this file: ${response.message}`));
    scheduleIdleTermination();
  };
  worker.onerror = event => {
    event.preventDefault();
    finishAll(new Error('Image worker crashed while preparing a file. Import stopped without decoding it again on the main thread.'), false);
  };
  worker.onmessageerror = () => {
    finishAll(new Error('Image worker returned an unreadable response. Import stopped safely.'), false);
  };
  return worker;
}

/** Null means worker support or this image codec is unavailable, so caller may
 * use the existing synchronous proxy generator. Errors are genuine failures:
 * do not immediately retry a crashed/overloaded worker on the UI thread. */
export function tryGenerateImageProxiesInWorker(file: File, mimeType: string): Promise<ImageProxyWorkerResult | null> {
  const imageWorker = ensureWorker();
  if (!imageWorker) return Promise.resolve(null);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finishAll(new Error(`Image worker timed out while preparing ${file.name}. Import stopped to keep the canvas responsive.`), false);
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      const request: ImageProxyWorkerRequest = { id, file, mimeType };
      imageWorker.postMessage(request);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      scheduleIdleTermination();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
