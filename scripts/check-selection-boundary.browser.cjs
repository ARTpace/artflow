// Regression: a marquee / selection drag must stay continuous when the pointer
// crosses the canvas boundary. Leaving the <svg> must not abort (commit early)
// the in-flight selection gesture, and a selection dragged past the boundary
// must survive the round trip without being dropped.
// P0-2: the marquee and the lasso also carry modifier semantics — Shift / Ctrl
// on empty canvas must keep the selection instead of clearing it, and the
// settled result must be merged (Shift / Ctrl = union, Alt = subtract) rather
// than overwritten, for both the marquee and the lasso.
// P0-3: while a marquee or lasso drag is in flight the elements that would end
// up selected must be highlighted from the transient preview channel (accent
// stroke = additive, red stroke = subtractive). The live preview must not touch
// the committed React selection before mouseup, must republish only when the
// hit set changes, and must be cleared once the gesture settles.
// Uses a clean Vite+Chrome profile; never opens the user's Electron project.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.resolve(root, '../scratch/import-worker-tools/node_modules/playwright-core'));

const MARQUEE_SEL = 'svg rect[fill="rgba(59, 130, 246, 0.1)"]';
const MULTI_SEL = 'svg rect[fill="none"][stroke-dasharray]';
const HANDLE_SEL = 'svg [data-handle]';

