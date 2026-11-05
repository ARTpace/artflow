// Optional isolated Chrome integration check. Requires external playwright-core
// in H:/AI-Tools/scratch/import-worker-tools; no project dependencies added.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.resolve(root, '../scratch/import-worker-tools/node_modules/playwright-core'));

async function dropPhoto(page) {
  await page.evaluate(async () => {
    const canvas=document.createElement('canvas');canvas.width=1700;canvas.height=1000;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#264470';ctx.fillRect(0,0,canvas.width,canvas.height);
    for(let i=0;i<3000;i++){
      ctx.fillStyle=`hsl(${i%360} 60% 70%)`;
      ctx.fillRect((i*71)%canvas.width,(i*53)%canvas.height,40,18);
    }
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));
    const transfer=new DataTransfer();transfer.items.add(new File([blob],'import-reveal.jpg',{type:'image/jpeg'}));
    document.querySelector('#root').firstElementChild.dispatchEvent(new DragEvent('drop',{
      bubbles:true,cancelable:true,clientX:620,clientY:400,dataTransfer:transfer,
    }));
  });
}

(async () => {
  process.chdir(root);
  const { createServer } = await import('vite');
  const server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0}});
  await server.listen();
  const port=server.httpServer.address().port;
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
    const errors=[];
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.on('pageerror',err=>errors.push(String(err)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('svg.w-full.h-full.block').waitFor();
    // Register observer before dropping so it cancels within the first fade
    // callback, not 180ms later after a Playwright round trip.
    await page.evaluate(() => {
      window.__revealProbe=new Promise(resolve=>{
        const layer=document.querySelector('svg.w-full.h-full.block').nextElementSibling;
        const timeout=setTimeout(()=>{observer.disconnect();resolve({timedOut:true})},15000);
        const observer=new MutationObserver(()=>{
          const panel=document.querySelector('[data-bp-reveal-phase="fading"]');
          if(!panel)return;
          observer.disconnect();clearTimeout(timeout);
          const node=document.querySelector('svg image[data-bp-import-suppressed]');
          const r=node.getBoundingClientRect();
          const x=(Math.max(50,r.left)+Math.min(1200,r.right))/2;
          const y=(Math.max(50,r.top)+Math.min(800,r.bottom))/2;
          const hit=document.elementFromPoint(x,y)?.closest('[data-element-id]');
          const before={
            id:node.getAttribute('data-element-id'),
            hit:hit?.getAttribute('data-element-id'),
            playing:panel.getAnimations().length,
            hidden:document.querySelectorAll('svg image[data-bp-import-suppressed]').length,
          };
          window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
          window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
          resolve({...before,remaining:document.querySelectorAll('svg image[data-bp-import-suppressed]').length,
            overlays:document.querySelectorAll('[data-bp-import-reveal="active"]').length});
        });
        observer.observe(layer,{childList:true,subtree:true,attributes:true,attributeFilter:['data-bp-reveal-phase']});
      });
    });
    await dropPhoto(page);
    const probed=await page.evaluate(()=>window.__revealProbe);
    assert.equal(probed.timedOut,undefined,'import should animate a single visible JPEG');
    assert.ok(probed.playing>0);
    assert.ok(probed.hidden>0);
    assert.equal(probed.hit,probed.id,'suppressed SVG image must remain hit-testable');
    assert.equal(probed.remaining,0,'pointer input must immediately reveal the real image');
    assert.equal(probed.overlays,0,'pointer input must remove the overlay');
    await page.waitForFunction(()=>!document.querySelector('div.absolute.bottom-4.right-4.z-50'));
    assert.equal(errors.length,0,errors.join('\n'));

    const reduced=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
    const reducedErrors=[];reduced.on('pageerror',err=>reducedErrors.push(String(err)));
    await reduced.goto(`http://127.0.0.1:${port}/`);
    await reduced.locator('svg.w-full.h-full.block').waitFor();
    await reduced.evaluate(()=>{
      window.__reducedReveals=0;
      const layer=document.querySelector('svg.w-full.h-full.block').nextElementSibling;
      new MutationObserver(records=>{
        for(const record of records)for(const node of record.addedNodes)
          if(node.nodeType===1 && node.hasAttribute('data-bp-import-reveal'))window.__reducedReveals++;
      }).observe(layer,{childList:true});
    });
    await dropPhoto(reduced);
    await reduced.waitForFunction(()=>document.querySelectorAll('svg image[data-element-id]').length===1
      && !document.querySelector('div.absolute.bottom-4.right-4.z-50'));
    const motion=await reduced.evaluate(()=>({
      reveals:window.__reducedReveals,
      hidden:document.querySelectorAll('svg image[data-bp-import-suppressed]').length,
    }));
    assert.equal(motion.reveals,0,'reduced motion must skip the visual effect');
    assert.equal(motion.hidden,0);
    assert.equal(reducedErrors.length,0,reducedErrors.join('\n'));
    console.log(JSON.stringify({cancelOnInput:probed,reducedMotion:motion},null,2));
    console.log('checks: import reveal is nonblocking, cancellable and reduced-motion safe');
  } finally { if(browser)await browser.close();await server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
