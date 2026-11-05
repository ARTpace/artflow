/**
 * OpenEXR (.exr) parser and HDR tone-mapper for browser canvas.
 */

export const isExrFile = (file: File): boolean => {
    return file.name.toLowerCase().endsWith('.exr') || file.type === 'image/x-exr';
};

// Half float (Float16) to Float32 conversion
const decodeFloat16 = (binary: number): number => {
    const exponent = (binary & 0x7c00) >> 10;
    const fraction = binary & 0x03ff;
    const sign = (binary >> 15) !== 0 ? -1 : 1;

    if (exponent === 0) {
        return fraction === 0 ? sign * 0 : sign * Math.pow(2, -14) * (fraction / 1024);
    } else if (exponent === 0x1f) {
        return fraction === 0 ? sign * Infinity : NaN;
    }
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
};

export const parseExrBuffer = (buffer: ArrayBuffer): { dataUrl: string; width: number; height: number } => {
    const data = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // Check magic number 0x76 0x2f 0x31 0x01
    if (data[0] !== 0x76 || data[1] !== 0x2f || data[2] !== 0x31 || data[3] !== 0x01) {
        throw new Error('Not a valid OpenEXR file.');
    }

    // Read attributes until null byte
    let offset = 8;
    let width = 0;
    let height = 0;
    let dataWindow = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    let compression = 0; // 0 = NO_COMPRESSION

    while (offset < data.length) {
        // Read attribute name
        let attrName = '';
        while (offset < data.length && data[offset] !== 0) {
            attrName += String.fromCharCode(data[offset++]);
        }
        offset++; // skip null
        if (!attrName) break; // end of header

        // Read attribute type
        let attrType = '';
        while (offset < data.length && data[offset] !== 0) {
            attrType += String.fromCharCode(data[offset++]);
        }
        offset++; // skip null

        const attrSize = view.getInt32(offset, true);
        offset += 4;

        if (attrName === 'dataWindow' && attrType === 'box2i') {
            dataWindow.xMin = view.getInt32(offset, true);
            dataWindow.yMin = view.getInt32(offset + 4, true);
            dataWindow.xMax = view.getInt32(offset + 8, true);
            dataWindow.yMax = view.getInt32(offset + 12, true);
            width = dataWindow.xMax - dataWindow.xMin + 1;
            height = dataWindow.yMax - dataWindow.yMin + 1;
        } else if (attrName === 'compression' && attrType === 'compression') {
            compression = data[offset];
        }

        offset += attrSize;
    }

    if (width <= 0 || height <= 0) {
        width = 512;
        height = 512;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create canvas context.');

    const imgData = ctx.createImageData(width, height);
    const rgba = imgData.data;

    // Scanline offset table is located after header
    // If uncompressed or simple scanlines, we can read scanlines
    const scanlineTableOffset = offset;
    const numScanlines = height;
    offset += numScanlines * 8; // skip line offset table

    // Try reading scanlines
    let scanlineOffset = offset;
    for (let y = 0; y < height && scanlineOffset < data.length - 8; y++) {
        // Scanline header: yCoord (4 bytes) + pixelDataSize (4 bytes)
        const lineY = view.getInt32(scanlineOffset, true);
        const dataSize = view.getInt32(scanlineOffset + 4, true);
        scanlineOffset += 8;

        if (compression === 0) {
            // Uncompressed scanline contains channels in alphabetical order (e.g. B, G, R, A)
            // Each pixel is typically 2 bytes (HALF) or 4 bytes (FLOAT)
            const bytesPerChannel = Math.max(1, Math.floor(dataSize / (width * 3)));
            const bOffset = scanlineOffset;
            const gOffset = bOffset + width * bytesPerChannel;
            const rOffset = gOffset + width * bytesPerChannel;

            for (let x = 0; x < width; x++) {
                let r = 0, g = 0, b = 0;
                if (bytesPerChannel === 2) {
                    b = decodeFloat16(view.getUint16(bOffset + x * 2, true));
                    g = decodeFloat16(view.getUint16(gOffset + x * 2, true));
                    r = decodeFloat16(view.getUint16(rOffset + x * 2, true));
                } else {
                    b = view.getFloat32(bOffset + x * 4, true);
                    g = view.getFloat32(gOffset + x * 4, true);
                    r = view.getFloat32(rOffset + x * 4, true);
                }

                // Reinhard Tone mapping & gamma 2.2
                const tonemap = (val: number) => {
                    const mapped = Math.max(0, val) / (1 + Math.max(0, val));
                    return Math.min(255, Math.max(0, Math.round(Math.pow(mapped, 1 / 2.2) * 255)));
                };

                const targetIdx = (y * width + x) * 4;
                rgba[targetIdx] = tonemap(r);
                rgba[targetIdx + 1] = tonemap(g);
                rgba[targetIdx + 2] = tonemap(b);
                rgba[targetIdx + 3] = 255;
            }
        }
        scanlineOffset += dataSize;
    }

    ctx.putImageData(imgData, 0, 0);
    return {
        dataUrl: canvas.toDataURL('image/png'),
        width,
        height,
    };
};

export const parseExrFile = async (file: File): Promise<{ dataUrl: string; width: number; height: number }> => {
    const buffer = await file.arrayBuffer();
    return parseExrBuffer(buffer);
};
