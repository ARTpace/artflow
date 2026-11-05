const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const { parsePurBytes } = require('../capabilities/formats-pureref/purParser.ts');

const zlib = require('node:zlib');

// 测试夹具原先写死的 1×1 PNG 十六进制在 IDAT CRC 前多了一个 0x00，chunk 链其实是断的，
// 旧实现靠搜 IEND 字节串兜过去才"能过"。这里直接生成一份合法的 PNG。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = buffer => {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  pngChunk('IHDR', Buffer.from('000000010000000108020000', 'hex')),
  pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0x40, 0x20, 0x10]))),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const beU32 = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const beI32 = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
};
const beU64 = value => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};
const beF64 = value => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes;
};
const matrix = (x, y) => Buffer.concat([beF64(x), beF64(0), beF64(0), beF64(0), beF64(y), beF64(0)]);
const point = (x, y) => Buffer.concat([beU32(1), beF64(x), beF64(y)]);

const header = (versionText = '1.10') => {
  const bytes = Buffer.alloc(224);
  bytes.writeUInt32BE(8, 0);
  if (versionText) {
    for (let i = 0; i < versionText.length; i += 1) bytes.writeUInt16BE(versionText.charCodeAt(i), 4 + i * 2);
  }
  return bytes;
};

const structuredPur = () => {
  const pngStart = 224;
  const body = Buffer.concat([
    beU32(34),
    Buffer.alloc(34),
    beI32(-1),
    beI32(-1),
    Buffer.alloc(8),
    matrix(1, 1),
    beF64(500),
    beF64(400),
    Buffer.alloc(8),
    beU32(7),
    beF64(2),
    matrix(1, 1),
    beF64(0),
    beF64(0),
    beF64(1),
    beU32(5),
    point(-100, -80),
    point(100, -80),
    point(100, 80),
    point(-100, 80),
    point(-100, -80),
    Buffer.alloc(32),
  ]);
  const itemStart = pngStart + PNG.length;
  const transformEnd = itemStart + 8 + body.length;
  return Buffer.concat([
    header(),
    PNG,
    beU64(transformEnd),
    body,
    beU32(0),
    beU32(7),
    beU64(pngStart),
    beU64(pngStart + PNG.length),
  ]);
};

const scene = parsePurBytes(structuredPur());
assert.equal(scene.structured, true);
assert.equal(scene.notice, undefined);
assert.equal(scene.items.length, 1);
assert.equal(scene.items[0].kind, 'image');
assert.equal(scene.items[0].width, 200);
assert.equal(scene.items[0].height, 160);
assert.equal(scene.items[0].x, 400);
assert.equal(scene.items[0].y, 320);
assert.equal(scene.items[0].z, 2);
assert.equal(scene.items[0].bytes.length, PNG.length);

const preview = Buffer.concat([header('2.0'), PNG, PNG]);
const fallback = parsePurBytes(preview);
assert.equal(fallback.structured, false);
assert.equal(fallback.items.length, 1);
assert.match(fallback.notice, /PureRef 2/);
assert.match(fallback.notice, /预览图/);

const unknown = parsePurBytes(Buffer.concat([header(), PNG, PNG]));
assert.equal(unknown.structured, false);
assert.equal(unknown.items.length, 2);
assert.match(unknown.notice, /按顺序铺开/);

assert.throws(() => parsePurBytes(Buffer.alloc(16)), /不是能识别的 PureRef 文件/);
assert.throws(() => parsePurBytes(Buffer.concat([header(), Buffer.alloc(32)])), /没有能放上画布的图片/);

console.log('pureref format: ok');
