const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
require('./register-typescript.cjs');
const { zipSync } = require('fflate');
const { parsePalmDocBytes } = require('../capabilities/formats-packaged/palmDoc.ts');
const { chaptersFromPlainText, readerChapters } = require('../capabilities/formats-book/readerOutline.ts');
const { parsePackedComicBytes } = require('../capabilities/formats-packaged/packedArchive.ts');

const vint = value => {
  const bytes = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};

const palmBytes = (record, compression, textLength) => {
  const record0 = Buffer.alloc(16);
  record0.writeUInt16BE(compression, 0);
  record0.writeUInt32BE(textLength, 4);
  record0.writeUInt16BE(1, 8);
  record0.writeUInt16BE(4096, 10);
  const record0At = 96;
  const record1At = record0At + record0.length;
  const file = Buffer.alloc(record1At + record.length);
  file.write('Fixture', 0);
  file.writeUInt16BE(2, 76);
  file.writeUInt32BE(record0At, 78);
  file.writeUInt32BE(record1At, 86);
  record0.copy(file, record0At);
  Buffer.from(record).copy(file, record1At);
  return file;
};

const rar4 = (name, data, method = 0x30) => {
  const nameBytes = Buffer.from(name);
  const marker = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
  const archive = Buffer.alloc(13);
  archive.writeUInt8(0x73, 2);
  archive.writeUInt16LE(13, 5);
  const headSize = 36 + nameBytes.length;
  const file = Buffer.alloc(headSize + data.length);
  file.writeUInt8(0x74, 2);
  file.writeUInt16LE(0x8000, 3);
  file.writeUInt16LE(headSize, 5);
  file.writeUInt32LE(data.length, 7);
  file.writeUInt32LE(data.length, 11);
  file.writeUInt32LE(data.length, 15);
  file.writeUInt8(20, 28);
  file.writeUInt8(method, 29);
  file.writeUInt16LE(nameBytes.length, 30);
  nameBytes.copy(file, 36);
  Buffer.from(data).copy(file, headSize);
  return Buffer.concat([marker, archive, file]);
};

const rar5Block = (type, rest, data = Buffer.alloc(0)) => {
  const flags = data.length ? 0x0002 : 0;
  const body = Buffer.concat([vint(type), vint(flags), data.length ? vint(data.length) : Buffer.alloc(0), rest]);
  return Buffer.concat([Buffer.alloc(4), vint(body.length), body, data]);
};

const rar5 = (name, data) => {
  const nameBytes = Buffer.from(name);
  const fileRest = Buffer.concat([
    vint(0),
    vint(data.length),
    vint(0),
    vint(0),
    vint(0),
    vint(nameBytes.length),
    nameBytes,
  ]);
  return Buffer.concat([
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
    rar5Block(1, vint(0)),
    rar5Block(2, fileRest, Buffer.from(data)),
    rar5Block(5, Buffer.alloc(0)),
  ]);
};

const sevenZip = (name, payload) => {
  const header = [];
  const num = value => header.push(value);
  header.push(0x01, 0x04, 0x06);
  num(0);
  num(1);
  header.push(0x09);
  num(payload.length);
  header.push(0x00, 0x07, 0x0b);
  num(1);
  header.push(0x00);
  num(1);
  header.push(0x01, 0x00, 0x0c);
  num(payload.length);
  header.push(0x00, 0x00, 0x05);
  num(1);
  header.push(0x11);
  const utf16 = Buffer.from(`${name}\0`, 'utf16le');
  num(1 + utf16.length);
  header.push(0x00, ...utf16, 0x00, 0x00);
  const headerBuf = Buffer.from(header);
  const start = Buffer.alloc(32);
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).copy(start);
  start.writeUInt8(4, 7);
  start.writeBigUInt64LE(BigInt(payload.length), 12);
  start.writeBigUInt64LE(BigInt(headerBuf.length), 20);
  return Buffer.concat([start, payload, headerBuf]);
};

