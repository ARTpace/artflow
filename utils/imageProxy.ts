/**
 * utils/imageProxy.ts —— PureRef-grade Multi-tier Image LOD & LRU Cache System (REQ-003 / R36).
 *
 * Implements:
 * 1. 256px thumbnail proxy + 512px medium proxy + 1024px standard display proxy contracts.
 * 2. Multi-tier LOD resolution by screen pixels:
 *    - ≤ 256px on screen: 256px thumbnail proxy
 *    - ≤ 512px on screen: 512px medium proxy (texture budget for dense multi-tile views)
 *    - ≤ 1024px on screen: 1024px standard display proxy
 *    - > 1024px on screen, static and admitted: full-resolution original (backed by LRU budget)
 * 3. Original-image admission limits: 50 images and 128 MiB estimated decoded RGBA bytes.
 *    This is an application admission budget, not a browser/GPU memory hard limit.
 * 4. Pure offline, zero-backend processing.
 */

import { useState, useEffect, useMemo } from 'react';

export const IMAGE_LOD_CONSTANTS = {
  THUMBNAIL_MAX_DIMENSION: 256,
  /**
   * 中档代理长边。
   *
   * 为什么需要它：标准档是**固定 1024px**。"一屏几百张高清图"的场景里，
   * 每张卡片在屏幕上只有 150~500px，却各自持有一张 1024px 纹理
   * （300 张 ≈ 0.9GB 显存），pan/zoom 的合成与（换档后的）重栅格都付这份钱。
   * 中档 512px 把这一档的纹理像素量降到 1/4，屏幕像素需求（≤512）下视觉无损。
   */
  MEDIUM_PROXY_MAX_DIMENSION: 512,
  STANDARD_PROXY_MAX_DIMENSION: 1024,
  FULL_RES_LRU_CAPACITY: 50,
  FULL_RES_DECODED_BYTE_BUDGET: 128 * 1024 * 1024,
  HIGH_RES_IDLE_DELAY_MS: 180,
  FAR_ZOOM_THRESHOLD: 0.25,
  DETAIL_ZOOM_THRESHOLD: 1.0,
  /**
   * 需要原图的**屏幕像素**门槛：标准代理的长边就是 1024，
   * 所以图片在屏幕上最长的边不超过 1024px 时，代理已经比屏幕需要的信息还多。
   *
   * 为什么不再用缩放级别来决定准入：`zoom > 1` 与"这一张图到底需不需要更多像素"
   * 没有关系 —— 一张很小的缩略卡片在 zoom=2 时依然只需要几百像素。
   * 按缩放级别放行会让整屏图片同时抢配额（容量只有 50），引发"准入 → 驱逐 → 再准入"的连锁。
   */
  FULL_RES_DISPLAY_PX_THRESHOLD: 1024,
  /**
   * 这里刻意**没有**档位滞回带。
   *
   * 曾经加过 ±15% 的滞回，用来消掉"门槛附近来回缩放 → 档位反复切"。但滞回必须
   * 记住"上一次的档位"，而这份记忆只存在于 LOD hook 内部（useRef）——
   * CanvasElement 的 memo 比较函数看不到它。于是 memo 用"纯门槛"判定、
   * hook 用"带滞回"判定，两个口径不同源：**滞回窗口内的那次升档会被 memo 当成
   * "档位没变"直接拦掉**，href 于是永远停在滞回前的值（糊着不换）。
   *
   * 真正的抖动缓解来自"按屏幕像素选档"本身：旧口径的门槛是**全局缩放级别**，
   * 门槛附近抖动会让整屏图片同时换档；按像素选档后每张图有自己的门槛，
   * 抖动只波及正停在门槛上的那一张。波及面已经小到不需要滞回。
   */
  THUMBNAIL_QUALITY: 0.75,
  PROXY_QUALITY: 0.85,
} as const;

export type ImageLODTier = 'thumbnail' | 'medium' | 'standard' | 'original';

