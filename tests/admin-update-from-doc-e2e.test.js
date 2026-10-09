// End-to-end test of "✎ Update from Doc" in the ADMIN userscript (the same code
// as the probe, now in the bar): the demo article is already in a fake edit
// form (5 boxes), the writer pastes the Doc link and the changes land.
// Also: "Test 5" is gone, and clicking without the edit form open says "Click Edit first".
// Run: node tests/admin-update-from-doc-e2e.test.js   (needs Playwright + Chromium)
const assert = require('assert'), fs = require('fs'), path = require('path');
const { execSync } = require('child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const SF = 'https://thumbtack.lightning.force.com', ID = 'ka2Vx0000003JULIA2';
const DEMO = path.join(__dirname, '..', 'tools', 'demo');
const EXPORT = fs.readFileSync(path.join(DEMO, 'demo-google-export.html'), 'utf8');
const NEWPNG = fs.readFileSync(path.join(DEMO, 'demo-jobs-new.png')).toString('base64');
const seedJs = fs.readFileSync(path.join(DEMO, 'demo-seed.js'), 'utf8');
const SEED = JSON.parse(seedJs.match(/DEMO_SEED = (\{.*\});/)[1]);
const TITLE = JSON.parse(seedJs.match(/DEMO_TITLE = (".*");/)[1]);
const uploader = `<script>document.body.addEventListener('paste',e=>{const f=e.clipboardData.files[0]; if(!f) return; e.preventDefault(); const r=getSelection().getRangeAt(0); const im=document.createElement('img'); im.src=URL.createObjectURL(f); r.insertNode(im); setTimeout(()=>{im.src='https://thumbtack.file.force.com/servlet/rtaImage?refid=0EMnew'},500)});<\/script>`;
const BOXES = ['KB Content', 'Related Content', 'MC Content', 'Additional Content', 'Support Content'];
const boxHtml = l => (SEED[l] || '').replace(/<p id="kwp-seed-img-[^"]+"><br><\/p>/g, '<p><img src="https://thumbtack.file.force.com/servlet/rtaImage?refid=0EMold"></p>')
  .replace('<p>{{FIGMA_IFRAME}}</p>', '<p><iframe src="about:blank"></iframe></p>');
const frame = (l, i) => `<div class="slds-form-element"><span class="slds-form-element__label">${l}</span><iframe data-k="${i}" style="width:700px;height:200px" srcdoc="${('<html><head><meta charset=utf-8></head><body contenteditable=true>' + boxHtml(l) + uploader + '</body></html>').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></div>`;

(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  let editing = false;
  await p.exposeFunction('__gm', async (url) => {
    if (/export\?format=html/.test(url)) return { t: EXPORT };
    if (/googleusercontent/.test(url)) return { b: NEWPNG };
    return { t: '{"ok":true}' };
  });
  await p.route(SF + '/**', r => r.fulfill({ contentType: 'text/html', body: '<html><head><meta charset=utf-8></head><body><h1>' + TITLE + '</h1>' +
    (editing ? '<div class="slds-form-element"><span class="slds-form-element__label">* Title</span><input id="title" type="text" value="' + TITLE + '" style="width:300px"></div>' +
      BOXES.map(frame).join('') : '<p>view mode</p>') + '</body></html>' }));
  const script = fs.readFileSync(path.join(__dirname, '..', 'tampermonkey', 'kaRefresh-admin.user.js'), 'utf8');
  await p.addInitScript({ content: `
    window.unsafeWindow = window;
    window.GM_getValue = (k, d) => { const v = localStorage.getItem('gm_' + k); return v === null ? d : v; };
    window.GM_setValue = (k, v) => localStorage.setItem('gm_' + k, v);
    window.GM_addStyle = (c) => { const s = document.createElement('style'); s.textContent = c; (document.head || document.documentElement).appendChild(s); };
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = o => { window.__gm(o.url).then(r => { if (r.b) { const bin = atob(r.b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); o.onload({ status: 200, response: new Blob([u], { type: 'image/png' }) }); } else o.onload({ status: 200, responseText: r.t }); }); };
    if (window.top === window.self) document.addEventListener('DOMContentLoaded', () => { (0, eval)(${JSON.stringify(script)}); });
  ` });
  const url = SF + '/lightning/r/Knowledge__kav/' + ID + '/view';
  await p.goto(url);
  await p.evaluate(() => { localStorage.setItem('gm_KAR2_reviewer', 'Jorge'); localStorage.setItem('gm_KAR2_secret', 'k'); });
  await p.reload(); await p.waitForSelector('#kar-ufd-btn', { timeout: 10000 });
  const bar = await p.$eval('#kar-bar', x => x.innerText.replace(/\s+/g, ' '));
  console.log('BAR:', bar);
  assert.ok(!/Test 5/.test(bar), 'Test 5 removed');
  assert.ok(/Update from Doc/.test(bar), 'new button in the bar');

  // not editing: tells the writer to click Edit
  await p.click('#kar-ufd-btn'); await p.waitForSelector('#kwp-copy');
  assert.ok(/Click Edit first/.test(await p.$eval('#kwp-box', x => x.innerText)));
  await p.click('#kwp-close');

  // edit form open: paste the link, apply
  editing = true; await p.reload(); await p.waitForSelector('#kar-ufd-btn'); await p.waitForTimeout(600);
  await p.click('#kar-ufd-btn'); await p.waitForSelector('#kwp-link');
  await p.fill('#kwp-link', 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit');
  await p.click('#kwp-go'); await p.waitForSelector('#kwp-copy', { timeout: 30000 });
  const rep = (await p.$eval('#kwp-box', x => x.innerText)).replace(/\n+/g, ' / ');
  console.log('REPORT:', rep);
  assert.ok(/100% match/.test(rep) && !/NO MATCH/.test(rep), rep);
  assert.ok(/The boxes now match the Doc/.test(rep), rep);
  assert.strictEqual(await p.$eval('#title', e => e.value), 'Demo: Pro account complete guide (Pro)');
  const kb = await p.$eval('iframe[data-k="0"]', f => f.contentDocument.body.innerHTML);
  const sup = await p.$eval('iframe[data-k="4"]', f => f.contentDocument.body.innerHTML);
  assert.ok(/<h2 id="pausing-the-account">12\. Pausing the account<\/h2>/.test(kb), 'new section');
  assert.ok(/Instant match/.test(kb) && !/Old name for featured placement/.test(kb), 'table rows');
  assert.ok(/rtaImage\?refid=0EMnew/.test(kb), 'new screenshot uploaded');
  assert.ok(/Lead fraud/.test(sup), 'Support Content changed');
  assert.deepStrictEqual(errs, []); await b.close(); console.log('\nadmin update from doc e2e ok');
})().catch(e => { console.error(e); process.exit(1); });
