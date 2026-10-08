// End-to-end test of the probe's demo: build the demo article in a fake editor,
// then "Update from Doc" with tools/demo/demo-google-export.html (the demo .docx
// shaped like Google's HTML export). Checks the 100% match, every change and the images.
// Run: node tests/update-from-doc-e2e.test.js   (needs Playwright + Chromium)
const assert=require('assert'),fs=require('fs'),path=require('path');const {execSync}=require('child_process');
const {chromium}=require(path.join(execSync('npm root -g').toString().trim(),'playwright'));
const SF='https://thumbtack.lightning.force.com'; const TEST='ka2Vx0000003JULIA2';
const EXPORT=fs.readFileSync(path.join(__dirname,'..','tools','demo','demo-google-export.html'),'utf8'); const NEWPNG=fs.readFileSync(path.join(__dirname,'..','tools','demo','demo-jobs-new.png')).toString('base64');
const uploader = `<script>document.body.addEventListener('paste',e=>{const f=e.clipboardData.files[0]; if(!f) return; e.preventDefault(); const s=getSelection(); const r=s.getRangeAt(0); const im=document.createElement('img'); im.src=URL.createObjectURL(f); r.insertNode(im); setTimeout(()=>{im.src='https://thumbtack.file.force.com/servlet/rtaImage?refid=0EM'+Math.random().toString(36).slice(2,8)},700)});<\/script>`;
const frame=(k,l,html)=>`<div><label>${l}</label><iframe data-k="${k}" style="width:700px;height:300px" srcdoc="${('<html><head><meta charset=utf-8></head><body contenteditable=true>'+html+uploader+'</body></html>').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"></iframe></div>`;
(async()=>{
 const script=fs.readFileSync(path.join(__dirname,'..','tools','ka-write-probe.user.js'),'utf8');
 const b=await chromium.launch(); const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 let answers=[]; p.on('dialog',d=>{ const a=answers.shift(); if(d.type()==='prompt') d.accept(a); else a?d.accept():d.dismiss(); });
 let kbHtml='<p>Hola prueba</p>';
 await p.exposeFunction('__gm',async(url,type)=>{ if(/export\?format=html/.test(url)) return {t:EXPORT}; if(/googleusercontent/.test(url)) return {b:NEWPNG}; return {t:''}; });
 await p.route(SF+'/**',async r=>{ const u=new URL(r.request().url());
  if(u.pathname.endsWith('/object-info/Knowledge__kav')) return r.fulfill({contentType:'application/json',body:JSON.stringify({fields:{KB_Content__c:{dataType:'TextArea',htmlFormatted:true,updateable:true,label:'KB Content',length:131072},Related__c:{dataType:'TextArea',htmlFormatted:true,updateable:true,label:'Related Content',length:131072},Multimedia__c:{dataType:'TextArea',updateable:true,label:'Multimedia',length:10072}}})});
  if(u.pathname.includes('/ui-api/records/')) return r.fulfill({contentType:'application/json',body:JSON.stringify({fields:{Title:{value:'t'},PublishStatus:{value:'Draft'},VersionNumber:{value:0},KB_Content__c:{value:'<p>x</p>'}}})});
  const form='<div class="slds-form-element"><span class="slds-form-element__label">* Title</span><div><input id="title" type="text" value="KA write probe test" style="width:300px"></div></div><div class="slds-form-element"><span class="slds-form-element__label">Multimedia <span>i</span></span><div><textarea id="mm" style="width:400px;height:40px"></textarea></div></div>'+frame('KB','KB Content',kbHtml)+frame('REL','Related Content','<p>stress junk</p>');
  return r.fulfill({contentType:'text/html',body:'<html><head><meta charset=utf-8></head><body>'+form+'</body></html>'}); });
 await p.addInitScript({content:`window.GM_xmlhttpRequest=o=>{window.__gm(o.url,o.responseType).then(r=>{ if(r.b){ const bin=atob(r.b); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); o.onload({status:200,response:new Blob([u],{type:'image/png'})}); } else o.onload({status:200,responseText:r.t}); })};window.GM_addStyle=c=>{const s=document.createElement('style');s.textContent=c;document.documentElement.appendChild(s)};window.GM_registerMenuCommand=()=>{};document.addEventListener('DOMContentLoaded',()=>{(0,eval)(${JSON.stringify(script)})});`});
 // 1. build the demo
 answers=[true];
 await p.goto(SF+'/lightning/r/Knowledge__kav/'+TEST+'/view'); await p.waitForTimeout(900);
 await p.click('#kwp-btn'); await p.click('button[data-m=demo]',{timeout:15000}); await p.waitForSelector('#kwp-copy',{timeout:30000});
 console.log('SEED:', (await p.$eval('#kwp-box',x=>x.innerText)).replace(/\n+/g,' / '));
 console.log('title=',await p.$eval('#title',e=>e.value),'| mm=',(await p.$eval('#mm',e=>e.value)).slice(0,40));
 kbHtml=await p.$eval('iframe[data-k=KB]',f=>f.contentDocument.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g,''));
 // 2. "save", reopen edit, update from doc
 answers=['https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit'];
 await p.reload(); await p.waitForTimeout(900); await p.click('#kwp-btn'); await p.click('button[data-m=doc]',{timeout:15000}); await p.waitForSelector('#kwp-copy',{timeout:30000});
 console.log('UPDATE:', (await p.$eval('#kwp-box',x=>x.innerText)).replace(/\n+/g,' / '));
 const after=await p.$eval('iframe[data-k=KB]',f=>f.contentDocument.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g,''));

 const report=await p.$eval('#kwp-box',x=>x.innerText);
 assert.ok(/2\. 100% match with Salesforce/.test(report) && !/NO MATCH/.test(report), report);
 assert.ok(/The box now matches the Doc/.test(report), report);
 ['Oct 8, 2026','within 12 hours','They check the customer','$20\u2013$50','in their first 30 days','If both look right','Weekly budget'].forEach(w=>assert.ok(after.indexOf(w)!==-1,'missing '+w));
 assert.ok(!/Leads older than 30 days/.test(after),'deleted bullet still there');
 assert.ok(!/\$15\u2013\$45/.test(after),'old price still there');
 assert.strictEqual((after.match(/rtaImage/g)||[]).length,2,'old + new screenshot uploaded');
 assert.ok(/<li>Oct 8, 2026[^<]*<\/li><li>Sep 30/.test(after),'new update is the first bullet');
 assert.ok(/<p>New screenshot of the updated Jobs tab:<\/p><p><br><img/.test(after),'new screenshot after its caption');
 assert.deepStrictEqual(errs,[]); await b.close(); console.log('\nupdate from doc e2e ok');
})().catch(e=>{console.error(e);process.exit(1)});
