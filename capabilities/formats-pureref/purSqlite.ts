/**
 * PureRef 2.x `.pur` 内嵌场景数据库读取器（纯 JS SQLite 页解析，无第三方依赖）。
 *
 * 逆向结论（对本机三个真实 2.1 文件逐字节验证过）：
 *  - 文件体就是**一个完整的 SQLite 数据库镜像**，第 N 页的物理位置是 `(N-1) * pageSize`；
 *  - 唯一例外是**第 1 页**（数据库头 + sqlite_master）：它被搬到文件里由头部
 *    `0x12` 处 uint32 大端给出的偏移上（实测正好等于 `pageCount * pageSize`）；
 *  - `.pur` 自己的头部（版本串 / `2.0.0` / 32 位场景 ID / 256×256 JPEG 缩略图）
 *    写在文件最前面，**压掉了第 1~5 页的开头**，所以 `images` / `metadata` / `items`
 *    的根页（rootpage 3/4/5）经常读不出来；
 *  - `items_images`（rootpage 6）通常完好，直接给出每张图的 QTransform 仿射矩阵；
 *  - `images` 表的数据叶子页远在后面几百页，全部完好，BLOB 走标准 overflow 链。
 * 所以这里能按根页走 b-tree 就走，根页坏了就**全库扫叶子页**，按列数认表。
 */

export interface PurImageRecord {
  id: number;
  sourcePath: string;
  format: string;
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface PurPlacement {
  itemId: number;
  imageId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
}

/** QTransform 的 2×3 仿射：x' = a*x + c*y + dx，y' = b*x + d*y + dy。 */
export interface PurAffine {
  a: number;
  b: number;
  c: number;
  d: number;
  dx: number;
  dy: number;
}

export interface PurItemRecord {
  id: number;
  parent: number;
  transform: PurAffine;
  z: number;
}

export interface PurDatabase {
  images: PurImageRecord[];
  placements: PurPlacement[];
  /** 场景里有、但这套实现没用上的东西（用于给用户提示）。 */
  skipped: { unsupportedFormat: number; oversized: number; salvaged: boolean };
}

const SQLITE_MAGIC = Uint8Array.from([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);
const PAGE_TYPES = new Set([0x02, 0x05, 0x0a, 0x0d]);
const LEAF_TABLE = 0x0d;
const INTERIOR_TABLE = 0x05;
const MAX_PAGE_SIZE = 65536;
const IMAGE_COLUMNS = 9;
const PLACEMENT_COLUMNS = 8;
const HEADER_PEEK = 4096;

const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] << 8) | bytes[at + 1];
const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

const startsWith = (bytes: Uint8Array, at: number, needle: Uint8Array): boolean => {
  if (at < 0 || at + needle.length > bytes.length) return false;
  for (let i = 0; i < needle.length; i += 1) if (bytes[at + i] !== needle[i]) return false;
  return true;
};

