/**
 * PureRef `.pur` reader.
 *
 * 2.x：文件体是一个 SQLite 场景数据库镜像（见 purSqlite.ts），直接读库拿原图 BLOB 和
 * 每张图的 QTransform，位置/尺寸都是原始值。
 * 1.x：走公开的 transform 布局（PNG 块 + 以中心点定位的 item）。
 * 两条路都失败时才退回「扫内嵌图片按网格铺开」，并在 notice 里说明丢了什么。
 */

import { FORMAT_LIMITS, limitBytes, limitMessage } from '../../plugin-runtime/format-limits';
import { readPurDatabase } from './purSqlite';

/**
 * 源文件上限（可调）：插件参数 `maxPurMiB`。旧值写死 64 MiB，且**报错文案里
 * 又硬编码了一遍「64MB」** —— 数值散落两处是迟早会对不上的（阈值一改文案就骗人）。
 * 现在数值只来自 plugins/format-limits.ts，文案由 limitMessage 按实际生效值生成。
 * 以下 MAX_IMAGES / MAX_IMAGE_BYTES / MAX_NOTES 原本是"内存闸门"（80 张图 / 单图 8 MiB），
 * 对真实参考图场景过于苛刻：一块分镜板动辄上百张图，单张 4K PNG 就超过 8 MiB。
 * 现已按实际量级放宽，只保留"防止畸形文件把进程撑爆"的兜底量级，不再作为业务限制。
 */
const purLimitBytes = () => limitBytes(FORMAT_LIMITS.purFileMiB);
const MAX_IMAGES = 5000;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_NOTES = 1000;
const MAX_NOTE_CHARS = 20000;
const HEADER_BYTES = 224;
const GRAPHICS_IMAGE_ITEM = 34;
const GRAPHICS_TEXT_ITEM = 32;

const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_FOOT = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export interface PurSceneItem {
  kind: 'image' | 'text';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  bytes?: Uint8Array;
  mimeType?: string;
  text?: string;
  fontSize?: number;
  fontColor?: string;
}

export interface PurScene {
  items: PurSceneItem[];
  notice?: string;
  structured: boolean;
}

class PurReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurReadError';
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const indexOfBytes = (hay: Uint8Array, needle: Uint8Array, from: number): number => {
  const last = hay.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
};

const readU32 = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);

/**
 * 读文件头的版本串。
 *
 * .pur 用 QDataStream 序列化 QString：`uint32 大端字节长度 + UTF-16BE 数据`。
 * 长度字段是**字节数**而非字符数，实测官方 2.1 文件写 6（"2.1" 三字符，不含终止符），
 * 而带终止符的写法会写 8。历史实现把 `readU32(bytes, 0) !== 8` 写死，
 * 于是所有长度 6 的真实文件都被判成"不是 PureRef 文件"。
 * 现在按长度字段动态解，再用「必须纯数字点号」校验，兼容同族任意版本号写法。
 */
const readVersionString = (bytes: Uint8Array): string | undefined => {
  if (bytes.length < 16) return undefined;
  const byteLength = readU32(bytes, 0);
  if (byteLength < 2 || byteLength > 64 || byteLength % 2 !== 0) return undefined;
  if (bytes.length < 4 + byteLength) return undefined;
  let text = '';
  for (let i = 4; i < 4 + byteLength; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    if (code === 0) break;
    if (code < 32 || code > 126) return undefined;
    text += String.fromCharCode(code);
  }
  return /^\d+(\.\d+)*$/.test(text) ? text : undefined;
};

const majorVersion = (bytes: Uint8Array): number => {
  const text = readVersionString(bytes);
  if (!text) return 0;
  if (text.startsWith('2')) return 2;
  if (text.startsWith('1')) return 1;
  return 0;
};

const pngSize = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  if (bytes.length < 24 || indexOfBytes(bytes, PNG_HEAD, 0) !== 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width < 1 || height < 1 || width > 16000 || height > 16000) return undefined;
  return { width, height };
};

