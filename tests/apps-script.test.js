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
          setFontWeight() {}, setBackgrounds(b) { backgrounds = b; },
          getValue() { return (data[r - 1] || [])[c - 1]; },
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }),
    },
    Utilities: {
      formatDate(d, tz, fmt) {
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
        list(q) {
          const folder = (q.q.match(/'([^']+)' in parents/) || [])[1];
          const items = Object.keys(files).filter(id => files[id].folder === folder).map(id => ({
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
        return { getId: () => id, getName: () => f.title, getDescription: () => f.description || '' };
      },
    },
    SpreadsheetApp: { openById: () => ss },
    DocumentApp: {
      openById(id) {
        const f = files[id];
        if (!f) throw new Error('no doc ' + id);
        return { getHeader: () => (f.headerVersion ? { getText: () => 'Published link: x\nVersion: ' + f.headerVersion + '\n' } : null) };
      },
    },
    MailApp: { sendEmail: (m) => mails.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Logger: { log() {} },
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
    { id: 'ka2', articleNumber: '000002', title: 'Outdated',     urlName: 'Outdated', lastModified: '2026-09-20T10:00:00.000Z' },
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
  assert.strictEqual(byTitle['Missing'], 'En Salesforce sin Doc');
  assert.strictEqual(byTitle['Archived'], 'Archivado por error');
  assert.strictEqual(byTitle['Dup'], 'Docs duplicados');
  assert.strictEqual(byTitle['Outdated'], 'Desactualizado');
  assert.strictEqual(byTitle['Wrong team'], 'OK', '"Sales" is the old name of GTM, so it is not a wrong team');
  assert.strictEqual(byTitle['Slug only'], 'OK', 'matched by URL Name when the Doc has no KA number');
  assert.strictEqual(byTitle['Gone'], 'Doc de más (no está en reportes)');
  assert.strictEqual(byTitle['No meta'], 'Doc sin datos del KA');
  assert.strictEqual(tab[1][0], 'En Salesforce sin Doc', 'most urgent first');
  assert.ok(tab[1][4].endsWith('/lightning/r/Knowledge__kav/ka4/view'));

  assert.strictEqual(sheets.ka_audit_log.data().length, 2);
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'owner@example.com,team@example.com');
  assert.ok(/6 pendientes/.test(mails[0].subject), mails[0].subject);
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
  assert.strictEqual(tab['Same version'][0], 'Desactualizado', 'minor edit published without a new version');
  assert.ok(/misma versión v7, cambio menor/.test(tab['Same version'][8]), tab['Same version'][8]);
  assert.strictEqual(tab['New version'][0], 'Desactualizado');
  assert.ok(/Doc en v6, Salesforce en v8/.test(tab['New version'][8]));
  assert.strictEqual(tab['Minutes'][0], 'OK', '5 minutes is inside the tolerance');
  assert.strictEqual(tab['No header'][0], 'Desactualizado', 'no header version: keep it outdated');
  assert.strictEqual(tab['Same version'][3], "'000201", 'number kept as text');
});

test('audit flags a real wrong team', () => {
  const fx = auditFixture();
  fx.files.d1.title = 'Ok one - internal - Support Ops - EN';
  const { g, sheets } = loadBackend({ files: fx.files, props: { SHARED_SECRET: 's' } });
  post(g, { secret: 's', action: 'audit', reports: fx.reports, published: fx.published, by: 'J' });
  const row = sheets.ka_audit.data().find(x => x[2] === 'Ok one');
  assert.strictEqual(row[0], 'Equipo distinto');
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
if (require.main === module) console.log('\n' + passed + ' passed');
