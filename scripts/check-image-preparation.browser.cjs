// Optional real-browser fixture. Does not open/modify the user's project or Electron window.
// Install tools in an isolated directory; see docs/图片换档预解码优化记录.md.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const tools = process.env.ARTFLOW_BROWSER_TEST_TOOLS || path.join(root, '.performance-tools', 'node_modules');
const tool = name => { try { return require(name); } catch { return require(path.join(tools, name)); } };
const { chromium } = tool('playwright');
const { build } = tool('esbuild');
(async () => {
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'artflow-image-preparation-'));
try {
const extract = (text, name) => text.slice(text.indexOf('interface ImageCanvasElementProps'), text.indexOf('interface CanvasElementProps')).replace('const ImageCanvasElement:', `const ${name}:`);
const componentAfter = extract(fs.readFileSync(path.join(root, 'components/CanvasElement.tsx'), 'utf8'), 'PreparedCanvasImage');
const componentBefore = extract(fs.readFileSync(path.join(root, '.performance-backups/2026-09-23-predecode-01/components/CanvasElement.tsx'), 'utf8'), 'LegacyCanvasImage');
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useImageLOD, resolveImageRenderRequirement } from ${JSON.stringify(path.join(root, 'utils/imageProxy.ts'))};
import { usePreparedImageSource } from ${JSON.stringify(path.join(root, 'utils/usePreparedImageSource.ts'))};
import { createImagePreparationQueue, getImagePreparationQueue, prepareBrowserImage } from ${JSON.stringify(path.join(root, 'utils/image-preparation-queue.ts'))};
type ImageElement = any; type Rect = any;
${componentAfter}
${componentBefore.replace(/interface ImageCanvasElementProps[\s\S]*?\n}\n/, '')}
const check = (ok, msg) => { if (!ok) throw new Error(msg); };
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const until = async (test, label) => { for (let i=0;i<300;i++) { if (test()) return; await frame(); } throw new Error('timeout: '+label); };
function fixture(size, color) {
 const c=document.createElement('canvas');c.width=c.height=size;
 const x=c.getContext('2d')!;x.fillStyle=color;x.fillRect(0,0,size,size);
 x.fillStyle='white';for(let i=0;i<size;i+=32)x.fillRect(i,i,16,16);
 return c.toDataURL('image/png');
}
const thumb=fixture(128,'#365'), standard=fixture(1024,'#358'), newest=fixture(256,'#835');
const host=document.createElement('div');document.body.append(host);let reactRoot=createRoot(host);
function Probe(props) {
 const value=usePreparedImageSource(props);
 return <svg><image data-testid="probe" href={value.src} data-state={value.loadState}/></svg>;
}
const paint = (props) => flushSync(()=>reactRoot.render(<React.StrictMode><Probe {...props}/></React.StrictMode>));
const current = () => host.querySelector('image')?.getAttribute('href');
window.runPreparationTests = async () => {
 const results:any={};
 // Actual React hook lifecycle, including StrictMode's setup/cleanup/setup.
 const loads:any[]=[];
 const q=createImagePreparationQueue({
  requestFrame:cb=>requestAnimationFrame(cb),cancelFrame:cancelAnimationFrame,
  load:(src,signal)=>new Promise(resolve=>loads.push({src,signal,resolve:()=>resolve({bytes:4096,release:()=>{}})})),
 });
 const props={elementId:'a',baseSrc:'asset-a',fallback:{src:thumb,tier:'thumbnail'},desired:{src:standard,tier:'standard'},queue:q};
 paint(props); check(current()===thumb,'initial fallback');
 await until(()=>loads.some(x=>x.src===standard&&!x.signal.aborted),'standard scheduled');
 paint({...props,desired:{src:newest,tier:'original'}});
 await until(()=>loads.some(x=>x.src===newest&&!x.signal.aborted),'replacement scheduled');
 for(const l of loads.filter(x=>x.src===standard))l.resolve();
 await frame();await frame();check(current()===thumb,'stale result must not replace fallback');
 loads.find(x=>x.src===newest&&!x.signal.aborted).resolve();
 await until(()=>current()===newest,'new target visible');
 paint({...props,baseSrc:'asset-b',fallback:{src:standard,tier:'standard'},desired:{src:standard,tier:'standard'}});
 check(current()===standard,'asset replacement must never flash old asset');
 flushSync(()=>reactRoot.unmount());q.dispose();
 for(const l of loads)l.resolve();await frame();
 check(q.getStats().waitingConsumers===0,'unmount consumers');
 results.lifecycle='pass: StrictMode, old-source retention, rapid target reversal, stale completion, asset replacement, unmount';

 // A failed upgrade retains an existing usable source and reports error.
 reactRoot=createRoot(host);
 const failureQueue=createImagePreparationQueue({load:()=>Promise.reject(Error('broken')),requestFrame:cb=>requestAnimationFrame(cb),cancelFrame:cancelAnimationFrame});
 paint({...props,queue:failureQueue});
 await until(()=>host.querySelector('image')?.getAttribute('data-state')==='error','failure state');
 check(current()===thumb,'failed upgrade must retain old image');
 flushSync(()=>reactRoot.unmount());failureQueue.dispose();
 results.failure='pass';

 // 裁剪重挂：卸载前显示的源必须在重挂后的第一帧就恢复（不闪 fallback、不空窗、不重复提交）。
 {
  const remountLoads:any[]=[];
  const remountQueue=createImagePreparationQueue({load:(src,signal)=>new Promise(resolve=>remountLoads.push({src,signal,resolve:()=>resolve({bytes:4096,release:()=>{}})})),requestFrame:cb=>requestAnimationFrame(cb),cancelFrame:cancelAnimationFrame});
  const remountProps={elementId:'remount-1',baseSrc:'asset-r',fallback:{src:thumb,tier:'thumbnail'},desired:{src:standard,tier:'standard'},queue:remountQueue};
  reactRoot=createRoot(host);
  paint(remountProps);
  await until(()=>remountLoads.some(x=>x.src===standard&&!x.signal.aborted),'remount standard scheduled');
  remountLoads.find(x=>x.src===standard&&!x.signal.aborted).resolve();
  await until(()=>current()===standard,'remount standard visible');
  flushSync(()=>reactRoot.unmount());
  reactRoot=createRoot(host);
  paint(remountProps);
  check(current()===standard,'remount must restore the previously displayed source on the first frame');
  const loadCountAfterRemount=remountLoads.length;
  await frame();await frame();
  check(current()===standard,'remount source must remain stable (no fallback flash)');
  check(remountLoads.length===loadCountAfterRemount,'remembered source must not resubmit the same request');
  flushSync(()=>reactRoot.unmount());remountQueue.dispose();
  results.remount='pass: culling remount restores last displayed source';
 }

 // Real browser Image.decode() and real old/new ImageCanvasElement source snippets.
 const count=48;
 const elements=Array.from({length:count},(_,i)=>({id:'real-'+i,type:'image',x:(i%8)*140,y:Math.floor(i/8)*90,width:400,height:225,href:standard+'#'+i,thumbnailHref:thumb+'#'+i}));
 const renderCards=(Component,zoom)=>flushSync(()=>reactRoot.render(<svg width="1200" height="800">{elements.map(element=><Component key={element.id} element={element} zoom={zoom} croppingState={null}/>)}</svg>));
 const upgraded=()=>host.querySelectorAll('image[data-lod-tier="standard"]').length;
 reactRoot=createRoot(host);renderCards(LegacyCanvasImage,.3);renderCards(LegacyCanvasImage,.7);
 const oldImmediate=upgraded();check(oldImmediate===count,'legacy immediate upgrades');
 flushSync(()=>reactRoot.unmount());reactRoot=createRoot(host);
 renderCards(PreparedCanvasImage,.3);renderCards(PreparedCanvasImage,.7);
 const newImmediate=upgraded();check(newImmediate===0,'prepared path must retain thumbnails before decode');
 const progress:number[]=[];let maxActive=0,maxReady=0;
 for(let i=0;i<300&&upgraded()<count;i++){
  await frame();progress.push(upgraded());const st=getImagePreparationQueue().getStats();maxActive=Math.max(maxActive,st.active);maxReady=Math.max(maxReady,st.ready);check(st.active<=2,'browser concurrency');
 }
 check(upgraded()===count,'all real images eventually upgrade');
 const stats=getImagePreparationQueue().getStats();
 results.realImages={count,oldImmediate,newImmediate,framesObserved:progress.length,progress,maxActive,maxReady,started:stats.started,delivered:stats.delivered,cacheBytes:stats.cacheBytes};
 flushSync(()=>reactRoot.unmount());getImagePreparationQueue().dispose();

 // Real browser decoder rejects an invalid source and honours pre-abort.
 await prepareBrowserImage('data:image/png;base64,broken',new AbortController().signal).then(()=>{throw Error('invalid source accepted')},()=>{});
 const c=new AbortController();c.abort();await prepareBrowserImage(standard,c.signal).then(()=>{throw Error('abort ignored')},()=>{});
 results.browserErrors='pass';return results;
};
`;
fs.writeFileSync(path.join(scratch, 'browser-entry.tsx'), entry);
await build({ entryPoints: [path.join(scratch, 'browser-entry.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(scratch, 'browser-bundle.js'), nodePaths: [path.join(root,'node_modules'), tools], define: { 'process.env.NODE_ENV': '"development"' } });
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.setContent('<!doctype html><html><body></body></html>');
 await page.addScriptTag({path:path.join(scratch,'browser-bundle.js')});
 const result=await page.evaluate(()=>window.runPreparationTests());
 if(errors.length)throw Error(errors.join('\n'));
 console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}

} finally { fs.rmSync(scratch, {recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