const jpegSize = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2, false);
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xc2) {
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      if (width < 1 || height < 1 || width > 16000 || height > 16000) return undefined;
      return { width, height };
    }
    offset += 2 + length;
  }
  return undefined;
};

const rotationOf = (matrix: readonly number[]): number => {
  const degrees = Math.atan2(matrix[2], matrix[0]) * 180 / Math.PI;
  if (!Number.isFinite(degrees) || Math.abs(degrees) < 0.5) return 0;
  return Math.round(degrees * 10) / 10;
};

const cssColor = (rgb: readonly number[]): string => {
  const hex = (channel: number) => clamp(Math.round(channel / 65535 * 255), 0, 255).toString(16).padStart(2, '0');
  return `#${hex(rgb[0] ?? 0)}${hex(rgb[1] ?? 0)}${hex(rgb[2] ?? 0)}`;
};

const hsvToRgb = (hsv: readonly number[]): number[] => {
  const h = ((hsv[0] ?? 0) / 35900) % 1;
  const s = clamp((hsv[1] ?? 0) / 65535, 0, 1);
  const v = clamp((hsv[2] ?? 0) / 65535, 0, 1);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const table = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ];
  const [r, g, b] = table[i % 6];
  return [Math.round(r * 65535), Math.round(g * 65535), Math.round(b * 65535)];
};

interface ImageTransform {
  id: number;
  name: string;
  x: number;
  y: number;
  zLayer: number;
  matrix: number[];
  pointsX: number[];
  pointsY: number[];
  children: TextTransform[];
}

interface TextTransform {
  x: number;
  y: number;
  zLayer: number;
  matrix: number[];
  text: string;
  rgb: number[];
  children: TextTransform[];
}

interface StoredImage {
  addressStart: number;
  png: Uint8Array;
  transforms: ImageTransform[];
}

class PurCursor {
  pos = 0;

  constructor(private readonly bytes: Uint8Array, private readonly view: DataView) {}

  private need(offset: number, size: number): void {
    if (offset < 0 || this.pos + offset + size > this.bytes.length) throw new PurReadError('truncated');
  }

  u32(rel = 0): number {
    this.need(rel, 4);
    return this.view.getUint32(this.pos + rel, false);
  }

  i32(rel = 0): number {
    this.need(rel, 4);
    return this.view.getInt32(this.pos + rel, false);
  }

  u16(rel = 0): number {
    this.need(rel, 2);
    return this.view.getUint16(this.pos + rel, false);
  }

  i8(rel = 0): number {
    this.need(rel, 1);
    return this.view.getInt8(this.pos + rel);
  }

  f64(rel = 0): number {
    this.need(rel, 8);
    return this.view.getFloat64(this.pos + rel, false);
  }

  u64(rel = 0): number {
    this.need(rel, 8);
    return this.view.getUint32(this.pos + rel, false) * 0x100000000 + this.view.getUint32(this.pos + rel + 4, false);
  }

  erase(length: number): void {
    if (length < 0 || this.pos + length > this.bytes.length) throw new PurReadError('erase');
    this.pos += length;
  }

  takeU32(): number {
    const value = this.u32(0);
    this.erase(4);
    return value;
  }

  takeI32(): number {
    const value = this.i32(0);
    this.erase(4);
    return value;
  }

  takeU16(): number {
    const value = this.u16(0);
    this.erase(2);
    return value;
  }

  takeI8(): number {
    const value = this.i8(0);
    this.erase(1);
    return value;
  }

  takeF64(): number {
    const value = this.f64(0);
    this.erase(8);
    return value;
  }

  find(needle: Uint8Array, fromRel = 0): number {
    const absolute = indexOfBytes(this.bytes, needle, this.pos + fromRel);
    return absolute < 0 ? -1 : absolute - this.pos;
  }

  slice(startRel: number, endRel: number): Uint8Array {
    this.need(startRel, endRel - startRel);
    return this.bytes.subarray(this.pos + startRel, this.pos + endRel);
  }

  string(): string {
    const length = this.takeU32();
    if (length > 65536) throw new PurReadError('string');
    this.need(0, length);
    const text = new TextDecoder('utf-16be').decode(this.bytes.subarray(this.pos, this.pos + length));
    this.erase(length);
    return text;
  }

