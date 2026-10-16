// Offline tests for apps-script/Code.gs. Run: node tests/apps-script.test.js
// Loads Code.gs into a sandbox with small fakes of the Google services it
// uses, so the audit logic, secret check and fixes can be checked without
// deploying anything.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function loadBackend(opts) {
  opts = opts || {};
  const sheets = {};
  const mails = [];
  const files = opts.files || {};           // docId -> { title, description, modifiedDate, folder }
  const props = Object.assign({}, opts.props || {});

  function makeSheet(name, id) {
    let data = [];
    let backgrounds = null;
    const sh = {
      name, data: () => data, backgrounds: () => backgrounds,
      clear() { data = []; backgrounds = null; },
      getRange(r, c, nr, nc) {
        return {
          setValues(v) { for (let i = 0; i < v.length; i++) data[r - 1 + i] = v[i].slice(); },
          setValue(v) { (data[r - 1] = data[r - 1] || [])[c - 1] = v; },
          setFontWeight() {}, setBackgrounds(b) { backgrounds = b; },
          getValue() { return (data[r - 1] || [])[c - 1]; },
          getValues() { const out = []; for (let i = 0; i < nr; i++) out.push((data[r - 1 + i] || []).slice(c - 1, c - 1 + nc)); return out; },
        };
      },
      setFrozenRows() {}, autoResizeColumns() {},
      appendRow(row) { data.push(row.slice()); },
      getSheetId() { return id; },
      getLastRow() { return data.length; },
      getDataRange() { return { getValues: () => data.map(r => r.slice()) }; },
    };
    return sh;
  }
  let sheetSeq = 100;
  const ss = {
    getSheetByName(n) { return sheets[n] || null; },
    insertSheet(n) { sheets[n] = makeSheet(n, sheetSeq++); return sheets[n]; },
  };

  const sandbox = {
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; } }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }),
    },
    Utilities: {
      newBlob: (x) => ({ html: x, getDataAsString: () => (typeof x === 'string' ? x : Buffer.from(x).toString('utf8')) }),
      base64DecodeWebSafe: (t) => Buffer.from(String(t).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      formatDate(d, tz, fmt) {
        if (!fmt) return '';
        if (fmt === 'MMM d') return d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
          .reduce((o, x) => (o[x.type] = x.value, o), {});
        const hh = p.hour === '24' ? '00' : p.hour;
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
          .replace('HH', hh).replace('mm', p.minute);
      },
    },
    Drive: {
      Files: {
        insert(meta, blob, o) { const id = 'new' + (Object.keys(files).length + 1); files[id] = { title: meta.title, folder: meta.parents[0].id, html: blob.html, mimeType: meta.mimeType }; return { id }; },
        list(q) {
          const folder = (q.q.match(/'([^']+)' in parents/) || [])[1];
          const title = (q.q.match(/title = '((?:[^'\\]|\\.)*)'/) || [])[1];
          const items = Object.keys(files).filter(id => files[id].folder === folder && (title == null || files[id].title === title.replace(/\\(.)/g, '$1'))).map(id => ({
            id, title: files[id].title, description: files[id].description || '', modifiedDate: files[id].modifiedDate,
          }));
          return { items };
        },
      },
    },
    DriveApp: {
      getFileById(id) {
        const f = files[id];
        if (!f) throw new Error('no file ' + id);
        return { getId: () => id, getName: () => f.title, getDescription: () => f.description || '', setDescription: d => { f.description = d; } };
      },
    },
    SpreadsheetApp: { openById: () => ss },
    DocumentApp: {
      openById(id) {
        const f = files[id];
        if (!f) throw new Error('no doc ' + id);
        return { getBody: () => ({ getText: () => f.text || '' }), getHeader: () => (f.headerVersion ? { getText: () => 'Published link: x\nVersion: ' + f.headerVersion + '\n' } : null) };
      },
    },
    MailApp: { sendEmail: (m) => mails.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Logger: { log() {} },
    CacheService: { getScriptCache: () => { const c = (sandbox.__cache = sandbox.__cache || {}); return { get: k => c[k] || null, put: (k, v) => { c[k] = v; } }; } },
    LockService: { getScriptLock: () => ({ tryLock: () => !opts.locked, releaseLock() {} }) },
    HtmlService: { createHtmlOutput: h => ({ html: h, setTitle() { return this; }, addMetaTag() { return this; } }) },
    UrlFetchApp: { fetch: (url, o) => { const r = (opts.fetch || (() => ({ code: 404, body: '{}' })))(url, o); return { getResponseCode: () => r.code || 200, getContentText: () => typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }; } },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/X/exec' }), getProjectTriggers: () => (sandbox.__trig = sandbox.__trig || []).slice(), deleteTrigger(t) { sandbox.__trig = sandbox.__trig.filter(x => x !== t); }, newTrigger: (h) => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create() {} }) }), onWeekDay: () => ({ atHour: () => ({ create() {} }) }), after: () => ({ create() { (sandbox.__trig = sandbox.__trig || []).push({ getHandlerFunction: () => h }); } }) }) }), WeekDay: {} },
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code, sandbox);
  return { g: sandbox, sheets, mails, props };
}

