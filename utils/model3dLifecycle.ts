import * as THREE from 'three';

// One pending frame at most. OrbitControls.change wakes a settled viewport;
// update() keeps damping alive until it settles, without a perpetual idle RAF.
export function createModel3DRenderLoop(options: {
    update: (delta: number) => boolean;
    render: () => void;
    continuous: () => boolean;
    active?: () => boolean;
    visibilityTarget?: Element;
}) {
    let frame: number | null = null;
    let disposed = false;
    let previous: number | null = null;
    // Wait for the first intersection result: offscreen viewers must not start
    // their default auto-rotation loop merely because their model finished loading.
    let intersecting = !options.visibilityTarget || typeof IntersectionObserver === 'undefined';
    const visible = () => !document.hidden && intersecting && (options.active?.() ?? true);
    const invalidate = () => {
        if (disposed) return;
        if (!visible()) {
            previous = null;
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
        } else if (frame === null) frame = requestAnimationFrame(tick);
    };
    const tick = (time: number) => {
        frame = null;
        if (disposed || !visible()) { previous = null; return; }
        const delta = previous === null ? 0 : (time - previous) / 1000;
        previous = time;
        const changed = options.update(delta);
        options.render();
        if (changed || options.continuous()) invalidate();
        else previous = null;
    };
    const onVisibility = () => {
        previous = null;
        invalidate();
    };
    const intersectionObserver = options.visibilityTarget && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(entries => {
            const entry = entries.find(candidate => candidate.target === options.visibilityTarget);
            if (!entry || disposed) return;
            // isIntersecting includes edge contact. At threshold 0 the browser
            // need not notify again when edge contact becomes positive area.
            intersecting = entry.isIntersecting;
            onVisibility();
        }) : null;
    if (options.visibilityTarget) intersectionObserver?.observe(options.visibilityTarget);
    document.addEventListener('visibilitychange', onVisibility);
    invalidate();
    return {
        invalidate,
        dispose() {
            disposed = true;
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
            document.removeEventListener('visibilitychange', onVisibility);
            intersectionObserver?.disconnect();
        },
    };
}

// CSS transforms (board zoom/pan) do not change the content box. Consume the
// observer's supplied size instead of forcing a layout read or reallocating an
// unchanged drawing buffer. Canvas CSS sizing stays owned by its container.
export function observeModel3DSize(
    target: Element,
    initialWidth: number,
    initialHeight: number,
    resize: (width: number, height: number) => void,
): ResizeObserver {
    let width = initialWidth;
    let height = initialHeight;
    const observer = new ResizeObserver(entries => {
        const entry = entries.find(candidate => candidate.target === target);
        if (!entry) return;
        const nextWidth = Math.floor(entry.contentRect.width);
        const nextHeight = Math.floor(entry.contentRect.height);
        if (nextWidth <= 0 || nextHeight <= 0 || (width === nextWidth && height === nextHeight)) return;
        width = nextWidth;
        height = nextHeight;
        resize(width, height);
    });
    observer.observe(target);
    return observer;
}

// Viewers own their loaded scene. Shared geometries/materials/textures within
// that scene are disposed once, including late load results after unmount.
export function disposeModel3DObject(root: THREE.Object3D): void {
    const resources = new Set<{ dispose: () => void }>();
    root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) resources.add(mesh.geometry);
        if (mesh.material) {
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const material of materials) {
                resources.add(material);
                for (const value of Object.values(material)) {
                    if (value instanceof THREE.Texture) resources.add(value);
                }
            }
        }
        const skinned = object as THREE.SkinnedMesh;
        if (skinned.skeleton) resources.add(skinned.skeleton);
        const light = object as THREE.Light & { shadow?: THREE.LightShadow };
        if (light.shadow) resources.add(light.shadow);
    });
    resources.forEach(resource => resource.dispose());
}
