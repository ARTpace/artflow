/**
 * builtin/cutout/CutoutEditor.tsx —— 本地抠图编辑器（模态浮层）。
 *
 * 工作方式：
 * 1. 原图按 MAX_WORK_PIXELS 上限取"工作分辨率"（大图才降采样），所有选区/笔刷/羽化都在工作分辨率上算；
 * 2. 掩码（Uint8Array）是唯一真值，alpha 由 mask + 收缩/羽化 推导；三张离屏画布做显示：
 *    source（工作分辨率原图）/ alpha（红色 tint + alpha）/ preview（原图 × alpha，透明预览用）；
 * 3. 应用 = 原分辨率重绘原图 → destination-in 贴 alpha → PNG → 入库托管资产 → 原地 patch 元素 locator
 *    （沿用 builtin.image-tools 的"替换图像"契约，走 committed 历史，Ctrl+Z 可撤销）。
 */

import React from 'react';
import type { Kernel } from '../../plugin-runtime/kernel';
import { HOST_PLATFORM_SERVICE, type HostPlatformService } from '../../plugin-runtime/host-platform';
import { CANVAS_MUTATION_SERVICE, type CanvasMutationService } from '../../plugin-runtime/canvas-mutation';
import { generateProxyDataUrls } from '../../utils/imageProxy';
import type { ImageElement } from '../../types';
import {
  MASK_CUT,
  MASK_KEEP,
  alphaToRgba,
  binaryFromAlpha,
  composeAiAlpha,
  countCut,
  fillMask,
  invertMask,
  mergeMask,
  paintBrush,
  paintStroke,
  refineAlpha,
  sampleColor,
  selectByColor,
  type Rect,
} from './matting';
import {
  AI_MATTING_MODELS,
  DEFAULT_MATTING_MODEL,
  isAiMattingAvailable,
  requestAiMatting,
} from './ai-matting';

/** 工作分辨率像素上限：超过则降采样编辑，应用时 alpha 平滑放大回原尺寸。 */
const MAX_WORK_PIXELS = 4_000_000;
const UNDO_LIMIT = 8;
const REFINE_DEBOUNCE_MS = 130;
const ALPHA_TINT = { r: 255, g: 72, b: 72 };

type Tool = 'wand' | 'erase' | 'restore' | 'pan';
type ViewMode = 'mask' | 'result';

interface CutoutEditorProps {
  kernel: Kernel;
  element: ImageElement;
  onClose: () => void;
}

interface ManagedImportResult {
  asset?: { id: string; locator: { previewRef?: string; originalRef?: string; fileRef?: string; mimeType?: string } };
  byteSize?: number;
  ok?: boolean;
  message?: string;
}

const clampRect = (rect: Rect, width: number, height: number): Rect => ({
  x0: Math.max(0, Math.min(width, rect.x0)),
  y0: Math.max(0, Math.min(height, rect.y0)),
  x1: Math.max(0, Math.min(width, rect.x1)),
  y1: Math.max(0, Math.min(height, rect.y1)),
});

const rectIsEmpty = (rect: Rect): boolean => rect.x1 <= rect.x0 || rect.y1 <= rect.y0;

const createCanvas = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const context2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  return ctx;
};

const createCheckerPattern = (ctx: CanvasRenderingContext2D): CanvasPattern | null => {
  const tile = createCanvas(16, 16);
  const tileCtx = context2d(tile);
  tileCtx.fillStyle = '#2a2a2e';
  tileCtx.fillRect(0, 0, 16, 16);
  tileCtx.fillStyle = '#34343a';
  tileCtx.fillRect(0, 0, 8, 8);
  tileCtx.fillRect(8, 8, 8, 8);
  return ctx.createPattern(tile, 'repeat');
};

