const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { validateVideoResolveUrl, validateExternalVideoUrl, createVideoShortUrlResolver } = require('../main/onlineVideo.cjs');

function mockNetwork(steps, timers = {}) {
  const calls = [];
  const requests = [];
  const responses = [];
  const resolve = createVideoShortUrlResolver({
    ...timers,
    request(url, options, callback) {
      calls.push({ url: url.href, options });
      const req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; };
      req.end = () => queueMicrotask(() => {
        const step = steps[calls.length - 1];
        if (!step) return req.emit('error', new Error('Unexpected request'));
        if (step.hang) return;
        if (step.error) return req.emit('error', new Error(step.error));
        const response = new EventEmitter();
        response.statusCode = step.status;
        response.headers = step.location === undefined ? {} : { location: step.location };
        response.destroy = () => { response.destroyed = true; };
        response.on('newListener', name => assert.notEqual(name, 'data', 'must not read bodies'));
        responses.push(response);
        callback(response);
      });
      requests.push(req);
      return req;
    },
  });
  return { resolve, calls, requests, responses };
}

async function main() {
  for (const input of [null, {}, '', 'http://b23.tv/a', 'https://b23.tv:443/a', 'https://b23.tv:444/a',
    'https://u:p@b23.tv/a', 'https://@b23.tv/a', 'https://b23.tv.evil.test/a', 'https://evil.test/a',
    'https://b23.tv./a', 'https://127.0.0.1/a', 'https://b23.tv\\@evil.test/a', 'https:b23.tv/a', 'https://b23.tv/\na']) {
    assert.throws(() => validateVideoResolveUrl(input), undefined, String(input));
  }
  assert.equal(validateVideoResolveUrl('/next', new URL('https://b23.tv/a')).href, 'https://b23.tv/next');
  assert.equal(validateExternalVideoUrl('http://example.com:8080/a'), 'http://example.com:8080/a');
  for (const input of ['file:///x', 'javascript:alert(1)', 'https://u:p@example.com', 'https://@example.com', null]) {
    assert.throws(() => validateExternalVideoUrl(input));
  }

  const ok = mockNetwork([
    { status: 302, location: '/next' },
    { status: 307, location: 'https://www.bilibili.com/video/BVtest?p=2#fragment' },
    { status: 200 },
  ]);
  assert.equal(await ok.resolve('https://b23.tv/abc'), 'https://www.bilibili.com/video/BVtest?p=2');
  assert.equal(ok.calls.length, 3);
  assert.ok(ok.responses.every(response => response.destroyed));
  for (const { options } of ok.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.agent, false);
    assert.deepEqual(Object.keys(options.headers), ['User-Agent']);
  }
  for (const location of ['https://evil.test/a', 'http://www.bilibili.com/video/x', 'https://www.bilibili.com:443/a',
    'https://u@b23.tv/a', 'https://api.bilibili.com/a', 'https://bilibili.com.evil.test/a', 'https://127.0.0.1/a', 'https:evil.test']) {
    const bad = mockNetwork([{ status: 302, location }]);
    await assert.rejects(bad.resolve('https://b23.tv/a'));
    assert.equal(bad.calls.length, 1, 'blocked redirect must never be requested');
  }
  for (const step of [{ status: 302 }, { status: 404 }, { status: 200 }, { error: 'network failed' }]) {
    await assert.rejects(mockNetwork([step]).resolve('https://b23.tv/a'));
  }
  const limitOk = mockNetwork([
    ...Array.from({ length: 3 }, (_, i) => ({ status: 302, location: `/hop${i}` })),
    { status: 302, location: 'https://m.bilibili.com/video/BVtest' }, { status: 200 },
  ]);
  assert.equal(await limitOk.resolve('https://b23.tv/a'), 'https://m.bilibili.com/video/BVtest');
  assert.equal(limitOk.calls.length, 5);
  const loop = mockNetwork(Array.from({ length: 5 }, () => ({ status: 302, location: '/loop' })));
  await assert.rejects(loop.resolve('https://b23.tv/a'), /Too many/);
  assert.equal(loop.calls.length, 5);
  const initial = mockNetwork([]);
  await assert.rejects(initial.resolve('https://www.bilibili.com/video/x'), /Only b23.tv/);
  assert.equal(initial.calls.length, 0);

  let fireTimeout;
  let timerCount = 0;
  let cleared = false;
  const timeout = mockNetwork([{ status: 302, location: '/slow' }, { hang: true }], {
    setTimer(fn, ms) { assert.equal(ms, 8000); timerCount++; fireTimeout = fn; return 7; },
    clearTimer(id) { assert.equal(id, 7); cleared = true; },
  });
  const pending = timeout.resolve('https://b23.tv/a');
  const rejected = assert.rejects(pending, /timed out/);
  await new Promise(resolve => setImmediate(resolve));
  fireTimeout();
  await rejected;
  assert.equal(timerCount, 1, 'one total deadline, not a per-hop timeout');
  assert.ok(cleared && timeout.requests.at(-1).destroyed);

  // Verify the actual preload bridge without starting Electron.
  const bridges = {};
  const invoked = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(name, bridge) { bridges[name] = bridge; } },
        ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve(); } } };
    }, process: { platform: 'win32' }, window: { addEventListener() {} },
  });
  await bridges.artflowApp.resolveVideoShortUrl('https://b23.tv/a');
  await bridges.artflowApp.openVideoLink('https://www.bilibili.com/video/x');
  assert.deepEqual(invoked, [
    ['artflow-app:resolve-video-short-url', 'https://b23.tv/a'],
    ['artflow-app:open-video-link', 'https://www.bilibili.com/video/x'],
  ]);
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  for (const name of ['resolveVideoShortUrl', 'openVideoLink']) {
    assert.match(source, new RegExp(`ipcMain\\.handle\\(CHANNELS\\.${name}, [\\s\\S]*?assertTrustedRenderer\\(event\\);`));
  }
  assert.match(source, /await shell\.openExternal\(validateExternalVideoUrl\(url\)\)/);
  console.log('online-video main checks passed (URL policy, redirect simulations, total timeout, preload IPC and trusted sender wiring)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
