import React from 'react';
import { Point, Rect, Guide } from '../types';

interface CanvasOverlaysProps {
  zoom: number;
  lassoPath: Point[] | null;
  alignmentGuides: Guide[];
  selectionBox: Rect | null;
}

export const CanvasOverlays: React.FC<CanvasOverlaysProps> = ({
  zoom,
  lassoPath,
  alignmentGuides,
  selectionBox,
}) => {
  return (
    <>
      {lassoPath && (
        <path
          d={lassoPath.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ')}
          stroke="rgb(59 130 246)"
          strokeWidth={1 / zoom}
          strokeDasharray={`${4 / zoom} ${4 / zoom}`}
          fill="rgba(59, 130, 246, 0.1)"
        />
      )}

      {alignmentGuides.map((guide, i) => (
        <line
          key={i}
          x1={guide.type === 'v' ? guide.position : guide.start}
          y1={guide.type === 'h' ? guide.position : guide.start}
          x2={guide.type === 'v' ? guide.position : guide.end}
          y2={guide.type === 'h' ? guide.position : guide.end}
          stroke="red"
          strokeWidth={1 / zoom}
          strokeDasharray={`${4 / zoom} ${2 / zoom}`}
        />
      ))}

      {selectionBox && (
        <rect
          x={selectionBox.x}
          y={selectionBox.y}
          width={selectionBox.width}
          height={selectionBox.height}
          fill="rgba(59, 130, 246, 0.1)"
          stroke="rgb(59, 130, 246)"
          strokeWidth={1 / zoom}
          strokeDasharray={`${4 / zoom} ${4 / zoom}`}
        />
      )}
    </>
  );
};
