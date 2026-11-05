/**
 * Utilities for SVG file parsing, validation, and rendering dimensions extraction.
 */

export const isSvgFile = (file: File): boolean => {
    if (!file) return false;
    return file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
};

export const isSvgString = (content: string): boolean => {
    if (!content || typeof content !== 'string') return false;
    const trimmed = content.trim();
    return (
        (trimmed.startsWith('<svg') || (trimmed.startsWith('<?xml') && trimmed.includes('<svg'))) &&
        trimmed.includes('</svg>')
    );
};

export interface SvgParseResult {
    dataUrl: string;
    width: number;
    height: number;
    mimeType: string;
    name: string;
}

export const parseSvgContent = (svgText: string, defaultName = 'vector.svg'): SvgParseResult => {
    let width = 400;
    let height = 400;

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');
        const svgEl = doc.querySelector('svg');

        if (svgEl) {
            const widthAttr = svgEl.getAttribute('width');
            const heightAttr = svgEl.getAttribute('height');
            const viewBox = svgEl.getAttribute('viewBox');

            let parsedW: number | null = null;
            let parsedH: number | null = null;

            if (widthAttr && !widthAttr.includes('%')) {
                const val = parseFloat(widthAttr);
                if (!isNaN(val) && val > 0) parsedW = val;
            }

            if (heightAttr && !heightAttr.includes('%')) {
                const val = parseFloat(heightAttr);
                if (!isNaN(val) && val > 0) parsedH = val;
            }

            if (viewBox) {
                const parts = viewBox.trim().split(/[\s,]+/).map(parseFloat);
                if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
                    if (parsedW === null) parsedW = parts[2];
                    if (parsedH === null) parsedH = parts[3];
                }
            }

            if (parsedW !== null && parsedH !== null) {
                width = parsedW;
                height = parsedH;
            } else if (parsedW !== null) {
                width = parsedW;
                height = parsedW;
            } else if (parsedH !== null) {
                width = parsedH;
                height = parsedH;
            }
        }
    } catch (e) {
        console.warn('Could not parse SVG attributes, using defaults:', e);
    }

    // Ensure valid non-zero bounds
    width = Math.max(16, Math.min(width, 4000));
    height = Math.max(16, Math.min(height, 4000));

    // Convert to base64 Data URL for robust cross-browser and iframe SVG rendering
    const encoded = btoa(unescape(encodeURIComponent(svgText)));
    const dataUrl = `data:image/svg+xml;base64,${encoded}`;

    return {
        dataUrl,
        width,
        height,
        mimeType: 'image/svg+xml',
        name: defaultName,
    };
};

export const parseSvgFile = async (file: File): Promise<SvgParseResult> => {
    const text = await file.text();
    return parseSvgContent(text, file.name);
};
