
import React, { useCallback } from 'react';
import { Element, ImageElement, VideoElement, PathElement, AIRotationState, ImageAspectRatio, Rect, FrameElement } from '../types';
import type { AIProviderRequest, AIProviderResponse } from '../plugin-runtime/ai-providers';
import { generateId, getElementBounds, rasterizeElement, rasterizeElements, rasterizeMask, getFlattenedSelection, getSelectionBounds, getClosestAspectRatio, getCanvasScreenRect } from '../utils/canvasUtils';

/** 注入的 provider 调用入口：由 App 绑定到 kernel 上的 `gemini.image-generator`。 */
export type InvokeAIProvider = (request: AIProviderRequest) => Promise<AIProviderResponse>;

/** 从 provider 响应里取全部图像产物（data URL 形态）。失败或无产物时返回空数组。 */
export const imageArtifacts = (response: AIProviderResponse): { href: string; mimeType: string }[] => {
    if (!response.ok) return [];
    return response.artifacts
        .filter(artifact => artifact.kind === 'image' && artifact.dataUrl)
        .map(artifact => ({ href: artifact.dataUrl as string, mimeType: artifact.mimeType }));
};

/** 从 provider 响应里取文本产物；失败时回退到 error，供界面提示。 */
export const textArtifact = (response: AIProviderResponse): string | undefined => {
    if (!response.ok) return response.error;
    const artifact = response.artifacts.find(item => item.kind === 'text');
    return artifact?.content ?? response.error;
};

interface AIHandlersProps {
    invokeProvider: InvokeAIProvider;
    elements: Element[];
    selectedElementIds: string[];
    zoom: number;
    panOffset: { x: number, y: number };
    generationMode: 'image' | 'video';
    videoAspectRatio: '16:9' | '9:16';
    numberOfVideos: number;
    numberOfImages: number;
    imageAspectRatio: ImageAspectRatio;
    prompt: string;
    setPrompt: (prompt: string) => void;
    setIsLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
    setProgressMessage: (message: string) => void;
    setSelectedElementIds: (ids: string[]) => void;
    addElementsWithParenting: (elements: Element[]) => void;
    commitAction: (updater: (prev: Element[]) => Element[]) => void;
    setAiRotationState: (state: AIRotationState | null) => void;
    getCanvasPoint: (clientX: number, clientY: number) => { x: number, y: number };
    svgRef: React.RefObject<SVGSVGElement>;
}