export interface ImageLODResolutionOptions {
  zoom: number;
  isInteracting?: boolean;
  href: string;
  thumbnailHref?: string;
  mediumHref?: string;
  originalHref?: string;
  isHighResAdmitted?: boolean;
  /**
   * 元素的世界坐标尺寸。给了就按"屏幕像素需求"选档（推荐口径）；
   * 不给则退回按缩放级别选档（兼容没有尺寸信息的调用点）。
   */
  width?: number;
  height?: number;
}

export interface ImageLODResult {
  src: string;
  tier: ImageLODTier;
}

/**
 * Computes proportionally scaled dimensions clamped to maxDimension without upscaling.
 */
export function computeScaledDimensions(
  origWidth: number,
  origHeight: number,
  maxDimension: number
): { width: number; height: number; scaled: boolean } {
  if (origWidth <= 0 || origHeight <= 0) {
    return { width: Math.max(1, origWidth || 0), height: Math.max(1, origHeight || 0), scaled: false };
  }
  if (origWidth <= maxDimension && origHeight <= maxDimension) {
    return { width: Math.round(origWidth), height: Math.round(origHeight), scaled: false };
  }
  const ratio = Math.min(maxDimension / origWidth, maxDimension / origHeight);
  return {
    width: Math.max(1, Math.round(origWidth * ratio)),
    height: Math.max(1, Math.round(origHeight * ratio)),
    scaled: true,
  };
}

export interface ImageLODTierInput {
  /** 图片在屏幕上的最长边（CSS 像素）= 世界最长边 × zoom。 */
  screenLongest: number;
  hasThumbnail: boolean;
  hasMedium?: boolean;
  hasOriginal: boolean;
  isHighResAdmitted: boolean;
  enabled?: boolean;
  isInteracting?: boolean;
}

/**
 * 按"屏幕需要多少像素"选档（纯函数，**无历史状态**）。
 *
 * 选档原则是"够用且最小"：屏幕上只需要 200px，就不该拿 1024 的代理去画。
 * 这样既省解码也省纹理，更重要的是**让换档逐图分散**。
 *
 * 旧口径是全局缩放级别（zoom < 0.25 全缩略图 / zoom > 1 全原图）：门槛一旦跨过，
 * 屏幕上所有图会同时换 href（实测 300 张图一轮约 180ms 的解码停顿）。
 * 按屏幕像素选档后，每张图有自己的门槛（取决于它自己的世界尺寸），
 * 同一时刻只有"屏幕像素正好跨过门槛"的那几张需要换 —— 换档从"整屏同步"变成"逐图分散"。
 *
 * 刻意保持无历史状态：memo 的比较函数与 LOD hook 必须各自独立算出同样的结果。
 * 任何"上一次的档位"这类记忆都只有 hook 看得到，会让 memo 拿另一套口径拦掉重绘
 * （见 IMAGE_LOD_CONSTANTS 里关于滞回的说明）。
 */
export const resolveImageLODTier = ({
  screenLongest,
  hasThumbnail,
  hasMedium = false,
  hasOriginal,
  isHighResAdmitted,
  enabled = true,
  isInteracting = false,
}: ImageLODTierInput): ImageLODTier => {
  if (!enabled) return 'standard';
  if (!Number.isFinite(screenLongest) || screenLongest <= 0) {
    return hasThumbnail ? 'thumbnail' : 'standard';
  }

  const thumbBoundary = IMAGE_LOD_CONSTANTS.THUMBNAIL_MAX_DIMENSION;
  const mediumBoundary = IMAGE_LOD_CONSTANTS.MEDIUM_PROXY_MAX_DIMENSION;
  const originalBoundary = IMAGE_LOD_CONSTANTS.STANDARD_PROXY_MAX_DIMENSION;

  // 屏幕上连缩略图的原生尺寸都用不满 → 用缩略图。
  if (screenLongest <= thumbBoundary) return hasThumbnail ? 'thumbnail' : 'standard';
  // 交互中不升原图：拖动/缩放时换纹理只会让画面闪，而且此时换档没有任何收益。
  // 中档不受此限制——它在手势中比 1024 标准档更省，降级到手势中是有收益的。
  if (screenLongest <= mediumBoundary) return hasMedium ? 'medium' : 'standard';
  // 交互中不升原图（中档档已在上面按屏幕像素给出）。
  if (isInteracting) return 'standard';
  if (!hasOriginal || !isHighResAdmitted) return 'standard';
  // 屏幕上要画的像素已经超出标准代理的能力 → 才值得换成原图。
  return screenLongest >= originalBoundary ? 'original' : 'standard';
};