/** SQLite 变长整数（大端 base-128，最多 9 字节）。 */
const readVarint = (bytes: Uint8Array, at: number): { value: number; next: number } => {
  let value = 0;
  for (let i = 0; i < 9; i += 1) {
    const byte = bytes[at + i];
    if (byte === undefined) return { value, next: at + i };
    if (i === 8) return { value: value * 256 + byte, next: at + 9 };
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  return { value, next: at + 9 };
};

/**
 * 把 Qt 写坏的二进制“文本”还原成原始字节。
 *
 * PureRef 把 QByteArray（QTransform / QPainterPath）绑进了 TEXT 亲和性的列，
 * Qt 的 SQLite 驱动按 Latin-1 → QString → UTF-8 存了一遍，于是每个 ≥0x80 的字节
 * 都撑成 2 字节（0xC2/0xC3 + 续字节）。这里逐字节逆变换，无法识别的序列原样保留。
 */
export const demojibake = (raw: Uint8Array): Uint8Array => {
  const out = new Uint8Array(raw.length);
  let n = 0;
  let i = 0;
  while (i < raw.length) {
    const byte = raw[i];
    if (byte < 0x80) {
      out[n] = byte;
      n += 1;
      i += 1;
      continue;
    }
    if ((byte === 0xc2 || byte === 0xc3) && i + 1 < raw.length && (raw[i + 1] & 0xc0) === 0x80) {
      out[n] = ((byte & 0x03) << 6) | (raw[i + 1] & 0x3f);
      n += 1;
      i += 2;
      continue;
    }
    out[n] = byte;
    n += 1;
    i += 1;
  }
  return out.subarray(0, n);
};

type Reader = {
  bytes: Uint8Array;
  pageSize: number;
  usable: number;
  pageCount: number;
  page1Offset: number;
};

const pageOffset = (reader: Reader, pgno: number): number =>
  pgno === 1 ? reader.page1Offset : (pgno - 1) * reader.pageSize;

const localSize = (reader: Reader, size: number): number => {
  const maxLocal = reader.usable - 35;
  const minLocal = Math.floor(((reader.usable - 12) * 32) / 255) - 23;
  if (size <= maxLocal) return size;
  const spilled = minLocal + ((size - minLocal) % (reader.usable - 4));
  return spilled <= maxLocal ? spilled : minLocal;
};

type PageHeader = { type: number; offset: number; pointers: number[]; right?: number };

const readPageHeader = (reader: Reader, pgno: number): PageHeader | undefined => {
  const offset = pageOffset(reader, pgno);
  if (offset < 0 || offset + reader.pageSize > reader.bytes.length) return undefined;
  const headerAt = pgno === 1 ? 100 : 0;
  const type = reader.bytes[offset + headerAt];
  if (!PAGE_TYPES.has(type)) return undefined;
  const count = u16(reader.bytes, offset + headerAt + 3);
  if (count > Math.floor(reader.usable / 2)) return undefined;
  let cursor = headerAt + 8;
  let right: number | undefined;
  if (type === INTERIOR_TABLE || type === 0x02) {
    right = u32(reader.bytes, offset + cursor);
    cursor += 4;
  }
  if (cursor + count * 2 > reader.pageSize) return undefined;
  const pointers: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const pointer = u16(reader.bytes, offset + cursor + i * 2);
    if (pointer < cursor + count * 2 || pointer >= reader.pageSize) return undefined;
    pointers.push(pointer);
  }
  return { type, offset, pointers, right };
};

/** 组装一条记录的完整 payload（含 overflow 链）。 */
const readPayload = (reader: Reader, offset: number, size: number): Uint8Array => {
  const local = localSize(reader, size);
  if (local >= size) return reader.bytes.subarray(offset, offset + size);
  const parts: Uint8Array[] = [reader.bytes.subarray(offset, offset + local)];
  let total = local;
  let next = u32(reader.bytes, offset + local);
  let remaining = size - local;
  const seen = new Set<number>();
  while (remaining > 0 && next > 0 && !seen.has(next)) {
    seen.add(next);
    const at = (next - 1) * reader.pageSize;
    if (at + reader.pageSize > reader.bytes.length) break;
    const take = Math.min(remaining, reader.usable - 4);
    parts.push(reader.bytes.subarray(at + 4, at + 4 + take));
    total += take;
    remaining -= take;
    next = u32(reader.bytes, at);
  }
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
};

const serialSize = (type: number): number => {
  if (type >= 12) return Math.floor((type - (type % 2 === 0 ? 12 : 13)) / 2);
  if (type === 7) return 8;
  if (type === 5) return 6;
  if (type === 6) return 8;
  if (type >= 1 && type <= 4) return type;
  return 0;
};

/** 只解记录头（序列类型表），不碰记录体 —— 用来判断一条记录有几列、BLOB 多大。 */
const readTypeList = (raw: Uint8Array): number[] | undefined => {
  if (raw.length < 2) return undefined;
  const header = readVarint(raw, 0);
  if (header.value <= 1 || header.value > raw.length) return undefined;
  const types: number[] = [];
  let cursor = header.next;
  while (cursor < header.value && types.length <= 64) {
    const entry = readVarint(raw, cursor);
    if (entry.next <= cursor) return undefined;
    types.push(entry.value);
    cursor = entry.next;
  }
  return types;
};

type CellValue =
  | { kind: 'null' }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bytes'; value: Uint8Array };