export const useAIHandlers = ({
    invokeProvider,
    elements,
    selectedElementIds,
    zoom,
    panOffset,
    generationMode,
    videoAspectRatio,
    numberOfVideos,
    numberOfImages,
    imageAspectRatio,
    prompt,
    setPrompt,
    setIsLoading,
    setError,
    setProgressMessage,
    setSelectedElementIds,
    addElementsWithParenting,
    commitAction,
    setAiRotationState,
    getCanvasPoint,
    svgRef,
}: AIHandlersProps) => {

    const handleAIGenerateRotation = useCallback(async (state: AIRotationState) => {
        const { element, currentAngle, dragDirection } = state;
        if (!dragDirection) return;

        let aiPrompt = '';
        const angle = Math.abs(currentAngle);

        if (dragDirection === 'h') {
            const direction = currentAngle > 0 ? 'to their right' : 'to their left';
            aiPrompt = `Re-render this image with the subject turned to face ${direction} by approximately ${angle} degrees. The overall style, lighting, and background should be preserved as closely as possible.`;
        } else {
            const direction = currentAngle > 0 ? 'downwards from a higher viewpoint' : 'upwards from a lower viewpoint';
            aiPrompt = `Re-render this image as if viewed ${direction}, simulating a 3D perspective tilt of about ${angle} degrees. Keep the subject and style identical.`;
        }

        setIsLoading(true);
        setError(null);
        setProgressMessage('Applying AI perspective shift...');

        try {
            const response = await invokeProvider({
                prompt: aiPrompt,
                referenceImages: [element.href],
                parameters: { op: 'image-to-image' },
            });
            const [generated] = imageArtifacts(response);

            if (generated) {
                const img = new Image();
                img.onload = () => {
                    const PADDING = 20 / zoom;
                    const newImage: ImageElement = {
                        id: generateId(),
                        type: 'image',
                        name: `${element.name || 'Image'} (rotated)`,
                        x: element.x + element.width + PADDING,
                        y: element.y + (element.height / 2) - (img.height / 2),
                        width: img.width,
                        height: img.height,
                        href: generated.href,
                        mimeType: generated.mimeType,
                        parentId: element.parentId,
                        rotation: 0,
                    };
                    addElementsWithParenting([newImage]);
                    setSelectedElementIds([newImage.id]);
                };
                img.src = generated.href;
            } else {
                setError(textArtifact(response) || 'AI operation failed to produce an image.');
            }
        } catch (err) {
            const error = err as Error;
            setError(`Failed to perform AI operation: ${error.message}`);
            console.error(err);
        } finally {
            setIsLoading(false);
            setProgressMessage('');
            setAiRotationState(null);
        }
    }, [invokeProvider, zoom, addElementsWithParenting, setSelectedElementIds, setIsLoading, setError, setProgressMessage, setAiRotationState]);

    const handleRemoveBackground = useCallback(async (element: ImageElement) => {
        if (!element) return;

        setIsLoading(true);
        setError(null);
        setProgressMessage('Removing background...');

        try {
            const response = await invokeProvider({
                prompt: "Please remove the background of this image. The output should only contain the main subject with a transparent background.",
                referenceImages: [element.href],
                parameters: { op: 'image-to-image' },
            });
            const [generated] = imageArtifacts(response);

            if (generated) {
                const img = new Image();
                img.onload = () => {
                    const PADDING = 20 / zoom;
                    const newImage: ImageElement = {
                        id: generateId(),
                        type: 'image',
                        name: `${element.name || 'Image'} (no bg)`,
                        x: element.x + element.width + PADDING,
                        y: element.y + (element.height / 2) - (img.height / 2),
                        width: img.width,
                        height: img.height,
                        href: generated.href,
                        mimeType: generated.mimeType,
                        parentId: element.parentId,
                        rotation: 0,
                    };

                    addElementsWithParenting([newImage]);
                    setSelectedElementIds([newImage.id]);
                };
                img.onerror = () => setError('Failed to load the background-removed image.');
                img.src = generated.href;
            } else {
                setError(textArtifact(response) || 'Background removal failed to produce an image.');
            }

        } catch (err) {
            const error = err as Error;
            setError(`Failed to remove background: ${error.message}`);
            console.error(err);
        } finally {
            setIsLoading(false);
            setProgressMessage('');
        }
    }, [invokeProvider, zoom, addElementsWithParenting, setSelectedElementIds, setIsLoading, setError, setProgressMessage]);

    const handleGetPromptFromImage = useCallback(async (element: ImageElement) => {
        if (!element) return;

        setIsLoading(true);
        setError(null);
        setProgressMessage('Analyzing image...');

        try {
            const response = await invokeProvider({
                prompt: 'Describe this image',
                referenceImages: [element.href],
                parameters: { op: 'prompt-enhancement' },
            });
            const generatedPrompt = textArtifact(response);
            if (!generatedPrompt) throw new Error('AI did not return a prompt.');
            setPrompt(generatedPrompt);
        } catch (err) {
            const error = err as Error;
            setError(`Failed to get prompt from image: ${error.message}`);
            console.error(err);
        } finally {
            setIsLoading(false);
            setProgressMessage('');
        }
    }, [invokeProvider, setPrompt, setIsLoading, setError, setProgressMessage]);

    const handleGenerate = useCallback(async () => {
        if (!prompt.trim()) {
            setError('Please enter a prompt.');
            return;
        }

        setIsLoading(true);
        setError(null);
        setProgressMessage('Starting generation...');

        if (generationMode === 'video') {
            try {
                const selectedElements = elements.filter(el => selectedElementIds.includes(el.id) && el.type !== 'frame');
                const imageElement = selectedElements.find(el => el.type === 'image') as ImageElement | undefined;
                
                if (selectedElementIds.length > 1 || (selectedElementIds.length === 1 && !imageElement)) {
                    setError('For video generation, please select a single image or no elements.');
                    setIsLoading(false);
                    return;
                }
                
                const response = await invokeProvider({
                    prompt,
                    referenceImages: imageElement ? [imageElement.href] : [],
                    parameters: { op: 'video', aspectRatio: videoAspectRatio, numberOfVideos },
                    onProgress: (message) => setProgressMessage(message),
                });

                if (!response.ok) throw new Error(response.error || 'Video generation failed.');

                const videoArtifacts = response.artifacts.filter(item => item.kind === 'video' && item.dataUrl);
                if (videoArtifacts.length === 0) {
                    const text = response.artifacts.find(item => item.kind === 'text')?.content;
                    throw new Error(text || 'Video generation failed to produce a video.');
                }

                setProgressMessage('Processing video(s)...');

                const videoPromises = videoArtifacts.map(artifact => {
                    return new Promise<{ video: HTMLVideoElement; url: string; mimeType: string }>((resolve, reject) => {
                        const video = document.createElement('video');

                        video.onloadedmetadata = () => {
                            resolve({ video, url: artifact.dataUrl as string, mimeType: artifact.mimeType });
                        };

                        video.onerror = (err) => {
                            reject(err);
                        };

                        video.src = artifact.dataUrl as string;
                    });
                });

                const loadedVideos = await Promise.all(videoPromises);

                const svgBounds = getCanvasScreenRect(svgRef.current);
                if (!svgBounds) return;
                const screenCenter = { x: svgBounds.left + svgBounds.width / 2, y: svgBounds.top + svgBounds.height / 2 };
                const canvasPoint = getCanvasPoint(screenCenter.x, screenCenter.y);

                const PADDING = 20 / zoom;
                const totalWidth = loadedVideos.reduce((sum, {video}) => {
                    let newWidth = video.videoWidth;
                    let newHeight = video.videoHeight;
                    const MAX_DIM = 800;
                    if (newWidth > MAX_DIM || newHeight > MAX_DIM) {
                        const ratio = newWidth / newHeight;
                        if (ratio > 1) { newWidth = MAX_DIM; } else { newWidth = MAX_DIM * ratio; }
                    }
                    return sum + newWidth;
                }, 0) + (loadedVideos.length - 1) * PADDING;

                let currentX = canvasPoint.x - totalWidth / 2;

                const newVideoElements: VideoElement[] = [];
                const newVideoIds: string[] = [];

                for (const { video, url, mimeType } of loadedVideos) {
                    let newWidth = video.videoWidth;
                    let newHeight = video.videoHeight;
                    const MAX_DIM = 800;
                    if (newWidth > MAX_DIM || newHeight > MAX_DIM) {
                        const ratio = newWidth / newHeight;
                        if (ratio > 1) { // landscape
                            newWidth = MAX_DIM;
                            newHeight = MAX_DIM / ratio;
                        } else { // portrait or square
                            newHeight = MAX_DIM;
                            newWidth = MAX_DIM * ratio;
                        }
                    }

                    const y = canvasPoint.y - (newHeight / 2);

                    const newVideoElement: VideoElement = {
                        id: generateId(), type: 'video', name: 'Generated Video',
                        x: currentX, y,
                        width: newWidth,
                        height: newHeight,
                        href: url,
                        mimeType,
                        rotation: 0,
                    };

                    newVideoElements.push(newVideoElement);
                    newVideoIds.push(newVideoElement.id);
                    currentX += newWidth + PADDING;
                }

                addElementsWithParenting(newVideoElements);
                setSelectedElementIds(newVideoIds);
                setIsLoading(false);

            } catch (err) {
                 const error = err as Error; 
                 setError(`Video generation failed: ${error.message}`); 
                 console.error("Video generation failed:", error);
                 setIsLoading(false);
            }
            return;
        }

        // IMAGE GENERATION LOGIC
        try {
            // Check for Frame selection
            if (selectedElementIds.length === 1) {
                const selectedEl = elements.find(el => el.id === selectedElementIds[0]);
                if (selectedEl && selectedEl.type === 'frame') {
                    const frame = selectedEl as FrameElement;
                    const ratio = getClosestAspectRatio(frame.width, frame.height);
                    
                    const response = await invokeProvider({
                        prompt,
                        parameters: { op: 'text-to-image', aspectRatio: ratio, numberOfImages },
                    });
                    const generatedImages = imageArtifacts(response);
                    
                    if (generatedImages.length > 0) {
                         const loadedImages = await Promise.all(generatedImages.map(async (imgData) => {
                             const img = new Image();
                             img.src = imgData.href;
                             await img.decode();
                             return { img, data: imgData };
                         }));

                         const PADDING = 20 / zoom;
                         const newElements: ImageElement[] = [];
                         const newIds: string[] = [];
                         
                         const fittedImages = loadedImages.map(({img, data}) => {
                             const imgRatio = img.width / img.height;
                             const frameRatio = frame.width / frame.height;
                             let w = frame.width;
                             let h = frame.height;
                             if (frameRatio > imgRatio) { // Frame wider, fit height
                                 h = frame.height; w = h * imgRatio;
                             } else { // Frame taller, fit width
                                 w = frame.width; h = w / imgRatio;
                             }
                             // Scale down slightly to fit nicely
                             w *= 0.9; h *= 0.9;
                             return { w, h, img, data };
                         });

                         const totalW = fittedImages.reduce((acc, cur) => acc + cur.w, 0) + (fittedImages.length - 1) * PADDING;
                         let startX = frame.x + (frame.width - totalW) / 2;
                         const centerY = frame.y + frame.height / 2;

                         for (const { w, h, data } of fittedImages) {
                             const newEl: ImageElement = {
                                 id: generateId(),
                                 type: 'image',
                                 name: 'Generated Image',
                                 x: startX,
                                 y: centerY - h/2,
                                 width: w,
                                 height: h,
                                 href: data.href,
                                 mimeType: data.mimeType,
                                 rotation: 0,
                                 parentId: frame.id
                             };
                             newElements.push(newEl);
                             newIds.push(newEl.id);
                             startX += w + PADDING;
                         }
                         
                         addElementsWithParenting(newElements);
                         setSelectedElementIds(newIds);
                    } else {
                        setError(textArtifact(response) || 'Generation failed.');
                    }
                    
                    setIsLoading(false);
                    return;
                }
            }

            const isEditing = selectedElementIds.length > 0;

            if (isEditing) {
                const flattenedSelection = getFlattenedSelection(selectedElementIds, elements);
                const selectedElements = flattenedSelection.filter(el => el.type !== 'frame');
                const imageElements = selectedElements.filter(el => el.type === 'image') as ImageElement[];
                const maskPaths = selectedElements.filter(el => el.type === 'path' && el.opacity && el.opacity < 1) as PathElement[];

                // Inpainting logic
                if (imageElements.length === 1 && maskPaths.length > 0 && selectedElements.length === (1 + maskPaths.length)) {
                    const baseImage = imageElements[0];
                    const maskData = await rasterizeMask(maskPaths, baseImage);
                    const response = await invokeProvider({
                        prompt,
                        referenceImages: [baseImage.href],
                        parameters: { op: 'inpainting', mask: maskData.href },
                    });
                    const [generated] = imageArtifacts(response);
                    
                    if (generated) {
                        const img = new Image();
                        img.onload = () => {
                            const PADDING = 20 / zoom;
                            const newImage: ImageElement = {
                                id: generateId(),
                                type: 'image',
                                name: `${baseImage.name || 'Image'} (inpainted)`,
                                x: baseImage.x + baseImage.width + PADDING,
                                y: baseImage.y + (baseImage.height / 2) - (img.height / 2),
                                width: img.width,
                                height: img.height,
                                href: generated.href,
                                mimeType: generated.mimeType,
                                parentId: baseImage.parentId,
                                rotation: 0,
                            };
                    
                            addElementsWithParenting([newImage]);
                            setSelectedElementIds([newImage.id]);
                        };
                        img.onerror = () => setError('Failed to load the generated image.');
                        img.src = generated.href;
                    } else {
                        setError(textArtifact(response) || 'Inpainting failed to produce an image.');
                    }
                    return;
                }
                
                // Regular edit/combine logic
                const imagePromises = selectedElements
                    .filter(el => el.type !== 'group')
                    .map(el => {
                        if (el.type === 'image') return Promise.resolve({ href: el.href, mimeType: el.mimeType });
                        if (el.type === 'video') return Promise.reject(new Error("Cannot use video elements in image generation."));
                        return rasterizeElement(el as any);
                });
                const imagesToProcess = await Promise.all(imagePromises);

                const generationPromises = Array.from({ length: numberOfImages }).map((_, i) => {
                    setProgressMessage(`Generating image ${i + 1} of ${numberOfImages}...`);
                    return invokeProvider({
                        prompt,
                        referenceImages: imagesToProcess.map(item => item.href),
                        parameters: { op: 'image-to-image' },
                    });
                });

                const responses = await Promise.all(generationPromises);
                const generatedImages = responses.flatMap(imageArtifacts);

                if (generatedImages.length > 0) {
                     const imagePromises = generatedImages.map(data => {
                        return new Promise<{img: HTMLImageElement, data: { href: string, mimeType: string }}>((resolve, reject) => {
                            const img = new Image();
                            img.onload = () => resolve({img, data});
                            img.onerror = (err) => reject(err);
                            img.src = data.href;
                        });
                    });

                    const loadedImages = await Promise.all(imagePromises);
                    
                    const selectionBounds = getSelectionBounds(selectedElementIds, elements);

                    const PADDING = 20 / zoom;
                    let currentX = selectionBounds.x + selectionBounds.width + PADDING;
                    const selectionCenterY = selectionBounds.y + selectionBounds.height / 2;

                    const newImageElements: ImageElement[] = [];
                    const newImageIds: string[] = [];

                    for (const {img, data} of loadedImages) {
                        const y = selectionCenterY - (img.height / 2);
                        const newImage: ImageElement = {
                            id: generateId(), type: 'image', x: currentX, y, name: 'Generated Image',
                            width: img.width, height: img.height,
                            href: data.href, mimeType: data.mimeType,
                            rotation: 0,
                        };
                        newImageElements.push(newImage);
                        newImageIds.push(newImage.id);
                        currentX += img.width + PADDING;
                    }
                    
                    addElementsWithParenting(newImageElements);
                    setSelectedElementIds(newImageIds);
                } else {
                    const firstError = responses.find(r => !r.ok && r.error)?.error;
                    setError(firstError || 'Generation failed to produce any images.');
                }

            } else {
                // Generate from scratch
                const response = await invokeProvider({
                    prompt,
                    parameters: { op: 'text-to-image', aspectRatio: imageAspectRatio, numberOfImages },
                });
                const generatedImages = imageArtifacts(response);

                if (generatedImages.length > 0) {
                    const imagePromises = generatedImages.map(imgData => {
                        return new Promise<{img: HTMLImageElement, data: { href: string; mimeType: string }}>((resolve, reject) => {
                            const img = new Image();
                            img.onload = () => resolve({img, data: imgData});
                            img.onerror = (err) => reject(err);
                            img.src = imgData.href;
                        });
                    });

                    const loadedImages = await Promise.all(imagePromises);

                    const svgBounds = getCanvasScreenRect(svgRef.current);
                    if (!svgBounds) return;
                    const screenCenter = { x: svgBounds.left + svgBounds.width / 2, y: svgBounds.top + svgBounds.height / 2 };
                    const canvasPoint = getCanvasPoint(screenCenter.x, screenCenter.y);

                    const PADDING = 20 / zoom;
                    const totalWidth = loadedImages.reduce((sum, {img}) => sum + img.width, 0) + (loadedImages.length - 1) * PADDING;
                    let currentX = canvasPoint.x - totalWidth / 2;

                    const newImageElements: ImageElement[] = [];
                    const newImageIds: string[] = [];

                    for (const {img, data} of loadedImages) {
                        const y = canvasPoint.y - (img.height / 2);
                        const newImage: ImageElement = {
                            id: generateId(), type: 'image', x: currentX, y, name: 'Generated Image',
                            width: img.width, height: img.height,
                            href: data.href, mimeType: data.mimeType,
                            rotation: 0,
                        };
                        newImageElements.push(newImage);
                        newImageIds.push(newImage.id);
                        currentX += img.width + PADDING;
                    }

                    addElementsWithParenting(newImageElements);
                    setSelectedElementIds(newImageIds);
                } else { 
                    setError(textArtifact(response) || 'Generation failed to produce an image.'); 
                }
            }
        } catch (err) {
            const error = err as Error; 
            let friendlyMessage = `An error occurred during generation: ${error.message}`;

            if (error.message && (error.message.includes('429') || error.message.toUpperCase().includes('RESOURCE_EXHAUSTED'))) {
                friendlyMessage = "API 额度已耗尽。请检查您的 Google AI Studio 计划和账单详情，或稍后再试。";
            } else if (error.message && error.message.includes('billed users')) {
                friendlyMessage = "Imagen API 当前仅对已启用结算（Billing）的用户开放。请前往 Google Cloud 控制台为您的项目启用结算功能。";
            } else {
                friendlyMessage = `生成过程中发生错误: ${error.message}`;
            }
            setError(friendlyMessage);
            console.error("Generation failed:", error);
        } finally { 
            setIsLoading(false); 
            setProgressMessage('');
        }
    }, [invokeProvider, prompt, generationMode, elements, selectedElementIds, videoAspectRatio, numberOfVideos, numberOfImages, imageAspectRatio, zoom, addElementsWithParenting, setSelectedElementIds, setIsLoading, setError, setProgressMessage, getCanvasPoint, svgRef]);

    const handleRasterizeSelection = useCallback(async () => {
        const flattenedSelection = getFlattenedSelection(selectedElementIds, elements);
        const elementsToRasterize = flattenedSelection.filter(
            (el): el is Exclude<Element, ImageElement | VideoElement | FrameElement | import('../types').GroupElement> => {
                switch (el.type) {
                    case 'image':
                    case 'video':
                    case 'frame':
                    case 'group':
                        return false;
                    default:
                        return true;
                }
            }
        );

        if (elementsToRasterize.length === 0) return;

        setIsLoading(true);
        setError(null);

        try {
            let minX = Infinity, minY = Infinity;
            elementsToRasterize.forEach(element => {
                const bounds = getElementBounds(element, elements);
                minX = Math.min(minX, bounds.x);
                minY = Math.min(minY, bounds.y);
            });
            
            const { href, mimeType, width, height } = await rasterizeElements(elementsToRasterize);
            
            const newImage: ImageElement = {
                id: generateId(),
                type: 'image', name: 'Rasterized Image',
                x: minX - 10,
                y: minY - 10,
                width,
                height,
                href,
                mimeType,
                rotation: 0,
            };

            const idsToRemove = new Set(elementsToRasterize.map(el => el.id));

            commitAction(prev => {
                const remainingElements = prev.filter(el => !idsToRemove.has(el.id));
                return [...remainingElements, newImage];
            });

            setSelectedElementIds([newImage.id]);

        } catch (err) {
            const error = err as Error;
            setError(`Failed to rasterize selection: ${error.message}`);
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    }, [elements, selectedElementIds, commitAction, setSelectedElementIds, setIsLoading, setError]);

    return {
        handleAIGenerateRotation,
        handleRemoveBackground,
        handleGetPromptFromImage,
        handleGenerate,
        handleRasterizeSelection,
    };
};
