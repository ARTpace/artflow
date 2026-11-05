
import React, { useRef } from 'react';
import { AIRotationState, Point, Element } from '../types';
import { getElementBounds } from '../utils/canvasUtils';

interface RotationOverlaysProps {
    zoom: number;
    aiRotationState: AIRotationState | null;
    interactionMode: string | null;
    rotateStartInfo: { originalElement: Element; center: Point; startCanvasPoint: Point; } | null;
    rotateDialPoint: Point | null;
    elements: Element[];
}

export const RotationOverlays: React.FC<RotationOverlaysProps> = ({
    zoom,
    aiRotationState,
    interactionMode,
    rotateStartInfo,
    rotateDialPoint,
    elements
}) => {
    return (
        <g>
            {aiRotationState && (
                <g>
                    {/* Visual guides for AI Rotation */}
                    <circle
                        cx={aiRotationState.center.x} cy={aiRotationState.center.y}
                        r={150 / zoom}
                        fill="none" stroke="rgba(255, 255, 255, 0.2)" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${2 / zoom}`}
                        pointerEvents="none"
                    />
                    <line
                        x1={aiRotationState.center.x - 150 / zoom} y1={aiRotationState.center.y}
                        x2={aiRotationState.center.x + 150 / zoom} y2={aiRotationState.center.y}
                        stroke="rgba(255, 255, 255, 0.3)" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${2 / zoom}`}
                        pointerEvents="none"
                    />
                    <line
                        x1={aiRotationState.center.x} y1={aiRotationState.center.y - 150 / zoom}
                        x2={aiRotationState.center.x} y2={aiRotationState.center.y + 150 / zoom}
                        stroke="rgba(255, 255, 255, 0.3)" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${2 / zoom}`}
                        pointerEvents="none"
                    />

                    {/* Draggable Handle Logic */}
                    {(() => {
                        const handleVisibleRadius = 15 / zoom;
                        const grabAreaRadius = 20 / zoom;

                        // Calculate the handle's position based on the current angle and drag direction
                        let handleCx = aiRotationState.center.x;
                        let handleCy = aiRotationState.center.y;

                        // Only move the handle visually during the drag interaction
                        if (interactionMode === 'ai-rotate' && aiRotationState.dragDirection) {
                            const maxDistance = 150 / zoom;
                            const distanceRatio = aiRotationState.currentAngle / 90;
                            const distance = distanceRatio * maxDistance;

                            if (aiRotationState.dragDirection === 'h') {
                                handleCx += distance;
                            } else { // 'v'
                                handleCy -= distance; // angle is positive for up, so cy decreases
                            }
                        }

                        const angleText = (
                            <text
                                x={handleCx} y={handleCy}
                                fill={interactionMode === 'ai-rotate' ? '#3b82f6' : 'white'}
                                fontSize={12 / zoom} textAnchor="middle" dominantBaseline="central"
                                pointerEvents="none"
                                style={{ fontWeight: 'bold' }}
                            >
                                {aiRotationState.currentAngle.toFixed(0)}°
                            </text>
                        );

                        return (
                            <g>
                                {/* A larger, invisible circle for easier grabbing at the center */}
                                <circle
                                    data-handle="ai-rotate"
                                    cx={aiRotationState.center.x}
                                    cy={aiRotationState.center.y}
                                    r={grabAreaRadius}
                                    fill="transparent"
                                    style={{ cursor: 'grab' }}
                                />

                                {/* The visible handle that moves */}
                                <circle
                                    cx={handleCx}
                                    cy={handleCy}
                                    r={handleVisibleRadius}
                                    fill="white"
                                    stroke="#3b82f6"
                                    strokeWidth={2 / zoom}
                                    style={{ pointerEvents: 'none' }}
                                />
                                {angleText}
                            </g>
                        );
                    })()}
                </g>
            )}

            {interactionMode === 'rotate' && rotateStartInfo && (() => {
                const rotatingElement = elements.find(el => el.id === rotateStartInfo.originalElement.id);
                if (!rotatingElement || !('rotation' in rotatingElement) || !rotateDialPoint) return null;

                const { center } = rotateStartInfo;
                const bounds = getElementBounds(rotateStartInfo.originalElement, elements);
                const elementRadius = Math.hypot(bounds.width / 2, bounds.height / 2);
                const radius = elementRadius + 40 / zoom;

                const currentRotation = rotatingElement.rotation || 0;
                const angleToMouseRad = Math.atan2(rotateDialPoint.y - center.y, rotateDialPoint.x - center.x);

                return (
                    <g pointerEvents="none">
                        <circle cx={center.x} cy={center.y} r={radius} fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${4 / zoom}`} />
                        {Array.from({ length: 12 }).map((_, i) => {
                            const angle = i * 30;
                            const angleRad = angle * Math.PI / 180;
                            const isMajorTick = i % 3 === 0;
                            const tickLength = (isMajorTick ? 10 : 5) / zoom;
                            const startX = center.x + (radius - tickLength) * Math.cos(angleRad);
                            const startY = center.y + (radius - tickLength) * Math.sin(angleRad);
                            const endX = center.x + radius * Math.cos(angleRad);
                            const endY = center.y + radius * Math.sin(angleRad);
                            return <line key={i} x1={startX} y1={startY} x2={endX} y2={endY} stroke="rgba(255, 255, 255, 0.5)" strokeWidth={isMajorTick ? 1.5 / zoom : 1 / zoom} />
                        })}
                        <line x1={center.x} y1={center.y} x2={center.x + radius * Math.cos(angleToMouseRad)} y2={center.y + radius * Math.sin(angleToMouseRad)} stroke="#3b82f6" strokeWidth={1.5 / zoom} />
                        <g transform={`translate(${center.x}, ${center.y})`}>
                            <rect x={-25 / zoom} y={-15 / zoom} width={50 / zoom} height={30 / zoom} fill="rgba(17, 24, 39, 0.8)" rx={4 / zoom} />
                            <text x={0} y={0} fill="white" fontSize={14 / zoom} textAnchor="middle" dominantBaseline="central" style={{ fontWeight: 'bold' }}>
                                {`${((currentRotation) % 360).toFixed(0)}°`}
                            </text>
                        </g>
                    </g>
                );
            })()}
        </g>
    );
};