/**
 * Pure LOD resolution logic: determines which image URL to render based on zoom level,
 * interaction state, and LRU admission status.
 */
export function resolveImageLODSource(options: ImageLODResolutionOptions): ImageLODResult {
  const {
    zoom,
    isInteracting,
    href,
    thumbnailHref,
    mediumHref,
    originalHref,
    isHighResAdmitted,
    width,
    height,
  } = options;

  // 首选口径：尺寸已知时按"屏幕像素需求"选档（"够用且最小"）。
  // 这比"按全局缩放级别整屏换档"精确得多，也让换档逐图分散。
  if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
    const tier = resolveImageLODTier({
      screenLongest: getImageDisplayLongestEdge(width, height, zoom),
      hasThumbnail: Boolean(thumbnailHref),
      hasMedium: Boolean(mediumHref),
      hasOriginal: Boolean(originalHref),
      isHighResAdmitted: isHighResAdmitted !== false,
      isInteracting,
    });
    if (tier === 'thumbnail' && thumbnailHref) return { src: thumbnailHref, tier: 'thumbnail' };
    if (tier === 'medium' && mediumHref) return { src: mediumHref, tier: 'medium' };
    if (tier === 'original' && originalHref) return { src: originalHref, tier: 'original' };
    return { src: href, tier: 'standard' };
  }

  // 兜底口径：没有尺寸信息时沿用按缩放级别的语义（既有调用点保持行为不变）。

  // Far zoom has priority over interaction: never promote a thumbnail to a
  // larger standard proxy merely because the user starts dragging.
  // Missing thumbnails safely fall back to the standard source.
  // 1. Far zoom (< 0.25): use lightweight 256px thumbnail if available
  if (zoom < IMAGE_LOD_CONSTANTS.FAR_ZOOM_THRESHOLD) {
    if (thumbnailHref) {
      return { src: thumbnailHref, tier: 'thumbnail' };
    }
    return { src: href, tier: 'standard' };
  }

  // 2. Interaction caps detail at the standard proxy, but preserves far LOD above.
  if (isInteracting) {
    return { src: href, tier: 'standard' };
  }

  // 3. Detail zoom (> 1.0): use full-res original if available and admitted by LRU cache
  if (zoom > IMAGE_LOD_CONSTANTS.DETAIL_ZOOM_THRESHOLD) {
    if (originalHref && isHighResAdmitted !== false) {
      return { src: originalHref, tier: 'original' };
    }
    return { src: href, tier: 'standard' };
  }

  // 4. Standard zoom (0.25 <= zoom <= 1.0): use 1024px standard proxy
  return { src: href, tier: 'standard' };
}

/**
 * 图片在屏幕上的最长边（CSS 像素）。
 * 元素尺寸是世界单位，只有乘上相机缩放，才是它实际占用多少屏幕像素。
 */
export const getImageDisplayLongestEdge = (width: number, height: number, zoom: number): number => {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return 0;
  if (!Number.isFinite(zoom) || zoom <= 0) return 0;
  return longest * zoom;
};