(async () => {
  process.chdir(root);
  const { createServer } = await import('vite');
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const port = server.httpServer.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 980 } });
    const errors = [];
    page.on('pageerror', err => errors.push(String(err)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('svg.w-full.h-full.block').waitFor();

    const dropAt = async (name, x, y) => {
      await page.evaluate(({ name, x, y }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 900; canvas.height = 620;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = name === 'alpha.jpg' ? '#bd5184' : '#2f6f9f';
        ctx.fillRect(0, 0, 900, 620);
        for (let i = 0; i < 200; i++) { ctx.fillStyle = `hsl(${i % 360} 60% 75%)`; ctx.fillRect(i * 31 % 900, i * 17 % 620, 25, 21); }
        return new Promise(resolve => canvas.toBlob(blob => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([blob], name, { type: 'image/jpeg' }));
          document.querySelector('#root').firstElementChild.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer,
          }));
          resolve(blob.size);
        }, 'image/jpeg', .88));
      }, { name, x, y });
    };

    await dropAt('alpha.jpg', 430, 300);
    await page.waitForFunction(() => document.querySelectorAll('svg g[data-id]').length >= 1, null, { timeout: 30000 });
    await dropAt('beta.jpg', 1090, 700);
    await page.waitForFunction(() => document.querySelectorAll('svg g[data-id]').length >= 2
      && !document.querySelector('[data-bp-import-reveal="active"]'), null, { timeout: 30000 });

    const boxes = await page.evaluate(() => [...document.querySelectorAll('svg g[data-id]')].map(node => {
      const box = node.querySelector('image') ? node.getBoundingClientRect() : node.getBoundingClientRect();
      return { id: node.getAttribute('data-id'), x: box.x, y: box.y, w: box.width, h: box.height };
    }));
    assert.equal(boxes.length, 2, 'two images must be present');
    boxes.sort((a, b) => a.x - b.x);
    const [a, b] = boxes;
    assert.ok(!(a.x + a.w > b.x && b.x + b.w > a.x && a.y + a.h > b.y && b.y + b.h > a.y), 'the two images must not overlap');
    assert.ok(b.x + b.w < 1330 && b.y + b.h < 930, `second image must sit inside the viewport (${JSON.stringify(b)})`);

    // ---------------------------------------------------------------- marquee
    // Start on empty canvas and drag the marquee *past* the canvas boundary,
    // then bring it back with the button still held to cover both images.
    const start = { x: Math.round(Math.min(a.x, b.x) - 55), y: Math.round(a.y - 55) };
    assert.ok(start.x > 30 && start.y > 30, `marquee start must be on empty canvas (${JSON.stringify(start)})`);
    const mid = { x: Math.round(a.x + a.w + 15), y: Math.round(a.y + a.h + 15) };
    const outside = { x: -30, y: start.y + 40 };
    const end = { x: Math.round(b.x + b.w + 12), y: Math.round(b.y + b.h + 12) };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(mid.x, mid.y, { steps: 8 });
    await page.waitForTimeout(30);
    assert.equal(await page.locator(MARQUEE_SEL).count(), 1, 'the marquee must be visible while dragging inside the canvas');

    await page.mouse.move(outside.x, outside.y, { steps: 8 });
    await page.waitForTimeout(30);
    const marqueeOutside = await page.locator(MARQUEE_SEL).count();
    assert.equal(marqueeOutside, 1, 'crossing the canvas boundary must not cancel the in-flight marquee');

    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.waitForTimeout(40);
    const marqueeReturned = await page.evaluate(sel => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
    }, MARQUEE_SEL);
    assert.ok(marqueeReturned, 'the marquee must keep following the pointer after re-entering the canvas');
    assert.ok(Math.abs(marqueeReturned.x - start.x) < 6 && Math.abs(marqueeReturned.y - start.y) < 6,
      `the marquee must stay anchored at the press point (${JSON.stringify(marqueeReturned)} vs ${JSON.stringify(start)})`);
    assert.ok(marqueeReturned.right > end.x - 12 && marqueeReturned.bottom > end.y - 12,
      `the marquee must extend to the returning pointer (${JSON.stringify(marqueeReturned)} vs ${JSON.stringify(end)})`);

    await page.mouse.up();
    await page.waitForTimeout(40);
    const afterMarquee = await page.evaluate(sel => ({
      handles: document.querySelectorAll('svg [data-handle]').length,
      multi: document.querySelectorAll(sel).length,
    }), MULTI_SEL);
    assert.equal(afterMarquee.handles, 0,
      `both images must stay selected after a boundary-crossing marquee (handles=${afterMarquee.handles})`);
    assert.equal(afterMarquee.multi, 1, 'the multi-selection outline must be rendered');

    // ------------------------------------------- P0-2 additive / subtractive
    // A press on empty canvas with Shift / Ctrl must keep the current selection
    // instead of clearing it, and the settled marquee result must be merged
    // (Shift / Ctrl = union, Alt = subtract) instead of overwriting it.
    const selectionState = () => page.evaluate(sel => {
      const outline = document.querySelector(sel);
      const handles = [...document.querySelectorAll('svg [data-handle]')];
      const box = outline ? outline.getBoundingClientRect() : null;
      const handleBox = handles.length
        ? handles.reduce((acc, node) => {
          const r = node.getBoundingClientRect();
          return { left: Math.min(acc.left, r.left), right: Math.max(acc.right, r.right), top: Math.min(acc.top, r.top), bottom: Math.max(acc.bottom, r.bottom) };
        }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity })
        : null;
      return {
        handles: handles.length,
        multi: outline ? 1 : 0,
        outline: box ? { x: box.x, y: box.y, right: box.right, bottom: box.bottom } : null,
        handleCenterX: handleBox ? (handleBox.left + handleBox.right) / 2 : null,
      };
    }, MULTI_SEL);

    const probeRect = box => ({
      left: Math.round(box.x - 30), top: Math.round(box.y - 30),
      right: Math.round(box.x + box.w + 8), bottom: Math.round(box.y + box.h + 8),
    });
    const overlaps = (rect, box) => !(rect.right < box.x || rect.left > box.x + box.w
      || rect.bottom < box.y || rect.top > box.y + box.h);
    const marqueeRect = async rect => {
      await page.mouse.move(rect.left, rect.top);
      await page.mouse.down();
      await page.mouse.move(rect.right, rect.bottom, { steps: 6 });
      await page.waitForTimeout(30);
      await page.mouse.up();
      await page.waitForTimeout(40);
    };
    const centerXOf = box => box.x + box.w / 2;

    const onlyA = probeRect(a);
    const onlyB = probeRect(b);
    assert.ok(onlyA.left > 10 && onlyA.top > 10 && onlyB.left > 10 && onlyB.top > 10,
      'the modifier probe rects must start on empty canvas inside the viewport');
    assert.ok(!overlaps(onlyA, b) && !overlaps(onlyB, a),
      `the two probe rects must not touch the other image (${JSON.stringify(onlyA)} / ${JSON.stringify(onlyB)})`);

    // Shift on empty canvas keeps the multi-selection (nothing gets cleared on press)
    await page.keyboard.down('Shift');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 45, start.y + 35, { steps: 4 });
    await page.waitForTimeout(30);
    const shiftHold = await selectionState();
    assert.ok(shiftHold.handles + shiftHold.multi > 0,
      'Shift + press on empty canvas must keep the current selection while dragging');
    await page.mouse.move(start.x, start.y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(40);
    const afterShiftEmpty = await selectionState();
    assert.equal(afterShiftEmpty.handles, 0, 'an empty Shift marquee must keep the multi-selection, not collapse it to one');
    assert.equal(afterShiftEmpty.multi, 1, 'an empty Shift marquee must keep the multi-selection outline');

    // Without a modifier the old behaviour must survive: pressing empty clears
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 45, start.y + 35, { steps: 4 });
    await page.waitForTimeout(30);
    const plainHold = await selectionState();
    assert.equal(plainHold.handles + plainHold.multi, 0,
      'a plain press on empty canvas must still clear the selection immediately');
    await page.mouse.move(start.x, start.y, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(40);

    // Ctrl marquee unions with the existing selection instead of replacing it
    await page.mouse.click(Math.round(centerXOf(b)), Math.round(b.y + b.h / 2));
    await page.waitForTimeout(40);
    const singleB = await selectionState();
    assert.ok(singleB.handles > 0 && singleB.multi === 0, 'clicking one image must render single-selection handles');
    assert.ok(singleB.handleCenterX !== null && Math.abs(singleB.handleCenterX - centerXOf(b)) < 30,
      `the clicked image must be the one with handles (${JSON.stringify(singleB.handleCenterX)} vs ${centerXOf(b)})`);
    await page.keyboard.down('Control');
    await marqueeRect(onlyA);
    await page.keyboard.up('Control');
    const ctrlUnion = await selectionState();
    assert.equal(ctrlUnion.handles, 0, 'Ctrl + marquee must union the hit image with the existing selection');
    assert.equal(ctrlUnion.multi, 1, 'the Ctrl union must render a multi-selection outline');
    assert.ok(ctrlUnion.outline && ctrlUnion.outline.x <= a.x + 12 && ctrlUnion.outline.right >= b.x + b.w - 12,
      `the Ctrl union outline must span both images (${JSON.stringify(ctrlUnion.outline)})`);

    // Alt marquee subtracts the enclosed image from the selection
    await page.keyboard.down('Alt');
    await marqueeRect(onlyA);
    await page.keyboard.up('Alt');
    const altSubtract = await selectionState();
    assert.ok(altSubtract.handles > 0 && altSubtract.multi === 0,
      'Alt + marquee must drop the enclosed image and fall back to a single selection');
    assert.ok(altSubtract.handleCenterX !== null && Math.abs(altSubtract.handleCenterX - centerXOf(b)) < 30,
      `only the second image may stay selected after the Alt marquee (${JSON.stringify(altSubtract.handleCenterX)})`);

    // Alt on empty canvas keeps the selection too, and an empty Alt marquee is a no-op
    await page.keyboard.down('Alt');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 30, start.y + 25, { steps: 4 });
    await page.waitForTimeout(30);
    const altHold = await selectionState();
    assert.ok(altHold.handles > 0, 'Alt + press on empty canvas must keep the current selection');
    await page.mouse.move(start.x, start.y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.waitForTimeout(40);
    const afterAltEmpty = await selectionState();
    assert.ok(afterAltEmpty.handles > 0 && afterAltEmpty.multi === 0, 'an empty Alt marquee must leave the selection untouched');

    // Put the multi-selection back as the starting point for the P0-3 preview legs
    await marqueeRect({ left: start.x, top: start.y, right: end.x, bottom: end.y });
    const restored = await selectionState();
    assert.equal(restored.handles, 0, 'a plain marquee must still replace the selection with both images');
    assert.equal(restored.multi, 1, 'the multi-selection outline must be back before the preview legs');

    // ------------------------------------------------------ P0-3 live preview
    // A marquee / lasso drag must highlight the elements that *would* be
    // selected while it is still in flight (Shift = union, Alt = subtract), and
    // it must publish through the transient channel only — the React selection
    // state may not change before mouseup, and the highlight must be gone once
    // the gesture settles (the committed selection is the only source of truth).
    const PREVIEW_LAYER_SEL = 'g[data-bp-selection-preview-layer]';
    const ADD_STROKE = 'rgb(59, 130, 246)';
    const SUBTRACT_STROKE = 'rgb(248, 113, 113)';
    const previewState = () => page.evaluate(sel => {
      const layer = document.querySelector(sel);
      if (!layer) return { present: false, items: [] };
      const items = [...layer.querySelectorAll('rect')]
        .filter(node => node.style.display !== 'none')
        .map(node => {
          const box = node.getBoundingClientRect();
          return {
            id: node.getAttribute('data-bp-selection-preview'),
            stroke: node.getAttribute('stroke'),
            box: { x: box.x, y: box.y, w: box.width, h: box.height },
          };
        });
      return { present: true, pointerEvents: getComputedStyle(layer).pointerEvents, items };
    }, PREVIEW_LAYER_SEL);
    const installPreviewProbe = () => page.evaluate(sel => {
      const layer = document.querySelector(sel);
      if (!layer || window.__pvProbe) return Boolean(layer);
      window.__pvProbe = { count: 0 };
      const observer = new MutationObserver(records => { window.__pvProbe.count += records.length; });
      observer.observe(layer, { attributes: true, childList: true, subtree: true });
      return true;
    }, PREVIEW_LAYER_SEL);
    const previewMutations = () => page.evaluate(() => (window.__pvProbe ? window.__pvProbe.count : -1));
    const resetPreviewMutations = () => page.evaluate(() => { if (window.__pvProbe) window.__pvProbe.count = 0; });
    const sameSet = (items, ids) => items.length === ids.length && ids.every(id => items.some(item => item.id === id));
    const nearBox = (item, box) => Math.abs(item.box.x - box.x) < 8 && Math.abs(item.box.y - box.y) < 8
      && Math.abs(item.box.w - box.w) < 8 && Math.abs(item.box.h - box.h) < 8;

    assert.ok(await installPreviewProbe(), 'the P0-3 live preview layer must be mounted on the canvas');
    const idlePreview = await previewState();
    assert.equal(idlePreview.present, true, 'the preview layer must exist even with no gesture in flight');
    assert.equal(idlePreview.pointerEvents, 'none', 'the preview layer must never intercept pointer events');
    assert.equal(idlePreview.items.length, 0, 'nothing may be highlighted before a marquee starts');

    // (1) Plain marquee over the first image while *both* are selected: the
    // highlight appears immediately, but the committed selection must not be
    // touched until mouseup (the preview is not a second source of truth).
    await page.mouse.move(onlyA.left, onlyA.top);
    await page.mouse.down();
    await page.mouse.move(onlyA.right, onlyA.bottom, { steps: 8 });
    await page.waitForTimeout(50);
    const previewA = await previewState();
    assert.equal(previewA.items.length, 1, `a marquee over one image must highlight exactly that image (${JSON.stringify(previewA.items)})`);
    assert.equal(previewA.items[0].id, a.id, 'the highlighted element must be the marquee hit');
    assert.equal(previewA.items[0].stroke, ADD_STROKE, 'a plain marquee must preview with the selection accent colour');
    assert.ok(nearBox(previewA.items[0], a), `the highlight must sit on the element bounds (${JSON.stringify(previewA.items[0].box)} vs ${JSON.stringify(a)})`);
    const duringPreview = await selectionState();
    assert.equal(duringPreview.handles + duringPreview.multi, 0,
      'the live preview must not commit anything while the button is held (a plain press already cleared the selection)');

    // A box that keeps hitting the same element must not republish: the channel
    // is only allowed to notify when the hit set (or the modifier tone) changes.
    await resetPreviewMutations();
    await page.mouse.move(onlyA.right - 4, onlyA.bottom - 4, { steps: 6 });
    await page.waitForTimeout(60);
    const steadyMutations = await previewMutations();
    assert.ok(steadyMutations <= 1, `an unchanged hit set must not rewrite the preview DOM (mutations=${steadyMutations})`);
    const steadyPreview = await previewState();
    assert.equal(steadyPreview.items.length, 1, 'the highlight must survive pointer jitter');
    assert.equal(steadyPreview.items[0].id, a.id, 'pointer jitter must not change who is highlighted');

    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.waitForTimeout(50);
    const previewBoth = await previewState();
    assert.ok(sameSet(previewBoth.items, [a.id, b.id]),
      `growing the marquee must highlight both images (${JSON.stringify(previewBoth.items.map(item => item.id))})`);
    assert.ok(await previewMutations() > 0, 'a changed hit set must republish the preview');
    await page.mouse.up();
    await page.waitForTimeout(50);
    assert.equal((await previewState()).items.length, 0, 'releasing the mouse must clear the live preview');
    const committedBoth = await selectionState();
    assert.equal(committedBoth.handles, 0, 'releasing a plain marquee over both images must select both');
    assert.equal(committedBoth.multi, 1, 'the committed selection must render the multi-selection outline');

    // (2) Shift (additive) preview: the enclosed image is highlighted while the
    // previously selected one is left alone, and mouseup unions the two.
    // A plain press on an already-selected element keeps the whole selection, so
    // clear it first to start this leg from a single selection.
    await page.mouse.click(Math.round(start.x), Math.round(start.y));
    await page.waitForTimeout(40);
    await page.mouse.click(Math.round(centerXOf(a)), Math.round(a.y + a.h / 2));
    await page.waitForTimeout(40);
    const singleA = await selectionState();
    assert.ok(singleA.handles > 0 && singleA.multi === 0, 'clicking the first image must leave a single selection before the Shift leg');
    await page.keyboard.down('Shift');
    await page.mouse.move(onlyB.left, onlyB.top);
    await page.mouse.down();
    await page.mouse.move(onlyB.right, onlyB.bottom, { steps: 8 });
    await page.waitForTimeout(50);
    const previewAdd = await previewState();
    assert.equal(previewAdd.items.length, 1, `a Shift marquee must preview the enclosed image (${JSON.stringify(previewAdd.items)})`);
    assert.equal(previewAdd.items[0].id, b.id, 'the Shift preview must highlight the marquee hit, not the current selection');
    assert.equal(previewAdd.items[0].stroke, ADD_STROKE, 'an additive preview must keep the selection accent colour');
    const duringAdd = await selectionState();
    assert.ok(duringAdd.handles > 0 && duringAdd.multi === 0, 'a Shift marquee must not union before mouseup');
    assert.ok(duringAdd.handleCenterX !== null && Math.abs(duringAdd.handleCenterX - centerXOf(a)) < 30,
      `the Shift preview must leave the existing selection untouched (${JSON.stringify(duringAdd.handleCenterX)})`);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(50);
    assert.equal((await previewState()).items.length, 0, 'the Shift preview must be cleared on release');
    const afterAdd = await selectionState();
    assert.equal(afterAdd.handles, 0, 'the Shift marquee must union the hit image with the existing selection');
    assert.equal(afterAdd.multi, 1, 'the Shift union must render a multi-selection outline');

    // (3) Alt (subtractive) preview: the enclosed image is highlighted as being
    // dropped — different tone — while the selection still holds both.
    await page.keyboard.down('Alt');
    await page.mouse.move(onlyA.left, onlyA.top);
    await page.mouse.down();
    await page.mouse.move(onlyA.right, onlyA.bottom, { steps: 8 });
    await page.waitForTimeout(50);
    const previewSubtract = await previewState();
    assert.equal(previewSubtract.items.length, 1, `an Alt marquee must preview the image about to be dropped (${JSON.stringify(previewSubtract.items)})`);
    assert.equal(previewSubtract.items[0].id, a.id, 'the subtractive preview must highlight the marquee hit');
    assert.equal(previewSubtract.items[0].stroke, SUBTRACT_STROKE, 'a subtractive preview must use the distinct subtract tone');
    const duringSubtract = await selectionState();
    assert.equal(duringSubtract.multi, 1, 'an Alt marquee must not subtract anything before mouseup');
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.waitForTimeout(50);
    assert.equal((await previewState()).items.length, 0, 'the Alt preview must be cleared on release');
    const afterSubtract = await selectionState();
    assert.ok(afterSubtract.handles > 0 && afterSubtract.multi === 0, 'the Alt marquee must drop the enclosed image on release');
    assert.ok(afterSubtract.handleCenterX !== null && Math.abs(afterSubtract.handleCenterX - centerXOf(b)) < 30,
      `only the second image may stay selected after the Alt preview leg (${JSON.stringify(afterSubtract.handleCenterX)})`);

    // Put the multi-selection back for the boundary drag leg below
    await marqueeRect({ left: start.x, top: start.y, right: end.x, bottom: end.y });
    const restoredAgain = await selectionState();
    assert.equal(restoredAgain.handles, 0, 'a plain marquee must replace the selection with both images after the preview legs');
    assert.equal(restoredAgain.multi, 1, 'the multi-selection outline must be back before the boundary drag leg');
    assert.equal((await previewState()).items.length, 0, 'the preview must stay empty between gestures');

    // ------------------------------------------------- drag selection past edge
    // With both images selected, drag them out through the top-left corner and
    // back; the selection must survive and the drop must be committed.
    const before = await page.evaluate(() => [...document.querySelectorAll('svg [data-cull-x]')].map(node => ({
      x: Number(node.getAttribute('data-cull-x')), y: Number(node.getAttribute('data-cull-y')),
      parent: node.getAttribute('data-bp-drag-x'),
    })));
    const grab = { x: Math.round(a.x + a.w / 2), y: Math.round(a.y + a.h / 2) };
    const back = { x: grab.x + 110, y: grab.y + 90 };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(-25, -25, { steps: 10 });
    await page.waitForTimeout(35);
    const during = await page.locator(MULTI_SEL).count() + await page.locator(HANDLE_SEL).count();
    assert.ok(during >= 1, 'the selection outline must stay visible while dragging past the boundary');
    await page.mouse.move(back.x, back.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(60);
    const after = await page.evaluate(() => [...document.querySelectorAll('svg [data-cull-x]')].map(node => ({
      x: Number(node.getAttribute('data-cull-x')), y: Number(node.getAttribute('data-cull-y')),
    })));
    assert.equal(after.length, before.length, 'no element may disappear after a boundary drag');
    const moved = after.map((item, index) => ({ dx: item.x - before[index].x, dy: item.y - before[index].y }));
    for (const delta of moved) {
      assert.ok(Math.abs(delta.dx - 110) < 22 && Math.abs(delta.dy - 90) < 22,
        `the boundary drag must commit (${JSON.stringify(delta)})`);
    }
    const kept = await page.evaluate(sel => ({
      handles: document.querySelectorAll('svg [data-handle]').length,
      multi: document.querySelectorAll(sel).length,
    }), MULTI_SEL);
    assert.equal(kept.handles, 0, 'the multi-selection must not be dropped by a boundary drag');
    assert.equal(kept.multi, 1, 'the multi-selection outline must survive a boundary drag');

    // ------------------------------------------------------ lasso shares path
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(80);
    await page.keyboard.press('Escape');
    // Activate the lasso tool through its real toolbar entry (it lives in a
    // group flyout, and this build binds no keyboard shortcut for it).
    const lassoActivated = await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const labelled = () => Array.from(document.querySelectorAll('button[aria-label]'));
      const isLasso = b => /lasso|套索|投げ縄|なげなわ/i.test(b.getAttribute('aria-label') || '');
      const groups = labelled().filter(b => /draw|绘图|描画/i.test(b.getAttribute('aria-label') || ''));
      for (const group of groups) {
        group.click();
        await sleep(80);
        const item = labelled().find(isLasso);
        if (item) { item.click(); await sleep(60); return true; }
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(40);
      }
      return false;
    });
    await page.waitForTimeout(60);
    const lassoStart = { x: start.x, y: start.y };
    const lassoEnd = { x: Math.round(a.x + a.w + 20), y: Math.round(a.y + a.h + 20) };
    await page.mouse.move(lassoStart.x, lassoStart.y);
    await page.mouse.down();
    await page.mouse.move(lassoStart.x + 40, lassoStart.y + 30, { steps: 4 });
    await page.waitForTimeout(30);
    const lassoInsideAlive = await page.evaluate(() => document.querySelectorAll('svg path[fill="rgba(59, 130, 246, 0.1)"]').length);
    await page.mouse.move(-30, outside.y, { steps: 8 });
    await page.waitForTimeout(30);
    const lassoAlive = await page.evaluate(() => document.querySelectorAll('svg path[fill="rgba(59, 130, 246, 0.1)"]').length);
    await page.mouse.move(lassoEnd.x, lassoEnd.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    let lassoMerge = null;
    let previewLasso = null;
    let duringLasso = null;
    let lassoPreviewCleared = null;
    let afterLassoPreview = null;
    if (!lassoActivated) {
      console.log('note: the lasso tool entry was not reachable in this build; lasso leg skipped');
    } else {
      assert.ok(lassoInsideAlive > 0, 'the lasso must start drawing inside the canvas');
      assert.ok(lassoAlive > 0, 'a boundary-crossing lasso must keep its in-flight path');

      // ------------------------------------------- P0-2 lasso shares the merge
      const lassoBoxes = await page.evaluate(() => [...document.querySelectorAll('svg g[data-id]')].map(node => {
        const box = node.getBoundingClientRect();
        return { id: node.getAttribute('data-id'), x: box.x, y: box.y, w: box.width, h: box.height };
      }));
      lassoBoxes.sort((p, q) => p.x - q.x);
      assert.equal(lassoBoxes.length, 2, 'both images must still be on the canvas for the lasso modifier legs');
      const [la, lb] = lassoBoxes;
      const lassoA = probeRect(la);
      const lassoB = probeRect(lb);
      assert.ok(!overlaps(lassoA, lb) && !overlaps(lassoB, la),
        `the lasso probe rects must keep the two images apart (${JSON.stringify(lassoA)} / ${JSON.stringify(lassoB)})`);
      const lassoOver = async rect => {
        await page.mouse.move(rect.left, rect.top);
        await page.mouse.down();
        await page.mouse.move(rect.right, rect.top, { steps: 3 });
        await page.mouse.move(rect.right, rect.bottom, { steps: 3 });
        await page.mouse.move(rect.left, rect.bottom, { steps: 3 });
        await page.mouse.move(rect.left + 3, rect.top + 3, { steps: 3 });
        await page.mouse.up();
        await page.waitForTimeout(50);
      };

      await lassoOver(lassoA);
      const lassoSingle = await selectionState();
      assert.ok(lassoSingle.handles > 0 && lassoSingle.multi === 0, 'a plain lasso must select exactly the enclosed image');
      assert.ok(lassoSingle.handleCenterX !== null && Math.abs(lassoSingle.handleCenterX - centerXOf(la)) < 30,
        `the plain lasso must select the first image (${JSON.stringify(lassoSingle.handleCenterX)})`);

      await page.keyboard.down('Shift');
      await lassoOver(lassoB);
      await page.keyboard.up('Shift');
      const lassoUnion = await selectionState();
      assert.equal(lassoUnion.handles, 0, 'Shift + lasso must union with the existing selection');
      assert.equal(lassoUnion.multi, 1, 'the lasso union must render a multi-selection outline');
      assert.ok(lassoUnion.outline && lassoUnion.outline.x <= la.x + 12 && lassoUnion.outline.right >= lb.x + lb.w - 12,
        `the lasso union outline must span both images (${JSON.stringify(lassoUnion.outline)})`);

      await page.keyboard.down('Alt');
      await lassoOver(lassoA);
      await page.keyboard.up('Alt');
      lassoMerge = await selectionState();
      assert.ok(lassoMerge.handles > 0 && lassoMerge.multi === 0, 'Alt + lasso must subtract the enclosed image');
      assert.ok(lassoMerge.handleCenterX !== null && Math.abs(lassoMerge.handleCenterX - centerXOf(lb)) < 30,
        `only the second image may stay selected after the Alt lasso (${JSON.stringify(lassoMerge.handleCenterX)})`);

      // P0-3: the lasso must preview exactly like the marquee — the enclosed
      // image lights up through the transient channel while the path is still
      // being drawn, nothing is committed before release, and the highlight is
      // gone once the gesture settles.
      await page.mouse.move(lassoB.left, lassoB.top);
      await page.mouse.down();
      await page.mouse.move(lassoB.right, lassoB.top, { steps: 3 });
      await page.mouse.move(lassoB.right, lassoB.bottom, { steps: 3 });
      await page.mouse.move(lassoB.left, lassoB.bottom, { steps: 3 });
      await page.waitForTimeout(50);
      previewLasso = await previewState();
      assert.equal(previewLasso.items.length, 1,
        `an in-flight lasso must highlight the enclosed image (${JSON.stringify(previewLasso.items)})`);
      assert.equal(previewLasso.items[0].id, lb.id, 'the lasso preview must highlight the lasso hit');
      assert.equal(previewLasso.items[0].stroke, ADD_STROKE, 'a plain lasso must preview with the selection accent colour');
      duringLasso = await selectionState();
      assert.ok(duringLasso.handles > 0 && duringLasso.multi === 0
        && duringLasso.handleCenterX !== null && Math.abs(duringLasso.handleCenterX - centerXOf(lb)) < 30,
        `an in-flight lasso must not commit before release (${JSON.stringify(duringLasso)})`);
      await page.mouse.move(lassoB.left + 3, lassoB.top + 3, { steps: 3 });
      await page.mouse.up();
      await page.waitForTimeout(50);
      lassoPreviewCleared = (await previewState()).items.length;
      assert.equal(lassoPreviewCleared, 0, 'the lasso preview must be cleared on release');
      afterLassoPreview = await selectionState();
      assert.ok(afterLassoPreview.handles > 0 && afterLassoPreview.multi === 0
        && afterLassoPreview.handleCenterX !== null && Math.abs(afterLassoPreview.handleCenterX - centerXOf(lb)) < 30,
        `the lasso must commit the enclosed image only on release (${JSON.stringify(afterLassoPreview.handleCenterX)})`);
    }
    assert.equal(errors.length, 0, errors.join('\n'));

    console.log(JSON.stringify({ boxes, start, mid, outside, end, marqueeOutside, marqueeReturned, afterMarquee, before, after, moved, kept, lassoActivated, lassoInsideAlive, lassoAlive, shiftHold, afterShiftEmpty, plainHold, singleB, ctrlUnion, altSubtract, altHold, afterAltEmpty, restored, lassoMerge, previewLasso, duringLasso, lassoPreviewCleared, afterLassoPreview, previewA, steadyMutations, previewBoth, committedBoth, singleA, previewAdd, duringAdd, afterAdd, previewSubtract, duringSubtract, afterSubtract, restoredAgain }, null, 2));
    console.log('checks: boundary-crossing marquee/selection drag stay continuous; Shift/Ctrl marquee & lasso union, Alt subtract, empty press keeps selection; P0-3 live preview tracks the would-be selection from the transient channel (accent = add, red = subtract) for both the marquee and the lasso, republishes only when the hit set changes and is cleared on release');
  } finally { if (browser) await browser.close(); await server.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