function post(g, body) {
  return JSON.parse(g.doPost({ postData: { contents: JSON.stringify(body) } }).text);
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

// ─── secret ────────────────────────────────────────────────────────────────

test('refuses every call while SHARED_SECRET is not set', () => {
  const { g } = loadBackend();
  assert.strictEqual(post(g, { secret: 'x', action: 'checkKA' }).code, 'NO_SECRET');
});

test('refuses a wrong secret', () => {
  const { g } = loadBackend({ props: { SHARED_SECRET: 'right' } });
  assert.strictEqual(post(g, { secret: 'wrong', action: 'checkKA' }).code, 'BAD_SECRET');
});

// ─── fixes ─────────────────────────────────────────────────────────────────

test('normalizeTimestamp returns "" when no date is found', () => {
  const { g } = loadBackend();
  assert.strictEqual(g.normalizeTimestamp('Not listed'), '');
  assert.strictEqual(g.normalizeTimestamp('10/1/2026, 2:16 AM by Someone'), '2026-10-01 02:16');
  assert.strictEqual(g.normalizeTimestamp('9/30/2026 10:16 PM'), '2026-09-30 22:16');
});

test('checkKA does not skip when the stored timestamp was never real', () => {
  const files = {
    d1: { folder: '1y-wucQGJ2i0y3VSfr1Hv4v-AK5GcNNQf', title: 'A - internal - GTM - EN',
          description: 'KA_META:000001|https://x/articles/Knowledge/a|not listed\n' },
  };
  const { g } = loadBackend({ files, props: { SHARED_SECRET: 's' } });
  const r = post(g, { secret: 's', action: 'checkKA', kaId: '000001', url: 'https://x/articles/Knowledge/a', lastModified: 'Not listed' });
  assert.strictEqual(r.decision, 'update');
});

test('checkKA still skips when both timestamps are real and equal', () => {
  const files = {
    d1: { folder: '1y-wucQGJ2i0y3VSfr1Hv4v-AK5GcNNQf', title: 'A - internal - GTM - EN',
          description: 'KA_META:000001|https://x/articles/Knowledge/a|2026-10-01 02:16\n' },
  };
  const { g } = loadBackend({ files, props: { SHARED_SECRET: 's' } });
  const r = post(g, { secret: 's', action: 'checkKA', kaId: '000001', url: 'https://x/articles/Knowledge/a', lastModified: '10/1/2026 2:16 AM by X' });
  assert.strictEqual(r.decision, 'skip');
});

test('inferAudience reads only the audience segment', () => {
  const { g } = loadBackend();
  assert.strictEqual(g.inferAudience('Support Ops handoff - internal - GTM - EN'), 'GTM');
  assert.strictEqual(g.inferAudience('Sales tax - internal - Trust & Safety - EN'), 'Trust & Safety');
  assert.strictEqual(g.inferAudience('Old doc - internal - Sales - EN'), 'Sales');
  assert.strictEqual(g.inferAudience('Weird - internal - general - EN'), null);
  assert.strictEqual(g.inferAudience('Legacy Support Ops name'), 'Support Ops');
});

// ─── audit ─────────────────────────────────────────────────────────────────

const PUB = '1y-wucQGJ2i0y3VSfr1Hv4v-AK5GcNNQf';
const ARC = '1j7HzWhwCFGCQyopxzKp7CL7tuyixuguG';
const meta = (num, slug, ts) => 'KA_META:' + num + '|https://thumbtack.lightning.force.com/articles/knowledge/' + slug + '|' + (ts || '') + '\nlog\n';

function auditFixture() {
  const published = [
    { id: 'ka1', articleNumber: '000001', title: 'Ok one',       urlName: 'Ok-One',   lastModified: '2026-09-01T10:00:00.000Z' },
    { id: 'ka2', articleNumber: '000002', title: 'Outdated',     urlName: 'Outdated', lastModified: '2026-09-20T10:00:00.000Z', lastModifiedBy: 'Ana Writer' },
    { id: 'ka3', articleNumber: '000003', title: 'Wrong team',   urlName: 'Wrong',    lastModified: '2026-09-01T10:00:00.000Z' },
    { id: 'ka4', articleNumber: '000004', title: 'Missing',      urlName: 'Missing',  lastModified: '2026-09-01T10:00:00.000Z' },
    { id: 'ka5', articleNumber: '000005', title: 'Archived',     urlName: 'Arch',     lastModified: '2026-09-01T10:00:00.000Z' },
    { id: 'ka6', articleNumber: '000006', title: 'Dup',          urlName: 'Dup',      lastModified: '2026-09-01T10:00:00.000Z' },
    { id: 'ka7', articleNumber: '000007', title: 'Slug only',    urlName: 'Slug-Only', lastModified: '2026-09-01T10:00:00.000Z' },
  ];
  const files = {
    d1: { folder: PUB, title: 'Ok one - internal - GTM - EN',          description: meta('000001', 'Ok-One'),   modifiedDate: '2026-09-10T00:00:00Z' },
    d2: { folder: PUB, title: 'Outdated - internal - Support Ops - EN', description: meta('000002', 'Outdated'), modifiedDate: '2026-09-10T00:00:00Z' },
    d3: { folder: PUB, title: 'Wrong team - internal - Sales - EN',      description: meta('000003', 'Wrong'),    modifiedDate: '2026-09-10T00:00:00Z' },
    d5: { folder: ARC, title: 'Archived - internal - Trust & Safety - EN', description: meta('000005', 'Arch'),  modifiedDate: '2026-09-10T00:00:00Z' },
    d6a: { folder: PUB, title: 'Dup - internal - Support Ops - EN',     description: meta('000006', 'Dup'),      modifiedDate: '2026-09-10T00:00:00Z' },
    d6b: { folder: PUB, title: 'Dup copy - internal - Support Ops - EN', description: meta('', 'Dup'),           modifiedDate: '2026-09-10T00:00:00Z' },
    d7: { folder: PUB, title: 'Slug only - internal - Support Ops - EN', description: meta('', 'Slug-Only'),     modifiedDate: '2026-09-10T00:00:00Z' },
    d8: { folder: PUB, title: 'Gone - internal - GTM - EN',             description: meta('000099', 'Gone'),     modifiedDate: '2026-09-10T00:00:00Z' },
    d9: { folder: PUB, title: 'No meta - internal - GTM - EN',          description: '',                         modifiedDate: '2026-09-10T00:00:00Z' },
  };
  const row = (id, slug, title) => ({ recordId: id, urlName: slug, title });
  const reports = [
    { team: 'GTM', reportId: 'r1', total: 2, rows: [row('ka1', 'Ok-One', 'Ok one'), row('ka3', 'Wrong', 'Wrong team')] },
    { team: 'Support Ops', reportId: 'r2', total: 4, rows: [row('ka2', 'Outdated'), row('ka4', 'Missing'), row('ka6', 'Dup'), row('ka7', 'Slug-Only')] },
    { team: 'Trust & Safety', reportId: 'r3', total: 1, rows: [row('ka5', 'Arch')] },
  ];
  return { published, files, reports };
}

test('audit classifies every case and writes the tab, log and email', () => {
  const fx = auditFixture();
  const { g, sheets, mails } = loadBackend({ files: fx.files, props: { SHARED_SECRET: 's', AUDIT_EMAILS: 'team@example.com' } });
  const r = post(g, { secret: 's', action: 'audit', reports: fx.reports, published: fx.published, by: 'Jorge' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(r.counts).filter(([, n]) => n)),
    { MISSING_DOC: 1, ARCHIVED_BUT_ACTIVE: 1, DUPLICATE_DOCS: 1, OUTDATED: 1, EXTRA_DOC: 1, NO_META: 1, OK: 3 });

  const tab = sheets.ka_audit.data();
  assert.strictEqual(tab.length, 1 + 9);
  const byTitle = Object.fromEntries(tab.slice(1).map(x => [x[2], x[0]]));
  assert.strictEqual(byTitle['Missing'], 'In Salesforce, no Doc');
  assert.strictEqual(byTitle['Archived'], 'Archived by mistake');
  assert.strictEqual(byTitle['Dup'], 'Duplicate Docs');
  assert.strictEqual(byTitle['Outdated'], 'Outdated');
  assert.strictEqual(byTitle['Wrong team'], 'OK', '"Sales" is the old name of GTM, so it is not a wrong team');
  assert.strictEqual(byTitle['Slug only'], 'OK', 'matched by URL Name when the Doc has no KA number');
  assert.strictEqual(byTitle['Gone'], 'Extra Doc (not in any report)');
  assert.strictEqual(byTitle['No meta'], 'Doc missing KA info');
  assert.strictEqual(tab[1][0], 'In Salesforce, no Doc', 'most urgent first');
  assert.ok(tab[1][4].endsWith('/lightning/r/Knowledge__kav/ka4/view'));

  assert.strictEqual(sheets.ka_audit_log.data().length, 2);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'owner@example.com,team@example.com');
  assert.ok(/6 to do/.test(mails[0].subject), mails[0].subject);
  // who last edited it in Salesforce: column in the tab + grouped in the email
  const hdr = tab[0], out = tab.find(x => x[2] === 'Outdated');
  assert.strictEqual(out[hdr.indexOf('modified by')], 'Ana Writer');
  assert.ok(/Not synced yet, by who last edited it[\s\S]*<b>Ana Writer<\/b> \(1\)[\s\S]*Outdated/.test(mails[0].htmlBody), mails[0].htmlBody);
  assert.ok(/last edited by Ana Writer/.test(mails[0].htmlBody));
});

