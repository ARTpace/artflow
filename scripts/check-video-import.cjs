// Metadata lifecycle checks using the actual editable plugin, without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugins/builtin.media/plugin.js'), 'utf8');

async function check(mode, managed = true) {
  let handler;
  let timer;
  let cleared = 0;
  let paused = 0;
  let unloaded = 0;
  let revoked = 0;
  let src = '';
  let removed = false;
  const probe = {
    videoWidth: 1920, videoHeight: 1080,
    pause() { paused++; },
    removeAttribute(name) { assert.equal(name, 'src'); src = ''; removed = true; },
    load() { assert.equal(src, ''); assert.equal(this.onloadedmetadata, null); assert.equal(this.onerror, null); unloaded++; },
    set src(value) {
      src = value;
      queueMicrotask(() => {
        if (mode === 'metadata') this.onloadedmetadata();
        else if (mode === 'error') this.onerror();
        else timer();
      });
    },
  };
  const expectedUrl = managed ? 'blob:fixture' : 'data:video/mp4;base64,AA==';
  vm.runInNewContext(source, {
    Artflow: {
      constants: { VIDEO_EXTENSIONS: ['mp4'] },
      host: { hasManagedProjectStorage: () => managed, fileToDataUrl: async () => ({ dataUrl: expectedUrl, mimeType: 'video/mp4' }) },
      definePlugin(plugin) { plugin.activate({ contributions: { register(slot, entry) { handler = entry.value; } } }); },
    },
    URL: { createObjectURL: () => expectedUrl, revokeObjectURL() { revoked++; } },
    document: { createElement(tag) { assert.equal(tag, 'video'); return probe; } },
    setTimeout(callback, ms) { assert.equal(ms, 10000); timer = callback; return 42; },
    clearTimeout(id) { assert.equal(id, 42); cleared++; },
  });
  const result = await handler.parse({ name: 'clip.mp4', type: 'video/mp4', size: 1024 });
  assert.equal(result.dataUrl, expectedUrl);
  assert.equal(result.width, mode === 'metadata' ? 1920 : 800);
  assert.equal(result.height, mode === 'metadata' ? 1080 : 450);
  assert.equal(result.fileSize, 1024);
  assert.equal(paused, 1);
  assert.equal(unloaded, 1);
  assert.equal(cleared, 1);
  assert.equal(removed, true);
  assert.equal(revoked, 0, 'the returned runtime URL must remain valid for playback/save');
  timer();
  assert.equal(unloaded, 1, 'late completion cannot unload twice');
}
(async () => {
  for (const managed of [true, false]) {
    for (const mode of ['metadata', 'error', 'timeout']) await check(mode, managed);
  }
  console.log('video import checks: ok (managed/JSON metadata, error, timeout, cleanup and live URL ownership)');
})().catch(error => { console.error(error); process.exitCode = 1; });
