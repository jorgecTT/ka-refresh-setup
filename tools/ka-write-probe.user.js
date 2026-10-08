// ==UserScript==
// @name         KA Write Probe (test only)
// @namespace    ka-write-probe
// @version      0.3.0
// @description  TEST ONLY. Checks whether a script can save changes to a KA DRAFT in Salesforce (needed for an "Update from Doc" button). Only works on drafts, never publishes, and puts back what it changes.
// @author       jcardona@thumbtack.com
// @match        https://thumbtack.lightning.force.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * 0.3.0: Salesforce does not let scripts save (the UI API is read-only with
 * the browser session, and we do not use the page's private session token).
 * So the plan is: the script FILLS the edit form and the writer clicks Save.
 * This probe finds the content boxes of the open edit form (or the "Source
 * Code" dialog) and types one test line at the end of one box, the same way
 * a person would. It never saves: click Cancel afterwards.
 *
 * Use: open a DRAFT test KA, click Edit (pencil), optionally open the Source
 * Code dialog of KB Content, then click "Test write" (top left).
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

  // --- The edit form: find the content boxes, whatever editor draws them ---
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
  function editors() {
    const out = [];
    const dialogOpen = deepAll(document, 'h1, h2, .slds-modal__title').some(h => /source code/i.test(h.innerText || '') && shown(h));
    deepAll(document, '.CodeMirror, .cm-editor, .ace_editor, .monaco-editor').filter(shown)
      .forEach(el => out.push({ kind: 'code editor', el, label: dialogOpen ? 'Source Code dialog' : labelOf(el), code: true }));
    deepAll(document, 'textarea').filter(shown)
      .forEach(el => out.push({ kind: 'textarea', el, label: dialogOpen ? 'Source Code dialog' : labelOf(el), code: dialogOpen }));
    deepAll(document, '[contenteditable="true"]').filter(shown)
      .forEach(el => out.push({ kind: 'rich text box', el, label: labelOf(el) }));
    deepAll(document, 'iframe').filter(shown).forEach(f => {
      try {
        const d = f.contentDocument, body = d && d.body;
        if (body && (body.isContentEditable || d.designMode === 'on')) out.push({ kind: 'rich text box (frame)', el: body, frame: f, label: labelOf(f) });
      } catch (e) { /* other domain */ }
    });
    return out;
  }
  function textOf(e) { return e.kind === 'textarea' ? (e.el.value || '') : (e.el.innerText || ''); }

  async function formTest(add) {
    const eds = editors();
    if (!eds.length) {
      add(false, '2. Edit form', 'No content box on screen. Click Edit (pencil) on the draft, wait for the content boxes, then click Test write again.');
      return;
    }
    add(true, '2. Content boxes found', eds.map(e => e.kind + ' "' + (e.label || 'no label') + '" (' + textOf(e).length + ' chars)').join(' | '));
    const target = eds.find(e => e.code) || eds.find(e => /KB.?Content/i.test(e.label)) ||
      eds.slice().sort((x, y) => textOf(y).length - textOf(x).length)[0];
    if (!window.confirm('3. Type a test line at the end of: ' + target.kind + ' "' + (target.label || 'no label') + '"?\n\n' +
      'It does NOT save. After the test, click Cancel (on the dialog and on the form).')) {
      add(false, '3. Fill a box', 'Skipped (you said no)'); return;
    }
    const line = target.code ? '<p>' + MARKER + '</p>' : MARKER;
    let how = '';
    try {
      const doc = target.frame ? target.frame.contentDocument : document;
      const el = target.el;
      const focusEl = target.kind === 'code editor' ? (el.querySelector('textarea, .cm-content, [contenteditable="true"]') || el) : el;
      focusEl.focus();
      if (target.kind === 'textarea') {
        el.selectionStart = el.selectionEnd = el.value.length;
      } else {
        const sel = (doc.defaultView || window).getSelection(), range = doc.createRange();
        range.selectNodeContents(target.kind === 'code editor' ? (el.querySelector('.CodeMirror-code, .cm-content') || el) : el);
        range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
      }
      // Same as typing: the editor sees normal input, so it keeps its own copy in sync.
      if (doc.execCommand('insertText', false, '\n' + line)) how = 'typed';
      else if (target.kind === 'textarea') { el.value += '\n' + line; el.dispatchEvent(new Event('input', { bubbles: true })); how = 'set value + input event'; }
      else how = 'typing was refused';
    } catch (e) { how = 'error: ' + (e && e.message || e); }
    await sleep(600);
    const ok = textOf(target).indexOf(MARKER) !== -1;
    add(ok, '3. Fill a box', (ok ? 'The test line shows in the box (' + how + ').' : 'The line did not show (' + how + ').') +
      ' Now click Cancel so nothing is saved.');
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
    await formTest(add);
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
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">KA Write Probe 0.3.0' + (running ? ' \u00B7 running\u2026' : '') + '</div>' +
      lines.map(l => '<div><b class="' + (l.ok ? 'ok' : 'no') + '">' + (l.ok ? '\u2713' : '\u2717') + '</b> <b>' + esc(l.label) + '</b>' +
        (l.detail ? '<div style="font-size:12px;color:#5B5D62;margin-left:16px">' + esc(l.detail) + '</div>' : '') + '</div>').join('') +
      (finished ? '<div style="margin-top:10px"><button class="kwp-b" id="kwp-copy">Copy results</button><button class="kwp-b kwp-grey" id="kwp-close">Close</button></div>' : '');
    if (finished) {
      const text = 'KA Write Probe 0.3.0 - record ' + id + '\n' + lines.map(l => (l.ok ? 'OK   ' : 'FAIL ') + l.label + (l.detail ? ' - ' + l.detail : '')).join('\n');
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
