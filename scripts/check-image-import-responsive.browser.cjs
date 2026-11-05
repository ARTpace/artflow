// Optional isolated Chrome smoke test. Uses a local Vite fixture, not the user's
// Electron window or project. Install playwright-core in ../../scratch/import-worker-tools.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.resolve(root, '../scratch/import-worker-tools/node_modules/playwright-core'));

(async () => {
  process.chdir(root);
  const { createServer } = await import('vite');
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert.ok(port > 0, 'local fixture port');
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.route('**/import-worker-fixture', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="result"></div></body></html>',
    }));
    await page.goto(`http://127.0.0.1:${port}/import-worker-fixture`);
    const result = await page.evaluate(async () => {
      const RealWorker = window.Worker;
      let startedWorkers = 0;
      window.Worker = class extends RealWorker {
        constructor(...args) { super(...args); startedWorkers++; }
      };
      const { readAndCompressImage } = await import('/utils/fileUtils.ts');
      const canvas = document.createElement('canvas');
      canvas.width = 3600;
      canvas.height = 2400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#c93272';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < 200; i++) {
        ctx.fillStyle = `rgb(${i % 250},${(3 * i) % 250},${(5 * i) % 250})`;
        ctx.fillRect((i * 53) % canvas.width, (i * 67) % canvas.height, 31, 31);
      }
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .88));
      const image = new File([jpeg], 'large.jpg', { type: 'image/jpeg' });
      const gaps = [];
      let running = true;
      let last = performance.now();
      function tick(now) { gaps.push(now - last); last = now; if (running) requestAnimationFrame(tick); }
      requestAnimationFrame(tick);
      const started = performance.now();
      const prepared = await readAndCompressImage(image);
      const duration = performance.now() - started;
      running = false;
      if (!prepared.originalDataUrl || !prepared.originalDataUrl.startsWith('data:image/jpeg')) throw Error('original JPEG missing');
      if (!prepared.thumbnailDataUrl?.startsWith('data:image/jpeg')) throw Error('thumbnail MIME mismatch');
      if (!prepared.mediumDataUrl?.startsWith('data:image/jpeg')) throw Error('medium MIME mismatch');
      if (!prepared.dataUrl?.startsWith('data:image/jpeg')) throw Error('proxy MIME mismatch');
      if (prepared.width !== 3600 || prepared.height !== 2400) throw Error('dimensions lost');
      if (startedWorkers !== 1) throw Error(`expected one image worker, saw ${startedWorkers}`);
      const lengths = [prepared.thumbnailDataUrl.length, prepared.mediumDataUrl.length, prepared.dataUrl.length];
      if (!(lengths[0] < lengths[1] && lengths[1] < lengths[2])) throw Error('proxy sizes not tiered');
      // Distinct codec: the existing renderer fallback still works without worker APIs.
      const savedOffscreen = window.OffscreenCanvas;
      window.OffscreenCanvas = undefined;
      const fallback = await readAndCompressImage(image);
      window.OffscreenCanvas = savedOffscreen;
      if (fallback.width !== prepared.width || fallback.height !== prepared.height || !fallback.originalDataUrl) {
        throw Error('legacy fallback did not preserve image contract');
      }
      return { workerStarted: startedWorkers, mime: prepared.mimeType, dimensions: [prepared.width, prepared.height],
        encodedBytes: image.size, tierUrlLengths: lengths, durationMs: Math.round(duration),
        frameGapsMs: gaps.slice(1).map(ms => Math.round(ms)), fallback: 'ok' };
    });
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    console.log(JSON.stringify(result, null, 2));
    console.log('checks: real Chrome image import worker + legacy fallback ok');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
