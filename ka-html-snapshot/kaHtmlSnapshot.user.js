// ==UserScript==
// @name         KA HTML Snapshot
// @namespace    https://thumbtack.com/ka-html-snapshot
// @version      1.0.0
// @description  Saves the exact Salesforce HTML of KAs (anchors, dropdowns, colors) to the Drive folder "KA HTML - do not edit", for the Content Index Dashboard's KA Checkup. Separate from KA Refresh: it never changes KA Refresh, KA Sync or the KA Docs.
// @author       jcardona@thumbtack.com
// @match        https://thumbtack.lightning.force.com/*
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

/*
 * KA HTML SNAPSHOT v1.0.0
 *
 * What it does:
 *   - "Save this KA's HTML": the KA you have open.
 *   - "Save all KAs" / "Save KAs that changed": every published KA, read straight
 *     from Salesforce (no need to open each one). Keep the tab open while it runs.
 *   - Hybrid: when you click KA Refresh's "↑ Update" or "+ New", this script also
 *     saves that KA's HTML a few seconds later. It only listens for the click;
 *     KA Refresh itself is not changed.
 *
 * Where it reads the HTML: the Salesforce UI API (/services/data/v59.0/ui-api),
 * the rich text fields of the KA record exactly as stored. If that can't be read,
 * nothing is saved for that KA (it never saves a cleaned copy).
 *
 * Setup: Tampermonkey menu → "Set web app URL and key" (from the KA HTML Snapshot
 * Apps Script: Deploy → web app URL, and the key that setup() logs).
 */

