// End-to-end test of "Fix from audit" in the admin userscript: it lists the
// flagged rows of ka_audit, you tick what you accept, and it creates the
// missing Docs (with the report's team), updates the outdated ones and
// archives the extra Docs you ticked. Rows it can't fix are not selectable.
// Run: node tests/fix-from-audit-e2e.test.js   (needs Playwright + Chromium)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const SF = 'https://thumbtack.lightning.force.com';
const KAS = {
  ka2Vx0000000000AAA: { title: 'Pro reports', num: '000008319', slug: 'Pro-reports', version: '6' },
  ka2Vx0000000000BBB: { title: 'Leads (Pro)', num: '000007636', slug: 'Leads-Pro', version: '45' },
  ka2Vx0000000000CCC: { title: 'Already fine', num: '000001111', slug: 'Fine', version: '3' },
};
const DOC = 'https://docs.google.com/document/d/1YVAvTzKSBcq5sMy82q31hG0C_BOAwutpnKRdSXN88zM/edit';
const rec = id => SF + '/lightning/r/Knowledge__kav/' + id + '/view';
const AUDIT_CSV = [
  '"status","team","title","KA number","Salesforce","Doc","modified in Salesforce","modified by","last Doc change","note","audited"',
  `"In Salesforce, no Doc","Trust & Safety","Pro reports","000008319","${rec('ka2Vx0000000000AAA')}","","","Ana Writer","","",""`,
  `"Outdated","Support Ops","Leads (Pro)","000007636","${rec('ka2Vx0000000000BBB')}","https://docs.google.com/document/d/1aaaaaaaaaaaaaaaaaaaaaaaaaaaa/edit","","","","",""`,
  `"Extra Doc (not in any report)","Trust & Safety","Incident mediation","000008310","","${DOC}","","","","",""`,
  `"Duplicate Docs","GTM","Two docs","000009999","${rec('ka2Vx0000000000CCC')}","","","","","",""`,
  `"OK","GTM","Already fine","000001111","${rec('ka2Vx0000000000CCC')}","","","","","",""`,
].join('\n');

// Just enough of a Lightning record page for the script's field readers.
function kaPage(id) {
  const k = KAS[id];
  const field = (label, value) =>
    `<records-record-layout-item><span class="test-id__field-label">${label}</span>` +
    `<span class="test-id__field-value">${value}</span></records-record-layout-item>`;
  return `<html><body><h1>${k.title}</h1>
    ${field('Title', k.title)}${field('Article Number', k.num)}${field('URL Name', k.slug)}${field('Version Number', k.version)}
    <records-record-layout-item><span class="test-id__field-label">KB Content</span>
      <lightning-formatted-rich-text><h2>Overview</h2><p>This is the body of ${k.title}, long enough to be read as content.</p></lightning-formatted-rich-text>
    </records-record-layout-item></body></html>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const syncs = [], archives = [];
  await page.exposeFunction('__gm', (url, body) => {
    if (/docs\.google\.com\/spreadsheets/.test(url)) return AUDIT_CSV;
    const req = JSON.parse(body);
    if (req.action === 'sync') syncs.push(req);
    if (req.action === 'archive') { archives.push(req); return JSON.stringify({ ok: true, moved: req.docIds.length }); }
    return JSON.stringify({ ok: true, mode: 'update', filename: req.title, docUrl: 'https://docs.google.com/document/d/x/edit' });
  });
  await page.route(SF + '/**', r => {
    const m = new URL(r.request().url()).pathname.match(/\/lightning\/r\/Knowledge__kav\/([^/]+)\//);
    return r.fulfill({ contentType: 'text/html', body: m && KAS[m[1]] ? kaPage(m[1]) : '<html><body>start</body></html>' });
  });

  const script = fs.readFileSync(path.join(__dirname, '..', 'tampermonkey', 'kaRefresh-admin.user.js'), 'utf8');
  await page.addInitScript({ content: `
    window.unsafeWindow = window;
    window.GM_getValue = (k, d) => { const v = localStorage.getItem('gm_' + k); return v === null ? d : v; };
    window.GM_setValue = (k, v) => localStorage.setItem('gm_' + k, v);
    window.GM_addStyle = (c) => { const s = document.createElement('style'); s.textContent = c; (document.head || document.documentElement).appendChild(s); };
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = (o) => { window.__gm(o.url, o.data || '').then(t => o.onload({ status: 200, responseText: t })); };
    if (window.top === window.self) document.addEventListener('DOMContentLoaded', () => { (0, eval)(${JSON.stringify(script)}); });
  ` });

  await page.goto(SF + '/lightning/r/Knowledge__kav/ka2Vx0000000000CCC/view');
  await page.evaluate(() => { localStorage.setItem('gm_KAR2_reviewer', 'Jorge'); localStorage.setItem('gm_KAR2_secret', 'k'); });
  await page.reload();
  await page.waitForSelector('#kar-fix-btn', { timeout: 10000 });
  await page.click('#kar-fix-btn');
  await page.waitForSelector('#kar-fix-go');
  const list = await page.$$eval('.kar-fix-list label', ls => ls.map(l => [l.innerText.replace(/\s+/g, ' ').trim(), l.querySelector('input').checked, l.querySelector('input').disabled]));
  console.log(list);
  assert.strictEqual(list.length, 4, 'OK rows are not listed');
  assert.ok(/last edit: Ana Writer/.test(list[0][0]), 'shows who last edited it');
  assert.deepStrictEqual(list.map(x => [x[1], x[2]]), [[true, false], [true, false], [false, false], [false, true]],
    'create/update ticked, archive unticked by default, duplicates not selectable');
  await page.check('.kar-fix-list input[data-i="2"]');   // accept the archive
  assert.strictEqual(await page.$eval('#kar-fix-go', b => b.textContent), 'Do selected (3)');
  await page.click('#kar-fix-go');
  await page.waitForFunction(() => /Fixes done/.test((document.getElementById('kar-overlay-body') || {}).innerText || ''), null, { timeout: 120000 });
  const overlay = await page.$eval('#kar-overlay-body', b => b.innerText);
  console.log(overlay);

  assert.deepStrictEqual(archives.map(a => a.docIds), [['1YVAvTzKSBcq5sMy82q31hG0C_BOAwutpnKRdSXN88zM']]);
  assert.strictEqual(archives[0].by, 'Jorge');
  assert.deepStrictEqual(syncs.map(s => [s.title, s.mode, s.audience]), [['Pro reports', 'create', 'Trust & Safety'], ['Leads (Pro)', 'update', '']]);
  assert.ok(syncs.every(s => s.secret === 'k' && /Overview/.test(s.html)));
  assert.ok(/2 synced/.test(overlay) && /1 Doc\(s\) archived/.test(overlay) && /Audit again/.test(overlay), overlay);
  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('\nfix from audit e2e ok');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
