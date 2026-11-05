import { useLayoutEffect, useState } from 'react';
import type { ImageLODResult } from './imageProxy';
import { getImagePreparationQueue, type ImagePreparationQueue } from './image-preparation-queue';
import { isImageSourceReady } from './imageWarmCache';

interface SourceState {
  elementId: string;
  baseSrc: string;
  displayed: ImageLODResult;
  failedSrc: string | null;
}

/**
 * 视口裁剪的固有代价：边缘元素随滚动/缩放反复卸载重挂。
 *
 * 重挂如果从 fallback（缩略图）开始，会先闪一次低清再升档 —— 屏幕上就是"闪"；
 * 没有缩略图的元素 fallback 是完整 href，重挂等于一次全新加载 —— 屏幕上就是
 * "图片消失"，等解码完才回来。P1-H 把选中集移出裁剪白名单后（正确修复了
 * "全选绕过裁剪"），这条路径在"导入即全选"的日常场景里第一次被大规模触发。
 *
 * 修复：模块级记住每个元素**最后实际显示**的源，重挂时直接从它开始 ——
 * 视觉上等同从未卸载。只存 src 字符串与档位，不持有解码资源；像素命中
 * 依赖浏览器图片缓存（刚显示过的 URL 几乎必然还在）与预解码队列。
 */
const LAST_DISPLAYED_CAPACITY = 256;
const MAX_REMEMBERED_SOURCE_CHARS = 8 * 1024 * 1024;
const MAX_ENTRY_SOURCE_CHARS = 1024 * 1024;
const lastDisplayedSources = new Map<string, { baseSrc: string; displayed: ImageLODResult; chars: number }>();
let rememberedSourceChars = 0;

/** Keep a bounded hint, not thousands of pinned base64 originals after culling/deleting cards. */
export const rememberLastDisplayedSource = (
  elementId: string,
  baseSrc: string,
  displayed: ImageLODResult,
): void => {
  // The full original stays with the document, but never in a second long-lived
  // remount cache. Retain the prior smaller tier instead if one was displayed.
  if (displayed.tier === 'original') return;
  const chars = baseSrc.length + (baseSrc === displayed.src ? 0 : displayed.src.length);
  if (chars > MAX_ENTRY_SOURCE_CHARS) return;
  const previous = lastDisplayedSources.get(elementId);
  if (previous) rememberedSourceChars -= previous.chars;
  lastDisplayedSources.delete(elementId);
  lastDisplayedSources.set(elementId, { baseSrc, displayed, chars });
  rememberedSourceChars += chars;
  while (lastDisplayedSources.size > LAST_DISPLAYED_CAPACITY || rememberedSourceChars > MAX_REMEMBERED_SOURCE_CHARS) {
    const oldest = lastDisplayedSources.keys().next().value;
    if (oldest === undefined) break;
    rememberedSourceChars -= lastDisplayedSources.get(oldest)!.chars;
    lastDisplayedSources.delete(oldest);
  }
};

/** 读取"最后显示源"。资产已被替换（baseSrc 变了）时必须作废，绝不能把旧资产像素交给新资产。 */
export const peekLastDisplayedSource = (elementId: string, baseSrc: string): ImageLODResult | null => {
  const cached = lastDisplayedSources.get(elementId);
  return cached && cached.baseSrc === baseSrc ? cached.displayed : null;
};

export interface PreparedImageSourceOptions {
  elementId: string;
  /** Identity of the underlying asset. Replacing an asset must never show the previous one. */
  baseSrc: string;
  desired: ImageLODResult;
  fallback: ImageLODResult;
  /** Dependency injection for deterministic lifecycle/integration tests. */
  queue?: ImagePreparationQueue;
}

/**
 * LOD demand stays a pure function. Only resource readiness is asynchronous.
 * Keep the existing image until the requested source has decoded and a bounded
 * notification slot is available. Never freeze the whole gesture or add hidden
 * tier hysteresis behind CanvasElement.memo.
 *
 * Initial lightweight fallback rendering remains synchronous (also in SSR),
 * except that a remembered source from a previous mount wins over the fallback:
 * culling remounts must not visually regress to a lighter tier or a blank image.
 * This queue governs source transitions, not every first-time thumbnail mount.
 */
export function usePreparedImageSource({
  elementId, baseSrc, desired, fallback, queue,
}: PreparedImageSourceOptions): ImageLODResult & { loadState: 'ready' | 'pending' | 'error' } {
  const [state, setState] = useState<SourceState>(() => {
    const remembered = peekLastDisplayedSource(elementId, baseSrc);
    // 原图卸载后解码通常已经释放，直接重挂会先空白再解码。
    // 解码还在（刚裁掉、缓存还热）就沿用上次的图，避免先闪一档缩略图。
    if (remembered && (remembered.tier !== 'original' || isImageSourceReady(remembered.src))) {
      return { elementId, baseSrc, displayed: remembered, failedSrc: null };
    }
    return { elementId, baseSrc, displayed: fallback, failedSrc: null };
  });
  const sameAsset = state.elementId === elementId && state.baseSrc === baseSrc;
  // Immediately use the new asset's fallback on replacement, even before effects.
  const displayed = sameAsset ? state.displayed : fallback;

  useLayoutEffect(() => {
    let live = true;
    if (desired.src === displayed.src) return;
    const preparation = queue ?? getImagePreparationQueue();
    const cancel = preparation.request(desired, result => {
      if (!live) return;
      if (result.ok) {
        const committed: ImageLODResult = { src: desired.src, tier: desired.tier };
        rememberLastDisplayedSource(elementId, baseSrc, committed);
        setState({ elementId, baseSrc, displayed: committed, failedSrc: null });
      } else {
        // Decode failure retains the current usable source. No retry timer loop.
        setState(previous => ({
          elementId,
          baseSrc,
          displayed: previous.elementId === elementId && previous.baseSrc === baseSrc
            ? previous.displayed : fallback,
          failedSrc: desired.src,
        }));
      }
    });
    return () => { live = false; cancel(); };
    // Deliberately do not depend on displayed/state: completion must not resubmit
    // the same request. Only a new desired resource or asset identity owns a lease.
  }, [elementId, baseSrc, desired.src, desired.tier, fallback.src, fallback.tier, queue]);

  const ready = displayed.src === desired.src;
  return {
    src: displayed.src,
    tier: ready ? desired.tier : displayed.tier,
    loadState: ready ? 'ready' : sameAsset && state.failedSrc === desired.src ? 'error' : 'pending',
  };
}
