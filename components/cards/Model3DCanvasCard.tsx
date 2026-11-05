import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { 
    Box, 
    RotateCw, 
    Maximize2, 
    Minimize2, 
    Download, 
    Eye, 
    Layers, 
    Sun, 
    Moon, 
    RotateCcw,
    Loader2,
    AlertCircle,
    Sliders
} from 'lucide-react';
import type { Model3DElement } from '../../types';
import { load3DModel, LoadModelResult, isPreviewable3DFile } from '../../utils/model3dUtils';
import { createModel3DRenderLoop, disposeModel3DObject, observeModel3DSize } from '../../utils/model3dLifecycle';
import { formatBytes } from '../../utils/docUtils';
import { useTranslation } from '../../utils/language-store';

interface Model3DCanvasCardProps {
    element: Model3DElement;
    isSelected: boolean;
    onUpdate?: (updates: Partial<Model3DElement>) => void;
}

type WireframeMaterial = THREE.Material & { wireframe: boolean };

const isWireframeMaterial = (material: THREE.Material): material is WireframeMaterial =>
    'wireframe' in material;

const setMeshWireframe = (material: THREE.Material | THREE.Material[], enabled: boolean): void => {
    const materials = Array.isArray(material) ? material : [material];
    for (const candidate of materials) {
        if (isWireframeMaterial(candidate)) candidate.wireframe = enabled;
    }
};

