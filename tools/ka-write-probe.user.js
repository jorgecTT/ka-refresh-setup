// ==UserScript==
// @name         KA Write Probe (test only)
// @namespace    ka-write-probe
// @version      0.8.1
// @description  TEST ONLY. Checks whether a script can save changes to a KA DRAFT in Salesforce (needed for an "Update from Doc" button). Only works on drafts, never publishes, and puts back what it changes.
// @author       jcardona@thumbtack.com
// @match        https://thumbtack.lightning.force.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      docs.google.com
// @connect      googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

/*
 * 0.8.1: a menu in the box replaces the OK/Cancel pop-ups.
 * 0.8.0: DEMO. "Build the demo article" fills this test draft with a realistic
 *   KA (from tools/demo/build_demo.py). "Update from Doc" reads a Google Doc
 *   (a copy of the article with red strikethrough = delete, green = add),
 *   checks that the Doc without the changes matches the KB Content box 100%,
 *   then applies the changes in the box (inline text, new bullets/steps/
 *   paragraphs, removed ones, links, new images pasted like a writer) and
 *   checks the result. It never saves: the writer reviews and clicks Save.
 * 0.7.0: IMAGE test. Embedded (data:) images are removed on save, but a
 *   picture a writer pastes or drops is uploaded by the editor. The probe makes
 *   a test PNG and pastes it (then drops it, if paste does nothing) under a
 *   test heading in KB Content; after Save it checks the image is a Salesforce
 *   file.
 * 0.6.0: FIGMA test, the documented way (Field Enablement guide "iFrames in
 *   Salesforce"): the Figma EMBED link goes in Multimedia and an iframe to
 *   Salesforce's own KnowledgeIFrame page, with the draft's record id, goes
 *   in Media. A direct figma.com iframe is removed on save.
 * 0.5.2: the hard block starts with the Pro App Simulator Figma prototype
 *   (already linked from a published KA) as an embed and as a button link.
 * 0.5.0: STRESS test. Reads the GTM KAs of the last audit straight from
 *   Salesforce and fills all 5 boxes to ~90% of their limit with them, plus a
 *   hard block (big and nested tables, 6-level lists, nested dropdowns, code,
 *   emoji, mailto/tel, and things Salesforce probably blocks: script, CSS
 *   animation, marquee, SVG, video, iframe, buttons). After Save, run it on
 *   the article to see sizes, how many KAs came through and what was blocked.
 * 0.4.0: with the edit form open it can fill ALL content boxes with a full
 *   sample draft (TOC, anchors, H1-H3, colors, lists, tables, dropdowns,
 *   images). After you Save, run it again on the article to see which
 *   formats Salesforce kept and which it dropped.
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

  // --- 0.4.0: a full sample draft in every box, then a check of what Salesforce kept ---
  const SAMPLE_TAG = 'KA probe sample';
  const IMG_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/120px-PNG_transparency_demonstration_1.png';
  const IMG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const SAMPLES = {
    'KB Content':
      '<p><em>' + SAMPLE_TAG + ' - KB Content</em></p>' +
      '<details><summary>Contents</summary><ol>' +
        '<li><a href="#sec-overview">Overview</a><ol><li><a href="#sec-updates">Updates</a></li></ol></li>' +
        '<li><a href="#sec-steps">Steps</a></li><li><a href="#sec-table">Table</a></li></ol></details>' +
      '<h1 id="sec-overview">1. Overview (H1)</h1>' +
      '<p>Normal text with <strong>bold</strong>, <em>italic</em>, <u>underline</u>, <s>strikethrough</s>, ' +
        '<span style="color:#009fd9">blue text</span>, <span style="color:#c0392b">red text</span>, ' +
        '<span style="background-color:#fff3b0">highlight</span> and a <a href="https://help.thumbtack.com/" target="_blank">link to the Help Center</a>.</p>' +
      '<h2 id="sec-updates">a. Updates (H2)</h2>' +
      '<h3>i. Detail (H3)</h3>' +
      '<ul><li>Bullet one<ul><li>Bullet inside<ul><li>Third level</li></ul></li></ul></li><li>Bullet two</li></ul>' +
      '<h2 id="sec-steps">b. Steps (H2)</h2>' +
      '<ol><li>Step one<ol style="list-style-type:lower-alpha"><li>Sub step a</li><li>Sub step b</li></ol></li><li>Step two</li><li>Step three</li></ol>' +
      '<details><summary>Dropdown: click to open</summary><p>Hidden text inside the dropdown, with a <a href="#sec-overview">link back to Overview</a>.</p></details>' +
      '<h2 id="sec-table">c. Table (H2)</h2>' +
      '<table border="1" style="border-collapse:collapse;width:100%"><thead><tr><th>Header A</th><th>Header B</th><th>Header C</th></tr></thead>' +
        '<tbody><tr><td>1</td><td style="background-color:#e5f6fc">2 (colored cell)</td><td>3</td></tr><tr><td colspan="2">Merged cells</td><td>6</td></tr></tbody></table>' +
      '<blockquote>A quote block.</blockquote><hr>' +
      '<p>Image from a link:</p><p><img src="' + IMG_URL + '" alt="sample image" width="120"></p>' +
      '<p>Image inside the page:</p><p><img src="' + IMG_DATA + '" alt="inline image" width="32"></p>',
    'Related Content':
      '<p><em>' + SAMPLE_TAG + ' - Related Content</em></p>' +
      '<details><summary>Contents</summary><ul><li><a href="#rel-links">Related links</a></li></ul></details>' +
      '<h2 id="rel-links">Related links</h2><ul><li><a href="https://help.thumbtack.com/">Help Center</a></li>' +
      '<li><a href="https://thumbtack.lightning.force.com/articles/Knowledge/Pro-reports">Pro reports (KA)</a></li></ul>',
    'MC Content':
      '<p><em>' + SAMPLE_TAG + ' - MC Content</em></p><h2>Table</h2>' +
      '<table border="1"><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>$10</td></tr><tr><td>Plus</td><td>$20</td></tr></table>',
    'Additional Content':
      '<p><em>' + SAMPLE_TAG + ' - Additional Content</em></p>' +
      '<details><summary>Dropdown one</summary><ul><li>Inside one</li></ul></details>' +
      '<details><summary>Dropdown two</summary><ol><li>Inside two</li></ol></details>',
    'Support Content':
      '<p><em>' + SAMPLE_TAG + ' - Support Content</em></p>' +
      '<p><span style="color:#009fd9"><strong>Blue bold</strong></span> and <span style="font-size:18px">bigger text</span></p>' +
      '<p><img src="' + IMG_URL + '" alt="sample image" width="120"></p>',
  };

  // What to look for in each saved field.
  const CHECKS = [
    ['H1', 'h1'], ['H2', 'h2'], ['H3', 'h3'], ['Bold', 'strong, b'], ['Italic', 'em, i'],
    ['Underline', 'u, span[style*="underline"]'], ['Strikethrough', 's, del, strike, span[style*="line-through"]'],
    ['Text color', '[style*="color:#009fd9"], [style*="color: #009fd9"], [style*="rgb(0, 159, 217)"]'],
    ['Highlight', '[style*="background"]'], ['Link to a website', 'a[href^="http"]'],
    ['Dropdowns (TOC and others)', 'details > summary'], ['TOC links to sections', 'a[href^="#"]'],
    ['Section anchors', '[id^="sec-"], [id^="rel-"], a[name^="sec-"], a[name^="rel-"]'],
    ['Bullets', 'ul > li'], ['Bullets inside bullets', 'ul ul'], ['Numbered list', 'ol > li'], ['Numbered inside numbered', 'ol ol'],
    ['Table', 'table'], ['Table header', 'th'], ['Merged cells', '[colspan]'], ['Quote', 'blockquote'], ['Line', 'hr'],
    ['Image from a link', 'img[src^="http"]'], ['Image inside the page', 'img[src^="data:"]'],
  ];
  // Salesforce can hand the field back with its tags written as text (&lt;h1&gt;).
  function asHtml(html) {
    html = html || '';
    if (!/<[a-z]/i.test(html) && /&lt;[a-z]/i.test(html)) {
      const t = document.createElement('textarea'); t.innerHTML = html; html = t.value;
    }
    return html;
  }
  function featuresOf(html) {
    html = asHtml(html);
    const d = new DOMParser().parseFromString('<body>' + (html || '') + '</body>', 'text/html');
    const has = {};
    CHECKS.forEach(([name, sel]) => { try { has[name] = d.querySelectorAll(sel).length; } catch (e) { has[name] = 0; } });
    return has;
  }

  function uniqueFrames() {
    const seen = new Set();
    return editors().filter(e => e.frame && !seen.has(e.el) && seen.add(e.el));
  }

  async function fillSample(add) {
    const boxes = uniqueFrames();
    if (!boxes.length) { add(false, 'Fill sample', 'No content boxes on screen. Click Edit (pencil) first.'); return; }
    if (!window.confirm('Replace what is in ALL ' + boxes.length + ' content boxes with the sample draft?\n\nIt does NOT save. ' +
      'Look at it, then click Save (this is your test KA) and click Test write again to check what Salesforce kept.')) {
      add(false, 'Fill sample', 'Skipped (you said no)'); return;
    }
    const done = new Set();
    for (const b of boxes) {
      const key = Object.keys(SAMPLES).find(k => new RegExp('^' + k.replace(/ /g, '.?') + '$', 'i').test(b.label));
      if (!key || done.has(key)) continue;
      done.add(key);
      try {
        const doc = b.frame.contentDocument;
        b.el.focus();
        doc.execCommand('selectAll', false, null);
        const ok = doc.execCommand('insertHTML', false, SAMPLES[key]);
        await sleep(300);
        const there = (b.el.innerText || '').indexOf(SAMPLE_TAG) !== -1;
        add(there, 'Fill ' + key, there ? 'filled' + (ok ? '' : ' (insertHTML said no, but the text is there)') : 'did not take');
      } catch (e) { add(false, 'Fill ' + key, String(e && e.message || e)); }
    }
    const missing = Object.keys(SAMPLES).filter(k => !done.has(k));
    if (missing.length) add(false, 'Boxes not found', missing.join(', '));
    add(true, 'Next', 'Scroll through the boxes, then click Save. After it saves, click Test write again to see what Salesforce kept.');
  }

  function checkSaved(add, rec, fields, rich) {
    let any = false;
    rich.forEach(f => {
      const label = fields[f].label || f;
      const html = val(rec.json, f) || '';
      if (html.indexOf(SAMPLE_TAG) === -1) return;
      any = true;
      const sent = featuresOf(SAMPLES[label] || ''), kept = featuresOf(html);
      const lost = Object.keys(sent).filter(k => sent[k] > 0 && !(kept[k] > 0));
      const ok = Object.keys(sent).filter(k => sent[k] > 0 && kept[k] > 0);
      const start = html.slice(0, 90).replace(/\s+/g, ' ');
      add(!lost.length, 'Saved: ' + label, (ok.length ? 'kept: ' + ok.join(', ') : '') + (lost.length ? (ok.length ? ' | ' : '') + 'LOST: ' + lost.join(', ') : '') +
        ' (' + html.length + ' chars' + (asHtml(html) !== html ? ', tags came back as text' : '') + ') starts: ' + start);
    });
    return any;
  }

  // --- 0.5.0: STRESS test. Real GTM KAs from Salesforce + a hard block, every box filled near its limit ---
  const STRESS_TAG = 'KA stress test';
  const SHEET_ID = '16X-I4oT-W96XTwx1qs7ErqTAT6sJI7du3_vnYFp9MIo';
  const FILL = 0.9;   // leave room: the editor adds a little when it saves
  const LIMIT_FALLBACK = 131072;
  const SENT_KEY = 'kwp_stress_sent';

  function parseCsv(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  // GTM KAs (record ids) from the last audit (ka_audit tab).
  function gtmFromAudit() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&sheet=ka_audit',
        onload(resp) {
          const t = resp.responseText || '';
          if (t.slice(0, 9) === '<!DOCTYPE') { reject(new Error('No access to the corpus sheet (sign into Google)')); return; }
          const rows = parseCsv(t), h = (rows.shift() || []).map(x => x.trim());
          const c = n => h.indexOf(n);
          resolve(rows.filter(r => (r[c('equipo')] || '').trim() === 'GTM').map(r => ({
            title: (r[c('t\u00EDtulo')] || '').trim(),
            id: (((r[c('Salesforce')] || '').match(/\/(ka[0-9A-Za-z]{13,16})\//)) || [])[1] || '',
          })).filter(x => x.id));
        },
        onerror() { reject(new Error('Network error reading the corpus sheet')); },
      });
    });
  }

  // The hard block: everything a KA could carry, and things Salesforce probably blocks.
  const FIGMA_PROTO = 'https://www.figma.com/proto/wJzer6HhDQ8a2tJ0tOAPNE/Thumbtack-Pro-App---Simulator?page-id=0:1&node-id=11-2&starting-point-node-id=1:3';
  const figmaBlock = () => '<h2>Figma prototype (Pro App Simulator)</h2>' +
    '<p><iframe style="border:1px solid rgba(0,0,0,0.1)" width="800" height="450" allowfullscreen ' +
      'src="https://www.figma.com/embed?embed_host=share&amp;url=' + encodeURIComponent(FIGMA_PROTO) + '"></iframe></p>' +
    '<p><a href="' + FIGMA_PROTO.replace(/&/g, '&amp;') + '" target="_blank" rel="noopener" style="display:inline-block;background-color:#009fd9;color:#ffffff;padding:6px 12px;border-radius:4px;text-decoration:none">' +
      '\u25B6 Open the prototype in Figma</a></p>';
  function hardBlock(p) {
    const rows = [];
    for (let r = 1; r <= 25; r++) {
      rows.push('<tr>' + [1, 2, 3, 4, 5, 6, 7, 8].map(c => '<td style="border:1px solid #ccc;padding:2px 4px' +
        (r % 2 ? ';background-color:#f5f7f9' : '') + '">R' + r + 'C' + c + (c === 8 ? ' $' + (r * 12.5).toFixed(2) : '') + '</td>').join('') + '</tr>');
    }
    let nested = 'Level 6';
    for (let i = 5; i >= 1; i--) nested = 'Level ' + i + '<ul><li>' + nested + '</li></ul>';
    let nestedOl = 'Step 6';
    for (let i = 5; i >= 1; i--) nestedOl = 'Step ' + i + '<ol><li>' + nestedOl + '</li></ol>';
    return '' +
      '<h1 id="' + p + '-hard">' + STRESS_TAG + ': hard block (' + p + ')</h1>' + figmaBlock() +
      '<p style="font-family:Georgia,serif;font-size:14pt">Georgia 14pt. <span style="font-family:Courier New,monospace">Courier.</span> ' +
        '<span style="color:#ffffff;background-color:#2f3033">White on dark.</span> <sup>superscript</sup> H<sub>2</sub>O E=mc<sup>2</sup> ' +
        '\u00E1\u00E9\u00ED\u00F3\u00FA \u00F1 \u00E7\u00E3\u00F5 \u00BF\u00A1 \u20AC \u00A9 \u2122 \uD83D\uDC4D \uD83D\uDE80 \u2705</p>' +
      '<p><a href="mailto:support@thumbtack.com">mailto link</a> \u00B7 <a href="tel:+18005550100">tel link</a> \u00B7 ' +
        '<a href="https://www.thumbtack.com/" target="_blank" rel="noopener">new tab link</a> \u00B7 <a href="#' + p + '-big">jump to the big table</a></p>' +
      '<h2 id="' + p + '-big">Big table (25 x 8, striped)</h2>' +
      '<table style="border-collapse:collapse;width:100%"><thead><tr>' + [1, 2, 3, 4, 5, 6, 7, 8].map(c => '<th style="background-color:#009fd9;color:#fff">Col ' + c + '</th>').join('') +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table>' +
      '<h2>Table inside a table</h2><table border="1"><tr><td>Outer A</td><td><table border="1"><tr><th>Inner 1</th><th>Inner 2</th></tr>' +
        '<tr><td rowspan="2">rowspan</td><td>x</td></tr><tr><td>y</td></tr></table></td></tr></table>' +
      '<h2>Lists 6 levels deep</h2><ul><li>' + nested + '</li></ul><ol><li>' + nestedOl + '</li></ol>' +
      '<ol style="list-style-type:upper-roman"><li>Roman I</li><li>Roman II</li></ol><ul style="list-style-type:square"><li>Square bullet</li></ul>' +
      '<h2>Dropdowns inside dropdowns</h2><details><summary>Level 1</summary><p>One</p><details><summary>Level 2</summary><p>Two</p>' +
        '<details><summary>Level 3</summary><p>Three</p></details></details></details>' +
      '<h2>Code</h2><pre><code>function hello(name) {\n  return "Hi " + name;\n}</code></pre><p>Inline <code>code()</code> and <kbd>Ctrl</kbd>+<kbd>C</kbd>.</p>' +
      '<h2>Quote and callout</h2><blockquote><p>Quote with <strong>bold</strong>.</p></blockquote>' +
        '<div style="border-left:4px solid #009fd9;background-color:#e5f6fc;padding:8px">Callout box (div with border and background)</div>' +
      '<h2>Things Salesforce probably blocks</h2>' +
        '<style>@keyframes kwpspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.kwp-spin{display:inline-block;animation:kwpspin 2s linear infinite}</style>' +
        '<p><span class="kwp-spin" style="animation:kwpspin 2s linear infinite;display:inline-block">\u2699 spinning (CSS animation)</span></p>' +
        '<p><marquee>Scrolling text (marquee)</marquee></p>' +
        '<script>console.log("KA stress test script ran")<\/script>' +
        '<p><svg width="60" height="20"><rect width="60" height="20" fill="#009fd9"></rect></svg> SVG drawing</p>' +
        '<p><video src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" controls width="200"></video> video</p>' +
        '<p><iframe width="200" height="113" src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe> embedded YouTube</p>' +
        '<p><button onclick="alert(1)">Button with onclick</button> <input type="checkbox"> checkbox</p>' +
        '<p><img src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/120px-PNG_transparency_demonstration_1.png" alt="linked image" width="60"></p>' +
      '<hr>';
  }

  async function readKa(id, rich) {
    const r = await call('GET', '/records/' + id + '?optionalFields=' + encodeURIComponent(['Title'].concat(rich).map(f => 'Knowledge__kav.' + f).join(',')));
    if (!r.ok) return null;
    const parts = rich.map(f => asHtml(val(r.json, f) || '')).filter(x => x.trim());
    return { title: val(r.json, 'Title') || '', html: parts.join('') };
  }

  async function buildStress(add, fields, rich) {
    let gtm;
    try { gtm = await gtmFromAudit(); } catch (e) { add(false, 'Stress: GTM list', e.message); return null; }
    add(gtm.length > 0, 'Stress: GTM list', gtm.length + ' GTM KAs in the last audit');
    const kas = [];
    for (const g of gtm) { const k = await readKa(g.id, rich); if (k && k.html) kas.push(k); }
    add(kas.length > 0, 'Stress: read GTM KAs from Salesforce', kas.length + ' read, ' + kas.reduce((s, k) => s + k.html.length, 0).toLocaleString() + ' chars of real content');
    if (!kas.length) return null;
    const out = {};
    let next = 0;
    rich.forEach((f, fi) => {
      const label = fields[f].label || f, limit = fields[f].length || LIMIT_FALLBACK;
      const target = Math.floor(limit * FILL), p = 'f' + fi;
      const toc = [], body = [];
      let html = hardBlock(p), n = 0, guard = 0;
      while (html.length < target && guard++ < 400) {
        const k = kas[next++ % kas.length];
        const chunk = '<h2 id="' + p + '-ka' + n + '">GTM KA ' + (n + 1) + ': ' + esc(k.title) + '</h2>' + k.html;
        if (html.length + chunk.length > target) {
          // fill the rest with short paragraphs so the box is really full
          while (html.length + 120 < target) html += '<p>' + STRESS_TAG + ' filler ' + (html.length) + ': Lorem ipsum dolor sit amet, consectetur.</p>';
          break;
        }
        toc.push('<li><a href="#' + p + '-ka' + n + '">' + esc(k.title) + '</a></li>');
        html += chunk; n++;
      }
      const head = '<p><em>' + STRESS_TAG + ' - ' + esc(label) + '</em></p><details><summary>Contents</summary><ol><li><a href="#' + p + '-hard">Hard block</a></li>' + toc.join('') + '</ol></details>';
      out[label] = { html: head + html, kas: n, limit };
    });
    return out;
  }

  async function fillStress(add, fields, rich) {
    const boxes = uniqueFrames();
    if (!boxes.length) { add(false, 'Stress', 'No content boxes on screen. Click Edit (pencil) first.'); return; }
    const plan = await buildStress(add, fields, rich);
    if (!plan) return;
    const sent = {};
    const done = new Set();
    for (const b of boxes) {
      const key = Object.keys(plan).find(k => new RegExp('^' + k.replace(/ /g, '.?') + '$', 'i').test(b.label));
      if (!key || done.has(key)) continue;
      done.add(key);
      try {
        const doc = b.frame.contentDocument;
        b.el.focus();
        doc.execCommand('selectAll', false, null);
        doc.execCommand('insertHTML', false, plan[key].html);
        await sleep(500);
        const inBox = b.el.innerHTML.length;
        sent[key] = { sent: plan[key].html.length, inBox, kas: plan[key].kas, limit: plan[key].limit, feats: featuresOfStress(plan[key].html) };
        add((b.el.innerText || '').indexOf(STRESS_TAG) !== -1, 'Stress fill ' + key,
          plan[key].html.length.toLocaleString() + ' chars sent (limit ' + plan[key].limit.toLocaleString() + '), ' + plan[key].kas +
          ' GTM KAs, ' + inBox.toLocaleString() + ' chars in the box after the editor' + (inBox > plan[key].limit ? ' \u2014 OVER the limit, Save may fail' : ''));
      } catch (e) { add(false, 'Stress fill ' + key, String(e && e.message || e)); }
    }
    try { localStorage.setItem(SENT_KEY, JSON.stringify(sent)); } catch (e) { /* ignore */ }
    add(true, 'Next', 'Look at the boxes, then click Save. If Salesforce says a field is too long, write down which one. Then click Test write again.');
  }

  const STRESS_CHECKS = [
    ['Contents + anchors', 'details > summary'], ['Big table', 'table th'], ['Table inside a table', 'table table'],
    ['Rowspan', '[rowspan]'], ['Lists 6 deep', 'ul ul ul ul ul li'], ['Numbers 6 deep', 'ol ol ol ol ol li'],
    ['Roman numbers', 'ol[style*="roman"]'], ['Dropdowns 3 deep', 'details details details'], ['Code block', 'pre'],
    ['Inline code', 'code'], ['Keyboard keys', 'kbd'], ['Superscript', 'sup'], ['Subscript', 'sub'], ['Quote', 'blockquote'],
    ['Callout box', 'div[style*="border-left"]'], ['Fonts', '[style*="Georgia"], [style*="Courier"]'],
    ['mailto link', 'a[href^="mailto:"]'], ['tel link', 'a[href^="tel:"]'], ['New tab link', 'a[target="_blank"]'],
    ['Image from a link', 'img[src^="http"]'], ['Salesforce images (from GTM KAs)', 'img[src*="rtaImage"], img[src*="force.com"], img[src*="salesforce"]'],
    ['CSS animation', 'style, [style*="animation"]'], ['Marquee', 'marquee'], ['Script', 'script'], ['SVG', 'svg'],
    ['Video', 'video'], ['YouTube iframe', 'iframe[src*="youtube"]'], ['Figma prototype iframe', 'iframe[src*="figma.com"]'], ['Figma button link', 'a[href*="figma.com/proto"]'], ['Button / checkbox', 'button, input'], ['onclick', '[onclick]'],
  ];
  function featuresOfStress(html) {
    const d = new DOMParser().parseFromString('<body>' + asHtml(html) + '</body>', 'text/html');
    const has = {};
    STRESS_CHECKS.forEach(([n, sel]) => { try { has[n] = d.querySelectorAll(sel).length; } catch (e) { has[n] = 0; } });
    has.__kas = (asHtml(html).match(/>GTM KA \d+:/g) || []).length;
    has.__emoji = /\uD83D\uDE80/.test(asHtml(html)) && /\uD83D\uDC4D/.test(asHtml(html)) ? 1 : 0;
    has.__accents = /\u00F1/.test(asHtml(html)) ? 1 : 0;
    return has;
  }
  function checkStress(add, rec, fields, rich) {
    let sent = {};
    try { sent = JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); } catch (e) { sent = {}; }
    let any = false;
    rich.forEach(f => {
      const label = fields[f].label || f, raw = val(rec.json, f) || '', html = asHtml(raw);
      if (html.indexOf(STRESS_TAG) === -1) return;
      any = true;
      const s = sent[label] || {}, kept = featuresOfStress(html), before = s.feats || featuresOfStress(html);
      const names = STRESS_CHECKS.map(c => c[0]).filter(n => before[n] > 0);
      const ok = names.filter(n => kept[n] > 0), lost = names.filter(n => !(kept[n] > 0));
      add(true, 'Saved: ' + label, html.length.toLocaleString() + ' chars stored (sent ' + (s.sent || 0).toLocaleString() + ', limit ' + (s.limit || fields[f].length || 0).toLocaleString() + ') \u00B7 GTM KAs complete: ' + kept.__kas + ' of ' + (s.kas != null ? s.kas : '?') +
        ' \u00B7 emoji ' + (kept.__emoji ? 'kept' : 'LOST') + ' \u00B7 accents ' + (kept.__accents ? 'kept' : 'LOST'));
      add(!lost.length, '   ' + label + ' formats', 'kept: ' + ok.join(', ') + (lost.length ? ' | BLOCKED/LOST: ' + lost.join(', ') : ''));
    });
    return any;
  }

  // --- 0.6.0: Figma the documented way (Nichole's guide "iFrames in Salesforce") ---
  // Multimedia = Figma EMBED link; Media = iframe to Salesforce's own KnowledgeIFrame page with the DRAFT record id.
  const FIGMA_EMBED = 'https://embed.figma.com/proto/wJzer6HhDQ8a2tJ0tOAPNE/Thumbtack-Pro-App---Simulator?page-id=0%3A1&node-id=11-2&starting-point-node-id=1%3A3&embed-host=share';
  const kiframe = id => '<p><iframe width="400" height="600" frameborder="2" scrolling="auto" src="https://thumbtack--c.vf.force.com/apex/KnowledgeIFrame?id=' + id + '"></iframe></p>';
  const FIGMA_LABELS = { multi: /^multimedia$/i, media: /^media$/i };

  function figmaFields(fields) {
    const find = re => Object.keys(fields).find(k => re.test(fields[k].label || '') || re.test(k.replace(/__c$/, '')));
    return { multi: find(FIGMA_LABELS.multi), media: find(FIGMA_LABELS.media) };
  }
  function describeField(fields, k) {
    if (!k) return 'not found';
    const f = fields[k];
    return k + ' (' + f.dataType + (f.htmlFormatted ? ', rich text' : '') + (f.length ? ', ' + f.length + ' chars' : '') + (f.updateable ? '' : ', READ-ONLY') + ')';
  }
  // A plain input (text/url) in the edit form, found by its label.
  function inputByLabel(re) {
    const clean = t => (t || '').replace(/\s+/g, ' ').replace(/^\*\s*/, '').trim();
    // 1. a label whose own text is the field name, then the closest box after it
    const labels = deepAll(document, 'label, .slds-form-element__label, span, div').filter(el =>
      el.children.length <= 2 && re.test(clean(el.innerText).replace(/\s*\(.*\)$/, '')) && shown(el));
    for (const lab of labels) {
      let cur = lab;
      for (let i = 0; i < 6 && cur; i++) {
        const box = deepAll(cur, 'textarea, input[type="text"], input[type="url"], input:not([type])').filter(shown)[0];
        if (box) return box;
        cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host);
      }
    }
    // 2. fallback: the box's own label
    return deepAll(document, 'input, textarea').filter(shown).find(el => re.test(clean(labelOf(el))));
  }
  function typeInto(el, text) {
    el.focus();
    if (el.select) el.select();
    const ok = document.execCommand('insertText', false, text);
    if (!ok || el.value !== text) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.blur();
    return el.value === text;
  }

  async function fillFigma(add, id, fields) {
    const ff = figmaFields(fields);
    add(!!ff.multi, 'Figma: Multimedia field', describeField(fields, ff.multi));
    if (ff.media) add(true, 'Figma: Media field', describeField(fields, ff.media));
    // 1. Multimedia = the Figma embed link
    const mInput = inputByLabel(/^multimedia\b/i);
    if (mInput) add(typeInto(mInput, FIGMA_EMBED), 'Figma: put the embed link in Multimedia', FIGMA_EMBED.slice(0, 70) + '\u2026');
    else add(false, 'Figma: Multimedia box', 'Not found in the edit form. Paste this into Multimedia by hand: ' + FIGMA_EMBED);
    // 2. Media = the KnowledgeIFrame iframe with THIS draft's id
    const code = kiframe(id);
    const frames = uniqueFrames();
    const mediaFrame = frames.find(e => FIGMA_LABELS.media.test(e.label || '')) || frames.find(e => /KB.?Content/i.test(e.label || ''));
    const mediaInput = mediaFrame ? null : inputByLabel(FIGMA_LABELS.media);
    if (mediaFrame) {
      const doc = mediaFrame.frame.contentDocument;
      // Insert at the very top of the box (keep what is already there).
      mediaFrame.el.focus();
      const sel = doc.defaultView.getSelection(), range = doc.createRange();
      range.setStart(mediaFrame.el, 0); range.collapse(true); sel.removeAllRanges(); sel.addRange(range);
      doc.execCommand('insertHTML', false, '<h2>Figma via KnowledgeIFrame</h2>' + code);
      await sleep(400);
      add(!!mediaFrame.el.querySelector('iframe[src*="KnowledgeIFrame"]'), 'Figma: put the iframe at the top of ' + (mediaFrame.label || 'the content box'),
        'id ' + id + '. If it is not there, use the editor: Insert > Media > Embed, and paste: ' + code);
    } else if (mediaInput) {
      add(typeInto(mediaInput, code), 'Figma: put the iframe in Media', 'text box \u00B7 id ' + id);
    } else {
      add(false, 'Figma: Media box', 'Not found in the edit form. In Media, click Embed and paste: ' + code);
    }
    add(true, 'Next', 'Click Save, open the article and look for the Pro App Simulator. Then click Test write again.');
  }

  function checkFigma(add, rec, fields, id) {
    const ff = figmaFields(fields);
    const m = ff.multi ? String(val(rec.json, ff.multi) || '') : '';
    const media = [ff.media].concat(Object.keys(fields).filter(k => fields[k].htmlFormatted)).filter(Boolean)
      .map(k => asHtml(String(val(rec.json, k) || ''))).find(h => h.indexOf('KnowledgeIFrame') !== -1) || '';
    if (m.indexOf('embed.figma.com') === -1 && media.indexOf('KnowledgeIFrame') === -1) return false;
    add(m.indexOf('embed.figma.com') !== -1, 'Saved: Multimedia', m ? m.slice(0, 90) : 'empty');
    const idOk = media.indexOf('id=' + id) !== -1;
    add(media.indexOf('KnowledgeIFrame') !== -1, 'Saved: Media', media ? (idOk ? 'iframe kept, uses this draft\'s id' : 'iframe kept, but the id is not this record\'s') : 'empty');
    const onPage = deepAll(document, 'iframe').some(f => /KnowledgeIFrame/.test(f.getAttribute('src') || ''));
    add(onPage, 'On the page', onPage ? 'The KnowledgeIFrame frame is on the page. Look at it: you should see the Pro App Simulator.' : 'No KnowledgeIFrame frame on the page yet (scroll to the Media field and run again).');
    return true;
  }

  // --- 0.7.0: IMAGE test. Paste (and if needed drop) a real image file into KB Content, like a writer would ---
  const IMG_TAG = 'KA image paste test';
  function makePng(label) {
    return new Promise(resolve => {
      const c = document.createElement('canvas'); c.width = 360; c.height = 140;
      const g = c.getContext('2d');
      g.fillStyle = '#009fd9'; g.fillRect(0, 0, 360, 140);
      g.fillStyle = '#ffffff'; g.font = 'bold 22px sans-serif'; g.fillText(IMG_TAG, 18, 52);
      g.font = '16px sans-serif'; g.fillText(label + ' \u00B7 ' + new Date().toISOString().slice(0, 16), 18, 90);
      c.toBlob(b => resolve(new File([b], 'ka-image-test-' + label + '.png', { type: 'image/png' })), 'image/png');
    });
  }
  function nearImgs(body) {
    const h = Array.from(body.querySelectorAll('h2')).find(x => (x.innerText || '').indexOf(IMG_TAG) !== -1);
    if (!h) return [];
    const out = [];
    for (let n = h.nextElementSibling, i = 0; n && i < 3; n = n.nextElementSibling, i++) {
      if (/^H[1-3]$/.test(n.tagName)) break;
      (n.tagName === 'IMG' ? [n] : Array.from(n.querySelectorAll('img'))).forEach(im => out.push(im.getAttribute('src') || ''));
    }
    return out;
  }
  const imgsIn = el => Array.from(el.querySelectorAll('img')).map(i => i.getAttribute('src') || '');
  const kindOf = src => /^data:/.test(src) ? 'embedded (data:)' : /^blob:/.test(src) ? 'blob (still uploading?)' :
    /rtaImage|servlet|file\.force\.com|content\.force\.com|\/sfc\//i.test(src) ? 'Salesforce file' : (src ? 'link: ' + src.slice(0, 50) : 'none');

  async function fillImage(add) {
    const kb = uniqueFrames().find(e => /KB.?Content/i.test(e.label || '')) || uniqueFrames()[0];
    if (!kb) { add(false, 'Image test', 'No content box on screen. Click Edit (pencil) first.'); return; }
    const doc = kb.frame.contentDocument, body = kb.el;
    // marker heading at the top, caret right after it
    body.focus();
    const sel = doc.defaultView.getSelection(); let r = doc.createRange();
    r.setStart(body, 0); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
    doc.execCommand('insertHTML', false, '<h2>' + IMG_TAG + '</h2><p id="kwp-img-here"><br></p>');
    const here = doc.getElementById('kwp-img-here') || body;
    const caret = () => { const rr = doc.createRange(); rr.selectNodeContents(here); rr.collapse(false); sel.removeAllRanges(); sel.addRange(rr); };
    const tries = [
      ['paste', async () => { const f = await makePng('paste'); const dt = new DataTransfer(); dt.items.add(f);
        caret(); body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }],
      ['drop', async () => { const f = await makePng('drop'); const dt = new DataTransfer(); dt.items.add(f);
        caret(); const rect = here.getBoundingClientRect();
        const o = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.left + 5, clientY: rect.top + 5 };
        here.dispatchEvent(new DragEvent('dragenter', o)); here.dispatchEvent(new DragEvent('dragover', o)); here.dispatchEvent(new DragEvent('drop', o)); }],
    ];
    let done = false;
    for (const [name, run] of tries) {
      try { await run(); } catch (e) { add(false, 'Image: ' + name, String(e && e.message || e)); continue; }
      let near = [];
      for (let i = 0; i < 16; i++) {
        await sleep(500);
        near = nearImgs(body);
        if (near.length && !near.some(x => /^blob:/.test(x))) break;
      }
      const got = near.length > 0;
      add(got, 'Image: ' + name, got ? 'image under the test heading: ' + near.map(kindOf).join(', ') : 'nothing appeared');
      if (got) { done = true; break; }
    }
    if (!done) add(false, 'Image: Insert dialog', 'Neither worked. Next test would be Insert > Image > Upload. Tell Claude.');
    add(true, 'Next', 'Look at the box: is the blue "' + IMG_TAG + '" picture under the heading? Click Save, then Test write again.');
  }

  function checkImage(add, rec, fields, rich) {
    const kbKey = rich.find(f => /KB.?Content/i.test(fields[f].label || '')) || rich[0];
    const html = asHtml(String(val(rec.json, kbKey) || ''));
    const at = html.indexOf(IMG_TAG);
    if (at === -1) return false;
    const after = html.slice(at, at + 3000);
    const srcs = (after.match(/<img[^>]+src="([^"]+)"/gi) || []).map(t => (t.match(/src="([^"]+)"/i) || [])[1] || '').filter(s => s.indexOf('wikimedia') === -1);
    const sf = srcs.filter(s => kindOf(s) === 'Salesforce file');
    add(sf.length > 0, 'Saved: pasted image', srcs.length ? srcs.map(kindOf).join(', ') + (sf.length ? ' \u2014 uploaded to Salesforce, it stays' : '') : 'no image under the test heading (it was removed on save)');
    if (sf[0]) add(true, 'Image address', sf[0].slice(0, 120));
    return true;
  }

  // --- 0.8.0: DEMO. (1) build a realistic test article, (2) "Update from Doc": apply a Google Doc's red/green changes ---
  // The seed is generated by tools/demo/build_demo.py (same source as the demo Doc).
  // DEMO-SEED-START
  const DEMO_TITLE = "Demo: Leads and messages quick guide (Pro)";
  const DEMO_SEED = "<p><em>Demo article for the &quot;Update from Doc&quot; test. Not real guidance.</em></p><details><summary>Contents</summary><ol><li><a href=\"#ov\">Overview</a></li><li><a href=\"#how\">How it works</a></li><li><a href=\"#price\">Lead prices</a></li><li><a href=\"#ts\">Troubleshooting</a></li><li><a href=\"#try\">Try it</a></li><li><a href=\"#res\">Resources</a></li></ol></details><h2 id=\"ov\">1. Overview</h2><h3>a. Updates</h3><ul><li>Sep 30, 2026: Added the steps for the Messages tab.</li></ul><h3>b. Key points</h3><ul><li>Pros get leads that match their services and travel area.</li><li>Reply to new leads within 24 hours to keep a strong response rate.</li><li>Leads older than 30 days are archived automatically.</li><li>Customers can message more than one pro.</li></ul><h2 id=\"how\">2. How it works</h2><ol><li>The pro opens the <strong>Jobs</strong> tab in the app.</li><li>They tap a lead to see the project details.</li><li>They send a quote or a message.</li></ol><p id=\"kwp-seed-img-jobs-old\"><br></p><h2 id=\"price\">3. Lead prices</h2><table style=\"border-collapse:collapse;width:100%\"><tbody><tr><th style=\"border:1px solid #c9c9c9;padding:4px 8px\"><strong>Lead type</strong></th><th style=\"border:1px solid #c9c9c9;padding:4px 8px\"><strong>Typical price</strong></th><th style=\"border:1px solid #c9c9c9;padding:4px 8px\"><strong>Notes</strong></th></tr><tr><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">Standard lead</td><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">$15\u2013$45</td><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">Based on category and location</td></tr><tr><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">Direct lead</td><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">$25\u2013$75</td><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">The customer chose this pro</td></tr><tr><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">Opportunity</td><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">Free</td><td style=\"border:1px solid #c9c9c9;padding:4px 8px\">Shown to new pros</td></tr></tbody></table><h2 id=\"ts\">4. Troubleshooting</h2><details><summary>The pro doesn't see new leads</summary><p>Check that their targeting is on and their budget isn't used up.</p></details><details><summary>A lead was charged twice</summary><p>Open a case for the billing team and include the lead ID.</p></details><h2 id=\"try\">5. Try it</h2><p>Use the Pro App Simulator to walk through the Jobs tab.</p><p>{{FIGMA_IFRAME}}</p><h2 id=\"res\">6. Resources</h2><ul><li><a href=\"https://help.thumbtack.com/\" target=\"_blank\">Help Center: Leads and opportunities</a></li><li><a href=\"https://thumbtack.lightning.force.com/articles/Knowledge/Pro-reports\" target=\"_blank\">KA: Pro reports</a></li></ul>";
  // DEMO-SEED-END

  async function pastePng(doc, body, target, title, sub, color) {
    const file = await new Promise(resolve => {
      const c = document.createElement('canvas'); c.width = 720; c.height = 260;
      const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 720, 260);
      g.fillStyle = '#fff'; g.font = 'bold 34px sans-serif'; g.fillText(title, 30, 100); g.font = '22px sans-serif'; g.fillText(sub, 30, 160);
      c.toBlob(b => resolve(new File([b], 'demo.png', { type: 'image/png' })), 'image/png');
    });
    return pasteFile(doc, body, target, file);
  }
  async function pasteFile(doc, body, target, file) {
    const sel = doc.defaultView.getSelection(), r = doc.createRange();
    r.selectNodeContents(target); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
    const dt = new DataTransfer(); dt.items.add(file);
    body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      const im = target.querySelector('img') || (target.nextElementSibling && target.nextElementSibling.querySelector && target.nextElementSibling.querySelector('img'));
      if (im && !/^blob:/.test(im.getAttribute('src') || '')) return true;
    }
    return false;
  }

  async function seedDemo(add, id) {
    const frames = uniqueFrames();
    const kb = frames.find(e => /KB.?Content/i.test(e.label || ''));
    if (!kb) { add(false, 'Demo', 'KB Content box not found. Click Edit first.'); return; }
    if (!window.confirm('Build the DEMO article?\n\nThis REPLACES the content of all 5 boxes of this test draft with a realistic demo KA ' +
      '(and sets the title and the Multimedia link). It does not save.')) { add(false, 'Demo', 'Skipped'); return; }
    const t = inputByLabel(/^title\b/i);
    if (t) add(typeInto(t, DEMO_TITLE), 'Demo: title', DEMO_TITLE);
    const mm = inputByLabel(/^multimedia\b/i);
    if (mm) add(typeInto(mm, FIGMA_EMBED), 'Demo: Multimedia', 'Pro App Simulator embed link');
    for (const b of frames) {
      if (b === kb) continue;
      const d = b.frame.contentDocument; b.el.focus(); d.execCommand('selectAll', false, null); d.execCommand('insertHTML', false, '<p><br></p>');
    }
    add(true, 'Demo: other boxes cleared', frames.filter(b => b !== kb).map(b => b.label).join(', '));
    const doc = kb.frame.contentDocument;
    kb.el.focus(); doc.execCommand('selectAll', false, null);
    doc.execCommand('insertHTML', false, DEMO_SEED.replace('<p>{{FIGMA_IFRAME}}</p>', kiframe(id) + '<p><br></p>'));
    await sleep(500);
    add((kb.el.innerText || '').indexOf('Demo article') !== -1, 'Demo: KB Content', (kb.el.innerText || '').length + ' characters of text');
    const spot = doc.getElementById('kwp-seed-img-jobs-old');
    if (spot) { add(await pastePng(doc, kb.el, spot, 'Jobs tab (demo)', 'Screenshot already in the article', '#009fd9'), 'Demo: screenshot', 'pasted and uploaded'); spot.removeAttribute('id'); }
    add(true, 'Next', 'Click Save. That is the "published" article for the demo. Then click Edit again and run Update from Doc.');
  }

  // ---------- Update from Doc ----------
  function gmGet(url, type) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, responseType: type || 'text',
      onload: r => (r.status >= 200 && r.status < 300) ? resolve(type === 'blob' ? r.response : r.responseText) : reject(new Error('HTTP ' + r.status)),
      onerror: () => reject(new Error('network error')),
    }));
  }
  function cssRules(doc) {
    const map = {};
    doc.querySelectorAll('style').forEach(st => (st.textContent || '').replace(/\.([\w-]+)\{([^}]*)\}/g, (m, cls, body) => { map[cls] = (map[cls] || '') + ';' + body; }));
    return map;
  }
  function styleOf(el, rules) {
    let s = el.getAttribute && (el.getAttribute('style') || '') || '';
    if (el.classList) el.classList.forEach(c => { if (rules[c]) s += ';' + rules[c]; });
    return s;
  }
  const rgb = c => { const m = String(c || '').match(/#([0-9a-f]{6})/i); if (m) return [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16));
    const m2 = String(c || '').match(/rgb\((\d+),\s*(\d+),\s*(\d+)/i); return m2 ? [+m2[1], +m2[2], +m2[3]] : null; };
  const isRed = c => c && c[0] >= 170 && c[1] <= 110 && c[2] <= 110;
  const isGreen = c => c && c[1] >= 110 && c[1] > c[0] + 40 && c[1] > c[2] + 20;
  const BLOCK = /^(P|H[1-6]|LI|TD|TH|SUMMARY|DIV|TR|TABLE|UL|OL|DETAILS|BLOCKQUOTE)$/;
  const LEAF_BLOCK = /^(P|H[1-6]|LI|TD|TH|SUMMARY)$/;
  const normCh = ch => ch === '\u00A0' || ch === '\t' || ch === '\n' || ch === '\r' ? ' ' : ch === '\u2019' || ch === '\u2018' ? "'" : ch === '\u201C' || ch === '\u201D' ? '"' :
    /[\u25B6\u25BA\u25B8\u200B\uFEFF]/.test(ch) ? '' : ch;

  // Doc -> tokens {ch, add, del, href, b, i, blk} (+ image tokens), with block boundaries as spaces.
  function docTokens(html) {
    const d = new DOMParser().parseFromString(html, 'text/html'), rules = cssRules(d);
    const out = []; let blk = 0, blockEl = null;
    const unwrap = h => { const m = String(h || '').match(/[?&]q=([^&]+)/); return m && /google\.com\/url/.test(h) ? decodeURIComponent(m[1]) : h; };
    const walk = (n, ctx) => {
      if (n.nodeType === 3) {
        for (const raw of n.data) { const ch = normCh(raw); if (ch) out.push(Object.assign({ ch, blk, tag: blockEl && blockEl.tagName }, ctx)); }
        return;
      }
      if (n.nodeType !== 1 || /^(STYLE|SCRIPT|HEAD)$/.test(n.tagName)) return;
      const s = styleOf(n, rules), c = ctx;
      const nc = Object.assign({}, c);
      const col = rgb((s.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i) || [])[1]);
      // green = added; red + strikethrough = deleted; any other color (like link blue) keeps what the parent said
      if (col && isGreen(col)) { nc.add = true; nc.del = false; }
      else if (col && isRed(col)) { nc.add = false; nc.del = /line-through/.test(s) || !!c.del; }
      if (/font-weight\s*:\s*(700|bold)/.test(s) || /^(B|STRONG)$/.test(n.tagName)) nc.b = true;
      if (/font-style\s*:\s*italic/.test(s) || /^(I|EM)$/.test(n.tagName)) nc.i = true;
      if (n.tagName === 'A' && n.getAttribute('href')) nc.href = unwrap(n.getAttribute('href'));
      if (n.tagName === 'IMG') { out.push({ img: n.getAttribute('src'), blk, tag: blockEl && blockEl.tagName }); return; }
      const isBlock = BLOCK.test(n.tagName);
      if (isBlock) { out.push({ ch: ' ', sep: true }); if (LEAF_BLOCK.test(n.tagName)) { blk++; blockEl = n; } }
      n.childNodes.forEach(k => walk(k, nc));
      if (isBlock) out.push({ ch: ' ', sep: true });
    };
    walk(d.body, {});
    // a block is "new" when every visible character in it is green
    const byBlk = {};
    out.forEach(t => { if (t.blk == null || t.img) return; if (!t.ch.trim()) return; const b = byBlk[t.blk] || (byBlk[t.blk] = { all: true, any: false }); if (!t.add) b.all = false; else b.any = true; });
    out.forEach(t => { if (t.blk != null && byBlk[t.blk] && byBlk[t.blk].all) t.newBlock = true; });
    out.forEach(t => { if (t.img && byBlk[t.blk] && byBlk[t.blk].any) t.add = true; });
    return out;
  }
  // Editor body -> chars {ch, node, off, el}; block boundaries are spaces with no node.
  function sfTokens(body) {
    const out = [];
    const walk = (n, el) => {
      if (n.nodeType === 3) { for (let i = 0; i < n.data.length; i++) { const ch = normCh(n.data[i]); if (ch) out.push({ ch, node: n, off: i, el }); } return; }
      if (n.nodeType !== 1 || /^(STYLE|SCRIPT)$/.test(n.tagName)) return;
      const isBlock = BLOCK.test(n.tagName), leaf = LEAF_BLOCK.test(n.tagName) ? n : el;
      if (isBlock) out.push({ ch: ' ', sep: true });
      n.childNodes.forEach(k => walk(k, leaf));
      if (isBlock) out.push({ ch: ' ', sep: true });
    };
    walk(body, null);
    return out;
  }
  // collapse spaces: a space is kept only after a visible char; marks dropped ones
  function collapse(list, keep) {
    const out = []; let prevSpace = true;
    list.forEach(t => { if (!keep(t)) return; if (t.ch === ' ') { if (prevSpace) return; prevSpace = true; } else prevSpace = false; out.push(t); });
    while (out.length && out[out.length - 1].ch === ' ') out.pop();
    return out;
  }

  async function updateFromDoc(add) {
    const kb = uniqueFrames().find(e => /KB.?Content/i.test(e.label || ''));
    if (!kb) { add(false, 'Update from Doc', 'KB Content box not found. Click Edit first.'); return; }
    const link = window.prompt('Update from Doc\n\nPaste the link of your copy of the Content Index Doc, with the changes marked\n(red strikethrough = delete, green = add):');
    if (!link) { add(false, 'Update from Doc', 'No link'); return; }
    const docId = (link.match(/\/d\/([A-Za-z0-9_-]{20,})/) || [])[1];
    if (!docId) { add(false, 'Update from Doc', 'That is not a Google Doc link'); return; }
    let html;
    try { html = await gmGet('https://docs.google.com/document/d/' + docId + '/export?format=html'); }
    catch (e) { add(false, '1. Read the Doc', e.message + '. Is it shared with you and are you signed into Google?'); return; }
    if (/<title>[^<]*Sign in/i.test(html)) { add(false, '1. Read the Doc', 'Google asked to sign in'); return; }
    const toks = docTokens(html);
    const adds = toks.filter(t => t.add && !t.img).length, dels = toks.filter(t => t.del).length, imgs = toks.filter(t => t.img && t.add).length;
    add(true, '1. Read the Doc', (adds + dels ? '' : 'NO changes found. ') + 'green: ' + adds + ' characters, red: ' + dels + ' characters, new images: ' + imgs);

    // 2. Parity: the Doc without the green (and with the red as normal text) must equal Salesforce
    const body = kb.el, doc = kb.frame.contentDocument;
    const sf = collapse(sfTokens(body), () => true);
    const orig = collapse(toks.filter(t => !t.img), t => !t.add);
    const a = orig.map(t => t.ch).join(''), b = sf.map(t => t.ch).join('');
    if (a !== b) {
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      add(false, '2. 100% match with Salesforce', 'NO MATCH, nothing was changed. First difference at character ' + i +
        ': Doc says "\u2026' + a.slice(Math.max(0, i - 40), i + 40) + '\u2026" but Salesforce has "\u2026' + b.slice(Math.max(0, i - 40), i + 40) + '\u2026". ' +
        'Make a fresh copy of the Content Index Doc, or mark that change in red/green.');
      return;
    }
    add(true, '2. 100% match with Salesforce', a.length + ' characters match (not counting the changes)');

    // 3. Plan the edits: each Doc token is placed against the Salesforce position it sits before.
    const ops = [];   // {at, kind:'del'|'ins'|'block', ...}
    let k = 0; const origSet = new Set(orig);
    let pendingIns = null, pendingBlock = null;
    const flush = () => { if (pendingIns) { ops.push(pendingIns); pendingIns = null; } if (pendingBlock) { ops.push(pendingBlock); pendingBlock = null; } };
    for (const t of toks) {
      if (origSet.has(t)) { flush(); if (t.del) ops.push({ at: k, kind: 'del' }); k++; continue; }
      if (t.img && t.add) { flush(); ops.push({ at: k, kind: 'img', src: t.img, blk: t.blk }); continue; }
      if (!t.add || t.sep) continue;
      if (t.newBlock) {
        if (!pendingBlock || pendingBlock.blk !== t.blk) { flush(); pendingBlock = { at: k, kind: 'block', blk: t.blk, tag: t.tag, runs: [] }; }
        pendingBlock.runs.push(t);
      } else {
        if (pendingBlock) { ops.push(pendingBlock); pendingBlock = null; }
        if (!pendingIns) pendingIns = { at: k, kind: 'ins', runs: [] };
        pendingIns.runs.push(t);
      }
    }
    flush();
    // attach new images to the new block they live in
    ops.filter(o => o.kind === 'img').forEach(im => { const bl = ops.find(o => o.kind === 'block' && o.blk === im.blk); if (bl) { bl.img = im.src; im.done = true; } });

    const fragOf = runs => {
      const f = doc.createDocumentFragment(); let i = 0;
      while (i < runs.length) {
        const r = runs[i]; let txt = ''; let j = i;
        while (j < runs.length && runs[j].href === r.href && !!runs[j].b === !!r.b && !!runs[j].i === !!r.i) { txt += runs[j].ch; j++; }
        let node = doc.createTextNode(txt);
        if (r.b) { const s = doc.createElement('strong'); s.appendChild(node); node = s; }
        if (r.i) { const s = doc.createElement('em'); s.appendChild(node); node = s; }
        if (r.href) { const aEl = doc.createElement('a'); aEl.setAttribute('href', r.href); if (!/^#/.test(r.href)) aEl.setAttribute('target', '_blank'); aEl.appendChild(node); node = aEl; }
        f.appendChild(node); i = j;
      }
      return f;
    };
    const real = idx => { for (let x = idx; x >= 0; x--) if (sf[x] && !sf[x].sep && sf[x].node) return sf[x]; return null; };
    const realFwd = idx => { for (let x = idx; x < sf.length; x++) if (sf[x] && !sf[x].sep && sf[x].node) return sf[x]; return null; };

    // 3a. deletions (whole blocks removed when every character goes)
    const delIdx = new Set(ops.filter(o => o.kind === 'del').map(o => o.at));
    const blocksAll = new Map();
    sf.forEach((t, i) => { if (!t.node || !t.el) return; const e = blocksAll.get(t.el) || { n: 0, d: 0 }; e.n++; if (delIdx.has(i)) e.d++; blocksAll.set(t.el, e); });
    let removedBlocks = 0, removedChars = 0;
    // elements that receive new text inline must stay; table cells and dropdown titles are never removed
    const keepEls = new Set();
    ops.filter(o => o.kind === 'ins').forEach(o => { const pr = sf[o.at - 1], nx = sf[o.at];
      keepEls.add(pr && pr.node && (!nx || !nx.node || pr.el === nx.el) ? pr.el : (nx && nx.el)); });
    const killEls = [...blocksAll].filter(([el, e]) => e.n > 0 && e.d === e.n && !keepEls.has(el) && !/^(TD|TH|SUMMARY)$/.test(el.tagName)).map(([el]) => el);
    // character deletions, highest offset first inside each text node
    const perNode = new Map();
    [...delIdx].forEach(i => { const t = sf[i]; if (!t || !t.node || killEls.includes(t.el)) return; (perNode.get(t.node) || perNode.set(t.node, []).get(t.node)).push(t.off); });
    // 3b. inserts and new blocks (process from the end so earlier positions stay valid)
    const inserts = ops.filter(o => o.kind === 'ins' || o.kind === 'block').sort((x, y) => y.at - x.at);
    const newEls = [];
    let insChars = 0;
    // group new blocks at the same position to keep their order
    const groups = [];
    inserts.forEach(o => { const g = groups.find(gg => gg.at === o.at && gg.kind === o.kind && o.kind === 'block'); if (g) g.list.push(o); else groups.push({ at: o.at, kind: o.kind, list: [o] }); });
    for (const g of groups) {
      if (g.kind === 'ins') {
        const o = g.list[0];
        const prev = sf[o.at - 1], next = sf[o.at];
        let node, off;
        if (prev && prev.node && (!next || !next.node || prev.el === next.el)) { node = prev.node; off = prev.off + 1; }
        else if (next && next.node) { node = next.node; off = next.off; }
        else { const p2 = real(o.at - 1); node = p2.node; off = p2.off + 1; }
        // shift pending deletions in this node that sit after the insert point
        const after = node.splitText(Math.min(off, node.data.length));
        const plain = o.runs.every(r => !r.href && !r.b && !r.i);
        const frag = plain ? doc.createTextNode(o.runs.map(r => r.ch).join('')) : fragOf(o.runs);
        node.parentNode.insertBefore(frag, after);
        // deletions that pointed into the moved tail now live in "after"
        const offs = perNode.get(node);
        if (offs) { const moved = offs.filter(x => x >= off).map(x => x - off); perNode.set(node, offs.filter(x => x < off)); if (moved.length) perNode.set(after, (perNode.get(after) || []).concat(moved)); }
        insChars += o.runs.length;
      } else {
        const list = g.list.sort((x, y) => x.blk - y.blk);
        const nb = realFwd(g.at), pb = real(g.at - 1);
        const tag = (list[0].tag || 'P').toLowerCase();
        const make = o => { const t2 = (o.tag || 'P').toLowerCase(); const el = doc.createElement(/^(td|th|summary)$/.test(t2) ? 'p' : t2);
          el.appendChild(fragOf(o.runs)); if (o.img) el.setAttribute('data-kwp-img', o.img); newEls.push(el); return el; };
        const topOf = el => { while (el && el.parentNode && el.parentNode !== body) el = el.parentNode; return el; };
        const inList = el => el && el.parentNode && /^(UL|OL)$/.test(el.parentNode.tagName);
        if (tag === 'li' && nb && nb.el && nb.el.tagName === 'LI') list.forEach(o => nb.el.parentNode.insertBefore(make(o), nb.el));
        else if (tag === 'li' && pb && pb.el && pb.el.tagName === 'LI') { let last = pb.el; list.forEach(o => { const el = make(o); last.parentNode.insertBefore(el, last.nextSibling); last = el; }); }
        else if (tag !== 'li' && pb && pb.el && !inList(pb.el) && !/^(TD|TH|SUMMARY)$/.test(pb.el.tagName) && pb.el.parentNode !== body) {
          let last = pb.el; list.forEach(o => { const el = make(o); last.parentNode.insertBefore(el, last.nextSibling); last = el; }); }
        else if (nb && nb.el) { const top = topOf(nb.el); list.forEach(o => body.insertBefore(make(o), top)); }
        else list.forEach(o => body.appendChild(make(o)));
      }
    }
    perNode.forEach((offs, node) => { offs.sort((x, y) => y - x).forEach(o => { node.deleteData(o, 1); removedChars++; }); });
    killEls.forEach(el => { const parent = el.parentNode; el.remove(); removedBlocks++; if (parent && /^(UL|OL)$/.test(parent.tagName) && !parent.querySelector('li')) parent.remove(); });
    body.dispatchEvent(new Event('input', { bubbles: true }));
    add(true, '3. Changes applied', insChars + ' characters added inline \u00B7 ' + newEls.length + ' new paragraphs/bullets/steps \u00B7 ' +
      removedChars + ' characters removed \u00B7 ' + removedBlocks + ' bullets/paragraphs removed');

    // 4. New images: download from the Doc and paste them like a writer
    let imgOk = 0, imgAll = 0;
    for (const el of newEls.filter(e => e.getAttribute('data-kwp-img'))) {
      imgAll++;
      try {
        const blob = await gmGet(el.getAttribute('data-kwp-img'), 'blob');
        const holder = doc.createElement('p'); holder.innerHTML = '<br>'; el.parentNode.insertBefore(holder, el.nextSibling);
        if (await pasteFile(doc, body, holder, new File([blob], 'doc-image.png', { type: blob.type || 'image/png' }))) imgOk++;
      } catch (e) { /* reported below */ }
      el.removeAttribute('data-kwp-img');
    }
    const loose = ops.filter(o => o.kind === 'img' && !o.done).length;
    if (imgAll || loose) add(imgOk === imgAll && !loose, '4. New images', imgOk + ' of ' + imgAll + ' pasted and uploaded' + (loose ? ' \u00B7 ' + loose + ' image(s) not inside a green paragraph: add them by hand' : ''));

    // 5. Check: Salesforce box text now equals the Doc with the red removed and the green kept
    const want = collapse(toks.filter(t => !t.img), t => !t.del).map(t => t.ch).join('');
    const now = collapse(sfTokens(body), () => true).map(t => t.ch).join('');
    let i2 = 0; while (i2 < want.length && want[i2] === now[i2]) i2++;
    add(want === now, '5. Final check', want === now ? 'The box now matches the Doc with the changes. Review it, then click Save.' :
      'Almost: first difference at ' + i2 + ': wanted "\u2026' + want.slice(Math.max(0, i2 - 30), i2 + 30) + '\u2026", box has "\u2026' + now.slice(Math.max(0, i2 - 30), i2 + 30) + '\u2026". Review before saving.');
  }

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
    const ffs = figmaFields(fields);
    const want = ['Title', 'PublishStatus', 'VersionNumber', 'ArticleNumber'].concat(rich, [ffs.multi, ffs.media].filter(Boolean)).map(f => 'Knowledge__kav.' + f);
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
    const formOpen = editors().length > 0;
    if (!formOpen) {
      const editHint = () => add(false, 'Menu', 'To see the menu (Update from Doc, Build the demo article...), click Edit (pencil) on this draft, wait for the content boxes to load, then click Test write again.');
      if (checkImage(add, rec, fields, rich) || checkFigma(add, rec, fields, id) || checkStress(add, rec, fields, rich) || checkSaved(add, rec, fields, rich)) { editHint(); return done(id, lines); }
      await formTest(add);   // explains how to open the form
      return done(id, lines);
    }
    const pick = await chooseMode(id, lines);
    if (pick === 'doc') await updateFromDoc(add);
    else if (pick === 'demo') await seedDemo(add, id);
    else if (pick === 'image') await fillImage(add);
    else if (pick === 'figma') await fillFigma(add, id, fields);
    else if (pick === 'stress') await fillStress(add, fields, rich);
    else if (pick === 'sample') await fillSample(add);
    else if (pick === 'line') await formTest(add);
    else { add(true, 'Closed', 'Nothing was changed.'); }
    done(id, lines);
  }

  // 0.8.1: a clear menu in the box instead of a chain of OK/Cancel pop-ups.
  const MODES = [
    ['doc', '1. Update from Doc', 'Apply the red/green changes of a Google Doc (checks 100% match first, never saves).'],
    ['demo', '2. Build the demo article', 'Replaces all 5 boxes of this test draft with the demo KA.'],
    ['image', 'Image test', ''], ['figma', 'Figma test', ''], ['stress', 'Stress test', ''],
    ['sample', 'Small sample', ''], ['line', 'One test line', ''],
  ];
  function chooseMode(id, lines) {
    return new Promise(resolve => {
      render(id, lines, false);
      const box = document.getElementById('kwp-box');
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div style="font-weight:700;margin:6px 0">Edit form found. What do you want to do?</div>' +
        MODES.map(m => '<div style="margin:6px 0"><button class="kwp-b' + (m[2] ? '' : ' kwp-grey') + '" data-m="' + m[0] + '">' + esc(m[1]) + '</button>' +
          (m[2] ? '<div style="font-size:12px;color:#5B5D62">' + esc(m[2]) + '</div>' : '') + '</div>').join('') +
        '<div style="margin-top:8px"><button class="kwp-b kwp-grey" data-m="close">Close</button></div>';
      box.appendChild(wrap);
      wrap.querySelectorAll('button').forEach(b => b.onclick = () => {
        const m = b.getAttribute('data-m');
        wrap.remove(); render(id, lines, true); resolve(m);
      });
    });
  }

  function done(id, lines) { render(id, lines, false, true); }

  // --- UI (top-left, clear of Salesforce's bottom bar and the KA Refresh buttons) ---
  GM_addStyle(`
    #kwp-btn { position: fixed; top: 110px; left: 20px; z-index: 2147483647; padding: 10px 16px;
      font: 600 13px -apple-system, sans-serif; background: #0E7490; color: #fff; border: none;
      border-radius: 100px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
    #kwp-box { position: fixed; top: 156px; left: 20px; z-index: 2147483647; width: 380px;
      background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.16);
      padding: 14px 16px; font: 13px/1.5 -apple-system, sans-serif; color: #2F3033;
      max-height: calc(100vh - 176px); overflow-y: auto; }
    #kwp-box .ok { color: #1E8E3E; } #kwp-box .no { color: #C5221F; }
    .kwp-b { padding: 6px 12px; font-size: 12px; font-weight: 600; border: none; border-radius: 100px;
      background: #0E7490; color: #fff; cursor: pointer; margin-right: 6px; }
    .kwp-grey { background: #8A8D91; }
  `);

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render(id, lines, running, finished) {
    let box = document.getElementById('kwp-box');
    if (!box) { box = document.createElement('div'); box.id = 'kwp-box'; document.body.appendChild(box); }
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">KA Write Probe 0.8.1' + (running ? ' \u00B7 running\u2026' : '') + '</div>' +
      (finished ? '<div style="margin-bottom:8px"><button class="kwp-b" id="kwp-copy">Copy results</button><button class="kwp-b kwp-grey" id="kwp-close">Close</button></div>' : '') +
      lines.map(l => '<div><b class="' + (l.ok ? 'ok' : 'no') + '">' + (l.ok ? '\u2713' : '\u2717') + '</b> <b>' + esc(l.label) + '</b>' +
        (l.detail ? '<div style="font-size:12px;color:#5B5D62;margin-left:16px">' + esc(l.detail) + '</div>' : '') + '</div>').join('') +
      '';
    if (finished) {
      const text = 'KA Write Probe 0.8.1 - record ' + id + '\n' + lines.map(l => (l.ok ? 'OK   ' : 'FAIL ') + l.label + (l.detail ? ' - ' + l.detail : '')).join('\n');
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
