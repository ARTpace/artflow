// Optional Chrome/Vite integration test. Isolated headless browser; no project
// opened or changed. Includes both-click semantics, marquee, fit, wheel and pan.
// Run: node scripts/check-canvas-gestures.browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.resolve(root, '../scratch/import-worker-tools/node_modules/playwright-core'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  process.chdir(root);
  const { createServer } = await import('vite');
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const port = server.httpServer.address().port;
  let browser;
  try {
    browser = await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
    const page = await browser.newPage({viewport:{width:1200,height:806}});
    page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('svg.w-full.h-full.block').waitFor();
    const state = () => page.evaluate(() => {
      const svg=document.querySelector('svg.w-full.h-full.block');
      const sr=svg.getBoundingClientRect();
      const image=document.querySelector('svg image[data-element-id]');
      const ir=image?.getBoundingClientRect();
      const group=image?.closest('g[data-id]');
      const menu=[...document.querySelectorAll('div[data-bp-ui-surface]')].find(n =>
        n.classList.contains('fixed') && n.classList.contains('z-50') && n.classList.contains('p-1')
        && n.style.left && n.style.top && n.querySelector('button'));
      const rect=svg.querySelector('rect[fill="rgba(59, 130, 246, 0.1)"]');
      return {svg:{x:sr.x,y:sr.y,width:sr.width,height:sr.height},
        menu:menu ? {x:menu.style.left,y:menu.style.top,items:[...menu.querySelectorAll('button')].map(n=>n.textContent.trim())}:null,
        image:image ? {id:group?.getAttribute('data-id'),x:ir.x,y:ir.y,width:ir.width,height:ir.height,
          docX:Number(group?.getAttribute('data-cull-x')),docY:Number(group?.getAttribute('data-cull-y')),
          originalWidth:Number(image.getAttribute('width'))}:null,
        selection:rect ? {width:Number(rect.getAttribute('width')),height:Number(rect.getAttribute('height'))}:null,
      };
    });
    const findBlank = () => page.evaluate(() => {
      const svg=document.querySelector('svg.w-full.h-full.block'); const r=svg.getBoundingClientRect();
      for(const [u,v] of [[.08,.12],[.91,.12],[.06,.82],[.9,.82],[.04,.5],[.96,.5]]) {
        const x=Math.round(r.left+r.width*u),y=Math.round(r.top+r.height*v);
        if(document.elementFromPoint(x,y)===svg)return {x,y};
      }
      return null;
    });
    const blank=await findBlank(); assert.ok(blank);
    await page.mouse.click(blank.x,blank.y,{button:'right'});
    await page.waitForFunction(() => [...document.querySelectorAll('div[data-bp-ui-surface]')]
      .some(el => el.classList.contains('fixed') && el.classList.contains('p-1') && el.style.left));
    assert.ok((await state()).menu?.items.some(x=>/复制|Copy/.test(x)), 'blank right-click retains canvas menu');
    const dragPoint=await findBlank();assert.ok(dragPoint);
    await page.mouse.move(dragPoint.x,dragPoint.y);
    await page.mouse.down({button:'right'});
    await page.mouse.move(dragPoint.x+68,dragPoint.y+29,{steps:8});
    await page.mouse.up({button:'right'});
    assert.equal((await state()).menu,null,'background right-drag suppresses menu (web fallback does not move a native window)');
    const shortPoint=await findBlank();assert.ok(shortPoint);
    await page.mouse.move(shortPoint.x,shortPoint.y);
    await page.mouse.down({button:'right'});
    await page.mouse.move(shortPoint.x+2,shortPoint.y+1);
    await page.mouse.up({button:'right'});
    await page.waitForFunction(() => [...document.querySelectorAll('div[data-bp-ui-surface]')]
      .some(el => el.classList.contains('fixed') && el.classList.contains('p-1') && el.style.left));
    assert.ok((await state()).menu,'under-threshold right click retains menu');
    console.log('right click/right drag threshold: PASS');

    // Marquee on empty canvas remains the LEFT-button background gesture.
    // Pick a background patch whose END also avoids the still-open context menu.
    const marqueePoint=await page.evaluate(() => {
      const svg=document.querySelector('svg.w-full.h-full.block');const r=svg.getBoundingClientRect();
      for(const [u,v] of [[.85,.7],[.15,.7],[.85,.2],[.15,.2]]) {
        const x=Math.round(r.left+r.width*u),y=Math.round(r.top+r.height*v);
        if(document.elementFromPoint(x,y)===svg && document.elementFromPoint(x+55,y+42)===svg)return {x,y};
      }
      return null;
    });assert.ok(marqueePoint);
    await page.mouse.move(marqueePoint.x,marqueePoint.y);
    await page.mouse.down();
    await page.mouse.move(marqueePoint.x+55,marqueePoint.y+42,{steps:4});
    await page.waitForFunction(() => !!document.querySelector('svg rect[fill="rgba(59, 130, 246, 0.1)"]'),null,{timeout:4000});
    assert.ok((await state()).selection?.width>40);
    await page.mouse.up();
    assert.equal((await state()).selection,null);
    console.log('blank left-drag marquee: PASS');

    await page.evaluate(async () => {
      const canvas=document.createElement('canvas');canvas.width=1500;canvas.height=1000;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#d4aa80';ctx.fillRect(0,0,1500,1000);
      ctx.fillStyle='#784b65';ctx.fillRect(120,90,1200,820);
      ctx.fillStyle='#faf4d5';ctx.font='bold 104px sans-serif';ctx.fillText('Gesture test',140,500);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const transfer=new DataTransfer();transfer.items.add(new File([blob],'test.png',{type:'image/png'}));
      document.querySelector('#root').firstElementChild.dispatchEvent(new DragEvent('drop',{
        bubbles:true,cancelable:true,clientX:640,clientY:440,dataTransfer:transfer,
      }));
    });
    await page.waitForFunction(() => document.querySelector('svg image[data-element-id]')
      && !document.querySelector('[data-bp-import-reveal="active"]'),null,{timeout:30000});
    await delay(220);
    const imported=await state();assert.ok(imported.image?.width>100);
    const center=s => ({x:Math.round(s.image.x+s.image.width/2),y:Math.round(s.image.y+s.image.height/2)});
    const p=center(imported);
    await page.mouse.click(p.x,p.y,{button:'right'});
    await page.waitForFunction(() => [...document.querySelectorAll('div[data-bp-ui-surface]')]
      .some(el => el.classList.contains('fixed') && [...el.querySelectorAll('button')]
        .some(b => /最前|Front/.test(b.textContent))));
    assert.ok((await state()).menu.items.some(x=>/最前|Front/.test(x)),'image right-click retains original layer actions');
    // Start drag away from the overlay menu, but inside the image.
    const rightPoint={x:Math.round(imported.image.x+imported.image.width*.2),
      y:Math.round(imported.image.y+imported.image.height*.3)};
    await page.mouse.move(rightPoint.x,rightPoint.y);
    await page.mouse.down({button:'right'});
    await page.mouse.move(rightPoint.x+42,rightPoint.y+22,{steps:5});
    await page.mouse.up({button:'right'});
    const afterRight=await state();
    assert.equal(afterRight.menu,null,'image right drag cannot open context menu');
    assert.equal(afterRight.image.docX,imported.image.docX,'right drag never edits the image');
    console.log('right click/right drag image: PASS');

    const initialPoint=center(afterRight);
    await page.mouse.move(initialPoint.x,initialPoint.y);
    await page.mouse.down();
    await page.mouse.move(initialPoint.x+38,initialPoint.y+19,{steps:6});
    await page.mouse.up();
    await page.waitForFunction(x=>{
      const group=document.querySelector('svg image[data-element-id]')?.closest('g[data-id]');
      return Math.abs(Number(group?.getAttribute('data-cull-x'))-x)>15;
    },imported.image.docX);
    const moved=await state();
    assert.ok(Math.abs(moved.image.docX-imported.image.docX)>20,'left image drag still moves the image');
    console.log('left image drag: PASS');

    const dbl=center(moved);
    await page.mouse.dblclick(dbl.x,dbl.y,{delay:80});
    await page.waitForFunction(() => {
      const svg=document.querySelector('svg.w-full.h-full.block').getBoundingClientRect();
      const image=document.querySelector('svg image[data-element-id]')?.getBoundingClientRect();
      return image && Math.abs(image.x+image.width/2-(svg.x+svg.width/2))<9
        && Math.abs(image.y+image.height/2-(svg.y+svg.height/2))<9
        && image.width<svg.width-85 && image.height<svg.height-85;
    });
    const focused=await state();
    assert.equal(focused.image.docX,moved.image.docX,'double click only changes camera');
    assert.ok(focused.image.width>moved.image.width*1.5,'small images grow to fit, not fixed at 100%');
    console.log('double click fit and center entire image: PASS');

    const wheelPoint={x:Math.round(focused.svg.x+focused.svg.width*.47),
      y:Math.round(focused.svg.y+focused.svg.height*.51)};
    await page.mouse.move(wheelPoint.x,wheelPoint.y);
    await page.mouse.wheel(0,-120);await delay(850);
    const zoomed=await state();const ratio=zoomed.image.width/focused.image.width;
    assert.ok(ratio>1.12 && ratio<1.55,'ordinary wheel zooms with no Ctrl');
    const expectX=wheelPoint.x+(focused.image.x-wheelPoint.x)*ratio;
    const expectY=wheelPoint.y+(focused.image.y-wheelPoint.y)*ratio;
    assert.ok(Math.abs(zoomed.image.x-expectX)<5 && Math.abs(zoomed.image.y-expectY)<5,
      'wheel anchor must stay under cursor');
    console.log('ordinary wheel zoom remains pointer anchored: PASS');

    const panPoint={x:Math.round(zoomed.svg.x+zoomed.svg.width*.51),
      y:Math.round(zoomed.svg.y+zoomed.svg.height*.55)};
    await page.mouse.move(panPoint.x,panPoint.y);
    await page.mouse.down({button:'middle'});
    await page.mouse.move(panPoint.x+54,panPoint.y+27,{steps:4});
    await page.mouse.up({button:'middle'});
    await delay(160);
    const panned=await state();
    assert.ok(Math.abs(panned.image.x-zoomed.image.x-54)<6);
    assert.ok(Math.abs(panned.image.y-zoomed.image.y-27)<6);
    console.log('middle-button pan over image: PASS');
    assert.deepEqual(errors,[],'no renderer exceptions');
    console.log('Headless canvas gesture integration: PASS');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
