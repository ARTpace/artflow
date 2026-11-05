/** Workspace wallpapers are a visual preference of SkinEngine; only media bytes live here.
 * The studio stages Files in memory. An IndexedDB transaction saves them only on Apply.
 * Never put images/videos in localStorage or in board/project documents.
 */
import type { SkinMode } from './contributions';
import type { UiThemeSettings } from './ui-theme-settings';
import auroraLake from '../builtin-plugins/ui-skin-picker/assets/aurora-lake.webp?inline';
import sunlitClouds from '../builtin-plugins/ui-skin-picker/assets/sunlit-clouds.webp?inline';
import abyssalLight from './theme-wallpaper-assets/background-light.webp?inline';
import abyssalDark from './theme-wallpaper-assets/background-dark.webp?inline';

export interface WallpaperEntry {
  id: string;
  name: string;
  fileName: string;
  mime: string;
  kind: 'image' | 'video';
  source: 'builtin' | 'saved' | 'draft';
  tone: 'light' | 'dark' | 'any';
  family?: string;
  src?: string;           // ONLY bundled trusted images, never user-provided URL strings
  poster?: string;        // small first-frame data image for thumbnails/reduced motion
  credit?: string;
  size?: number;
}

const builtin = Object.freeze<WallpaperEntry[]>([
  { id: 'builtin.wallpaper.aurora-lake', name: '极光湖畔', fileName: 'aurora-lake.webp', mime: 'image/webp', kind: 'image', source: 'builtin', tone: 'dark', family: 'landscapes', src: auroraLake, credit: 'Artflow · AI-generated artwork' },
  { id: 'builtin.wallpaper.sunlit-clouds', name: '云上晨曦', fileName: 'sunlit-clouds.webp', mime: 'image/webp', kind: 'image', source: 'builtin', tone: 'light', family: 'landscapes', src: sunlitClouds, credit: 'Artflow · AI-generated artwork' },
  { id: 'builtin.wallpaper.abyssal-light', name: '深海人鱼谣 · 海沫白', fileName: 'abyssal-serenade-light-by-theater.webp', mime: 'image/webp', kind: 'image', source: 'builtin', tone: 'light', family: 'abyssal', src: abyssalLight, credit: '原画：theater (Theater-ahyeon) · CC-BY-NC-SA-4.0' },
  { id: 'builtin.wallpaper.abyssal-dark', name: '深海人鱼谣 · 深渊青', fileName: 'abyssal-serenade-dark-by-theater.webp', mime: 'image/webp', kind: 'image', source: 'builtin', tone: 'dark', family: 'abyssal', src: abyssalDark, credit: '原画：theater (Theater-ahyeon) · CC-BY-NC-SA-4.0' },
]);

const DB_NAME = 'bp-theme-wallpapers';
const DB_VERSION = 1;
const FORMATS: Record<string, { mime: string; kind: 'image' | 'video' }> = {
  png: { mime: 'image/png', kind: 'image' }, apng: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' }, jpeg: { mime: 'image/jpeg', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' }, gif: { mime: 'image/gif', kind: 'image' },
  avif: { mime: 'image/avif', kind: 'image' },
  mp4: { mime: 'video/mp4', kind: 'video' }, webm: { mime: 'video/webm', kind: 'video' },
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}
function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is unavailable')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Cannot open wallpaper library'));
    request.onblocked = () => reject(new Error('Wallpaper library is blocked by another window'));
  });
}

const safeEntry = (entry: unknown): WallpaperEntry | null => {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Partial<WallpaperEntry>;
  if (typeof raw.id !== 'string' || !/^user-wall-[\w-]{8,88}$/.test(raw.id) ||
      typeof raw.name !== 'string' || typeof raw.fileName !== 'string' ||
      typeof raw.mime !== 'string' || !Object.values(FORMATS).some(f => f.mime === raw.mime)) return null;
  return {
    id: raw.id, name: raw.name.slice(0, 100), fileName: raw.fileName.slice(0, 128),
    mime: raw.mime, kind: raw.mime.startsWith('video/') ? 'video' : 'image',
    source: 'saved', tone: 'any',
    poster: typeof raw.poster === 'string' && /^data:image\/(?:webp|png|jpeg);base64,/.test(raw.poster) && raw.poster.length < 250_000 ? raw.poster : undefined,
    size: typeof raw.size === 'number' && raw.size >= 0 ? raw.size : undefined,
  };
};

function posterCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 600 / Math.max(width, 1), 360 / Math.max(height, 1));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}
/** Decode one small first frame for both thumbnail and motion-safe fallback. Failure is non-fatal. */
async function firstFrame(file: File, kind: 'image' | 'video'): Promise<string | undefined> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<string | undefined>(resolve => {
      let done = false;
      const finish = (image?: HTMLImageElement | HTMLVideoElement) => {
        if (done) return;
        done = true; clearTimeout(timeout);
        try {
          const width = image instanceof HTMLVideoElement ? image.videoWidth : image?.naturalWidth;
          const height = image instanceof HTMLVideoElement ? image.videoHeight : image?.naturalHeight;
          if (image && width && height) {
            const canvas = posterCanvas(width, height);
            canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/webp', 0.74));
          } else resolve(undefined);
        } catch { resolve(undefined); }
      };
      const timeout = window.setTimeout(() => finish(), 4500);
      if (kind === 'image') {
        const image = new Image();
        image.onload = () => finish(image);
        image.onerror = () => finish();
        image.src = url;
      } else {
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.preload = 'auto';
        video.onloadeddata = () => { finish(video); video.removeAttribute('src'); video.load(); };
        video.onerror = () => { finish(); video.removeAttribute('src'); video.load(); };
        video.src = url; video.load();
      }
    });
  } finally { URL.revokeObjectURL(url); }
}

export class ThemeWallpaperStore {
  private saved: WallpaperEntry[] = [];
  private readonly drafts = new Map<string, { entry: WallpaperEntry; file: File }>();
  private entries: WallpaperEntry[] = [...builtin];
  private readonly listeners = new Set<() => void>();
  private database: Promise<IDBDatabase> | null = null;
  private loading: Promise<void> | null = null;

  constructor() {
    if (typeof indexedDB !== 'undefined') void this.ready().catch(error => console.warn('[wallpapers] library unavailable:', error));
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = (): WallpaperEntry[] => this.entries;
  get = (id: string | null): WallpaperEntry | undefined => this.entries.find(entry => entry.id === id);
  private emit() {
    this.entries = [...builtin, ...this.saved, ...[...this.drafts.values()].map(draft => draft.entry)];
    for (const listener of [...this.listeners]) listener();
  }
  private db(): Promise<IDBDatabase> { return this.database ??= openDatabase(); }
  async ready(): Promise<void> {
    if (!this.loading) this.loading = (async () => {
      const db = await this.db();
      const items = await requestResult(db.transaction('entries', 'readonly').objectStore('entries').getAll());
      this.saved = items.map(safeEntry).filter((entry): entry is WallpaperEntry => entry !== null);
      this.emit();
    })();
    return this.loading;
  }

  /** Purely in memory: selecting files never touches disk or existing appearance state. */
  async stage(file: File): Promise<WallpaperEntry> {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const format = FORMATS[extension];
    if (!format || file.size === 0 || (file.type && file.type !== format.mime && !(extension === 'apng' && file.type === 'image/apng'))) {
      throw new Error(`不支持此文件：${file.name}。请选 PNG / APNG / JPG / WebP / GIF / MP4 / WebM。`);
    }
    if (format.kind === 'video' && !document.createElement('video').canPlayType(format.mime)) {
      throw new Error(`当前环境无法解码 ${extension.toUpperCase()} 视频。`);
    }
    const id = `user-wall-${crypto.randomUUID()}`;
    const entry: WallpaperEntry = {
      id, name: file.name.replace(/\.[^.]+$/, '').slice(0, 100), fileName: file.name.slice(0, 128),
      mime: format.mime, kind: format.kind, source: 'draft', tone: 'any', size: file.size,
      poster: await firstFrame(file, format.kind),
    };
    this.drafts.set(id, { entry, file });
    this.emit();
    return entry;
  }
  forgetDraft(id: string): void { if (this.drafts.delete(id)) this.emit(); }

  /** One transaction for metadata + original bytes: no half-saved gallery on quota failure. */
  async commitDrafts(ids: readonly string[]): Promise<void> {
    const pending = ids.map(id => this.drafts.get(id)).filter((item): item is { entry: WallpaperEntry; file: File } => !!item);
    if (!pending.length) return;
    await this.ready();
    const transaction = (await this.db()).transaction(['entries', 'files'], 'readwrite');
    const result = transactionResult(transaction);
    for (const { entry, file } of pending) {
      transaction.objectStore('entries').put({ ...entry, source: 'saved' });
      transaction.objectStore('files').put({ id: entry.id, blob: file });
    }
    await result;
    for (const { entry } of pending) this.drafts.delete(entry.id);
    this.saved = [...this.saved, ...pending.map(({ entry }) => ({ ...entry, source: 'saved' as const }))];
    this.emit();
  }
  /** Used solely to roll back a newly imported asset on Undo or an interrupted Apply. */
  async removeCommitted(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const transaction = (await this.db()).transaction(['entries', 'files'], 'readwrite');
    const result = transactionResult(transaction);
    for (const id of ids) {
      if (!id.startsWith('user-wall-')) continue;
      transaction.objectStore('entries').delete(id);
      transaction.objectStore('files').delete(id);
    }
    await result;
    this.saved = this.saved.filter(entry => !ids.includes(entry.id));
    this.emit();
  }
  async blob(id: string): Promise<Blob | null> {
    const draft = this.drafts.get(id);
    if (draft) return draft.file;
    const builtIn = builtin.find(entry => entry.id === id);
    if (builtIn?.src) return (await fetch(builtIn.src)).blob();
    if (!this.saved.some(entry => entry.id === id)) await this.ready();
    if (!this.saved.some(entry => entry.id === id)) return null;
    const result = await requestResult<{ id: string; blob: Blob } | undefined>(
      (await this.db()).transaction('files', 'readonly').objectStore('files').get(id),
    );
    return result?.blob instanceof Blob ? result.blob : null;
  }
}

export const themeWallpaperStore = new ThemeWallpaperStore();

/** One lightweight runtime offset shared by the display, quick switch and studio download. */
export const wallpaperRotation = (() => {
  let offset = 0;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => offset,
    next: () => { offset++; emit(); },
    reset: () => { if (offset) { offset = 0; emit(); } },
  };
})();

