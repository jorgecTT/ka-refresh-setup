// End-to-end test of "Refresh outdated" in the admin userscript: it must read
// the ka_audit tab, open ONLY the "Desactualizado" KAs by their record link,
// and send one sync per KA with the content read from the page.
// Run: node tests/refresh-outdated-e2e.test.js   (needs Playwright + Chromium)

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
const AUDIT_CSV = [
  '"estado","equipo","título","número KA","Salesforce","Doc","modificado en Salesforce","último cambio del Doc","nota","auditado"',
  ...Object.entries(KAS).map(([id, k], i) =>
    `"${i < 2 ? 'Desactualizado' : 'OK'}","Trust & Safety","${k.title}","${k.num}","${SF}/lightning/r/Knowledge__kav/${id}/view","","","","",""`),
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
  const syncs = [];
  await page.exposeFunction('__gm', (url, body) => {
    if (/docs\.google\.com\/spreadsheets/.test(url)) return AUDIT_CSV;
    const req = JSON.parse(body);
    if (req.action === 'sync') syncs.push(req);
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
  await page.waitForSelector('#kar-outdated-btn', { timeout: 10000 });
  await page.click('#kar-outdated-btn');
  await page.waitForFunction(() => /Batch done/.test((document.getElementById('kar-overlay-body') || {}).innerText || ''), null, { timeout: 120000 });
  const overlay = await page.$eval('#kar-overlay-body', b => b.innerText);
  console.log(overlay);

  assert.deepStrictEqual(syncs.map(s => s.title), ['Pro reports', 'Leads (Pro)'], 'only the outdated KAs are synced');
  assert.deepStrictEqual(syncs.map(s => s.kaId), ['000008319', '000007636']);
  assert.deepStrictEqual(syncs.map(s => s.url), [SF + '/articles/Knowledge/Pro-reports', SF + '/articles/Knowledge/Leads-Pro']);
  assert.ok(syncs.every(s => s.secret === 'k' && s.mode === 'update' && /Overview/.test(s.html)));
  assert.ok(/2 updated/.test(overlay) && /Audit again/.test(overlay), overlay);
  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('\nrefresh outdated e2e ok');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