/**
 * 这张图在当前缩放下，屏幕像素是否已经超出标准代理能提供的像素量。
 * 用于 memo 判断"是否需要重渲染来换 LOD"——必须与准入判定共用同一个门槛，
 * 否则会出现"准入变了但卡片不重绘"（或反之）的错位。
 */
export const exceedsFullResolutionDisplayBudget = (width: number, height: number, zoom: number): boolean =>
  getImageDisplayLongestEdge(width, height, zoom) > IMAGE_LOD_CONSTANTS.FULL_RES_DISPLAY_PX_THRESHOLD;

/**
 * 这张图在当前缩放下，是否"值得"换成原图 —— 纯几何判定，memo 与准入共用。
 *
 * 两个条件都必要：
 * 1. 屏幕像素确实超过标准代理能给的（否则代理已经够用，换原图是纯浪费）；
 * 2. 缩放已进入细节档（与 resolveImageLODSource 的语义保持一致，
 *    否则会出现"占着配额却渲染不出原图"的错配）。
 */
export const isFullResolutionWantedAtZoom = (width: number, height: number, zoom: number): boolean =>
  zoom > IMAGE_LOD_CONSTANTS.DETAIL_ZOOM_THRESHOLD
  && exceedsFullResolutionDisplayBudget(width, height, zoom);

export interface FullResolutionAdmissionInput {
  enabled?: boolean;
  isInteracting?: boolean;
  hasOriginal: boolean;
  /** 元素的世界坐标尺寸与当前缩放。 */
  width: number;
  height: number;
  zoom: number;
}

/**
 * 原图准入判定（纯函数，便于自检）。
 *
 * 准入看的是"屏幕需要多少像素"，而不是"缩放级别"：
 * 一张小卡片在 zoom=3 时依然只需要几百像素，不该去抢那 50 个配额。
 * 交互中一律不准入（拖动/缩放时换纹理只会让画面闪）。
 */
export const shouldAdmitFullResolution = ({
  enabled = true,
  isInteracting = false,
  hasOriginal,
  width,
  height,
  zoom,
}: FullResolutionAdmissionInput): boolean => {
  if (!enabled || isInteracting || !hasOriginal) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(zoom)) return false;
  return isFullResolutionWantedAtZoom(width, height, zoom);
};

/** 采样模式：放大时用 `auto`（不插值、保留像素锐度），否则 `optimizeQuality`。 */
export type ImageSamplingMode = 'auto' | 'optimizeQuality';

export interface ImageRenderRequirementInput {
  width: number;
  height: number;
  zoom: number;
  hasThumbnail: boolean;
  hasMedium?: boolean;
  hasOriginal: boolean;
  isInteracting?: boolean;
  enabled?: boolean;
}

/**
 * 这张图在当前相机下"需要什么" —— **memo 与 LOD hook 的唯一口径**。
 *
 * 为什么必须抽成一个对象：上一轮只保证了"选档函数共用"，但那不够。
 * 影响的输出的判定一共有三个，任何一个被 memo 漏掉，都会出现"hook 需要重渲染、
 * memo 却把它拦掉"的错位：
 *
 * - `desiredTier`：纯几何目标档位（换 LOD 需要重绘）。
 * - `eligibleForOriginal`：是否值得申请原图配额。它还含 `zoom > 1.0` 这个条件，
 *   而选档函数里没有 —— 实测 1600×900 的图 zoom 0.9→1.1 时，
 *   准入条件 false→true 而选档结果没变，于是申请原图的那次更新被 memo 拦掉，
 *   直到别的原因偶然触发重渲染才变清晰。
 * - `samplingMode`：`imageRendering` 的取值。同样是"选档没变但样式该变"的情况
 *   （400×225 的图 zoom 0.9→1.1：档位都是 standard，但采样该从
 *   optimizeQuality 切成 auto），memo 拦掉就换不过来。
 *
 * memo 比较整个判定；hook 用同一个函数取 `eligibleForOriginal`。
 * 实际显示什么（异步准入是否已落地）由资源状态单独驱动，不进这个判定。
 */
