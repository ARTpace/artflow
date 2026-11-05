/**
 * 星系视图会卸掉图片节点。浏览器里那份解码结果会跟着预解码队列的 release 一起丢掉，
 * 放大回来就要重新解码，画面先空再一张张冒出来。
 * 这里按 URL 留住少量已解码的 HTMLImageElement（优先缩略图），让回来的第一帧能直接画出来。
 */

// Thumbnail-only cache. Cap both decoded textures and data-URL strings; full-size
// image sources must never be pinned just because a card scrolled offscreen.
const CAPACITY = 64;
const MAX_WARM_SOURCE_CHARS = 512 * 1024;
const warmImages = new Map<string, HTMLImageElement>();

/** 这个 URL 是否已经有解码结果。用来让回来的图片直接淡入，而不是干等 load。 */
export const isImageSourceReady = (src: string): boolean => {
  if (!src || typeof Image === 'undefined') return false;
  const warm = warmImages.get(src);
  if (warm?.complete && warm.naturalWidth > 0) return true;
  // A probe for a large data URL or blob may decode the full original all over
  // again. Let the actual <image> load event / preparation queue handle it.
  if (src.length > MAX_WARM_SOURCE_CHARS || src.startsWith('blob:')) return false;
  const probe = new Image();
  probe.src = src;
  return probe.complete && probe.naturalWidth > 0;
};

export const warmImageSources = (sources: readonly string[]): void => {
  if (typeof Image === 'undefined') return;
  for (const src of sources) {
    if (!src || src.length > MAX_WARM_SOURCE_CHARS) continue;
    const existing = warmImages.get(src);
    if (existing) {
      warmImages.delete(src);
      warmImages.set(src, existing);
      continue;
    }
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
    warmImages.set(src, image);
    while (warmImages.size > CAPACITY) {
      const oldest = warmImages.keys().next().value;
      if (oldest === undefined) break;
      const node = warmImages.get(oldest);
      warmImages.delete(oldest);
      node?.removeAttribute('src');
    }
  }
};
