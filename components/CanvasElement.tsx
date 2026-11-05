
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, Profiler } from 'react';
import { Element, ImageElement, Rect, AIRotationState } from '../types';
import { getElementBounds } from '../utils/canvasUtils';
import { getMaterializedCardComponent, getMaterializedCardPluginId } from '../plugin-runtime/renderer-materialization';
import { PluginErrorBoundary } from '../plugin-runtime/plugin-error-boundary';
import { ExtensionNodeCard } from './ExtensionNodeCard';
import { useImageLOD, resolveImageRenderRequirement, isSameImageRenderRequirement } from '../utils/imageProxy';
import { usePreparedImageSource } from '../utils/usePreparedImageSource';
import { isImageSourceReady, warmImageSources } from '../utils/imageWarmCache';
import { recordProfilerRender } from '../utils/perfTelemetry';

interface ImageCanvasElementProps {
  element: ImageElement;
  zoom: number;
  isInteracting?: boolean;
  croppingState: { elementId: string; originalElement: ImageElement; cropBox: Rect } | null;
}

const ImageCanvasElement: React.FC<ImageCanvasElementProps> = ({
  element,
  zoom,
  isInteracting = false,
  croppingState,
}) => {
  const clipPath = element.borderRadius && element.borderRadius > 0 ? `url(#clip-${element.id})` : undefined;
  const desiredImage = useImageLOD(element.id, {
    zoom,
    // 原图准入按"屏幕像素"判定，所以必须把世界尺寸交给 LOD 层。
    width: element.width,
    height: element.height,
    isInteracting,
    href: element.href,
    thumbnailHref: element.thumbnailHref,
    mediumHref: element.mediumHref,
    originalHref: element.originalHref,
    originalPixelWidth: element.originalPixelWidth,
    originalPixelHeight: element.originalPixelHeight,
  });
  // Target LOD can change for many equal-width cards at once. Prepare sources
  // through a shared bounded queue, retaining the previous image until ready.
  const { src: imageSource, tier: imageLodTier, loadState } = usePreparedImageSource({
    elementId: element.id,
    baseSrc: element.href,
    desired: desiredImage,
    fallback: element.thumbnailHref
      ? { src: element.thumbnailHref, tier: 'thumbnail' }
      : { src: element.href, tier: 'standard' },
  });
  // 采样模式来自与 memo 共用的判定（见 resolveImageRenderRequirement），
  // 不再就地写 zoom 比较 —— 否则 memo 漏掉这个变化时样式会永远停在旧值。
  const { samplingMode } = resolveImageRenderRequirement({
    width: element.width,
    height: element.height,
    zoom,
    hasThumbnail: Boolean(element.thumbnailHref),
    hasMedium: Boolean(element.mediumHref),
    hasOriginal: Boolean(element.originalHref),
    isInteracting,
  });
  const [revealed, setRevealed] = useState(() => isImageSourceReady(imageSource));
  const imageNodeRef = useRef<SVGImageElement | null>(null);
  const dimmed = Boolean(croppingState && croppingState.elementId !== element.id);
  const paintedOpacity = dimmed ? 0.3 * (element.opacity ?? 1) : (element.opacity ?? 1);

  useEffect(() => () => {
    // Only keep an actual thumbnail warm across cull/remount. Standard/full-size
    // sources are handled by the bounded preparation queue, not a second decoded cache.
    if (imageLodTier === 'thumbnail' && imageSource !== element.originalHref) {
      warmImageSources([imageSource]);
    }
  }, [imageSource, imageLodTier, element.originalHref]);

  useLayoutEffect(() => {
    if (revealed) return;
    const node = imageNodeRef.current;
    if (!node) return;
    const show = () => setRevealed(true);
    if (isImageSourceReady(imageSource)) {
      const frame = requestAnimationFrame(show);
      return () => cancelAnimationFrame(frame);
    }
    node.addEventListener('load', show);
    node.addEventListener('error', show);
    return () => {
      node.removeEventListener('load', show);
      node.removeEventListener('error', show);
    };
  }, [imageSource, revealed]);

  return (
    <image
      ref={imageNodeRef}
      x={element.x}
      y={element.y}
      href={imageSource}
      data-element-id={element.id}
      data-lod-tier={imageLodTier}
      data-image-load-state={loadState}
      data-image-target-tier={desiredImage.tier}
      width={element.width}
      height={element.height}
      clipPath={clipPath}
      style={{
        imageRendering: samplingMode,
        opacity: revealed ? paintedOpacity : 0,
      }}
    />
  );
};

