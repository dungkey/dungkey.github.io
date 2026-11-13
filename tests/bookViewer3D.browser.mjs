import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const epubPath = process.argv[2];
if (!epubPath) throw new Error('Usage: node tests/bookViewer3D.browser.mjs /path/to/book.epub');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-browser-'));
const server = http.createServer((req, res) => {
  const file = path.resolve(root, `.${new URL(req.url, 'http://localhost').pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${path.join(output, 'profile')}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
try {
const endpoint = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000);
  chrome.on('error', error => { clearTimeout(timer); reject(error); });
  chrome.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code}`)); });
  chrome.stderr.on('data', chunk => {
    const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
});
const debugBase = `http://${new URL(endpoint).host}`;
const target=(await(await fetch(`${debugBase}/json/list`)).json()).find(t=>t.type==='page');
ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0;const pending=new Map();const pageErrors=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')pageErrors.push(m.params.exceptionDetails.text);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}}};
const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
await send('Network.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:`${base}/package.json`});
await new Promise(r=>setTimeout(r,500));
const data=fs.readFileSync(epubPath).toString('base64');
console.log(await ev(`(async()=>{
 document.body.innerHTML='';const map=document.createElement('script');map.type='importmap';map.textContent=JSON.stringify({imports:{three:'/vendor/three/three.module.min.js'}});document.head.append(map);
 for(const href of ['/styles/main.css','/styles/reader.css','/assets/fonts/kinghwa/result.css']){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link)}
 const {parseEpubFile}=await import('/src/epub.js');
 const {BookViewer3D}=await import('/src/bookViewer3D.js');
 const bytes=Uint8Array.from(atob('${data}'), c=>c.charCodeAt(0));
 const book=await parseEpubFile(new File([bytes],'我与地坛.epub'));
 window.v=new BookViewer3D();await v.openBook(null,{...book,id:'headless-test'});v.hud.classList.add('is-active');
 await document.fonts.ready;await new Promise(r=>setTimeout(r,400));
 v.loadChapter(v.chapters.findIndex(c=>c.paragraphs.join('').length>7000),0);
 window.rafQueue=new Map();let id=0;window.requestAnimationFrame=cb=>{rafQueue.set(++id,cb);return id};window.cancelAnimationFrame=id=>rafQueue.delete(id);
 return {title:book.title,chapters:v.chapters.length,chapter:v.currentChapter,spreads:v.chapterSpreadCount,cols:v.colsPerSpread};})()`));
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'))};
await shot('flip-before');
console.log(await ev(`window.start=performance.now();v.flipNext();({leaf:document.querySelector('.hud-flip-leaf').style.transform,clones:document.querySelectorAll('.hud-flip-stage *').length})`));
await shot('flip-start');
for(const time of [170,340,510,700]){console.log(time,await ev(`(()=>{const cb=rafQueue.get(v.flipRaf);rafQueue.delete(v.flipRaf);cb(start+${time});return {spread:v.currentSpread,raf:v.flipRaf,angle:document.querySelector('.hud-flip-leaf')?.style.transform}})()`));await shot('flip-'+time)}
console.log(await ev(`({chapter:v.currentChapter,spreads:v.chapterSpreadCount,stride:v.spreadStride,colW:v.colW,gap:v.colGap})`));
await ev(`(()=>{const cb=rafQueue.get(v.flipRaf);rafQueue.delete(v.flipRaf);if(cb)cb(start+1000);})()`);
await shot('flip-after');
for (const [name,width,height,dir] of [['prev',1440,900,-1],['single-next',600,900,1],['single-prev',600,900,-1]]) {
 await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 await ev(`v.reflowCurrentChapter(0);v.currentSpread=1;v.applySpreadTransform();window.start=performance.now();v.${dir>0?'flipNext':'flipPrev'}()`);
 await shot(name+'-start');
 await ev(`(()=>{const cb=rafQueue.get(v.flipRaf);rafQueue.delete(v.flipRaf);cb(start+340)})()`);
 await shot(name+'-mid');
 await ev(`(()=>{const cb=rafQueue.get(v.flipRaf);rafQueue.delete(v.flipRaf);cb(start+1000)})()`);
 await shot(name+'-after');
 assert.deepEqual(await ev(`({spread:v.currentSpread,raf:v.flipRaf,children:v.hudFlipStage.childElementCount})`), {spread:dir>0?2:0,raf:0,children:0});
}
const checks = await ev(`(() => {
 const finish = () => { const cb=rafQueue.get(v.flipRaf);rafQueue.delete(v.flipRaf);if(cb)cb(performance.now()+2000); };
 const chapter=v.currentChapter;
 v.currentSpread=v.chapterSpreadCount-1;v.applySpreadTransform();v.flipNext();
 const crossed=v.currentChapter===chapter+1 && v.currentSpread===0;finish();
 v.flipPrev();const returned=v.currentChapter===chapter && v.currentSpread===v.chapterSpreadCount-1;finish();
 v.currentSpread=0;v.applySpreadTransform();v.flipNext();const first=v.currentSpread;v.flipNext();const locked=v.currentSpread===first;
 v.reflowCurrentChapter(0);
 return {crossed,returned,locked,clean:v.flipRaf===0&&v.hudFlipStage.childElementCount===0&&rafQueue.size===0,
 header:+getComputedStyle(v.hudHeaderBook.parentElement).zIndex>+getComputedStyle(v.hudFlipStage).zIndex,
 footer:+getComputedStyle(v.hudFooter).zIndex>+getComputedStyle(v.hudFlipStage).zIndex};
})()`);
assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));
assert.deepEqual(pageErrors,[]);
console.log('Headless EPUB checks passed', checks, `Screenshots: ${output}`);
} finally {
 ws?.close();
 chrome.kill();
 server.close();
}

