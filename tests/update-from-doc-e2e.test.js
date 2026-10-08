// End-to-end test of the probe's demo: build the demo article in a fake editor (5 boxes),
// then "Update from Doc" with tools/demo/demo-google-export.html (the demo .docx
// shaped like Google's HTML export). Checks the 100% match, every change, the title and the images.
// Also checks: the link field survives a tab switch, and a Doc that does not match changes nothing.
// Run: node tests/update-from-doc-e2e.test.js   (needs Playwright + Chromium)
const assert=require('assert'),fs=require('fs'),path=require('path');const {execSync}=require('child_process');
const {chromium}=require(path.join(execSync('npm root -g').toString().trim(),'playwright'));
const SF='https://thumbtack.lightning.force.com'; const TEST='ka2Vx0000003JULIA2';
const LINK='https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit';
let EXPORT=fs.readFileSync(path.join(__dirname,'..','tools','demo','demo-google-export.html'),'utf8'); const NEWPNG=fs.readFileSync(path.join(__dirname,'..','tools','demo','demo-jobs-new.png')).toString('base64');
const uploader = `<script>document.body.addEventListener('paste',e=>{const f=e.clipboardData.files[0]; if(!f) return; e.preventDefault(); const s=getSelection(); const r=s.getRangeAt(0); const im=document.createElement('img'); im.src=URL.createObjectURL(f); r.insertNode(im); setTimeout(()=>{im.src='https://thumbtack.file.force.com/servlet/rtaImage?refid=0EM'+Math.random().toString(36).slice(2,8)},700)});<\/script>`;
const BOXES=[['KB','KB Content'],['REL','Related Content'],['MC','MC Content'],['ADDL','Additional Content'],['SUP','Support Content']];
const frame=(k,l,html)=>`<div><label>${l}</label><iframe data-k="${k}" style="width:700px;height:300px" srcdoc="${('<html><head><meta charset=utf-8></head><body contenteditable=true>'+html+uploader+'</body></html>').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"></iframe></div>`;
(async()=>{
 const script=fs.readFileSync(path.join(__dirname,'..','tools','ka-write-probe.user.js'),'utf8');
 const b=await chromium.launch(); const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 p.on('dialog',d=>d.accept());
 let html={KB:'<p>Hola prueba</p><h2>KA image paste test</h2>',REL:'<p>stress junk</p>',MC:'<p>more junk</p>',ADDL:'',SUP:'<p>x</p>'}; let title='KA write probe test';
 await p.exposeFunction('__gm',async(url,type)=>{ if(/export\?format=html/.test(url)) return {t:EXPORT}; if(/googleusercontent/.test(url)) return {b:NEWPNG}; return {t:''}; });
 await p.route(SF+'/**',async r=>{ const u=new URL(r.request().url());
  const rich=Object.fromEntries(BOXES.map(([k,l])=>[k+'__c',{dataType:'TextArea',htmlFormatted:true,updateable:true,label:l,length:131072}]));
  if(u.pathname.endsWith('/object-info/Knowledge__kav')) return r.fulfill({contentType:'application/json',body:JSON.stringify({fields:Object.assign(rich,{Multimedia__c:{dataType:'TextArea',updateable:true,label:'Multimedia',length:10072}})})});
  if(u.pathname.includes('/ui-api/records/')) return r.fulfill({contentType:'application/json',body:JSON.stringify({fields:{Title:{value:title},PublishStatus:{value:'Draft'},VersionNumber:{value:0},KB__c:{value:'<p>x</p>'}}})});
  const form='<div class="slds-form-element"><span class="slds-form-element__label">* Title</span><div><input id="title" type="text" value="'+title+'" style="width:300px"></div></div><div class="slds-form-element"><span class="slds-form-element__label">Multimedia <span>i</span></span><div><textarea id="mm" style="width:400px;height:40px"></textarea></div></div>'+BOXES.map(([k,l])=>frame(k,l,html[k])).join('');
  return r.fulfill({contentType:'text/html',body:'<html><head><meta charset=utf-8></head><body>'+form+'</body></html>'}); });
 await p.addInitScript({content:`window.GM_xmlhttpRequest=o=>{window.__gm(o.url,o.responseType).then(r=>{ if(r.b){ const bin=atob(r.b); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); o.onload({status:200,response:new Blob([u],{type:'image/png'})}); } else o.onload({status:200,responseText:r.t}); })};window.GM_addStyle=c=>{const s=document.createElement('style');s.textContent=c;document.documentElement.appendChild(s)};window.GM_registerMenuCommand=()=>{};document.addEventListener('DOMContentLoaded',()=>{(0,eval)(${JSON.stringify(script)})});`});
 const save=async()=>{ for(const [k] of BOXES) html[k]=await p.$eval('iframe[data-k='+k+']',f=>f.contentDocument.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g,'')); title=await p.$eval('#title',e=>e.value); };
 const box=async()=>(await p.$eval('#kwp-box',x=>x.innerText)).replace(/\n+/g,' / ');

 // 1. build the demo, "save"
 await p.goto(SF+'/lightning/r/Knowledge__kav/'+TEST+'/view'); await p.waitForTimeout(900);
 await p.click('#kwp-btn'); await p.click('button[data-m=demo]',{timeout:15000}); await p.waitForSelector('#kwp-copy',{timeout:30000});
 const seedRep=await box(); console.log('SEED:', seedRep);
 assert.ok(!/✗/.test(seedRep), seedRep);
 await save();
 assert.strictEqual(title,'Demo: Pro account guide (Pro)');
 assert.ok(/Demo article/.test(html.KB) && /Related articles/.test(html.REL) && /Internal notes/.test(html.SUP),'seeded boxes');
 assert.ok(!/junk/.test(html.REL+html.MC),'other boxes cleared');
 assert.strictEqual((html.KB.match(/rtaImage/g)||[]).length,2,'2 screenshots seeded');

 // 2. a Doc that does NOT match: nothing changes, the link field comes back
 const good=EXPORT; EXPORT=EXPORT.replace('Read the project details.','Read the project details carefully.');
 await p.reload(); await p.waitForTimeout(900); await p.click('#kwp-btn'); await p.click('button[data-m=doc]',{timeout:15000});
 await p.fill('#kwp-link',LINK);
 // writer goes to another tab and comes back: the field is still there
 const other=await b.newPage(); await other.goto('about:blank'); await other.bringToFront(); await p.waitForTimeout(400); await p.bringToFront(); await other.close();
 assert.strictEqual(await p.$eval('#kwp-link',e=>e.value),LINK,'link kept after switching tabs');
 const before=await p.$eval('iframe[data-k=KB]',f=>f.contentDocument.body.innerHTML);
 await p.click('#kwp-go'); await p.waitForSelector('#kwp-link',{timeout:30000});
 const r1=await box(); console.log('NO MATCH:', r1);
 assert.ok(/NO MATCH/.test(r1) && /carefully/.test(r1), r1);
 assert.strictEqual(await p.$eval('iframe[data-k=KB]',f=>f.contentDocument.body.innerHTML),before,'nothing changed on NO MATCH');
 assert.strictEqual(await p.$eval('#kwp-link',e=>e.value),LINK,'link remembered for the retry');

 // 3. fix the Doc, try again from the same box
 EXPORT=good; await p.click('#kwp-go'); await p.waitForSelector('#kwp-copy',{timeout:30000});
 const report=await box(); console.log('UPDATE:', report);
 assert.ok(/2\. 100% match with Salesforce/.test(report) && !/NO MATCH/.test(report), report);
 assert.ok(/The boxes now match the Doc/.test(report), report);
 await save();
 const kb=html.KB, rel=html.REL, sup=html.SUP;
 fs.writeFileSync(path.join(require('os').tmpdir(),'demo-after.html'),'<h1>'+title+'</h1>'+kb+'<hr>'+rel+'<hr>'+sup);
 // title
 assert.strictEqual(title,'Demo: Pro account complete guide (Pro)');
 // inline adds / replacements
 ['It is also a good start for new hires','from the search results','in about 10 minutes','$20–$50','in their first 30 days','resets every Monday',
  'reviewed in 3 to 5 business days','If both look right, ask them to update the app'].forEach(w=>assert.ok(kb.indexOf(w)!==-1,'KB missing '+w));
 ['by name','about 15 minutes','$15–$45','every Sunday','5 to 7','A fax number','Has a website','Lead quality score','hidden quality score','Spotlight'].forEach(w=>assert.ok(kb.indexOf(w)===-1,'KB still has '+w));
 // new bullets/steps in the right place
 assert.ok(/<li>Oct 8, 2026[^<]*<\/li><li>Sep 30/.test(kb),'new update is the first bullet');
 assert.ok(/<li>Add the services they offer\.<ul><li>Pick the main category first\.<\/li><li>Add up to 10 related services\.<\/li><\/ul><\/li>/.test(kb),'new sub-bullet under its step');
 assert.ok(/<li>Add a payment method\.<\/li><li>Turn on notifications so no lead is missed\.<\/li><\/ol>/.test(kb),'new last step');
 assert.ok(/<li>Distance from their address<\/li><li>Specific ZIP codes<\/li><\/ul><\/li><li>Availability/.test(kb),'new nested bullet');
 assert.ok(/Pros can reply to each review once\.<\/li><li>Pros can ask past customers/.test(kb),'new bullet inside dropdown');
 assert.ok(/<p>A pro with a \$100[^<]*<\/p><p>After that, they stop/.test(kb),'new paragraph inside dropdown');
 assert.ok(/<li>If it still fails, ask them to clear the app cache\.<\/li><\/ol><\/details>/.test(kb),'new step inside dropdown');
 assert.ok(/<li>Send a quote or a message\.<\/li><li>Follow up if/.test(kb),'new step in Messages');
 // table rows
 assert.ok(/<td[^>]*>Instant match<\/td><td[^>]*>The pro is matched right away/.test(kb),'new table row');
 assert.ok(/<td[^>]*>Duplicate lead from the same customer<\/td><td[^>]*>Yes<\/td><\/tr><\/tbody>/.test(kb),'new last table row');
 assert.ok(!/Old name for featured placement/.test(kb),'deleted table row');
 // new section + Contents link
 assert.ok(/<h2 id="pausing-the-account">12\. Pausing the account<\/h2><p>Pros can pause[^<]*<\/p><ol><li>Go to Settings\.<\/li><li>Tap Pause account\.<\/li><li>Pick an end date \(optional\)\.<\/li><\/ol><h2 id="res">13\. Resources/.test(kb),'new section before Resources');
 assert.ok(/<li><a href="#try">Try it<\/a><\/li><li><a href="#pausing-the-account">Pausing the account<\/a><\/li><li><a href="#res">Resources/.test(kb),'new Contents entry linked');
 // links
 assert.ok(/<a href="https:\/\/help\.thumbtack\.com\/" target="_blank">Help Center: Payments and refunds<\/a>/.test(kb),'link text extended inside the same link');
 assert.ok(/<li><a href="[^"]*Weekly-budget" target="_blank">KA: Weekly budget \(Pro\)<\/a><\/li><\/ul>/.test(kb),'new link bullet');
 // images
 assert.strictEqual((kb.match(/rtaImage/g)||[]).length,3,'2 old + 1 new screenshot');
 assert.ok(/<p>New screenshot of the updated Jobs tab:<\/p><p><br><img/.test(kb),'new screenshot after its caption');
 // other boxes
 assert.ok(/Lead credits[\s\S]*Top Pro program[\s\S]*Pausing the account \(Pro\)/.test(rel) && !/Spotlight/.test(rel),'Related Content changes');
 assert.ok(/<td[^>]*>2 business days<\/td>/.test(sup),'Support: 3 -> 2 days');
 assert.ok(/<td[^>]*>Lead fraud<\/td>/.test(sup),'Support: new row');
 assert.ok(/what you checked\. Include screenshots when you can\./.test(sup),'Support: added sentence');
 assert.deepStrictEqual(errs,[]); await b.close(); console.log('\nupdate from doc e2e ok');
})().catch(e=>{console.error(e);process.exit(1)});
