import type { FileCardCategory } from '../types';

export const CODE_EXTENSIONS_MAP: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    pyw: 'python',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    json5: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    env: 'bash',
    graphql: 'graphql',
    gql: 'graphql',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    rb: 'ruby',
    lua: 'lua',
    vue: 'html',
    svelte: 'html',
    toml: 'toml',
    dockerfile: 'docker',
    r: 'r',
    dart: 'dart',
};

export const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
export const TEXT_EXTENSIONS = new Set(['txt', 'log', 'csv', 'tsv', 'rtf', 'ini', 'conf', 'diff', 'patch', 'cfg', 'properties', 'env']);
export const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);
export const URL_EXTENSIONS = new Set(['url', 'webloc']);

export const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'dmg', 'pkg', 'apk', 'ipa']);
export const MODEL_3D_EXTENSIONS = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3ds', '3mf', 'vox', 'wrl', 'vrml', 'pcd', 'vtk', 'kmz', 'bvh', 'step', 'stp', 'iges', 'igs']);
export const DESIGN_EXTENSIONS = new Set(['blend', 'fig', 'sketch', 'c4d', 'ai', 'eps', 'prproj', 'aep', 'xd', 'dwg', 'dxf', 'indd', 'procreate']);
export const DOC_EXTENSIONS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'numbers', 'pages', 'key', 'epub', 'mobi']);
export const EXECUTABLE_EXTENSIONS = new Set(['exe', 'msi', 'app', 'bat', 'cmd', 'ps1']);

export function formatBytes(bytes: number, decimals: number = 1): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function classifyFileCategory(ext: string): FileCardCategory {
    const cleanExt = ext.toLowerCase();
    if (ARCHIVE_EXTENSIONS.has(cleanExt)) return 'archive';
    if (MODEL_3D_EXTENSIONS.has(cleanExt)) return '3d';
    if (DESIGN_EXTENSIONS.has(cleanExt)) return 'design';
    if (DOC_EXTENSIONS.has(cleanExt)) return 'doc';
    if (EXECUTABLE_EXTENSIONS.has(cleanExt)) return 'executable';
    if (cleanExt === 'csv' || cleanExt === 'tsv' || cleanExt === 'json' || cleanExt === 'sql') return 'data';
    return 'general';
}

export function getLanguageFromExt(ext: string): string {
    return CODE_EXTENSIONS_MAP[ext.toLowerCase()] || 'javascript';
}

/**
 * Reads text content from file
 */
export async function readTextFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}

/**
 * Parse URL from .url or .webloc file
 */
export async function parseUrlFile(file: File): Promise<{ url: string; title: string }> {
    const text = await readTextFile(file);
    const fileName = file.name.replace(/\.[^/.]+$/, '');
    
    // Windows .url file: URL=https://...
    const urlMatch = text.match(/URL=(https?:\/\/[^\r\n]+)/i);
    if (urlMatch && urlMatch[1]) {
        return { url: urlMatch[1].trim(), title: fileName };
    }

    // macOS .webloc XML plist: <string>https://...</string>
    const weblocMatch = text.match(/<string>(https?:\/\/[^<]+)<\/string>/i);
    if (weblocMatch && weblocMatch[1]) {
        return { url: weblocMatch[1].trim(), title: fileName };
    }

    // General URL match in text
    const anyUrl = text.match(/(https?:\/\/[^\s"'<>]+)/i);
    if (anyUrl && anyUrl[1]) {
        return { url: anyUrl[1].trim(), title: fileName };
    }

    return { url: 'https://', title: fileName };
}

/**
 * Dynamic Font Loader using FontFace API
 */
export async function loadFontFile(file: File): Promise<{ fontFamily: string; fontUrl: string; format: string }> {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'ttf';
    const fontUrl = URL.createObjectURL(file);
    const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fontFamily = `CustomFont_${cleanName}_${Date.now()}`;

    try {
        const fontFace = new FontFace(fontFamily, `url(${fontUrl})`);
        const loadedFont = await fontFace.load();
        document.fonts.add(loadedFont);
    } catch (e) {
        console.warn('FontFace dynamic loading warning:', e);
    }

    return {
        fontFamily,
        fontUrl,
        format: ext.toUpperCase(),
    };
}