interface CanvasElementProps {
  element: Element;
  elements: Element[];
  selectedElementIds: string[];
  zoom: number;
  editingElement: { id: string; text: string } | null;
  croppingState: { elementId: string; originalElement: ImageElement; cropBox: Rect } | null;
  aiRotationState: AIRotationState | null;
  setEditingElement: (val: { id: string; text: string } | null) => void;
  isInteracting?: boolean;
}

const CanvasElementBase: React.FC<CanvasElementProps> = ({
  element,
  elements,
  selectedElementIds,
  zoom,
  editingElement,
  croppingState,
  aiRotationState,
  setEditingElement,
  isInteracting = false,
}) => {
  const bounds = getElementBounds(element, elements);
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const rotation = 'rotation' in element && element.rotation ? element.rotation : 0;
  const transform = rotation !== 0 ? `rotate(${rotation} ${center.x} ${center.y})` : '';
  const isSelected = selectedElementIds.includes(element.id);

  const renderContent = () => {
    switch (element.type) {
      case 'path': {
        const pathData = element.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
        return (
          <path
            d={pathData}
            stroke={element.strokeColor}
            strokeWidth={element.strokeWidth}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="stroke"
            strokeOpacity={element.opacity ?? 1}
          />
        );
      }
      case 'arrow': {
        const [start, end] = element.points;
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const headLength = element.strokeWidth * 4;
        const arrowHeadHeight = headLength * Math.cos(Math.PI / 6);
        const lineEnd = {
          x: end.x - arrowHeadHeight * Math.cos(angle),
          y: end.y - arrowHeadHeight * Math.sin(angle),
        };
        const headPoint1 = {
          x: end.x - headLength * Math.cos(angle - Math.PI / 6),
          y: end.y - headLength * Math.sin(angle - Math.PI / 6),
        };
        const headPoint2 = {
          x: end.x - headLength * Math.cos(angle + Math.PI / 6),
          y: end.y - headLength * Math.sin(angle + Math.PI / 6),
        };
        return (
          <g>
            <line x1={start.x} y1={start.y} x2={lineEnd.x} y2={lineEnd.y} stroke={element.strokeColor} strokeWidth={element.strokeWidth} strokeLinecap="round" />
            <polygon points={`${end.x},${end.y} ${headPoint1.x},${headPoint1.y} ${headPoint2.x},${headPoint2.y}`} fill={element.strokeColor} />
          </g>
        );
      }
      case 'line': {
        const [start, end] = element.points;
        return <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={element.strokeColor} strokeWidth={element.strokeWidth} strokeLinecap="round" />;
      }
      case 'text': {
        const isEditing = editingElement?.id === element.id;
        return !isEditing ? (
          <foreignObject x={element.x} y={element.y} width={element.width} height={element.height} style={{ overflow: 'visible' }}>
            <div style={{ fontSize: element.fontSize, color: element.fontColor, width: '100%', height: '100%', wordBreak: 'break-word' }}>
              {element.text}
            </div>
          </foreignObject>
        ) : null;
      }
      case 'shape': {
        let shapeJsx;
        if (element.shapeType === 'rectangle') shapeJsx = <rect width={element.width} height={element.height} rx={element.borderRadius} ry={element.borderRadius} />;
        else if (element.shapeType === 'circle') shapeJsx = <ellipse cx={element.width / 2} cy={element.height / 2} rx={element.width / 2} ry={element.height / 2} />;
        else if (element.shapeType === 'triangle') shapeJsx = <polygon points={`${element.width / 2},0 0,${element.height} ${element.width},${element.height}`} />;
        return (
          <g transform={`translate(${element.x}, ${element.y})`} opacity={element.opacity ?? 1}>
            {shapeJsx &&
              React.cloneElement(shapeJsx as React.ReactElement<any>, {
                fill: element.fillColor,
                stroke: element.strokeColor,
                strokeWidth: element.strokeWidth,
                strokeDasharray: element.strokeDashArray ? element.strokeDashArray.join(' ') : 'none',
              })}
          </g>
        );
      }
      case 'image': {
        return (
          <ImageCanvasElement
            element={element}
            zoom={zoom}
            isInteracting={isInteracting}
            croppingState={croppingState}
          />
        );
      }
      case 'frame': {
        const isEditing = editingElement?.id === element.id;
        return (
          <>
            <rect
              x={element.x}
              y={element.y}
              width={element.width}
              height={element.height}
              fill={element.backgroundColor || 'rgba(100,100,100,0.1)'}
              stroke="rgba(255, 255, 255, 0.5)"
              strokeWidth={2 / zoom}
              strokeDasharray={`${8 / zoom} ${4 / zoom}`}
              pointerEvents="all"
            />
            {!isEditing && (
              <text
                x={element.x + 8 / zoom}
                y={element.y - 8 / zoom}
                fill="white"
                fontSize={16 / zoom}
                onDoubleClick={e => {
                  e.stopPropagation();
                  setEditingElement({ id: element.id, text: element.name! });
                }}
                className="cursor-pointer select-none"
              >
                {element.name}
              </text>
            )}
          </>
        );
      }
      default: {
        // Declarative extension nodes (ext.*): generic schema card, placeholder when the package is absent/disabled.
        if (element.type.startsWith('ext.') && ('width' in element) && ('height' in element)) {
          return (
            <foreignObject x={element.x} y={element.y} width={element.width} height={element.height} style={{ overflow: 'visible' }}>
              <ExtensionNodeCard element={element} isSelected={isSelected} />
            </foreignObject>
          );
        }
        // Cards are materialized once at renderer bootstrap. Plugin card types must not require a core switch case.
        const registeredCard = getMaterializedCardComponent(element.type);
        const pluginNodeCard = registeredCard
          ? undefined
          : element.type === 'plugin-node' && 'nodeType' in element
            ? getMaterializedCardComponent(String((element as { nodeType?: unknown }).nodeType ?? ''))
            : undefined;
        const CardComponent = registeredCard ?? pluginNodeCard;
        if (!('width' in element) || !('height' in element)) return null;
        if (!CardComponent) {
          // Host-owned recovery UI: never rewrite the node or expose plugin payloads/URLs.
          const missingType = element.type === 'plugin-node' && 'nodeType' in element
            ? String(element.nodeType ?? element.type)
            : element.type;
          return (
            <foreignObject x={element.x} y={element.y} width={element.width} height={element.height}>
              <div
                data-card-missing={missingType}
                role="status"
                style={{ width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden', padding: 12,
                  border: `2px dashed ${isSelected ? '#8b5cf6' : '#71717a'}`, borderRadius: 8,
                  background: '#18181b', color: '#e4e4e7', fontFamily: 'system-ui, sans-serif' }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  卡片组件未启用 / Card unavailable
                </div>
                <div style={{ fontSize: 11, marginTop: 6, overflowWrap: 'anywhere' }}>{missingType}</div>
                <div style={{ fontSize: 11, marginTop: 6, color: '#a1a1aa' }}>
                  数据已保留，请在插件管理中启用对应插件。
                </div>
              </div>
            </foreignObject>
          );
        }
        // 出错定位用：物化表里记着该 node type 的归属插件（命中 registeredCard 时就是 element.type，
        // plugin-node 走内层 nodeType）。
        const cardNodeType = registeredCard
          ? element.type
          : String((element as { nodeType?: unknown }).nodeType ?? element.type);
        return (
          <foreignObject x={element.x} y={element.y} width={element.width} height={element.height} style={{ overflow: 'visible' }}>
            {/* 局部错误边界，且必须在 Suspense 外层：插件卡片渲染期抛错、或 lazy 加载失败被 Suspense
                重新抛出，都只把这一张卡降级为占位（含 pluginId），画布其余元素与未保存编辑不受影响。 */}
            <PluginErrorBoundary
              slot="canvas_node_types"
              pluginId={getMaterializedCardPluginId(cardNodeType)}
              label={cardNodeType}
              fill
            >
              <React.Suspense fallback={(
                <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#a3a3a3', background: '#171717' }}>
                  Loading card…
                </div>
              )}>
                <CardComponent element={element} isSelected={isSelected} croppingState={croppingState} />
              </React.Suspense>
            </PluginErrorBoundary>
          </foreignObject>
        );
      }
    }
  };

  // 性能遥测：按控件实例（el:<type>:<elementId>）聚合渲染耗时（builtin/perf-monitor 排行榜
  // 支持"类型归并 / 实例"双视图）。普通 production 下 actualDuration 恒为 0，采集层自动忽略；
  // dev / profiling 构建（vite production alias react-dom/client → react-dom/profiling）下有值。
  return (
    <Profiler id={`el:${element.type}:${element.id}`} onRender={recordProfilerRender}>
      <g
        data-id={element.id}
        data-cull-x={bounds.x}
        data-cull-y={bounds.y}
        data-cull-w={bounds.width}
        data-cull-h={bounds.height}
        transform={transform}
        // Hundreds of cards can be selected after a drop. Promoting each SVG <g>
        // creates hundreds of compositor layers; only a single selection needs the hint.
        style={{ willChange: isSelected && selectedElementIds.length === 1 ? 'transform' : 'auto' }}
      >
        {renderContent()}
      </g>
    </Profiler>
  );
};

export const CanvasElement = React.memo(CanvasElementBase, (prev, next) => {
    // 性能优化核心：
    // 1. 绝对不比较 elements 数组。拖动 A 元素导致 elements 数组引用变化，不应触发 B 元素的重绘。
    // 2. 仅比较与当前 element 相关的核心属性。
    
    // 如果元素本身的对象引用变了，肯定要重绘 (Immutability pattern)
    if (prev.element !== next.element) return false;

    // 选中状态改变必须重绘
    const wasSelected = prev.selectedElementIds.includes(prev.element.id);
    const isSelected = next.selectedElementIds.includes(next.element.id);
    if (wasSelected !== isSelected) return false;
    // Removing compositor hints after a single selection expands to a batch
    // requires one update even if this particular card remains selected.
    if (wasSelected && isSelected && (prev.selectedElementIds.length === 1) !== (next.selectedElementIds.length === 1)) return false;

    // 编辑状态改变必须重绘
    const wasEditing = prev.editingElement?.id === prev.element.id;
    const isEditing = next.editingElement?.id === next.element.id;
    if (wasEditing !== isEditing) return false;
    
    // 如果正在编辑文本，且文本内容变了
    if (isEditing && prev.editingElement?.text !== next.editingElement?.text) return false;

    // 裁剪状态改变必须重绘 (用于透明度处理)
    if (prev.croppingState !== next.croppingState) return false;

    // AI 旋转状态
    if (prev.aiRotationState !== next.aiRotationState) return false;

    // 交互状态改变必须重绘（用于切换高清/压缩图）
    // 仅针对有高清图或缩略图的图片元素
    if (prev.element.type === 'image' && (prev.element.originalHref || prev.element.thumbnailHref)) {
        if (prev.isInteracting !== next.isInteracting) return false;
    }

    // Zoom 改变逻辑优化：
    // 普通图片拖动缩放时不应该因为 zoom 变化重绘 —— 除非"渲染需求"真的变了。
    //
    // 判定共用 resolveImageRenderRequirement 这一个纯函数，且它无历史状态，
    // 所以 memo 与 useImageLOD 内部算出的结果**必然一致**。这是硬要求：
    // 一旦两边口径不同（比如 hook 里有滞回而 memo 没有），memo 就会把
    // hook 真正需要的那次重绘拦掉（曾实测：滞回窗口内的升档被永久卡住）。
    //
    // 判定必须覆盖三个字段，缺一个都会漏掉真实变化：
    // desiredTier（换 LOD）、eligibleForOriginal（含 zoom > 1.0 的准入条件）、
    // samplingMode（imageRendering 取值）。
    if (prev.element.type === 'image' && next.element.type === 'image') {
        const prevElement = prev.element;
        const nextElement = next.element;
        const prevRequirement = resolveImageRenderRequirement({
            width: prevElement.width,
            height: prevElement.height,
            zoom: prev.zoom,
            hasThumbnail: Boolean(prevElement.thumbnailHref),
            hasMedium: Boolean(prevElement.mediumHref),
            hasOriginal: Boolean(prevElement.originalHref),
            isInteracting: prev.isInteracting,
        });
        const nextRequirement = resolveImageRenderRequirement({
            width: nextElement.width,
            height: nextElement.height,
            zoom: next.zoom,
            hasThumbnail: Boolean(nextElement.thumbnailHref),
            hasMedium: Boolean(nextElement.mediumHref),
            hasOriginal: Boolean(nextElement.originalHref),
            isInteracting: next.isInteracting,
        });
        if (!isSameImageRenderRequirement(prevRequirement, nextRequirement)) return false;
    }

    // 大部分元素（图片、形状）的 SVG 属性不依赖 zoom 计算（strokeWidth 除外，但如果不缩放描边可以忽略）。
    // 但是，Frame 元素的文字大小和描边 dasharray 依赖 zoom。
    // Path 元素的 strokeWidth 如果是固定像素视觉，也依赖 zoom。
    // 目前代码中 Frame 的 strokeWidth = 2/zoom。
    if (prev.element.type === 'frame' || prev.element.type === 'path' || prev.element.type === 'shape' || prev.element.type === 'arrow' || prev.element.type === 'line') {
        if (prev.zoom !== next.zoom) return false;
    }

    return true;
});
