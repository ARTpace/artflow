/** TXT/HTML/EPUB parsing only. The reader card is registered by builtin.cards. */

import type { Effect, Kernel } from '../../plugin-runtime/kernel';
import { definePlugin } from '../../plugin-runtime/define-plugin';
import type { FormatHandler } from '../../plugin-runtime/format-handlers';
import { bindFormatLimitConfig } from '../../plugin-runtime/format-limits';
import manifest from './manifest.json';
import { parseBookFile } from './bookParser';
import { parseEpubFile } from './epubParser';

const bookHandler: FormatHandler = {
  id: 'builtin.format-book-reader',
  // EPUB is extension-only on purpose: generic .zip must retain its existing FileCard route.
  extensions: ['txt', 'text', 'html', 'htm', 'epub'],
  mimeTypes: ['text/plain', 'text/html'],
  outputKind: 'reader',
  category: 'document',
  parse: file => file.name.toLowerCase().endsWith('.epub') ? parseEpubFile(file) : parseBookFile(file),
};

export const formatsBookPlugin = definePlugin({
  manifest,
  activate(ctx: Kernel): Effect {
    // 把 maxTextMiB / maxEpubMiB 接成解析器的阈值来源（详见 plugins/format-limits.ts）。
    const unbindLimits = bindFormatLimitConfig(ctx);
    const effect = ctx.contributions.register<FormatHandler>('format_handlers', {
      id: bookHandler.id,
      pluginId: 'builtin.formats-book',
      priority: 90,
      value: bookHandler,
    });
    return () => {
      effect();
      unbindLimits();
    };
  },
});
