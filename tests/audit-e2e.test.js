// End-to-end test of the admin userscript's Audit flow against fake
// Salesforce pages and the REAL apps-script/Code.gs (run in Node).
// Run: node tests/audit-e2e.test.js   (needs Playwright + Chromium)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const { loadBackend, post } = require('./apps-script.test.js');

const SF = 'https://thumbtack.lightning.force.com';
const REPORTS = { '00OVx000006OQHFMA4': 'GTM', '00OVx000006GGADMA4': 'Support Ops', '00OVx000006ORWfMAO': 'Trust & Safety' };
const SIZES = { 'GTM': 19, 'Support Ops': 171, 'Trust & Safety': 62 };
const PUB = '1y-wucQGJ2i0y3VSfr1Hv4v-AK5GcNNQf';

// Synthetic KAs: 252 across the 3 teams, ids ka2 + 14 chars.
const kas = [];
for (const team of Object.keys(SIZES)) {
  for (let i = 0; i < SIZES[team]; i++) {
    const n = kas.length + 1;
    kas.push({ team, id: 'ka2Vx' + String(n).padStart(13, '0'), num: String(n).padStart(9, '0'),
               title: team + ' article ' + i, slug: team.replace(/\W/g, '') + '-' + i,
               lastModified: '2026-09-01T10:00:00.000Z' });
  }
}
// Drive: Docs for all but 3; 3 outdated; 1 extra.
const files = {};
kas.forEach((k, i) => {
  if (i % 90 === 7) return;
  files['doc' + i] = { folder: PUB, title: k.title + ' - internal - ' + k.team + ' - EN',
    description: 'KA_META:' + k.num + '|' + SF + '/articles/knowledge/' + k.slug + '|\n',
    modifiedDate: i % 120 === 11 ? '2026-08-01T00:00:00Z' : '2026-09-15T00:00:00Z' };
});
files.extra = { folder: PUB, title: 'Retired - internal - GTM - EN', description: 'KA_META:000999999|x|\n', modifiedDate: '2026-09-15T00:00:00Z' };

// A report page like Salesforce's: the table lives in an iframe, only ~33 rows
// are drawn at a time, rows arrive in batches of 100 (the next batch takes
// 2.5 s after you reach the bottom) and the <table> element is replaced on
// every redraw.
function reportFrame(team) {
  const rows = kas.filter(k => k.team === team);
  return `<html><body style="margin:0"><div>Total Records ${rows.length}</div>
  <div id="sc" style="height:500px;overflow:auto"><div id="sp" style="position:relative"></div></div>
  <script>
  const rows=${JSON.stringify(rows.map(k => [k.id, k.slug, k.title]))};
  const sc=document.getElementById('sc'), sp=document.getElementById('sp');
  let loaded=Math.min(100, rows.length), loading=false;
  function draw(){ sp.style.height=(loaded*40)+'px';
    const f=Math.floor(sc.scrollTop/40), l=Math.min(loaded,f+33);
    let h='<table style="position:absolute;top:'+(f*40)+'px"><thead><tr><th>Title</th><th>Full Article URL</th></tr></thead><tbody>';
    for(let i=f;i<l;i++){ const r=rows[i];
      h+='<tr style="height:40px"><td>'+(i+1)+'</td><td><a href="/lightning/r/'+r[0]+'/view">'+r[2]+'</a></td>'+
        '<td><a href="/articles/Knowledge/'+r[1]+'">Right click and copy link</a></td></tr>'; }
    sp.innerHTML=h+'</tbody></table>';
    if (!loading && loaded<rows.length && sc.scrollTop+sc.clientHeight>=loaded*40-5) {
      loading=true; setTimeout(()=>{ loaded=Math.min(rows.length, loaded+100); loading=false; draw(); }, 2500); } }
  sc.addEventListener('scroll',()=>setTimeout(draw,60)); setTimeout(draw,800);
  </script></body></html>`;
}

