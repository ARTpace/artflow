/** Lightweight 3D format detection. Keep this module free of Three.js so file routing stays cheap. */
export const MODEL_3D_EXTENSIONS = new Set([
    'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3ds', '3mf', 'vox',
    'wrl', 'vrml', 'pcd', 'vtk', 'kmz', 'bvh', 'blend', 'step', 'stp', 'iges', 'igs', 'c4d'
]);

export const PREVIEWABLE_3D_EXTENSIONS = new Set([
    'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3ds', '3mf', 'vox',
    'wrl', 'vrml', 'pcd', 'vtk', 'kmz', 'bvh'
]);

export const is3DModelFile = (file: File): boolean => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    return MODEL_3D_EXTENSIONS.has(ext);
};

export const isPreviewable3DFile = (filenameOrExt: string): boolean => {
    const ext = filenameOrExt.includes('.')
        ? filenameOrExt.split('.').pop()?.toLowerCase() || ''
        : filenameOrExt.toLowerCase();
    return PREVIEWABLE_3D_EXTENSIONS.has(ext);
};
