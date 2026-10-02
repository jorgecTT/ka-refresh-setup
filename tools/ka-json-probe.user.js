// ==UserScript==
// @name         KA JSON Probe (test only)
// @namespace    ka-json-probe
// @version      0.2.0
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
 * Tries 3 read-only ways to get the KA record as JSON:
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

  let _lastJson = null;

  function recordId() {
    const m = location.href.match(KA_URL_PATTERN);
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

  // --- Test D: list ALL published KAs (read-only SOQL query) --------------
  // If this works, the weekly audit can compare Salesforce vs Drive without
  // opening each KA. Tries with the English filter first, then without it.

  async function tryPublishedList() {
    const base = 'SELECT Id, ArticleNumber, Title, UrlName, VersionNumber, LastModifiedDate ' +
      "FROM Knowledge__kav WHERE PublishStatus = 'Online'";
    const queries = [base + " AND Language = 'en_US'", base];
    let lastWhy = '';
    for (const q of queries) {
      let url = '/services/data/' + API_VERSION + '/query?q=' + encodeURIComponent(q);
      const rows = [];
      let total = null;
      let failed = false;
      for (let page = 0; url && page < 50; page++) {
        const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        const text = await resp.text();
        if (!resp.ok) { lastWhy = 'HTTP ' + resp.status + ' ' + shortErr(text); failed = true; break; }
        let json;
        try { json = JSON.parse(text); } catch (e) { lastWhy = 'Response is not JSON (probably a login page)'; failed = true; break; }
        if (total === null) total = json.totalSize;
        for (const r of json.records || []) {
          rows.push({ id: r.Id, articleNumber: r.ArticleNumber, title: r.Title, urlName: r.UrlName,
                      version: r.VersionNumber, lastModified: r.LastModifiedDate });
        }
        url = json.done ? null : json.nextRecordsUrl;
      }
      if (!failed) return { ok: true, total: total, rows: rows, englishOnly: q !== base };
    }
    return { ok: false, why: lastWhy };
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

  async function runProbe() {
    const id = recordId();
    const box = showBox('<b>Testing...</b>');
    if (!id) { box.innerHTML = '\u274C Open a KA first (the URL must contain Knowledge__kav).'; return; }

    const methods = [
      ['A. Lightning internal channel', tryAura],
      ['B. UI API (Lightning domain)', tryUiApi],
      ['C. REST API (my.salesforce.com)', tryRest],
    ];
    const results = [];
    for (const [label, fn] of methods) {
      let r;
      try { r = await fn(id); } catch (e) { r = { ok: false, why: 'Error: ' + e.message }; }
      results.push({ label, ...r });
    }

    const winner = results.find(r => r.ok);
    box.innerHTML = '<b>Testing the list of published KAs...</b>';
    let list;
    try { list = await tryPublishedList(); } catch (e) { list = { ok: false, why: 'Error: ' + e.message }; }
    _lastJson = winner ? { recordId: id, method: winner.label, fields: winner.fields } : null;
    if (list.ok) {
      _lastJson = _lastJson || { recordId: id };
      _lastJson.publishedList = list.rows;
    }
    const listLine = list.ok
      ? 'D. List of published KAs - ' + list.rows.length + ' KAs' + (list.englishOnly ? ' (English)' : ' (all languages)')
      : 'D. List of published KAs - ' + list.why;

    let html = '<div style="font-weight:700;font-size:14px;margin-bottom:8px">' +
      (winner ? '\u2705 It works! The KA can be read as JSON.' : '\u274C Blocked: the KA cannot be read as JSON.') + '</div>';
    for (const r of results) {
      html += '<div style="margin:4px 0">' + (r.ok ? '\u2705 ' : '\u274C ') + '<b>' + esc(r.label) + '</b>' +
        (r.ok ? ' - ' + Object.keys(r.fields).length + ' fields' : '<br><span style="color:#8A8D91">' + esc(r.why) + '</span>') +
        '</div>';
    }
    html += '<div style="margin:4px 0">' + (list.ok ? '\u2705 <b>' : '\u274C <b>') + esc(listLine) + '</b></div>';
    if (winner) {
      const rows = fieldSummary(winner.fields);
      html += '<div style="margin-top:8px;font-weight:600">Fields with content (\uD83D\uDCC4 = has formatting/HTML):</div>' +
        '<div style="max-height:180px;overflow:auto;font-size:11px;border:1px solid #E8E9EB;border-radius:6px;padding:6px">' +
        rows.map(r => (r.html ? '\uD83D\uDCC4 ' : '\u25AB\uFE0F ') + esc(r.name) + ' - ' + r.size + ' chars').join('<br>') + '</div>';
    }
    html += '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<button id="kjp-copy" class="kjp-btn">Copy result</button>' +
      (_lastJson ? '<button id="kjp-dl" class="kjp-btn">Download JSON</button>' : '') +
      '<button id="kjp-close" class="kjp-btn kjp-grey">Close</button></div>';
    box.innerHTML = html;

    const summaryText = 'KA JSON Probe v0.2.0 - record ' + id + '\n' +
      results.map(r => (r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.ok ? ' (' + Object.keys(r.fields).length + ' fields)' : ' - ' + r.why)).join('\n') +
      '\n' + (list.ok ? 'OK   ' : 'FAIL ') + listLine +
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
      a.download = 'ka-' + id + '.json';
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
    if (!KA_URL_PATTERN.test(location.href)) {
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
