// ==UserScript==
// @name         KA Write Probe (test only)
// @namespace    ka-write-probe
// @version      0.5.2
// @description  TEST ONLY. Checks whether a script can save changes to a KA DRAFT in Salesforce (needed for an "Update from Doc" button). Only works on drafts, never publishes, and puts back what it changes.
// @author       jcardona@thumbtack.com
// @match        https://thumbtack.lightning.force.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      docs.google.com
// @run-at       document-idle
// ==/UserScript==

/*
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
    const formOpen = editors().length > 0;
    if (!formOpen) {
      if (checkStress(add, rec, fields, rich)) return done(id, lines);
      if (checkSaved(add, rec, fields, rich)) return done(id, lines);
      await formTest(add);   // explains how to open the form
      return done(id, lines);
    }
    if (window.confirm('Edit form found.\n\nOK = STRESS TEST: fill all 5 boxes close to their limit with the real GTM KAs from Salesforce plus a hard block (big tables, deep lists, nested dropdowns, code, scripts, animations, video...).\nCancel = smaller tests.')) await fillStress(add, fields, rich);
    else if (window.confirm('OK = fill all boxes with the small sample draft.\nCancel = just type one test line.')) await fillSample(add);
    else await formTest(add);
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
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">KA Write Probe 0.5.2' + (running ? ' \u00B7 running\u2026' : '') + '</div>' +
      (finished ? '<div style="margin-bottom:8px"><button class="kwp-b" id="kwp-copy">Copy results</button><button class="kwp-b kwp-grey" id="kwp-close">Close</button></div>' : '') +
      lines.map(l => '<div><b class="' + (l.ok ? 'ok' : 'no') + '">' + (l.ok ? '\u2713' : '\u2717') + '</b> <b>' + esc(l.label) + '</b>' +
        (l.detail ? '<div style="font-size:12px;color:#5B5D62;margin-left:16px">' + esc(l.detail) + '</div>' : '') + '</div>').join('') +
      '';
    if (finished) {
      const text = 'KA Write Probe 0.5.2 - record ' + id + '\n' + lines.map(l => (l.ok ? 'OK   ' : 'FAIL ') + l.label + (l.detail ? ' - ' + l.detail : '')).join('\n');
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
