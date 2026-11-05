// Isolated real-browser regression: a card drag may leave the SVG/app window
// while held without being committed at the boundary. Uses a clean Vite+Chrome
// profile; does not open or modify the user's running Electron project.
const assert=require('node:assert/strict');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const {chromium}=require(path.resolve(root,'../scratch/import-worker-tools/node_modules/playwright-core'));

(async()=>{
  process.chdir(root);
  const {createServer}=await import('vite');
  const server=await createServer({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:0}});
  await server.listen();
  const port=server.httpServer.address().port;
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    const errors=[];page.on('pageerror',err=>errors.push(String(err)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('svg.w-full.h-full.block').waitFor();
    const photo=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=1500;canvas.height=1000;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#bd5184';ctx.fillRect(0,0,1500,1000);
      for(let i=0;i<400;i++){ctx.fillStyle=`hsl(${i%360} 60% 75%)`;ctx.fillRect(i*23%1500,i*29%1000,35,27)}
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.88));
      const transfer=new DataTransfer();transfer.items.add(new File([blob],'boundary-photo.jpg',{type:'image/jpeg'}));
      document.querySelector('#root').firstElementChild.dispatchEvent(new DragEvent('drop',{
        bubbles:true,cancelable:true,clientX:650,clientY:440,dataTransfer:transfer,
      }));
      return blob.size;
    });
    await page.waitForFunction(()=>document.querySelector('svg image[data-element-id]')
      && !document.querySelector('div.absolute.bottom-4.right-4.z-50')
      && !document.querySelector('[data-bp-import-reveal="active"]'),null,{timeout:30000});
    const image=page.locator('svg g[data-id]').first();
    const id=await image.getAttribute('data-id');
    const initial=Number(await image.getAttribute('data-cull-x'));
    const initialY=Number(await image.getAttribute('data-cull-y'));
    const box=await image.boundingBox();
    assert.ok(box?.width>100);
    const start={x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};
    assert.ok(start.x>60 && start.x<1220 && start.y>60 && start.y<830);
    await page.mouse.move(start.x,start.y);
    await page.mouse.down();
    await page.mouse.move(-25,start.y,{steps:12});
    await page.waitForTimeout(35);
    const whileOutside=Number(await image.getAttribute('data-cull-x'));
    // The pointer returns with the button *still held*. A mouseleave must not
    // have committed the negative boundary offset.
    const returnX=Math.min(1120,start.x+145);
    await page.mouse.move(returnX,start.y,{steps:12});
    await page.waitForTimeout(40);
    const returned=Number(await image.getAttribute('data-cull-x'));
    const expected=returnX-start.x;
    assert.ok(Math.abs((returned-initial)-expected)<20,
      `preview must follow the returning pointer (${returned-initial}px; expected ${expected}px)`);
    await page.mouse.up();
    const committed=Number(await image.getAttribute('data-cull-x'));
    assert.ok(Math.abs(committed-returned)<3,'release must preserve the last preview exactly');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(({id,x})=>{
      const node=[...document.querySelectorAll('svg [data-id]')].find(el=>el.getAttribute('data-id')===id);
      return node && Math.abs(Number(node.getAttribute('data-cull-x'))-x)<3;
    },{id,x:initial});
    // A mouseup over a sibling UI panel never reaches SVG's onMouseUp. The
    // window capture listener must flush that last coordinate and commit once.
    const release={x:start.x+75,y:20};
    await page.evaluate(({x})=>{
      const blocker=document.createElement('div');blocker.id='drag-boundary-test-panel';
      blocker.style.cssText=`position:fixed;left:${x-70}px;top:0;width:140px;height:80px;z-index:2147483647;pointer-events:auto`;
      document.body.appendChild(blocker);
    },release);
    await page.mouse.move(start.x,start.y);
    await page.mouse.down();
    await page.mouse.move(release.x,release.y,{steps:5});
    await page.mouse.up();
    await page.evaluate(()=>document.getElementById('drag-boundary-test-panel').remove());
    const onOutsideUp=Number(await image.getAttribute('data-cull-y'));
    assert.ok(Math.abs((onOutsideUp-initialY)-(release.y-start.y))<20,
      `mouseup outside SVG must commit final position (${onOutsideUp-initialY})`);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(({id,x})=>{
      const node=[...document.querySelectorAll('svg [data-id]')].find(el=>el.getAttribute('data-id')===id);
      return node && Math.abs(Number(node.getAttribute('data-cull-x'))-x)<3;
    },{id,x:initial});
    // Losing app focus during a held drag is not a drop. The session rolls back
    // without making a history entry, and another drag can start afterward.
    await page.mouse.move(start.x,start.y);
    await page.mouse.down();
    await page.mouse.move(start.x+85,start.y,{steps:5});
    await page.waitForTimeout(35);
    const beforeBlur=Number(await image.getAttribute('data-cull-x'));
    assert.ok(beforeBlur>initial+50,'second drag should be active before blur');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    const afterBlur=Number(await image.getAttribute('data-cull-x'));
    assert.ok(Math.abs(afterBlur-initial)<3,'blur must cancel rather than drop at the edge');
    await page.mouse.move(start.x,start.y);
    await page.mouse.down();
    await page.mouse.move(start.x+55,start.y,{steps:4});
    await page.mouse.up();
    const afterRestart=Number(await image.getAttribute('data-cull-x'));
    assert.ok(afterRestart>initial+40,'a new drag should work after focus-loss cancellation');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(({id,x})=>{
      const node=[...document.querySelectorAll('svg [data-id]')].find(el=>el.getAttribute('data-id')===id);
      return node && Math.abs(Number(node.getAttribute('data-cull-x'))-x)<3;
    },{id,x:initial});
    await page.mouse.move(start.x,start.y);
    await page.mouse.down();
    await page.mouse.move(start.x+90,start.y,{steps:5});
    await page.waitForTimeout(35);
    const beforeMissedUp=Number(await image.getAttribute('data-cull-x'));
    assert.ok(beforeMissedUp>initial+50);
    // Simulate an OS/window that misses mouseup while the pointer is outside:
    // the first no-button movement on re-entry cancels instead of getting stuck.
    await page.evaluate(({x,y})=>window.dispatchEvent(new MouseEvent('mousemove',{
      clientX:x,clientY:y,buttons:0,bubbles:true,
    })),{x:start.x+90,y:start.y});
    await page.mouse.up();
    const afterMissedUp=Number(await image.getAttribute('data-cull-x'));
    assert.ok(Math.abs(afterMissedUp-initial)<3,'missed mouseup must not drop at the edge');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log(JSON.stringify({photoBytes:photo,id,start,initial,initialY,whileOutside,returned,expected,committed,onOutsideUp,afterBlur,afterRestart,afterMissedUp},null,2));
    console.log('checks: card drag survives mouseleave; blur cancels without committing');
  }finally{if(browser)await browser.close();await server.close()}
})().catch(err=>{console.error(err);process.exitCode=1});
