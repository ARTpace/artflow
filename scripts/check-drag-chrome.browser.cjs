// Optional Chrome/Vite integration test: while images are being dragged the chrome
// hugging the selection (toolbar above it, round extend button on its right,
// resize/rotate handles) must disappear, and come back on release. Covers both the
// single-image drag and the whole-set drag of a multi selection.
// Isolated headless browser; no project opened or changed.
// Run: node scripts/check-drag-chrome.browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.resolve(root, '../scratch/import-worker-tools/node_modules/playwright-core'));

(async () => {
  process.chdir(root);
  const { createServer } = await import('vite');
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const port = server.httpServer.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 806 } });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('svg.w-full.h-full.block').waitFor();

    // 带标签的等待：超时信息要能直接指出是哪一步没等到，否则只剩一句 “Timeout”。
    const waitFor = async (label, predicate, timeout = 30000) => {
      try {
        await page.waitForFunction(predicate, null, { timeout });
      } catch {
        throw new Error(`wait failed: ${label}（当前 ${JSON.stringify(await state())}）`);
      }
    };

    // 只读探测：周边控件 = 缩放手柄 + 画布内工具条（选区/元素工具条）+ 右侧圆形扩展按钮。
    const state = () => page.evaluate(() => {
      const toRect = node => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return {
        handles: document.querySelectorAll('[data-handle]').length,
        canvasToolbars: document.querySelectorAll('svg foreignObject [data-bp-ui-surface]').length,
        extendButtons: [...document.querySelectorAll('[data-bp-ui-surface]')].filter(node =>
          node.classList.contains('flex-col') && getComputedStyle(node).position === 'fixed').length,
        images: document.querySelectorAll('svg image[data-element-id]').length,
        rects: [...document.querySelectorAll('svg image[data-element-id]')].map(toRect),
      };
    });

    const findBlank = () => page.evaluate(() => {
      const svg = document.querySelector('svg.w-full.h-full.block');
      const box = svg.getBoundingClientRect();
      for (const [u, v] of [[.08, .85], [.92, .85], [.08, .1], [.92, .1], [.5, .92]]) {
        const x = Math.round(box.left + box.width * u);
        const y = Math.round(box.top + box.height * v);
        if (document.elementFromPoint(x, y) === svg) return { x, y };
      }
      return null;
    });
    const grabInside = (rect, u = 0.3, v = 0.7) => ({
      x: Math.round(rect.x + rect.width * u),
      y: Math.round(rect.y + rect.height * v),
    });
    const dragBy = async (from, dx, dy) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
    };
    // 拖动位移按屏幕像素算，渲染位置应当正好跟着鼠标走；返回真正动了的图下标。
    const movedIndexes = (before, during, dx, dy) => during.rects
      .map((rect, index) => (Math.abs(rect.x - before.rects[index].x - dx) < 8
        && Math.abs(rect.y - before.rects[index].y - dy) < 8 ? index : -1))
      .filter(index => index >= 0);

    // 一次拖进来两张图。导入完成后两张图是整批选中的，正好覆盖“多选整体拖动”。
    await page.evaluate(async () => {
      const transfer = new DataTransfer();
      for (let i = 0; i < 2; i++) {
        const canvas = document.createElement('canvas');
        canvas.width = 420; canvas.height = 300;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = i ? '#4d7ea8' : '#d4aa80'; ctx.fillRect(0, 0, 420, 300);
        ctx.fillStyle = '#faf4d5'; ctx.font = 'bold 72px sans-serif'; ctx.fillText(`#${i + 1}`, 60, 180);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        transfer.items.add(new File([blob], `drag-chrome-${i + 1}.png`, { type: 'image/png' }));
      }
      document.querySelector('#root').firstElementChild.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, clientX: 600, clientY: 420, dataTransfer: transfer,
      }));
    });
    await waitFor('投递图片后画布出现两张图', () => document.querySelectorAll('svg image[data-element-id]').length === 2
      && !document.querySelector('[data-bp-import-reveal="active"]'));

    // 阶段一：多选整体拖动。
    const multiBefore = await state();
    assert.ok(multiBefore.canvasToolbars > 0, '多选时上方工具条必须出现');
    assert.ok(multiBefore.extendButtons > 0, '多选时右侧圆形扩展按钮必须出现');
    await dragBy(grabInside(multiBefore.rects[0]), 46, 24);
    await waitFor('多选拖动中画布内工具条隐藏', () =>
      document.querySelectorAll('svg foreignObject [data-bp-ui-surface]').length === 0, 5000);
    const multiDragging = await state();
    assert.equal(movedIndexes(multiBefore, multiDragging, 46, 24).length, 2, '多选整体拖动：两张图必须一起走');
    assert.equal(multiDragging.extendButtons, 0, '多选拖动中右侧圆形扩展按钮必须隐藏');
    await page.mouse.up();
    await waitFor('多选松手后画布内工具条恢复', () =>
      document.querySelectorAll('svg foreignObject [data-bp-ui-surface]').length > 0, 5000);

    // 阶段二：单选拖动（截图场景：上方工具条 + 右侧圆形扩展按钮 + 缩放手柄）。
    const blank = await findBlank();
    assert.ok(blank, '找不到空白处，无法取消选中');
    await page.mouse.click(blank.x, blank.y);
    await waitFor('点击空白后取消选中', () =>
      document.querySelectorAll('svg foreignObject [data-bp-ui-surface]').length === 0, 5000);

    const singleBefore = await state();
    const pick = grabInside(singleBefore.rects[0], 0.5, 0.62);
    await page.mouse.click(pick.x, pick.y);
    await waitFor('单选图片后出现缩放手柄', () => document.querySelectorAll('[data-handle]').length > 0);
    const selected = await state();
    assert.ok(selected.canvasToolbars > 0, '选中图片后上方工具条必须出现');
    assert.ok(selected.extendButtons > 0, '选中图片后右侧圆形扩展按钮必须出现');

    await dragBy(grabInside(selected.rects[0]), -52, -28);
    await waitFor('拖动中缩放手柄隐藏', () => document.querySelectorAll('[data-handle]').length === 0, 5000);
    const dragging = await state();
    assert.equal(movedIndexes(selected, dragging, -52, -28).length, 1, '单选拖动：只有被拖的那张图跟着走');
    assert.equal(dragging.canvasToolbars, 0, '拖动中图片上方工具条必须隐藏');
    assert.equal(dragging.extendButtons, 0, '拖动中图片右侧圆形扩展按钮必须隐藏');
    assert.equal(dragging.handles, 0, '拖动中缩放手柄/旋转手柄必须隐藏');

    await page.mouse.up();
    await waitFor('松手后缩放手柄恢复', () => document.querySelectorAll('[data-handle]').length > 0, 5000);
    // 扩展按钮由 App 层的 smartToolbarState 恢复，落在手柄之后一帧左右；
    // 紧跟手柄断言会踩到竞态，这里同样等它回来再断言。
    await waitFor('松手后右侧圆形扩展按钮恢复', () => [...document.querySelectorAll('[data-bp-ui-surface]')].filter(node =>
      node.classList.contains('flex-col') && getComputedStyle(node).position === 'fixed').length > 0, 5000);
    const released = await state();
    assert.ok(released.canvasToolbars > 0, '松手后上方工具条必须恢复');
    assert.ok(released.extendButtons > 0, '松手后右侧圆形扩展按钮必须恢复');

    assert.deepEqual(errors, [], 'no renderer exceptions');
    console.log('Headless drag chrome visibility (single + multi): PASS');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