/** The skin background (null) is never put into a timed playlist unless there are no assets. */
export function chooseWallpaper(settings: UiThemeSettings, entries: readonly WallpaperEntry[], mode: SkinMode, step = 0): string | null {
  const ids = new Set(entries.map(entry => entry.id));
  const followTone = settings.wallpaperAuto === 'system' || settings.wallpaperAuto === 'both';
  const base = ids.has(settings.wallpaperId ?? '') ? settings.wallpaperId : null;
  let choice = base;
  if (followTone) {
    const pairId = mode === 'light' ? settings.wallpaperLightId : settings.wallpaperDarkId;
    const paired = entries.find(entry => entry.id === base && !!entry.family);
    const sibling = paired && entries.find(entry => entry.family === paired.family && entry.tone === mode);
    choice = (pairId && ids.has(pairId) ? pairId : sibling?.id ?? base);
  }
  const rotate = settings.wallpaperAuto === 'interval' || settings.wallpaperAuto === 'both';
  if (!rotate && step === 0) return choice;
  const oppositePair = mode === 'light' ? settings.wallpaperDarkId : settings.wallpaperLightId;
  const pool: (string | null)[] = rotate
    ? entries.filter(entry => (!followTone || entry.tone === 'any' || entry.tone === mode)
      && (!followTone || entry.id !== oppositePair || entry.id === choice)).map(entry => entry.id)
    : [null, ...entries.map(entry => entry.id)];
  if (choice && !pool.includes(choice)) pool.unshift(choice);
  if (!pool.length) return choice;
  const baseIndex = Math.max(0, pool.indexOf(choice));
  return pool[((baseIndex + step) % pool.length + pool.length) % pool.length] ?? null;
}

/** Only bundled author assets are eligible when the selection follows the current skin. */
export async function currentThemeWallpaper(): Promise<Blob | null> {
  const css = getComputedStyle(document.querySelector('#root') ?? document.documentElement)
    .getPropertyValue('--bp-canvas-bg-image');
  const src = /url\(\s*['"]?(data:image\/(?:webp|png|jpeg|gif);base64,[^'"\s)]+)/i.exec(css)?.[1];
  return src ? (await fetch(src)).blob() : null;
}
