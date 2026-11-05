import { isSvgFile, parseSvgFile } from './svgUtils';
import { isTgaFile, parseTgaFile } from './tgaUtils';
import { isExrFile, parseExrFile } from './exrUtils';
import { generateProxyDataUrls } from './imageProxy';

const RAW_EXTENSIONS = new Set([
    'raw', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw', 'kdc', 'mrw'
]);
const WORKER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'jfif', 'webp', 'avif', 'gif', 'bmp']);

const fileExtension = (file: File): string => file.name.split('.').pop()?.toLowerCase() || '';
const isPsdFile = (file: File): boolean => {
    const type = file.type.toLowerCase();
    return ['psd', 'psb'].includes(fileExtension(file)) || [
        'image/vnd.adobe.photoshop', 'image/x-photoshop', 'application/x-photoshop',
        'application/photoshop', 'image/psd', 'application/psd',
    ].includes(type);
};
const isTiffFile = (file: File): boolean => ['tif', 'tiff'].includes(fileExtension(file)) || file.type === 'image/tiff';
const isRawFile = (file: File): boolean => RAW_EXTENSIONS.has(fileExtension(file));

export const fileToDataUrl = async (file: File): Promise<{ dataUrl: string; mimeType: string }> => {
    if (isPsdFile(file)) {
        const { parsePsdFile } = await import('./psdUtils');
        const psd = await parsePsdFile(file);
        return { dataUrl: psd.compositeDataUrl, mimeType: 'image/png' };
    }

    if (isSvgFile(file)) {
        const svg = await parseSvgFile(file);
        return { dataUrl: svg.dataUrl, mimeType: 'image/svg+xml' };
    }

    if (isTiffFile(file)) {
        const { parseTiffFile } = await import('./tiffUtils');
        const tiff = await parseTiffFile(file);
        return { dataUrl: tiff.dataUrl, mimeType: 'image/png' };
    }

    if (isTgaFile(file)) {
        const tga = await parseTgaFile(file);
        return { dataUrl: tga.dataUrl, mimeType: 'image/png' };
    }

    if (isExrFile(file)) {
        const exr = await parseExrFile(file);
        return { dataUrl: exr.dataUrl, mimeType: 'image/png' };
    }

    if (isRawFile(file)) {
        const { parseRawFile } = await import('./rawUtils');
        const raw = await parseRawFile(file);
        return { dataUrl: raw.dataUrl, mimeType: 'image/png' };
    }

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                resolve({ dataUrl: reader.result, mimeType: file.type || 'application/octet-stream' });
            } else {
                reject(new Error('Failed to read file as a data URL.'));
            }
        };
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file);
    });
};

export interface ImageReadResult {
    dataUrl: string; // 1024px standard display proxy (or original if within bounds)
    thumbnailDataUrl?: string; // 256px lightweight thumbnail proxy (for far zoom)
    mediumDataUrl?: string; // 512px medium proxy (texture budget for dense multi-tile views)
    originalDataUrl?: string; // Full-resolution original (if proxy was created)
    width: number;
    height: number;
    mimeType: string;
}

async function createProxiesFromDataUrl(
    dataUrl: string,
    width: number,
    height: number,
    mimeType: string = 'image/png'
): Promise<{ dataUrl: string; thumbnailDataUrl?: string; mediumDataUrl?: string; originalDataUrl?: string }> {
    if (typeof document === 'undefined') {
        return { dataUrl };
    }
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const proxies = generateProxyDataUrls(img, width, height, mimeType);
            resolve({
                dataUrl: proxies.proxyDataUrl ?? dataUrl,
                thumbnailDataUrl: proxies.thumbnailDataUrl,
                mediumDataUrl: proxies.mediumDataUrl,
                originalDataUrl: proxies.proxyDataUrl ? dataUrl : undefined,
            });
        };
        img.onerror = () => resolve({ dataUrl });
        img.src = dataUrl;
    });
}

