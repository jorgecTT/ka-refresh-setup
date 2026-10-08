// ==UserScript==
// @name         KA Write Probe (test only)
// @namespace    ka-write-probe
// @version      0.2.0
// @description  TEST ONLY. Checks whether a script can save changes to a KA DRAFT in Salesforce (needed for an "Update from Doc" button). Only works on drafts, never publishes, and puts back what it changes.
// @author       jcardona@thumbtack.com
// @match        https://thumbtack.lightning.force.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/*
 * 0.2.0: the UI API answered 401 for writes (reads only). Now it also tries
 *   A. Lightning's own save channel (Aura "updateRecord"), the same call the
 *      page makes when you click Save.
 *   B. The edit form: with the draft open in Edit, it puts a test line in the
 *      KB Content box WITHOUT saving (you click Cancel afterwards).
 *
 * Open a KA, click "Edit as Draft" so you are on the DRAFT version, then click
 * the "Test write" button (top left). It runs:
 *   1. Read the article's fields (which ones hold the content, is it a draft).
 *   2. Save the SAME title back to the draft (changes nothing, tests access).
 *   3. Only if 2 worked and you say OK: add one test line to the first content
 *      field, check it is there, then put the field back as it was and check.
 * It stops at step 1 on a published article: published versions are never
 * touched. Nothing is ever published. Use a test KA (e.g. MTS Test Article).
 * Results can be copied with "Copy results".
 */

