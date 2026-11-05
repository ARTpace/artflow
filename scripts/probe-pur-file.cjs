/**
 * 手动验证：把真实 .pur 文件跑一遍解析器，打印每张图的位置/尺寸/大小。
 * 用法：node scripts/probe-pur-file.cjs "D:/path/a.pur" [more.pur ...]
 * 自动化断言仍在 scripts/check-pureref-format.cjs。
 */
require('./register-typescript.cjs');
const fs = require('node:fs');
const { parsePurBytes } = require('../capabilities/formats-pureref/purParser.ts');
const files = process.argv.slice(2);
for (const file of files) {
  const started = Date.now();
  try {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const scene = parsePurBytes(bytes);
    const ms = Date.now() - started;
    const imgs = scene.items.filter(i => i.kind === 'image');
    console.log(`\n=== ${file.split(/[\\/]/).pop()}  ${(bytes.length / 1048576).toFixed(1)} MB  ${ms} ms`);
    console.log(`items=${scene.items.length} images=${imgs.length} structured=${scene.structured}`);
    console.log('notice:', scene.notice ?? '(无)');
    for (const item of imgs.slice(0, 40)) {
      console.log(`  ${item.name.slice(0, 42).padEnd(42)} x=${Math.round(item.x).toString().padStart(7)} y=${Math.round(item.y).toString().padStart(7)} w=${Math.round(item.width).toString().padStart(5)} h=${Math.round(item.height).toString().padStart(5)} rot=${item.rotation.toFixed(1)} ${((item.bytes?.length ?? 0) / 1024).toFixed(0)}KB ${item.mimeType}`);
    }
    if (imgs.length > 40) console.log(`  ... 另有 ${imgs.length - 40} 张`);
  } catch (error) {
    console.log(`\n=== ${file}: FAIL ${error.message}`);
  }
}
