import { useMemo } from 'react';
import type { Tool } from '../types';

interface CanvasCursorProps {
    croppingState: any;
    aiRotationState: any;
    activeTool: Tool;
    interactionMode: { current: string };
}

export const useCanvasCursor = ({
    croppingState,
    aiRotationState,
    activeTool,
    interactionMode,
}: CanvasCursorProps) => {
    const cursor = useMemo(() => {
        if (croppingState) return 'default';
        if (interactionMode.current === 'ai-rotate') return 'grabbing';
        if (aiRotationState) return 'grab';
        if (interactionMode.current === 'pan') return 'grabbing';
        if (activeTool === 'pan') return 'grab';
        if (['draw', 'erase', 'rectangle', 'circle', 'triangle', 'arrow', 'line', 'text', 'highlighter', 'lasso', 'frame'].includes(activeTool)) return 'crosshair';
        return 'default';
    }, [croppingState, aiRotationState, activeTool, interactionMode.current]);

    return cursor;
};