const decodeRecord = (raw: Uint8Array): CellValue[] => {
  const types = readTypeList(raw);
  if (!types) return [];
  const header = readVarint(raw, 0);
  let body = header.value;
  const values: CellValue[] = [];
  for (const type of types) {
    if (type === 0) {
      values.push({ kind: 'null' });
    } else if (type >= 1 && type <= 6) {
      const width = serialSize(type);
      let value = 0;
      for (let i = 0; i < width; i += 1) value = value * 256 + (raw[body + i] ?? 0);
      // SQLite 的 1~6 号序列类型是有符号整数；parent = -1 表示挂在根上。
      if (width < 8 && (raw[body] & 0x80) !== 0) value -= 2 ** (width * 8);
      values.push({ kind: 'int', value });
      body += width;
    } else if (type === 7) {
      const view = new DataView(raw.buffer, raw.byteOffset + body, 8);
      values.push({ kind: 'float', value: view.getFloat64(0, false) });
      body += 8;
    } else if (type === 8) {
      values.push({ kind: 'int', value: 0 });
    } else if (type === 9) {
      values.push({ kind: 'int', value: 1 });
    } else if (type >= 12) {
      const length = serialSize(type);
      values.push({ kind: 'bytes', value: raw.subarray(body, body + length) });
      body += length;
    } else {
      values.push({ kind: 'null' });
    }
  }
  return values;
};

/** 一条表格叶子记录：只留定位信息 + 记录头，体积大的 BLOB 按需再读。 */
interface LeafCell {
  rowid: number;
  payloadAt: number;
  size: number;
  types: number[];
}

const readLeafCells = (reader: Reader, pgno: number): LeafCell[] | undefined => {
  const header = readPageHeader(reader, pgno);
  if (!header || header.type !== LEAF_TABLE) return undefined;
  const cells: LeafCell[] = [];
  for (const pointer of header.pointers) {
    const at = header.offset + pointer;
    const sizeField = readVarint(reader.bytes, at);
    const rowidField = readVarint(reader.bytes, sizeField.next);
    if (sizeField.value <= 0) continue;
    const payloadAt = rowidField.next;
    const peekLength = Math.min(
      localSize(reader, sizeField.value),
      Math.max(HEADER_PEEK, reader.pageSize),
      reader.bytes.length - payloadAt,
    );
    const types = readTypeList(reader.bytes.subarray(payloadAt, payloadAt + Math.max(0, peekLength)));
    if (!types) continue;
    cells.push({ rowid: rowidField.value, payloadAt, size: sizeField.value, types });
  }
  return cells;
};

const readCellValues = (reader: Reader, cell: LeafCell): CellValue[] =>
  decodeRecord(readPayload(reader, cell.payloadAt, cell.size));

const walkTable = (reader: Reader, root: number, depth = 0): LeafCell[] => {
  if (depth > 12) return [];
  const header = readPageHeader(reader, root);
  if (!header) return [];
  if (header.type === LEAF_TABLE) return readLeafCells(reader, root) ?? [];
  if (header.type !== INTERIOR_TABLE) return [];
  const out: LeafCell[] = [];
  for (const pointer of header.pointers) {
    const child = u32(reader.bytes, header.offset + pointer);
    if (child > 1 && child <= reader.pageCount) out.push(...walkTable(reader, child, depth + 1));
  }
  if (header.right && header.right > 1 && header.right <= reader.pageCount) {
    out.push(...walkTable(reader, header.right, depth + 1));
  }
  return out;
};

/** sqlite_master 在搬迁页（第 1 页）里，按表名取根页。 */
const tableRoots = (reader: Reader): Map<string, number> => {
  const roots = new Map<string, number>();
  for (const cell of readLeafCells(reader, 1) ?? []) {
    if (cell.types.length < 4) continue;
    const values = readCellValues(reader, cell);
    const kind = values[0];
    const name = values[1];
    const root = values[3];
    if (kind?.kind !== 'bytes' || name?.kind !== 'bytes' || root?.kind !== 'int') continue;
    if (new TextDecoder().decode(kind.value) !== 'table') continue;
    roots.set(new TextDecoder().decode(name.value), root.value);
  }
  return roots;
};

