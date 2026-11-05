import type { Element, Point } from '../types';

export type ClipboardTextHandler = (text: string, center: Point) => Element[] | null;
const handlers = new Set<ClipboardTextHandler>();

/** Optional plugins own recognition and node creation; disposal removes their paste behavior. */
export function registerClipboardTextHandler(handler: ClipboardTextHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function parseClipboardText(text: string, center: Point): Element[] | null {
  for (const handler of handlers) {
    try {
      const elements = handler(text, center);
      if (elements?.length) return elements;
    } catch (error) {
      console.error('[clipboard] plugin text handler failed', error);
    }
  }
  return null;
}