  matrix(): number[] {
    const matrix = [this.f64(0), this.f64(8), this.f64(24), this.f64(32)];
    this.erase(48);
    return matrix;
  }

  rgb(hsv: boolean): number[] {
    const channels = [this.takeU16(), this.takeU16(), this.takeU16()];
    return hsv ? hsvToRgb(channels) : channels;
  }
}

const isDuplicate = (image: StoredImage): boolean =>
  image.png.length === 4 && !(image.png[0] === 0xff && image.png[1] === 0xff && image.png[2] === 0xff && image.png[3] === 0xff);

const isExternalLink = (image: StoredImage): boolean =>
  image.png.length === 4 && image.png[0] === 0xff && image.png[1] === 0xff && image.png[2] === 0xff && image.png[3] === 0xff;

const textBox = (text: string, matrix: readonly number[]): { width: number; height: number; fontSize: number } => {
  const scale = Math.max(Math.hypot(matrix[0], matrix[2]), 0.05);
  const fontSize = clamp(Math.round(16 * scale), 12, 96);
  const lines = text.split(/\r?\n/).slice(0, 40);
  const longest = Math.max(1, ...lines.map(line => [...line].length));
  return {
    fontSize,
    width: clamp(Math.round(longest * fontSize * 0.62 + 24), 140, 720),
    height: clamp(Math.round(lines.length * fontSize * 1.45 + 16), 48, 640),
  };
};

const pushText = (item: TextTransform, into: PurSceneItem[]): void => {
  if (into.filter(entry => entry.kind === 'text').length >= MAX_NOTES) return;
  const text = item.text.replace(/\0/g, '').trim().slice(0, MAX_NOTE_CHARS);
  if (!text) return;
  const box = textBox(text, item.matrix);
  into.push({
    kind: 'text',
    name: text.slice(0, 24),
    text,
    x: item.x - box.width / 2,
    y: item.y - box.height / 2,
    width: box.width,
    height: box.height,
    rotation: rotationOf(item.matrix),
    z: item.zLayer,
    fontSize: box.fontSize,
    fontColor: cssColor(item.rgb),
  });
  item.children.forEach(child => pushText(child, into));
};