(function () {
  'use strict';
  if (window.top !== window.self) return;

  const VERSION = '1.0.0';
  const K_URL = 'KHS_url', K_KEY = 'KHS_key', K_SAVED = 'KHS_saved', K_IDS = 'KHS_urlname_ids';
  const API = '/services/data/v59.0/ui-api';
  const BOX_ORDER = ['KB Content', 'Related Content', 'MC Content', 'Additional Content', 'Support Content'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- small status box (bottom right) ----------
  function box(html, sticky) {
    let b = document.getElementById('khs-box');
    if (!b) {
      b = document.createElement('div'); b.id = 'khs-box';
      b.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;max-width:360px;background:#fff;border-radius:10px;' +
        'box-shadow:0 4px 18px rgba(0,0,0,.18);padding:10px 14px;font:13px/1.45 -apple-system,sans-serif;color:#2F3033';
      document.body.appendChild(b);
    }
    b.innerHTML = '<div style="font-weight:700;margin-bottom:4px">KA HTML Snapshot</div>' + html +
      (sticky ? '' : '') + '<div style="margin-top:6px"><a href="#" id="khs-x" style="font-size:12px;color:#5B5D62">Close</a></div>';
    b.querySelector('#khs-x').onclick = e => { e.preventDefault(); b.remove(); };
    clearTimeout(box._t);
    if (!sticky) box._t = setTimeout(() => b.remove(), 9000);
    return b;
  }

  // ---------- settings ----------
  function setup() {
    const url = window.prompt('KA HTML Snapshot: paste the web app URL (Apps Script → Deploy → Web app URL, ends in /exec)', GM_getValue(K_URL, ''));
    if (url == null) return;
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url.trim())) { window.alert('That doesn\'t look like a web app URL (it should end in /exec).'); return; }
    const key = window.prompt('Now paste the secret key (Apps Script → run setup() → View → Logs)', GM_getValue(K_KEY, ''));
    if (key == null) return;
    GM_setValue(K_URL, url.trim()); GM_setValue(K_KEY, key.trim());
    post({ action: 'ping' }).then(r => box(r.ok ? '✓ Connected (web app ' + esc(r.version) + '). <a href="' + esc(r.folderUrl) + '" target="_blank">Open the folder</a>' : '✗ ' + esc(r.error)))
      .catch(e => box('✗ ' + esc(e.message)));
  }

  function post(payload) {
    const url = GM_getValue(K_URL, ''), key = GM_getValue(K_KEY, '');
    if (!url || !key) return Promise.reject(new Error('Not set up yet: Tampermonkey menu → "Set web app URL and key".'));
    payload.secret = key;
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url, headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(payload), timeout: 120000,
      onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error(/<html|<!DOCTYPE/i.test(r.responseText || '') ? 'Google asked to sign in: sign into your Thumbtack Google account' : 'Bad answer from the web app (HTTP ' + r.status + ')')); } },
      onerror: () => reject(new Error('Network error reaching the web app')), ontimeout: () => reject(new Error('The web app took too long')),
    }));
  }

  // ---------- Salesforce UI API ----------
  async function uiGet(path) {
    const resp = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    const text = await resp.text();
    if (!resp.ok) throw new Error('Salesforce answered HTTP ' + resp.status);
    try { return JSON.parse(text); } catch (e) { throw new Error('Salesforce did not answer with data (signed out?)'); }
  }
  const who = f => !f ? '' : f.displayValue ? String(f.displayValue) : (f.value && f.value.fields && f.value.fields.Name && f.value.fields.Name.value) || '';
  let _fields = null;
  async function htmlFields() {
    if (_fields) return _fields;
    const info = await uiGet(API + '/object-info/Knowledge__kav');
    _fields = Object.values(info.fields || {}).filter(f => f.htmlFormatted).map(f => ({ api: f.apiName, label: f.label }));
    if (!_fields.length) throw new Error('No rich text fields found on Knowledge');
    return _fields;
  }
  // Every published KA: id, Url-Name, number, title, version, last modified (and by whom)
  async function publishedList() {
    let views = [];
    for (const p of ['/list-info/Knowledge__kav?recentListsOnly=false', '/list-ui/Knowledge__kav?pageSize=200']) {
      try { const info = await uiGet(API + p); const c = (info.lists && info.lists.lists) || info.lists || info.listInfoBatch || [];
        views = c.map(v => ({ apiName: v.apiName || (v.listReference && v.listReference.listViewApiName), label: v.label || '' })).filter(v => v.apiName); if (views.length) break; } catch (e) { /* next */ }
    }
    const view = views.find(v => /^published articles$/i.test(v.label.trim())) || views.find(v => /publish/i.test(v.label));
    if (!view) throw new Error('The "Published Articles" list view was not found');
    const sets = [['Title', 'ArticleNumber', 'UrlName', 'VersionNumber', 'LastModifiedDate', 'LastModifiedBy.Name'], ['Title', 'ArticleNumber', 'UrlName', 'VersionNumber', 'LastModifiedDate']]
      .map(s => s.map(f => 'Knowledge__kav.' + f).join(','));
    let fields = sets.shift(), token = null; const out = [];
    for (let page = 0; page < 25; page++) {
      let json;
      for (;;) {
        try { json = await uiGet(API + '/list-records/Knowledge__kav/' + encodeURIComponent(view.apiName) + '?pageSize=2000&optionalFields=' + encodeURIComponent(fields) + (token ? '&pageToken=' + encodeURIComponent(token) : '')); break; }
        catch (e) { if (page > 0 || !sets.length) throw e; fields = sets.shift(); }
      }
      for (const rec of json.records || []) { const f = rec.fields || {}, v = k => (f[k] && f[k].value != null ? f[k].value : '');
        out.push({ id: rec.id, urlName: v('UrlName'), kaNumber: v('ArticleNumber'), title: v('Title'), version: v('VersionNumber'), lastModified: v('LastModifiedDate'), lastModifiedBy: who(f.LastModifiedBy) }); }
      token = json.nextPageToken; if (!token) break;
    }
    if (!out.length) throw new Error('The "Published Articles" list came back empty');
    const map = {}; out.forEach(r => { if (r.urlName) map[String(r.urlName).toLowerCase()] = r.id; });
    GM_setValue(K_IDS, { at: Date.now(), map });
    return out;
  }
  // One KA record with its rich text boxes exactly as stored
  async function readKa(id) {
    const fl = await htmlFields();
    const rec = await uiGet(API + '/records/' + id + '?optionalFields=' + fl.map(f => 'Knowledge__kav.' + f.api).join(',') + ',' + ['Title', 'ArticleNumber', 'UrlName', 'VersionNumber', 'LastModifiedDate', 'LastModifiedBy.Name'].map(f => 'Knowledge__kav.' + f).join(','));
    const f = rec.fields || {}, v = k => (f[k] && f[k].value != null ? f[k].value : '');
    const rank = l => { const k = BOX_ORDER.findIndex(o => new RegExp(o.replace(/ /g, '.?'), 'i').test(l)); return k < 0 ? 99 : k; };
    const boxes = fl.map(x => ({ label: x.label, api: x.api, html: v(x.api) })).filter(b => b.html && String(b.html).trim()).sort((a, b) => rank(a.label) - rank(b.label));
    return { id, urlName: v('UrlName'), kaNumber: v('ArticleNumber'), title: v('Title'), version: v('VersionNumber'), lastModified: v('LastModifiedDate'), lastModifiedBy: who(f.LastModifiedBy),
      html: boxes.map(b => '<!-- BOX: ' + String(b.label).replace(/--/g, '-') + ' (' + b.api + ') -->\n' + b.html + '\n<!-- /BOX -->').join('\n') };
  }
  async function saveKa(id) {
    const ka = await readKa(id);
    if (!ka.urlName) throw new Error('This KA has no URL Name');
    if (!ka.html) throw new Error('Salesforce gave no content for this KA (nothing saved)');
    const res = await post({ action: 'save', urlName: ka.urlName, kaNumber: ka.kaNumber, title: ka.title, version: ka.version, lastModified: ka.lastModified,
      lastModifiedBy: ka.lastModifiedBy, recordId: id, url: location.origin + '/articles/Knowledge/' + ka.urlName, html: ka.html, source: 'salesforce ui-api ' + id });
    if (!res.ok) throw new Error(res.error || 'not saved');
    const saved = GM_getValue(K_SAVED, {}); saved[String(ka.urlName).toLowerCase()] = ka.lastModified; GM_setValue(K_SAVED, saved);
    return { ka, res };
  }

  // ---------- the KA open on screen ----------
  async function currentId() {
    const id = (location.href.match(/\/Knowledge__kav\/([a-zA-Z0-9]{15,18})/) || [])[1];
    if (id) return id;
    const un = ((location.href.match(/\/articles\/knowledge\/([^/?#]+)/i) || [])[1] || '').toLowerCase();
    if (!un) return '';
    let c = GM_getValue(K_IDS, null);
    if (!c || !c.map || !c.map[un] || Date.now() - c.at > 864e5) { await publishedList(); c = GM_getValue(K_IDS, null); }
    return (c && c.map && c.map[un]) || '';
  }
  let busyOne = false;
  async function saveCurrent(quiet) {
    if (busyOne) return; busyOne = true;
    try {
      const id = await currentId();
      if (!id) { if (!quiet) box('Open a KA first.'); return; }
      if (!quiet) box('Saving this KA’s HTML…', true);
      const { ka, res } = await saveKa(id);
      box('✓ HTML saved: <b>' + esc(ka.title) + '</b> (' + (res.created ? 'new file' : 'updated') + ', ' + Math.round(res.chars / 1000) + 'k characters)');
    } catch (e) { box('✗ HTML not saved: ' + esc(e.message)); }
    finally { busyOne = false; }
  }

  // ---------- all KAs ----------
  let bulk = null;
  async function saveAll(onlyChanged) {
    if (bulk) return;
    bulk = { stop: false, done: 0, ok: 0, skip: 0, fail: [], total: 0 };
    const draw = () => { const b = box('<div>' + (bulk.stop ? 'Stopping…' : 'Saving ' + (bulk.done + 1 > bulk.total ? bulk.total : bulk.done + 1) + ' of ' + bulk.total + '…') + '</div>' +
      '<div style="font-size:12px;color:#5B5D62">' + bulk.ok + ' saved · ' + bulk.skip + ' unchanged · ' + bulk.fail.length + ' failed. Keep this tab open.</div>' +
      '<button id="khs-stop" style="margin-top:6px;padding:4px 10px;border:none;border-radius:100px;background:#8A8D91;color:#fff;cursor:pointer">Stop</button>', true);
      const s = b.querySelector('#khs-stop'); if (s) s.onclick = () => { bulk.stop = true; draw(); }; };
    try {
      box('Reading the list of published KAs…', true);
      const list = await publishedList();
      const saved = GM_getValue(K_SAVED, {});
      bulk.total = list.length; draw();
      let i = 0;
      const worker = async () => {
        while (!bulk.stop && i < list.length) {
          const r = list[i++];
          if (onlyChanged && saved[String(r.urlName).toLowerCase()] && saved[String(r.urlName).toLowerCase()] === r.lastModified) { bulk.skip++; bulk.done++; draw(); continue; }
          try { await saveKa(r.id); bulk.ok++; }
          catch (e) { bulk.fail.push(r.title + ': ' + e.message); if (/sign in|key was not accepted|Not set up/i.test(e.message)) bulk.stop = true; }
          bulk.done++; draw();
        }
      };
      await Promise.all([worker(), worker()]);
      box('<b>' + (bulk.stop && bulk.done < bulk.total ? 'Stopped' : 'Done') + '</b>: ' + bulk.ok + ' saved, ' + bulk.skip + ' unchanged, ' + bulk.fail.length + ' failed' +
        (bulk.fail.length ? '<div style="font-size:12px;color:#C5221F;max-height:160px;overflow:auto;margin-top:4px">' + bulk.fail.slice(0, 30).map(esc).join('<br>') + '</div>' : ''), true);
    } catch (e) { box('✗ ' + esc(e.message), true); }
    finally { bulk = null; }
  }

  // ---------- hybrid: follow KA Refresh's Update / + New ----------
  document.addEventListener('click', e => {
    const t = e.target && e.target.closest && e.target.closest('#kar-update-btn, #kar-new-btn');
    if (!t) return;
    setTimeout(() => saveCurrent(true), 4000);
  }, true);

  GM_registerMenuCommand('Save this KA’s HTML', () => saveCurrent(false));
  GM_registerMenuCommand('Save KAs that changed', () => saveAll(true));
  GM_registerMenuCommand('Save all KAs', () => { if (window.confirm('Save the HTML of every published KA? It takes a few minutes. Keep this tab open.')) saveAll(false); });
  GM_registerMenuCommand('Set web app URL and key', setup);
  console.log('[KA HTML Snapshot] v' + VERSION + ' loaded');
})();