(function () {
  'use strict';

  const API = '/services/data/v59.0/ui-api';
  const KA_URL_PATTERN = /\/lightning\/r\/Knowledge__kav\/([a-zA-Z0-9]{15,18})/;
  const MARKER = 'KA write probe test line - safe to delete';

  function recordId() {
    const m = location.href.match(KA_URL_PATTERN);
    return m ? m[1] : '';
  }

  async function call(method, path, body) {
    const t0 = Date.now();
    let status = 0, text = '';
    try {
      const resp = await fetch(API + path, {
        method, credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      status = resp.status;
      text = await resp.text();
    } catch (e) { text = String(e && e.message || e); }
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    const err = !json ? (text || '').slice(0, 160)
      : Array.isArray(json) ? json.map(x => (x.errorCode || '') + ' ' + (x.message || '')).join('; ').slice(0, 240)
      : (json.message || (json.output && JSON.stringify(json.output.errors || json.output.fieldErrors || '')) || '').slice(0, 240);
    return { ok: status >= 200 && status < 300, status, json, err, ms: Date.now() - t0 };
  }

  const val = (rec, f) => (rec && rec.fields && rec.fields[f] && rec.fields[f].value != null) ? rec.fields[f].value : null;

  // --- Lightning's own channel (Aura) ---
  function auraToken(A) {
    const cs = A && A.clientService;
    const c = [cs && cs._token, cs && cs.token, cs && typeof cs.getToken === 'function' ? cs.getToken() : null];
    for (const x of c) if (x) return x;
    return null;
  }
  async function auraUpdate(id, fields) {
    const A = unsafeWindow.$A;
    if (!A) return { ok: false, err: 'Lightning framework ($A) not found on the page' };
    const token = auraToken(A);
    if (!token) return { ok: false, err: 'Could not get the page session token' };
    let context;
    try { context = A.getContext().encodeForServer(); } catch (e) { return { ok: false, err: 'No page context: ' + e.message }; }
    const message = { actions: [{
      id: '1;a', descriptor: 'aura://RecordUiController/ACTION$updateRecord', callingDescriptor: 'UNKNOWN',
      params: { recordId: id, recordInput: { allowSaveOnDuplicate: false, apiName: 'Knowledge__kav', fields: Object.assign({ Id: id }, fields) }, clientOptions: {} },
    }] };
    const body = new URLSearchParams({
      message: JSON.stringify(message),
      'aura.context': typeof context === 'string' ? context : JSON.stringify(context),
      'aura.pageURI': location.pathname + location.search,
      'aura.token': token,
    });
    try {
      const resp = await fetch('/aura?r=1&aura.RecordUi.updateRecord=1', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: body.toString(),
      });
      const text = (await resp.text()).replace(/^while\(1\);\s*/, '');
      if (!resp.ok) return { ok: false, err: 'HTTP ' + resp.status };
      let json; try { json = JSON.parse(text); } catch (e) { return { ok: false, err: 'Answer is not JSON' }; }
      const a = (json.actions || [])[0] || {};
      if (a.state === 'SUCCESS') return { ok: true };
      const e = (a.error || [])[0] || {};
      const msg = e.message || (e.event && e.event.attributes && JSON.stringify(e.event.attributes.values).slice(0, 200)) ||
        (e.data && JSON.stringify(e.data).slice(0, 240)) || '';
      return { ok: false, err: (a.state || 'no state') + (msg ? ' - ' + msg : '') };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  }

  // --- The edit form: rich text boxes (lightning-input-rich-text) ---
  function deepAll(root, sel, out) {
    out = out || [];
    root.querySelectorAll(sel).forEach(el => out.push(el));
    root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) deepAll(el.shadowRoot, sel, out); });
    return out;
  }
  function richBoxes() {
    return deepAll(document, 'lightning-input-rich-text').filter(el => el.getBoundingClientRect().height > 0)
      .map(el => ({ el, label: (el.label || el.getAttribute('label') || (el.closest && el.closest('[data-target-selection-name]') && el.closest('[data-target-selection-name]').getAttribute('data-target-selection-name')) || '').toString() }));
  }
  async function formTest(add) {
    const boxes = richBoxes();
    if (!boxes.length) {
      add(false, 'B. Edit form', 'No edit form open. To test this: on the draft click Edit (pencil), then click Test write again.');
      return;
    }
    add(true, 'B. Edit form found', boxes.length + ' content boxes: ' + boxes.map(b => b.label || '(no label)').join(', '));
    const kb = boxes.find(b => /KB.?Content/i.test(b.label)) || boxes[0];
    if (!window.confirm('B. Put a test line in the "' + (kb.label || 'first') + '" box of the open edit form?\n\nIt does NOT save. After the test, click Cancel on the form.')) {
      add(false, 'B. Fill the form', 'Skipped (you said no)'); return;
    }
    try {
      const before = kb.el.value || '';
      kb.el.value = before + '<p>' + MARKER + '</p>';
      kb.el.dispatchEvent(new CustomEvent('change', { bubbles: true, composed: true, detail: { value: kb.el.value } }));
      await sleep(800);
      const shown = deepAll(kb.el.shadowRoot || kb.el, '[contenteditable="true"]').map(x => x.innerText).join(' ');
      add(shown.indexOf(MARKER) !== -1, 'B. Fill the form', shown.indexOf(MARKER) !== -1
        ? 'The test line shows in the box. Now click Cancel on the form (nothing was saved).'
        : 'Value set but the box did not show it (' + (kb.el.value || '').length + ' chars). Click Cancel on the form.');
    } catch (e) { add(false, 'B. Fill the form', String(e && e.message || e)); }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function runProbe() {
    const id = recordId();
    const lines = [];
    const add = (ok, label, detail) => { lines.push({ ok, label, detail: detail || '' }); render(id, lines, false); };
    if (!id) { add(false, 'Open a Knowledge article first', ''); return; }
    render(id, lines, true);

    // 1. Which fields hold content (rich text), and is this a draft?
    const info = await call('GET', '/object-info/Knowledge__kav');
    if (!info.ok) { add(false, '1. Read the article fields', 'HTTP ' + info.status + ' ' + info.err); return done(id, lines); }
    const fields = info.json.fields || {};
    const rich = Object.keys(fields).filter(k => fields[k].dataType === 'TextArea' && fields[k].htmlFormatted && fields[k].updateable);
    const want = ['Title', 'PublishStatus', 'VersionNumber', 'ArticleNumber'].concat(rich).map(f => 'Knowledge__kav.' + f);
    const rec = await call('GET', '/records/' + id + '?optionalFields=' + encodeURIComponent(want.join(',')));
    if (!rec.ok) { add(false, '1. Read the article', 'HTTP ' + rec.status + ' ' + rec.err); return done(id, lines); }
    const status = val(rec.json, 'PublishStatus'), title = val(rec.json, 'Title');
    const withContent = rich.filter(f => (val(rec.json, f) || '').length > 0);
    add(true, '1. Read the article', 'status: ' + status + ' \u00B7 version ' + val(rec.json, 'VersionNumber') +
      ' \u00B7 content fields: ' + rich.map(f => (fields[f].label || f) + ' (' + (val(rec.json, f) || '').length + ')').join(', '));
    if (status !== 'Draft') {
      add(false, '2. Save to draft', 'Skipped: this is the ' + status + ' version. Click "Edit as Draft", open the draft, and run the test there.');
      return done(id, lines);
    }
    // B first when an edit form is open (it never saves).
    if (richBoxes().length) { await formTest(add); return done(id, lines); }

    // 2. Save the same title back (no change).
    const w1 = await call('PATCH', '/records/' + id, { fields: { Title: title } });
    add(w1.ok, '2. Save to draft (no change), UI API', w1.ok ? 'HTTP ' + w1.status + ' in ' + w1.ms + ' ms' : 'HTTP ' + w1.status + ' ' + w1.err);
    let save = w1.ok ? (flds) => call('PATCH', '/records/' + id, { fields: flds }) : null;
    if (!w1.ok) {
      const a1 = await auraUpdate(id, { Title: title });
      add(a1.ok, 'A. Save to draft (no change), Lightning channel', a1.ok ? 'worked' : a1.err);
      if (a1.ok) save = (flds) => auraUpdate(id, flds);
    }
    if (!save) {
      add(false, 'B. Edit form', 'Next: on this draft click Edit (pencil), then click Test write again to test filling the form.');
      return done(id, lines);
    }

    // 3. Add a test line to the first content field, check, put it back, check.
    const f = withContent[0] || rich[0];
    if (!f) { add(false, '3. Content test', 'No content field found'); return done(id, lines); }
    if (!window.confirm('Step 2 worked.\n\nStep 3 adds one test line to "' + (fields[f].label || f) +
      '" in this DRAFT, checks it, and then puts the field back exactly as it was.\n\nRun step 3?')) {
      add(false, '3. Content test', 'Skipped (you said no)'); return done(id, lines);
    }
    const original = val(rec.json, f) || '';
    const w2 = await save({ [f]: original + '<p>' + MARKER + '</p>' });
    add(w2.ok, '3a. Add a test line', w2.ok ? 'saved' : (w2.status ? 'HTTP ' + w2.status + ' ' : '') + w2.err);
    if (!w2.ok) return done(id, lines);
    const r2 = await call('GET', '/records/' + id + '?optionalFields=Knowledge__kav.' + f);
    const saved = val(r2.json, f) || '';
    add(saved.indexOf(MARKER) !== -1, '3b. Check it is there', saved.indexOf(MARKER) !== -1 ? 'yes' : 'not found after saving');
    const w3 = await save({ [f]: original });
    const r3 = await call('GET', '/records/' + id + '?optionalFields=Knowledge__kav.' + f);
    const back = val(r3.json, f) || '';
    const restored = w3.ok && back.indexOf(MARKER) === -1;
    add(restored, '3c. Put it back', !w3.ok ? (w3.status ? 'HTTP ' + w3.status + ' ' : '') + w3.err + ' \u2014 delete the test line by hand'
      : back === original ? 'exactly as before' : 'test line removed (Salesforce reformatted ' + Math.abs(back.length - original.length) + ' characters)');
    done(id, lines);
  }

  function done(id, lines) { render(id, lines, false, true); }

  // --- UI (top-left, clear of Salesforce's bottom bar and the KA Refresh buttons) ---
  GM_addStyle(`
    #kwp-btn { position: fixed; top: 110px; left: 20px; z-index: 2147483647; padding: 10px 16px;
      font: 600 13px -apple-system, sans-serif; background: #0E7490; color: #fff; border: none;
      border-radius: 100px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
    #kwp-box { position: fixed; top: 156px; left: 20px; z-index: 2147483647; width: 380px;
      background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.16);
      padding: 14px 16px; font: 13px/1.5 -apple-system, sans-serif; color: #2F3033; }
    #kwp-box .ok { color: #1E8E3E; } #kwp-box .no { color: #C5221F; }
    .kwp-b { padding: 6px 12px; font-size: 12px; font-weight: 600; border: none; border-radius: 100px;
      background: #0E7490; color: #fff; cursor: pointer; margin-right: 6px; }
    .kwp-grey { background: #8A8D91; }
  `);

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render(id, lines, running, finished) {
    let box = document.getElementById('kwp-box');
    if (!box) { box = document.createElement('div'); box.id = 'kwp-box'; document.body.appendChild(box); }
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">KA Write Probe 0.2.0' + (running ? ' \u00B7 running\u2026' : '') + '</div>' +
      lines.map(l => '<div><b class="' + (l.ok ? 'ok' : 'no') + '">' + (l.ok ? '\u2713' : '\u2717') + '</b> <b>' + esc(l.label) + '</b>' +
        (l.detail ? '<div style="font-size:12px;color:#5B5D62;margin-left:16px">' + esc(l.detail) + '</div>' : '') + '</div>').join('') +
      (finished ? '<div style="margin-top:10px"><button class="kwp-b" id="kwp-copy">Copy results</button><button class="kwp-b kwp-grey" id="kwp-close">Close</button></div>' : '');
    if (finished) {
      const text = 'KA Write Probe 0.2.0 - record ' + id + '\n' + lines.map(l => (l.ok ? 'OK   ' : 'FAIL ') + l.label + (l.detail ? ' - ' + l.detail : '')).join('\n');
      document.getElementById('kwp-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(text); document.getElementById('kwp-copy').textContent = 'Copied \u2713'; }
        catch (e) { window.prompt('Copy this:', text); }
      };
      document.getElementById('kwp-close').onclick = () => box.remove();
    }
  }

  function injectButton() {
    if (!KA_URL_PATTERN.test(location.href)) { const b = document.getElementById('kwp-btn'); if (b) b.remove(); return; }
    if (document.getElementById('kwp-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'kwp-btn';
    btn.textContent = '\u270E Test write';
    btn.onclick = runProbe;
    document.body.appendChild(btn);
  }

  GM_registerMenuCommand('Run KA write test', runProbe);
  setTimeout(injectButton, 1500);
  let _href = location.href;
  setInterval(() => { if (location.href !== _href) { _href = location.href; setTimeout(injectButton, 1200); } }, 1000);
})();