/** 根页坏了以后的兜底：整库扫叶子页。 */
const scanLeaves = (reader: Reader): LeafCell[] => {
  const out: LeafCell[] = [];
  const lastPage = Math.min(reader.pageCount, Math.floor(reader.bytes.length / reader.pageSize) + 1);
  for (let pgno = 2; pgno <= lastPage; pgno += 1) {
    if (reader.bytes[(pgno - 1) * reader.pageSize] !== LEAF_TABLE) continue;
    const cells = readLeafCells(reader, pgno);
    if (cells) out.push(...cells);
  }
  return out;
};

const IDENTITY: PurAffine = { a: 1, b: 0, c: 0, d: 1, dx: 0, dy: 0 };

const multiplyAffine = (outer: PurAffine, inner: PurAffine): PurAffine => ({
  a: outer.a * inner.a + outer.c * inner.b,
  b: outer.b * inner.a + outer.d * inner.b,
  c: outer.a * inner.c + outer.c * inner.d,
  d: outer.b * inner.c + outer.d * inner.d,
  dx: outer.a * inner.dx + outer.c * inner.dy + outer.dx,
  dy: outer.b * inner.dx + outer.d * inner.dy + outer.dy,
});

/**
 * 解 QTransform。
 *
 * 实测序列化形态：`00 00 00 50`（QByteArray 长度 80）+ 1 字节标志 + 9 个 double：
 * `[m11, m12, m13, m21, m22, m23, dx, dy, m33]`（Qt 的 x' = m11x + m21y + dx）。
 * 注意这些列是 TEXT 亲和性，Qt 把二进制按 Latin-1→UTF-8 存了一遍，要先逆变换。
 */
const decodeAffine = (raw: Uint8Array): PurAffine | undefined => {
  const data = demojibake(raw);
  if (data.length < 56) return undefined;
  const flagged = u32(data, 0) === 0x50;
  const start = flagged ? 5 : 4;
  const count = Math.floor((data.length - start) / 8);
  if (count < 6) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numbers: number[] = [];
  for (let i = 0; i < Math.min(count, 9); i += 1) numbers.push(view.getFloat64(start + i * 8, false));
  if (!numbers.every(Number.isFinite)) return undefined;
  return {
    a: numbers[0],
    b: numbers[1],
    c: numbers[3],
    d: numbers[4],
    dx: numbers[6] ?? 0,
    dy: numbers[7] ?? 0,
  };
};

interface RawPlacement {
  itemId: number;
  imageId: number;
  local: PurAffine;
}

const buildPlacement = (cell: LeafCell, values: CellValue[]): RawPlacement | undefined => {
  const matrix = asBytes(values[4]);
  if (!matrix) return undefined;
  const local = decodeAffine(matrix);
  if (!local) return undefined;
  return { itemId: cell.rowid, imageId: asInt(values[0]), local };
};

/** 只看 items 表的 9 列签名：parent(int) / id(null,PK) / name / transform / sort_order / z / … */
const buildItemRecord = (cell: LeafCell, values: CellValue[]): PurItemRecord | undefined => {
  const transform = asBytes(values[3]);
  if (!transform) return undefined;
  const affine = decodeAffine(transform);
  if (!affine) return undefined;
  return { id: cell.rowid, parent: asInt(values[0]), transform: affine, z: asInt(values[5]) };
};

const totalValueBytes = (types: number[]): number =>
  types.reduce((sum, type) => sum + serialSize(type), 0);

/**
 * 抢救被 `.pur` 头部（缩略图）压掉页头的叶子页。
 *
 * `items` 的根页通常正好落在第 5 页，页头连同单元格指针数组一起被缩略图覆盖，
 * 但**单元格内容还在页尾**。这里按「载荷长度 + rowid + 记录头 + 列型签名」逐个
 * 字节试解，签名（parent 整型 / PK 为 NULL / transform 是 QTransform）足够强，
 * 误判率可以忽略，而且解析出的总长度必须与载荷长度严格相等。
 */
