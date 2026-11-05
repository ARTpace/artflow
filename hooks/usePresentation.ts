
import { useState, useCallback, useMemo, useRef } from 'react';
import type { Element, FrameElement, Point, Rect } from '../types';
import type { CanvasViewportStore } from '../utils/viewport-store';
import { getCanvasScreenRect } from '../utils/canvasUtils';

export const usePresentation = (
    elements: Element[],
    zoom: number,
    panOffset: { x: number; y: number },
    updateActiveBoard: (updater: (board: any) => any) => void,
    viewportStore?: CanvasViewportStore
) => {
    const [presentationState, setPresentationState] = useState<{ 
        isActive: boolean; 
        currentFrameIndex: number; 
        transition: 'direct' | 'smooth' 
    } | null>(null);

    const animationFrameId = useRef<number | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const elementsRef = useRef(elements);
    elementsRef.current = elements;

    const frames = useMemo(() => 
        ((elements || []).filter(el => el && el.type === 'frame') as FrameElement[]).reverse(), 
    [elements]);

    const zoomToBounds = useCallback((bounds: Rect, options: { animated?: boolean; minZoom?: number } = {}) => {
        if (animationFrameId.current) {
            cancelAnimationFrame(animationFrameId.current);
            animationFrameId.current = null;
            // 动画被新目标打断时先提交当前位置，避免瞬时相机一直挂着不落盘。
            viewportStore?.endInteraction();
        }

        if (!svgRef.current) return;
        if (bounds.width <= 0 || bounds.height <= 0) return;
    
        // 屏幕基准用未变换的容器盒子（相机 transform 在 <svg> 上，见 ADR-049）。
        const svgBounds = getCanvasScreenRect(svgRef.current);
        if (!svgBounds) return;
        const padding = 50;
        const viewportWidth = svgBounds.width - padding * 2;
        const viewportHeight = svgBounds.height - padding * 2;
    
        const newZoom = Math.min(viewportWidth / bounds.width, viewportHeight / bounds.height);
        const clampedZoom = Math.max(options.minZoom ?? 0.1, Math.min(newZoom, 10));
    
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
    
        const newPanX = (svgBounds.width / 2) - (centerX * clampedZoom);
        const newPanY = (svgBounds.height / 2) - (centerY * clampedZoom);
    
        if (!options.animated) {
            const target = { zoom: clampedZoom, panOffset: { x: newPanX, y: newPanY } };
            if (viewportStore) {
                // 瞬时通道 + 立即提交：一次文档写入，不经过"每帧 updateActiveBoard"。
                viewportStore.setTransient(target);
                viewportStore.endInteraction();
            } else {
                updateActiveBoard(b => ({ ...b, zoom: clampedZoom, panOffset: { x: newPanX, y: newPanY } }));
            }
            return;
        }

        const startViewport = viewportStore ? viewportStore.getLive() : { zoom, panOffset };
        const startZoom = startViewport.zoom;
        const startPan = startViewport.panOffset;
        viewportStore?.beginInteraction();
        const duration = 600;
        let startTime: number | null = null;
        
        const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;

        const animate = (timestamp: number) => {
            if (!startTime) startTime = timestamp;
            const elapsed = timestamp - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easedProgress = easeInOutCubic(progress);

            const currentZoom = startZoom + (clampedZoom - startZoom) * easedProgress;
            const currentPanX = startPan.x + (newPanX - startPan.x) * easedProgress;
            const currentPanY = startPan.y + (newPanY - startPan.y) * easedProgress;
            
            if (viewportStore) {
                // 动画期间只动瞬时相机：App 不再逐帧重绘，结束时提交一次。
                viewportStore.setTransient({ zoom: currentZoom, panOffset: { x: currentPanX, y: currentPanY } });
            } else {
                updateActiveBoard(b => ({ ...b, zoom: currentZoom, panOffset: { x: currentPanX, y: currentPanY } }));
            }

            if (progress < 1) {
                animationFrameId.current = requestAnimationFrame(animate);
            } else {
                animationFrameId.current = null;
                viewportStore?.endInteraction();
            }
        };

        animationFrameId.current = requestAnimationFrame(animate);
    }, [zoom, panOffset, updateActiveBoard, viewportStore]);

    const zoomToFrame = useCallback((frameId: string, options: { animated?: boolean } = {}) => {
        const frame = elementsRef.current.find(el => el.id === frameId && el.type === 'frame') as FrameElement;
        if (!frame) return;
        zoomToBounds({ x: frame.x, y: frame.y, width: frame.width, height: frame.height }, options);
    }, [zoomToBounds]);

    const handleNavigateWithTransition = useCallback((direction: 'next' | 'prev', transition: 'smooth' | 'direct') => {
        if (!presentationState || frames.length < 2) return;
        const newIndex = direction === 'next' 
            ? (presentationState.currentFrameIndex + 1) % frames.length
            : (presentationState.currentFrameIndex - 1 + frames.length) % frames.length;
        setPresentationState(prev => ({ ...prev!, currentFrameIndex: newIndex }));
        zoomToFrame(frames[newIndex].id, { animated: transition === 'smooth' });
    }, [presentationState, frames, zoomToFrame]);

    const handleExitPresentation = useCallback(() => {
        setPresentationState(null);
    }, []);

    const handleStartPresentation = useCallback((frameId?: string) => {
        const index = frameId ? frames.findIndex(f => f.id === frameId) : 0;
        setPresentationState({
            isActive: true,
            currentFrameIndex: index >= 0 ? index : 0,
            transition: 'smooth'
        });
        if (frames.length > 0) {
            zoomToFrame(frames[index >= 0 ? index : 0].id, { animated: true });
        }
    }, [frames, zoomToFrame]);

    const handleNavigatePresentation = useCallback((direction: 'next' | 'prev') => {
        if (!presentationState || frames.length < 2) return;

        const newIndex = direction === 'next' 
            ? (presentationState.currentFrameIndex + 1) % frames.length
            : (presentationState.currentFrameIndex - 1 + frames.length) % frames.length;
        
        setPresentationState(prev => ({ ...prev!, currentFrameIndex: newIndex }));
        zoomToFrame(frames[newIndex].id, { animated: presentationState.transition === 'smooth' });
    }, [presentationState, frames, zoomToFrame]);

    return {
        presentationState,
        setPresentationState,
        frames,
        zoomToFrame,
        zoomToBounds,
        handleNavigateWithTransition,
        handleExitPresentation,
        handleStartPresentation,
        handleNavigatePresentation,
        svgRef
    };
};