const readStructured = (bytes: Uint8Array): PurScene => {
  const cursor = new PurCursor(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (bytes.length < HEADER_BYTES || cursor.u32(0) !== 8) throw new PurReadError('header');
  cursor.erase(HEADER_BYTES);

  const images: StoredImage[] = [];
  let imageScans = 0;
  while (cursor.find(PNG_HEAD) >= 0) {
    if (imageScans++ > 200) throw new PurReadError('too many images');
    const start = cursor.find(PNG_HEAD);
    if (start >= 4) {
      images.push({ addressStart: cursor.pos, png: cursor.slice(0, 4), transforms: [] });
      cursor.erase(4);
      continue;
    }
    const foot = cursor.find(PNG_FOOT, start);
    const end = foot + PNG_FOOT.length;
    if (foot < start || end > bytes.length - cursor.pos) throw new PurReadError('png');
    images.push({ addressStart: cursor.pos + start, png: cursor.slice(start, end), transforms: [] });
    cursor.erase(end);
  }

  let trailingRefs = 0;
  while (cursor.u32(8) !== GRAPHICS_IMAGE_ITEM && cursor.u32(8) !== GRAPHICS_TEXT_ITEM) {
    if (trailingRefs++ > 200) throw new PurReadError('refs');
    images.push({ addressStart: cursor.pos, png: cursor.slice(0, 4), transforms: [] });
    cursor.erase(4);
  }

  const imageItems: ImageTransform[] = [];
  const texts: TextTransform[] = [];

  const addTextChildren = (parent: { children: TextTransform[] }, count: number): void => {
    if (count < 0 || count > 16) throw new PurReadError('children');
    for (let i = 0; i < count; i += 1) parent.children.push(unpackText());
  };

  const unpackText = (): TextTransform => {
    const transformEnd = cursor.u64(0);
    cursor.erase(12 + cursor.u32(8));
    const text = cursor.string();
    const matrix = cursor.matrix();
    const x = cursor.takeF64();
    const y = cursor.takeF64();
    cursor.erase(8);
    cursor.takeU32();
    const zLayer = cursor.takeF64();
    const hsv = cursor.takeI8() === 2;
    cursor.takeU16();
    const rgb = cursor.rgb(hsv);
    cursor.erase(2);
    const backgroundHsv = cursor.takeI8() === 2;
    cursor.takeU16();
    cursor.rgb(backgroundHsv);
    const children = cursor.u32(2);
    const skip = transformEnd - cursor.pos;
    if (skip < 0) throw new PurReadError('text end');
    cursor.erase(skip);
    const item: TextTransform = { x, y, zLayer, matrix, text, rgb, children: [] };
    if (children > 0) addTextChildren(item, children);
    return item;
  };

  const unpackImage = (): ImageTransform => {
    const transformEnd = cursor.u64(0);
    cursor.erase(12 + cursor.u32(8));
    let bruteForced = false;
    if (cursor.u32(0) === 0) {
      bruteForced = true;
      cursor.erase(4);
    }
    let name = 'image';
    if (cursor.i32(0) === -1) cursor.erase(4);
    else cursor.string();
    if (!bruteForced) {
      if (cursor.i32(0) === -1) cursor.erase(4);
      else name = cursor.string() || name;
    }
    cursor.erase(8);
    const matrix = cursor.matrix();
    const x = cursor.takeF64();
    const y = cursor.takeF64();
    cursor.erase(8);
    const id = cursor.takeU32();
    const zLayer = cursor.takeF64();
    cursor.matrix();
    cursor.takeF64();
    cursor.takeF64();
    cursor.takeF64();
    const pointCount = cursor.takeU32();
    if (pointCount > 32) throw new PurReadError('points');
    const pointsX: number[] = [];
    const pointsY: number[] = [];
    for (let i = 0; i < pointCount; i += 1) {
      cursor.erase(4);
      pointsX.push(cursor.takeF64());
      pointsY.push(cursor.takeF64());
    }
    const children = cursor.u32(21);
    const skip = transformEnd - cursor.pos;
    if (skip < 0) throw new PurReadError('image end');
    cursor.erase(skip);
    const item: ImageTransform = { id, name, x, y, zLayer, matrix, pointsX, pointsY, children: [] };
    addTextChildren(item, children);
    return item;
  };

  let itemScans = 0;
  while (cursor.u32(8) === GRAPHICS_IMAGE_ITEM || cursor.u32(8) === GRAPHICS_TEXT_ITEM) {
    if (itemScans++ > 200) throw new PurReadError('items');
    if (cursor.u32(8) === GRAPHICS_IMAGE_ITEM) imageItems.push(unpackImage());
    else texts.push(unpackText());
  }

  cursor.string();
  for (let i = 0; i < imageItems.length; i += 1) {
    const id = cursor.u32(0);
    const address = cursor.u64(4);
    const item = imageItems.find(candidate => candidate.id === id);
    const image = images.find(candidate => candidate.addressStart === address);
    if (item && image) image.transforms = [item];
    cursor.erase(20);
  }

  for (const image of images) {
    if (!isDuplicate(image)) continue;
    const id = new DataView(image.png.buffer, image.png.byteOffset, image.png.byteLength).getUint32(0, false);
    const original = images.find(candidate => candidate.transforms[0]?.id === id);
    if (original) original.transforms.push(...image.transforms);
  }

  const items: PurSceneItem[] = [];
  let externalLinks = 0;
  let unplaced = 0;
  let oversized = 0;
  for (const image of images) {
    if (isDuplicate(image)) continue;
    if (isExternalLink(image)) {
      externalLinks += 1;
      continue;
    }
    const intrinsic = pngSize(image.png);
    if (!intrinsic || image.png.length > MAX_IMAGE_BYTES) {
      if (image.png.length > MAX_IMAGE_BYTES) oversized += 1;
      continue;
    }
    const transforms = image.transforms.length > 0 ? image.transforms : [undefined];
    if (image.transforms.length === 0) unplaced += 1;
    for (const transform of transforms) {
      if (items.filter(entry => entry.kind === 'image').length >= MAX_IMAGES) break;
      const matrix = transform?.matrix ?? [1, 0, 0, 1];
      const pointsX = transform?.pointsX ?? [];
      const pointsY = transform?.pointsY ?? [];
      let width = pointsX.length > 2 ? Math.abs(pointsX[2] - pointsX[0]) * Math.hypot(matrix[0], matrix[2]) : 0;
      let height = pointsY.length > 2 ? Math.abs(pointsY[2] - pointsY[0]) * Math.hypot(matrix[1], matrix[3]) : 0;
      if (!(width >= 1)) width = intrinsic.width;
      if (!(height >= 1)) height = intrinsic.height;
      width = clamp(width, 1, 16000);
      height = clamp(height, 1, 16000);
      const centerX = transform?.x ?? width / 2;
      const centerY = transform?.y ?? height / 2;
      items.push({
        kind: 'image',
        name: transform?.name || 'image',
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
        rotation: rotationOf(matrix),
        z: transform?.zLayer ?? 0,
        bytes: image.png,
        mimeType: 'image/png',
      });
      transform?.children.forEach(child => pushText(child, items));
    }
  }
  texts.forEach(text => pushText(text, items));
  if (items.length === 0) throw new PurReadError('empty');
  items.sort((a, b) => a.z - b.z);

  const notes: string[] = [];
  if (externalLinks > 0) notes.push(`有 ${externalLinks} 张图片只保存了外部路径，没有嵌进文件。`);
  if (unplaced > 0) notes.push(`有 ${unplaced} 张图片没有读出位置，已按原尺寸放下。`);
  if (oversized > 0) notes.push(`有 ${oversized} 张图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，没有导入。`);
  return { items, structured: true, notice: notes.length > 0 ? notes.join('') : undefined };
};

const gridItems = (blobs: readonly { bytes: Uint8Array; mimeType: string; width: number; height: number }[]): PurSceneItem[] => {
  const columns = 4;
  const cell = 360;
  const gap = 24;
  return blobs.slice(0, MAX_IMAGES).map((blob, index) => {
    const aspect = blob.height / blob.width;
    let width = cell;
    let height = cell * aspect;
    if (height > cell * 1.6) {
      height = cell * 1.6;
      width = height / aspect;
    }
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      kind: 'image' as const,
      name: `image ${index + 1}`,
      x: column * (cell + gap),
      y: row * (cell + gap),
      width: Math.round(width),
      height: Math.round(height),
      rotation: 0,
      z: index,
      bytes: blob.bytes,
      mimeType: blob.mimeType,
    };
  });
};

