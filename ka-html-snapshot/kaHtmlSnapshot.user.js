// ==UserScript==
// @name         KA HTML Snapshot
// @namespace    https://thumbtack.com/ka-html-snapshot
// @version      1.3.1
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
// @connect      help.thumbtack.com
// @run-at       document-idle
// ==/UserScript==

/*
 * KA HTML SNAPSHOT v1.3.1
 *
 * What it does:
 *   - "Save this KA's HTML": the KA you have open.
 *   - "Save all KAs" / "Save KAs that changed": every published KA, read straight
 *     from Salesforce (no need to open each one). Keep the tab open while it runs.
 *   - "Apply fixes": makes the changes the dashboard's KA Checkup → Fix sent, in the draft's
 *     boxes (Edit mode). It never saves: you review and click Save.
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

  const VERSION = '1.3.1';
  const K_URL = 'KHS_url', K_KEY = 'KHS_key', K_SAVED = 'KHS_saved', K_IDS = 'KHS_urlname_ids';
  // Personal copy only: the URL and key can be written here once. On first run they
  // are copied into Tampermonkey's storage, so later updates (which come without
  // them) keep working. Never put the key in the public repo.
  const PRESET_URL = '', PRESET_KEY = '';
  if (PRESET_URL && PRESET_KEY && !GM_getValue(K_KEY, '')) { GM_setValue(K_URL, PRESET_URL); GM_setValue(K_KEY, PRESET_KEY); }
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
    _fields = Object.values(info.fields || {}).filter(f => f.htmlFormatted && !f.calculated && f.dataType !== 'Url' && !/full article url/i.test(f.label || '')).map(f => ({ api: f.apiName, label: f.label }));
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
  // The UI API sends rich text escaped (&lt;h1&gt;): turn it back into real HTML.
  // Only when the value has no real tags, so already-raw HTML is left untouched.
  function unescapeHtml(s) {
    s = String(s || '');
    if (/<[a-z!\/]/i.test(s) || !/&lt;[a-z!\/]/i.test(s)) return s;
    const t = document.createElement('textarea'); t.innerHTML = s; return t.value;
  }
  // One KA record with its rich text boxes exactly as stored
  async function readKa(id) {
    const fl = await htmlFields();
    const rec = await uiGet(API + '/records/' + id + '?optionalFields=' + fl.map(f => 'Knowledge__kav.' + f.api).join(',') + ',' + ['Title', 'ArticleNumber', 'UrlName', 'VersionNumber', 'LastModifiedDate', 'LastModifiedBy.Name'].map(f => 'Knowledge__kav.' + f).join(','));
    const f = rec.fields || {}, v = k => (f[k] && f[k].value != null ? f[k].value : '');
    const rank = l => { const k = BOX_ORDER.findIndex(o => new RegExp(o.replace(/ /g, '.?'), 'i').test(l)); return k < 0 ? 99 : k; };
    const boxes = fl.map(x => ({ label: x.label, api: x.api, html: unescapeHtml(v(x.api)) })).filter(b => b.html && String(b.html).trim()).sort((a, b) => rank(a.label) - rank(b.label));
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

  // ---------- Apply fixes (from the dashboard's KA Checkup → Fix → Send to Salesforce) ----------
  // Works on the draft in Edit mode: it changes only what each fix names, in the rich text boxes, and never saves.
  function deepAll(root, sel, out) {
    out = out || [];
    root.querySelectorAll(sel).forEach(el => out.push(el));
    root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) deepAll(el.shadowRoot, sel, out); });
    return out;
  }
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 20; };
  function labelOf(el) {
    const direct = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('label'));
    if (direct) return direct;
    for (let cur = el, i = 0; cur && i < 12; i++) {
      const lab = cur.querySelector && cur.querySelector('label, .slds-form-element__label, legend');
      if (lab && lab.innerText && lab.innerText.trim().length < 60) return lab.innerText.trim();
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host);
    }
    return '';
  }
  // the content boxes of the edit form (rich text editors in frames), in the same order the HTML copy uses
  function contentBoxes() {
    const seen = new Set(), fr = [];
    deepAll(document, 'iframe').filter(shown).forEach(f => {
      try { const d = f.contentDocument, body = d && d.body;
        if (body && (body.isContentEditable || d.designMode === 'on') && !seen.has(body)) { seen.add(body); fr.push({ el: body, frame: f, label: labelOf(f) }); } } catch (e) { /* other domain */ }
    });
    const used = new Set(), boxRe = l => new RegExp(l.replace(/ /g, '.?'), 'i');
    return BOX_ORDER.map(l => fr.find(e => !used.has(e) && boxRe(l).test(e.label || '') && used.add(e))).filter(Boolean);
  }
  const fxKey = t => String(t || '').replace(/[ \s]+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
  const gmFinal = url => new Promise(res => GM_xmlhttpRequest({ method: 'GET', url, timeout: 15000,
    onload: r => res(r.status >= 200 && r.status < 400 ? (r.finalUrl || url) : null), onerror: () => res(null), ontimeout: () => res(null) }));
  const hcSlug = u => ((String(u || '').match(/^https?:\/\/help\.thumbtack\.com\/(?:[a-z-]+\/)?article\/([^?#\/\s)]+)/i) || [])[1] || '').toLowerCase();
  function parseFix(txt) { try { const d = JSON.parse(String(txt || '').trim()); return d && d.t === 'kar-khfix' && Array.isArray(d.ops) ? d : null; } catch (e) { return null; } }
  function retag(el, to) {
    const n = el.ownerDocument.createElement(to);
    Array.from(el.attributes).forEach(a => n.setAttribute(a.name, a.value));
    while (el.firstChild) n.appendChild(el.firstChild);
    el.replaceWith(n); return n;
  }
  // what a check counts in the boxes: anchors, dropdowns, tables, images, lists, text, and what the fixes remove
  function metrics(boxes) {
    const q = sel => boxes.reduce((n, b) => n + b.el.querySelectorAll(sel).length, 0);
    const anchors = boxes.reduce((n, b) => n + new Set(Array.from(b.el.querySelectorAll('[id],a[name]')).flatMap(e => [e.id, e.getAttribute('name')]).filter(Boolean)).size, 0);
    const links = boxes.flatMap(b => Array.from(b.el.querySelectorAll('a[href^="#"]')));
    return { anchors, dropdowns: q('details'), tables: q('table'), images: q('img'), lists: q('ul,ol'),
      text: boxes.reduce((n, b) => n + (b.el.textContent || '').replace(/\s/g, '').length, 0),
      emptyLinks: links.filter(a => !fxKey(a.textContent) && !a.querySelector('img') && !a.id && !a.getAttribute('name')).length,
      blank: links.filter(a => /_blank/i.test(a.getAttribute('target') || '')).length };
  }
  async function applyFixes(data, say) {
    const boxes = contentBoxes();
    if (!boxes.length) { say(false, 'Click Edit first', 'Open the KA’s draft, click Edit, wait for the content boxes, then Apply fixes again.'); return; }
    const id = await currentId();
    let here = null; try { if (id) here = await readKa(id); } catch (e) { /* checked below */ }
    if (here && data.urlName && String(here.urlName).toLowerCase() !== String(data.urlName).toLowerCase()) {
      say(false, 'Another KA', 'These fixes are for “' + data.ka + '” but this is “' + here.title + '”. Nothing was changed.'); return; }
    const all = sel => boxes.flatMap(b => Array.from(b.el.querySelectorAll(sel)).map(el => Object.assign(el, { _box: b })));
    const boxOf = el => boxes.find(b => b.el.contains(el));
    const touched = new Set(), done = [], miss = [], ok = new Set();
    const before = metrics(boxes);
    const count = s => all(s.tag).filter(e => fxKey(e.textContent) === s.text && (s.href == null || (e.getAttribute('href') || '') === s.href)).length;
    const find = s => {
      const c = all(s.tag).filter(e => fxKey(e.textContent) === s.text && (s.href == null || (e.getAttribute('href') || '') === s.href));
      if (c.length === s.of) return c[s.nth] || null;
      return c.length === 1 && s.of === 1 ? c[0] : null;
    };
    // find every target first, so one change doesn't move the next one
    const ORDER = ['unwrap-toc', 'rename', 'href', 'hc-resolve', 'record-url', 'repoint', 'add-entry', 'del-entry', 'del-empty', 'no-blank', 'retag', 'del'];
    const ops = data.ops.slice().sort((a, b) => ORDER.indexOf(a.op) - ORDER.indexOf(b.op)).map(o => ({ o, el: o.sel ? find(o.sel) : o.after ? find(o.after) : null, n0: o.sel ? count(o.sel) : 0 }));
    for (const { o, el } of ops) {
      try {
        if ((o.sel || o.after) && !el) { miss.push(o.what + ' (not found: it may be fixed already)'); continue; }
        if (o.op === 'retag') { touched.add(boxOf(el)); retag(el, o.to.toLowerCase()); }
        else if (o.op === 'del') { touched.add(boxOf(el)); el.remove(); }
        else if (o.op === 'repoint') {
          const links = all('a[href]').filter(a => a.getAttribute('href') === o.from);
          if (!links.length) { miss.push(o.what + ' (not found: it may be fixed already)'); continue; }
          links.forEach(a => { a.setAttribute('href', o.to); a.removeAttribute('data-mce-href'); if (/^#/.test(o.to)) a.removeAttribute('target'); touched.add(boxOf(a)); });
        }
        else if (o.op === 'del-entry') {
          const li = el.closest('li'), bx = boxOf(el);
          if (li && !li.querySelector('ol,ul') && fxKey(li.textContent) === fxKey(el.textContent)) li.remove(); else el.remove();
          touched.add(bx);
        }
        else if (o.op === 'add-entry') {
          const li = el.closest('li'); if (!li) { miss.push(o.what + ' (the Contents entry to put it after isn\u2019t in a list)'); continue; }
          const n = li.cloneNode(true); n.querySelectorAll('ol,ul').forEach(x => x.remove()); n.removeAttribute('id');
          const a = n.querySelector('a[href^="#"]'); if (!a) { miss.push(o.what + ' (couldn\u2019t copy the entry)'); continue; }
          a.setAttribute('href', '#' + o.anchor); a.removeAttribute('data-mce-href'); a.removeAttribute('id'); a.removeAttribute('name');
          const w = n.ownerDocument.createTreeWalker(a, NodeFilter.SHOW_TEXT); let first = null, t;
          while ((t = w.nextNode())) { if (!t.nodeValue.trim()) continue; if (!first) { first = t; t.nodeValue = o.to; } else t.nodeValue = ''; }
          const w2 = n.ownerDocument.createTreeWalker(n, NodeFilter.SHOW_TEXT); while ((t = w2.nextNode())) if (!a.contains(t)) t.nodeValue = '';
          li.after(n); touched.add(boxOf(li));
        }
        else if (o.op === 'unwrap-toc') {
          const a = el.querySelector('a[href="#contents"]'); if (!a) { miss.push(o.what + ' (not found)'); continue; }
          let top = a; while (top.parentElement && top.parentElement !== el && fxKey(top.parentElement.textContent) === fxKey(a.textContent)) top = top.parentElement;
          const div = el.ownerDocument.createElement('div'); div.appendChild(top); el.after(div); touched.add(boxOf(el));
        }
        else if (o.op === 'rename') {
          // second guard: never rename a link that starts or ends in the middle of a word ("r" + "efund policy")
          if (el.tagName === 'A') { const blk = el.closest('p,li,td,div,summary,h1,h2,h3,h4') || el.parentElement, full = blk ? blk.textContent || '' : '', raw = el.textContent || '', at = full.indexOf(raw);
            if (at >= 0 && (/[A-Za-z\u00C0-\u00FF]/.test(full[at - 1] || '') && /^[a-z\u00E0-\u00FF]/.test(raw) || /[A-Za-z\u00C0-\u00FF]$/.test(raw) && /^[a-z\u00E0-\u00FF]/.test(full[at + raw.length] || ''))) {
              miss.push(o.what + ' (not done: the link starts or ends in the middle of a word, so changing it would break the word. Fix it by hand)'); continue; } }
          const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT); let first = null, n;
          while ((n = w.nextNode())) { if (!n.nodeValue.trim()) continue; if (!first) { first = n; n.nodeValue = o.to; } else n.nodeValue = ''; }
          if (!first) { miss.push(o.what + ' (no text found)'); continue; } touched.add(boxOf(el));
        }
        else if (o.op === 'href' || o.op === 'hc-resolve' || o.op === 'record-url') {
          const from = o.op === 'href' ? o.from : o.href, links = all('a[href]').filter(a => a.getAttribute('href') === from);
          if (!links.length) { miss.push(o.what + ' (not found: it may be fixed already)'); continue; }
          let to = o.to;
          if (o.op === 'hc-resolve') {
            const fin = await gmFinal(from), s2 = hcSlug(fin);
            if (!s2) { miss.push(o.what + ' (the old address doesn’t open: check it by hand)'); continue; }
            if (s2 === hcSlug(from)) { miss.push(o.what + ' (it still opens the same address: nothing to change)'); continue; }
            to = from.replace(/\/article\/[^?#\/\s)]+/i, '/article/' + s2);
          }
          if (o.op === 'record-url') {
            // every KA record id in the address (the link itself and the ?ws= one), and the #section at the end
            const dec = decodeURIComponent(from), hash = (from.match(/#[^#]*$/) || [''])[0];
            const recs = [...new Set((dec.match(/Knowledge__kav\/([a-zA-Z0-9]{15,18})/gi) || []).map(x => x.split('/')[1]))];
            let un = '';
            for (const rid of recs) { try { const r = await uiGet(API + '/records/' + rid + '?optionalFields=Knowledge__kav.UrlName'); un = (r.fields && r.fields.UrlName && r.fields.UrlName.value) || ''; } catch (e) { /* next */ } if (un) break; }
            const hasAnchor = hash.length > 1 && all('[id],a[name]').some(e => e.id === hash.slice(1) || e.getAttribute('name') === hash.slice(1));
            if (!un && hasAnchor) { to = hash; links.forEach(a => { a.setAttribute('href', to); a.removeAttribute('data-mce-href'); a.removeAttribute('target'); touched.add(boxOf(a)); });
              ok.add(o); done.push(o.what + ' → ' + to + ' (that record is gone, but this KA has the ' + hash + ' section: check it’s the right one)'); continue; }
            if (!un) { miss.push(o.what + ' (Salesforce doesn’t know that record anymore: fix it by hand)'); continue; }
            to = here && String(here.urlName).toLowerCase() === un.toLowerCase() && hash ? hash : '/articles/Knowledge/' + un + hash;
          }
          links.forEach(a => { a.setAttribute('href', to); a.removeAttribute('data-mce-href'); touched.add(boxOf(a)); });
          ok.add(o); done.push(o.what + (o.op === 'href' ? '' : ' → ' + to)); continue;
        }
        else if (o.op === 'del-empty') {
          const e = all('a[href^="#"]').filter(a => !fxKey(a.textContent) && !a.querySelector('img') && !a.id && !a.getAttribute('name'));
          e.forEach(a => { touched.add(boxOf(a)); a.remove(); }); ok.add(o); done.push('Deleted ' + e.length + ' empty link' + (e.length === 1 ? '' : 's')); continue;
        }
        else if (o.op === 'no-blank') {
          const e = all('a[href^="#"][target]').filter(a => /_blank/i.test(a.getAttribute('target'))); e.forEach(a => { a.removeAttribute('target'); a.removeAttribute('rel'); touched.add(boxOf(a)); });
          ok.add(o); done.push('“Open in a new tab” removed from ' + e.length + ' link' + (e.length === 1 ? '' : 's')); continue;
        }
        else { miss.push(o.what + ' (unknown change)'); continue; }
        ok.add(o); done.push(o.what);
      } catch (e) { miss.push(o.what + ' (error: ' + (e && e.message || e) + ')'); }
    }
    touched.forEach(b => b && b.el.dispatchEvent(new Event('input', { bubbles: true })));
    say(done.length > 0, done.length + ' of ' + data.ops.length + ' fixes made', done.map(esc).join('<br>'));
    if (miss.length) say(false, miss.length + ' not made', miss.map(esc).join('<br>'));
    // ---- double check: read the boxes again and confirm each change is really there, and that nothing else was lost ----
    const after = metrics(boxes), bad = [], good = [];
    const toc = /\(\s*table of contents\s*\)/ig;
    for (const { o, n0 } of ops) {
      if (!ok.has(o)) continue;
      let yes = true;
      if (o.op === 'retag') yes = count(o.sel) === n0 - 1 && all(o.to).some(e => fxKey(e.textContent) === o.sel.text);
      else if (o.op === 'del') yes = count(o.sel) === n0 - 1;
      else if (o.op === 'unwrap-toc') { const t = fxKey(o.sel.text.replace(toc, '')); yes = all(o.sel.tag).some(e => fxKey(e.textContent) === t && !e.querySelector('a[href="#contents"]')); }
      else if (o.op === 'rename') yes = all('a').some(e => (e.getAttribute('href') || '') === o.sel.href && fxKey(e.textContent) === fxKey(o.to));
      else if (o.op === 'href' || o.op === 'hc-resolve' || o.op === 'record-url') yes = !all('a[href]').some(e => e.getAttribute('href') === (o.op === 'href' ? o.from : o.href));
      else if (o.op === 'repoint') yes = !all('a[href]').some(e => e.getAttribute('href') === o.from);
      else if (o.op === 'del-entry') yes = count(o.sel) === n0 - 1;
      else if (o.op === 'add-entry') yes = all('a[href="#' + o.anchor + '"]').some(e => fxKey(e.textContent) === fxKey(o.to));
      else if (o.op === 'del-empty') yes = after.emptyLinks === 0;
      else if (o.op === 'no-blank') yes = after.blank === 0;
      (yes ? good : bad).push(o.what);
    }
    const len = t => fxKey(t).replace(/\s/g, '').length;
    const expText = ops.filter(x => ok.has(x.o)).reduce((n, x) => n + (x.o.op === 'rename' ? len(x.o.to) - len(x.o.sel.text) : x.o.op === 'add-entry' ? len(x.o.to) : x.o.op === 'del-entry' || (x.o.op === 'del' && x.o.sel.tag === 'A') ? -len(x.o.sel.text) : 0), 0);
    const lost = [];
    if (after.anchors < before.anchors) lost.push((before.anchors - after.anchors) + ' anchor(s) missing (' + before.anchors + ' → ' + after.anchors + ')');
    ['dropdowns', 'tables', 'images', 'lists'].forEach(k => { if (after[k] !== before[k]) lost.push(k + ' changed: ' + before[k] + ' → ' + after[k]); });
    if (Math.abs(after.text - before.text - expText) > 3) lost.push('the text changed by ' + (after.text - before.text) + ' characters (expected ' + expText + ')');
    say(!bad.length, 'Check 1 · each change: ' + good.length + ' of ' + (good.length + bad.length) + ' confirmed', bad.length ? 'Not there after all: ' + bad.map(esc).join('<br>') : 'Read the boxes again: every change is in place.');
    say(!lost.length, 'Check 2 · nothing else changed', lost.length ? lost.map(esc).join('<br>') + '<br><b>Don’t save: click Cancel</b> and send a screenshot of this box.' :
      'Anchors ' + after.anchors + ', dropdowns ' + after.dropdowns + ', tables ' + after.tables + ', images ' + after.images + ', lists ' + after.lists + ': same as before. Text: ' + (after.text - before.text >= 0 ? '+' : '') + (after.text - before.text) + ' characters (from the names and Contents entries changed).');
    say(true, 'Next', (bad.length || lost.length ? '<b>Something didn’t go as planned: click Cancel to undo all of it.</b> ' : 'All good. ') + 'Review the boxes, then click <b>Save</b> yourself. Nothing was saved. After you publish, click ↑ Update (or Save this KA’s HTML), then in the dashboard Reload and Check all: it shows what got fixed.');
  }
  let fixBusy = false;
  function fixPanel() {
    if (fixBusy) return; fixBusy = true;
    const b = box('<div style="font-size:12px;color:#5B5D62;margin-bottom:6px">In the dashboard: KA Checkup → Fix → <b>Send to Salesforce</b>. Then click Paste here (or click in the box and press Cmd+V).</div>' +
      '<textarea id="khs-fx" rows="3" style="width:100%;box-sizing:border-box;font-size:11px;border:1px solid #c9c9c9;border-radius:6px;padding:6px"></textarea>' +
      '<div style="margin-top:6px;display:flex;gap:6px"><button id="khs-fxp" style="padding:4px 10px;border:1px solid #c9c9c9;border-radius:6px;background:#fff;cursor:pointer">Paste</button>' +
      '<button id="khs-fxgo" style="padding:4px 10px;border:none;border-radius:6px;background:#009FD9;color:#fff;cursor:pointer">Apply fixes</button></div><div id="khs-fxout" style="margin-top:8px;max-height:260px;overflow:auto"></div>', true);
    const ta = b.querySelector('#khs-fx'), out = b.querySelector('#khs-fxout');
    ['keydown', 'keyup', 'keypress'].forEach(ev => ta.addEventListener(ev, e => e.stopPropagation()));
    b.querySelector('#khs-x').addEventListener('click', () => { fixBusy = false; });
    b.querySelector('#khs-fxp').onclick = async () => { try { ta.value = await navigator.clipboard.readText(); } catch (e) { ta.focus(); ta.placeholder = 'Click here and press Cmd+V'; } };
    const say = (ok, label, detail) => { out.insertAdjacentHTML('beforeend', '<div style="margin:4px 0"><b style="color:' + (ok ? '#1b7a43' : '#C5221F') + '">' + (ok ? '✓ ' : '✗ ') + esc(label) + '</b>' + (detail ? '<div style="font-size:12px;color:#5B5D62">' + detail + '</div>' : '') + '</div>'); };
    b.querySelector('#khs-fxgo').onclick = async () => {
      const d = parseFix(ta.value);
      if (!d) { ta.style.borderColor = '#C5221F'; ta.value = ''; ta.placeholder = 'That is not a fix list from the dashboard. Click Send to Salesforce there first.'; return; }
      out.innerHTML = ''; b.querySelector('#khs-fxgo').disabled = true;
      try { await applyFixes(d, say); } catch (e) { say(false, 'Error', esc(e && e.message || e)); }
      fixBusy = false;
    };
    navigator.clipboard.readText().then(t => { if (parseFix(t)) ta.value = t; }).catch(() => {});
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
  GM_registerMenuCommand('Apply fixes (from the dashboard)', fixPanel);
  GM_registerMenuCommand('Set web app URL and key', setup);
  console.log('[KA HTML Snapshot] v' + VERSION + ' loaded');
})();