export interface ImageRenderRequirement {
  desiredTier: ImageLODTier;
  eligibleForOriginal: boolean;
  samplingMode: ImageSamplingMode;
}

export const resolveImageRenderRequirement = ({
  width,
  height,
  zoom,
  hasThumbnail,
  hasMedium = false,
  hasOriginal,
  isInteracting = false,
  enabled = true,
}: ImageRenderRequirementInput): ImageRenderRequirement => ({
  desiredTier: resolveImageLODTier({
    screenLongest: getImageDisplayLongestEdge(width, height, zoom),
    hasThumbnail,
    hasMedium,
    hasOriginal,
    // 档位判定不管配额是否可用：配额落地后 hook 自己会因状态变化重渲染，
    // memo 只需要判断"props 是否要求不同的输出"。
    isHighResAdmitted: true,
    enabled,
    isInteracting,
  }),
  eligibleForOriginal: shouldAdmitFullResolution({
    enabled,
    isInteracting,
    hasOriginal,
    width,
    height,
    zoom,
  }),
  samplingMode: zoom > IMAGE_LOD_CONSTANTS.DETAIL_ZOOM_THRESHOLD ? 'auto' : 'optimizeQuality',
});

/** 三个字段逐项比较；任一项不同就必须重绘。 */
export const isSameImageRenderRequirement = (
  a: ImageRenderRequirement,
  b: ImageRenderRequirement,
): boolean =>
  a.desiredTier === b.desiredTier
  && a.eligibleForOriginal === b.eligibleForOriginal
  && a.samplingMode === b.samplingMode;

export type LRUListener = (evictedId: string | null, activeIds: ReadonlySet<string>) => void;

/** 定向准入回调：只关心"我这一个 id 现在是否驻留原图"。 */
export type LRUAdmissionListener = (admitted: boolean) => void;

/**
 * LRU Cache for managing concurrent active high-resolution textures.
 * Bounded to capacity and estimated decoded bytes; active hook leases cannot evict each other.
 * Legacy request(id) remains count-only; production admission always supplies decoded bytes.
 */
export class ImageLRUCache {
  private readonly capacity: number;
  private readonly items = new Map<string, number>(); // id -> sequence
  /** 兼容通道：整体广播（"谁被驱逐"）。订阅者数量大时是 O(订阅者) 每 id，热路径不要用它。 */
  private readonly listeners = new Set<LRUListener>();
  /**
   * 定向通道：每个图片元素只订阅自己的 id。
   * 这是热路径该走的通道 —— 准入/驱逐只通知受影响的 1~2 个 id，
   * 而不是把整个画布的订阅者都叫醒一遍。
   */
  private readonly admissionListeners = new Map<string, Set<LRUAdmissionListener>>();
  private sequence = 0;
  private readonly byteBudget: number;
  private readonly decodedBytes = new Map<string, number>();
  private readonly retained = new Set<string>();
  private estimatedBytes = 0;

  constructor(
    capacity: number = IMAGE_LOD_CONSTANTS.FULL_RES_LRU_CAPACITY,
    byteBudget: number = IMAGE_LOD_CONSTANTS.FULL_RES_DECODED_BYTE_BUDGET,
  ) {
    this.capacity = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : IMAGE_LOD_CONSTANTS.FULL_RES_LRU_CAPACITY;
    this.byteBudget = Number.isFinite(byteBudget) ? Math.max(0, Math.floor(byteBudget)) : IMAGE_LOD_CONSTANTS.FULL_RES_DECODED_BYTE_BUDGET;
  }

  getByteBudget(): number { return this.byteBudget; }

  getEstimatedBytes(): number { return this.estimatedBytes; }

  getCapacity(): number {
    return this.capacity;
  }

