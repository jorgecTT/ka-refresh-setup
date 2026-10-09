// End-to-end test of "📅 Weekly report" in the admin userscript: it reads the
// Published Articles list with the editor's name and the publish dates, posts
// it and the Archived Articles list (with who archived) to the backend ('weekly')
// and shows the counts. If Salesforce refuses the
// date fields, it asks again with fewer fields instead of failing.
// Run: node tests/weekly-e2e.test.js   (needs Playwright + Chromium)
const assert = require('assert'), fs = require('fs'), path = require('path');
const { execSync } = require('child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const SF = 'https://thumbtack.lightning.force.com';

async function run(refuseDates, oldBackend) {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept());
  const posts = [], asked = [];
  await p.exposeFunction('__gm', (url, body) => {
    const req = JSON.parse(body || '{}');
    posts.push(req);
    if (req.action === 'weekly' && oldBackend) return JSON.stringify({ ok: false, code: 'BAD_ACTION', error: 'Unknown action: weekly' });
    if (req.action === 'weekly') return JSON.stringify({ ok: true, counts: { NEW: 1, NEW_VERSION: 2, MINOR_EDIT: 3, ARCHIVED: 1 }, week: 'Oct 3 – Oct 10', firstRun: true, sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit' });
    return JSON.stringify({ ok: true });
  });
  await p.route(SF + '/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith('/ui-api/list-info/Knowledge__kav')) return r.fulfill({ status: 404, contentType: 'application/json', body: '[]' });
    if (u.pathname.endsWith('/ui-api/list-ui/Knowledge__kav')) return r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ lists: [{ apiName: 'Published_Articles', label: 'Published Articles' }, { apiName: 'Archived_Articles', label: 'Archived Articles' }] }) });
    if (u.pathname.includes('/ui-api/list-records/Knowledge__kav/Archived_Articles')) {
      const f = u.searchParams.get('optionalFields') || '';
      const fields = { Title: { value: 'Old program' }, ArticleNumber: { value: '000009000' }, VersionNumber: { value: 3 }, LastModifiedDate: { value: '2026-10-08T10:00:00.000Z' } };
      if (/ArchivedDate/.test(f)) Object.assign(fields, { ArchivedDate: { value: '2026-10-08T10:00:00.000Z' }, ArchivedBy: { displayValue: 'Sam Editor' } });
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ records: [{ id: 'ka2Vx0000000000ARC', fields }], nextPageToken: null }) });
    }
    if (u.pathname.includes('/ui-api/list-records/Knowledge__kav/Published_Articles')) {
      const f = u.searchParams.get('optionalFields') || '';
      asked.push(f);
      if (refuseDates && /FirstPublishedDate/.test(f)) return r.fulfill({ status: 400, contentType: 'application/json', body: '[{"errorCode":"INVALID_FIELD"}]' });
      const fields = { Title: { value: 'Leads (Pro)' }, ArticleNumber: { value: '000007636' }, UrlName: { value: 'Leads-Pro' },
        VersionNumber: { value: 46 }, LastModifiedDate: { value: '2026-10-09T15:00:00.000Z' },
        LastModifiedBy: { displayValue: 'Nichole Jensen', value: { fields: { Name: { value: 'Nichole Jensen' } } } } };
      if (/FirstPublishedDate/.test(f)) Object.assign(fields, { FirstPublishedDate: { value: '2025-01-01T00:00:00.000Z' },
        LastPublishedDate: { value: '2026-10-09T15:00:00.000Z' }, ArticleCreatedBy: { displayValue: 'Ana Writer' } });
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ records: [{ id: 'ka2Vx0000000000BBB', fields }], nextPageToken: null }) });
    }
    return r.fulfill({ contentType: 'text/html', body: '<html><body><h1>KA page</h1></body></html>' });
  });
  const script = fs.readFileSync(path.join(__dirname, '..', 'tampermonkey', 'kaRefresh-admin.user.js'), 'utf8');
  await p.addInitScript({ content: `
    window.unsafeWindow = window;
    window.GM_getValue = (k, d) => { const v = localStorage.getItem('gm_' + k); return v === null ? d : v; };
    window.GM_setValue = (k, v) => localStorage.setItem('gm_' + k, v);
    window.GM_addStyle = (c) => { const s = document.createElement('style'); s.textContent = c; (document.head || document.documentElement).appendChild(s); };
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = (o) => { window.__gm(o.url, o.data || '').then(t => o.onload({ status: 200, responseText: t })); };
    if (window.top === window.self) document.addEventListener('DOMContentLoaded', () => { (0, eval)(${JSON.stringify(script)}); });
  ` });
  await p.goto(SF + '/lightning/r/Knowledge__kav/ka2Vx0000000000BBB/view');
  await p.evaluate(() => { localStorage.setItem('gm_KAR2_reviewer', 'Jorge'); localStorage.setItem('gm_KAR2_secret', 'k'); });
  await p.reload(); await p.waitForSelector('#kar-weekly-btn', { timeout: 10000 });
  await p.click('#kar-weekly-btn');
  await p.waitForFunction(() => /Weekly report (sent|stopped)/.test((document.getElementById('kar-overlay-body') || {}).innerText || ''), null, { timeout: 30000 });
  const overlay = await p.$eval('#kar-overlay-body', x => x.innerText.replace(/\s+/g, ' '));
  const weekly = posts.find(x => x.action === 'weekly');
  await b.close();
  return { overlay, weekly, asked, errs };
}

(async () => {
  let r = await run(false);
  console.log('OVERLAY:', r.overlay);
  assert.ok(/Weekly report sent/.test(r.overlay) && /5 updated \(2 new version · 3 minor\) · 1 new · 1 archived/.test(r.overlay), r.overlay);
  assert.strictEqual(r.weekly.by, 'Jorge');
  const k = r.weekly.published[0];
  assert.deepStrictEqual([k.articleNumber, k.version, k.lastModifiedBy, k.createdBy, k.firstPublished, k.lastPublished],
    ['000007636', 46, 'Nichole Jensen', 'Ana Writer', '2025-01-01T00:00:00.000Z', '2026-10-09T15:00:00.000Z']);
  assert.deepStrictEqual(r.weekly.archived, [{ id: 'ka2Vx0000000000ARC', articleNumber: '000009000', title: 'Old program', version: 3,
    archived: '2026-10-08T10:00:00.000Z', archivedBy: 'Sam Editor' }]);
  assert.deepStrictEqual(r.errs, []);

  r = await run(true);
  console.log('FALLBACK asked:', r.asked.map(f => (f.match(/FirstPublishedDate/) ? 'dates' : 'no dates')).join(', '));
  assert.ok(/Weekly report sent/.test(r.overlay), r.overlay);
  assert.strictEqual(r.weekly.published[0].lastModifiedBy, 'Nichole Jensen', 'still has the editor without the dates');
  assert.strictEqual(r.weekly.published[0].firstPublished, '');
  assert.deepStrictEqual(r.errs, []);
  // an old Code.gs answers "unknown action": the box says so and how to check it
  r = await run(false, true);
  console.log('OLD BACKEND:', r.overlay);
  assert.ok(/Weekly report stopped: Google is running a Code\.gs older than 2\.4\.2/.test(r.overlay), r.overlay);
  assert.ok(/only Code\.gs/.test(r.overlay) && /"server":"2\.4\.2"/.test(r.overlay), r.overlay);
  assert.deepStrictEqual(r.errs, []);
  console.log('\nweekly e2e ok');
})().catch(e => { console.error(e); process.exit(1); });
