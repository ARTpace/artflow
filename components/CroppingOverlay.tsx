import React from 'react';
import { ImageElement, Rect } from '../types';

interface CroppingOverlayProps {
  zoom: number;
  croppingState: {
    elementId: string;
    originalElement: ImageElement;
    cropBox: Rect;
  };
}

export const CroppingOverlay: React.FC<CroppingOverlayProps> = ({ zoom, croppingState }) => {
  const { x, y, width, height } = croppingState.cropBox;
  const handleSize = 8 / zoom;
  const handles = [
    { name: 'tl', x, y, cursor: 'nwse-resize' },
    { name: 'tm', x: x + width / 2, y, cursor: 'ns-resize' },
    { name: 'tr', x: x + width, y, cursor: 'nesw-resize' },
    { name: 'ml', x, y: y + height / 2, cursor: 'ew-resize' },
    { name: 'mr', x: x + width, y: y + height / 2, cursor: 'ew-resize' },
    { name: 'bl', x, y: y + height, cursor: 'nesw-resize' },
    { name: 'bm', x: x + width / 2, y: y + height, cursor: 'ns-resize' },
    { name: 'br', x: x + width, y: y + height, cursor: 'nwse-resize' },
  ];

  return (
    <g>
      <rect 
        x={-10000} y={-10000} width={20000} height={20000}
        fill="black" opacity="0.5"
        pointerEvents="all"
      />
      <image 
        x={croppingState.originalElement.x} 
        y={croppingState.originalElement.y}
        width={croppingState.originalElement.width} 
        height={croppingState.originalElement.height}
        href={croppingState.originalElement.href}
        clipPath={`url(#crop-clip-${croppingState.elementId})`}
      />
      <defs>
        <clipPath id={`crop-clip-${croppingState.elementId}`}>
          <rect 
            x={croppingState.cropBox.x} 
            y={croppingState.cropBox.y}
            width={croppingState.cropBox.width} 
            height={croppingState.cropBox.height}
          />
        </clipPath>
      </defs>
      <rect 
        x={croppingState.cropBox.x} 
        y={croppingState.cropBox.y}
        width={croppingState.cropBox.width} 
        height={croppingState.cropBox.height}
        fill="none" stroke="white" strokeWidth={2 / zoom}
      />
      {handles.map(h => (
        <rect 
          key={h.name} 
          data-handle={h.name} 
          x={h.x - handleSize / 2} 
          y={h.y - handleSize / 2} 
          width={handleSize} 
          height={handleSize} 
          fill="white" 
          stroke="#3b82f6" 
          strokeWidth={1 / zoom} 
          style={{ cursor: h.cursor }} 
        />
      ))}
    </g>
  );
};
