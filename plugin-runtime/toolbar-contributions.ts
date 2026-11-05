/**
 * `ui_toolbar` slot: selection overlay and the smart toolbar stay plugin-owned.
 * Hosts only choose a placement; the components themselves are unchanged.
 */

import type { ComponentType } from 'react';
import type { Contribution, Kernel } from './kernel';

export type CanvasToolbarPlacement = 'selection-overlay' | 'smart';

export interface CanvasToolbarContribution {
  placement: CanvasToolbarPlacement;
  component: ComponentType<{ kernel: Kernel }>;
}

export type CanvasToolbarRegistryEntry = Contribution<CanvasToolbarContribution>;

export const listCanvasToolbarContributions = (
  kernel: Kernel,
  placement: CanvasToolbarPlacement,
): readonly CanvasToolbarRegistryEntry[] =>
  kernel.contributions.list<CanvasToolbarContribution>('ui_toolbar')
    .filter(entry => entry.value.placement === placement);