const newAssetId = (): string => `asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// 宿主服务取用统一走类型化 helper：React.FC 的 props 在本仓库 tsconfig 下会退化成 any，
// 组件体内直接 kernel.use<T>() 会丢类型（TS2347），与 image-tools / canvas-export 保持同一写法。
const hostPlatform = (kernel: Kernel): HostPlatformService =>
  kernel.use<HostPlatformService>(HOST_PLATFORM_SERVICE);
const canvasMutation = (kernel: Kernel): CanvasMutationService =>
  kernel.use<CanvasMutationService>(CANVAS_MUTATION_SERVICE);

export const CutoutEditor: React.FC<CutoutEditorProps> = ({ kernel, element, onClose }) => {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const imgRef = React.useRef<HTMLImageElement | null>(null);
  const sourceCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const sourcePixelsRef = React.useRef<Uint8ClampedArray | null>(null);
  const alphaCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const maskRef = React.useRef<Uint8Array | null>(null);
  const alphaRef = React.useRef<Uint8Array | null>(null);
  /** AI 软边基底（0..255 连续值）；null = 纯本地算法路径。 */
  const aiAlphaRef = React.useRef<Uint8Array | null>(null);
  /** 快照必须同时含 aiAlpha：只回滚二进制层会让软边基底残留成"幽灵软边"。 */
  const undoRef = React.useRef<Array<{ mask: Uint8Array; aiAlpha: Uint8Array | null }>>([]);
  const checkerRef = React.useRef<CanvasPattern | null>(null);
  const viewRef = React.useRef({ zoom: 1, x: 0, y: 0 });
  const sizeRef = React.useRef({ work: { width: 0, height: 0 }, natural: { width: 0, height: 0 }, scale: 1 });
  const frameRef = React.useRef(0);
  const paintRef = React.useRef<{ value: number; last: { x: number; y: number } } | null>(null);
  const panRef = React.useRef<{ pointerId: number; startX: number; startY: number; viewX: number; viewY: number } | null>(null);
  const spaceRef = React.useRef(false);

  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [revision, setRevision] = React.useState(0);
  const [tool, setTool] = React.useState<Tool>('wand');
  const [tolerance, setTolerance] = React.useState(32);
  const [contiguous, setContiguous] = React.useState(true);
  const [shrink, setShrink] = React.useState(0);
  const [feather, setFeather] = React.useState(1);
  const [brushSize, setBrushSize] = React.useState(60);
  const [viewMode, setViewMode] = React.useState<ViewMode>('result');
  const [busy, setBusy] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const [undoDepth, setUndoDepth] = React.useState(0);
  const [cutRatio, setCutRatio] = React.useState(0);
  const [aiModel, setAiModel] = React.useState<string>(DEFAULT_MATTING_MODEL);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiNote, setAiNote] = React.useState<string | null>(null);

  const paramsRef = React.useRef({ tool, tolerance, contiguous, shrink, feather, brushSize, viewMode });
  paramsRef.current = { tool, tolerance, contiguous, shrink, feather, brushSize, viewMode };

  const scheduleDraw = React.useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const ctx = context2d(canvas);
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = wrap.clientWidth;
      const cssHeight = wrap.clientHeight;
      const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        checkerRef.current = null;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      ctx.fillStyle = '#17171a';
      ctx.fillRect(0, 0, cssWidth, cssHeight);
      if (!checkerRef.current) checkerRef.current = createCheckerPattern(ctx);
      if (checkerRef.current) {
        ctx.fillStyle = checkerRef.current;
        ctx.fillRect(0, 0, cssWidth, cssHeight);
      }

      const source = sourceCanvasRef.current;
      const alpha = alphaCanvasRef.current;
      const preview = previewCanvasRef.current;
      if (!source || !alpha || !preview) return;
      const { work } = sizeRef.current;
      const view = viewRef.current;
      const drawWidth = work.width * view.zoom;
      const drawHeight = work.height * view.zoom;
      ctx.imageSmoothingEnabled = view.zoom < 1;
      ctx.imageSmoothingQuality = 'high';

      if (paramsRef.current.viewMode === 'mask') {
        ctx.globalAlpha = 0.55;
        ctx.drawImage(source, view.x, view.y, drawWidth, drawHeight);
        ctx.globalAlpha = 0.5;
        ctx.drawImage(alpha, view.x, view.y, drawWidth, drawHeight);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(preview, view.x, view.y, drawWidth, drawHeight);
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(view.x - 0.5, view.y - 0.5, drawWidth + 1, drawHeight + 1);
    });
  }, []);

  /** 全量重建 preview（原图 × alpha）。 */
  const rebuildPreviewFull = React.useCallback(() => {
    const source = sourceCanvasRef.current;
    const alpha = alphaCanvasRef.current;
    const preview = previewCanvasRef.current;
    if (!source || !alpha || !preview) return;
    const ctx = context2d(preview);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(alpha, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }, []);

  /** 全量重建 alpha（mask + 收缩/羽化）。 */
  const rebuildAlphaFull = React.useCallback(() => {
    const mask = maskRef.current;
    const alpha = alphaCanvasRef.current;
    if (!mask || !alpha) return;
    const { work } = sizeRef.current;
    const { shrink: shrinkPx, feather: featherPx } = paramsRef.current;
    const refined = refineAlpha(mask, work.width, work.height, { shrink: shrinkPx, feather: featherPx });
    // 二进制层决定「哪里抠掉」，AI 软边决定「保留处多透明」，取严叠加。
    const next = composeAiAlpha(refined, aiAlphaRef.current);
    alphaRef.current = next;
    context2d(alpha).putImageData(new ImageData(alphaToRgba(next, ALPHA_TINT), work.width, work.height), 0, 0);
    rebuildPreviewFull();
    setCutRatio(mask.length === 0 ? 0 : countCut(mask) / mask.length);
    scheduleDraw();
  }, [rebuildPreviewFull, scheduleDraw]);

  const refineTimerRef = React.useRef(0);
  /** 收缩/羽化是 O(n) 距离变换，滑块与笔刷期间做防抖，避免每帧全量重算。 */
  const scheduleRefine = React.useCallback(() => {
    setBusy(true);
    if (refineTimerRef.current) window.clearTimeout(refineTimerRef.current);
    refineTimerRef.current = window.setTimeout(() => {
      refineTimerRef.current = 0;
      rebuildAlphaFull();
      setBusy(false);
    }, REFINE_DEBOUNCE_MS);
  }, [rebuildAlphaFull]);

  /** 脏矩形增量：mask → alpha 二值 + alpha 画布 + preview 画布（笔刷期间即时反馈，松手后再走羽化重算）。 */
  const applyRectBinary = React.useCallback((rect: Rect) => {
    const mask = maskRef.current;
    const alpha = alphaRef.current;
    const alphaCanvas = alphaCanvasRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    const previewCanvas = previewCanvasRef.current;
    if (!mask || !alpha || !alphaCanvas || !sourceCanvas || !previewCanvas) return;
    const { work } = sizeRef.current;
    const area = clampRect(rect, work.width, work.height);
    if (rectIsEmpty(area)) return;
    const width = area.x1 - area.x0;
    const height = area.y1 - area.y0;

    const alphaData = new Uint8ClampedArray(width * height * 4);
    // 笔刷期间走二进制快路径，但仍要叠上 AI 软边基底，否则涂一笔就会把整块软边抹平。
    const aiAlpha = aiAlphaRef.current;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (area.y0 + y) * work.width + (area.x0 + x);
        const value = mask[index] === MASK_CUT ? 0 : (aiAlpha ? aiAlpha[index] : 255);
        alpha[index] = value;
        const p = (y * width + x) * 4;
        alphaData[p] = ALPHA_TINT.r;
        alphaData[p + 1] = ALPHA_TINT.g;
        alphaData[p + 2] = ALPHA_TINT.b;
        alphaData[p + 3] = value;
      }
    }
    const alphaCtx = context2d(alphaCanvas);
    alphaCtx.putImageData(new ImageData(alphaData, width, height), area.x0, area.y0);

    // preview 脏矩形：读回源图与 alpha，逐像素合成（避免依赖 clip + 复合算子的边界语义）。
    const previewCtx = context2d(previewCanvas);
    const sourceData = context2d(sourceCanvas).getImageData(area.x0, area.y0, width, height);
    const patchData = context2d(alphaCanvas).getImageData(area.x0, area.y0, width, height);
    for (let i = 0; i < width * height; i += 1) sourceData.data[i * 4 + 3] = patchData.data[i * 4 + 3];
    previewCtx.putImageData(sourceData, area.x0, area.y0);
    scheduleDraw();
  }, [scheduleDraw]);

  const pushUndo = React.useCallback(() => {
    const mask = maskRef.current;
    if (!mask) return;
    const aiAlpha = aiAlphaRef.current;
    undoRef.current.push({ mask: mask.slice(), aiAlpha: aiAlpha ? aiAlpha.slice() : null });
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
    setUndoDepth(undoRef.current.length);
  }, []);

  const undo = React.useCallback(() => {
    const snapshot = undoRef.current.pop();
    if (!snapshot) return;
    maskRef.current = snapshot.mask;
    aiAlphaRef.current = snapshot.aiAlpha;
    setAiNote(current => (snapshot.aiAlpha ? current : null));
    setUndoDepth(undoRef.current.length);
    rebuildAlphaFull();
  }, [rebuildAlphaFull]);

  // —— 载入图片 → 建工作分辨率源图 / 掩码 / alpha / preview ——
  React.useEffect(() => {
    let cancelled = false;
    const src = element.originalHref ?? element.href;
    if (!src) {
      setError('元素没有可用的图片地址');
      return undefined;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (cancelled) return;
      const natural = { width: img.naturalWidth || Math.round(element.width), height: img.naturalHeight || Math.round(element.height) };
      if (natural.width <= 0 || natural.height <= 0) {
        setError('图片尺寸无效');
        return;
      }
      const scale = Math.min(1, Math.sqrt(MAX_WORK_PIXELS / (natural.width * natural.height)));
      const work = { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
      sizeRef.current = { work, natural, scale };

      try {
        const source = createCanvas(work.width, work.height);
        const sourceCtx = context2d(source);
        sourceCtx.imageSmoothingEnabled = true;
        sourceCtx.imageSmoothingQuality = 'high';
        sourceCtx.drawImage(img, 0, 0, work.width, work.height);
        sourceCanvasRef.current = source;
        sourcePixelsRef.current = sourceCtx.getImageData(0, 0, work.width, work.height).data;

        const alpha = createCanvas(work.width, work.height);
        const preview = createCanvas(work.width, work.height);
        alphaCanvasRef.current = alpha;
        previewCanvasRef.current = preview;

        const mask = new Uint8Array(work.width * work.height);
        maskRef.current = mask;
        alphaRef.current = refineAlpha(mask, work.width, work.height, { shrink: 0, feather: 0 });
        context2d(alpha).putImageData(new ImageData(alphaToRgba(alphaRef.current, ALPHA_TINT), work.width, work.height), 0, 0);
        rebuildPreviewFull();
        undoRef.current = [];
        setUndoDepth(0);
        setCutRatio(0);

        imgRef.current = img;
        setReady(true);
        fitView();
        scheduleDraw();
      } catch (err) {
        setError((err as Error)?.message ?? '初始化失败');
      }
    };
    img.onerror = () => {
      if (!cancelled) setError('图片加载失败（资产可能已失效）');
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
    // element 变化时由父组件以 key 重挂载，这里只按 id 初始化一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element.id, element.href, element.originalHref]);

  const fitView = React.useCallback(() => {
    const wrap = wrapRef.current;
    const { work } = sizeRef.current;
    if (!wrap || work.width === 0 || work.height === 0) return;
    const padding = 48;
    const zoom = Math.min((wrap.clientWidth - padding) / work.width, (wrap.clientHeight - padding) / work.height);
    const next = Math.max(0.02, zoom);
    viewRef.current = {
      zoom: next,
      x: (wrap.clientWidth - work.width * next) / 2,
      y: (wrap.clientHeight - work.height * next) / 2,
    };
    scheduleDraw();
  }, [scheduleDraw]);

  React.useEffect(() => {
    if (!ready) return undefined;
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver(() => fitView());
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [ready, fitView]);

  const toWork = (clientX: number, clientY: number): { x: number; y: number } => {
    const wrap = wrapRef.current;
    const view = viewRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
  };

  const insideWork = (point: { x: number; y: number }): boolean => {
    const { work } = sizeRef.current;
    return point.x >= 0 && point.y >= 0 && point.x < work.width && point.y < work.height;
  };

  const runWand = (point: { x: number; y: number }, subtract: boolean) => {
    const pixels = sourcePixelsRef.current;
    const mask = maskRef.current;
    if (!pixels || !mask) return;
    const { work } = sizeRef.current;
    const px = Math.floor(point.x);
    const py = Math.floor(point.y);
    const { tolerance: tol, contiguous: isContiguous } = paramsRef.current;
    try {
      const selection = selectByColor(
        pixels,
        work.width,
        work.height,
        sampleColor(pixels, work.width, px, py),
        { tolerance: tol, contiguous: isContiguous },
        { x: px, y: py },
      );
      pushUndo();
      const rect = mergeMask(mask, selection, work.width, subtract ? 'subtract' : 'add');
      applyRectBinary(rect);
      scheduleRefine();
    } catch (err) {
      setError((err as Error)?.message ?? '魔术棒失败');
    }
  };

  // —— 指针交互：魔术棒点击 / 笔刷拖拽 / 平移 ——
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const params = paramsRef.current;
    const wantsPan = event.button === 1 || params.tool === 'pan' || spaceRef.current;
    if (wantsPan) {
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewX: viewRef.current.x,
        viewY: viewRef.current.y,
      };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;

    const point = toWork(event.clientX, event.clientY);
    if (params.tool === 'wand') {
      if (insideWork(point)) runWand(point, event.altKey);
      return;
    }
    if (!insideWork(point)) return;
    const value = params.tool === 'erase' ? MASK_CUT : MASK_KEEP;
    pushUndo();
    paintRef.current = { value, last: point };
    applyRectBinary(paintBrush(maskRef.current as Uint8Array, sizeRef.current.work.width, sizeRef.current.work.height, point.x, point.y, params.brushSize / 2, value));
    canvas.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      viewRef.current = {
        ...viewRef.current,
        x: pan.viewX + (event.clientX - pan.startX),
        y: pan.viewY + (event.clientY - pan.startY),
      };
      scheduleDraw();
      return;
    }
    const painting = paintRef.current;
    if (!painting) return;
    const point = toWork(event.clientX, event.clientY);
    const { work } = sizeRef.current;
    const rect = paintStroke(maskRef.current as Uint8Array, work.width, work.height, painting.last, point, paramsRef.current.brushSize / 2, painting.value);
    painting.last = point;
    applyRectBinary(rect);
  };

  const finishPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
      return;
    }
    if (paintRef.current) {
      paintRef.current = null;
      scheduleRefine();
    }
  };

  React.useEffect(() => {
    if (!ready) return undefined;
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const view = viewRef.current;
      const rect = wrap.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const next = Math.min(8, Math.max(0.03, view.zoom * factor));
      const ratio = next / view.zoom;
      viewRef.current = {
        zoom: next,
        x: anchorX - (anchorX - view.x) * ratio,
        y: anchorY - (anchorY - view.y) * ratio,
      };
      scheduleDraw();
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [ready, scheduleDraw]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spaceRef.current = true;
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
        return;
      }
      if (event.key === '1') setTool('wand');
      if (event.key === '2') setTool('erase');
      if (event.key === '3') setTool('restore');
      if (event.key === 'Escape') event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      if (refineTimerRef.current) window.clearTimeout(refineTimerRef.current);
    };
  }, [undo]);

  const onToleranceChange = (value: number) => {
    setTolerance(value);
  };
  const onShrinkChange = (value: number) => {
    setShrink(value);
    setBusy(true);
  };
  const onFeatherChange = (value: number) => {
    setFeather(value);
    setBusy(true);
  };

  React.useEffect(() => {
    if (!ready) return undefined;
    scheduleRefine();
    return undefined;
  }, [ready, shrink, feather, scheduleRefine]);

  /** 合成最终 PNG（原分辨率）。 */
  const composeResult = async (): Promise<{ bytes: ArrayBuffer; canvas: HTMLCanvasElement }> => {
    const img = imgRef.current;
    const alpha = alphaCanvasRef.current;
    const { work, natural } = sizeRef.current;
    if (!img || !alpha) throw new Error('尚未准备就绪');
    const out = createCanvas(natural.width, natural.height);
    const ctx = context2d(out);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, natural.width, natural.height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(alpha, 0, 0, work.width, work.height, 0, 0, natural.width, natural.height);
    ctx.globalCompositeOperation = 'source-over';
    const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG 编码失败');
    return { bytes: await blob.arrayBuffer(), canvas: out };
  };

  const exportPng = async () => {
    try {
      setApplying(true);
      setError(null);
      const { bytes } = await composeResult();
      const host = hostPlatform(kernel);
      const name = `${(element.name || 'image').replace(/\.[^.]+$/, '')}-cutout.png`;
      const result = await host.saveBytes({ title: '导出抠图 PNG', defaultName: name, bytes });
      if (!result.ok) setError(result.message ?? '导出失败');
    } catch (err) {
      setError((err as Error)?.message ?? '导出失败');
    } finally {
      setApplying(false);
    }
  };

  const applyResult = async () => {
    try {
      setApplying(true);
      setError(null);
      const { bytes, canvas } = await composeResult();
      const host = hostPlatform(kernel);
      const mutation = canvasMutation(kernel);
      const { natural } = sizeRef.current;
      const originalName = `${(element.name || 'image').replace(/\.[^.]+$/, '')}-cutout.png`;
      const imported = await host.importAsset({
        asset: { id: newAssetId(), kind: 'image', locator: { mimeType: 'image/png' }, metadata: { originalName } },
        bytes,
        originalName,
      }) as ManagedImportResult;
      const managed = imported?.asset;
      if (!managed?.locator) throw new Error(imported?.message ?? '资产入库失败');
      const href = managed.locator.previewRef ?? managed.locator.fileRef;
      if (!href) throw new Error('资产入库未返回可用引用');

      // 缩略图/中档代理与导入管线同源生成，避免未定义时回落成全尺寸纹理。
      const proxies = generateProxyDataUrls(canvas, natural.width, natural.height, 'image/png');
      const patched = mutation.patchElements(
        [{
          id: element.id,
          patch: {
            assetId: managed.id,
            href,
            originalHref: managed.locator.originalRef ?? href,
            mimeType: managed.locator.mimeType ?? 'image/png',
            fileSize: imported.byteSize ?? bytes.byteLength,
            thumbnailHref: proxies.thumbnailDataUrl,
            mediumHref: proxies.mediumDataUrl,
          },
        }],
        { committed: true },
      );
      if (!patched) throw new Error('元素替换失败');
      onClose();
    } catch (err) {
      setError((err as Error)?.message ?? '应用失败');
    } finally {
      setApplying(false);
    }
  };

  const resetMask = () => {
    if (!maskRef.current) return;
    pushUndo();
    // 「重置」= 回到空白起点，AI 软边基底一并清掉，否则会残留看不见却生效的半透明边缘。
    aiAlphaRef.current = null;
    setAiNote(null);
    fillMask(maskRef.current, MASK_KEEP);
    rebuildAlphaFull();
  };

  const invertSelection = () => {
    if (!maskRef.current) return;
    pushUndo();
    invertMask(maskRef.current);
    rebuildAlphaFull();
  };

  /**
   * AI 一键抠图：拿回软边 alpha 作基底，同时把 mask 二进制化以便可视化与继续笔刷编辑。
   * 之后笔刷只改二进制层，软边在合成时取严叠加 —— 两条路径互不覆盖。
   */
  const runAiMatting = async () => {
    const mask = maskRef.current;
    const source = sourceCanvasRef.current;
    if (!mask || !source || aiBusy) return;
    setAiBusy(true);
    setError(null);
    setAiNote('正在调用本机 ComfyUI…');
    try {
      const { work } = sizeRef.current;
      const outcome = await requestAiMatting(kernel, source, aiModel, work.width, work.height);
      pushUndo();
      aiAlphaRef.current = outcome.alpha;
      mask.set(binaryFromAlpha(outcome.alpha));
      rebuildAlphaFull();
      const model = typeof outcome.metadata['comfyui.model'] === 'string' ? outcome.metadata['comfyui.model'] : aiModel;
      const elapsed = outcome.metadata['comfyui.durationMs'];
      setAiNote(`AI 软边基底已就绪 · ${model}${typeof elapsed === 'number' ? ` · ${(elapsed / 1000).toFixed(1)}s` : ''}`);
    } catch (err) {
      aiAlphaRef.current = null;
      setAiNote(null);
      setError((err as Error)?.message ?? 'AI 抠图失败');
    } finally {
      setAiBusy(false);
    }
  };

  const aiAvailable = isAiMattingAvailable(kernel);
  const { work, natural, scale } = sizeRef.current;
  const toolButton = (id: Tool, label: string, hint: string) => (
    <button
      type="button"
      key={id}
      onClick={() => setTool(id)}
      title={hint}
      className={`rounded-lg px-2 py-1.5 text-xs transition ${tool === id ? 'bg-violet-500 text-white' : 'bg-white/5 text-neutral-300 hover:bg-white/10'}`}
    >
      {label}
    </button>
  );

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (next: number) => void,
    suffix = '',
  ) => (
    <label className="block space-y-1">
      <span className="flex items-center justify-between text-[11px] text-neutral-400">
        <span>{label}</span>
        <span className="tabular-nums text-neutral-200">{value}{suffix}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-violet-400"
      />
    </label>
  );

  return (
    <div data-bp-ui-scrim="" className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4" role="dialog" aria-modal="true">
      <div data-bp-ui-surface="" className="flex h-full max-h-[92vh] w-full max-w-[1280px] flex-col overflow-hidden rounded-2xl border border-white/12 bg-neutral-950/96 text-neutral-100 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">抠图 · {element.name || '图片'}</div>
            <div className="mt-0.5 truncate text-[11px] text-neutral-500">
              工作 {work.width}×{work.height}
              {scale < 1 ? `（原图 ${natural.width}×${natural.height}，缩放编辑，应用时还原尺寸）` : ''}
              {' · 已抠除 '}{(cutRatio * 100).toFixed(1)}%
              {busy ? ' · 边缘处理中…' : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-neutral-400 transition hover:bg-white/10 hover:text-white"
            title="关闭"
          >
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div ref={wrapRef} data-bp-ui-artwork="" className="relative min-h-0 flex-1 overflow-hidden bg-neutral-900">
            <canvas
              ref={canvasRef}
              className={`absolute inset-0 h-full w-full ${tool === 'pan' ? 'cursor-grab' : 'cursor-crosshair'}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={finishPointer}
              onPointerCancel={finishPointer}
              onContextMenu={event => event.preventDefault()}
            />
            {!ready && !error && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-400">正在准备图像…</div>
            )}
            <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-neutral-500">
              滚轮缩放 · 空格/中键拖拽平移 · {tool === 'wand' ? '左键加入抠除区 · Alt+左键从抠除区减去' : '左键拖拽涂抹'}
            </div>
          </div>

          <div className="w-64 shrink-0 space-y-4 overflow-y-auto border-l border-white/10 p-3">
            <div className="space-y-2">
              <div className="text-[11px] font-medium text-neutral-400">AI 抠图</div>
              <select
                value={aiModel}
                onChange={event => setAiModel(event.target.value)}
                disabled={aiBusy}
                className="w-full rounded-lg border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 disabled:opacity-40"
              >
                {AI_MATTING_MODELS.map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={runAiMatting}
                disabled={aiBusy || !ready || !aiAvailable}
                title={aiAvailable ? '调用本机 ComfyUI 的 BiRefNet 抠图，得到软边结果，之后仍可用笔刷修' : '需要桌面端运行且 AI provider 已注册'}
                className="w-full rounded-lg bg-emerald-500/90 px-2 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-400 disabled:opacity-40"
              >
                {aiBusy ? 'AI 处理中…' : 'AI 一键抠图'}
              </button>
              {aiNote && <div className="text-[11px] leading-relaxed text-emerald-300/80">{aiNote}</div>}
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-neutral-400">工具</div>
              <div className="grid grid-cols-2 gap-1.5">
                {toolButton('wand', '魔术棒', '点选背景区域（容差控制相似度）')}
                {toolButton('erase', '擦除', '把涂抹处变透明')}
                {toolButton('restore', '恢复', '把涂抹处恢复为不透明')}
                {toolButton('pan', '平移', '拖拽画布（也可空格/中键）')}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-neutral-400">魔术棒</div>
              {slider('容差', tolerance, 0, 255, 1, onToleranceChange)}
              <label className="flex items-center gap-2 text-[11px] text-neutral-400">
                <input
                  type="checkbox"
                  checked={contiguous}
                  onChange={event => setContiguous(event.target.checked)}
                  className="accent-violet-400"
                />
                仅连续区域（关闭 = 全图同色）
              </label>
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-neutral-400">边缘</div>
              {slider('收缩', shrink, 0, 8, 1, onShrinkChange, ' px')}
              {slider('羽化', feather, 0, 8, 1, onFeatherChange, ' px')}
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-neutral-400">笔刷</div>
              {slider('大小', brushSize, 4, 400, 2, setBrushSize, ' px')}
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-neutral-400">视图</div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setViewMode('mask')}
                  className={`rounded-lg px-2 py-1.5 text-xs transition ${viewMode === 'mask' ? 'bg-violet-500 text-white' : 'bg-white/5 text-neutral-300 hover:bg-white/10'}`}
                >
                  遮罩视图
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('result')}
                  className={`rounded-lg px-2 py-1.5 text-xs transition ${viewMode === 'result' ? 'bg-violet-500 text-white' : 'bg-white/5 text-neutral-300 hover:bg-white/10'}`}
                >
                  透明预览
                </button>
              </div>
              <button
                type="button"
                onClick={fitView}
                className="w-full rounded-lg bg-white/5 px-2 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10"
              >
                适应窗口
              </button>
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-neutral-400">编辑</div>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={undo}
                  disabled={undoDepth === 0}
                  className="rounded-lg bg-white/5 px-2 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10 disabled:opacity-40"
                >
                  撤销
                </button>
                <button
                  type="button"
                  onClick={invertSelection}
                  className="rounded-lg bg-white/5 px-2 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10"
                >
                  反相
                </button>
                <button
                  type="button"
                  onClick={resetMask}
                  className="rounded-lg bg-white/5 px-2 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10"
                >
                  重置
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-2.5">
          <div className="min-w-0 truncate text-[11px] text-rose-300">{error}</div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/10"
            >
              取消
            </button>
            <button
              type="button"
              onClick={exportPng}
              disabled={applying || !ready || cutRatio === 0}
              className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/10 disabled:opacity-40"
            >
              导出 PNG
            </button>
            <button
              type="button"
              onClick={applyResult}
              data-bp-ui-action="primary"
              disabled={applying || !ready || cutRatio === 0}
              className="rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-violet-400 disabled:opacity-40"
            >
              {applying ? '处理中…' : '应用（替换原图）'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