  size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  keys(): string[] {
    return Array.from(this.items.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  }

  /**
   * Requests admission; supplied bytes are naturalWidth * naturalHeight * 4.
   * Retained entries belong to current visible demand and cannot be evicted by
   * another request. Reject atomically if limits cannot be met (no churn).
   */
  request(id: string, estimatedBytes?: number, retain = false): boolean {
    const bytes = estimatedBytes ?? this.decodedBytes.get(id) ?? 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.byteBudget) return false;
    const present = this.items.has(id);
    let total = this.estimatedBytes - (this.decodedBytes.get(id) ?? 0) + bytes;
    let count = this.items.size + (present ? 0 : 1);
    const evicted: string[] = [];
    // Select victims first, so a denied request cannot partially empty the cache.
    for (const candidate of this.keys()) {
      if (count <= this.capacity && total <= this.byteBudget) break;
      if (candidate === id || this.retained.has(candidate)) continue;
      evicted.push(candidate);
      total -= this.decodedBytes.get(candidate) ?? 0;
      count--;
    }
    if (count > this.capacity || total > this.byteBudget) return false;
    for (const candidate of evicted) {
      this.items.delete(candidate);
      this.decodedBytes.delete(candidate);
      this.retained.delete(candidate);
    }
    this.items.set(id, ++this.sequence);
    this.decodedBytes.set(id, bytes);
    this.estimatedBytes = total;
    if (retain) this.retained.add(id);
    if (!present) this.notifyAdmission(id);
    for (const candidate of evicted) this.notifyAdmission(candidate);
    if (!present || evicted.length) {
      // Keep the legacy one-eviction event contract, including multiple byte victims.
      if (evicted.length) for (const candidate of evicted) this.notify(candidate);
      else this.notify(null);
    }
    return true;
  }

  /**
   * Releases an element from the LRU cache (e.g. when unmounting or navigating away).
   */
  release(id: string): boolean {
    if (!this.items.delete(id)) return false;
    this.estimatedBytes -= this.decodedBytes.get(id) ?? 0;
    this.decodedBytes.delete(id);
    this.retained.delete(id);
    this.notifyAdmission(id);
    this.notify(null);
    return true;
  }

  evict(id: string): boolean {
    return this.release(id);
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.decodedBytes.clear();
    this.retained.clear();
    this.estimatedBytes = 0;
    // 既要通知定向订阅者（它们的 id 已不再驻留），也保留旧的广播通道语义。
    for (const id of Array.from(this.admissionListeners.keys())) this.notifyAdmission(id);
    this.notify(null);
  }