export const readAndCompressImage = async (file: File): Promise<ImageReadResult> => {
    if (isSvgFile(file)) {
        const svg = await parseSvgFile(file);
        return {
            dataUrl: svg.dataUrl,
            thumbnailDataUrl: svg.dataUrl,
            originalDataUrl: svg.dataUrl,
            width: svg.width,
            height: svg.height,
            mimeType: 'image/svg+xml',
        };
    }

    if (isPsdFile(file)) {
        const { parsePsdFile } = await import('./psdUtils');
        const psd = await parsePsdFile(file);
        const { width, height, compositeDataUrl } = psd;
        const proxyInfo = await createProxiesFromDataUrl(compositeDataUrl, width, height, 'image/png');
        return {
            dataUrl: proxyInfo.dataUrl,
            thumbnailDataUrl: proxyInfo.thumbnailDataUrl,
            mediumDataUrl: proxyInfo.mediumDataUrl,
            originalDataUrl: proxyInfo.originalDataUrl,
            width,
            height,
            mimeType: 'image/png',
        };
    }

    if (isTiffFile(file)) {
        const { parseTiffFile } = await import('./tiffUtils');
        const tiff = await parseTiffFile(file);
        const proxyInfo = await createProxiesFromDataUrl(tiff.dataUrl, tiff.width, tiff.height, 'image/png');
        return {
            dataUrl: proxyInfo.dataUrl,
            thumbnailDataUrl: proxyInfo.thumbnailDataUrl,
            mediumDataUrl: proxyInfo.mediumDataUrl,
            originalDataUrl: proxyInfo.originalDataUrl,
            width: tiff.width,
            height: tiff.height,
            mimeType: 'image/png',
        };
    }

    if (isTgaFile(file)) {
        const tga = await parseTgaFile(file);
        const proxyInfo = await createProxiesFromDataUrl(tga.dataUrl, tga.width, tga.height, 'image/png');
        return {
            dataUrl: proxyInfo.dataUrl,
            thumbnailDataUrl: proxyInfo.thumbnailDataUrl,
            mediumDataUrl: proxyInfo.mediumDataUrl,
            originalDataUrl: proxyInfo.originalDataUrl,
            width: tga.width,
            height: tga.height,
            mimeType: 'image/png',
        };
    }

    if (isExrFile(file)) {
        const exr = await parseExrFile(file);
        const proxyInfo = await createProxiesFromDataUrl(exr.dataUrl, exr.width, exr.height, 'image/png');
        return {
            dataUrl: proxyInfo.dataUrl,
            thumbnailDataUrl: proxyInfo.thumbnailDataUrl,
            mediumDataUrl: proxyInfo.mediumDataUrl,
            originalDataUrl: proxyInfo.originalDataUrl,
            width: exr.width,
            height: exr.height,
            mimeType: 'image/png',
        };
    }

    if (isRawFile(file)) {
        const { parseRawFile } = await import('./rawUtils');
        const raw = await parseRawFile(file);
        const proxyInfo = await createProxiesFromDataUrl(raw.dataUrl, raw.width, raw.height, 'image/png');
        return {
            dataUrl: proxyInfo.dataUrl,
            thumbnailDataUrl: proxyInfo.thumbnailDataUrl,
            mediumDataUrl: proxyInfo.mediumDataUrl,
            originalDataUrl: proxyInfo.originalDataUrl,
            width: raw.width,
            height: raw.height,
            mimeType: 'image/png',
        };
    }

    // Standard browser codecs can build all LOD proxies in a dedicated worker.
    // The worker closes its bitmap before we asynchronously read the original;
    // it never sends the potentially huge original data URL via postMessage.
    // Special parsers above (SVG, PSD, TIFF, RAW, etc.) retain their existing
    // behaviour, and missing OffscreenCanvas/unsupported codecs fall back below.
    if (WORKER_IMAGE_EXTENSIONS.has(fileExtension(file)) && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
        const { tryGenerateImageProxiesInWorker } = await import('./imageImportWorkerClient');
        const proxies = await tryGenerateImageProxiesInWorker(file, file.type || 'image/png');
        if (proxies) {
            const { dataUrl: originalDataUrl } = await fileToDataUrl(file);
            return {
                dataUrl: proxies.proxyDataUrl ?? originalDataUrl,
                thumbnailDataUrl: proxies.thumbnailDataUrl,
                mediumDataUrl: proxies.mediumDataUrl,
                originalDataUrl: proxies.proxyDataUrl ? originalDataUrl : undefined,
                width: proxies.width,
                height: proxies.height,
                mimeType: file.type || 'image/png',
            };
        }
    }

    // Decode the uploaded File from a short-lived blob URL. The previous path
    // first allocated its full base64 data URL, then fed the same huge string to
    // an Image while drawing three proxies. A batch would retain all originals
    // plus these transient copies and exceed V8's heap before the first commit.
    const sourceUrl = URL.createObjectURL(file);
    const img = new Image();
    try {
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
            img.src = sourceUrl;
        });
        const { width, height } = img;
        const mimeType = file.type || 'image/png';
        const proxies = generateProxyDataUrls(img, width, height, mimeType);
        // Release the decoded input before materializing the persistent original.
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        URL.revokeObjectURL(sourceUrl);
        const { dataUrl: originalDataUrl } = await fileToDataUrl(file);
        return {
            dataUrl: proxies.proxyDataUrl ?? originalDataUrl,
            thumbnailDataUrl: proxies.thumbnailDataUrl,
            mediumDataUrl: proxies.mediumDataUrl,
            originalDataUrl: proxies.proxyDataUrl ? originalDataUrl : undefined,
            width,
            height,
            mimeType,
        };
    } finally {
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        URL.revokeObjectURL(sourceUrl);
    }
};
