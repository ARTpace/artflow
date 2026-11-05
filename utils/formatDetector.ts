import { MODEL_3D_EXTENSIONS } from './model3dFormats';
import { 
    MARKDOWN_EXTENSIONS, 
    CODE_EXTENSIONS_MAP, 
    TEXT_EXTENSIONS, 
    FONT_EXTENSIONS, 
    URL_EXTENSIONS 
} from './docUtils';

export const IMAGE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'jfif', 'gif', 'tif', 'tiff', 'webp', 'avif', 
    'svg', 'bmp', 'ico', 'psd', 'psb', 'exr', 'tga', 'raw', 'dng', 
    'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw'
]);

export const VIDEO_EXTENSIONS = new Set([
    'mp4', 'mov', 'avi', 'wmv', 'webm', 'mkv', 'm4v'
]);

export const AUDIO_EXTENSIONS = new Set([
    'wav', 'mp3', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'
]);

export const DOCUMENT_EXTENSIONS = new Set([
    'pdf'
]);

export type SupportedCategory = 
    | 'image' 
    | 'video' 
    | 'audio' 
    | 'pdf' 
    | 'markdown' 
    | 'code' 
    | 'text' 
    | 'bookmark' 
    | 'font' 
    | 'model3d'
    | 'file';

export const getFileCategory = (file: File): SupportedCategory => {
    if (!file) return 'file';
    const ext = file.name.split('.').pop()?.toLowerCase() || '';

    if (file.type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) {
        return 'image';
    }

    if (file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) {
        return 'video';
    }

    if (file.type.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) {
        return 'audio';
    }

    if (file.type === 'application/pdf' || DOCUMENT_EXTENSIONS.has(ext)) {
        return 'pdf';
    }

    if (MODEL_3D_EXTENSIONS.has(ext)) {
        return 'model3d';
    }

    if (MARKDOWN_EXTENSIONS.has(ext)) {
        return 'markdown';
    }

    if (FONT_EXTENSIONS.has(ext)) {
        return 'font';
    }

    if (URL_EXTENSIONS.has(ext)) {
        return 'bookmark';
    }

    if (ext in CODE_EXTENSIONS_MAP) {
        return 'code';
    }

    if (TEXT_EXTENSIONS.has(ext) || file.type.startsWith('text/')) {
        return 'text';
    }

    return 'file';
};

export const isSupportedFile = (file: File): boolean => {
    return Boolean(file && file.name);
};

export const ACCEPTED_FILE_TYPES_STRING = '*/*';