  subscribe(listener: LRUListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 定向订阅某一个 id 的准入状态。
   * 热路径（每个图片元素）都应该用它：准入/驱逐只会唤醒受影响的 id，
   * 复杂度是 O(1) 而不是 O(画布上所有订阅者)。
   */
  subscribeAdmission(id: string, listener: LRUAdmissionListener): () => void {
    let bucket = this.admissionListeners.get(id);
    if (!bucket) {
      bucket = new Set();
      this.admissionListeners.set(id, bucket);
    }
    bucket.add(listener);
    return () => {
      const current = this.admissionListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.admissionListeners.delete(id);
    };
  }

  private notify(evictedId: string | null): void {
    if (this.listeners.size === 0) return;
    const activeSet = new Set(this.items.keys());
    for (const listener of this.listeners) {
      try {
        listener(evictedId, activeSet);
      } catch (e) {
        console.error('Error in ImageLRUCache listener:', e);
      }
    }
  }

  private notifyAdmission(id: string): void {
    const bucket = this.admissionListeners.get(id);
    if (!bucket || bucket.size === 0) return;
    const admitted = this.items.has(id);
    for (const listener of Array.from(bucket)) {
      try {
        listener(admitted);
      } catch (e) {
        console.error('Error in ImageLRUCache admission listener:', e);
      }
    }
  }
}

/** Global singleton LRU cache for high-resolution images */
export const globalImageLRUCache = new ImageLRUCache(IMAGE_LOD_CONSTANTS.FULL_RES_LRU_CAPACITY);

/** Invalid/unknown natural dimensions must never be charged as tiny world dimensions. */
export const estimateOriginalDecodedBytes = (width: number, height: number): number => {
  const bytes = width * height * 4;
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
    && Number.isSafeInteger(bytes) ? bytes : Infinity;
};

/**
 * Batch visible demand, highest screen-pixel priority first. Use persisted source
 * dimensions; unknown legacy sources stay on proxies without speculative decoding.
 * Admit only if both budgets fit. Retain active leases: a denied
 * original stays on its proxy until a future demand change, never retries on
 * someone else's admission/release notification.
 */
const pendingAdmissions = new Map<string, { priority: number; bytes: number }>();
let admissionFlushTimer: ReturnType<typeof setTimeout> | null = null;
let admissionFlushRunning = false;

const flushScheduledAdmissions = async (): Promise<void> => {
  admissionFlushTimer = null;
  if (admissionFlushRunning) return;
  admissionFlushRunning = true;
  try {
    while (pendingAdmissions.size) {
      const [id, demand] = Array.from(pendingAdmissions.entries()).sort((a, b) => b[1].priority - a[1].priority)[0];
      pendingAdmissions.delete(id);
      globalImageLRUCache.request(id, demand.bytes, true);
    }
  } finally {
    admissionFlushRunning = false;
  }
};

const scheduleAdmission = (id: string, priority: number, bytes: number): void => {
  pendingAdmissions.set(id, { priority, bytes });
  if (!admissionFlushRunning && admissionFlushTimer === null) {
    admissionFlushTimer = setTimeout(flushScheduledAdmissions, IMAGE_LOD_CONSTANTS.HIGH_RES_IDLE_DELAY_MS);
  }
};

const cancelScheduledAdmission = (id: string): void => {
  pendingAdmissions.delete(id);
  if (pendingAdmissions.size === 0 && admissionFlushTimer !== null) {
    clearTimeout(admissionFlushTimer);
    admissionFlushTimer = null;
  }
};

/** React hook for dynamic LOD source resolution with automatic LRU registration & unmount release. */
export interface ImageLODHookOptions {
  zoom: number;
  /** 元素的世界坐标尺寸；乘上 zoom 才是它占用多少屏幕像素。 */
  width?: number;
  height?: number;
  isInteracting?: boolean;
  href: string;
  thumbnailHref?: string;
  mediumHref?: string;
  originalHref?: string;
  originalPixelWidth?: number;
  originalPixelHeight?: number;
  enabled?: boolean;
}

export function useImageLOD(
  elementId: string,
  options: ImageLODHookOptions
): ImageLODResult {
  const {
    zoom,
    width = 0,
    height = 0,
    isInteracting = false,
    href,
    thumbnailHref,
    mediumHref,
    originalHref,
    originalPixelWidth,
    originalPixelHeight,
    enabled = true,
  } = options;

  // 准入条件与 CanvasElement 的 memo 走**同一个判定函数**（见 resolveImageRenderRequirement）：
  // 两边各自算必然一致，不会出现"准入该变但 memo 拦掉了重绘"。
  const eligibleForHighRes = resolveImageRenderRequirement({
    width,
    height,
    zoom,
    hasThumbnail: Boolean(thumbnailHref),
    hasOriginal: Boolean(originalHref),
    isInteracting,
    enabled,
  }).eligibleForOriginal;

  const [admission, setAdmission] = useState({ id: elementId, src: originalHref, admitted: false });
  const isAdmitted = admission.id === elementId && admission.src === originalHref && admission.admitted;

  // 定向订阅绑定资产身份，旧原图的准入不能放行同 id 的新原图。
  useEffect(() => {
    const unsubscribe = globalImageLRUCache.subscribeAdmission(elementId, admitted => {
      setAdmission({ id: elementId, src: originalHref, admitted });
    });
    return () => {
      unsubscribe();
      cancelScheduledAdmission(elementId);
      // 卸载或换 id 时归还配额（已退订，这里的通知不会再回到本组件）。
      globalImageLRUCache.release(elementId);
    };
  }, [elementId, originalHref]);

  useEffect(() => {
    if (!eligibleForHighRes || !originalHref) {
      // 不再需要原图：撤掉还没落地的排队，并立刻归还已占用的配额。
      cancelScheduledAdmission(elementId);
      globalImageLRUCache.release(elementId);
      setAdmission({ id: elementId, src: originalHref, admitted: false });
      return;
    }
    // Asset identity is a dependency: replacing an original must not reuse its old charge.
    scheduleAdmission(elementId, getImageDisplayLongestEdge(width, height, zoom),
      estimateOriginalDecodedBytes(originalPixelWidth ?? 0, originalPixelHeight ?? 0));
    return () => {
      cancelScheduledAdmission(elementId);
      globalImageLRUCache.release(elementId);
    };
  }, [elementId, eligibleForHighRes, originalHref, originalPixelWidth, originalPixelHeight]);

  return useMemo(() => resolveImageLODSource({
    zoom,
    isInteracting,
    href,
    thumbnailHref,
    mediumHref,
    originalHref,
    isHighResAdmitted: isAdmitted,
    width,
    height,
  }), [zoom, isInteracting, href, thumbnailHref, mediumHref, originalHref, isAdmitted, width, height]);
}

/**
 * Pure-client canvas proxy generator for browser environment.
 * Generates thumbnail (256px), medium (512px) and standard (1024px) proxies
 * from an HTMLImageElement or canvas. Each tier is only generated when the
 * original actually exceeds that tier's long edge (no upscaling).
 */
export function generateProxyDataUrls(
  img: HTMLImageElement | HTMLCanvasElement,
  origWidth: number,
  origHeight: number,
  mimeType: string = 'image/png'
): { thumbnailDataUrl?: string; mediumDataUrl?: string; proxyDataUrl?: string } {
  if (typeof document === 'undefined') {
    return {};
  }

  const result: { thumbnailDataUrl?: string; mediumDataUrl?: string; proxyDataUrl?: string } = {};
  const isOpaque = mimeType === 'image/jpeg' || mimeType === 'image/jpg';
  const targetMime = isOpaque ? 'image/jpeg' : 'image/png';

  const drawTier = (
    maxDimension: number,
    quality: number,
    label: string,
  ): string | undefined => {
    const dim = computeScaledDimensions(origWidth, origHeight, maxDimension);
    if (!dim.scaled) return undefined;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = dim.width;
      canvas.height = dim.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, dim.width, dim.height);
        return canvas.toDataURL(targetMime, quality);
      }
    } catch (e) {
      console.warn(`Failed to generate ${label}:`, e);
    }
    return undefined;
  };

  // 1. 1024px display proxy if original exceeds 1024px
  result.proxyDataUrl = drawTier(
    IMAGE_LOD_CONSTANTS.STANDARD_PROXY_MAX_DIMENSION,
    IMAGE_LOD_CONSTANTS.PROXY_QUALITY,
    '1024px proxy',
  );

  // 2. 512px medium proxy if original exceeds 512px（密集多卡场景的纹理预算档，见 ADR-049）
  result.mediumDataUrl = drawTier(
    IMAGE_LOD_CONSTANTS.MEDIUM_PROXY_MAX_DIMENSION,
    IMAGE_LOD_CONSTANTS.PROXY_QUALITY,
    '512px medium proxy',
  );

  // 3. 256px thumbnail proxy if original exceeds 256px
  result.thumbnailDataUrl = drawTier(
    IMAGE_LOD_CONSTANTS.THUMBNAIL_MAX_DIMENSION,
    IMAGE_LOD_CONSTANTS.THUMBNAIL_QUALITY,
    '256px thumbnail',
  );

  return result;
}
