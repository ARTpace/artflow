/**
 * builtin/cards/index.tsx —— 画布卡片界面。
 * 格式插件只把文件解析成一种 nodeType；这里登记对应的卡片组件。
 * CanvasElement 渲染时从注册表查组件。第三方卡片走同一插槽（{ nodeType, component }）。
 */

import React from 'react';
import type { BuiltinPluginModule } from '../../plugin-runtime/loader';
import filesManifest from './manifest.json';
import mediaManifest from './media.manifest.json';
import readerManifest from './reader.manifest.json';
import type { CanvasCardContribution } from '../../plugin-runtime/card-contributions';

// Keep heavyweight card implementations out of the startup bundle. A card chunk is
// requested only when that node type is actually visible on the canvas.
const BookmarkCanvasCard = React.lazy(() => import('../../components/cards/BookmarkCanvasCard')
  .then(module => ({ default: module.BookmarkCanvasCard })));
const CodeCanvasCard = React.lazy(() => import('../../components/cards/CodeCanvasCard')
  .then(module => ({ default: module.CodeCanvasCard })));
const FontCanvasCard = React.lazy(() => import('../../components/cards/FontCanvasCard')
  .then(module => ({ default: module.FontCanvasCard })));
const MarkdownCanvasCard = React.lazy(() => import('../../components/cards/MarkdownCanvasCard')
  .then(module => ({ default: module.MarkdownCanvasCard })));
const Model3DCanvasCard = React.lazy(() => import('../../components/cards/Model3DCanvasCard')
  .then(module => ({ default: module.Model3DCanvasCard })));
const UniversalFileCanvasCard = React.lazy(() => import('../../components/cards/UniversalFileCanvasCard')
  .then(module => ({ default: module.UniversalFileCanvasCard })));
const ComicCanvasCard = React.lazy(() => import('../../capabilities/formats-comic/ComicCanvasCard')
  .then(module => ({ default: module.ComicCanvasCard })));
const ReaderCanvasCard = React.lazy(() => import('../../capabilities/formats-book/ReaderCanvasCard')
  .then(module => ({ default: module.ReaderCanvasCard })));
const VideoCanvasCard = React.lazy(() => import('../../components/cards/VideoCanvasCard')
  .then(module => ({ default: module.VideoCanvasCard })));
const AudioCanvasCard = React.lazy(() => import('../../components/cards/AudioCanvasCard')
  .then(module => ({ default: module.AudioCanvasCard })));

/** Legacy local alias retained for existing builtin-card callers; shared contract lives in plugins/. */
export type CardContributionValue = CanvasCardContribution;

type CardEntry = [string, CardContributionValue['component']];

function cardPlugin(manifest: { id: string }, cards: CardEntry[]): BuiltinPluginModule {
  return {
    manifest,
    activate(ctx) {
      const disposers = cards.map(([nodeType, component]) =>
        ctx.contributions.register<CardContributionValue>('canvas_node_types', {
          id: `builtin.card-${nodeType}`,
          pluginId: manifest.id,
          value: { nodeType, component },
        }),
      );
      return () => disposers.reverse().forEach(dispose => dispose());
    },
  };
}

/** Independent optional renderers. Their shared protocol and missing-card fallback belong to the host. */
export const CARD_PLUGINS: BuiltinPluginModule[] = [
  cardPlugin(filesManifest, [
    ['bookmark', BookmarkCanvasCard],
    ['code', CodeCanvasCard],
    ['font', FontCanvasCard],
    ['markdown', MarkdownCanvasCard],
    ['model3d', Model3DCanvasCard],
    ['file', UniversalFileCanvasCard],
  ]),
  cardPlugin(mediaManifest, [
    ['video', VideoCanvasCard],
    ['audio', AudioCanvasCard],
  ]),
  cardPlugin(readerManifest, [
    ['comic', ComicCanvasCard],
    ['reader', ReaderCanvasCard],
  ]),
];