const IMAGE_EXTENSIONS = ['webp', 'jpeg', 'tiff', 'png', 'jpg', 'gif', 'bmp', 'tif'] as const;
const HEX_DIGITS = '0123456789abcdef';

interface PurRecord {
  /** 图像数据的起点（32 位资源哈希之后）。 */
  dataStart: number;
  /** 记录里带的源文件绝对路径，可能为空。 */
  sourcePath: string;
  extension: string;
  hash: string;
}

const isHexByte = (value: number): boolean => HEX_DIGITS.includes(String.fromCharCode(value));

const isPrintable = (value: number): boolean => value >= 0x20 && value <= 0x7e;

/** 读出哈希前面的可打印串（路径），长度上限防止被二进制误连。 */
const printableBefore = (bytes: Uint8Array, end: number): string => {
  let start = end;
  while (start > 0 && end - start < 1024 && isPrintable(bytes[start - 1])) start -= 1;
  let text = '';
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
};

/** 从 `路径路径扩展名哈希` 这段串里取出源文件路径（两段路径通常是同一个）。 */
const pickSourcePath = (run: string): string => {
  const second = run.slice(1).search(/[A-Za-z]:[\\/]/);
  if (second >= 0) return run.slice(0, second + 1);
  return run;
};

/** 扫 PureRef 2.x 的资源记录：每条记录是「路径 ×2 + 扩展名 + 32 位哈希 + 图像数据」。 */
const scanRecords = (bytes: Uint8Array): PurRecord[] => {
  const records: PurRecord[] = [];
  for (let i = 32; i + 32 < bytes.length; i += 1) {
    let hash = '';
    for (let k = 0; k < 32; k += 1) {
      if (!isHexByte(bytes[i + k])) break;
      hash += String.fromCharCode(bytes[i + k]);
    }
    if (hash.length < 32) continue;
    if (isHexByte(bytes[i + 32])) continue;
    let extension = '';
    for (const candidate of IMAGE_EXTENSIONS) {
      let match = true;
      for (let k = 0; k < candidate.length; k += 1) {
        const code = bytes[i - candidate.length + k] | 0x20;
        if (code !== candidate.charCodeAt(k)) { match = false; break; }
      }
      if (match) { extension = candidate; break; }
    }
    if (!extension) continue;
    const run = printableBefore(bytes, i - extension.length);
    records.push({ dataStart: i + 32, sourcePath: pickSourcePath(run), extension, hash });
    i += 31;
  }
  return records;
};

