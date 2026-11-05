import React from 'react';
import type { AudioElement } from '../../types';
import { AudioCanvasPlayer } from '../AudioCanvasPlayer';

/**
 * Audio canvas card — owned by builtin/cards (canvas_node_types slot).
 * Thin wrapper so the player implementation stays plugin-replaceable while
 * keeping its existing element-driven API.
 */
export const AudioCanvasCard: React.FC<{
  element: AudioElement;
  isSelected?: boolean;
  croppingState?: { readonly elementId: string } | null;
}> = ({ element, isSelected }) => <AudioCanvasPlayer element={element} isSelected={isSelected} />;
