// Isolated real-browser end-to-end smoke: drop many photos, drag/pan during
// import, then verify it completes without a white screen or lost input.
// Uses a clean Chrome profile + temporary Vite port; never opens user projects.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(path.resolve(root, '../scratch/import-worker-tools/node_modules/playwright-core'));

(async () => {
  process.chdir(root);
  const { createServer } = await import('vite');
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  let browser;
  try {
    browser = await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(25_000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.locator('svg.w-full.h-full.block').waitFor();
    const setup = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width=2200;canvas.height=1500;
      const ctx=canvas.getContext('2d');
      let seed=110351;
      for(let i=0;i<16000;i++){
        seed=(seed*1664525+1013904223)|0;
        const x=Math.abs(seed)%canvas.width;
        seed=(seed*1664525+1013904223)|0;
        const y=Math.abs(seed)%canvas.height;
        ctx.fillStyle=`hsl(${i%360} 60% 55%)`;
        ctx.fillRect(x,y,23,19);
      }
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.83));
      const files=Array.from({length:48},(_,i)=>new File([blob],`test-${i}.jpg`,{type:'image/jpeg'}));
      const transfer=new DataTransfer();files.forEach(f=>transfer.items.add(f));
      const host=document.querySelector('#root')?.firstElementChild;
      const revealLayer=document.querySelector('svg.w-full.h-full.block')?.nextElementSibling;
      if(!revealLayer)throw new Error('Import reveal overlay layer missing');
      const reveals={inserted:0,animated:0,maxHidden:0};
      window.__importReveals=reveals;
      new MutationObserver(records=>{
        for(const record of records){
          if(record.type==='attributes' && record.target.getAttribute('data-bp-reveal-phase')==='fading')reveals.animated++;
          for(const node of record.addedNodes){
            if(node.nodeType===1 && node.hasAttribute('data-bp-import-reveal')){
              reveals.inserted++;
              reveals.maxHidden=Math.max(reveals.maxHidden,document.querySelectorAll('svg image[data-bp-import-suppressed]').length);
            }
          }
        }
      }).observe(revealLayer,{childList:true,subtree:true,attributes:true,attributeFilter:['data-bp-reveal-phase']});
      const recorder={gaps:[],last:performance.now(),running:true};
      window.__importFrames=recorder;
      function frame(time){recorder.gaps.push(Math.round(time-recorder.last));recorder.last=time;if(recorder.running)requestAnimationFrame(frame)}
      requestAnimationFrame(frame);
      host.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:650,clientY:430,dataTransfer:transfer}));
      return { fileSize: blob.size, count:files.length };
    });
    await page.waitForFunction(() => document.querySelectorAll('svg [data-id]').length > 0 && !!document.querySelector('div.absolute.bottom-4.right-4.z-50'),null,{timeout:30_000});
    const firstVisible = await page.locator('svg [data-id]').evaluateAll(nodes => nodes.map(node => ({id:node.getAttribute('data-id'),rect:node.getBoundingClientRect()}))
      .find(({rect}) => rect.width>20 && rect.height>20 && rect.left<1200 && rect.right>100 && rect.top<780 && rect.bottom>80)?.id || null);
    assert.ok(firstVisible,'imported image should be visible and draggable');
    const element = page.locator(`svg [data-id="${firstVisible}"]`).first();
    const rect = await element.boundingBox();
    assert.ok(rect && rect.width>0);
    const start={
      x:(Math.max(100,rect.x)+Math.min(1180,rect.x+rect.width))/2,
      y:(Math.max(80,rect.y)+Math.min(780,rect.y+rect.height))/2,
    };
    const beforeX = Number(await element.getAttribute('data-cull-x'));
    await page.mouse.move(start.x,start.y);
    await page.mouse.down();
    const during = await page.evaluate(start => ({
      workerImportVisible: !!document.querySelector('div.absolute.bottom-4.right-4.z-50'),
      frameCount: window.__importFrames.gaps.length,
      images: document.querySelectorAll('svg [data-id]').length,
      revealBatches: window.__importReveals.inserted,
      overlayActive: !!document.querySelector('[data-bp-import-reveal="active"]'),
      hitTestImage: document.elementFromPoint(start.x,start.y)?.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null,
    }), start);
    for(let i=1;i<=6;i++){
      await page.mouse.move(start.x+i*12,start.y+i*5,{steps:2});
      await page.waitForTimeout(45);
    }
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('div.absolute.bottom-4.right-4.z-50'),null,{timeout:70_000});
    await page.waitForFunction(() => !document.querySelector('[data-bp-import-reveal="active"]'),null,{timeout:3_000});
    const afterX = Number(await element.getAttribute('data-cull-x'));
    const movedX = afterX - beforeX;
    assert.ok(during.workerImportVisible, 'must drag while import is still in progress');
    assert.ok(movedX > 20, `dragged image must move while import runs (moved ${movedX}px)`);
    const result=await page.evaluate(() => {
      const recorder=window.__importFrames;recorder.running=false;
      const gaps=recorder.gaps.filter(Number.isFinite).slice(1);
      gaps.sort((a,b)=>a-b);
      return { frames:gaps.length,p50Ms:gaps[Math.floor(gaps.length*.5)],p95Ms:gaps[Math.floor(gaps.length*.95)],maxMs:gaps.at(-1),
        shownImages:document.querySelectorAll('svg [data-id]').length,
        reveals:window.__importReveals,
        suppressedAfterImport:document.querySelectorAll('svg image[data-bp-import-suppressed]').length,
        activeOverlays:document.querySelectorAll('[data-bp-import-reveal="active"]').length,
        errorText:document.querySelector('div.absolute.top-4.left-1\\/2')?.textContent??null };
    });
    assert.equal(result.errorText,null,'no import error overlay');
    assert.equal(errors.length,0,errors.join('\n'));
    assert.ok(result.frames>15,'UI must keep producing animation frames during import');
    assert.ok(result.reveals.inserted>=1,'visible imported images should receive a reveal');
    assert.ok(result.reveals.animated>=1,'at least one overlay must actually fade in');
    assert.ok(result.reveals.maxHidden<=8,'reveal must be bounded to one small batch');
    assert.equal(result.suppressedAfterImport,0,'SVG images must never remain hidden');
    assert.equal(result.activeOverlays,0,'temporary overlays must be cleaned up');
    console.log(JSON.stringify({ setup, firstVisible, during, movedX, result },null,2));
    console.log('checks: real canvas stays interactive during bulk image import');
  } finally {
    if(browser)await browser.close();
    await server.close();
  }
})().catch(error => {console.error(error);process.exitCode=1});
