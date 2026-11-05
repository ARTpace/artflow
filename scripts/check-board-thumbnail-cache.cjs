const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const { generateBoardThumbnail } = require('../utils/canvasUtils.ts');
const savedBtoa = global.btoa;
let encodes = 0;
global.btoa = value => { encodes++; return savedBtoa(value); };
const image = { id: 'a', type: 'image', x: 0, y: 0, width: 100, height: 100, href: 'data:image/png;base64,ORIGINAL', thumbnailHref: 'data:image/png;base64,SMALL', mediumHref: 'data:image/png;base64,MEDIUM' };
const decode = url => Buffer.from(url.split(',')[1], 'base64').toString('utf8');
try {
  const elements = [image];
  const result = generateBoardThumbnail(elements, '#18181b');
  assert.ok(decode(result).includes('SMALL'));
  assert.ok(!decode(result).includes('ORIGINAL'));
  assert.equal(generateBoardThumbnail(elements, '#18181b'), result);
  assert.equal(encodes, 1, 'unchanged board should not re-encode');
  generateBoardThumbnail(elements, '#fff');
  assert.equal(encodes, 2, 'background changes must invalidate');
  generateBoardThumbnail([...elements], '#fff');
  assert.equal(encodes, 3, 'document revision must invalidate');
  assert.ok(decode(generateBoardThumbnail([{ ...image, thumbnailHref: undefined }], '#fff')).includes('MEDIUM'));
  assert.ok(decode(generateBoardThumbnail([{ ...image, thumbnailHref: undefined, mediumHref: undefined }], '#fff')).includes('ORIGINAL'));
  const empty = []; generateBoardThumbnail(empty, '#fff'); const before = encodes;
  generateBoardThumbnail(empty, '#fff'); assert.equal(encodes, before);
  console.log('board-thumbnail: immutable cache, background invalidation and image LOD fallback passed');
} finally { global.btoa = savedBtoa; }