/** PNG 的完整长度：按 chunk 链走到 IEND；链断了返回 -1。 */
const pngExtent = (bytes: Uint8Array, start: number, limit: number): number => {
  let i = start + PNG_HEAD.length;
  for (let guard = 0; guard < 4096 && i + 12 <= limit; guard += 1) {
    const length = readU32(bytes, i);
    if (length > MAX_IMAGE_BYTES) return -1;
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return -1;
    i += 12 + length;
    if (type === 'IEND') return i;
  }
  return -1;
};

/** JPEG 的完整长度：按 marker 走到 EOI；中途不合法返回 -1。 */
const jpegExtent = (bytes: Uint8Array, start: number, limit: number): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = start + 2;
  for (let guard = 0; guard < 100000 && i + 3 < limit; guard += 1) {
    if (bytes[i] !== 0xff) return -1;
    const marker = bytes[i + 1];
    if (marker === 0xd9) return i + 2;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = view.getUint16(i + 2);
    if (length < 2) return -1;
    if (marker === 0xda) {
      let j = i + 2 + length;
      while (j + 1 < limit) {
        if (bytes[j] === 0xff) {
          const next = bytes[j + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      if (j + 1 >= limit) return -1;
      i = j;
      continue;
    }
    i += 2 + length;
  }
  return -1;
};

/** 按首字节判断真实格式，再验证完整性；返回可用区间，否则 undefined。 */
const validateImage = (
  bytes: Uint8Array,
  start: number,
  limit: number,
): { end: number; mimeType: string } | undefined => {
  if (start + PNG_HEAD.length <= limit) {
    let matched = true;
    for (let k = 0; k < PNG_HEAD.length; k += 1) {
      if (bytes[start + k] !== PNG_HEAD[k]) { matched = false; break; }
    }
    if (matched) {
      const end = pngExtent(bytes, start, limit);
      return end > 0 ? { end, mimeType: 'image/png' } : undefined;
    }
  }
  if (bytes[start] === 0xff && bytes[start + 1] === 0xd8) {
    const end = jpegExtent(bytes, start, limit);
    return end > 0 ? { end, mimeType: 'image/jpeg' } : undefined;
  }
  return undefined;
};

/** 文件尾部内嵌 SQLite 的起点（PureRef 2.x 把场景数据放在这里）。 */
const embeddedStoreStart = (bytes: Uint8Array): number => {
  const marker = indexOfBytes(bytes, Uint8Array.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]), Math.max(0, bytes.length - 4 * 1024 * 1024));
  return marker > 0 ? marker : bytes.length;
};

