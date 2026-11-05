import { readPsd, Psd } from 'ag-psd';
import type { PsdLayerResult, PsdParseResult as SharedPsdParseResult } from '../plugin-runtime/format-handlers';

/** Compatibility aliases: the public shape belongs to the plugin contract, not this parser implementation. */
export type PsdLayerInfo = PsdLayerResult;
export type PsdParseResult = SharedPsdParseResult;

/**
 * Checks if a given file is a PSD or PSB file
 */
export const isPsdFile = (file: File): boolean => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.psd') || name.endsWith('.psb')) {
        return true;
    }
    const type = file.type.toLowerCase();
    return (
        type === 'image/vnd.adobe.photoshop' ||
        type === 'image/x-photoshop' ||
        type === 'application/x-photoshop' ||
        type === 'application/photoshop' ||
        type === 'image/psd' ||
        type === 'application/psd'
    );
};

/**
 * Recursively extracts layers from PSD tree
 */
const extractLayers = (children: any[] | undefined, layersOut: PsdLayerInfo[]) => {
    if (!children || !Array.isArray(children)) return;

    for (const child of children) {
        if (child.children && child.children.length > 0) {
            extractLayers(child.children, layersOut);
        }

        if (child.canvas) {
            try {
                const layerCanvas = child.canvas as HTMLCanvasElement;
                const dataUrl = layerCanvas.toDataURL('image/png');
                const width = layerCanvas.width || (child.right - child.left) || 0;
                const height = layerCanvas.height || (child.bottom - child.top) || 0;
                
                if (width > 0 && height > 0) {
                    layersOut.push({
                        id: `psd-layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        name: child.name || 'Layer',
                        left: typeof child.left === 'number' ? child.left : 0,
                        top: typeof child.top === 'number' ? child.top : 0,
                        width,
                        height,
                        opacity: typeof child.opacity === 'number' ? child.opacity : 1,
                        hidden: Boolean(child.hidden),
                        dataUrl,
                    });
                }
            } catch (err) {
                console.warn('Failed to extract PSD layer canvas', child.name, err);
            }
        }
    }
};

/**
 * Reads and parses a PSD file in the browser
 */
export const parsePsdFile = async (file: File): Promise<PsdParseResult> => {
    const buffer = await file.arrayBuffer();
    
    // Read PSD with full canvas rendering
    const psd: Psd = readPsd(buffer, {
        skipLayerImageData: false,
        skipCompositeImageData: false,
        skipThumbnail: true,
    });

    const width = psd.width || 800;
    const height = psd.height || 600;

    // 1. Get composite image
    let compositeDataUrl = '';
    if (psd.canvas) {
        compositeDataUrl = (psd.canvas as HTMLCanvasElement).toDataURL('image/png');
    }

    // 2. Extract layers
    const layers: PsdLayerInfo[] = [];
    if (psd.children && psd.children.length > 0) {
        extractLayers(psd.children, layers);
    }

    // Fallback if composite image wasn't in the PSD header
    if (!compositeDataUrl) {
        if (layers.length > 0) {
            // Render visible layers onto a new canvas
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                for (const layer of layers) {
                    if (layer.hidden) continue;
                    const img = new Image();
                    await new Promise<void>((resolve) => {
                        img.onload = () => {
                            ctx.globalAlpha = layer.opacity;
                            ctx.drawImage(img, layer.left, layer.top, layer.width, layer.height);
                            resolve();
                        };
                        img.onerror = () => resolve();
                        img.src = layer.dataUrl;
                    });
                }
                compositeDataUrl = canvas.toDataURL('image/png');
            }
        }
    }

    // If still empty (empty PSD), generate a blank transparent image
    if (!compositeDataUrl) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        compositeDataUrl = canvas.toDataURL('image/png');
    }

    return {
        fileName: file.name,
        width,
        height,
        compositeDataUrl,
        layers,
        hasMultipleLayers: layers.length > 1,
    };
};