test('KA titles come back to plain text', () => {
  const { g } = loadBackend();
  assert.strictEqual(g._plainTitle('Thumbtack&#39;s Quality Commitment (Pro)'), "Thumbtack's Quality Commitment (Pro)");
  assert.strictEqual(g._plainTitle('Leads &amp; quotes &quot;new&quot;'), 'Leads & quotes "new"');
});

test('URL Names that differ only in case are different KAs', () => {
  const published = [
    { id: 'kaA', articleNumber: '000101', title: 'Background checks (incidents)', urlName: 'Background-checks', lastModified: '2026-09-01T10:00:00.000Z' },
    { id: 'kaB', articleNumber: '000102', title: 'Background Checks (Pro)', urlName: 'Background-Checks', lastModified: '2026-09-01T10:00:00.000Z' },
  ];
  const files = {
    dA: { folder: PUB, title: 'Background checks (incidents) - internal - Trust & Safety - EN', description: meta('000101', 'Background-checks'), modifiedDate: '2026-09-10T00:00:00Z' },
    dB: { folder: PUB, title: 'Background Checks (Pro) - internal - Support Ops - EN', description: meta('', 'Background-Checks'), modifiedDate: '2026-09-10T00:00:00Z' },
  };
  const reports = [
    { team: 'GTM', rows: [{ recordId: 'kaX', urlName: 'x' }] },
    { team: 'Support Ops', rows: [{ recordId: 'kaB', urlName: 'Background-Checks' }] },
    { team: 'Trust & Safety', rows: [{ recordId: 'kaA', urlName: 'Background-checks' }] },
  ];
  const { g, sheets } = loadBackend({ files, props: { SHARED_SECRET: 's' } });
  const r = post(g, { secret: 's', action: 'audit', reports, published, by: 'J' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.counts.DUPLICATE_DOCS, 0);
  const tab = Object.fromEntries(sheets.ka_audit.data().slice(1).map(x => [x[2], x[0]]));
  assert.strictEqual(tab['Background checks (incidents)'], 'OK');
  assert.strictEqual(tab['Background Checks (Pro)'], 'OK');
});

test('outdated: edited after the last sync is outdated even with the same version (minor edit); 10-minute tolerance', () => {
  const published = [
    { id: 'kaS', articleNumber: '000201', title: 'Same version', urlName: 'Same', version: 7, lastModified: '2026-09-20T10:00:00.000Z' },
    { id: 'kaN', articleNumber: '000202', title: 'New version',  urlName: 'New',  version: 8, lastModified: '2026-09-20T10:00:00.000Z' },
    { id: 'kaM', articleNumber: '000203', title: 'Minutes',      urlName: 'Min',  version: 3, lastModified: '2026-09-10T00:05:00.000Z' },
    { id: 'kaH', articleNumber: '000204', title: 'No header',    urlName: 'NoH',  version: 3, lastModified: '2026-09-20T10:00:00.000Z' },
  ];
  const files = {
    dS: { folder: PUB, title: 'Same version - internal - GTM - EN', description: meta('000201', 'Same'), modifiedDate: '2026-09-10T00:00:00Z', headerVersion: '7' },
    dN: { folder: PUB, title: 'New version - internal - GTM - EN',  description: meta('000202', 'New'),  modifiedDate: '2026-09-10T00:00:00Z', headerVersion: '6' },
    dM: { folder: PUB, title: 'Minutes - internal - GTM - EN',      description: meta('000203', 'Min'),  modifiedDate: '2026-09-10T00:00:00Z', headerVersion: '2' },
    dH: { folder: PUB, title: 'No header - internal - GTM - EN',    description: meta('000204', 'NoH'),  modifiedDate: '2026-09-10T00:00:00Z' },
  };
  const reports = [
    { team: 'GTM', rows: ['kaS', 'kaN', 'kaM', 'kaH'].map(id => ({ recordId: id })) },
    { team: 'Support Ops', rows: [{ recordId: 'kaX' }] },
    { team: 'Trust & Safety', rows: [{ recordId: 'kaY' }] },
  ];
  const { g, sheets } = loadBackend({ files, props: { SHARED_SECRET: 's' } });
  const r = post(g, { secret: 's', action: 'audit', reports, published, by: 'J' });
  assert.ok(r.ok, JSON.stringify(r));
  const tab = Object.fromEntries(sheets.ka_audit.data().slice(1).map(x => [x[2], x]));
  assert.strictEqual(tab['Same version'][0], 'Outdated', 'minor edit published without a new version');
  assert.ok(/same version v7, minor edit/.test(tab['Same version'][9]), tab['Same version'][9]);
  assert.strictEqual(tab['New version'][0], 'Outdated');
  assert.ok(/Doc is v6, Salesforce is v8/.test(tab['New version'][9]));
  assert.strictEqual(tab['Minutes'][0], 'OK', '5 minutes is inside the tolerance');
  assert.strictEqual(tab['No header'][0], 'Outdated', 'no header version: keep it outdated');
  assert.strictEqual(tab['Same version'][3], "'000201", 'number kept as text');
});

test('audit flags a real wrong team', () => {
  const fx = auditFixture();
  fx.files.d1.title = 'Ok one - internal - Support Ops - EN';
  const { g, sheets } = loadBackend({ files: fx.files, props: { SHARED_SECRET: 's' } });
  post(g, { secret: 's', action: 'audit', reports: fx.reports, published: fx.published, by: 'J' });
  const row = sheets.ka_audit.data().find(x => x[2] === 'Ok one');
  assert.strictEqual(row[0], 'Different team');
});

test('audit refuses an incomplete report', () => {
  const fx = auditFixture();
  fx.reports[1].total = 171;
  const { g, sheets } = loadBackend({ files: fx.files, props: { SHARED_SECRET: 's' } });
  const r = post(g, { secret: 's', action: 'audit', reports: fx.reports, published: fx.published });
  assert.strictEqual(r.ok, false);
  assert.ok(/incomplete/.test(r.error), r.error);
  assert.ok(!sheets.ka_audit, 'nothing written');
});

test('audit refuses when a team report is missing', () => {
  const fx = auditFixture();
  const { g } = loadBackend({ files: fx.files, props: { SHARED_SECRET: 's' } });
  const r = post(g, { secret: 's', action: 'audit', reports: fx.reports.slice(0, 2), published: fx.published });
  assert.strictEqual(r.ok, false);
  assert.ok(/Missing report: Trust & Safety/.test(r.error), r.error);
});

test('audit refuses a report that came back short (many extra Docs in one team)', () => {
  const fx = auditFixture();
  // 12 T&S Docs whose KAs are "in no report": what a half-read T&S report looks like.
  for (let i = 0; i < 12; i++) {
    fx.files['ts' + i] = { folder: PUB, title: 'TS ' + i + ' - internal - Trust & Safety - EN', description: meta('00090' + i, 'TS-' + i), modifiedDate: '2026-09-10T00:00:00Z' };
  }
  const { g, sheets, mails } = loadBackend({ files: fx.files, props: { SHARED_SECRET: 's' } });
  const r = post(g, { secret: 's', action: 'audit', reports: fx.reports, published: fx.published, by: 'J' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'INCOMPLETE_REPORT');
  assert.ok(/12 Trust & Safety Docs are missing from the Trust & Safety report/.test(r.error), r.error);
  assert.ok(!sheets.ka_audit && !sheets.ka_audit_log, 'nothing written');
  assert.strictEqual(mails.length, 0, 'no email');
});

test('auditDocs lists the published KA Docs per team (read-only)', () => {
  const fx = auditFixture();
  const { g, sheets } = loadBackend({ files: fx.files, props: { SHARED_SECRET: 's' } });
  const r = post(g, { secret: 's', action: 'auditDocs' });
  assert.ok(r.ok, JSON.stringify(r));
  const by = {}; r.docs.forEach(d => { (by[d.team] = by[d.team] || []).push(d.slug); });
  assert.deepStrictEqual(by['GTM'].sort(), ['', 'Gone', 'Ok-One', 'Wrong'].sort());   // 'Sales' Doc counts as GTM
  assert.ok(!by['Trust & Safety'], 'archived Docs are not listed');
  assert.ok(!sheets.ka_audit, 'nothing written');
});

module.exports = { loadBackend, post };

// ─── weekly report ──────────────────────────────────────────────────────────

test('weekly report: updates (new version / minor edit), new and archived KAs, and who did each', () => {
  const DAY = 86400000, now = Date.now(), iso = t => new Date(t).toISOString();
  const files = {
    dNew: { folder: PUB, title: 'Brand new - internal - GTM - EN', description: meta('000301', 'Brand-new'), modifiedDate: iso(now - 1 * DAY) },
    dVer: { folder: PUB, title: 'Big change - internal - Support Ops - EN', description: meta('000302', 'Big'), modifiedDate: iso(now - 10 * DAY) },
  };
  const pub = (over) => Object.assign({ lastModifiedBy: 'Ana Writer', createdBy: 'Ana Writer' }, over);
  let published = [
    pub({ id: 'k1', articleNumber: '000301', title: 'Brand new', version: 1, firstPublished: iso(now - 2 * DAY), lastPublished: iso(now - 2 * DAY), lastModified: iso(now - 2 * DAY), createdBy: 'Nichole Jensen', lastModifiedBy: 'Nichole Jensen' }),
    pub({ id: 'k2', articleNumber: '000302', title: 'Big change', version: 5, firstPublished: iso(now - 300 * DAY), lastPublished: iso(now - 1 * DAY), lastModified: iso(now - 1 * DAY) }),
    pub({ id: 'k3', articleNumber: '000303', title: 'Thumbtack&#39;s small fix', version: 3, firstPublished: iso(now - 300 * DAY), lastPublished: iso(now - 30 * DAY), lastModified: iso(now - 1 * DAY) }),
    pub({ id: 'k4', articleNumber: '000304', title: 'Quiet', version: 2, firstPublished: iso(now - 300 * DAY), lastPublished: iso(now - 40 * DAY), lastModified: iso(now - 40 * DAY) }),
  ];
  const archived = [
    { id: 'a1', articleNumber: '000390', title: 'Old program', version: 4, archived: iso(now - 3 * DAY), archivedBy: 'Sam Editor' },
    { id: 'a2', articleNumber: '000302', title: 'Big change', version: 4, archived: iso(now - 1 * DAY), archivedBy: 'Ana Writer' },   // old version of a live KA
    { id: 'a3', articleNumber: '000391', title: 'Long gone', version: 2, archived: iso(now - 90 * DAY), archivedBy: 'Sam Editor' },
  ];
  const { g, sheets, mails } = loadBackend({ files, props: { SHARED_SECRET: 's' } });

  // 1. first run: read from Salesforce dates
  let r = post(g, { secret: 's', action: 'weekly', published, archived, by: 'Jorge' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.firstRun, true);
  assert.deepStrictEqual(r.counts, { NEW_VERSION: 1, MINOR_EDIT: 1, NEW: 1, ARCHIVED: 1 });
  let tab = sheets.ka_weekly.data(), h = tab[0];
  const row = t => tab.find(x => x[h.indexOf('title')] === t);
  assert.ok(h.indexOf('Doc synced') === -1, 'no Drive sync info');
  assert.strictEqual(row('Brand new')[h.indexOf('change')], 'New KA');
  assert.strictEqual(row('Brand new')[h.indexOf('by')], 'Nichole Jensen');
  assert.strictEqual(row('Big change')[h.indexOf('change')], 'New version');
  assert.strictEqual(row("Thumbtack's small fix")[h.indexOf('change')], 'Minor edit');
  assert.strictEqual(row('Old program')[h.indexOf('change')], 'Archived');
  assert.strictEqual(row('Old program')[h.indexOf('by')], 'Sam Editor');
  assert.ok(!row('Quiet') && !row('Long gone'), 'nothing from outside the week');
  assert.strictEqual(tab.filter(x => x[h.indexOf('title')] === 'Big change').length, 1, 'the archived old version of a live KA is not "archived"');
  const m = mails[0];
  assert.ok(/^Weekly KA report .* — 2 updates \(1 new version, 1 minor\), 1 new, 1 archived$/.test(m.subject), m.subject);
  assert.ok(/<b>2 KAs<\/b> updated in Salesforce: <b>1<\/b> with a new version, <b>1<\/b> minor edit \(no new version\)/.test(m.htmlBody));
  assert.ok(/v4 → v5/.test(m.htmlBody) && /still v3/.test(m.htmlBody));
  assert.ok(!/synced/i.test(m.htmlBody), 'no sync info in the email');
  assert.ok(/<b>Sam Editor<\/b><\/td><td[^>]*>0<\/td><td[^>]*>0<\/td><td[^>]*>0<\/td><td[^>]*>1<\/td>/.test(m.htmlBody), 'per-person table counts the archive');

  // 2. a re-run the same day keeps the same week: same answer
  r = post(g, { secret: 's', action: 'weekly', published, archived, by: 'Jorge' });
  assert.deepStrictEqual(r.counts, { NEW_VERSION: 1, MINOR_EDIT: 1, NEW: 1, ARCHIVED: 1 });

  // 3. next week: compared with the versions saved last week; no archived list -> gone from Published = archived
  const snap = sheets.ka_weekly_snapshot.data();
  snap.slice(1).forEach(x => { if (x[0] === 'cur') x[3] = iso(now - 7 * DAY); else x[3] = iso(now - 14 * DAY); });
  published = [
    pub({ id: 'k1', articleNumber: '000301', title: 'Brand new', version: 1, firstPublished: iso(now - 9 * DAY), lastPublished: iso(now - 9 * DAY), lastModified: iso(now - 9 * DAY) }),
    pub({ id: 'k2b', articleNumber: '000302', title: 'Big change', version: 6, firstPublished: iso(now - 300 * DAY), lastPublished: iso(now - 2 * DAY), lastModified: iso(now - 2 * DAY), lastModifiedBy: 'Sam Editor' }),
    pub({ id: 'k3', articleNumber: '000303', title: 'Small fix', version: 3, firstPublished: iso(now - 300 * DAY), lastPublished: iso(now - 2 * DAY), lastModified: iso(now - 2 * DAY) }),
    pub({ id: 'k5', articleNumber: '000305', title: 'No first-published date', version: 1, lastModified: iso(now - 1 * DAY), createdBy: 'Lee Writer' }),
  ];
  r = post(g, { secret: 's', action: 'weekly', published, archived: null, by: 'Jorge' });
  assert.strictEqual(r.firstRun, false);
  assert.deepStrictEqual(r.counts, { NEW_VERSION: 1, MINOR_EDIT: 1, NEW: 1, ARCHIVED: 1 });
  tab = sheets.ka_weekly.data(); h = tab[0];
  assert.strictEqual(row('Big change')[h.indexOf('previous version')], '5');
  assert.strictEqual(row('Big change')[h.indexOf('by')], 'Sam Editor');
  assert.strictEqual(row('Small fix')[h.indexOf('change')], 'Minor edit', 'republished with the same number = minor edit');
  assert.strictEqual(row('No first-published date')[h.indexOf('change')], 'New KA');
  assert.strictEqual(row('Quiet')[h.indexOf('change')], 'Archived', 'published last week, gone now');
  assert.ok(!row('Brand new'), 'last week\'s new KA is not new again');
});

test('every answer says which Code.gs is running; ?version=1 shows it in the browser', () => {
  const { g } = loadBackend({ props: { SHARED_SECRET: 's' } });
  const v = post(g, { secret: 's', action: 'version' });
  assert.strictEqual(v.server, '2.8.0');
  assert.ok(v.actions.includes('weekly'));
  const bad = post(g, { secret: 's', action: 'nope' });
  assert.strictEqual(bad.code, 'BAD_ACTION');
  assert.strictEqual(bad.server, '2.8.0');
  const get = JSON.parse(g.doGet({ parameter: { version: '1' } }).text);
  assert.strictEqual(get.server, '2.8.0');
});

test('Contentful: last change of each article counts its segments, who did it, shared segments', () => {
  const L = id => ({ sys: { type: 'Link', linkType: 'Entry', id } });
  const U = id => ({ sys: { type: 'Link', linkType: 'User', id } });
  const ct = id => ({ sys: { type: 'Link', linkType: 'ContentType', id } });
  const E = (id, type, fields, sys) => ({ sys: Object.assign({ id, contentType: ct(type), version: 5, publishedVersion: 4 }, sys), fields });
  const entries = [
    E('a1', 'helpCenterArticle', { title: { 'en-US': 'Leads and opportunities', 'es-US': 'Prospectos y oportunidades' }, slug: { 'en-US': 'leads' },
      sections: { 'en-US': [L('s1'), L('s2')] }, related: { 'en-US': [L('a2')] } },
      { updatedAt: '2026-09-01T10:00:00Z', updatedBy: U('u1'), publishedAt: '2026-09-01T10:00:00Z', publishedBy: U('u1') }),
    E('s1', 'section', { title: { 'en-US': 'How leads work' }, items: { 'en-US': [L('i1')] } }, { updatedAt: '2026-08-01T10:00:00Z', updatedBy: U('u1'), publishedAt: '2026-08-01T10:00:00Z', publishedBy: U('u1') }),
    // accordion item shared by both articles, changed last, saved but not published
    E('i1', 'accordionItem', { question: { 'en-US': 'Why was I charged?' } }, { updatedAt: '2026-10-10T10:00:00Z', updatedBy: U('u2'), publishedAt: '2026-10-01T10:00:00Z', publishedBy: U('u2'), version: 9, publishedVersion: 7 }),
    E('s2', 'section', { body: { 'en-US': { nodeType: 'document', content: [{ nodeType: 'embedded-entry-block', data: { target: L('i2') } }] } } }, { updatedAt: '2026-07-01T10:00:00Z', updatedBy: U('u1') }),
    E('i2', 'accordionItem', { question: { 'en-US': 'In rich text' } }, { updatedAt: '2026-07-02T10:00:00Z', updatedBy: U('u1') }),
    E('a2', 'helpCenterArticle', { title: { 'en-US': 'Refunds' }, sections: { 'en-US': [L('i1')] } }, { updatedAt: '2025-01-01T10:00:00Z', updatedBy: U('u1'), publishedAt: '2025-01-01T10:00:00Z', publishedBy: U('u1') }),
    E('a3', 'helpCenterArticle', { title: { 'en-US': 'Old one' } }, { updatedAt: '2024-01-01T10:00:00Z', updatedBy: U('u3'), publishedAt: '2024-01-01T10:00:00Z', publishedBy: U('u3') }),
  ];
  const pages = {
    // like the real space: the pieces are named "Article > ..."
    '/content_types': [{ sys: { id: 'helpCenterArticle' }, name: 'Article' }, { sys: { id: 'section' }, name: 'Article > Segment' }, { sys: { id: 'accordionItem' }, name: 'Article > Toggle' }],
    '/locales': [{ code: 'en-US' }, { code: 'es-US' }, { code: 'pt-BR' }],
    '/entries': entries,
    '/users': [{ sys: { id: 'u1' }, firstName: 'Ana', lastName: 'Writer' }, { sys: { id: 'u2' }, firstName: 'Nichole', lastName: 'Jensen' }],
  };
  const urls = [];
  const fetch = (url, o) => {
    urls.push([url, o.method, o.headers.Authorization]);
    const path = url.replace('https://api.contentful.com', '').split('?')[0];
    const key = Object.keys(pages).find(k => path.endsWith(k));
    const items = key ? pages[key] : [];
    return { body: { items, total: items.length } };
  };
  const { g, sheets } = loadBackend({ fetch, props: { CONTENTFUL_TOKEN: 'tok' } });
  const msg = g.syncContentful();
  assert.ok(/3 articles \(helpCenterArticle\)/.test(msg), msg);
  assert.ok(urls.every(u => u[1] === 'get' && u[2] === 'Bearer tok'), 'read only, with the token');
  assert.ok(urls.some(u => /\/spaces\/zkjkphkd3oqx\/environments\/master\/entries\?limit=1000&skip=0/.test(u[0])));
  const tab = sheets.hc_contentful.data(), h = tab[0];
  const row = t => tab.find(x => x[h.indexOf('titleEN')] === t);
  const col = (r, c) => r[h.indexOf(c)];
  const a1 = row('Leads and opportunities');
  assert.strictEqual(col(a1, 'titleES'), 'Prospectos y oportunidades');
  assert.strictEqual(col(a1, 'lastUpdated'), '2026-10-10T10:00:00Z', 'the newest change is in a segment');
  assert.strictEqual(col(a1, 'lastUpdatedBy'), 'Nichole Jensen');
  assert.strictEqual(col(a1, 'changedIn'), 'Article > Toggle: Why was I charged?');
  assert.strictEqual(col(a1, 'sharedWith'), 1, 'that item is also in Refunds');
  assert.strictEqual(col(a1, 'unpublishedChanges'), 'yes');
  assert.strictEqual(col(a1, 'segments'), 4, 'sections, items and rich-text embeds, not the related article');
  assert.strictEqual(col(a1, 'lastPublished'), '2026-10-01T10:00:00Z');
  const a2 = row('Refunds');
  assert.strictEqual(col(a2, 'lastUpdated'), '2026-10-10T10:00:00Z', 'a shared segment counts for every article that has it');
  assert.strictEqual(col(row('Old one'), 'lastUpdatedBy'), 'Unknown user (u3)');
  assert.strictEqual(tab[1][h.indexOf('titleEN')], 'Leads and opportunities', 'newest first');
  assert.ok(/app\.contentful\.com\/spaces\/zkjkphkd3oqx\/environments\/master\/entries\/a1/.test(col(a1, 'contentfulUrl')));
  assert.deepStrictEqual(g._cfArticleTypes([{ sys:{id:'x'}, name:'Article > Tip' }, { sys:{id:'y'}, name:'FAQ article' }]), ['y'], 'without an exact "Article", sub-types are still left out');
  // no token: clear message
  const nt = loadBackend({ fetch, props: {} });
  assert.throws(() => nt.g.syncContentful(), /CONTENTFUL_TOKEN/);
});

test('dashboard button: ?refresh=contentful reads Contentful now, once a minute, one at a time', () => {
  const fetch = (url) => {
    const path = url.replace('https://api.contentful.com', '').split('?')[0];
    const items = path.endsWith('/content_types') ? [{ sys: { id: 'article' }, name: 'Article' }] : path.endsWith('/locales') ? [{ code: 'en-US' }]
      : path.endsWith('/entries') ? [{ sys: { id: 'a1', contentType: { sys: { id: 'article' } }, updatedAt: '2026-10-01T00:00:00Z', version: 2, publishedVersion: 1 }, fields: { title: { 'en-US': 'One' } } }] : [];
    return { body: { items, total: items.length } };
  };
  const { g, sheets } = loadBackend({ fetch, props: { CONTENTFUL_TOKEN: 't' } });
  const page = g.doGet({ parameter: { refresh: 'contentful' } });
  assert.ok(/Updated from Contentful/.test(page.html) && /1 articles/.test(page.html), page.html);
  assert.strictEqual(sheets.hc_contentful.data().length, 2);
  const again = g.doGet({ parameter: { refresh: 'contentful' } });
  assert.ok(/less than a minute ago/.test(again.html), 'second click within a minute does not run it again');
  const busy = loadBackend({ fetch, props: { CONTENTFUL_TOKEN: 't' }, locked: true });
  assert.ok(/Someone else is updating/.test(busy.g.doGet({ parameter: { refresh: 'contentful' } }).html));
  const noTok = loadBackend({ fetch, props: {} });
  assert.ok(/Could not update/.test(noTok.g.doGet({ parameter: { refresh: 'contentful' } }).html) && /CONTENTFUL_TOKEN/.test(noTok.g.doGet({ parameter: { refresh: 'contentful' } }).html));
});

test('Create Doc from Contentful: adds the article to the Auto Sync list (once); Auto Sync makes the Doc', () => {
  const art = (id, f, extra) => ({ sys: Object.assign({ id, contentType: { sys: { id: 'helpCenterArticle' } }, publishedVersion: 5 }, extra || {}),
    fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { 'en-US': v }])) });
  const all = {
    pol: art('pol', { name: 'Preset Jobs policy [Spanish]', title: 'Política de trabajos preestablecidos', slug: 'politica-de-trabajos-preestablecidos' }),
    draft: art('draft', { title: 'Draft one', slug: 'draft-one' }, { publishedVersion: undefined }),
    have: art('have', { title: 'Quote templates', slug: 'quote-templates' }),
    seg: { sys: { id: 'seg', contentType: { sys: { id: 'segment' } } }, fields: {} },
  };
  const posts = [];
  const fetch = (url, o) => {
    if (url === 'https://script.google.com/macros/s/AUTO/exec') { const b = JSON.parse(o.payload); posts.push(b);
      if (b.action === 'run_manual') return { body: posts.filter(x => x.action === 'run_manual').length > 1 ? { ok: false, error: 'A sync is already running. Wait for it to finish.' } : { ok: true, message: 'Manual sync started.' } };
      return { body: b.url.endsWith('quote-templates') ? { ok: false, code: 'ALREADY_EXISTS', existingDocUrl: 'https://docs.google.com/document/d/old/edit' } : { ok: true, mode: 'create', docUrl: 'https://docs.google.com/document/d/new1/edit' } }; }
    const p = url.replace('https://api.contentful.com', '').split('?')[0];
    if (p.endsWith('/content_types')) return { body: { items: [{ sys: { id: 'helpCenterArticle' }, name: 'Article' }, { sys: { id: 'segment' }, name: 'Article > Segment' }], total: 2 } };
    const m = p.match(/\/entries\/(\w+)$/); if (m && all[m[1]]) return { body: all[m[1]] };
    return { code: 404, body: {} };
  };
  const seed = (sheets) => { const sh = sheets.Articles; sh.appendRow(['URL', 'Last updatedAt', '', '', '']);
    sh.appendRow(['https://help.thumbtack.com/article/Quote-Templates/', '2026-06-08', 'no change', 'docQT', 'h']); };
  // 1) not set up for "right away": only adds to the list
  let B = loadBackend({ fetch, props: { CONTENTFUL_TOKEN: 't' } });
  B.g.SpreadsheetApp.openById('x').insertSheet('Articles'); seed(B.sheets);
  const prev = B.g.doGet({ parameter: { create: 'contentful', id: 'pol' } }).html;
  assert.ok(/Add this article to the Content Index\?/.test(prev) && /help\.thumbtack\.com\/article\/politica-de-trabajos-preestablecidos/.test(prev), prev);
  assert.ok(/next run \(weeknights, 2am UTC\)/.test(prev) && /create=contentful&amp;id=pol&amp;go=1/.test(prev));
  assert.strictEqual(B.sheets.Articles.data().length, 2, 'the preview adds nothing');
  const done = B.g.doGet({ parameter: { create: 'contentful', id: 'pol', go: '1' } }).html;
  assert.ok(/On the Auto Sync list/.test(done) && /Added to the Auto Sync list/.test(done), done);
  const rows = B.sheets.Articles.data();
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[2][0], 'https://help.thumbtack.com/article/politica-de-trabajos-preestablecidos');
  assert.ok(rows[2][1] === '' && rows[2][3] === '' && rows[2][4] === '', 'empty updatedAt, fileId and hash: Auto Sync creates the Doc');
  assert.ok(/Added by Content Index Dashboard/.test(rows[2][2]));
  const again = B.g.doGet({ parameter: { create: 'contentful', id: 'pol', go: '1' } }).html;
  assert.ok(/already on the Auto Sync list/.test(again) && B.sheets.Articles.data().length === 3, 'never added twice');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(B.sheets.hc_added.data()[0])), ['entryId', 'url', 'status', 'docUrl', 'at', 'by']);
  assert.strictEqual(B.sheets.hc_added.data()[1][2], 'on the Auto Sync list');
  // already listed with a Doc (URL written differently): links to it, adds nothing
  const have = B.g.doGet({ parameter: { create: 'contentful', id: 'have', go: '1' } }).html;
  assert.ok(/Already in the Content Index/.test(have) && /document\/d\/docQT\/edit/.test(have), have);
  assert.strictEqual(B.sheets.Articles.data().length, 3);
  // not published, not an article, bad id
  assert.ok(/not published in Contentful/.test(B.g.doGet({ parameter: { create: 'contentful', id: 'draft', go: '1' } }).html));
  assert.ok(/not a Help Center article/.test(B.g.doGet({ parameter: { create: 'contentful', id: 'seg', go: '1' } }).html));
  assert.ok(/not a Contentful entry id/.test(B.g.doGet({ parameter: { create: 'contentful', id: "x' or 1" } }).html));
  assert.strictEqual(posts.length, 0, 'never calls Auto Sync when it is not set up');
  // 2) with AUTO_SYNC_URL + AUTO_SYNC_SECRET: also asks Auto Sync to create it now
  B = loadBackend({ fetch, props: { CONTENTFUL_TOKEN: 't', AUTO_SYNC_URL: 'https://script.google.com/macros/s/AUTO/exec', AUTO_SYNC_SECRET: 's3' } });
  B.g.SpreadsheetApp.openById('x').insertSheet('Articles'); seed(B.sheets);
  assert.ok(/Auto Sync creates the Doc right away/.test(B.g.doGet({ parameter: { create: 'contentful', id: 'pol' } }).html));
  const now = B.g.doGet({ parameter: { create: 'contentful', id: 'pol', go: '1' } }).html;
  assert.ok(/On the Auto Sync list/.test(now) && /creating the Doc now, in the background/.test(now), now);
  assert.strictEqual(posts.length, 0, 'answers right away: Auto Sync is called from a trigger');
  assert.deepStrictEqual(B.g.__trig.map(t => t.getHandlerFunction()), ['autoSyncPending']);
  assert.strictEqual(B.sheets.Articles.data().length, 3, 'on the list, so Auto Sync keeps it updated');
  // the trigger fires: create, then one full sync
  const out = B.g.autoSyncPending();
  assert.ok(/1 done/.test(out) && /started a full sync of all articles/.test(out), out);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(posts[0])), { mode: 'create', url: 'https://help.thumbtack.com/article/politica-de-trabajos-preestablecidos', reviewer: 'Content Index Dashboard', secret: 's3' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(posts[1])), { action: 'run_manual', secret: 's3' });
  const log = B.sheets.hc_added.data();
  assert.strictEqual(log[1][2], 'Auto Sync is creating the Doc');
  assert.deepStrictEqual([log[2][2], log[2][3]], ['Doc created', 'https://docs.google.com/document/d/new1/edit']);
  assert.strictEqual(B.g.__trig.length, 0, 'its trigger is gone');
  assert.strictEqual(B.g.autoSyncPending(), 'nothing to do');
  const have2 = B.g.doGet({ parameter: { create: 'contentful', id: 'have', go: '1' } }).html;
  assert.ok(/Already in the Content Index/.test(have2) && !/full sync/.test(have2), 'nothing to do: no full sync');
  // an old Auto Sync without "run_manual" says so instead of failing
  const old = loadBackend({ props: { CONTENTFUL_TOKEN: 't', AUTO_SYNC_URL: 'u', AUTO_SYNC_SECRET: 's' }, fetch: () => ({ body: { ok: false, code: 'BAD_REQUEST', error: 'Missing url' } }) });
  assert.ok(/does not have the "run_manual" addition yet/.test(old.g._autoSyncRunAll()));
});