const extractEmbedded = (bytes: Uint8Array, version: number): PurScene => {
  const records = scanRecords(bytes);
  const storeStart = embeddedStoreStart(bytes);
  const blobs: { bytes: Uint8Array; mimeType: string; width: number; height: number }[] = [];
  let broken = 0;
  let skippedOversized = 0;

  for (const [index, record] of records.entries()) {
    const nextStart = records[index + 1]?.dataStart ?? storeStart;
    const limit = Math.min(bytes.length, Math.max(nextStart, record.dataStart + 8));
    const valid = validateImage(bytes, record.dataStart, limit);
    if (!valid) { broken += 1; continue; }
    const slice = bytes.subarray(record.dataStart, valid.end);
    if (slice.length > MAX_IMAGE_BYTES) { skippedOversized += 1; continue; }
    const size = valid.mimeType === 'image/png' ? pngSize(slice) : jpegSize(slice);
    if (!size) { broken += 1; continue; }
    if (blobs.length < MAX_IMAGES) blobs.push({ bytes: slice, mimeType: valid.mimeType, ...size });
  }

  if (blobs.length === 0 && records.length > 0) {
    throw new Error(
      `这个 PureRef 文件里有 ${records.length} 条图片记录，但内嵌的图像数据都不完整（多为只写了文件头就被截断）。`
      + '常见原因是场景设成了「不缓存原图」，或者文件被覆盖写坏了。请在 PureRef 里用「另存为」重新导出后再试。',
    );
  }
  if (blobs.length === 0) {
    const fallback: { bytes: Uint8Array; mimeType: string; width: number; height: number }[] = [];
    let cursor = 0;
    while (cursor < bytes.length && fallback.length < MAX_IMAGES) {
      const pngAt = indexOfBytes(bytes, PNG_HEAD, cursor);
      const jpegAt = indexOfBytes(bytes, Uint8Array.from([0xff, 0xd8, 0xff]), cursor);
      const next = [pngAt, jpegAt].filter(index => index >= 0).sort((a, b) => a - b)[0];
      if (next === undefined) break;
      const valid = validateImage(bytes, next, bytes.length);
      if (!valid) { cursor = next + 1; continue; }
      const slice = bytes.subarray(next, valid.end);
      const size = valid.mimeType === 'image/png' ? pngSize(slice) : jpegSize(slice);
      if (size && slice.length <= MAX_IMAGE_BYTES) fallback.push({ bytes: slice, mimeType: valid.mimeType, ...size });
      cursor = Math.max(valid.end, next + 1);
    }
    if (fallback.length === 0) throw new Error('这个 PureRef 文件里没有能放上画布的图片。');
    const notes: string[] = [
      version >= 2
        ? '这是 PureRef 2 的文件，原位置、便签、裁剪和手绘没有读出来，图片按顺序铺开。'
        : '没有读出 PureRef 里的位置和便签，图片按顺序铺开。',
    ];
    if (version >= 2 && fallback.length > 1 && fallback[0].mimeType === 'image/png') {
      fallback.shift();
      notes.push('已跳过开头的预览图。');
    }
    return { items: gridItems(fallback), structured: false, notice: notes.join('') };
  }

  const notes = [
    version >= 2
      ? '这是 PureRef 2 的文件，原位置、便签、裁剪和手绘没有读出来，图片按顺序铺开。'
      : '没有读出 PureRef 里的位置和便签，图片按顺序铺开。',
  ];
  if (skippedOversized > 0) notes.push(`有 ${skippedOversized} 张图片超过上限，没有导入。`);
  if (records.length > MAX_IMAGES) notes.push(`只导入了前 ${MAX_IMAGES} 张图片。`);
  if (broken > 0) notes.push(`另有 ${broken} 张的内嵌数据不完整，已跳过。`);
  return { items: gridItems(blobs), structured: false, notice: notes.join('') };
};

const fileNameOf = (path: string, index: number): string => {
  const parts = path.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? '';
  return name.length > 0 ? name : `图片 ${index + 1}`;
};

/**
 * `.pur` 头部（版本串 / `2.0.0` / 32 位场景 ID / 256×256 JPEG 缩略图）覆盖了文件最前面
 * 一段字节，正好压掉数据库开头几页的页头。这里算出这段的长度，供抢救根页使用。
 */
