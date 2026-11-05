import React from 'react';
import type { VideoElement } from '../../types';
import type { CanvasCardCroppingState } from '../../plugin-runtime/card-contributions';

const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();
const playerEvents = {
  onPointerDown: stopPropagation, onPointerMove: stopPropagation, onPointerUp: stopPropagation,
  onMouseDown: stopPropagation, onMouseMove: stopPropagation, onMouseUp: stopPropagation,
  onTouchStart: stopPropagation, onTouchMove: stopPropagation, onTouchEnd: stopPropagation,
  onClick: stopPropagation, onDoubleClick: stopPropagation, onWheel: stopPropagation,
  onKeyDown: stopPropagation, onKeyUp: stopPropagation,
};

/** Reuse the host's selection/lock/undo-aware gesture path rather than mutate element data. */
function moveFromKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
  event.stopPropagation();
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const distance = event.shiftKey ? 30 : 10;
  const offsets: Record<string, [number, number]> = {
    ArrowLeft: [-distance, 0], ArrowRight: [distance, 0],
    ArrowUp: [0, -distance], ArrowDown: [0, distance],
  };
  const offset = offsets[event.key];
  if (!offset) return;
  event.preventDefault();
  const handle = event.currentTarget;
  const svg = handle.closest('svg');
  if (!svg) return;
  const rect = handle.getBoundingClientRect();
  const start = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  // ponytail: the card contract has no move callback; delegate one discrete gesture to the existing host.
  const options = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
  handle.dispatchEvent(new MouseEvent('mousedown', { ...options, ...start, detail: 1 }));
  const end = { clientX: start.clientX + offset[0], clientY: start.clientY + offset[1] };
  svg.dispatchEvent(new MouseEvent('mousemove', { ...options, ...end }));
  svg.dispatchEvent(new MouseEvent('mouseup', { ...options, ...end, buttons: 0 }));
}

/** Native media controls consume gestures; the thin in-content handle remains a canvas drag target. */
export const VideoCanvasCard: React.FC<{
  element: VideoElement;
  isSelected?: boolean;
  croppingState?: CanvasCardCroppingState | null;
}> = ({ element, isSelected, croppingState }) => (
  <div data-video-player data-selected={isSelected || undefined} className="relative w-full h-full rounded-lg"
    style={{ background: '#000' }}>
    <video
      src={element.href}
      preload="none"
      controls
      aria-label={element.name || '视频'}
      style={{ width: '100%', height: '100%', borderRadius: '8px' }}
      className={croppingState ? 'opacity-30' : ''}
      {...playerEvents}
    />
    <div data-video-drag-handle role="button" tabIndex={0}
      aria-label="移动视频：拖动或使用方向键，Shift 加速"
      title="拖动移动 · 方向键微调"
      className="absolute top-2 left-1/2 -translate-x-1/2 w-16 h-6 flex items-center justify-center rounded-full cursor-grab active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
      style={{ background: 'rgba(0,0,0,0.45)', touchAction: 'none', color: 'rgba(255,255,255,0.85)' }}
      onKeyDown={moveFromKeyboard} onKeyUp={stopPropagation} onClick={stopPropagation} onDoubleClick={stopPropagation} onWheel={stopPropagation}>
      <span aria-hidden="true" className="w-8 h-0.5 rounded-full bg-current pointer-events-none" />
    </div>
  </div>
);
