import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { VOXLoader } from 'three/examples/jsm/loaders/VOXLoader.js';
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { VTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js';
import { KMZLoader } from 'three/examples/jsm/loaders/KMZLoader.js';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';

export {
    MODEL_3D_EXTENSIONS,
    PREVIEWABLE_3D_EXTENSIONS,
    is3DModelFile,
    isPreviewable3DFile,
} from './model3dFormats';

export interface LoadModelResult {
    object: THREE.Object3D;
    animations: THREE.AnimationClip[];
    stats: {
        vertexCount: number;
        triangleCount: number;
        meshCount: number;
    };
}

export const load3DModel = async (
    url: string, 
    extension: string,
    onProgress?: (percent: number) => void
): Promise<LoadModelResult> => {
    const ext = extension.toLowerCase().replace('.', '');
    const manager = new THREE.LoadingManager();
    
    if (onProgress) {
        manager.onProgress = (_item, loaded, total) => {
            if (total > 0) {
                onProgress(Math.round((loaded / total) * 100));
            }
        };
    }

    let loadedObject: THREE.Object3D;
    let animations: THREE.AnimationClip[] = [];

    switch (ext) {
        case 'glb':
        case 'gltf': {
            const loader = new GLTFLoader(manager);
            const gltf = await loader.loadAsync(url);
            loadedObject = gltf.scene || gltf.scenes[0];
            animations = gltf.animations || [];
            break;
        }

        case 'fbx': {
            const loader = new FBXLoader(manager);
            const fbx = await loader.loadAsync(url);
            loadedObject = fbx;
            animations = fbx.animations || [];
            break;
        }

        case 'dae': {
            const loader = new ColladaLoader(manager);
            const collada = await loader.loadAsync(url);
            loadedObject = collada.scene;
            // @types/three exposes no normalized animation clip list for Collada.
            // Keep the preview correct and leave animation playback empty for this loader.
            animations = [];
            break;
        }

        case '3ds': {
            const loader = new TDSLoader(manager);
            loadedObject = await loader.loadAsync(url);
            break;
        }

        case '3mf': {
            const loader = new ThreeMFLoader(manager);
            loadedObject = await loader.loadAsync(url);
            break;
        }

        case 'vox': {
            const loader = new VOXLoader(manager);
            const vox = await loader.loadAsync(url);
            // VOXLoader already builds a scene from its chunks; treating the result as an array was invalid.
            loadedObject = vox.scene;
            break;
        }

        case 'wrl':
        case 'vrml': {
            const loader = new VRMLLoader(manager);
            loadedObject = await loader.loadAsync(url);
            break;
        }

        case 'pcd': {
            const loader = new PCDLoader(manager);
            const points = await loader.loadAsync(url);
            loadedObject = points;
            break;
        }

        case 'vtk': {
            const loader = new VTKLoader(manager);
            const geometry = await loader.loadAsync(url);
            const material = new THREE.MeshStandardMaterial({
                color: 0x90cdf4,
                roughness: 0.35,
                metalness: 0.25,
            });
            loadedObject = new THREE.Mesh(geometry, material);
            break;
        }

        case 'kmz': {
            const loader = new KMZLoader(manager);
            const collada = await loader.loadAsync(url);
            loadedObject = collada.scene;
            break;
        }

        case 'bvh': {
            const loader = new BVHLoader(manager);
            const result = await loader.loadAsync(url);
            const skeletonHelper = new THREE.SkeletonHelper(result.skeleton.bones[0]);
            const boneContainer = new THREE.Group();
            boneContainer.add(result.skeleton.bones[0]);
            boneContainer.add(skeletonHelper);
            loadedObject = boneContainer;
            if (result.clip) {
                animations = [result.clip];
            }
            break;
        }

        case 'obj': {
            const loader = new OBJLoader(manager);
            loadedObject = await loader.loadAsync(url);
            break;
        }

        case 'stl': {
            const loader = new STLLoader(manager);
            const geometry = await loader.loadAsync(url);
            const material = new THREE.MeshStandardMaterial({
                color: 0x90cdf4,
                roughness: 0.35,
                metalness: 0.25,
            });
            loadedObject = new THREE.Mesh(geometry, material);
            break;
        }

        case 'ply': {
            const loader = new PLYLoader(manager);
            const geometry = await loader.loadAsync(url);
            const material = new THREE.MeshStandardMaterial({
                color: 0x9ae6b4,
                roughness: 0.4,
                metalness: 0.2,
            });
            loadedObject = new THREE.Mesh(geometry, material);
            break;
        }

        default:
            throw new Error(`Format .${ext} is not previewable in 3D WebGL viewer.`);
    }

    // Compute stats & configure meshes
    let vertexCount = 0;
    let triangleCount = 0;
    let meshCount = 0;

    loadedObject.traverse((child) => {
        if ((child as THREE.Mesh).isMesh || (child as THREE.Points).isPoints) {
            meshCount++;
            const mesh = child as THREE.Mesh;
            mesh.castShadow = true;
            mesh.receiveShadow = true;

            if (mesh.geometry) {
                const geom = mesh.geometry;
                if (geom.attributes.position) {
                    vertexCount += geom.attributes.position.count;
                }
                if (geom.index) {
                    triangleCount += geom.index.count / 3;
                } else if (geom.attributes.position) {
                    triangleCount += geom.attributes.position.count / 3;
                }
            }

            // Ensure materials respond well to lighting
            if (mesh.material) {
                const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                mats.forEach(mat => {
                    mat.side = THREE.DoubleSide;
                });
            }
        }
    });

    // Auto-center & normalize dimensions
    const box = new THREE.Box3().setFromObject(loadedObject);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const targetScale = maxDim > 0 ? 3.2 / maxDim : 1;

    loadedObject.scale.setScalar(targetScale);
    // Center at origin
    loadedObject.position.x = -center.x * targetScale;
    loadedObject.position.y = -center.y * targetScale;
    loadedObject.position.z = -center.z * targetScale;

    const wrapper = new THREE.Group();
    wrapper.add(loadedObject);

    return {
        object: wrapper,
        animations,
        stats: {
            vertexCount: Math.round(vertexCount),
            triangleCount: Math.round(triangleCount),
            meshCount
        }
    };
};
