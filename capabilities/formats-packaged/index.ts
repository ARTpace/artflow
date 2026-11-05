/** MOBI/AZW/AZW3 reader and CBR/CB7/7Z comic handlers. Cards stay with the book and comic plugins. */

import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import type { FormatHandler } from '../../plugin-runtime/format-handlers';
import { bindFormatLimitConfig } from '../../plugin-runtime/format-limits';
import manifest from './manifest.json';
import { parsePalmFile } from './palmDoc';
import { parsePackedComicFile } from './packedArchive';

const palmHandler: FormatHandler = {
  id: 'builtin.format-palm-reader',
  extensions: ['mobi', 'azw', 'azw3'],
  outputKind: 'reader',
  category: 'document',
  parse: parsePalmFile,
};

const packedComicHandler: FormatHandler = {
  id: 'builtin.format-packed-comic',
  extensions: ['cbr', 'cb7', '7z'],
  outputKind: 'comic',
  category: 'document',
  parse: parsePackedComicFile,
};

export const formatsPackagedPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    // 把 maxPalmMiB / maxComicMiB 接成解析器的阈值来源（详见 plugins/format-limits.ts）。
    const unbindLimits = bindFormatLimitConfig(ctx);
    const disposePalm = ctx.contributions.register<FormatHandler>('format_handlers', {
      id: palmHandler.id,
      pluginId: 'builtin.formats-packaged',
      priority: 80,
      value: palmHandler,
    });
    const disposeComic = ctx.contributions.register<FormatHandler>('format_handlers', {
      id: packedComicHandler.id,
      pluginId: 'builtin.formats-packaged',
      priority: 80,
      value: packedComicHandler,
    });
    return () => {
      disposeComic();
      disposePalm();
      unbindLimits();
    };
  },
});
