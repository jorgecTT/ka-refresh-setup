// ==UserScript==
// @name         KA Write Probe (test only)
// @namespace    ka-write-probe
// @version      0.1.0
// @description  TEST ONLY. Checks whether a script can save changes to a KA DRAFT in Salesforce (needed for an "Update from Doc" button). Only works on drafts, never publishes, and puts back what it changes.
// @author       jcardona@thumbtack.com
// @match        https://thumbtack.lightning.force.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
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
    add(!!window.$A, 'Lightning internal channel', window.$A ? 'available (backup path)' : 'not visible to scripts');
    if (status !== 'Draft') {
      add(false, '2. Save to draft', 'Skipped: this is the ' + status + ' version. Click "Edit as Draft", open the draft, and run the test there.');
      return done(id, lines);
    }

    // 2. Save the same title back (no change).
    const w1 = await call('PATCH', '/records/' + id, { fields: { Title: title } });
    add(w1.ok, '2. Save to draft (no change)', w1.ok ? 'HTTP ' + w1.status + ' in ' + w1.ms + ' ms' : 'HTTP ' + w1.status + ' ' + w1.err);
    if (!w1.ok) return done(id, lines);

    // 3. Add a test line to the first content field, check, put it back, check.
    const f = withContent[0] || rich[0];
    if (!f) { add(false, '3. Content test', 'No content field found'); return done(id, lines); }
    if (!window.confirm('Step 2 worked.\n\nStep 3 adds one test line to "' + (fields[f].label || f) +
      '" in this DRAFT, checks it, and then puts the field back exactly as it was.\n\nRun step 3?')) {
      add(false, '3. Content test', 'Skipped (you said no)'); return done(id, lines);
    }
    const original = val(rec.json, f) || '';
    const w2 = await call('PATCH', '/records/' + id, { fields: { [f]: original + '<p>' + MARKER + '</p>' } });
    add(w2.ok, '3a. Add a test line', w2.ok ? 'saved' : 'HTTP ' + w2.status + ' ' + w2.err);
    if (!w2.ok) return done(id, lines);
    const r2 = await call('GET', '/records/' + id + '?optionalFields=Knowledge__kav.' + f);
    const saved = val(r2.json, f) || '';
    add(saved.indexOf(MARKER) !== -1, '3b. Check it is there', saved.indexOf(MARKER) !== -1 ? 'yes' : 'not found after saving');
    const w3 = await call('PATCH', '/records/' + id, { fields: { [f]: original } });
    const r3 = await call('GET', '/records/' + id + '?optionalFields=Knowledge__kav.' + f);
    const back = val(r3.json, f) || '';
    const restored = w3.ok && back.indexOf(MARKER) === -1;
    add(restored, '3c. Put it back', !w3.ok ? 'HTTP ' + w3.status + ' ' + w3.err + ' \u2014 delete the test line by hand'
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
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">KA Write Probe 0.1.0' + (running ? ' \u00B7 running\u2026' : '') + '</div>' +
      lines.map(l => '<div><b class="' + (l.ok ? 'ok' : 'no') + '">' + (l.ok ? '\u2713' : '\u2717') + '</b> <b>' + esc(l.label) + '</b>' +
        (l.detail ? '<div style="font-size:12px;color:#5B5D62;margin-left:16px">' + esc(l.detail) + '</div>' : '') + '</div>').join('') +
      (finished ? '<div style="margin-top:10px"><button class="kwp-b" id="kwp-copy">Copy results</button><button class="kwp-b kwp-grey" id="kwp-close">Close</button></div>' : '');
    if (finished) {
      const text = 'KA Write Probe 0.1.0 - record ' + id + '\n' + lines.map(l => (l.ok ? 'OK   ' : 'FAIL ') + l.label + (l.detail ? ' - ' + l.detail : '')).join('\n');
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
