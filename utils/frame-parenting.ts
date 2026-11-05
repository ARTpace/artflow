/**
 * frame-parenting.ts —— exact drag-commit frame parent resolution.
 *
 * The R11/R14 index is only a conservative candidate source. Parent semantics
 * remain the existing bounds containment and frame comparator below.
 */

import type { Element, FrameElement } from '../types';
import { getElementBounds } from './canvasUtils';
import { queryInteractionCandidates } from './interaction-spatial-query';
import type { InteractionViewportIndexSnapshot } from './interaction-spatial-query';

const exactlyContains = (frame: FrameElement, bounds: { x: number; y: number; width: number; height: number }): boolean => (
  bounds.x >= frame.x
  && bounds.y >= frame.y
  && bounds.x + bounds.width <= frame.x + frame.width
  && bounds.y + bounds.height <= frame.y + frame.height
);

/**
 * Uses an optional same-elements R11 snapshot to narrow frame candidates.
 * Missing or stale snapshots deliberately return the full current list through
 * queryInteractionCandidates, reproducing the legacy frame scan.
 */
export function resolveContainingFrame(
  element: Element,
  elements: readonly Element[],
  snapshot: InteractionViewportIndexSnapshot | null,
): FrameElement | null {
  const bounds = getElementBounds(element, elements as Element[]);
  return resolveFrameFromCandidates(bounds, queryInteractionCandidates(snapshot, elements, bounds)
    .filter((candidate): candidate is FrameElement => candidate.type === 'frame'));
}

const resolveFrameFromCandidates = (bounds: ReturnType<typeof getElementBounds>, frames: readonly FrameElement[]): FrameElement | null => (
  frames.filter(frame => exactlyContains(frame, bounds))
    // Preserve the pre-existing comparator exactly; do not silently normalize it to true area.
    .sort((a, b) => (a.width * a.height) - (b.width * a.height))[0] ?? null
);

/** One commit-local full scan, using post-offset Frames in original document order.
 * A same-reference index keeps its existing query semantics; stale/missing indexes
 * fall back to the prepared full Frame list instead of scanning all cards per target.
 */
export function createContainingFrameResolver(
  elements: readonly Element[],
  snapshot: InteractionViewportIndexSnapshot | null,
): (element: Element) => FrameElement | null {
  if (snapshot?.elements === elements) {
    return element => resolveContainingFrame(element, elements, snapshot);
  }
  const frames = elements.filter((element): element is FrameElement => element.type === 'frame');
  return element => resolveFrameFromCandidates(getElementBounds(element, elements as Element[]), frames);
}
