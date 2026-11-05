/**
 * Bounded image preparation and notification queue.
 *
 * This owns temporary HTMLImageElement references, NOT Chromium's decoded-image
 * cache or GPU textures. Byte limits are accounting estimates, not hard process
 * memory limits. No gesture/frozen flag participates in this queue.
 */
export type PreparationTier = 'thumbnail' | 'medium' | 'standard' | 'original';
export interface PreparedImageResource {
  bytes: number;
  release(): void;
}
export type PreparationResult = { ok: true } | { ok: false; reason: 'load-failed' };
export interface PreparationRequest { src: string; tier: PreparationTier }
export interface ImagePreparationQueueOptions {
  load(src: string, signal: AbortSignal): Promise<PreparedImageResource>;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  maxConcurrent?: number;
  maxCommitsPerFrame?: number;
  maxPrepared?: number;
  maxEstimatedWorkingBytes?: number;
  maxCacheBytes?: number;
  maxCacheEntries?: number;
}
export interface ImagePreparationQueue {
  request(input: PreparationRequest, listener: (result: PreparationResult) => void): () => void;
  getStats(): {
    pending: number; active: number; ready: number; waitingConsumers: number;
    cached: number; cacheBytes: number; reservedBytes: number;
    started: number; completed: number; failed: number; cancelled: number;
    cacheHits: number; sharedRequests: number; delivered: number;
  };
  dispose(): void;
}

type Status = 'queued' | 'loading' | 'ready' | 'error';
interface Entry {
  src: string;
  tier: PreparationTier;
  status: Status;
  listeners: Map<number, (result: PreparationResult) => void>;
  controller: AbortController | null;
  resource: PreparedImageResource | null;
  reservation: number;
}
const MiB = 1024 * 1024;
const estimatedBytes = (tier: PreparationTier): number =>
  tier === 'thumbnail' ? 256 * 256 * 4 : tier === 'medium' ? 512 * 512 * 4 : tier === 'standard' ? 1024 * 1024 * 4 : 32 * MiB;
const priority = (tier: PreparationTier): number => tier === 'thumbnail' ? 4 : tier === 'medium' ? 3 : tier === 'standard' ? 2 : 1;