const salvageLeafCells = (reader: Reader, clobberedBytes: number): LeafCell[] => {
  const out: LeafCell[] = [];
  const lastPage = Math.min(
    reader.pageCount,
    Math.max(7, Math.ceil(clobberedBytes / reader.pageSize) + 2),
  );
  for (let pgno = 2; pgno <= lastPage; pgno += 1) {
    const base = (pgno - 1) * reader.pageSize;
    if (base + reader.pageSize > reader.bytes.length) break;
    if (reader.bytes[base] === LEAF_TABLE) continue;
    const from = Math.max(base + 8, Math.min(clobberedBytes, base + reader.pageSize - 8));
    const to = base + reader.pageSize - 8;
    let at = from;
    while (at < to) {
      const sizeField = readVarint(reader.bytes, at);
      const size = sizeField.value;
      if (size < 24 || size > reader.usable) {
        at += 1;
        continue;
      }
      const rowidField = readVarint(reader.bytes, sizeField.next);
      if (rowidField.value < 1 || rowidField.value > 100_000_000) {
        at += 1;
        continue;
      }
      const payloadAt = rowidField.next;
      if (payloadAt + size > base + reader.pageSize) {
        at += 1;
        continue;
      }
      const types = readTypeList(reader.bytes.subarray(payloadAt, Math.min(payloadAt + size, payloadAt + HEADER_PEEK)));
      const plausible = types !== undefined
        && types.length === 9
        && types[0] >= 1 && types[0] <= 6
        && types[1] === 0
        && types[3] >= 13
        && types[5] >= 1 && types[5] <= 6;
      const headerField = types ? readVarint(reader.bytes, payloadAt) : undefined;
      if (!plausible || !headerField || headerField.value + totalValueBytes(types) !== size) {
        at += 1;
        continue;
      }
      out.push({ rowid: rowidField.value, payloadAt, size, types });
      at = payloadAt + size;
    }
  }
  return out;
};

const asInt = (value: CellValue | undefined): number => (value?.kind === 'int' ? value.value : 0);
const asBytes = (value: CellValue | undefined): Uint8Array | undefined =>
  value?.kind === 'bytes' ? value.value : undefined;

const text = (value: CellValue | undefined): string =>
  value?.kind === 'bytes' ? new TextDecoder().decode(value.value) : '';

const IMAGE_SIGNATURES = [
  Uint8Array.from([0xff, 0xd8, 0xff]),
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  Uint8Array.from([0x52, 0x49, 0x46, 0x46]),
  Uint8Array.from([0x47, 0x49, 0x46, 0x38]),
  Uint8Array.from([0x42, 0x4d]),
];

const looksLikeImage = (bytes: Uint8Array): boolean =>
  IMAGE_SIGNATURES.some(signature => startsWith(bytes, 0, signature));

const buildImageRecord = (
  cell: LeafCell,
  values: CellValue[],
): PurImageRecord | undefined => {
  const formatRaw = asBytes(values[4]);
  const data = asBytes(values[6]);
  if (!formatRaw || !data || data.length < 8) return undefined;
  const format = new TextDecoder().decode(formatRaw).trim().toLowerCase();
  return {
    id: cell.rowid,
    sourcePath: text(values[3]) || text(values[2]),
    format,
    mimeType: MIME_BY_FORMAT[format] ?? `image/${format}`,
    bytes: data,
    width: asInt(values[7]),
    height: asInt(values[8]),
  };
};


/**
 * 读取 `.pur` 内嵌场景数据库。
 *
 * @param headerDatabaseOffset 头部 `0x12` 处给出的第 1 页偏移；0 表示常规布局（第 1 页在文件最前）。
 * @param maxImageBytes 单张图片上限，超出的直接跳过（不算失败）。
 * @param clobberedBytes `.pur` 自身头部（含缩略图）占用的字节数；这一段会压掉数据库开头几页。
 */