test('setupSearchNames creates the search_names tab once', () => {
  const { g, sheets } = loadBackend({});
  assert.ok(/created/.test(g.setupSearchNames()));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sheets.search_names.data()[0])), ['names', 'notes']);
  assert.ok(/claimable jobs/.test(sheets.search_names.data()[1][0]));
  sheets.search_names.appendRow(['x, y', '']);
  assert.ok(/already exists/.test(g.setupSearchNames()));
  assert.strictEqual(sheets.search_names.data().length, 4, 'never touched again');
});

test('re-audit: buildAuditQueue copies the EN/ES Doc text (and the old scores once); ?save=audit writes the new scores after a confirm', () => {
  const files = { en1: { text: 'Preset jobs. Cancel a job. Tip: fees.' }, es1: { text: 'Trabajos preestablecidos.' }, en2: { text: 'x' } };
  const { g, sheets } = loadBackend({ files });
  const ss = g.SpreadsheetApp.openById('x'), tr = ss.insertSheet('localization_tracker');
  tr.appendRow(['translationKey', 'titleEN', 'docIdEN', 'docIdES', 'audience', 'status', 'auditedDate', 'accuracy', 'notes', 'startedDate', 'esLastUpdated', 'aiScore']);
  tr.appendRow(['what are preset jobs', 'What are preset jobs', 'en1', 'es1', 'pro', 'translated', '', 0.9, 'old note', '', '', 87]);
  tr.appendRow(['no spanish', 'No Spanish', 'en2', '', 'pro', 'not_translated', '', '', '', '', '', '']);
  tr.appendRow(['broken', 'Broken', 'en1', 'missing', 'pro', 'translated', '', '', '', '', '', 50]);
  const msg = g.buildAuditQueue();
  assert.ok(/^1 translations ready/.test(msg) && /could not read 1: broken/.test(msg), msg);
  const q = sheets.translation_audit_queue.data();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(q[0])), ['translationKey', 'titleEN', 'docIdEN', 'docIdES', 'enText', 'esText', 'enWords', 'esWords', 'preparedAt']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(q[1].slice(0, 8))), ['what are preset jobs', 'What are preset jobs', 'en1', 'es1', 'Preset jobs. Cancel a job. Tip: fees.', 'Trabajos preestablecidos.', 7, 2]);
  assert.strictEqual(sheets.translation_scores_before_reaudit.data()[1][11], 87, 'the old scores are kept');
  // save: preview first, nothing written
  const enc = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const d = enc([{ k: 'what are preset jobs', s: 61, n: '{"aiScore":61,"notes":"Cancelación falta"}' }, { k: 'nope', s: 80, n: '' }]);
  const prev = g.doGet({ parameter: { save: 'audit', d } }).html;
  assert.ok(/Save 1 new scores/.test(prev) && /87 → <b>61<\/b>/.test(prev) && /not in localization_tracker: skipped/.test(prev), prev);
  assert.strictEqual(tr.data()[1][11], 87, 'preview writes nothing');
  const done = g.doGet({ parameter: { save: 'audit', d, go: '1' } }).html;
  assert.ok(/Saved 1/.test(done), done);
  const row = tr.data()[1];
  assert.strictEqual(row[11], 61); assert.ok(/^\d{4}-\d\d-\d\d$/.test(row[6])); assert.ok(/Cancelación falta/.test(row[8]));
  assert.strictEqual(row[7], 0.9, 'accuracy untouched'); assert.strictEqual(row[5], 'translated', 'status untouched');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sheets.translation_audit_log.data()[1].slice(0, 4))), ['what are preset jobs', 'What are preset jobs', 87, 61]);
  // a second build keeps the first copy of the old scores
  g.buildAuditQueue();
  assert.strictEqual(sheets.translation_scores_before_reaudit.data()[1][11], 87);
  // bad input
  assert.ok(/Could not save/.test(g.doGet({ parameter: { save: 'audit', d: enc([{ k: 'x', s: 300 }]) } }).html));
  assert.ok(/Could not save/.test(g.doGet({ parameter: { save: 'audit', d: 'garbage' } }).html));
});

if (require.main === module) console.log('\n' + passed + ' passed');