(async () => {
  const backend = loadBackend({ files, props: { SHARED_SECRET: 'the-key' } });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const backendCalls = [];
  await page.exposeFunction('__backend', (body) => {
    backendCalls.push(JSON.parse(body));
    return JSON.stringify(post(backend.g, JSON.parse(body)));
  });

  await page.route(SF + '/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith('/frame/')) return r.fulfill({ contentType: 'text/html', body: reportFrame(REPORTS[u.pathname.split('/')[2]]) });
    const rep = u.pathname.match(/\/lightning\/r\/Report\/([^/]+)\//);
    if (rep) return r.fulfill({ contentType: 'text/html',
      body: '<html><body><h1>Report</h1><iframe src="/frame/' + rep[1] + '" style="width:900px;height:600px"></iframe></body></html>' });
    // Like the real org: /list-info answers 404, /list-ui has the views.
    if (u.pathname.endsWith('/ui-api/list-info/Knowledge__kav')) return r.fulfill({ status: 404, contentType: 'application/json',
      body: '[{"errorCode":"NOT_FOUND","message":"The requested resource does not exist"}]' });
    if (u.pathname.endsWith('/ui-api/list-ui/Knowledge__kav')) return r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ lists: [{ apiName: 'Recent', label: 'Recently Viewed' }, { apiName: 'Published_Articles', label: 'Published Articles' }] }) });
    if (u.pathname.includes('/ui-api/list-records/Knowledge__kav/Published_Articles')) {
      const page2 = u.searchParams.get('pageToken') === '200';
      const slice = page2 ? kas.slice(200) : kas.slice(0, 200);
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({
        records: slice.map(k => ({ id: k.id, fields: { Title: { value: k.title }, ArticleNumber: { value: k.num },
          UrlName: { value: k.slug }, VersionNumber: { value: 1 }, LastModifiedDate: { value: k.lastModified } } })),
        nextPageToken: page2 ? null : '200' }) });
    }
    return r.fulfill({ contentType: 'text/html', body: '<html><body><h1>KA page</h1></body></html>' });
  });

  // Tampermonkey stand-in: GM storage in localStorage (same origin for all pages), Apps Script via __backend.
  const script = fs.readFileSync(path.join(__dirname, '..', 'tampermonkey', 'kaRefresh-admin.user.js'), 'utf8');
  await page.addInitScript({ content: `
    window.unsafeWindow = window;
    window.GM_getValue = (k, d) => { const v = localStorage.getItem('gm_' + k); return v === null ? d : v; };
    window.GM_setValue = (k, v) => localStorage.setItem('gm_' + k, v);
    window.GM_addStyle = (c) => { const s = document.createElement('style'); s.textContent = c; (document.head || document.documentElement).appendChild(s); };
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = (o) => { window.__backend(o.data).then(t => o.onload({ status: 200, responseText: t })); };
    if (window.top === window.self) document.addEventListener('DOMContentLoaded', () => { (0, eval)(${JSON.stringify(script)}); });
  ` });

  await page.goto(SF + '/lightning/r/Knowledge__kav/ka2Vx0000000000001/view');
  await page.evaluate(() => localStorage.setItem('gm_KAR2_reviewer', 'Jorge'));
  await page.reload();
  await page.waitForSelector('#kar-audit-btn', { timeout: 10000 });
  await page.click('#kar-audit-btn');

  // Sync key asked once.
  await page.waitForSelector('#kar-key-input');
  await page.fill('#kar-key-input', 'the-key');
  await page.click('#kar-key-save');

  // Walks the 3 reports, then shows the result.
  await page.waitForFunction(() => /need attention|up to date|stopped|failed/i.test((document.getElementById('kar-overlay-body') || {}).innerText || ''),
    null, { timeout: 180000 });
  const overlay = await page.$eval('#kar-overlay-body', b => b.innerText);
  console.log(overlay);

  const audit = backendCalls.find(c => c.action === 'audit');
  assert.ok(audit, 'audit call sent');
  assert.strictEqual(audit.secret, 'the-key');
  assert.deepStrictEqual(audit.reports.map(r => [r.team, r.rows.length, r.total]),
    [['GTM', 19, 19], ['Support Ops', 171, 171], ['Trust & Safety', 62, 62]]);
  assert.strictEqual(audit.published.length, 252);
  const counts = Object.fromEntries(Object.entries(post(backend.g, audit).counts).filter(([, n]) => n));
  assert.deepStrictEqual(counts, { MISSING_DOC: 3, OUTDATED: 3, EXTRA_DOC: 1, OK: 246 });
  assert.ok(/7 KAs need attention/.test(overlay), overlay);
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('gm_KAR2_audit')), '', 'audit state cleared');
  assert.strictEqual(backend.sheets.ka_audit.data().length, 1 + 253);
  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('\naudit e2e ok');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