export const readPurDatabase = (
  bytes: Uint8Array,
  headerDatabaseOffset: number,
  maxImageBytes: number,
  clobberedBytes = 0,
): PurDatabase | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let reader: Reader | undefined;
  for (const offset of [headerDatabaseOffset, 0]) {
    if (offset < 0 || offset + 108 > bytes.length) continue;
    if (!startsWith(bytes, offset, SQLITE_MAGIC)) continue;
    const declared = view.getUint16(offset + 16, false);
    const pageSize = declared === 1 ? MAX_PAGE_SIZE : declared;
    if (pageSize < 512 || pageSize > MAX_PAGE_SIZE || (pageSize & (pageSize - 1)) !== 0) continue;
    const usable = pageSize - bytes[offset + 20];
    if (usable < 480) continue;
    const pageCount = view.getUint32(offset + 28, false);
    if (pageCount < 2 || pageCount > 4_000_000) continue;
    reader = { bytes, pageSize, usable, pageCount, page1Offset: offset };
    break;
  }
  if (!reader) return undefined;

  const roots = tableRoots(reader);
  const walkNamed = (table: string): LeafCell[] => {
    const root = roots.get(table);
    if (root === undefined || root < 2 || root > reader.pageCount) return [];
    return walkTable(reader, root);
  };

  let imageCells = walkNamed('images');
  let placementCells = walkNamed('items_images');
  if (imageCells.length === 0 || placementCells.length === 0) {
    const scanned = scanLeaves(reader);
    if (imageCells.length === 0) imageCells = scanned.filter(cell => cell.types.length === IMAGE_COLUMNS);
    if (placementCells.length === 0) placementCells = scanned.filter(cell => cell.types.length === PLACEMENT_COLUMNS);
  }

  const skipped = { unsupportedFormat: 0, oversized: 0, salvaged: false };
  const images = new Map<number, PurImageRecord>();
  for (const cell of imageCells) {
    if (cell.types.length !== IMAGE_COLUMNS) continue;
    if (cell.size > maxImageBytes + 8192) {
      skipped.oversized += 1;
      continue;
    }
    const record = buildImageRecord(cell, readCellValues(reader, cell));
    if (!record) continue;
    if (!looksLikeImage(record.bytes)) {
      skipped.unsupportedFormat += 1;
      continue;
    }
    images.set(record.id, record);
  }

  // items 表给的是「图片在场景里的绝对位置」；它的根页常被缩略图压坏，坏了就抢救页尾内容。
  let itemCells = walkNamed('items');
  if (itemCells.length === 0 && clobberedBytes > 0) {
    itemCells = salvageLeafCells(reader, clobberedBytes);
    skipped.salvaged = itemCells.length > 0;
  }
  const items = new Map<number, PurItemRecord>();
  for (const cell of itemCells) {
    if (cell.types.length !== 9) continue;
    if (cell.size > 8 * 1024) continue;
    const record = buildItemRecord(cell, readCellValues(reader, cell));
    if (record) items.set(record.id, record);
  }

  /** 沿 parent 链把 item 的变换叠成绝对变换。 */
  const absoluteOf = (id: number, depth = 0): PurAffine | undefined => {
    const item = items.get(id);
    if (!item) return undefined;
    if (depth > 6 || item.parent === id || !items.has(item.parent)) return item.transform;
    const parent = absoluteOf(item.parent, depth + 1);
    return parent ? multiplyAffine(parent, item.transform) : item.transform;
  };

  const placements: PurPlacement[] = [];
  for (const cell of placementCells) {
    if (cell.types.length !== PLACEMENT_COLUMNS) continue;
    if (cell.size > 64 * 1024) continue;
    const raw = buildPlacement(cell, readCellValues(reader, cell));
    if (!raw) continue;
    const image = images.get(raw.imageId);
    if (!image || image.width <= 0 || image.height <= 0) continue;
    const itemTransform = absoluteOf(raw.itemId);
    const final = itemTransform ? multiplyAffine(itemTransform, raw.local) : raw.local;
    const scaleX = Math.hypot(final.a, final.b);
    const scaleY = Math.hypot(final.c, final.d);
    placements.push({
      itemId: raw.itemId,
      imageId: raw.imageId,
      x: final.dx,
      y: final.dy,
      width: image.width * (scaleX > 0 ? scaleX : 1),
      height: image.height * (scaleY > 0 ? scaleY : 1),
      rotation: scaleX > 0 ? (Math.atan2(final.b, final.a) * 180) / Math.PI : 0,
      z: items.get(raw.itemId)?.z ?? raw.itemId,
    });
  }

  if (images.size === 0 && placements.length === 0) return undefined;
  return { images: [...images.values()], placements, skipped };
};
