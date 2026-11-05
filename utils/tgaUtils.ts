/**
 * Self-contained TGA (Truevision TARGA) decoder for browser.
 */

export const isTgaFile = (file: File): boolean => {
    return file.name.toLowerCase().endsWith('.tga') || file.type === 'image/x-tga' || file.type === 'image/tga';
};

export const parseTgaBuffer = (buffer: ArrayBuffer): { dataUrl: string; width: number; height: number } => {
    const data = new Uint8Array(buffer);
    if (data.length < 18) {
        throw new Error('Invalid TGA file: Header too small.');
    }

    const idLength = data[0];
    const imageType = data[2];
    const width = data[12] | (data[13] << 8);
    const height = data[14] | (data[15] << 8);
    const pixelDepth = data[16];
    const imageDescriptor = data[17];

    if (width <= 0 || height <= 0) {
        throw new Error('Invalid TGA dimensions.');
    }

    const isRLE = imageType === 9 || imageType === 10 || imageType === 11;
    const isColor = imageType === 2 || imageType === 10;
    const isGray = imageType === 3 || imageType === 11;

    if (!isColor && !isGray) {
        throw new Error(`Unsupported TGA image type: ${imageType}`);
    }

    const bytesPerPixel = Math.floor(pixelDepth / 8);
    if (bytesPerPixel < 1 || bytesPerPixel > 4) {
        throw new Error(`Unsupported TGA bit depth: ${pixelDepth}`);
    }

    const totalPixels = width * height;
    const rgba = new Uint8ClampedArray(totalPixels * 4);

    let offset = 18 + idLength;

    if (isRLE) {
        let pixelIndex = 0;
        while (pixelIndex < totalPixels && offset < data.length) {
            const packetHeader = data[offset++];
            const count = (packetHeader & 0x7f) + 1;
            const isRunLength = (packetHeader & 0x80) !== 0;

            if (isRunLength) {
                const b = data[offset++];
                const g = bytesPerPixel >= 2 ? data[offset++] : b;
                const r = bytesPerPixel >= 3 ? data[offset++] : b;
                const a = bytesPerPixel === 4 ? data[offset++] : 255;

                for (let i = 0; i < count && pixelIndex < totalPixels; i++) {
                    const idx = pixelIndex * 4;
                    rgba[idx] = r;
                    rgba[idx + 1] = g;
                    rgba[idx + 2] = b;
                    rgba[idx + 3] = a;
                    pixelIndex++;
                }
            } else {
                for (let i = 0; i < count && pixelIndex < totalPixels; i++) {
                    const b = data[offset++];
                    const g = bytesPerPixel >= 2 ? data[offset++] : b;
                    const r = bytesPerPixel >= 3 ? data[offset++] : b;
                    const a = bytesPerPixel === 4 ? data[offset++] : 255;

                    const idx = pixelIndex * 4;
                    rgba[idx] = r;
                    rgba[idx + 1] = g;
                    rgba[idx + 2] = b;
                    rgba[idx + 3] = a;
                    pixelIndex++;
                }
            }
        }
    } else {
        for (let i = 0; i < totalPixels; i++) {
            const b = data[offset++];
            const g = bytesPerPixel >= 2 ? data[offset++] : b;
            const r = bytesPerPixel >= 3 ? data[offset++] : b;
            const a = bytesPerPixel === 4 ? data[offset++] : 255;

            const idx = i * 4;
            rgba[idx] = r;
            rgba[idx + 1] = g;
            rgba[idx + 2] = b;
            rgba[idx + 3] = a;
        }
    }

    // TGA origin is bottom-left by default unless bit 5 of descriptor is set
    const isTopDown = (imageDescriptor & 0x20) !== 0;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create canvas context.');

    const imgData = ctx.createImageData(width, height);

    if (isTopDown) {
        imgData.data.set(rgba);
    } else {
        // Flip vertically
        for (let y = 0; y < height; y++) {
            const srcRow = (height - 1 - y) * width * 4;
            const dstRow = y * width * 4;
            for (let x = 0; x < width * 4; x++) {
                imgData.data[dstRow + x] = rgba[srcRow + x];
            }
        }
    }

    ctx.putImageData(imgData, 0, 0);
    return {
        dataUrl: canvas.toDataURL('image/png'),
        width,
        height,
    };
};

export const parseTgaFile = async (file: File): Promise<{ dataUrl: string; width: number; height: number }> => {
    const buffer = await file.arrayBuffer();
    return parseTgaBuffer(buffer);
};
