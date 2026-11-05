import { useEffect, useRef } from 'react';
import type React from 'react';
import type { HostPlatformService, WindowMoveRequest } from '../plugin-runtime/host-platform';

/** Click is still a context menu; a deliberate 6px right-drag moves the app window. */
export const RIGHT_WINDOW_DRAG_THRESHOLD_PX = 6;

type RightGesture = {
    screenX: number;
    screenY: number;
    elementId: string | null;
    dragging: boolean;
    lastScreenX: number;
    lastScreenY: number;
    frame: number | null;
    cleanup: () => void;
};

interface CanvasWindowMoveOptions {
    svgRef: React.RefObject<SVGSVGElement>;
    platform: HostPlatformService | null;
    showMenu: (x: number, y: number, elementId: string | null) => void;
    dismissMenu: () => void;
}

/** No React state updates while moving; native events continue across sidebars. */
export function useCanvasWindowMove(options: CanvasWindowMoveOptions) {
    const latest = useRef(options);
    latest.current = options;
    const session = useRef<RightGesture | null>(null);
    const suppressContextUntil = useRef(0);

    const send = (request: WindowMoveRequest) => {
        const platform = latest.current.platform;
        if (platform?.isFramelessWindow) {
            void platform.windowMove(request).catch(() => {});
        }
    };

    const finish = (cancel: boolean, event?: MouseEvent) => {
        const active = session.current;
        if (!active) return;
        session.current = null;
        active.cleanup();
        if (active.frame !== null) cancelAnimationFrame(active.frame);
        // Windows normally fires contextmenu after mouseup. Our click already
        // opened the app menu, and a drag must never open either native or app menu.
        suppressContextUntil.current = performance.now() + 350;
        if (active.dragging) {
            // Include the release coordinate; the queued rAF might not have run yet.
            if (event && Number.isFinite(event.screenX) && Number.isFinite(event.screenY)) {
                send({ phase: 'update', screenX: event.screenX, screenY: event.screenY });
            } else {
                send({ phase: 'update', screenX: active.lastScreenX, screenY: active.lastScreenY });
            }
            send({ phase: 'end' });
        } else if (!cancel && event && latest.current.svgRef.current?.contains(event.target as Node)) {
            latest.current.showMenu(event.clientX, event.clientY, active.elementId);
        }
    };
    const finishRef = useRef(finish);
    finishRef.current = finish;

    useEffect(() => {
        // Capture at window level to intercept the browser's context menu even
        // when the right button is released over a floating panel or outside SVG.
        const blockContextMenu = (event: MouseEvent) => {
            if (!session.current && performance.now() >= suppressContextUntil.current) return;
            event.preventDefault();
            event.stopPropagation();
        };
        window.addEventListener('contextmenu', blockContextMenu, true);
        return () => {
            window.removeEventListener('contextmenu', blockContextMenu, true);
            finishRef.current(true);
        };
    }, []);

    const onMouseDownCapture = (event: React.MouseEvent<SVGSVGElement>) => {
        if (event.button !== 2) return;
        // Editable controls inside foreignObject are not a canvas drag surface.
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"]')) return;
        event.preventDefault();
        event.stopPropagation(); // never start an image/shape tool with the right button
        if (session.current || (event.buttons & 1)) return;
        latest.current.dismissMenu();

        const elementId = target instanceof globalThis.Element
            ? target.closest('g[data-id]')?.getAttribute('data-id') ?? null : null;
        const downX = event.screenX;
        const downY = event.screenY;
        if (!Number.isFinite(downX) || !Number.isFinite(downY)) return;
        const owner = event.currentTarget.ownerDocument.defaultView;
        if (!owner) return;

        const onMove = (native: MouseEvent) => {
            const active = session.current;
            if (!active) return;
            // A mouseup outside the OS window can be missed; never leave a
            // captured gesture alive on re-entry without a held right button.
            if ((native.buttons & 2) === 0) { finishRef.current(true); return; }
            active.lastScreenX = native.screenX;
            active.lastScreenY = native.screenY;
            if (!active.dragging && Math.hypot(
                native.screenX - active.screenX,
                native.screenY - active.screenY,
            ) >= RIGHT_WINDOW_DRAG_THRESHOLD_PX) {
                active.dragging = true;
                latest.current.dismissMenu();
                send({ phase: 'start', screenX: active.screenX, screenY: active.screenY });
            }
            if (active.dragging && active.frame === null) {
                active.frame = owner.requestAnimationFrame(() => {
                    active.frame = null;
                    if (session.current === active) {
                        send({ phase: 'update', screenX: active.lastScreenX, screenY: active.lastScreenY });
                    }
                });
            }
        };
        const onUp = (native: MouseEvent) => {
            if (native.button !== 2) return;
            native.preventDefault();
            native.stopPropagation();
            finishRef.current(false, native);
        };
        const onBlur = () => finishRef.current(true);
        const onVisibilityChange = () => { if (owner.document.hidden) onBlur(); };
        const cleanup = () => {
            owner.removeEventListener('mousemove', onMove, true);
            owner.removeEventListener('mouseup', onUp, true);
            owner.removeEventListener('blur', onBlur);
            owner.document.removeEventListener('visibilitychange', onVisibilityChange);
        };
        session.current = {
            screenX: downX, screenY: downY, elementId,
            dragging: false, lastScreenX: downX, lastScreenY: downY,
            frame: null, cleanup,
        };
        owner.addEventListener('mousemove', onMove, true);
        owner.addEventListener('mouseup', onUp, true);
        owner.addEventListener('blur', onBlur);
        owner.document.addEventListener('visibilitychange', onVisibilityChange);
    };

    return { onMouseDownCapture };
}
