// ==UserScript==
// @name         KA JSON Probe (test only)
// @namespace    ka-json-probe
// @version      0.5.0
// @description  TEST ONLY. Checks whether the current KA can be read as the original Salesforce record (JSON) instead of from the page HTML. Read-only: never writes to Salesforce or Drive.
// @author       jcardona@thumbtack.com
// @match        https://thumbtack.lightning.force.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @connect      thumbtack.my.salesforce.com
// @run-at       document-idle
// ==/UserScript==

/*
 * On a KA page it tries 3 read-only ways to get the KA record as JSON, and on
 * a KA or Report page it tries read-only ways to get the full list of
 * published KAs (GraphQL, list view, report export). Record tests:
 *   A. Lightning's own internal channel (Aura "getRecordWithLayouts") - the
 *      same call the page makes to draw the record.
 *   B. UI API on the Lightning domain (/services/data/.../ui-api/records).
 *   C. REST API on the my.salesforce.com domain (/sobjects/Knowledge__kav).
 * For each one it reports worked / blocked, and which fields came back with
 * their size. Content is only shown as sizes; the full JSON can be downloaded
 * locally with the "Download JSON" button.
 */

(function () {
  'use strict';

  const API_VERSION = 'v59.0';
  const MY_DOMAIN = 'https://thumbtack.my.salesforce.com';
  const KA_URL_PATTERN = /\/lightning\/r\/Knowledge__kav\/([a-zA-Z0-9]{15,18})/;
  const REPORT_URL_PATTERN = /\/lightning\/r\/Report\/(00O[a-zA-Z0-9]{12,15})/;

  let _lastJson = null;

  function recordId() {
    const m = location.href.match(KA_URL_PATTERN);
    return m ? m[1] : null;
  }

  function reportId() {
    const m = location.href.match(REPORT_URL_PATTERN);
    return m ? m[1] : null;
  }

  // --- Method A: Aura (Lightning internal channel) -------------------------

  function auraToken(A) {
    const cs = A && A.clientService;
    const candidates = [
      cs && cs._token, cs && cs.token,
      cs && typeof cs.getToken === 'function' ? cs.getToken() : null,
    ];
    for (const c of candidates) if (c) return c;
    return null;
  }

  async function tryAura(id) {
    const A = unsafeWindow.$A;
    if (!A) return { ok: false, why: 'Lightning framework ($A) not found on the page' };
    const token = auraToken(A);
    if (!token) return { ok: false, why: 'Could not get the page session token' };
    let context;
    try { context = A.getContext().encodeForServer(); }
    catch (e) { return { ok: false, why: 'Could not read the page context: ' + e.message }; }

    const message = {
      actions: [{
        id: '1;a',
        descriptor: 'aura://RecordUiController/ACTION$getRecordWithLayouts',
        callingDescriptor: 'UNKNOWN',
        params: { recordId: id, layoutTypes: ['Full'], modes: ['View'] },
      }],
    };
    const body = new URLSearchParams({
      message: JSON.stringify(message),
      'aura.context': typeof context === 'string' ? context : JSON.stringify(context),
      'aura.pageURI': location.pathname + location.search,
      'aura.token': token,
    });
    const resp = await fetch('/aura?r=1&aura.RecordUi.getRecordWithLayouts=1', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    const text = (await resp.text()).replace(/^while\(1\);\s*/, '');
    if (!resp.ok) return { ok: false, why: 'HTTP ' + resp.status };
    let json;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, why: 'Response is not JSON' }; }
    const action = (json.actions || [])[0] || {};
    if (action.state !== 'SUCCESS') {
      const err = (action.error || [])[0];
      return { ok: false, why: 'Salesforce said: ' + (action.state || 'no state') + (err && err.message ? ' - ' + err.message : '') };
    }
    const rv = action.returnValue || {};
    const rec = rv.record || (rv.records && rv.records[id]) || null;
    if (!rec || !rec.fields) return { ok: false, why: 'Answer came back without record fields' };
    return { ok: true, fields: flattenUiFields(rec.fields), raw: rv };
  }

  // --- Method B: UI API on the Lightning domain ---------------------------

  async function tryUiApi(id) {
    const extra = ['ArticleNumber', 'VersionNumber', 'PublishStatus', 'Language']
      .map(f => 'Knowledge__kav.' + f).join(',');
    const url = '/services/data/' + API_VERSION + '/ui-api/records/' + id +
      '?layoutTypes=Full&modes=View&optionalFields=' + encodeURIComponent(extra);
    const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, why: 'HTTP ' + resp.status + ' ' + shortErr(text) };
    let json;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, why: 'Response is not JSON (probably a login page)' }; }
    if (!json.fields) return { ok: false, why: 'Answer came back without fields' };
    return { ok: true, fields: flattenUiFields(json.fields), raw: json };
  }

  // --- List tests: can we get ALL published KAs at once? -----------------
  // The Lightning session only opens the "UI API" door (plain SOQL /query
  // returned 401 in v0.2.0), so these use UI API routes, plus the classic
  // report export when the button is pressed on a Report page.

  const LIST_FIELDS = ['Title', 'ArticleNumber', 'UrlName', 'VersionNumber', 'LastModifiedDate', 'PublishStatus', 'Language'];

  function listRow(get) {
    return {
      id: get('Id'), articleNumber: get('ArticleNumber'), title: get('Title'), urlName: get('UrlName'),
      version: get('VersionNumber'), lastModified: get('LastModifiedDate'),
      publishStatus: get('PublishStatus'), language: get('Language'),
    };
  }

  // D. UI API GraphQL (read-only query), 2000 per page.
  async function tryGraphQL() {
    const rows = [];
    let after = null;
    for (let page = 0; page < 25; page++) {
      const query = 'query KaList($after: String) { uiapi { query { Knowledge__kav(first: 2000, after: $after, ' +
        'where: { PublishStatus: { eq: "Online" } }) { totalCount pageInfo { hasNextPage endCursor } ' +
        'edges { node { Id ' + LIST_FIELDS.map(f => f + ' { value }').join(' ') + ' } } } } } }';
      const resp = await fetch('/services/data/' + API_VERSION + '/graphql', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: query, variables: { after: after } }),
      });
      const text = await resp.text();
      if (!resp.ok) return { ok: false, why: 'HTTP ' + resp.status + ' ' + shortErr(text) };
      let json;
      try { json = JSON.parse(text); } catch (e) { return { ok: false, why: 'Response is not JSON (probably a login page)' }; }
      if (json.errors && json.errors.length) return { ok: false, why: 'Salesforce said: ' + (json.errors[0].message || 'error') };
      const conn = json.data && json.data.uiapi && json.data.uiapi.query && json.data.uiapi.query.Knowledge__kav;
      if (!conn) return { ok: false, why: 'Answer came back without a list' };
      for (const e of conn.edges || []) {
        const n = e.node || {};
        rows.push(listRow(f => (f === 'Id' ? n.Id : (n[f] && n[f].value))));
      }
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { ok: true, rows: rows, note: 'totalCount ' + conn.totalCount };
      after = conn.pageInfo.endCursor;
    }
    return { ok: true, rows: rows, note: 'stopped after 25 pages' };
  }

  // E. UI API list views (e.g. the "Published Articles" tab).
  async function getJson(url) {
    const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    const text = await resp.text();
    if (!resp.ok) return { error: 'HTTP ' + resp.status + ' ' + shortErr(text) };
    try { return { json: JSON.parse(text) }; } catch (e) { return { error: 'Response is not JSON (probably a login page)' }; }
  }

  async function tryListView() {
    const base = '/services/data/' + API_VERSION + '/ui-api';
    let views = null;
    let why = '';
    for (const path of ['/list-info/Knowledge__kav?recentListsOnly=false', '/list-ui/Knowledge__kav?pageSize=200']) {
      const r = await getJson(base + path);
      if (r.error) { why = r.error; continue; }
      const coll = r.json.lists || r.json.listInfoBatch || (r.json.lists && r.json.lists.lists) || [];
      views = coll.map(v => ({ apiName: v.apiName || (v.listReference && v.listReference.listViewApiName),
                               label: v.label, id: v.id || (v.listReference && v.listReference.id) }))
                  .filter(v => v.apiName);
      if (views.length) break;
    }
    if (!views || !views.length) return { ok: false, why: 'Could not read the list views: ' + why };
    const view = views.find(v => /publish/i.test(v.label || '')) || views[0];
    const rows = [];
    let pageToken = null;
    const fields = LIST_FIELDS.map(f => 'Knowledge__kav.' + f).join(',');
    for (let page = 0; page < 25; page++) {
      const url = base + '/list-records/Knowledge__kav/' + encodeURIComponent(view.apiName) +
        '?pageSize=2000&optionalFields=' + encodeURIComponent(fields) + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const r = await getJson(url);
      if (r.error) return { ok: false, why: 'View "' + view.label + '": ' + r.error };
      for (const rec of r.json.records || []) {
        const f = rec.fields || {};
        rows.push(listRow(k => (k === 'Id' ? rec.id : (f[k] && f[k].value))));
      }
      pageToken = r.json.nextPageToken;
      if (!pageToken) break;
    }
    return { ok: true, rows: rows, note: 'view "' + view.label + '" (' + views.length + ' views found)' };
  }

  // F. Report export (only when the button is pressed on a Report page).
  function tryReportExport(reportId) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: MY_DOMAIN + '/' + reportId + '?export=1&enc=UTF-8&xf=csv',
        onload(resp) {
          const t = resp.responseText || '';
          if (resp.status !== 200) { resolve({ ok: false, why: 'HTTP ' + resp.status }); return; }
          if (/^\s*</.test(t)) { resolve({ ok: false, why: 'Got a web page instead of a CSV (probably a login page)' }); return; }
          const lines = t.split(/\r?\n/).filter(l => l.trim());
          resolve({ ok: true, csv: t, note: Math.max(0, lines.length - 1) + ' rows; columns: ' + (lines[0] || '').slice(0, 300) });
        },
        onerror() { resolve({ ok: false, why: 'Network error / blocked' }); },
      });
    });
  }

  // F2. Same export, but on the Lightning domain (same origin as the page).
  async function tryReportExportLightning(reportId) {
    const resp = await fetch('/' + reportId + '?export=1&enc=UTF-8&xf=csv', { credentials: 'include' });
    const t = await resp.text();
    if (!resp.ok) return { ok: false, why: 'HTTP ' + resp.status };
    if (/^\s*</.test(t)) return { ok: false, why: 'Got a web page instead of a CSV' };
    const lines = t.split(/\r?\n/).filter(l => l.trim());
    return { ok: true, csv: t, note: Math.max(0, lines.length - 1) + ' rows; columns: ' + (lines[0] || '').slice(0, 300) };
  }

  // H. Read the report table that is already drawn on the screen (also
  //    inside same-origin iframes and shadow DOM).
  function collectDocs(doc, out, depth) {
    out.push(doc);
    if (depth > 3) return;
    doc.querySelectorAll('iframe').forEach(f => {
      try { if (f.contentDocument) collectDocs(f.contentDocument, out, depth + 1); } catch (e) { /* cross-origin frame */ }
    });
  }

  function collectTables(root, out, depth) {
    root.querySelectorAll('table').forEach(t => out.push(t));
    if (depth > 20) return;
    root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) collectTables(el.shadowRoot, out, depth + 1); });
  }

  function isShown(el) {
    // Visible in its own document AND (for iframes) the iframe itself is visible.
    for (let cur = el; cur; ) {
      const win = cur.ownerDocument && cur.ownerDocument.defaultView;
      const r = cur.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = win && win.getComputedStyle(cur);
      if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) return false;
      cur = win && win.frameElement;
    }
    return true;
  }

  function readRows(table, into) {
    let added = 0;
    for (const tr of table.querySelectorAll('tbody tr')) {
      const cells = Array.from(tr.querySelectorAll('td, th')).map(td => (td.innerText || '').trim());
      const links = Array.from(tr.querySelectorAll('a[href]')).map(a => a.getAttribute('href'));
      const recLink = links.find(h => /\/lightning\/r\/ka[0-9A-Za-z]{13,16}\//.test(h || ''));
      const key = recLink || cells.join('|');
      if (!recLink || into.has(key)) continue;   // skip header/total rows and repeats
      into.set(key, { cells: cells, links: links });
      added++;
    }
    return added;
  }

  function scrollParent(el) {
    for (let cur = el; cur; cur = cur.parentElement) {
      const cs = cur.ownerDocument.defaultView.getComputedStyle(cur);
      if (/(auto|scroll)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 5) return cur;
    }
    return null;
  }

  async function tryReportTable() {
    const docs = [];
    collectDocs(document, docs, 0);
    // Only the report on the tab you are looking at (console keeps other tabs loaded).
    let best = null;
    for (const d of docs) {
      const tables = [];
      collectTables(d, tables, 0);
      for (const t of tables) {
        if (!isShown(t)) continue;
        const n = t.querySelectorAll('tbody tr').length;
        if (!best || n > best.n) best = { t: t, n: n, doc: d };
      }
    }
    if (!best || best.n < 2) return { ok: false, why: 'No visible report table (' + docs.length + ' frames checked)' };

    const text = (best.doc.body && best.doc.body.innerText) || '';
    const m = text.match(/Total Records\s*([\d,]+)/i);
    const total = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;

    // Scroll the table's container step by step: Salesforce only draws the rows near the screen.
    const rows = new Map();
    readRows(best.t, rows);
    const box = scrollParent(best.t);
    const scroller = box || best.doc.scrollingElement;
    let still = 0;
    for (let i = 0; i < 400 && still < 6 && !(total && rows.size >= total); i++) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + Math.max(200, scroller.clientHeight * 0.8);
      await sleep(350);
      const added = readRows(best.t, rows);
      still = (added === 0 && scroller.scrollTop === before) ? still + 1 : (added === 0 ? still + 0.5 : 0);
    }
    scroller.scrollTop = 0;
    const list = Array.from(rows.values());
    const complete = total === null ? null : list.length >= total;
    return { ok: true, tableRows: list,
             note: list.length + ' of ' + (total === null ? '?' : total) + ' rows read' +
                   (complete === false ? ' (INCOMPLETE)' : complete ? ' (complete)' : '') };
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function tryReportApi(reportId) {
    const r = await getJson('/services/data/' + API_VERSION + '/analytics/reports/' + reportId + '?includeDetails=true');
    if (r.error) return { ok: false, why: r.error };
    const rows = ((r.json.factMap || {})['T!T'] || {}).rows || [];
    return { ok: true, report: r.json, note: rows.length + ' rows' };
  }

  // --- Method C: REST API on the my.salesforce.com domain -----------------

  function tryRest(id) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: MY_DOMAIN + '/services/data/' + API_VERSION + '/sobjects/Knowledge__kav/' + id,
        headers: { Accept: 'application/json' },
        onload(resp) {
          if (resp.status !== 200) {
            resolve({ ok: false, why: 'HTTP ' + resp.status + ' ' + shortErr(resp.responseText) });
            return;
          }
          try {
            const json = JSON.parse(resp.responseText);
            const fields = {};
            for (const k of Object.keys(json)) if (k !== 'attributes') fields[k] = json[k];
            resolve({ ok: true, fields, raw: json });
          } catch (e) { resolve({ ok: false, why: 'Response is not JSON (probably a login page)' }); }
        },
        onerror() { resolve({ ok: false, why: 'Network error / blocked' }); },
      });
    });
  }

  // --- Helpers -------------------------------------------------------------

  function flattenUiFields(fields) {
    const out = {};
    for (const k of Object.keys(fields)) {
      const f = fields[k];
      out[k] = f && typeof f === 'object' && 'value' in f ? f.value : f;
    }
    return out;
  }

  function shortErr(text) {
    try {
      const parsed = JSON.parse(text);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first && (first.errorCode || first.message)) {
        return '- ' + (first.errorCode || '') + ' ' + (first.message || '');
      }
      return '';
    } catch (err) {
      return '';
    }
  }

  function fieldSummary(fields) {
    const rows = [];
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (v === null || v === undefined || v === '') continue;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      rows.push({ name: k, size: s.length, html: /<[a-z][\s\S]*>|&lt;[a-z]/i.test(s) });
    }
    rows.sort((a, b) => (b.html - a.html) || (b.size - a.size));
    return rows;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- Run -----------------------------------------------------------------

  async function attempt(label, fn) {
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, why: 'Error: ' + e.message }; }
    return Object.assign({ label: label }, r);
  }

  function resultLine(r) {
    if (!r.ok) return r.label + ' - ' + r.why;
    if (r.fields) return r.label + ' - ' + Object.keys(r.fields).length + ' fields';
    if (r.rows) return r.label + ' - ' + r.rows.length + ' KAs' + (r.note ? ' (' + r.note + ')' : '');
    return r.label + (r.note ? ' - ' + r.note : '');
  }

  async function runProbe() {
    const id = recordId();
    const rid = reportId();
    const box = showBox('<b>Testing...</b>');
    if (!id && !rid) { box.innerHTML = '\u274C Open a KA or a Report first.'; return; }

    const results = [];
    if (id) {
      results.push(await attempt('A. Lightning internal channel', () => tryAura(id)));
      results.push(await attempt('B. UI API (Lightning domain)', () => tryUiApi(id)));
      results.push(await attempt('C. REST API (my.salesforce.com)', () => tryRest(id)));
    }
    box.innerHTML = '<b>Testing the list of published KAs...</b>';
    results.push(await attempt('D. List via GraphQL', tryGraphQL));
    results.push(await attempt('E. List via list view', tryListView));
    if (rid) {
      box.innerHTML = '<b>Testing the report export...</b>';
      results.push(await attempt('F. Report export (CSV)', () => tryReportExport(rid)));
      results.push(await attempt('F2. Report export (Lightning domain)', () => tryReportExportLightning(rid)));
      results.push(await attempt('H. Report table on screen', tryReportTable));
      results.push(await attempt('G. Report API', () => tryReportApi(rid)));
    }

    const winner = results.find(r => r.ok && r.fields);
    const list = results.find(r => r.ok && (r.rows || r.csv || r.report || r.tableRows));
    _lastJson = { recordId: id, reportId: rid };
    if (winner) { _lastJson.method = winner.label; _lastJson.fields = winner.fields; }
    for (const r of results) {
      if (r.ok && r.rows) _lastJson['list_' + r.label.charAt(0)] = r.rows;
      if (r.ok && r.csv) _lastJson.reportCsv = r.csv;
      if (r.ok && r.report) _lastJson.reportJson = r.report;
      if (r.ok && r.tableRows) _lastJson.reportTable = r.tableRows;
    }
    const anyOk = results.some(r => r.ok);

    let head = [];
    if (id) head.push(winner ? '\u2705 The KA can be read as JSON.' : '\u274C The KA cannot be read as JSON.');
    head.push(list ? '\u2705 A full list can be read.' : '\u274C No full list yet.');
    let html = '<div style="font-weight:700;font-size:14px;margin-bottom:8px">' + head.join('<br>') + '</div>';
    for (const r of results) {
      const parts = resultLine(r).split(' - ');
      html += '<div style="margin:4px 0">' + (r.ok ? '\u2705 ' : '\u274C ') + '<b>' + esc(parts.shift()) + '</b>' +
        (parts.length ? (r.ok ? ' - ' + esc(parts.join(' - ')) : '<br><span style="color:#8A8D91">' + esc(parts.join(' - ')) + '</span>') : '') +
        '</div>';
    }
    if (winner) {
      const rows = fieldSummary(winner.fields);
      html += '<div style="margin-top:8px;font-weight:600">Fields with content (\uD83D\uDCC4 = has formatting/HTML):</div>' +
        '<div style="max-height:140px;overflow:auto;font-size:11px;border:1px solid #E8E9EB;border-radius:6px;padding:6px">' +
        rows.map(r => (r.html ? '\uD83D\uDCC4 ' : '\u25AB\uFE0F ') + esc(r.name) + ' - ' + r.size + ' chars').join('<br>') + '</div>';
    }
    html += '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<button id="kjp-copy" class="kjp-btn">Copy result</button>' +
      (anyOk ? '<button id="kjp-dl" class="kjp-btn">Download JSON</button>' : '') +
      '<button id="kjp-close" class="kjp-btn kjp-grey">Close</button></div>';
    box.innerHTML = html;

    const summaryText = 'KA JSON Probe v0.5.0 - ' + (id ? 'record ' + id : 'report ' + rid) + '\n' +
      results.map(r => (r.ok ? 'OK   ' : 'FAIL ') + resultLine(r)).join('\n') +
      (winner ? '\n\nFields:\n' + fieldSummary(winner.fields).map(r => (r.html ? '[html] ' : '       ') + r.name + ' ' + r.size).join('\n') : '');
    document.getElementById('kjp-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(summaryText); document.getElementById('kjp-copy').textContent = 'Copied \u2713'; }
      catch (e) { window.prompt('Copy this:', summaryText); }
    };
    const dl = document.getElementById('kjp-dl');
    if (dl) dl.onclick = () => {
      const blob = new Blob([JSON.stringify(_lastJson, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ka-probe-' + (id || rid) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    document.getElementById('kjp-close').onclick = () => { document.getElementById('kjp-box').remove(); };
  }

  // --- UI (top-LEFT: clear of Salesforce's bottom utility bar and the KA Refresh buttons) ---------

  GM_addStyle(`
    #kjp-btn { position: fixed; top: 110px; left: 20px; z-index: 2147483647; padding: 10px 16px;
      font: 600 13px -apple-system, sans-serif; background: #7C3AED; color: #fff; border: none;
      border-radius: 100px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
    #kjp-box { position: fixed; top: 156px; left: 20px; z-index: 2147483647; width: 360px;
      background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.16);
      padding: 14px 16px; font: 13px/1.5 -apple-system, sans-serif; color: #2F3033; }
    .kjp-btn { padding: 6px 12px; font-size: 12px; font-weight: 600; border: none;
      border-radius: 100px; background: #7C3AED; color: #fff; cursor: pointer; }
    .kjp-grey { background: #8A8D91; }
  `);

  function showBox(html) {
    let box = document.getElementById('kjp-box');
    if (!box) { box = document.createElement('div'); box.id = 'kjp-box'; document.body.appendChild(box); }
    box.innerHTML = html;
    return box;
  }

  function injectButton() {
    if (!KA_URL_PATTERN.test(location.href) && !REPORT_URL_PATTERN.test(location.href)) {
      const b = document.getElementById('kjp-btn'); if (b) b.remove();
      return;
    }
    if (document.getElementById('kjp-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'kjp-btn';
    btn.textContent = '\uD83E\uDDEA Test JSON';
    btn.onclick = runProbe;
    document.body.appendChild(btn);
  }

  // Also runnable from the Tampermonkey menu, in case the button is hidden.
  GM_registerMenuCommand('Run KA JSON test', runProbe);

  setTimeout(injectButton, 1500);
  let _href = location.href;
  setInterval(() => { if (location.href !== _href) { _href = location.href; setTimeout(injectButton, 1200); } }, 1000);
})();
