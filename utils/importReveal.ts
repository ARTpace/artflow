import type { ImageElement } from '../types';

/** Transient UI-only signal. Never add animation flags to the saved document or undo history. */
export interface ImportRevealRequest {
  scope: string;
  ids: readonly string[];
}

export const IMPORT_REVEAL_MAX_IMAGES = 8;
const MAX_SCREEN_PIXELS = 1_600_000;
const MAX_PREVIEW_URL_LENGTH = 450_000;
const DECODE_WAIT_MS = 150;
const REVEAL_MS = 180;

interface RevealOptions {
  svg: SVGSVGElement;
  layer: HTMLElement;
  images: readonly ImageElement[];
  isBusy: () => boolean;
  subscribeToCamera?: (cancel: () => void) => () => void;
}

interface Candidate {
  node: SVGImageElement;
  preview: HTMLImageElement;
}

function decodePreview(image: HTMLImageElement): Promise<void> {
  if (typeof image.decode === 'function') return image.decode();
  return new Promise((resolve, reject) => {
    if (image.complete) {
      if (image.naturalWidth) resolve();
      else reject(new Error('Import preview could not be loaded'));
      return;
    }
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => reject(new Error('Import preview could not be loaded')), { once: true });
  });
}

/** CSS opacity animation *inside* the large SVG repaints the whole canvas on
 * every frame in Chromium (see ADR-051). Instead fade a single, short-lived HTML
 * compositor layer with up to one bounded import batch. The SVG's new images
 * stay in the document/hit-test tree and are only hidden with a static rule.
 * Any input cancels the cosmetic animation and reveals the real images at once.
 */
export function createImportRevealController(): {
  reveal: (options: RevealOptions) => void;
  cancel: () => void;
} {
  let active: (() => void) | null = null;

  const cancel = () => { active?.(); };
  const reveal = ({ svg, layer, images, isBusy, subscribeToCamera }: RevealOptions): void => {
    // Under heavy load, editing, reduced motion, or a previous reveal, paint
    // immediately rather than queuing work or competing with user input.
    if (active || images.length === 0 || !layer.isConnected || document.hidden || isBusy()
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const byId = new Map(images.slice(0, IMPORT_REVEAL_MAX_IMAGES).map(image => [image.id, image]));
    const container = layer.getBoundingClientRect();
    const candidates: Candidate[] = [];
    let screenPixels = 0;
    // One DOM query / layout read per visible import batch, not one per frame.
    for (const node of svg.querySelectorAll<SVGImageElement>('image[data-element-id]')) {
      const image = byId.get(node.getAttribute('data-element-id') || '');
      if (!image || image.parentId || image.rotation || (image.borderRadius ?? 0) > 0
          || (image.opacity ?? 1) !== 1 || node.hasAttribute('clip-path')
          || node.hasAttribute('data-bp-import-suppressed')
          || node.closest('[data-cull-state="out"]')) continue;
      const rect = node.getBoundingClientRect();
      const visibleWidth = Math.min(container.right, rect.right) - Math.max(container.left, rect.left);
      const visibleHeight = Math.min(container.bottom, rect.bottom) - Math.max(container.top, rect.top);
      const pixels = rect.width * rect.height;
      if (visibleWidth < 24 || visibleHeight < 24 || !Number.isFinite(pixels)
          || pixels <= 0 || screenPixels + pixels > MAX_SCREEN_PIXELS) continue;
      const actualSource = node.getAttribute('href') || '';
      const source = [actualSource, image.mediumHref, image.thumbnailHref].find(value =>
        value && value.length <= MAX_PREVIEW_URL_LENGTH
        && /^data:image\/(?:jpeg|png|webp|avif|bmp);base64,/i.test(value));
      if (!source) continue; // SVG/animated GIF, huge originals, managed locators: normal paint.
      const preview = new Image();
      preview.alt = '';
      preview.decoding = 'async';
      preview.style.cssText = `position:absolute;left:${rect.left - container.left}px;top:${rect.top - container.top}px;width:${rect.width}px;height:${rect.height}px;object-fit:fill;pointer-events:none`;
      preview.style.imageRendering = node.style.imageRendering;
      preview.src = source;
      candidates.push({ node, preview });
      screenPixels += pixels;
    }
    if (!candidates.length || isBusy()) return;

    const panel = document.createElement('div');
    panel.setAttribute('data-bp-import-reveal', 'active');
    panel.setAttribute('aria-hidden', 'true');
    panel.style.cssText = 'position:absolute;inset:0;opacity:0;pointer-events:none;will-change:opacity;contain:layout paint';
    for (const { preview } of candidates) panel.appendChild(preview);
    layer.appendChild(panel);
    for (const { node } of candidates) node.setAttribute('data-bp-import-suppressed', '');

    let finished = false;
    let animation: Animation | null = null;
    let unsubscribe: (() => void) | undefined;
    const timeout = window.setTimeout(() => finish(), DECODE_WAIT_MS + REVEAL_MS + 170);
    function finish(): void {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      unsubscribe?.();
      window.removeEventListener('pointerdown', finish, true);
      window.removeEventListener('touchstart', finish, true);
      window.removeEventListener('wheel', finish, true);
      window.removeEventListener('keydown', finish, true);
      window.removeEventListener('resize', finish);
      window.removeEventListener('blur', finish);
      document.removeEventListener('visibilitychange', finish);
      animation?.cancel();
      for (const { node } of candidates) node.removeAttribute('data-bp-import-suppressed');
      panel.remove();
      if (active === finish) active = null;
    }
    active = finish;
    window.addEventListener('pointerdown', finish, true);
    window.addEventListener('touchstart', finish, true);
    window.addEventListener('wheel', finish, true);
    window.addEventListener('keydown', finish, true);
    window.addEventListener('resize', finish);
    window.addEventListener('blur', finish);
    document.addEventListener('visibilitychange', finish);
    unsubscribe = subscribeToCamera?.(finish);

    const ready = Promise.all(candidates.map(({ preview }) => decodePreview(preview)));
    let decodeTimer: ReturnType<typeof setTimeout> | undefined;
    const decodeDeadline = new Promise<false>(resolve => {
      decodeTimer = setTimeout(() => resolve(false), DECODE_WAIT_MS);
    });
    void Promise.race([ready.then(() => true, () => false), decodeDeadline]).then(decoded => {
      if (decodeTimer) clearTimeout(decodeTimer);
      if (finished) return;
      if (!decoded || isBusy() || document.hidden || !panel.isConnected || !panel.animate) {
        finish();
        return;
      }
      animation = panel.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: REVEAL_MS,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'forwards',
      });
      panel.setAttribute('data-bp-reveal-phase', 'fading');
      void animation.finished.then(finish, finish);
    });
  };
  return { reveal, cancel };
}
