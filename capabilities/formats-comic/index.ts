/** CBZ parsing only. The comic page card is registered by builtin.cards. */

import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import type { FormatHandler } from '../../plugin-runtime/format-handlers';
import manifest from './manifest.json';
import { parseComicFile } from './comicParser';

const comicHandler: FormatHandler = {
  id: 'builtin.format-cbz-comic',
  // Extension-only on purpose: generic .zip must retain its existing FileCard path.
  extensions: ['cbz'],
  outputKind: 'comic',
  category: 'document',
  parse: parseComicFile,
};

export const formatsComicPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    return ctx.contributions.register<FormatHandler>('format_handlers', {
      id: comicHandler.id,
      pluginId: 'builtin.formats-comic',
      priority: 95,
      value: comicHandler,
    });
  },
});