const run = async () => {
  const outline = chaptersFromPlainText('序\n\n第一章：练习钝感力\n\n正文\n\n第二章 继续\n\n后文');
  assert.deepEqual(outline.map(chapter => chapter.title), ['第一章：练习钝感力', '第二章 继续']);
  assert.equal(readerChapters('第一章 A\n\n第二章 B', [{ title: '开篇', start: 0 }, { title: '后记', start: 6 }])[0].title, '开篇');

  const plain = await parsePalmDocBytes(palmBytes(Buffer.from('Chapter one'), 1, 11), 'Guide.mobi');
  assert.equal(plain.sourceFormat, 'mobi');
  assert.match(plain.content, /Chapter one/);

  const compressed = await parsePalmDocBytes(palmBytes(Buffer.from([0x61, 0x62, 0x63, 0x80, 0x18]), 2, 6), 'Novel.azw3');
  assert.equal(compressed.sourceFormat, 'azw3');
  assert.match(compressed.content, /abcabc/);

  const html = await parsePalmDocBytes(palmBytes(Buffer.from('<h1>Start</h1><p>Body</p>'), 1, 24), 'Book.azw');
  assert.equal(html.sourceFormat, 'azw');
  assert.match(html.content, /# Start/);
  assert.match(html.content, /Body/);

  const encrypted = palmBytes(Buffer.from('secret'), 1, 6);
  encrypted.writeUInt16BE(1, 96 + 12);
  await assert.rejects(async () => parsePalmDocBytes(encrypted, 'Locked.mobi'), /Encrypted Palm/);

  const page = new Uint8Array([1, 2, 3, 4]);
  const zipped = zipSync({ '01.png': page });
  const fromZip = await parsePackedComicBytes(zipped, 'Album.cbr');
  assert.equal(fromZip.sourceFormat, 'cbr');
  assert.equal(fromZip.pages.length, 1);
  assert.match(fromZip.pages[0], /^data:image\/png;base64,/);

  const fromRar4 = await parsePackedComicBytes(rar4('02.png', page), 'Album.cbr');
  assert.equal(fromRar4.pages.length, 1);
  const fromRar5 = await parsePackedComicBytes(rar5('03.png', page), 'Album.cbr');
  assert.equal(fromRar5.pages.length, 1);
  await assert.rejects(async () => parsePackedComicBytes(rar4('04.png', page, 0x31), 'Album.cbr'), /uses compression/);

  const from7z = await parsePackedComicBytes(sevenZip('05.png', page), 'Album.cb7');
  assert.equal(from7z.sourceFormat, 'cb7');
  assert.equal(from7z.pages.length, 1);
  const fromSeven = await parsePackedComicBytes(sevenZip('06.png', page), 'Album.7z');
  assert.equal(fromSeven.sourceFormat, '7z');

  const root = path.join(__dirname, '..');
  const mainCanvas = await fs.readFile(path.join(root, 'components/MainCanvas.tsx'), 'utf8');
  const app = await fs.readFile(path.join(root, 'App.tsx'), 'utf8');
  const toolbarPlugin = await fs.readFile(path.join(root, 'builtin-plugins/canvas-toolbars/index.tsx'), 'utf8');
  assert.match(mainCanvas, /CanvasToolbarHost/);
  assert.match(mainCanvas, /placement="selection-overlay"/);
  assert.doesNotMatch(mainCanvas, /from '\.\/ToolbarOverlay'/);
  assert.match(app, /placement="smart"/);
  assert.doesNotMatch(app, /from '\.\/components\/SmartToolbar'/);
  assert.match(toolbarPlugin, /ui_toolbar/);
  assert.match(toolbarPlugin, /ToolbarOverlay/);
  assert.match(toolbarPlugin, /SmartToolbar/);
  console.log('packaged formats and canvas toolbars: ok');
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
