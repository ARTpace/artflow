/**
 * Typed contract and pure dispatch for the `format_handlers` contribution slot.
 * ponytail: this layer owns matching/order only; parser implementations stay in trusted builtin plugins.
 */

import type { Contribution, Kernel } from './kernel';

export type FormatHandlerCategory = 'image' | 'audio' | 'video' | 'document' | 'scene';

export interface FormatImageResult {
  kind: 'image';
  name: string;
  width: number;
  height: number;
  dataUrl: string;
  thumbnailDataUrl?: string;
  mediumDataUrl?: string;
  originalDataUrl?: string;
  mimeType: string;
}

export interface FormatAudioResult {
  kind: 'audio';
  name: string;
  width: number;
  height: number;
  dataUrl: string;
  mimeType: string;
  duration?: number;
}

/**
 * Runtime locator (blob: in managed Electron storage) or self-contained dataURL (browser JSON docs).
 * Must stay opaque here: materialization knows how to persist both forms.
 */
export interface FormatVideoResult {
  kind: 'video';
  name: string;
  width: number;
  height: number;
  dataUrl: string;
  mimeType: string;
  fileSize?: number;
}

/** Bounded, plain content emitted by a reader-format plugin; it carries no executable markup. */
export interface FormatReaderResult {
  kind: 'reader';
  title: string;
  content: string;
  sourceFormat: 'text' | 'html' | 'epub' | 'mobi' | 'azw' | 'azw3';
  characterCount: number;
  isTruncated: boolean;
  /** UTF-16 offsets into `content`. Absent for a single undifferentiated text. */
  chapters?: readonly { title: string; start: number }[];
}

/** Bounded page payload emitted by a comic-format plugin; archive parsing remains plugin-local. */
export interface FormatComicResult {
  kind: 'comic';
  title: string;
  sourceFormat: 'cbz' | 'cbr' | 'cb7' | '7z';
  /** 新版懒加载：主进程档案仓引用 + 自然排序页名清单，页图按需拉取。 */
  archiveRef?: string;
  pageNames?: string[];
  /** 旧版全量 data URL（存量资产库/夹具兼容保留）。 */
  pages?: string[];
}

export interface PsdLayerResult {
  id: string;
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number;
  hidden: boolean;
  dataUrl: string;
}

/** Shared contract, intentionally independent of the PSD parser implementation. */
export interface PsdParseResult {
  fileName: string;
  width: number;
  height: number;
  compositeDataUrl: string;
  layers: readonly PsdLayerResult[];
  hasMultipleLayers: boolean;
}

/**
 * A format plugin describes a canvas card without inventing a new element union member.
 * Known cardType values (markdown, code, bookmark, font, model3d, file) reuse those elements.
 * Any other cardType is placed as plugin-node and rendered by the registered nodeType card.
 */
export interface FormatCardResult {
  kind: 'card';
  cardType: string;
  name: string;
  width: number;
  height: number;
  fields: Record<string, unknown>;
}

/** One `.pur` (or similar) file becomes many canvas elements. x/y are top-left. */
export type FormatSceneItem =
  | {
      kind: 'image';
      name: string;
      x: number;
      y: number;
      width: number;
      height: number;
      rotation?: number;
      dataUrl: string;
      mimeType: string;
    }
  | {
      kind: 'text';
      name: string;
      x: number;
      y: number;
      width: number;
      height: number;
      rotation?: number;
      text: string;
      fontSize: number;
      fontColor: string;
    };

export interface FormatSceneResult {
  kind: 'scene';
  items: readonly FormatSceneItem[];
  /** Shown after import when positions, notes, or linked images were only partly recovered. */
  notice?: string;
}

export type FormatParseResult =
  | FormatImageResult
  | FormatAudioResult
  | FormatVideoResult
  | FormatReaderResult
  | FormatComicResult
  | FormatCardResult
  | FormatSceneResult
  | { kind: 'image-pages'; pages: readonly FormatImageResult[] }
  | { kind: 'psd'; psd: PsdParseResult };

const KNOWN_CARD_TYPES = new Set(['markdown', 'code', 'bookmark', 'font', 'model3d', 'file']);

/** Turns a plugin card payload into the importer's loaded-item shape. */
export function loadedItemFromCard(card: FormatCardResult): {
  type: string;
  name: string;
  width: number;
  height: number;
  nodeType?: string;
  data?: Record<string, unknown>;
} & Record<string, unknown> {
  if (KNOWN_CARD_TYPES.has(card.cardType)) {
    return {
      type: card.cardType,
      name: card.name,
      width: card.width,
      height: card.height,
      ...card.fields,
    };
  }
  const declared = card.fields.nodeType;
  const nodeType = typeof declared === 'string' && declared.length > 0 ? declared : card.cardType;
  return {
    type: 'plugin-node',
    nodeType,
    name: card.name,
    width: card.width,
    height: card.height,
    data: card.fields,
  };
}

const formatAliases = new Map<string, string>();

/** Declarative external manifests may point an unused extension at an already registered handler. */
export function registerFormatAlias(extension: string, handlerId: string): void {
  const ext = extension.trim().toLowerCase();
  if (!/^[a-z0-9]{1,16}$/.test(ext)) return;
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(handlerId)) return;
  formatAliases.set(ext, handlerId);
}

export interface FormatHandler {
  /** Global contribution id: `<namespace>.<name>`. */
  id: string;
  extensions: readonly string[];
  /** Lets a generic importer choose its existing UI flow before parsing (e.g. PSD modal). */
  outputKind: FormatParseResult['kind'];
  category: FormatHandlerCategory;
  mimeTypes?: readonly string[];
  parse(file: File): Promise<FormatParseResult>;
}

export type FormatHandlerContribution = Contribution<FormatHandler>;

const normalizedExtension = (file: Pick<File, 'name'>): string => {
  const lastDot = file.name.lastIndexOf('.');
  return lastDot < 0 ? '' : file.name.slice(lastDot + 1).toLowerCase();
};

const matches = (handler: FormatHandler, file: Pick<File, 'name' | 'type'>): boolean => {
  const extension = normalizedExtension(file);
  if (extension && handler.extensions.some(candidate => candidate.toLowerCase() === extension)) return true;
  const mimeType = file.type.toLowerCase();
  return Boolean(mimeType && handler.mimeTypes?.some(candidate => candidate.toLowerCase() === mimeType));
};

/** All matching handlers in stable registry order. This is the future conflict-visibility data source. */
export function getFormatHandlerCandidates(kernel: Kernel, file: Pick<File, 'name' | 'type'>): readonly FormatHandlerContribution[] {
  return kernel.contributions
    .list<FormatHandler>('format_handlers')
    .filter(contribution => matches(contribution.value, file));
}

/**
 * Priority (registry sort) and id tie-break choose exactly one handler.
 * A third-party video handler may take over the builtin one by registering a higher priority.
 * User binding is intentionally a P4 concern.
 */
export function resolveFormatHandler(kernel: Kernel, file: Pick<File, 'name' | 'type'>): FormatHandlerContribution | undefined {
  const direct = getFormatHandlerCandidates(kernel, file)[0];
  if (direct) return direct;
  const extension = normalizedExtension(file);
  const handlerId = extension ? formatAliases.get(extension) : undefined;
  if (!handlerId) return undefined;
  return kernel.contributions
    .list<FormatHandler>('format_handlers')
    .find(contribution => contribution.value.id === handlerId);
}

export async function parseWithFormatHandler(kernel: Kernel, file: File): Promise<FormatParseResult | null> {
  const selected = resolveFormatHandler(kernel, file);
  return selected ? selected.value.parse(file) : null;
}