export const Model3DCanvasCard: React.FC<Model3DCanvasCardProps> = React.memo(({
    element,
    isSelected,
    onUpdate,
}: Model3DCanvasCardProps) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const modelGroupRef = useRef<THREE.Group | null>(null);
    const mixerRef = useRef<THREE.AnimationMixer | null>(null);
    const invalidateRef = useRef<(() => void) | null>(null);
    const settingsRef = useRef({ autoRotate: element.autoRotate ?? true, wireframe: element.wireframe ?? false });
    const fullscreenRef = useRef(false);

    const [loading, setLoading] = useState(true);
    const [loadPercent, setLoadPercent] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [autoRotate, setAutoRotate] = useState(element.autoRotate ?? true);
    const [wireframe, setWireframe] = useState(element.wireframe ?? false);
    const [bgTheme, setBgTheme] = useState<'dark' | 'light' | 'studio'>(
        element.theme === 'light' ? 'light' : element.theme === 'dark' ? 'dark' : 'studio'
    );
    const [stats, setStats] = useState<{ vertexCount: number; triangleCount: number; meshCount: number } | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showStats, setShowStats] = useState(false);

    settingsRef.current = { autoRotate, wireframe };
    fullscreenRef.current = isFullscreen;
    const isPreviewable = isPreviewable3DFile(element.fileExtension);

    // Initial 3D Scene Setup
    useEffect(() => {
        if (!containerRef.current || !isPreviewable) {
            setLoading(false);
            return;
        }

        const container = containerRef.current;
        const width = container.clientWidth || element.width || 400;
        const height = container.clientHeight || (element.height - 42) || 280;

        // Scene
        const scene = new THREE.Scene();
        sceneRef.current = scene;

        // Camera
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
        camera.position.set(0, 1.5, 4.5);
        cameraRef.current = camera;

        // Renderer
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height, false);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;
        rendererRef.current = renderer;

        container.innerHTML = '';
        container.appendChild(renderer.domElement);

        // OrbitControls
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.rotateSpeed = 0.8;
        controls.zoomSpeed = 0.8;
        controls.autoRotate = autoRotate;
        controls.autoRotateSpeed = 2.0;
        controlsRef.current = controls;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
        scene.add(ambientLight);

        const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
        keyLight.position.set(5, 8, 5);
        keyLight.castShadow = true;
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0x90cdf4, 1.2);
        fillLight.position.set(-5, 4, -4);
        scene.add(fillLight);

        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334155, 0.8);
        scene.add(hemiLight);

        // Grid Floor
        const gridHelper = new THREE.GridHelper(10, 20, 0x64748b, 0x334155);
        gridHelper.position.y = -1.5;
        scene.add(gridHelper);

        let disposed = false;
        let mixer: THREE.AnimationMixer | null = null;
        let model: THREE.Object3D | null = null;
        const loop = createModel3DRenderLoop({
            update: delta => {
                mixer?.update(delta);
                controls.autoRotate = !!model && settingsRef.current.autoRotate;
                return controls.update();
            },
            render: () => renderer.render(scene, camera),
            continuous: () => (!!model && controls.autoRotate) || !!mixer,
            active: () => !fullscreenRef.current,
            visibilityTarget: container,
        });
        invalidateRef.current = loop.invalidate;
        controls.addEventListener('change', loop.invalidate);

        // Load the 3D Model
        setLoading(true);
        setError(null);

        setLoadPercent(0);
        setStats(null);
        load3DModel(element.fileUrl, element.fileExtension, pct => { if (!disposed) setLoadPercent(pct); })
            .then((res: LoadModelResult) => {
                if (disposed) { disposeModel3DObject(res.object); return; }
                model = res.object;
                modelGroupRef.current = res.object as THREE.Group;
                scene.add(res.object);
                setStats(res.stats);

                // Setup animations if present
                if (res.animations.length > 0) {
                    mixer = new THREE.AnimationMixer(res.object);
                    for (const clip of res.animations) mixer.clipAction(clip).play();
                    mixerRef.current = mixer;
                }

                // Apply initial wireframe setting
                if (settingsRef.current.wireframe) {
                    res.object.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh) {
                            const mesh = child as THREE.Mesh;
                            if (mesh.material) setMeshWireframe(mesh.material, true);
                        }
                    });
                }

                loop.invalidate();
                setLoading(false);
            })
            .catch((err) => {
                if (disposed) return;
                console.error('Failed to load 3D model:', err);
                setError(err.message || 'Failed to parse 3D model.');
                setLoading(false);
            });

        // Resize observer
        const resizeObserver = observeModel3DSize(container, width, height, (newW, newH) => {
            camera.aspect = newW / newH;
            camera.updateProjectionMatrix();
            renderer.setSize(newW, newH, false);
            loop.invalidate();
        });

        return () => {
            disposed = true;
            loop.dispose();
            invalidateRef.current = null;
            resizeObserver.disconnect();
            controls.removeEventListener('change', loop.invalidate);
            controls.dispose();
            mixer?.stopAllAction();
            if (model) mixer?.uncacheRoot(model);
            disposeModel3DObject(scene);
            renderer.dispose();
            renderer.domElement.remove();
            sceneRef.current = null;
            cameraRef.current = null;
            rendererRef.current = null;
            controlsRef.current = null;
            modelGroupRef.current = null;
            mixerRef.current = null;
        };
    }, [element.fileUrl, element.fileExtension, isPreviewable]);

    // Update Auto-Rotate
    useEffect(() => {
        if (controlsRef.current) {
            controlsRef.current.autoRotate = autoRotate;
            invalidateRef.current?.();
        }
    }, [autoRotate]);

    useEffect(() => { invalidateRef.current?.(); }, [isFullscreen]);

    // Update Wireframe
    useEffect(() => {
        if (modelGroupRef.current) {
            modelGroupRef.current.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    if (mesh.material) setMeshWireframe(mesh.material, wireframe);
                }
            });
        }
        invalidateRef.current?.();
    }, [wireframe]);

    const handleResetCamera = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (cameraRef.current && controlsRef.current) {
            cameraRef.current.position.set(0, 1.5, 4.5);
            controlsRef.current.target.set(0, 0, 0);
            controlsRef.current.update();
        }
    };

    const handleToggleAutoRotate = (e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !autoRotate;
        setAutoRotate(next);
        onUpdate?.({ autoRotate: next });
    };

    const handleToggleWireframe = (e: React.MouseEvent) => {
        e.stopPropagation();
        const next = !wireframe;
        setWireframe(next);
        onUpdate?.({ wireframe: next });
    };

    const handleCycleTheme = (e: React.MouseEvent) => {
        e.stopPropagation();
        const themes: Array<'studio' | 'dark' | 'light'> = ['studio', 'dark', 'light'];
        const next = themes[(themes.indexOf(bgTheme) + 1) % themes.length];
        setBgTheme(next);
    };

    const bgClass = bgTheme === 'studio' 
        ? 'bg-gradient-to-b from-slate-900 via-slate-800 to-slate-950 text-white' 
        : bgTheme === 'dark' 
            ? 'bg-neutral-950 text-white' 
            : 'bg-gradient-to-b from-slate-50 via-slate-100 to-slate-200 text-slate-900';

    return (
        <div
            id={`model3d-card-${element.id}`}
            className={`w-full h-full flex flex-col rounded-xl overflow-hidden shadow-xl select-none transition-all duration-200 border ${
                isSelected 
                    ? 'ring-2 ring-[var(--bp-card-accent-3d,var(--bp-accent))] border-[var(--bp-card-accent-3d,var(--bp-accent))]' 
                    : 'border-slate-700/50 hover:border-slate-600'
            } ${bgClass}`}
            style={{ minWidth: 260, minHeight: 200 }}
            onWheel={(e) => {
                // Prevent canvas zooming when scrolling over the 3D viewport
                e.stopPropagation();
            }}
        >
            {/* Header / Control Bar */}
            <div 
                className="flex items-center justify-between px-3 py-2 bg-black/40 backdrop-blur-md border-b border-white/10 z-10 cursor-move"
                title={t('model3d.dragHint')}
            >
                <div className="flex items-center gap-2 min-w-0 pr-2">
                    <div className="p-1 rounded-md bg-[var(--bp-accent-soft)] text-[var(--bp-card-accent-3d,var(--bp-accent))] border border-[var(--bp-card-accent-3d,var(--bp-accent))] flex-shrink-0">
                        <Box className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                        <div className="text-xs font-semibold truncate tracking-tight" title={element.name}>
                            {element.name}
                        </div>
                    </div>
                </div>

                {/* Badges & Actions */}
                <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    <span className="px-1.5 py-0.5 text-[10px] font-mono font-medium rounded uppercase bg-[var(--bp-accent-soft)] text-[var(--bp-card-accent-3d,var(--bp-accent))] border border-[var(--bp-card-accent-3d,var(--bp-accent))]">
                        {element.fileExtension.toUpperCase()}
                    </span>

                    {/* Auto-Rotate Toggle */}
                    <button
                        onClick={handleToggleAutoRotate}
                        title={autoRotate ? "Pause Auto-Rotation" : "Enable Auto-Rotation"}
                        className={`p-1 rounded hover:bg-white/10 transition-colors ${
                            autoRotate ? 'text-[var(--bp-card-accent-3d,var(--bp-accent))]' : 'text-white/50'
                        }`}
                    >
                        <RotateCw className={`w-3.5 h-3.5 ${autoRotate ? 'animate-spin-slow' : ''}`} />
                    </button>

                    {/* Wireframe Toggle */}
                    <button
                        onClick={handleToggleWireframe}
                        title={wireframe ? "Solid Mesh Mode" : "Wireframe Mode"}
                        className={`p-1 rounded hover:bg-white/10 transition-colors ${
                            wireframe ? 'text-emerald-400 bg-emerald-500/10' : 'text-white/50'
                        }`}
                    >
                        <Layers className="w-3.5 h-3.5" />
                    </button>

                    {/* Theme Toggle */}
                    <button
                        onClick={handleCycleTheme}
                        title={`Environment: ${bgTheme}`}
                        className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                    >
                        {bgTheme === 'light' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                    </button>

                    {/* Reset View */}
                    <button
                        onClick={handleResetCamera}
                        title={t('model3d.resetCamera')}
                        className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                    </button>

                    {/* Fullscreen Inspector Modal */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsFullscreen(true);
                        }}
                        title={t('model3d.fullscreen')}
                        className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                    >
                        <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* 3D WebGL Canvas Area */}
            <div className="relative flex-1 w-full min-h-0 overflow-hidden cursor-grab active:cursor-grabbing">
                {isPreviewable ? (
                    <div ref={containerRef} className="w-full h-full" />
                ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center">
                        <Box className="w-12 h-12 text-slate-500 mb-2 animate-pulse" />
                        <div className="text-sm font-medium text-slate-300">
                            {element.fileExtension.toUpperCase()} 3D Model
                        </div>
                        <div className="text-xs text-slate-500 mt-1 max-w-[200px]">
                            Preview is supported for GLB, GLTF, OBJ, STL, and PLY files.
                        </div>
                        <a
                            href={element.fileUrl}
                            download={element.name}
                            className="mt-3 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs text-white font-medium flex items-center gap-1.5 shadow"
                        >
                            <Download className="w-3.5 h-3.5" />
                            Download Model
                        </a>
                    </div>
                )}

                {/* Loading State Overlay */}
                {loading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/70 backdrop-blur-sm z-20">
                        <Loader2 className="w-7 h-7 text-indigo-400 animate-spin mb-2" />
                        <span className="text-xs font-medium text-slate-200">
                            Loading 3D Mesh... {loadPercent > 0 ? `${loadPercent}%` : ''}
                        </span>
                    </div>
                )}

                {/* Error State Overlay */}
                {error && !loading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm text-center z-20">
                        <AlertCircle className="w-8 h-8 text-rose-400 mb-2" />
                        <div className="text-xs font-semibold text-rose-200">{error}</div>
                        <a
                            href={element.fileUrl}
                            download={element.name}
                            className="mt-3 px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-white flex items-center gap-1"
                        >
                            <Download className="w-3.5 h-3.5" /> Download File
                        </a>
                    </div>
                )}

                {/* Floating Bottom Info Pill */}
                {stats && !loading && (
                    <div 
                        className="absolute bottom-2 left-2 z-10 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/50 backdrop-blur-md border border-white/10 text-[10px] text-slate-300"
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowStats(!showStats);
                        }}
                    >
                        <span>▲ {stats.triangleCount.toLocaleString()} polys</span>
                        {element.fileSize && (
                            <>
                                <span className="opacity-40">•</span>
                                <span>{formatBytes(element.fileSize)}</span>
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* Fullscreen 3D Inspector Modal */}
            {isFullscreen && (
                <div 
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-6 animate-in fade-in duration-200"
                    onClick={(e) => {
                        e.stopPropagation();
                        setIsFullscreen(false);
                    }}
                >
                    <div 
                        className="relative w-full max-w-5xl h-[85vh] bg-slate-900 rounded-2xl overflow-hidden border border-slate-700 shadow-2xl flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Modal Header */}
                        <div className="flex items-center justify-between px-5 py-3 bg-slate-950/90 border-b border-slate-800">
                            <div className="flex items-center gap-3">
                                <Box className="w-5 h-5 text-indigo-400" />
                                <div>
                                    <div className="text-sm font-semibold text-white">{element.name}</div>
                                    <div className="text-xs text-slate-400 flex items-center gap-2">
                                        <span className="uppercase text-indigo-400 font-mono">{element.fileExtension}</span>
                                        {element.fileSize && <span>• {formatBytes(element.fileSize)}</span>}
                                        {stats && <span>• {stats.triangleCount.toLocaleString()} Polygons ({stats.vertexCount.toLocaleString()} Vertices)</span>}
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                <a
                                    href={element.fileUrl}
                                    download={element.name}
                                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white flex items-center gap-1.5 border border-slate-700"
                                >
                                    <Download className="w-3.5 h-3.5" /> Export File
                                </a>
                                <button
                                    onClick={() => setIsFullscreen(false)}
                                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white"
                                >
                                    <Minimize2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        {/* Modal 3D Body (Re-mount viewer) */}
                        <div className="flex-1 w-full h-full relative">
                            <ModalViewer 
                                fileUrl={element.fileUrl} 
                                fileExtension={element.fileExtension}
                                autoRotate={autoRotate}
                                wireframe={wireframe}
                                bgTheme={bgTheme}
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}, (previous, next) => previous.isSelected === next.isSelected
    && previous.onUpdate === next.onUpdate
    && previous.element.id === next.element.id
    && previous.element.name === next.element.name
    && previous.element.width === next.element.width
    && previous.element.height === next.element.height
    && previous.element.fileUrl === next.element.fileUrl
    && previous.element.fileExtension === next.element.fileExtension
    && previous.element.fileSize === next.element.fileSize
    && previous.element.autoRotate === next.element.autoRotate
    && previous.element.wireframe === next.element.wireframe
    && previous.element.theme === next.element.theme);

// Subcomponent for Fullscreen High-Res 3D Inspector
const ModalViewer: React.FC<{
    fileUrl: string;
    fileExtension: string;
    autoRotate: boolean;
    wireframe: boolean;
    bgTheme: 'studio' | 'dark' | 'light';
}> = ({ fileUrl, fileExtension, autoRotate, wireframe, bgTheme }) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const settingsRef = useRef({ autoRotate, wireframe });
    settingsRef.current = { autoRotate, wireframe };
    const invalidateRef = useRef<(() => void) | null>(null);
    const modelRef = useRef<THREE.Object3D | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        modelRef.current?.traverse(child => {
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh && mesh.material) setMeshWireframe(mesh.material, wireframe);
        });
        invalidateRef.current?.();
    }, [autoRotate, wireframe]);

    useEffect(() => {
        if (!mountRef.current) return;
        const container = mountRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
        camera.position.set(0, 1.5, 4.5);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height, false);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';
        renderer.shadowMap.enabled = true;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        container.innerHTML = '';
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.autoRotate = autoRotate;
        controls.autoRotateSpeed = 1.5;

        // Lights
        scene.add(new THREE.AmbientLight(0xffffff, 1.4));
        const key = new THREE.DirectionalLight(0xffffff, 2.5);
        key.position.set(6, 10, 6);
        key.castShadow = true;
        scene.add(key);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.0));

        const grid = new THREE.GridHelper(12, 24, 0x64748b, 0x334155);
        grid.position.y = -1.5;
        scene.add(grid);

        let disposed = false;
        let mixer: THREE.AnimationMixer | null = null;
        const loop = createModel3DRenderLoop({
            update: delta => {
                mixer?.update(delta);
                controls.autoRotate = !!modelRef.current && settingsRef.current.autoRotate;
                return controls.update();
            },
            render: () => renderer.render(scene, camera),
            continuous: () => (!!modelRef.current && controls.autoRotate) || !!mixer,
            visibilityTarget: container,
        });
        invalidateRef.current = loop.invalidate;
        controls.addEventListener('change', loop.invalidate);
        const resizeObserver = observeModel3DSize(container, width, height, (w, h) => {
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h, false);
            loop.invalidate();
        });
        setLoading(true);

        load3DModel(fileUrl, fileExtension)
            .then((res) => {
                if (disposed) { disposeModel3DObject(res.object); return; }
                modelRef.current = res.object;
                scene.add(res.object);
                if (res.animations.length > 0) {
                    mixer = new THREE.AnimationMixer(res.object);
                    for (const clip of res.animations) mixer.clipAction(clip).play();
                }
                if (settingsRef.current.wireframe) {
                    res.object.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh) {
                            const mesh = child as THREE.Mesh;
                            if (mesh.material) setMeshWireframe(mesh.material, true);
                        }
                    });
                }
                loop.invalidate();
                setLoading(false);
            })
            .catch(() => { if (!disposed) setLoading(false); });

        return () => {
            disposed = true;
            loop.dispose();
            invalidateRef.current = null;
            resizeObserver.disconnect();
            controls.removeEventListener('change', loop.invalidate);
            controls.dispose();
            mixer?.stopAllAction();
            if (modelRef.current) mixer?.uncacheRoot(modelRef.current);
            modelRef.current = null;
            disposeModel3DObject(scene);
            renderer.dispose();
            renderer.domElement.remove();
        };
    }, [fileUrl, fileExtension]);

    return (
        <div className="w-full h-full relative bg-slate-950 flex items-center justify-center">
            <div ref={mountRef} className="w-full h-full" />
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 z-10">
                    <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
                </div>
            )}
        </div>
    );
};
