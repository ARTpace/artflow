/**
 * Shared renderer card contribution shape.
 * Business card components stay in plugins; the host only consumes this small materialized contract.
 */

import type { ComponentType } from 'react';

/** Structural subset passed by CanvasElement; cards may dim themselves while another element is cropped. */
export interface CanvasCardCroppingState {
  readonly elementId: string;
}

export interface CanvasCardComponentProps {
  element: any;
  isSelected?: boolean;
  croppingState?: CanvasCardCroppingState | null;
}

export interface CanvasCardContribution {
  nodeType: string;
  component: ComponentType<CanvasCardComponentProps>;
  /**
   * Declares intent to take over a nodeType owned by another plugin.
   * Conflict resolution itself is priority-based (ContributionRegistry.list order);
   * this field exists for conflict visibility in tooling / logs, not for lookup.
   */
  replaces?: string;
}
