import UTIF from 'utif';

export const isTiffFile = (file: File): boolean => {
    if (!file) return false;
    const ext = file.name.toLowerCase();
    return ext.endsWith('.tif') || ext.endsWith('.tiff') || file.type === 'image/tiff';
};

export const parseTiffBuffer = (buffer: ArrayBuffer): { dataUrl: string; width: number; height: number } => {
    const ifds = UTIF.decode(buffer);
    if (!ifds || ifds.length === 0) {
        throw new Error('Failed to decode TIFF IFD headers.');
    }
    UTIF.decodeImage(buffer, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const width = ifds[0].width;
    const height = ifds[0].height;

    if (!width || !height) {
        throw new Error('Invalid TIFF dimensions.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create canvas context.');

    const imgData = ctx.createImageData(width, height);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);

    return {
        dataUrl: canvas.toDataURL('image/png'),
        width,
        height,
    };
};

export const parseTiffFile = async (file: File): Promise<{ dataUrl: string; width: number; height: number }> => {
    const buffer = await file.arrayBuffer();
    return parseTiffBuffer(buffer);
};
