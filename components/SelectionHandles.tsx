
import React from 'react';
import { Element, Rect, ImageElement } from '../types';
import { getElementBounds, getSelectionBounds } from '../utils/canvasUtils';

interface SelectionHandlesProps {
    selectedElementIds: string[];
    elements: Element[];
    zoom: number;
    croppingState: any;
    aiRotationState: any;
    /**
     * 拖动中（拖动会话已有可见位移）：只留选区轮廓，隐藏缩放手柄与旋转手柄。
     * 用户需求：拖动图片时，图片周边的悬浮按键要跟着让位。
     * 手柄本身不可点（拖动期间不走 resize 分支），但会跟着图片一起走、挡住下方内容。
     */
    isDragging?: boolean;
}

export const SelectionHandles: React.FC<SelectionHandlesProps> = ({
    selectedElementIds,
    elements,
    zoom,
    croppingState,
    aiRotationState,
    isDragging = false
}) => {
    if (selectedElementIds.length === 0 || croppingState || aiRotationState) return null;

    // 多选显示虚线框
    if (selectedElementIds.length > 1) {
        const bounds = getSelectionBounds(selectedElementIds, elements);
        return (
            <rect
                x={bounds.x}
                y={bounds.y}
                width={bounds.width}
                height={bounds.height}
                fill="none"
                stroke="rgb(59 130 246)"
                strokeWidth={2 / zoom}
                strokeDasharray={`${6 / zoom} ${4 / zoom}`}
                pointerEvents="none"
            />
        );
    }

    // 单选显示控制点
    const element = elements.find(el => el.id === selectedElementIds[0]);
    if (!element) return null;

    const bounds = getElementBounds(element, elements);
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const rotation = 'rotation' in element && element.rotation ? element.rotation : 0;
    const transform = rotation !== 0 ? `rotate(${rotation} ${center.x} ${center.y})` : '';

    const { x, y, width, height } = bounds;
    const handleSize = 8 / zoom;
    const handles = [
        { name: 'tl', x: x, y: y, cursor: 'nwse-resize' },
        { name: 'tm', x: x + width / 2, y: y, cursor: 'ns-resize' },
        { name: 'tr', x: x + width, y: y, cursor: 'nesw-resize' },
        { name: 'ml', x: x, y: y + height / 2, cursor: 'ew-resize' },
        { name: 'mr', x: x + width, y: y + height / 2, cursor: 'ew-resize' },
        { name: 'bl', x: x, y: y + height, cursor: 'nesw-resize' },
        { name: 'bm', x: x + width / 2, y: y + height, cursor: 'ns-resize' },
        { name: 'br', x: x + width, y: y + height, cursor: 'nwse-resize' },
    ];

    const rotationHandleY = y - 25 / zoom;
    const rotationHandleX = x + width / 2;

    return (
        <g transform={transform}>
            <rect
                x={x}
                y={y}
                width={width}
                height={height}
                fill="none"
                stroke="rgb(59 130 246)"
                strokeWidth={2 / zoom}
                pointerEvents="none"
            />
            {/* 拖动中只留轮廓：手柄既挡视线又点不动（拖动期间不走 resize 分支），
                它们还会跟着图片一起位移，松手后按新位置重新出现。 */}
            {!isDragging && (
                <>
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
                    <line x1={rotationHandleX} y1={y} x2={rotationHandleX} y2={rotationHandleY} stroke="#3b82f6" strokeWidth={1 / zoom} />
                    <circle
                        data-handle="rotate"
                        cx={rotationHandleX}
                        cy={rotationHandleY}
                        r={handleSize / 1.5}
                        fill="white"
                        stroke="#3b82f6"
                        strokeWidth={1 / zoom}
                        style={{ cursor: 'grab' }}
                    />
                </>
            )}
        </g>
    );
};