export function createImagePreparationQueue(options: ImagePreparationQueueOptions): ImagePreparationQueue {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) && value! > 0 ? Math.max(1, Math.floor(value!)) : fallback;
  const concurrency = positive(options.maxConcurrent, 2);
  const commitsPerFrame = positive(options.maxCommitsPerFrame, 2);
  const maxPrepared = positive(options.maxPrepared, 4);
  const workingBudget = positive(options.maxEstimatedWorkingBytes, 64 * MiB);
  const cacheBudget = Math.max(0, options.maxCacheBytes ?? 32 * MiB);
  const cacheCapacity = Math.max(0, options.maxCacheEntries ?? 24);
  const entries = new Map<string, Entry>();
  const cache = new Map<string, PreparedImageResource>();
  let cacheBytes = 0;
  let active = 0;
  let reservedBytes = 0;
  let nextToken = 0;
  let disposed = false;
  let frame: number | null = null;
  const counters = { started: 0, completed: 0, failed: 0, cancelled: 0, cacheHits: 0, sharedRequests: 0, delivered: 0 };

  const release = (resource: PreparedImageResource | null) => {
    try { resource?.release(); } catch { /* resource cleanup must not stall the queue */ }
  };
  const cacheResource = (entry: Entry) => {
    const resource = entry.resource;
    entry.resource = null;
    if (!resource) return;
    if (disposed || !Number.isFinite(resource.bytes) || resource.bytes < 0
      || resource.bytes > cacheBudget || cacheCapacity === 0) {
      release(resource);
      return;
    }
    cache.set(entry.src, resource);
    cacheBytes += resource.bytes;
    while (cache.size > cacheCapacity || cacheBytes > cacheBudget) {
      const first = cache.entries().next().value as [string, PreparedImageResource];
      cache.delete(first[0]);
      cacheBytes -= first[1].bytes;
      release(first[1]);
    }
  };
  const preparedCount = () => {
    let count = 0;
    for (const entry of entries.values()) if (entry.status === 'ready' || entry.status === 'error') count++;
    return count;
  };
  const hasDeliveries = () => {
    for (const entry of entries.values()) {
      if ((entry.status === 'ready' || entry.status === 'error') && entry.listeners.size) return true;
    }
    return false;
  };
  const scheduleDelivery = () => {
    if (disposed || frame !== null || !hasDeliveries()) return;
    frame = options.requestFrame(deliver);
  };
  const pump = () => {
    if (disposed) return;
    while (active < concurrency && active + preparedCount() < maxPrepared) {
      let next: Entry | undefined;
      for (const entry of entries.values()) {
        if (entry.status !== 'queued' || entry.listeners.size === 0) continue;
        const cost = Math.min(workingBudget, estimatedBytes(entry.tier));
        if (reservedBytes + cost > workingBudget) continue;
        if (!next || priority(entry.tier) > priority(next.tier)) next = entry;
      }
      if (!next) break;
      const entry = next;
      const cached = cache.get(entry.src);
      if (cached) {
        cache.delete(entry.src);
        cacheBytes -= cached.bytes;
        entry.resource = cached;
        entry.status = 'ready';
        counters.cacheHits++;
        scheduleDelivery();
        continue;
      }
      const controller = new AbortController();
      entry.controller = controller;
      entry.status = 'loading';
      entry.reservation = Math.min(workingBudget, estimatedBytes(entry.tier));
      reservedBytes += entry.reservation;
      active++;
      counters.started++;
      // The microtask boundary also contains a synchronous throwing loader.
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('cancelled');
        return options.load(entry.src, controller.signal);
      }).then(resource => {
        if (disposed || controller.signal.aborted || entries.get(entry.src) !== entry) {
          release(resource);
          return;
        }
        entry.resource = resource;
        entry.status = 'ready';
        counters.completed++;
      }, () => {
        if (disposed || controller.signal.aborted || entries.get(entry.src) !== entry) return;
        entry.status = 'error';
        counters.failed++;
      }).finally(() => {
        active--;
        reservedBytes -= entry.reservation;
        entry.reservation = 0;
        entry.controller = null;
        scheduleDelivery();
        pump();
      });
    }
  };
  function deliver() {
    frame = null;
    if (disposed) return;
    let delivered = 0;
    // Count consumers, not URLs: 200 cards sharing one cached URL must still
    // not receive 200 href updates in one frame.
    for (const entry of entries.values()) {
      if (entry.status !== 'ready' && entry.status !== 'error') continue;
      for (const [token, listener] of entry.listeners) {
        if (delivered >= commitsPerFrame) break;
        entry.listeners.delete(token);
        delivered++;
        counters.delivered++;
        try { listener(entry.status === 'ready' ? { ok: true } : { ok: false, reason: 'load-failed' }); }
        catch { /* one detached consumer must not break others */ }
      }
      if (entry.listeners.size === 0 && entries.get(entry.src) === entry) {
        entries.delete(entry.src);
        cacheResource(entry);
      }
      if (delivered >= commitsPerFrame) break;
    }
    pump();
    scheduleDelivery();
  }

  return {
    request(input, listener) {
      if (disposed || !input.src) return () => {};
      let entry = entries.get(input.src);
      if (!entry) {
        entry = { src: input.src, tier: input.tier, status: 'queued', listeners: new Map(), controller: null, resource: null, reservation: 0 };
        entries.set(input.src, entry);
      } else {
        counters.sharedRequests++;
        if (priority(input.tier) > priority(entry.tier)) entry.tier = input.tier;
      }
      const ownEntry = entry;
      const token = ++nextToken;
      entry.listeners.set(token, listener);
      pump();
      scheduleDelivery();
      let cancelled = false;
      return () => {
        if (cancelled) return;
        cancelled = true;
        if (!ownEntry.listeners.delete(token)) return;
        if (ownEntry.listeners.size === 0 && entries.get(ownEntry.src) === ownEntry) {
          entries.delete(ownEntry.src);
          if (ownEntry.controller) {
            counters.cancelled++;
            ownEntry.controller.abort();
            // A cancelled decoder still owns its concurrency permit until its
            // promise settles. Never create an unlimited set of orphan loads.
          }
          cacheResource(ownEntry);
        }
        if (frame !== null && !hasDeliveries()) {
          options.cancelFrame(frame);
          frame = null;
        }
        pump();
      };
    },
    getStats() {
      let pending = 0, ready = 0, waitingConsumers = 0;
      for (const entry of entries.values()) {
        if (entry.status === 'queued') pending++;
        if (entry.status === 'ready' || entry.status === 'error') ready++;
        waitingConsumers += entry.listeners.size;
      }
      return { pending, active, ready, waitingConsumers, cached: cache.size, cacheBytes, reservedBytes, ...counters };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) options.cancelFrame(frame);
      frame = null;
      for (const entry of entries.values()) {
        entry.listeners.clear();
        entry.controller?.abort();
        release(entry.resource);
        entry.resource = null;
      }
      entries.clear();
      for (const resource of cache.values()) release(resource);
      cache.clear();
      cacheBytes = 0;
    },
  };
}

/** Browser loader: timeout/abort/error always settle and release listeners. */
export function prepareBrowserImage(src: string, signal: AbortSignal): Promise<PreparedImageResource> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined' || signal.aborted) {
      reject(new Error('image preparation unavailable'));
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    let settled = false;
    const clear = () => {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clear();
      image.removeAttribute('src');
      reject(new Error('image preparation failed'));
    };
    const abort = () => fail();
    const timer = setTimeout(fail, 10000);
    signal.addEventListener('abort', abort, { once: true });
    image.onerror = fail;
    image.onload = () => {
      let decoded: Promise<void>;
      try { decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve(); }
      catch { fail(); return; }
      decoded.then(() => {
        if (settled) return;
        if (signal.aborted || !image.naturalWidth || !image.naturalHeight) { fail(); return; }
        settled = true;
        clear();
        resolve({
          bytes: image.naturalWidth * image.naturalHeight * 4,
          release: () => { image.removeAttribute('src'); },
        });
      }, fail);
    };
    try { image.src = src; } catch { fail(); }
  });
}

let browserQueue: ImagePreparationQueue | undefined;
export function getImagePreparationQueue(): ImagePreparationQueue {
  if (!browserQueue) {
    browserQueue = createImagePreparationQueue({
      load: prepareBrowserImage,
      requestFrame: callback => typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(callback) : setTimeout(callback, 16) as unknown as number,
      cancelFrame: handle => typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame(handle) : clearTimeout(handle),
    });
  }
  return browserQueue;
}