const headerRegionBytes = (bytes: Uint8Array): number => {
  if (bytes.byteLength < 0x70) return 0;
  const thumbnailAt = 0x6c;
  const isJpeg = bytes[thumbnailAt] === 0xff && bytes[thumbnailAt + 1] === 0xd8;
  if (!isJpeg) return 0;
  const length = readU32(bytes, 0x68);
  const end = thumbnailAt + length;
  return length > 32 && end <= bytes.byteLength ? end : 0;
};

/**
 * PureRef 2.x 的正解：文件体就是一个 SQLite 数据库镜像，直接读库拿
 * 原图 BLOB + `items_images.image_transform` 里的仿射矩阵，位置和尺寸都是真值。
 * 读不出来（老版本 / 库被写坏）才退回魔数扫描。
 */
const readDatabaseScene = (bytes: Uint8Array): PurScene | undefined => {
  const databaseOffset = bytes.byteLength >= 0x16 ? readU32(bytes, 0x12) : 0;
  const database = readPurDatabase(bytes, databaseOffset, MAX_IMAGE_BYTES, headerRegionBytes(bytes));
  if (!database || database.images.length === 0) return undefined;

  const byId = new Map(database.images.map(image => [image.id, image]));
  const placed: PurSceneItem[] = [];
  const used = new Set<number>();
  const ordered = [...database.placements].sort((a, b) => (a.z - b.z) || (a.itemId - b.itemId));
  for (const placement of ordered) {
    const image = byId.get(placement.imageId);
    if (!image || used.has(image.id) || placed.length >= MAX_IMAGES) continue;
    const width = placement.width > 0 ? placement.width : image.width;
    const height = placement.height > 0 ? placement.height : image.height;
    if (width <= 0 || height <= 0) continue;
    used.add(image.id);
    placed.push({
      kind: 'image',
      name: fileNameOf(image.sourcePath, placed.length),
      x: placement.x,
      y: placement.y,
      width,
      height,
      rotation: placement.rotation,
      z: placed.length,
      bytes: image.bytes,
      mimeType: image.mimeType,
    });
  }

  // 有图但没有位置记录（items_images 被写坏）时，补在已摆放内容的右侧网格里。
  const leftovers = database.images.filter(image => !used.has(image.id));
  if (leftovers.length > 0 && placed.length < MAX_IMAGES) {
    const right = placed.reduce((max, item) => Math.max(max, item.x + item.width), 0);
    const top = placed.reduce((min, item) => Math.min(min, item.y), 0);
    const grid = gridItems(leftovers.slice(0, MAX_IMAGES - placed.length));
    for (const [index, item] of grid.entries()) {
      placed.push({
        ...item,
        name: fileNameOf(leftovers[index]?.sourcePath ?? '', index),
        x: right + 48 + item.x,
        y: top + item.y,
        z: placed.length,
      });
    }
  }

  if (placed.length === 0) return undefined;

  const notes: string[] = [];
  if (leftovers.length > 0) notes.push(`有 ${leftovers.length} 张图没读到原始位置，先排在右边。`);
  if (database.skipped.unsupportedFormat > 0) {
    notes.push(`另有 ${database.skipped.unsupportedFormat} 张是画布不支持显示的格式（如 PSD），没有导入。`);
  }
  if (database.skipped.oversized > 0) notes.push(`另有 ${database.skipped.oversized} 张单图超过上限，没有导入。`);
  return { items: placed, structured: true, notice: notes.length > 0 ? notes.join('') : undefined };
};

export const parsePurBytes = (bytes: Uint8Array): PurScene => {
  const limit = purLimitBytes();
  if (bytes.byteLength > limit) throw new Error(limitMessage(FORMAT_LIMITS.purFileMiB, limit));
  if (bytes.byteLength < HEADER_BYTES || readVersionString(bytes) === undefined) throw new Error('这不是能识别的 PureRef 文件。');
  const version = majorVersion(bytes);
  if (version >= 2) {
    const scene = readDatabaseScene(bytes);
    if (scene) return scene;
    return extractEmbedded(bytes, version);
  }
  try {
    return readStructured(bytes);
  } catch (error) {
    if (!(error instanceof PurReadError)) throw error;
  }
  return extractEmbedded(bytes, version);
};
