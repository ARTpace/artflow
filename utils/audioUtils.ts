/**
 * Utilities for Audio file detection, metadata extraction, and Data URL conversions.
 */

const AUDIO_EXTENSIONS = new Set([
    'wav', 'mp3', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'
]);

export const isAudioFile = (file: File): boolean => {
    if (!file) return false;
    if (file.type.startsWith('audio/')) return true;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    return AUDIO_EXTENSIONS.has(ext);
};

export interface AudioReadResult {
    dataUrl: string;
    mimeType: string;
    name: string;
    duration: number;
    width: number;
    height: number;
}

export const parseAudioFile = async (file: File): Promise<AudioReadResult> => {
    const dataUrl = URL.createObjectURL(file);
    const mimeType = file.type || `audio/${file.name.split('.').pop()?.toLowerCase() || 'mpeg'}`;

    return new Promise((resolve) => {
        const audio = document.createElement('audio');
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => {
            resolve({
                dataUrl,
                mimeType,
                name: file.name,
                duration: audio.duration || 0,
                width: 350,
                height: 130,
            });
        };
        audio.onerror = () => {
            resolve({
                dataUrl,
                mimeType,
                name: file.name,
                duration: 0,
                width: 350,
                height: 130,
            });
        };
        audio.src = dataUrl;
    });
};
