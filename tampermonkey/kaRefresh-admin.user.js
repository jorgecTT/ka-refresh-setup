// ==UserScript==
// @name         KA Refresh - Sync to Drive
// @namespace    https://thumbtack.com/
// @version      2.6.0
// @updateURL    https://raw.githubusercontent.com/jorgectt/ka-refresh-setup/claude/code-web-vs-desktop-fx3w97/tampermonkey/kaRefresh-admin.user.js
// @downloadURL  https://raw.githubusercontent.com/jorgectt/ka-refresh-setup/claude/code-web-vs-desktop-fx3w97/tampermonkey/kaRefresh-admin.user.js
// @description  One-click sync of the current Salesforce KA to its Google Doc, batch refresh, and the weekly Content Index audit (admin copy).
// @author       jcardona@thumbtack.com
// @match        https://thumbtack.lightning.force.com/*
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      docs.google.com
// @connect      googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

/*
 * KA REFRESH v2.0.0 - writers' manual sync tool
 *
 * WHAT CHANGED vs v1.4.6:
 *   - One button: "Sync KA -> Drive". The backend decides create / update /
 *     skip by comparing the KA's "Last Modified" against what the Doc stored
 *     on its last sync. No more separate Update / New buttons.
 *   - If nothing changed, it tells you and offers "Sync anyway".
 *   - Updates happen IN PLACE: same Doc ID, shared links keep working.
 *   - The Doc is built by Drive's native HTML conversion (the v2 backend),
 *     not block-by-block - same format as the Python batch.
 *
 * v2.0.2 - hyperlinks: every real link is absolutized against SF_BASE, so
 *   root-relative "/articles/Knowledge/..." cross-article links (which Drive
 *   silently dropped) now form in the Doc. Fragment "#..." jumps (TOC / section
 *   anchors) still become colored spans; mailto:/tel: are left untouched.
 *
 * v2.1.0 - "Test 5" / "Refresh all" batch buttons (re-sync every KA listed in
 *   the ka_published tab, one by one in this tab).
 *
 * v2.2.0 - admin copy, installed from GitHub (auto-updates from there):
 *   - "Audit" button / menu command: reads the "Published Articles" list view
 *     and the 3 Content Index reports (scrolling each to the end), and the
 *     backend writes the ka_audit tab and emails a summary. Read-only.
 *   - The sync key is no longer in the code: asked once and kept in this
 *     browser (Tampermonkey menu -> "Change sync key" to replace it).
 *
 * v2.2.1 - Audit: the list of Knowledge views falls back to /list-ui when
 *   /list-info answers 404 (it does in this org).
 *
 * v2.2.2 - Audit: long reports (Support, 170+ rows) load in batches; the
 *   reader now waits at the bottom, follows a swapped table and retries.
 *
 * v2.5.0 - "Fix from audit": lists what the last audit flagged, you tick the
 *   ones you accept, and it does them in one go: + New for "En Salesforce
 *   sin Doc" (with the team from the report), Update for "Desactualizado",
 *   Archive for "Doc de más". Anything else is listed to do by hand.
 *
 * v2.4.0 - Audit, one report at a time: read it, save it, VERIFY it, then go
 *   to the next. Verify = the rows match the Docs Drive has for that team
 *   (at most 10 of the team's Docs missing, at most 5 rows from another
 *   team) and the row count matches the report total. A report that fails is
 *   reloaded and read again (3 tries) before the audit stops. Only when all 3
 *   are verified is anything sent. Frames are also matched by report name.
 *
 * v2.3.1 - Audit: read ONLY the report being audited. The console keeps the
 *   previous report tab loaded, and the reader could pick up its table (or
 *   its "Total Records") while the next one opened, mixing rows between
 *   reports. Now the table must come from the frame of this report's ID,
 *   rows start over if the table moves to another frame, and a report whose
 *   total can't be read is retried instead of trusted.
 *
 * v2.3.0 - "Refresh outdated": re-syncs only the KAs the last audit marked
 *   "Desactualizado" (ka_audit tab). "Refresh all" stays for code/format
 *   changes that need every Doc rebuilt.
 *
 * v2.6.0 - "\u270E Update from Doc" in the bar (apply a Doc copy's red/green
 *   changes to the open KA draft; checks the 100% match first, never saves).
 *   "Test 5" removed. The audit also records who last edited each KA in
 *   Salesforce (LastModifiedBy), shown in Fix from audit and the email.
 *
 * Reviewer: asked once, remembered. Click the reviewer name in the status
 * overlay to change it. Audience: asked only when CREATING a new Doc.
 */

(function () {
  'use strict';
  if (window.top !== window.self) return;   // never run inside report iframes

  // --- CONFIG (KA Sync v2 backend - same project URL as always) --------------
  const APPS_SCRIPT_URL = 'https://script.google.com/a/macros/thumbtack.com/s/AKfycbwYEMf5NIMzAl0hwYAeKvnuLDSjLpzRpd9Mo8es6a7R16kklElzIrN0C4vvEMTATpDL/exec';
  const SF_BASE = 'https://thumbtack.lightning.force.com';

  const RICH_TEXT_FIELDS = [
    'KB Content', 'Related Content', 'MC Content',
    'Additional Content', 'Support Content', 'Multimedia',
  ];
  const AUDIENCES = ['Support Ops', 'GTM', 'Trust & Safety'];
  const KA_URL_PATTERN = /\/lightning\/r\/Knowledge__kav\//;
  const SCRIPT_VERSION = '2.6.0';

  const K_REVIEWER = 'KAR2_reviewer';
  const K_SECRET = 'KAR2_secret';

  // Batch "Refresh all" - reads ka_published from the corpus sheet.
  const CORPUS_SHEET_ID = '16X-I4oT-W96XTwx1qs7ErqTAT6sJI7du3_vnYFp9MIo';
  const KA_PUBLISHED_TAB = 'ka_published';
  const K_BATCH = 'KAR2_batch';

  // Weekly audit - Nichole's Content Index reports, one per team.
  const K_AUDIT = 'KAR2_audit';
  const AUDIT_TAB = 'ka_audit';
  const AUDIT_REPORTS = [
    { team: 'GTM',            reportId: '00OVx000006OQHFMA4', label: 'GTM KAs: Active' },
    { team: 'Support Ops',    reportId: '00OVx000006GGADMA4', label: 'Support KAs: Active' },
    { team: 'Trust & Safety', reportId: '00OVx000006ORWfMAO', label: 'T&S KAs: Active' },
  ];

  console.log('[KA Refresh] v2.5.0 loaded (admin)');

  function walkAll(root, callback, depth) {
    if (depth > 30 || !root) return;
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      callback(el);
      if (el.shadowRoot) walkAll(el.shadowRoot, callback, depth + 1);
    }
  }

  function searchLabelInside(r, d) {
    if (d > 5 || !r) return null;
    if (r.querySelector) {
      const lbl = r.querySelector('.test-id__field-label, .slds-form-element__label');
      if (lbl && (lbl.innerText || '').trim()) return lbl.innerText.trim();
    }
    const inner = r.querySelectorAll ? r.querySelectorAll('*') : [];
    for (const i of inner) {
      if (i.shadowRoot) {
        const found = searchLabelInside(i.shadowRoot, d + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function findLabelForRichText(el) {
    let cur = el;
    let layoutItem = null;
    for (let i = 0; i < 20 && cur; i++) {
      if ((cur.tagName || '').toUpperCase() === 'RECORDS-RECORD-LAYOUT-ITEM') {
        layoutItem = cur;
        break;
      }
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host);
    }
    if (!layoutItem) return null;
    if (layoutItem.shadowRoot) {
      const lbl = searchLabelInside(layoutItem.shadowRoot, 0);
      if (lbl) return lbl;
    }
    return searchLabelInside(layoutItem, 0);
  }

  function extractSimpleFields() {
    const simpleFields = {};
    walkAll(document, (el) => {
      if (!el.tagName) return;
      const tag = el.tagName.toUpperCase();
      if (tag !== 'RECORDS-RECORD-LAYOUT-ITEM' && tag !== 'LIGHTNING-OUTPUT-FIELD') return;
      const lbl = (el.querySelector && el.querySelector('.test-id__field-label, .slds-form-element__label')) ||
                  (el.shadowRoot && el.shadowRoot.querySelector('.test-id__field-label, .slds-form-element__label'));
      const val = (el.querySelector && el.querySelector('.test-id__field-value, .slds-form-element__static')) ||
                  (el.shadowRoot && el.shadowRoot.querySelector('.test-id__field-value, .slds-form-element__static'));
      if (lbl) {
        const label = (lbl.innerText || '').trim();
        const value = val ? (val.innerText || '').trim() : '';
        if (label && !(label in simpleFields)) {
          simpleFields[label] = value.split('\n')[0].slice(0, 500);
        }
      }
    }, 0);

    walkAll(document, (el) => {
      if (!el.tagName) return;
      if ((el.tagName || '').toUpperCase() !== 'RECORDS-RECORD-LAYOUT-ITEM') return;
      const label = searchLabelInside(el.shadowRoot || el, 0);
      if (!label || label in simpleFields) return;
      const textVal = (el.innerText || '').trim().split('\n')[0].slice(0, 500);
      if (textVal && textVal !== label) {
        simpleFields[label] = textVal;
      }
    }, 0);

    walkAll(document, (el) => {
      if (!el.tagName) return;
      const cls = (el.className || '').toString();
      if (!cls.includes('slds-text-title')) return;
      const txt = (el.innerText || '').trim();
      if (txt !== 'Article Number') return;
      let sibling = el.nextElementSibling;
      while (sibling) {
        const stxt = (sibling.innerText || '').trim();
        if (/^0\d{8,}$/.test(stxt)) { if (!simpleFields['Article Number']) simpleFields['Article Number'] = stxt; return; }
        sibling = sibling.nextElementSibling;
      }
    }, 0);
    if (!simpleFields['Article Number']) {
      walkAll(document, (el) => {
        if (simpleFields['Article Number']) return;
        if (!el.tagName || el.children.length > 0) return;
        const txt = (el.innerText || '').trim();
        if (/^0\d{8,}$/.test(txt)) simpleFields['Article Number'] = txt;
      }, 0);
    }
    walkAll(document, (el) => {
      if (simpleFields['Version Number']) return;
      if (!el.tagName) return;
      const cls = (el.className || '').toString();
      if (!cls.includes('slds-text-title')) return;
      if ((el.innerText || '').trim() !== 'Version Number') return;
      let sibling = el.nextElementSibling;
      while (sibling) {
        const stxt = (sibling.innerText || '').trim();
        if (/^\d+$/.test(stxt)) { simpleFields['Version Number'] = stxt; return; }
        sibling = sibling.nextElementSibling;
      }
    }, 0);

    function findValueFor(labelText, isDate) {
      let found = null;
      walkAll(document, (el) => {
        if (found) return;
        if (!el.tagName) return;
        const txt = (el.innerText || '').trim();
        if (txt !== labelText) return;
        let sibling = el.nextElementSibling;
        while (sibling) {
          const stxt = (sibling.innerText || '').trim();
          const firstLine = stxt.split('\n')[0];
          if (isDate) { if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(firstLine)) { found = firstLine; return; } }
          else { if (firstLine && firstLine !== labelText) { found = stxt; return; } }
          sibling = sibling.nextElementSibling;
        }
      }, 0);
      return found;
    }
    if (!simpleFields['Last Modified Date']) {
      const v = findValueFor('Last Modified Date', true);
      if (v) simpleFields['Last Modified Date'] = v;
    }

    walkAll(document, (el) => {
      if (simpleFields['Last Modified By Full']) return;
      if (!el.tagName) return;
      if ((el.innerText || '').trim() !== 'Last Modified By') return;
      let candidate = null;
      let sibling = el.nextElementSibling;
      while (sibling && !candidate) {
        const stxt = (sibling.innerText || '').trim();
        if (stxt && stxt.includes(',') && /\d{1,2}\/\d{1,2}\/\d{4}/.test(stxt)) candidate = stxt;
        sibling = sibling.nextElementSibling;
      }
      if (candidate) simpleFields['Last Modified By Full'] = candidate;
    }, 0);

    return simpleFields;
  }

  function extractRichTextFields() {
    const richTextResults = {};
    walkAll(document, (el) => {
      if (!el.tagName) return;
      const tag = el.tagName.toUpperCase();
      const cls = (el.className || '').toString();
      const isRichText =
        tag === 'LIGHTNING-FORMATTED-RICH-TEXT' ||
        tag === 'KNOWLEDGEUI-OUTPUT-RICH-TEXT' ||
        cls.includes('slds-rich-text-editor__output');
      if (!isRichText) return;
      const text = (el.innerText || '').trim();
      if (text.length < 30) return;
      const label = findLabelForRichText(el);
      if (!label) return;
      const html = el.shadowRoot ? el.shadowRoot.innerHTML : el.innerHTML;
      if (richTextResults[label] && richTextResults[label].html.length >= html.length) return;
      richTextResults[label] = { html, text };
    }, 0);
    return richTextResults;
  }

  function formatLastModified(simpleFields) {
    const full = (simpleFields['Last Modified By Full'] || '').trim();
    if (full && full.includes(',')) {
      const m = full.match(/^(.+?)\s*,\s*(\d{1,2}\/\d{1,2}\/\d{4}.*)$/s);
      if (m) {
        let rawName = m[1].trim().replace(/\n/g, ' ');
        let date = m[2].trim();
        rawName = rawName.replace(/\s*Open\s+.*?\s+Preview\s*$/i, '');
        rawName = rawName.replace(/\s*\d{1,2}\/\d{1,2}\/\d{4}.*$/, '');
        const parts = rawName.split(/\s+/);
        const half = Math.floor(parts.length / 2);
        if (half > 0 && parts.slice(0, half).join() === parts.slice(half, half * 2).join()) {
          rawName = parts.slice(0, half).join(' ');
        }
        date = date.replace(/\s+(Open|Preview).*$/i, '').trim();
        if (rawName) return date + ' by ' + rawName;
        return date;
      }
    }
    return (simpleFields['Last Modified Date'] || 'Not listed').trim();
  }

  function toSlugUrl(simpleFields, fallbackUrl) {
    const urlName = (simpleFields['URL Name'] || '').trim();
    if (urlName) return SF_BASE + '/articles/Knowledge/' + urlName;
    return fallbackUrl;
  }
  // --- NORMALIZER (v2 - feedback round 1) -----------------------------------
  // Rewrites the SF HTML instead of parsing it to blocks. Drive's native HTML
  // importer converts the result to a Doc in one call.
  // v2 changes from the side-by-side review:
  //   - "Contents" label: black bold underlined (matches the hand-corrected
  //     Doc), not a green H1. Compact spacing around the TOC.
  //   - List glyphs forced by nesting depth (OL: 1. -> a. -> i., UL: * -> o -> #)
  //     unless SF set an explicit list-style-type. Fixes TOC and body lists.
  //   - ALL "(Return to contents)"/"(Table of contents)" variants removed:
  //     relative "#C", absolute URL "...#C", parens inside OR outside the
  //     link, zero-width chars in the text.
  //   - NO faux-heading promotion: what SF sends as a painted paragraph stays
  //     a painted paragraph (formatting audit happens in SF).
  //   - Real headings keep their inner structure (<br>, <strong>) so glued
  //     heading+body content stays on separate lines; inner style attrs are
  //     stripped so the heading style is uniform.
  //   - line-height 1.15 on body blocks; tighter list indents; uniform hr
  //     margins; title separated from the page header.

  const PT = {
    title: 'font-family:Montserrat,Arial,sans-serif;font-size:16pt;font-weight:bold;color:#2f3033;line-height:1.15;margin:6pt 0 6pt 0;',
    h1:    'font-family:Montserrat,Arial,sans-serif;font-size:14pt;font-weight:bold;color:#2db783;line-height:1.15;margin:12pt 0 6pt 0;',
    h2:    'font-family:Montserrat,Arial,sans-serif;font-size:13pt;font-weight:bold;color:#009fd9;line-height:1.15;margin:10pt 0 4pt 0;',
    h3:    'font-family:Montserrat,Arial,sans-serif;font-size:13pt;font-weight:bold;color:#007fad;line-height:1.15;margin:8pt 0 3pt 0;',
    h4:    'font-family:Montserrat,Arial,sans-serif;font-size:12pt;font-weight:bold;color:#005979;line-height:1.15;margin:6pt 0 3pt 0;',
    body:  'font-family:Montserrat,Arial,sans-serif;font-size:10pt;color:#2f3033;line-height:1.15;margin:0 0 6pt 0;',
    list:  'font-family:Montserrat,Arial,sans-serif;font-size:10pt;color:#2f3033;line-height:1.15;margin:0 0 2pt 0;',
    contents: 'font-family:Montserrat,Arial,sans-serif;font-size:10pt;font-weight:bold;color:#2f3033;text-decoration:underline;line-height:1.15;margin:0 0 4pt 0;',
    accordion: 'font-family:Montserrat,Arial,sans-serif;font-size:10pt;font-weight:bold;color:#2f3033;line-height:1.15;margin:6pt 0 3pt 0;',
    image: 'font-family:Montserrat,Arial,sans-serif;font-size:10pt;font-style:italic;color:#666666;line-height:1.15;margin:6pt 0 6pt 0;',
    cell:  'border:1pt solid #cccccc;padding:4pt;font-family:Montserrat,Arial,sans-serif;font-size:10pt;color:#2f3033;line-height:1.15;vertical-align:top;',
    hr:    'margin:8pt 0 8pt 0;',
  };

  const OL_GLYPHS = ['decimal', 'lower-alpha', 'lower-roman'];
  const UL_GLYPHS = ['disc', 'circle', 'square'];

  const TOC_WHOLE_RE = /^\(?\s*(table\s*of\s*contents|return\s*to\s*contents)\s*\)?$/i;
  const TOC_INLINE_RE = /\(\s*(table\s*of\s*contents|return\s*to\s*contents)\s*\)/gi;
  const TOC_SUMMARY_RE = /^(contents|table\s*of\s*contents|toc|index|tabla\s*de\s*contenido|contenido)$/i;

  function cleanText(s) {
    return (s || '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
  }

  function isBlank(el) {
    const t = (el.textContent || '').replace(/[\u00A0\u200B-\u200F\uFEFF\s]/g, '');
    return t === '' && !el.querySelector('img, table, video, iframe, embed, hr');
  }

  function normalizeKaHtml(richFields, title) {
    const root = document.createElement('div');
    for (const fieldName of RICH_TEXT_FIELDS) {
      const field = richFields[fieldName];
      if (!field || !field.html) continue;
      if ((field.text || '').trim() === "Right click and copy link to share this Article's URL") continue;
      const d = document.createElement('div');
      d.innerHTML = field.html;
      root.appendChild(d);
    }

    // 0. Junk out.
    root.querySelectorAll('script, style, button').forEach(e => e.remove());

    // 1. Media -> text placeholders (works no matter where they're nested).
    root.querySelectorAll('img').forEach(img => {
      const alt = (img.getAttribute('alt') || '').trim();
      const src = img.getAttribute('src') || '';
      let desc = alt;
      if (!desc && src) {
        try { desc = decodeURIComponent(src.split('/').pop().split('?')[0]); }
        catch (e) { desc = src.split('/').pop().split('?')[0]; }
      }
      const p = document.createElement('p');
      p.setAttribute('style', PT.image);
      p.textContent = '[Image: ' + (desc || 'image') + ']';
      img.replaceWith(p);
    });
    root.querySelectorAll('video, audio').forEach(v => {
      const p = document.createElement('p');
      p.setAttribute('style', PT.image);
      p.textContent = '[Video]';
      v.replaceWith(p);
    });
    root.querySelectorAll('iframe, embed, object').forEach(f => {
      const p = document.createElement('p');
      p.setAttribute('style', PT.image);
      p.textContent = '[Embedded content]';
      f.replaceWith(p);
    });

    // 2. Remove EVERY "(Return to contents)"/"(Table of contents)" variant:
    //    - <a> whose cleaned text is the phrase (parens optional), no matter
    //      if the href is relative "#C" or the full absolute KA URL + "#C".
    //    - parens living OUTSIDE the link as sibling text nodes: "(<a>...</a>)"
    //    - a <br> right before, the usual SF layout.
    root.querySelectorAll('a').forEach(a => {
      const t = cleanText(a.textContent);
      const href = a.getAttribute('href') || '';
      const isTocText = TOC_WHOLE_RE.test(t) ||
        (/contents/i.test(t.replace(/[()\s]/g, '')) && /#c(ontents)?$/i.test(href) &&
         /^(return\s*to\s*contents|table\s*of\s*contents)$/i.test(t.replace(/[()]/g, '').trim()));
      if (!isTocText) return;
      // Eat surrounding "(" / ")" text-node siblings.
      const prev = a.previousSibling;
      const next = a.nextSibling;
      if (prev && prev.nodeType === Node.TEXT_NODE && cleanText(prev.nodeValue).replace(/\u00A0/g, '') === '(') prev.remove();
      if (next && next.nodeType === Node.TEXT_NODE && cleanText(next.nodeValue).replace(/\u00A0/g, '') === ')') next.remove();
      const prev2 = a.previousSibling;
      a.remove();
      if (prev2 && prev2.nodeName === 'BR') prev2.remove();
    });
    // ...and the same phrase living in plain text nodes (glued or standalone).
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (tw.nextNode()) textNodes.push(tw.currentNode);
    for (const tn of textNodes) {
      let v = tn.nodeValue || '';
      if (TOC_INLINE_RE.test(v)) v = v.replace(TOC_INLINE_RE, '');
      TOC_INLINE_RE.lastIndex = 0;
      if (TOC_WHOLE_RE.test(cleanText(v))) v = '';
      tn.nodeValue = v;
    }

    // 3. Links (Opcion A). Los autores insertan links a otros KA de dos
    //    formas: absoluta (Drive la forma) o ROOT-RELATIVA "/articles/
    //    Knowledge/..." (Drive no puede resolver un href relativo sin base ->
    //    el link se pierde). Fix: absolutizar todo link real contra SF_BASE.
    //    Los "#..." (TOC / saltos de seccion) siguen muertos -> span de color.
    root.querySelectorAll('a[href]').forEach(a => {
      const href = (a.getAttribute('href') || '').trim();
      // 3a. Solo-fragmento (#...) -> muerto en un Doc -> span de color.
      if (href === '' || href.charAt(0) === '#') {
        const span = document.createElement('span');
        span.setAttribute('style', 'color:#5968e2;');
        span.innerHTML = a.innerHTML;
        a.replaceWith(span);
        return;
      }
      // 3b. mailto:/tel: -> intactos.
      if (/^(mailto:|tel:)/i.test(href)) return;
      // 3c. Link real -> clicable con href ABSOLUTO para que Drive lo forme.
      //     Relativos SF resuelven contra SF_BASE; absolutos no cambian.
      try { a.setAttribute('href', new URL(href, SF_BASE + '/').href); }
      catch (e) { /* si no parsea, se deja el href original */ }
    });
    // Pure anchor targets (<a id> with no text) -> drop.
    root.querySelectorAll('a[id], a[name]').forEach(a => {
      if (cleanText(a.textContent) === '') a.remove();
      else { a.removeAttribute('id'); a.removeAttribute('name'); }
    });

    // 4. Flatten <details> accordions. The FIRST TOC accordion's summary
    //    becomes the compact black bold underlined "Contents" label; any
    //    LATER TOC accordion (Related Content and other fields carry their
    //    own) is removed entirely - only the initial Contents survives.
    //    Every other summary becomes a bold "\u25B6 ..." paragraph. Loop handles
    //    nesting.
    let guard = 0;
    let det;
    let tocSeen = false;
    while ((det = root.querySelector('details')) && guard++ < 500) {
      const sum = det.querySelector(':scope > summary') || det.querySelector('summary');
      const sumText = sum ? cleanText(sum.textContent) : '';
      const isToc = sumText && TOC_SUMMARY_RE.test(sumText.toLowerCase());
      if (isToc && tocSeen) { det.remove(); continue; }
      let replacementHeader = null;
      if (isToc) {
        tocSeen = true;
        replacementHeader = document.createElement('p');
        replacementHeader.setAttribute('style', PT.contents);
        replacementHeader.textContent = 'Contents';
      } else if (sumText) {
        replacementHeader = document.createElement('p');
        replacementHeader.setAttribute('style', PT.accordion);
        replacementHeader.textContent = '\u25B6 ' + sumText;
      }
      if (sum) sum.remove();
      const frag = document.createDocumentFragment();
      if (replacementHeader) frag.appendChild(replacementHeader);
      while (det.firstChild) frag.appendChild(det.firstChild);
      det.replaceWith(frag);
    }

    // 5. Real headings: uniform OUTER style, but keep the inner structure
    //    (<br>, <strong>, text) so heading tags that carry glued body content
    //    keep their line breaks. Inner style attrs are stripped so the
    //    heading style applies uniformly. NO promotion of painted paragraphs
    //    to headings - those stay exactly as SF sent them (formatting audit).
    const HSTYLES = { h1: PT.h1, h2: PT.h2, h3: PT.h3, h4: PT.h4, h5: PT.h4, h6: PT.h4 };
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
      const tag = h.tagName.toLowerCase();
      h.setAttribute('style', HSTYLES[tag]);
      h.querySelectorAll('[style]').forEach(inner => inner.removeAttribute('style'));
      h.querySelectorAll('font').forEach(f => {
        f.removeAttribute('color'); f.removeAttribute('size'); f.removeAttribute('face');
      });
    });

    // 6. Base styles on body blocks. Inner spans/strong/em keep their own
    //    inline styles (orange "Important:", link colors) - block-level only.
    root.querySelectorAll('p').forEach(p => {
      const st = p.getAttribute('style') || '';
      if (!/font-family:Montserrat/.test(st)) p.setAttribute('style', PT.body);
    });
    root.querySelectorAll('li').forEach(li => li.setAttribute('style', PT.list));

    // 6.5 List cleanup (BEFORE glyph styling so depths are computed on the
    //     final structure):
    //     - A blank <li> (no own text, no nested list/media) renders as a
    //       lone glyph - drop it.
    //     - A "wrapper" list whose items ALL have no text of their own and
    //       only contain nested lists renders as a lone glyph followed by the
    //       real items one level too deep (the "* then a. b. c." bug). The
    //       wrapper is replaced by the nested lists, hoisting them to the
    //       right depth so numbering matches Salesforce.
    function liDirectText(li) {
      const clone = li.cloneNode(true);
      clone.querySelectorAll('ul, ol').forEach(n => n.remove());
      return (clone.textContent || '').replace(/[\u00A0\u200B-\u200F\uFEFF\s]/g, '');
    }
    root.querySelectorAll('li').forEach(li => {
      if (!liDirectText(li) && !li.querySelector('ul, ol, img, table')) li.remove();
    });
    let listChanged = true;
    let listGuard = 0;
    while (listChanged && listGuard++ < 50) {
      listChanged = false;
      for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
        const lis = Array.from(list.children).filter(c => c.tagName === 'LI');
        if (lis.length === 0) { list.remove(); listChanged = true; continue; }
        const allWrappers = lis.every(li =>
          !liDirectText(li) && !li.querySelector('img, table') &&
          Array.from(li.children).some(c => c.tagName === 'UL' || c.tagName === 'OL'));
        if (allWrappers) {
          const frag = document.createDocumentFragment();
          for (const li of lis) {
            for (const c of Array.from(li.children)) {
              if (c.tagName === 'UL' || c.tagName === 'OL') frag.appendChild(c);
            }
          }
          list.replaceWith(frag);
          listChanged = true;
        }
      }
    }

    // 7. Lists: glyph forced by NESTING DEPTH so numbering matches production
    //    (OL: 1. -> a. -> i. ; UL: * -> o -> #). An explicit list-style-type from
    //    SF wins. Tighter indent than the converter's default.
    function styleList(listEl, depth) {
      const own = (listEl.getAttribute('style') || '').match(/list-style-type\s*:\s*([a-z-]+)/i);
      let glyph;
      if (own) {
        glyph = own[1].toLowerCase();
      } else if (listEl.tagName === 'OL') {
        glyph = OL_GLYPHS[Math.min(depth, OL_GLYPHS.length - 1)];
      } else {
        glyph = UL_GLYPHS[Math.min(depth, UL_GLYPHS.length - 1)];
      }
      listEl.setAttribute('style',
        'margin:0 0 4pt 0;padding-left:18pt;list-style-type:' + glyph + ';');
      for (const li of listEl.children) {
        if (li.tagName !== 'LI') continue;
        for (const child of li.children) {
          if (child.tagName === 'UL' || child.tagName === 'OL') styleList(child, depth + 1);
        }
      }
    }
    root.querySelectorAll('ul, ol').forEach(l => {
      // Only style top-level lists here; styleList recurses into nested ones.
      let parent = l.parentElement;
      let nested = false;
      while (parent && parent !== root) {
        if (parent.tagName === 'UL' || parent.tagName === 'OL') { nested = true; break; }
        parent = parent.parentElement;
      }
      if (!nested) styleList(l, 0);
    });

    // 8. Tables: visible borders, padded cells.
    root.querySelectorAll('table').forEach(t => {
      t.setAttribute('style', 'border-collapse:collapse;margin:6pt 0;');
      t.setAttribute('border', '1');
    });
    root.querySelectorAll('td, th').forEach(c => {
      const old = c.getAttribute('style') || '';
      const bg = old.match(/background-color\s*:\s*(#[0-9a-fA-F]{3,6})/i);
      c.setAttribute('style', PT.cell + (bg ? 'background-color:' + bg[1] + ';' : ''));
      if (c.tagName === 'TH') c.setAttribute('style', c.getAttribute('style') + 'font-weight:bold;');
    });

    // 9. Uniform hr spacing.
    root.querySelectorAll('hr').forEach(h => h.setAttribute('style', PT.hr));

    // 10. Kill blank spacer paragraphs/divs and trailing <br> runs - the
    //     "weird gaps". Includes blanks that hide an empty <span> inside
    //     (the gap under headings). Collapse 2+ consecutive <br> into one.
    root.querySelectorAll('p, div').forEach(el => {
      if (isBlank(el)) el.remove();
    });
    root.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6').forEach(el => {
      while (el.lastChild && (
        (el.lastChild.nodeName === 'BR') ||
        (el.lastChild.nodeType === Node.TEXT_NODE && (el.lastChild.nodeValue || '').replace(/[\u00A0\s]/g, '') === '')
      )) el.removeChild(el.lastChild);
    });
    root.querySelectorAll('br').forEach(br => {
      let next = br.nextSibling;
      while (next && next.nodeType === Node.TEXT_NODE && (next.nodeValue || '').replace(/[\u00A0\s]/g, '') === '') next = next.nextSibling;
      if (next && next.nodeName === 'BR') br.remove();
    });

    // 11. Doc title at the very top (top margin keeps it off the page header).
    const titleEl = document.createElement('h1');
    titleEl.setAttribute('style', PT.title);
    titleEl.textContent = title;
    root.insertBefore(titleEl, root.firstChild);

    return root.innerHTML;
  }


  // ---------------------------------------------------------------------------
  // -- BACKEND ----------------------------------------------------------------
  // ---------------------------------------------------------------------------

  async function apiPost(payload) {
    const secret = await ensureSecret();
    if (!secret) throw new Error('No sync key: open the Tampermonkey menu \u2192 "Change sync key"');
    return new Promise((resolve, reject) => {
      payload.secret = secret;
      GM_xmlhttpRequest({
        method: 'POST', url: APPS_SCRIPT_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        onload(resp) {
          let json;
          try { json = JSON.parse(resp.responseText); }
          catch (e) {
            reject(new Error(/<html|<!DOCTYPE/i.test(resp.responseText || '')
              ? 'Google answered with a sign-in page: sign into your Thumbtack Google account and try again'
              : 'Bad server response (HTTP ' + resp.status + ')'));
            return;
          }
          if (json && json.code === 'BAD_SECRET') {
            GM_setValue(K_SECRET, '');   // wrong key: ask again next time
            reject(new Error('The sync key was not accepted. Click again and paste the current key.'));
            return;
          }
          resolve(json);
        },
        onerror() { reject(new Error('Network error reaching Apps Script')); },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // -- SYNC ENGINE ------------------------------------------------------------
  //
  // Two intents, matching the documented SOP (Step 9):
  //   NEW    -> creates the Doc. If one already exists, you're prompted to use
  //            Update instead.
  //   UPDATE -> updates the existing Doc in place. If none exists yet, you're
  //            prompted to use New instead.
  // Bonus on Update: if the KA hasn't changed since the last sync, it says so
  // and offers "Sync anyway".
  // ---------------------------------------------------------------------------

  let _busy = false;

  function _readKa() {
    const simpleFields = extractSimpleFields();
    const richFields = extractRichTextFields();
    if (!simpleFields['Title'] && !simpleFields['Article Number']) return null;
    return {
      simpleFields, richFields,
      title: simpleFields['Title'] || 'Untitled',
      kaId: simpleFields['Article Number'] || simpleFields['URL Name'] || '',
      version: simpleFields['Version Number'] || '',
      lastModified: formatLastModified(simpleFields),
      url: toSlugUrl(simpleFields, location.href),
    };
  }

  async function _performSync(ka, mode, reviewer, audience) {
    setStatus('loading', 'Normalizing HTML\u2026');
    const html = normalizeKaHtml(ka.richFields, ka.title);
    setStatus('loading', (mode === 'create' ? 'Creating' : 'Updating') + ' Doc\u2026');
    let result;
    try {
      result = await apiPost({
        action: 'sync', mode,
        title: ka.title, kaId: ka.kaId, version: ka.version,
        lastModified: ka.lastModified, url: ka.url,
        html, reviewer, audience: audience || '',
      });
    } catch (e) { setStatus('error', e.message); return; }
    if (result.ok) {
      setDoneStatus(
        (result.mode === 'create' ? 'Created: ' : 'Updated: ') + (result.filename || ka.title),
        result.docUrl || ''
      );
    } else {
      setStatus('error', (result.code ? result.code + ': ' : '') + (result.error || 'sync failed'));
    }
  }

  async function runIntent(intent, opts) {
    if (_busy) return;
    _busy = true;
    setButtonsDisabled(true);
    opts = opts || {};
    try {
      const reviewer = await ensureReviewer();
      if (!reviewer) return;

      setStatus('loading', 'Reading KA fields\u2026');
      const ka = _readKa();
      if (!ka) {
        setStatus('error', 'Could not read the KA. Wait for the page to finish loading and try again.');
        return;
      }

      // Forced re-sync from the "Sync anyway" button: skip the change check.
      if (opts.force) {
        await _performSync(ka, 'update', reviewer, '');
        return;
      }

      setStatus('loading', 'Checking the Drive folder\u2026');
      let decision;
      try {
        decision = await apiPost({ action: 'checkKA', kaId: ka.kaId, url: ka.url, lastModified: ka.lastModified });
      } catch (e) { setStatus('error', e.message); return; }
      if (!decision.ok) { setStatus('error', decision.error || 'Check failed'); return; }

      if (decision.decision === 'skip' && decision.reason === 'multiple-docs') {
        setStatus('error', 'Multiple Docs match this KA \u2014 delete the duplicates in Drive first.');
        return;
      }

      const docExists = decision.decision !== 'create';

      if (intent === 'new') {
        if (docExists) {
          // SOP: "If you click New and a doc already exists -> use Update instead."
          setMismatchStatus(
            'A Doc already exists for this KA.',
            'Use Update instead', 'update', decision.docUrl || ''
          );
          return;
        }
        const audience = await promptAudience();
        if (!audience) { setStatus('idle', 'Cancelled.'); return; }
        await _performSync(ka, 'create', reviewer, audience);
        return;
      }

      // intent === 'update'
      if (!docExists) {
        // SOP: "If you click Update and no doc exists yet -> use New instead."
        setMismatchStatus('No Doc exists for this KA yet.', 'Use New instead', 'new', '');
        return;
      }
      if (decision.decision === 'skip') {
        setSkipStatus(decision.message || 'No change since the last sync.', decision.docUrl || '');
        return;
      }
      await _performSync(ka, 'update', reviewer, '');
    } finally {
      _busy = false;
      setButtonsDisabled(false);
    }
  }

  // ---------------------------------------------------------------------------
  // -- UI ---------------------------------------------------------------------
  // ---------------------------------------------------------------------------

  GM_addStyle(`
    #kar-bar { position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      font-family: -apple-system, sans-serif; display: flex; gap: 10px; }
    .kar-main-btn { padding: 10px 18px; font-size: 13px; font-weight: 600; border: none;
      border-radius: 100px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      line-height: 1.4; white-space: nowrap; }
    .kar-main-btn:disabled { opacity: 0.6; cursor: wait; }
    #kar-update-btn { background: #009FD9; color: #fff; }
    #kar-update-btn:hover:not(:disabled) { background: #008BC0; }
    #kar-new-btn { background: #2F3033; color: #fff; }
    #kar-new-btn:hover:not(:disabled) { background: #1C1D1F; }
    #kar-ufd-btn { background: #0E7490; color: #fff; }
    #kar-ufd-btn:hover:not(:disabled) { background: #0B5E75; }
    #kar-batch-btn { background: #2DB783; color: #fff; }
    #kar-batch-btn:hover:not(:disabled) { background: #269E70; }
    #kar-outdated-btn { background: #E8912D; color: #fff; }
    #kar-outdated-btn:hover:not(:disabled) { background: #CC7A1C; }
    #kar-fix-btn { background: #1E8E3E; color: #fff; }
    #kar-fix-btn:hover:not(:disabled) { background: #176F30; }
    .kar-fix-list { max-height: 46vh; overflow: auto; margin: 6px 0; border-top: 1px solid #E8E9EB; }
    .kar-fix-list label { display: flex; gap: 8px; align-items: flex-start; padding: 6px 2px; border-bottom: 1px solid #F0F1F2; cursor: pointer; }
    .kar-fix-list label.off { cursor: default; color: #8A8D93; }
    .kar-fix-list .kar-act { font-size: 11px; font-weight: 700; border-radius: 4px; padding: 1px 6px; white-space: nowrap; }
    .kar-act.create { background: #E3F5EA; color: #176F30; } .kar-act.update { background: #FFF3DC; color: #8A5300; }
    .kar-act.archive { background: #E8F0FB; color: #2A5A9C; } .kar-act.manual { background: #F0F1F2; color: #5B5D62; }
    #kar-audit-btn { background: #7A5AF8; color: #fff; }
    #kar-audit-btn:hover:not(:disabled) { background: #6440E5; }
    #kar-overlay { position: fixed; bottom: 66px; right: 20px; z-index: 99999;
      width: 340px; background: #fff; border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.16); padding: 14px 16px;
      font-family: -apple-system, sans-serif; font-size: 13px; line-height: 1.5;
      color: #2F3033; display: none; }
    #kar-overlay.visible { display: block; }
    #kar-overlay .kar-title { font-weight: 700; font-size: 14px; margin: 0 0 4px; }
    #kar-overlay .kar-title.success { color: #1E8E3E; }
    #kar-overlay .kar-title.error { color: #D93025; }
    #kar-overlay .kar-title.loading { color: #009FD9; }
    #kar-overlay .kar-title.idle { color: #5B5D62; }
    #kar-overlay .kar-title.skip { color: #B45309; }
    #kar-overlay .kar-title.mismatch { color: #B45309; }
    #kar-overlay a { color: #009FD9; font-weight: 600; text-decoration: none; }
    #kar-overlay a:hover { text-decoration: underline; }
    #kar-overlay .kar-meta { font-size: 11px; color: #8A8D91; margin-top: 8px; }
    #kar-overlay .kar-meta a { color: #8A8D91; font-weight: 400; text-decoration: underline; cursor: pointer; }
    .kar-mini-btn { display: inline-block; margin-top: 8px; padding: 6px 14px;
      font-size: 12px; font-weight: 600; border: none; border-radius: 100px;
      cursor: pointer; color: #fff; }
    .kar-mini-btn.warn { background: #B45309; }
    .kar-mini-btn.blue { background: #009FD9; }
    .kar-spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor;
      border-right-color: transparent; border-radius: 50%; animation: kar-spin 0.6s linear infinite;
      vertical-align: middle; margin-right: 6px; }
    @keyframes kar-spin { to { transform: rotate(360deg); } }
    #kar-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4);
      z-index: 100000; display: flex; align-items: center; justify-content: center; }
    #kar-modal { background: #fff; border-radius: 12px; padding: 24px;
      width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); font-family: -apple-system, sans-serif; }
    #kar-modal h3 { margin: 0 0 6px; font-size: 16px; }
    #kar-modal p { margin: 0 0 12px; font-size: 13px; color: #5B5D62; }
    #kar-modal input { width: 100%; padding: 10px 12px; font-size: 14px;
      border: 1.5px solid #E8E9EB; border-radius: 8px; margin-bottom: 10px; outline: none; box-sizing: border-box; }
    #kar-modal .kar-opt { display: block; width: 100%; padding: 10px 12px; margin-bottom: 8px;
      font-size: 14px; font-weight: 600; text-align: left; border: 1.5px solid #E8E9EB;
      border-radius: 8px; background: #fff; cursor: pointer; }
    #kar-modal .kar-opt:hover { border-color: #009FD9; color: #009FD9; }
    #kar-modal .kar-primary { width: 100%; padding: 10px; font-size: 14px; font-weight: 600;
      background: #009FD9; color: #fff; border: none; border-radius: 100px; cursor: pointer; }
    #kar-modal .kar-cancel { width: 100%; padding: 8px; margin-top: 6px; font-size: 13px;
      background: none; border: none; color: #8A8D91; cursor: pointer; }
  `);

  // ---------------------------------------------------------------------------
  // -- UPDATE FROM DOC ---------------------------------------------------------
  // The writer makes a copy of the KA's Content Index Doc, marks the changes
  // (red strikethrough = delete, green = add), opens the KA DRAFT, clicks Edit
  // and then "Update from Doc". The Doc without the changes must match the
  // draft 100% (all 5 boxes), or nothing is touched. It never saves: the
  // writer reviews, clicks Save, then Publish. (Built and tested in
  // tools/ka-write-probe.user.js.)
  // ---------------------------------------------------------------------------
  const UFD = (() => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  function uniqueFrames() {
    const seen = new Set();
    return editors().filter(e => e.frame && !seen.has(e.el) && seen.add(e.el));
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

  // ---------- Update from Doc ----------
  const BOX_ORDER = ['KB Content', 'Related Content', 'MC Content', 'Additional Content', 'Support Content'];
  const boxRe = l => new RegExp(l.replace(/ /g, '.?'), 'i');
  // The 5 content boxes in the order the Content Index Doc lists them.
  function contentBoxes() {
    const fr = uniqueFrames(), used = new Set();
    return BOX_ORDER.map(l => fr.find(e => !used.has(e) && boxRe(l).test(e.label || '') && used.add(e))).filter(Boolean);
  }
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
  // what the Content Index Doc writes where Salesforce has a picture, video or embed
  const META = /^(Published link|KA ID|Version|Last modified in Salesforce|Current refresh|Previous refresh):/;
  // the Content Index leaves out "(Return to contents)" links: so does the match
  const TOC_BACK = /^\(?\s*(table\s*of\s*contents|return\s*to\s*contents)\s*\)?$/i;
  const TOC_BACK_INLINE = /\(\s*(table\s*of\s*contents|return\s*to\s*contents)\s*\)/gi;
  const PLACEHOLDER = /^\s*\[(Image|Video|Embedded content)\b[^\]]*\]\s*$/;

  // Doc -> tokens {ch, add, del, href, b, i, blk, tag, lvl, tr, td} (+ image tokens), with block boundaries as spaces.
  function docTokens(html) {
    const d = new DOMParser().parseFromString(html, 'text/html'), rules = cssRules(d);
    let out = []; let blk = 0, blockEl = null, lvl = null, ltag = null, trN = 0;
    const unwrap = h => { const m = String(h || '').match(/[?&]q=([^&]+)/); return m && /google\.com\/url/.test(h) ? decodeURIComponent(m[1]) : h; };
    // list level: Google writes it in the list class (lst-kix_..-1 = second level); real nesting counts too
    const levelOf = li => { const list = li.parentElement; const m = list && (list.className || '').match(/lst-kix_[\w]*?-(\d+)\b/);
      let n = 0; for (let x = list && list.parentElement; x; x = x.parentElement) if (x.tagName === 'LI') n++; return (m ? +m[1] : 0) + n; };
    const walk = (n, ctx) => {
      if (n.nodeType === 3) {
        for (const raw of n.data) { const ch = normCh(raw); if (ch) out.push(Object.assign({ ch, blk, tag: blockEl && blockEl.tagName, lvl, ltag }, ctx)); }
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
      if (n.tagName === 'TR') nc.tr = ++trN;
      if (n.tagName === 'TD' || n.tagName === 'TH') nc.td = Array.prototype.indexOf.call(n.parentElement.children, n);
      if (n.tagName === 'IMG') { out.push({ img: n.getAttribute('src'), blk, tag: blockEl && blockEl.tagName, lvl }); return; }
      const isBlock = BLOCK.test(n.tagName);
      if (isBlock) { out.push({ ch: ' ', sep: true }); if (LEAF_BLOCK.test(n.tagName)) { blk++; blockEl = n; lvl = n.tagName === 'LI' ? levelOf(n) : null; ltag = n.tagName === 'LI' && n.parentElement ? n.parentElement.tagName : null; } }
      n.childNodes.forEach(k => walk(k, nc));
      if (isBlock) out.push({ ch: ' ', sep: true });
    };
    walk(d.body, {});
    const byBlk = {}, byTr = {};
    out.forEach(t => { if (t.blk == null || t.img || t.sep) return;
      if (!t.ch.trim()) { if (byBlk[t.blk]) byBlk[t.blk].txt += ' '; return; }
      const b = byBlk[t.blk] || (byBlk[t.blk] = { all: true, any: false, txt: '', del: true }); if (!t.add) b.all = false; else b.any = true; if (!t.del) b.del = false; b.txt += t.ch;
      if (t.tr) { const r = byTr[t.tr] || (byTr[t.tr] = { all: true }); if (!t.add) r.all = false; } });
    // "[Image: ...]" lines are the Doc's stand-ins for Salesforce pictures: not text, leave them out
    const ph = new Set(Object.keys(byBlk).filter(k => PLACEHOLDER.test(byBlk[k].txt) && !byBlk[k].any).map(Number));
    const imgDeletes = [...ph].filter(k => byBlk[k].del).length;
    // the Content Index page header (KA details) and the title on top are not part of the boxes
    const h1 = out.find(t => t.tag === 'H1' && t.ch && t.ch.trim());
    const before = h1 ? Object.keys(byBlk).filter(k => +k < h1.blk) : [];
    const cut = h1 && before.every(k => META.test(byBlk[k].txt.trim())) ? h1.blk : -1;
    const meta = new Set(Object.keys(byBlk).filter(k => META.test(byBlk[k].txt.trim()) && (cut < 0 || +k < cut)).map(Number));
    let title = null;
    if (cut >= 0) {
      const tt = out.filter(t => t.blk === cut && !t.sep && !t.img && t.ch);
      const join = f => tt.filter(f).map(t => t.ch).join('').replace(/\s+/g, ' ').trim();
      title = { old: join(t => !t.add), now: join(t => !t.del), changed: tt.some(t => t.add || t.del) };
    }
    out = Object.assign(out.filter(t => t.sep || t.blk == null || !(ph.has(t.blk) || meta.has(t.blk) || (cut >= 0 && t.blk <= cut))), { imgDeletes, title });
    // a block is "new" when every visible character in it is green; a table row too
    out.forEach(t => { if (t.blk != null && byBlk[t.blk] && byBlk[t.blk].all) t.newBlock = true; if (t.tr && byTr[t.tr] && byTr[t.tr].all) t.newRow = t.tr; });
    out.forEach(t => { if (t.img && byBlk[t.blk] && byBlk[t.blk].any) t.add = true; });
    return out;
  }
  // Editor body -> chars {ch, node, off, el}; block boundaries are spaces with no node.
  function sfTokens(body) {
    const out = [], skip = new Map();   // text node -> Set of offsets left out
    const skipAt = (node, i) => (skip.get(node) || skip.set(node, new Set()).get(node)).add(i);
    body.querySelectorAll('a').forEach(a => {
      if (!TOC_BACK.test((a.textContent || '').trim())) return;
      a.setAttribute('data-kwp-skip', '1');
      const pv = a.previousSibling, nx = a.nextSibling;
      if (pv && pv.nodeType === 3) { const m = pv.data.match(/\(\s*$/); if (m) for (let i = m.index; i < pv.data.length; i++) skipAt(pv, i); }
      if (nx && nx.nodeType === 3) { const m = nx.data.match(/^\s*\)/); if (m) for (let i = 0; i < m[0].length; i++) skipAt(nx, i); }
    });
    const walk = (n, el) => {
      if (n.nodeType === 3) {
        if (TOC_BACK.test(n.data.trim())) return;
        let m; TOC_BACK_INLINE.lastIndex = 0;
        while ((m = TOC_BACK_INLINE.exec(n.data))) for (let i = m.index; i < m.index + m[0].length; i++) skipAt(n, i);
        const sk = skip.get(n);
        for (let i = 0; i < n.data.length; i++) { if (sk && sk.has(i)) continue; const ch = normCh(n.data[i]); if (ch) out.push({ ch, node: n, off: i, el }); }
        return;
      }
      if (n.nodeType !== 1 || /^(STYLE|SCRIPT)$/.test(n.tagName)) return;
      if (n.getAttribute('data-kwp-skip')) { n.removeAttribute('data-kwp-skip'); return; }
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
  function allBoxTokens(boxes) {
    let all = [];
    boxes.forEach(bx => { all.push({ ch: ' ', sep: true }); all = all.concat(sfTokens(bx.el)); });
    return all;
  }
  const slug = s => String(s).toLowerCase().replace(/^[\s\d.]+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  const plainText = s => String(s || '').replace(/[\u00A0\s]+/g, ' ').trim().toLowerCase();

  async function updateFromDoc(add, link) {
    const boxes = contentBoxes();
    if (!boxes.length) { add(false, 'Update from Doc', 'No content boxes on screen. Click Edit first.'); return 'stop'; }
    const docId = (link.match(/\/d\/([A-Za-z0-9_-]{20,})/) || [])[1];
    if (!docId) { add(false, 'Update from Doc', 'That is not a Google Doc link'); return 'retry'; }
    let html;
    try { html = await gmGet('https://docs.google.com/document/d/' + docId + '/export?format=html'); }
    catch (e) { add(false, '1. Read the Doc', e.message + '. Is it shared with you and are you signed into Google?'); return 'retry'; }
    if (/<title>[^<]*Sign in/i.test(html)) { add(false, '1. Read the Doc', 'Google asked to sign in'); return 'retry'; }
    const toks = docTokens(html);
    const adds = toks.filter(t => t.add && !t.img).length, dels = toks.filter(t => t.del).length, imgs = toks.filter(t => t.img && t.add).length;
    add(adds + dels + imgs > 0, '1. Read the Doc', (adds + dels + imgs ? '' : 'NO changes found. ') + 'green: ' + adds + ' characters, red: ' + dels + ' characters, new images: ' + imgs);

    // 2. Parity: the Doc without the green (and with the red as normal text) must equal Salesforce (all boxes, in order)
    const sf = collapse(allBoxTokens(boxes), () => true);
    const orig = collapse(toks.filter(t => !t.img), t => !t.add);
    const a = orig.map(t => t.ch).join(''), b = sf.map(t => t.ch).join('');
    if (a !== b) {
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      add(false, '2. 100% match with Salesforce', 'NO MATCH, nothing was changed. First difference at character ' + i +
        ': Doc says "\u2026' + a.slice(Math.max(0, i - 40), i + 40) + '\u2026" but Salesforce has "\u2026' + b.slice(Math.max(0, i - 40), i + 40) + '\u2026". ' +
        'Make a fresh copy of the Content Index Doc, or mark that change in red/green.');
      return 'retry';
    }
    add(true, '2. 100% match with Salesforce', a.length + ' characters match in ' + boxes.length + ' boxes (not counting the changes)');

    // 3. Plan the edits: each Doc token is placed against the Salesforce position it sits before.
    const ops = [];   // {at, kind:'del'|'ins'|'block'|'row'|'img', ...}
    let k = 0; const origSet = new Set(orig);
    let pendingIns = null, pendingBlock = null, pendingRow = null;
    const flush = () => { [pendingIns, pendingBlock, pendingRow].forEach(p => p && ops.push(p)); pendingIns = pendingBlock = pendingRow = null; };
    for (const t of toks) {
      if (origSet.has(t)) { flush(); if (t.del) ops.push({ at: k, kind: 'del' }); k++; continue; }
      if (t.img && t.add) { flush(); ops.push({ at: k, kind: 'img', src: t.img, blk: t.blk }); continue; }
      if (!t.add || t.sep) continue;
      if (t.newRow) {
        if (!pendingRow || pendingRow.tr !== t.newRow) { flush(); pendingRow = { at: k, kind: 'row', tr: t.newRow, cells: {} }; }
        (pendingRow.cells[t.td] || (pendingRow.cells[t.td] = [])).push(t);
      } else if (t.newBlock) {
        if (pendingIns) { ops.push(pendingIns); pendingIns = null; }
        if (!pendingBlock || pendingBlock.blk !== t.blk) { if (pendingBlock) ops.push(pendingBlock); pendingBlock = { at: k, kind: 'block', blk: t.blk, tag: t.tag, lvl: t.lvl, ltag: t.ltag, runs: [] }; }
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

    const fragOf = (runs, doc, anc) => {
      anc = anc || {};
      const f = doc.createDocumentFragment(); let i = 0;
      const key = r => [r.href && r.href !== anc.href ? r.href : '', r.b && !anc.b ? 1 : 0, r.i && !anc.i ? 1 : 0].join('|');
      while (i < runs.length) {
        const r = runs[i], kk = key(r); let txt = ''; let j = i;
        while (j < runs.length && key(runs[j]) === kk) { txt += runs[j].ch; j++; }
        const [href, bb, ii] = kk.split('|');
        let node = doc.createTextNode(txt);
        if (bb === '1') { const s = doc.createElement('strong'); s.appendChild(node); node = s; }
        if (ii === '1') { const s = doc.createElement('em'); s.appendChild(node); node = s; }
        if (href) { const aEl = doc.createElement('a'); aEl.setAttribute('href', href); if (!/^#/.test(href)) aEl.setAttribute('target', '_blank'); aEl.appendChild(node); node = aEl; }
        f.appendChild(node); i = j;
      }
      return f;
    };
    const real = idx => { for (let x = idx; x >= 0; x--) if (sf[x] && !sf[x].sep && sf[x].node) return sf[x]; return null; };
    const realFwd = idx => { for (let x = idx; x < sf.length; x++) if (sf[x] && !sf[x].sep && sf[x].node) return sf[x]; return null; };
    const pe = t => t && t.node && t.node.parentElement;
    const boxOf = t => t && t.node && t.node.ownerDocument.body;

    // 3a. deletions: whole table rows, whole blocks, or characters
    const delIdx = new Set(ops.filter(o => o.kind === 'del').map(o => o.at));
    const blocksAll = new Map(), rowsAll = new Map();
    sf.forEach((t, i) => { if (!t.node) return;
      if (t.el) { const e = blocksAll.get(t.el) || { n: 0, d: 0 }; e.n++; if (delIdx.has(i)) e.d++; blocksAll.set(t.el, e); }
      const tr = pe(t).closest('tr'); if (tr) { const e = rowsAll.get(tr) || { n: 0, d: 0 }; e.n++; if (delIdx.has(i)) e.d++; rowsAll.set(tr, e); } });
    let removedBlocks = 0, removedChars = 0, removedRows = 0;
    // elements that receive new text inline must stay; table cells and dropdown titles are never removed on their own
    const keepEls = new Set();
    ops.filter(o => o.kind === 'ins').forEach(o => { const pr = sf[o.at - 1], nx = sf[o.at];
      keepEls.add(pr && pr.node && (!nx || !nx.node || pr.el === nx.el) ? pr.el : (nx && nx.el)); });
    const killRows = [...rowsAll].filter(([tr, e]) => e.n > 0 && e.d === e.n && ![...keepEls].some(el => el && tr.contains(el))).map(([tr]) => tr);
    const inKilledRow = el => killRows.some(tr => tr.contains(el));
    const killEls = [...blocksAll].filter(([el, e]) => e.n > 0 && e.d === e.n && !keepEls.has(el) && !/^(TD|TH|SUMMARY)$/.test(el.tagName) && !inKilledRow(el)).map(([el]) => el);
    // character deletions, highest offset first inside each text node
    const perNode = new Map();
    [...delIdx].forEach(i => { const t = sf[i]; if (!t || !t.node || killEls.includes(t.el) || inKilledRow(t.node.parentElement)) return; (perNode.get(t.node) || perNode.set(t.node, []).get(t.node)).push(t.off); });

    // 3b. inserts, new blocks and new rows (from the end so earlier positions stay valid)
    const inserts = ops.filter(o => o.kind === 'ins' || o.kind === 'block' || o.kind === 'row').sort((x, y) => y.at - x.at);
    const newEls = [], touched = new Set(boxes.map(bx => bx.el));
    let insChars = 0, newRows = 0;
    const groups = [];
    inserts.forEach(o => { const g = o.kind === 'block' && groups.find(gg => gg.at === o.at && gg.kind === 'block'); if (g) g.list.push(o); else groups.push({ at: o.at, kind: o.kind, list: [o] }); });
    const liDepth = li => { let d = -1; for (let x = li.parentElement; x && x.tagName !== 'BODY'; x = x.parentElement) if (/^(UL|OL)$/.test(x.tagName)) d++; return d; };
    const liOf = t => t && pe(t) && pe(t).closest('li');
    for (const g of groups) {
      if (g.kind === 'ins') {
        const o = g.list[0];
        const prev = sf[o.at - 1], next = sf[o.at];
        let node, off;
        if (prev && prev.node && (!next || !next.node || prev.el === next.el)) { node = prev.node; off = prev.off + 1; }
        else if (next && next.node) { node = next.node; off = next.off; }
        else { const p2 = real(o.at - 1); node = p2.node; off = p2.off + 1; }
        const doc = node.ownerDocument, par = node.parentElement;
        const ancA = par.closest('a');
        const anc = { b: !!par.closest('strong,b'), i: !!par.closest('em,i'), href: ancA ? ancA.getAttribute('href') : null };
        const after = node.splitText(Math.min(off, node.data.length));
        // plain text typed right after a link goes after the link, not inside it
        if (ancA && !o.runs[0].href && !after.data.length && !after.nextSibling && ancA.lastChild === after) { anc.href = null; ancA.parentNode.insertBefore(fragOf(o.runs, doc, anc), ancA.nextSibling); }
        else node.parentNode.insertBefore(fragOf(o.runs, doc, anc), after);
        const offs = perNode.get(node);
        if (offs) { const moved = offs.filter(x => x >= off).map(x => x - off); perNode.set(node, offs.filter(x => x < off)); if (moved.length) perNode.set(after, (perNode.get(after) || []).concat(moved)); }
        insChars += o.runs.length;
      } else if (g.kind === 'row') {
        const o = g.list[0];
        const pb = real(o.at - 1), nb = realFwd(o.at);
        const pTr = pb && pe(pb).closest('tr'), nTr = nb && pe(nb).closest('tr');
        const ref = pTr || nTr; if (!ref) continue;
        const table = ref.closest('table');
        const tmpl = (ref.querySelector('td') ? ref : (table.querySelector('td') || {}).parentElement) || ref;
        const doc = ref.ownerDocument, tr = tmpl.cloneNode(false);
        Array.from(tmpl.children).forEach((cell, ci) => { const c2 = cell.cloneNode(false); const runs = o.cells[ci];
          if (runs) c2.appendChild(fragOf(runs, doc)); else c2.innerHTML = '<br>'; tr.appendChild(c2); });
        if (pTr) pTr.parentNode.insertBefore(tr, pTr.nextSibling); else nTr.parentNode.insertBefore(tr, nTr);
        newRows++;
      } else {
        const list = g.list.sort((x, y) => x.blk - y.blk);
        const nb = realFwd(g.at), pb = real(g.at - 1);
        const make = (o, doc) => { const t2 = (o.tag || 'P').toLowerCase(); const el = doc.createElement(/^(td|th|summary)$/.test(t2) ? 'p' : t2);
          // headings carry their own style: no extra bold/italic
          const runs = /^h\d$/.test(t2) ? o.runs.map(r => Object.assign({}, r, { b: false, i: false })) : o.runs;
          el.appendChild(fragOf(runs, doc)); if (o.img) el.setAttribute('data-kwp-img', o.img); newEls.push(el); return el; };
        const topOf = el => { while (el && el.parentNode && el.parentNode.tagName !== 'BODY') el = el.parentNode; return el; };
        const inList = el => el && el.parentNode && /^(UL|OL)$/.test(el.parentNode.tagName);
        const outerList = li => { let x = li; while (x.parentElement && /^(UL|OL|LI)$/.test(x.parentElement.tagName)) x = x.parentElement; return x; };
        const after = (ref, el) => { ref.parentNode.insertBefore(el, ref.nextSibling); return el; };
        // bullets at their level: next to the bullet before (anchor), or before the bullet after (nLi)
        const placeLis = (items, anchor, nLi) => {
          let first = true;
          for (const o of items) {
            const want = o.lvl == null ? null : o.lvl;
            if (anchor) {
              const el = make(o, anchor.ownerDocument);
              let d = liDepth(anchor);
              if (want != null && want > d) {
                const sub = Array.from(anchor.children).find(c => /^(UL|OL)$/.test(c.tagName));
                if (sub && first) sub.insertBefore(el, sub.firstChild);
                else if (sub) sub.appendChild(el);
                else { const nl = anchor.ownerDocument.createElement(o.ltag === 'OL' ? 'ol' : 'ul'); nl.appendChild(el); anchor.appendChild(nl); }
              } else {
                let a2 = anchor;
                while (want != null && d > want && a2.parentElement.closest('li')) { a2 = a2.parentElement.closest('li'); d = liDepth(a2); }
                after(a2, el);
              }
              anchor = el;
            } else {
              const el = make(o, nLi.ownerDocument);
              let a2 = nLi, d = liDepth(a2);
              while (want != null && d > want && a2.parentElement.closest('li')) { a2 = a2.parentElement.closest('li'); d = liDepth(a2); }
              a2.parentNode.insertBefore(el, a2);
              anchor = el;
            }
            first = false;
          }
          return anchor;
        };
        // split into runs of bullets / other blocks, placed one after the other
        const segs = [];
        list.forEach(o => { const li = (o.tag || 'P') === 'LI', l = segs[segs.length - 1]; if (l && l.li === li) l.items.push(o); else segs.push({ li, items: [o] }); });
        let last = null;
        segs.forEach((sg, si) => {
          if (si > 0) {
            if (sg.li) {
              const ref = last.tagName === 'LI' ? outerList(last) : last;
              const nl = after(ref, ref.ownerDocument.createElement(sg.items[0].ltag === 'OL' ? 'ol' : 'ul'));
              const firstEl = make(sg.items[0], nl.ownerDocument); nl.appendChild(firstEl);
              last = sg.items.length > 1 ? placeLis(sg.items.slice(1), firstEl, null) : firstEl;
            } else {
              let ref = last.tagName === 'LI' ? outerList(last) : last;
              sg.items.forEach(o => { ref = after(ref, make(o, ref.ownerDocument)); });
              last = ref;
            }
            return;
          }
          if (sg.li && (liOf(pb) || liOf(nb))) {
            let anchor = liOf(pb);
            const nLi = liOf(nb);
            // the bullet before belongs to another part of the article: this is a new first bullet of the next list
            if (anchor && nLi && topOf(anchor) !== topOf(nLi) && !anchor.closest('ul,ol').contains(nLi)) {
              const between = anchor.closest('ul,ol') !== nLi.closest('ul,ol');
              if (between) anchor = null;
            }
            if (!anchor && !nLi) anchor = liOf(pb);
            last = placeLis(sg.items, anchor, anchor ? null : nLi);
          } else if (!sg.li && pb && pb.el && !inList(pb.el) && !/^(TD|TH|SUMMARY)$/.test(pb.el.tagName) && pb.el.parentNode.tagName !== 'BODY' && !pe(pb).closest('table')) {
            let ref = pb.el; sg.items.forEach(o => { ref = after(ref, make(o, ref.ownerDocument)); }); last = ref;
          } else if (nb && nb.el && (!pb || boxOf(pb) === boxOf(nb) || !pb.el)) {
            const top = topOf(nb.el);
            if (sg.li) { const nl = top.ownerDocument.createElement(sg.items[0].ltag === 'OL' ? 'ol' : 'ul'); top.parentNode.insertBefore(nl, top);
              const firstEl = make(sg.items[0], nl.ownerDocument); nl.appendChild(firstEl); last = sg.items.length > 1 ? placeLis(sg.items.slice(1), firstEl, null) : firstEl; }
            else sg.items.forEach(o => { last = make(o, top.ownerDocument); top.parentNode.insertBefore(last, top); });
          } else if (pb && pb.el) {
            let ref = topOf(pb.el);
            if (sg.li) { const nl = after(ref, ref.ownerDocument.createElement(sg.items[0].ltag === 'OL' ? 'ol' : 'ul'));
              const firstEl = make(sg.items[0], nl.ownerDocument); nl.appendChild(firstEl); last = sg.items.length > 1 ? placeLis(sg.items.slice(1), firstEl, null) : firstEl; }
            else { sg.items.forEach(o => { ref = after(ref, make(o, ref.ownerDocument)); }); last = ref; }
          } else {
            const bd = boxes[0].el;
            if (sg.li) { const nl = bd.ownerDocument.createElement(sg.items[0].ltag === 'OL' ? 'ol' : 'ul'); bd.appendChild(nl); sg.items.forEach(o => nl.appendChild(last = make(o, bd.ownerDocument))); }
            else sg.items.forEach(o => bd.appendChild(last = make(o, bd.ownerDocument)));
          }
        });
      }
    }
    perNode.forEach((offs, node) => { offs.sort((x, y) => y - x).forEach(o => { node.deleteData(o, 1); removedChars++; }); });
    killEls.forEach(el => { const parent = el.parentNode; el.remove(); removedBlocks++; if (parent && /^(UL|OL)$/.test(parent.tagName) && !parent.querySelector('li')) parent.remove(); });
    killRows.forEach(tr => { tr.remove(); removedRows++; });
    // new headings get an anchor; a new Contents entry that names a heading links to it
    newEls.filter(e => /^H[1-6]$/.test(e.tagName) && !e.id).forEach(h => { h.id = slug(h.textContent); });
    newEls.filter(e => e.tagName === 'LI' && !e.querySelector('a')).forEach(li => {
      const list = li.parentElement; if (!list || !list.querySelector('a[href^="#"]')) return;
      const txt = plainText(li.textContent);
      const h = Array.from(li.ownerDocument.querySelectorAll('h1,h2,h3,h4')).find(x => plainText(x.textContent).replace(/^[\d.\s]+/, '') === txt);
      if (!h) return; if (!h.id) h.id = slug(h.textContent);
      const aEl = li.ownerDocument.createElement('a'); aEl.setAttribute('href', '#' + h.id);
      while (li.firstChild) aEl.appendChild(li.firstChild); li.appendChild(aEl);
    });
    touched.forEach(bd => bd.dispatchEvent(new Event('input', { bubbles: true })));
    // the title (top of the Doc)
    if (toks.title && toks.title.changed) {
      const ti = inputByLabel(/^title\b/i);
      if (!ti) add(false, '3. Title', 'Title box not found. Change it by hand to: ' + toks.title.now);
      else { const was = ti.value; add(typeInto(ti, toks.title.now), '3. Title', '"' + was + '" \u2192 "' + toks.title.now + '"' + (was.trim() !== toks.title.old ? ' (note: the Doc had "' + toks.title.old + '")' : '')); }
    }
    add(true, '3. Changes applied', insChars + ' characters added inline \u00B7 ' + newEls.length + ' new paragraphs/bullets/steps/headings \u00B7 ' + newRows + ' new table rows \u00B7 ' +
      removedChars + ' characters removed \u00B7 ' + removedBlocks + ' bullets/paragraphs removed \u00B7 ' + removedRows + ' table rows removed');

    // 4. New images: download from the Doc and paste them like a writer
    let imgOk = 0, imgAll = 0;
    for (const el of newEls.filter(e => e.getAttribute('data-kwp-img'))) {
      imgAll++;
      try {
        const blob = await gmGet(el.getAttribute('data-kwp-img'), 'blob');
        const doc = el.ownerDocument, holder = doc.createElement('p'); holder.innerHTML = '<br>'; el.parentNode.insertBefore(holder, el.nextSibling);
        if (await pasteFile(doc, doc.body, holder, new File([blob], 'doc-image.png', { type: blob.type || 'image/png' }))) imgOk++;
      } catch (e) { /* reported below */ }
      el.removeAttribute('data-kwp-img');
    }
    const loose = ops.filter(o => o.kind === 'img' && !o.done).length;
    if (imgAll || loose) add(imgOk === imgAll && !loose, '4. New images', imgOk + ' of ' + imgAll + ' pasted and uploaded' + (loose ? ' \u00B7 ' + loose + ' image(s) not inside a green paragraph: add them by hand' : ''));
    if (toks.imgDeletes) add(false, '4. Images to remove', toks.imgDeletes + ' picture(s) are crossed out in red in the Doc. Delete them by hand in the box.');

    // 5. Check: the boxes now equal the Doc with the red removed and the green kept
    const want = collapse(toks.filter(t => !t.img), t => !t.del).map(t => t.ch).join('');
    const now = collapse(allBoxTokens(boxes), () => true).map(t => t.ch).join('');
    let i2 = 0; while (i2 < want.length && want[i2] === now[i2]) i2++;
    add(want === now, '5. Final check', want === now ? 'The boxes now match the Doc with the changes. Review them, then click Save.' :
      'Almost: first difference at ' + i2 + ': wanted "\u2026' + want.slice(Math.max(0, i2 - 30), i2 + 30) + '\u2026", box has "\u2026' + now.slice(Math.max(0, i2 - 30), i2 + 30) + '\u2026". Review before saving.');
    return 'done';
  }

  // The link goes in a field inside the box: it stays open while the writer goes to the Doc and back.
  function askLink(id, lines, note) {
    return new Promise(resolve => {
      render(id, lines, false);
      const box = document.getElementById('kwp-box');
      const w = document.createElement('div');
      let last = ''; try { last = sessionStorage.getItem('kwp-doc-link') || ''; } catch (e) { /* private window */ }
      w.innerHTML = '<div style="font-weight:700;margin:8px 0 4px">Update from Doc</div>' +
        (note ? '<div style="font-size:12px;color:#C5221F;margin-bottom:4px">' + esc(note) + '</div>' : '') +
        '<div style="font-size:12px;color:#5B5D62;margin-bottom:6px">Paste the link of your copy of the Content Index Doc (red strikethrough = delete, green = add). ' +
        'You can go to the Doc and come back: this box stays open.</div>' +
        '<input id="kwp-link" type="text" placeholder="https://docs.google.com/document/d/..." style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #c9c9c9;border-radius:6px;font-size:12px">' +
        '<div style="margin-top:8px"><button class="kwp-b kwp-grey" id="kwp-paste">Paste copied link</button><button class="kwp-b" id="kwp-go">Apply changes</button>' +
        '<button class="kwp-b kwp-grey" id="kwp-cancel">Close</button></div>';
      box.appendChild(w);
      const inp = w.querySelector('#kwp-link'); inp.value = last;
      ['keydown', 'keyup', 'keypress'].forEach(ev => inp.addEventListener(ev, e => e.stopPropagation()));
      w.querySelector('#kwp-paste').onclick = async () => {
        try { inp.value = (await navigator.clipboard.readText()).trim(); } catch (e) { inp.focus(); inp.placeholder = 'Click here and press Cmd+V'; }
      };
      w.querySelector('#kwp-go').onclick = () => {
        const v = inp.value.trim();
        if (!/\/d\/[A-Za-z0-9_-]{20,}/.test(v)) { inp.style.borderColor = '#C5221F'; inp.placeholder = 'Paste a Google Doc link first'; return; }
        try { sessionStorage.setItem('kwp-doc-link', v); } catch (e) { /* private window */ }
        w.remove(); render(id, lines, true); resolve(v);
      };
      w.querySelector('#kwp-cancel').onclick = () => { w.remove(); resolve(null); };
    });
  }


    GM_addStyle(`
      #kwp-box { position: fixed; top: 110px; left: 20px; z-index: 2147483647; width: 380px;
        background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.16);
        padding: 14px 16px; font: 13px/1.5 -apple-system, sans-serif; color: #2F3033;
        max-height: calc(100vh - 130px); overflow-y: auto; }
      #kwp-box .ok { color: #1E8E3E; } #kwp-box .no { color: #C5221F; }
      .kwp-b { padding: 6px 12px; font-size: 12px; font-weight: 600; border: none; border-radius: 100px;
        background: #0E7490; color: #fff; cursor: pointer; margin-right: 6px; }
      .kwp-grey { background: #8A8D91; }
    `);
    function render(id, lines, running, finished) {
      let box = document.getElementById('kwp-box');
      if (!box) { box = document.createElement('div'); box.id = 'kwp-box'; document.body.appendChild(box); }
      box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">\u270E Update from Doc' + (running ? ' \u00B7 working\u2026' : '') + '</div>' +
        (finished ? '<div style="margin-bottom:8px"><button class="kwp-b" id="kwp-copy">Copy results</button><button class="kwp-b kwp-grey" id="kwp-close">Close</button></div>' : '') +
        lines.map(l => '<div><b class="' + (l.ok ? 'ok' : 'no') + '">' + (l.ok ? '\u2713' : '\u2717') + '</b> <b>' + esc(l.label) + '</b>' +
          (l.detail ? '<div style="font-size:12px;color:#5B5D62;margin-left:16px">' + esc(l.detail) + '</div>' : '') + '</div>').join('');
      if (finished) {
        const text = 'Update from Doc (KA Refresh ' + SCRIPT_VERSION + ') - record ' + id + '\n' + lines.map(l => (l.ok ? 'OK   ' : 'FAIL ') + l.label + (l.detail ? ' - ' + l.detail : '')).join('\n');
        document.getElementById('kwp-copy').onclick = async () => {
          try { await navigator.clipboard.writeText(text); document.getElementById('kwp-copy').textContent = 'Copied \u2713'; }
          catch (e) { window.prompt('Copy this:', text); }
        };
        document.getElementById('kwp-close').onclick = () => box.remove();
      }
    }
    let running = false;
    async function run() {
      if (running) return;
      const id = (location.href.match(/\/Knowledge__kav\/([a-zA-Z0-9]{15,18})/) || [])[1] || '';
      const lines = [];
      const add = (ok, label, detail) => { lines.push({ ok, label, detail: detail || '' }); render(id, lines, true); };
      running = true;
      try {
        if (!id) add(false, 'Open the KA first', 'Open the DRAFT of the KA in Salesforce.');
        else if (!contentBoxes().length) add(false, 'Click Edit first', 'Open the DRAFT of the KA, click Edit (pencil), wait for the content boxes to load, then click \u270E Update from Doc again.');
        else {
          const base = lines.length; let note = '';
          for (;;) {
            const link = await askLink(id, lines, note);
            if (!link) { add(true, 'Closed', 'Nothing was changed.'); break; }
            lines.length = base;
            if (await updateFromDoc(add, link) !== 'retry') break;
            note = 'Nothing was changed. Fix the Doc (or make a fresh copy) and click Apply changes again.';
          }
        }
      } catch (e) { add(false, 'Error', String(e && e.message || e)); }
      running = false;
      render(id, lines, false, true);
    }
    return { run };
  })();

  function injectUI() {
    if (document.getElementById('kar-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'kar-bar';
    bar.innerHTML =
      '<button class="kar-main-btn" id="kar-update-btn">\u2191 Update</button>' +
      '<button class="kar-main-btn" id="kar-new-btn">+ New</button>' +
      '<button class="kar-main-btn" id="kar-outdated-btn">\u27F3 Refresh outdated</button>' +
      '<button class="kar-main-btn" id="kar-batch-btn">\u27F3 Refresh all</button>' +
      '<button class="kar-main-btn" id="kar-audit-btn">\uD83D\uDCCB Audit</button>' +
      '<button class="kar-main-btn" id="kar-fix-btn">\u2713 Fix from audit</button>' +
      '<button class="kar-main-btn" id="kar-ufd-btn">\u270E Update from Doc</button>';
    document.body.appendChild(bar);
    const overlay = document.createElement('div');
    overlay.id = 'kar-overlay';
    overlay.innerHTML = '<div id="kar-overlay-body"></div>';
    document.body.appendChild(overlay);
    document.getElementById('kar-update-btn').addEventListener('click', () => runIntent('update'));
    document.getElementById('kar-new-btn').addEventListener('click', () => runIntent('new'));
    document.getElementById('kar-ufd-btn').addEventListener('click', () => UFD.run());
    document.getElementById('kar-batch-btn').addEventListener('click', () => startBatch(0));
    document.getElementById('kar-outdated-btn').addEventListener('click', () => startBatch(0, 'outdated'));
    document.getElementById('kar-audit-btn').addEventListener('click', () => startAudit());
    document.getElementById('kar-fix-btn').addEventListener('click', () => openFixList());
  }

  function setButtonsDisabled(disabled) {
    for (const id of ['kar-update-btn', 'kar-new-btn', 'kar-outdated-btn', 'kar-batch-btn', 'kar-audit-btn', 'kar-fix-btn']) {
      const b = document.getElementById(id);
      if (b) b.disabled = disabled;
    }
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function _overlayBody() { return document.getElementById('kar-overlay-body'); }
  function _showOverlay() {
    const o = document.getElementById('kar-overlay');
    if (o) o.classList.add('visible');
  }
  function _reviewerFooter() {
    const r = GM_getValue(K_REVIEWER, '');
    return '<div class="kar-meta">Reviewer: ' + escHtml(r || '\u2014') +
      ' \u00B7 <a id="kar-change-rev">change</a></div>';
  }
  function _wireReviewerLink() {
    const link = document.getElementById('kar-change-rev');
    if (link) link.addEventListener('click', () => {
      GM_setValue(K_REVIEWER, '');
      ensureReviewer();
    });
  }

  function setStatus(kind, msg) {
    const body = _overlayBody();
    if (!body) return;
    const spinner = kind === 'loading' ? '<span class="kar-spinner"></span>' : '';
    body.innerHTML = '<div class="kar-title ' + kind + '">' + spinner + escHtml(msg) + '</div>' + _reviewerFooter();
    _showOverlay();
    _wireReviewerLink();
  }

  function setDoneStatus(msg, docUrl) {
    const body = _overlayBody();
    if (!body) return;
    body.innerHTML = '<div class="kar-title success">\u2713 ' + escHtml(msg) + '</div>' +
      (docUrl ? '<a href="' + escHtml(docUrl) + '" target="_blank">Open the Doc \u2197</a>' : '') +
      _reviewerFooter();
    _showOverlay();
    _wireReviewerLink();
  }

  function setSkipStatus(msg, docUrl) {
    const body = _overlayBody();
    if (!body) return;
    body.innerHTML = '<div class="kar-title skip">' + escHtml(msg) + '</div>' +
      (docUrl ? '<a href="' + escHtml(docUrl) + '" target="_blank">Open the Doc \u2197</a><br>' : '') +
      '<button class="kar-mini-btn warn" id="kar-force">Sync anyway</button>' +
      _reviewerFooter();
    _showOverlay();
    _wireReviewerLink();
    const f = document.getElementById('kar-force');
    if (f) f.addEventListener('click', () => runIntent('update', { force: true }));
  }

  // The SOP mistake-catcher: wrong button -> friendly redirect to the right one.
  function setMismatchStatus(msg, btnLabel, redirectIntent, docUrl) {
    const body = _overlayBody();
    if (!body) return;
    body.innerHTML = '<div class="kar-title mismatch">' + escHtml(msg) + '</div>' +
      (docUrl ? '<a href="' + escHtml(docUrl) + '" target="_blank">Open the existing Doc \u2197</a><br>' : '') +
      '<button class="kar-mini-btn blue" id="kar-redirect">' + escHtml(btnLabel) + '</button>' +
      _reviewerFooter();
    _showOverlay();
    _wireReviewerLink();
    const r = document.getElementById('kar-redirect');
    if (r) r.addEventListener('click', () => runIntent(redirectIntent));
  }

  function ensureReviewer() {
    const stored = GM_getValue(K_REVIEWER, '');
    if (stored) return Promise.resolve(stored);
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.id = 'kar-modal-backdrop';
      backdrop.innerHTML =
        '<div id="kar-modal"><h3>Your first name?</h3>' +
        '<p>Appears as the reviewer in the Doc header.</p>' +
        '<input id="kar-rev-input" type="text" placeholder="e.g. Tiffany">' +
        '<button class="kar-primary" id="kar-rev-save">Save</button></div>';
      document.body.appendChild(backdrop);
      const input = document.getElementById('kar-rev-input');
      input.focus();
      function save() {
        const name = input.value.trim();
        if (!name) return;
        GM_setValue(K_REVIEWER, name);
        backdrop.remove();
        resolve(name);
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      document.getElementById('kar-rev-save').addEventListener('click', save);
    });
  }

  function promptAudience() {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.id = 'kar-modal-backdrop';
      let opts = '';
      for (const a of AUDIENCES) {
        opts += '<button class="kar-opt" data-aud="' + escHtml(a) + '">' + escHtml(a) + '</button>';
      }
      backdrop.innerHTML =
        '<div id="kar-modal"><h3>New Doc \u2014 audience?</h3>' +
        '<p>Pick the audience for the filename.</p>' +
        opts +
        '<button class="kar-cancel" id="kar-aud-cancel">Cancel</button></div>';
      document.body.appendChild(backdrop);
      backdrop.querySelectorAll('.kar-opt').forEach(b => {
        b.addEventListener('click', () => { backdrop.remove(); resolve(b.getAttribute('data-aud')); });
      });
      document.getElementById('kar-aud-cancel').addEventListener('click', () => {
        backdrop.remove(); resolve('');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // -- SYNC KEY (asked once, kept only in this browser) -----------------------
  // ---------------------------------------------------------------------------

  function ensureSecret() {
    const stored = GM_getValue(K_SECRET, '');
    if (stored) return Promise.resolve(stored);
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.id = 'kar-modal-backdrop';
      backdrop.innerHTML =
        '<div id="kar-modal"><h3>Sync key</h3>' +
        '<p>Paste the KA Sync key once. It is saved only in this browser.</p>' +
        '<input id="kar-key-input" type="password" autocomplete="off" placeholder="KaSync...">' +
        '<button class="kar-primary" id="kar-key-save">Save</button>' +
        '<button class="kar-cancel" id="kar-key-cancel">Cancel</button></div>';
      document.body.appendChild(backdrop);
      const input = document.getElementById('kar-key-input');
      input.focus();
      function save() {
        const key = input.value.trim();
        if (!key) return;
        GM_setValue(K_SECRET, key);
        backdrop.remove();
        resolve(key);
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      document.getElementById('kar-key-save').addEventListener('click', save);
      document.getElementById('kar-key-cancel').addEventListener('click', () => { backdrop.remove(); resolve(''); });
    });
  }

  // ---------------------------------------------------------------------------
  // -- BATCH: "Refresh all" (reads ka_published, re-syncs each Doc in place) ----
  // Drives navigation KA-by-KA in THIS tab, reusing the live Salesforce session
  // and the same normalizer (no Python, no expiring cookie). State in GM storage
  // -> survives full reloads and SPA nav. Force = skip checkKA (always update).
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parseCsv(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function fetchPublishedList() {
    return new Promise((resolve, reject) => {
      const url = 'https://docs.google.com/spreadsheets/d/' + CORPUS_SHEET_ID +
        '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(KA_PUBLISHED_TAB);
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload(resp) {
          const t = resp.responseText || '';
          if (t.slice(0, 9) === '<!DOCTYPE') { reject(new Error('No access to the sheet (sign into Google)')); return; }
          const rows = parseCsv(t);
          const header = (rows.shift() || []).map((h) => h.trim());
          const uCol = header.indexOf('salesforceUrl');
          const tCol = header.indexOf('title');
          if (uCol === -1) { reject(new Error('ka_published has no salesforceUrl column')); return; }
          const list = rows.map((r) => ({ url: (r[uCol] || '').trim(), title: (r[tCol] || '').trim() }))
            .filter((x) => /^https?:\/\//.test(x.url));
          resolve(list);
        },
        onerror() { reject(new Error('Network error reading the sheet')); },
      });
    });
  }

  // KAs the last audit marked outdated (ka_audit tab, written by the backend).
  function fetchOutdatedList() {
    return new Promise((resolve, reject) => {
      const url = 'https://docs.google.com/spreadsheets/d/' + CORPUS_SHEET_ID +
        '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(AUDIT_TAB);
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload(resp) {
          const t = resp.responseText || '';
          if (t.slice(0, 9) === '<!DOCTYPE') { reject(new Error('No access to the sheet (sign into Google)')); return; }
          const rows = parseCsv(t);
          const header = (rows.shift() || []).map((h) => h.trim());
          const sCol = header.indexOf('estado');
          const uCol = header.indexOf('Salesforce');
          const tCol = header.indexOf('t\u00EDtulo');
          if (sCol === -1 || uCol === -1) { reject(new Error('No ka_audit tab yet: run \uD83D\uDCCB Audit first')); return; }
          const list = rows.filter((r) => (r[sCol] || '').trim() === 'Desactualizado')
            .map((r) => {
              const u = (r[uCol] || '').trim();
              return { url: u, title: (r[tCol] || '').trim(), recordId: (u.match(/\/(ka[0-9A-Za-z]{13,16})\//) || [])[1] || '' };
            })
            .filter((x) => x.recordId);
          resolve(list);
        },
        onerror() { reject(new Error('Network error reading the sheet')); },
      });
    });
  }

  // Every flagged row of the last audit, with what the script can do about it.
  const FIX_ACTIONS = {
    'En Salesforce sin Doc': 'create', 'Desactualizado': 'update', 'Doc de más': 'archive',
  };
  function fetchAuditRows() {
    return new Promise((resolve, reject) => {
      const url = 'https://docs.google.com/spreadsheets/d/' + CORPUS_SHEET_ID +
        '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(AUDIT_TAB);
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload(resp) {
          const t = resp.responseText || '';
          if (t.slice(0, 9) === '<!DOCTYPE') { reject(new Error('No access to the sheet (sign into Google)')); return; }
          const rows = parseCsv(t);
          const h = (rows.shift() || []).map((x) => x.trim());
          const c = (n) => h.indexOf(n);
          if (c('estado') === -1) { reject(new Error('No ka_audit tab yet: run 📋 Audit first')); return; }
          const out = rows.map((r) => {
            const v = (n) => (c(n) === -1 ? '' : (r[c(n)] || '').trim());
            const estado = v('estado'), sf = v('Salesforce'), doc = v('Doc');
            const key = Object.keys(FIX_ACTIONS).find((k) => estado.indexOf(k) === 0);
            let action = key ? FIX_ACTIONS[key] : 'manual';
            const recordId = (sf.match(/\/(ka[0-9A-Za-z]{13,16})\//) || [])[1] || '';
            const docId = (doc.match(/\/d\/([A-Za-z0-9_-]{20,})/) || [])[1] || '';
            if ((action === 'create' || action === 'update') && !recordId) action = 'manual';
            if (action === 'archive' && !docId) action = 'manual';
            return { estado, team: v('equipo'), title: v('título'), url: sf, recordId, docId, action, by: v('modificado por') };
          }).filter((x) => x.estado && x.estado !== 'OK');
          resolve(out);
        },
        onerror() { reject(new Error('Network error reading the sheet')); },
      });
    });
  }

  const ACT_LABEL = { create: '+ New', update: '↑ Update', archive: 'Archive Doc', manual: 'By hand' };
  async function openFixList() {
    if (_busy) return;
    if (getAudit() || getBatch()) { setStatus('error', 'Something else is still running in this tab.'); return; }
    setStatus('loading', 'Reading the last audit…');
    let items;
    try { items = await fetchAuditRows(); } catch (e) { setStatus('error', e.message); return; }
    if (!items.length) { setStatus('success', 'Nothing to fix: the last audit is all OK.'); return; }
    const body = _overlayBody(); if (!body) return;
    body.innerHTML =
      '<div class="kar-title">Fix from audit</div>' +
      '<div style="font-size:12px;color:#5B5D62">Tick what you accept. Archive is off by default: tick it only when the KA was archived in Salesforce.</div>' +
      '<div class="kar-fix-list">' + items.map((x, i) => {
        const can = x.action !== 'manual';
        return '<label class="' + (can ? '' : 'off') + '"><input type="checkbox" data-i="' + i + '"' +
          (can ? (x.action === 'archive' ? '' : ' checked') : ' disabled') + '>' +
          '<span style="flex:1;min-width:0"><span class="kar-act ' + x.action + '">' + ACT_LABEL[x.action] + '</span> ' +
          escHtml(x.title) + '<br><span style="font-size:11px;color:#8A8D93">' + escHtml(x.team) + ' · ' + escHtml(x.estado) + (x.by ? ' · last edit: ' + escHtml(x.by) : '') + '</span></span></label>';
      }).join('') + '</div>' +
      '<button class="kar-mini-btn blue" id="kar-fix-go">Do selected</button> ' +
      '<button class="kar-mini-btn warn" id="kar-fix-cancel">Cancel</button>';
    _showOverlay();
    const count = () => body.querySelectorAll('.kar-fix-list input:checked').length;
    const go = document.getElementById('kar-fix-go');
    const upd = () => { go.textContent = 'Do selected (' + count() + ')'; go.disabled = !count(); };
    body.querySelectorAll('.kar-fix-list input').forEach((el) => el.addEventListener('change', upd)); upd();
    document.getElementById('kar-fix-cancel').addEventListener('click', () => setStatus('idle', 'Cancelled.'));
    go.addEventListener('click', () => {
      const chosen = Array.from(body.querySelectorAll('.kar-fix-list input:checked')).map((el) => items[+el.dataset.i]);
      runFixes(chosen);
    });
  }

  async function runFixes(chosen) {
    const reviewer = await ensureReviewer();
    if (!reviewer) return;
    if (!(await ensureSecret())) return;
    const arch = chosen.filter((x) => x.action === 'archive');
    const syncs = chosen.filter((x) => x.action === 'create' || x.action === 'update');
    if (!window.confirm('Do ' + chosen.length + ' fix' + (chosen.length > 1 ? 'es' : '') + '?\n\n' +
      (syncs.filter((x) => x.action === 'create').length ? '• Create ' + syncs.filter((x) => x.action === 'create').length + ' Doc(s)\n' : '') +
      (syncs.filter((x) => x.action === 'update').length ? '• Update ' + syncs.filter((x) => x.action === 'update').length + ' Doc(s)\n' : '') +
      (arch.length ? '• Move ' + arch.length + ' Doc(s) to the Archived folder\n' : '') +
      '\nKeep this tab on Salesforce until it finishes.')) { setStatus('idle', 'Cancelled.'); return; }
    let archived = 0, archFail = 0;
    if (arch.length) {
      setStatus('loading', 'Archiving ' + arch.length + ' Doc(s)…');
      try {
        const r = await apiPost({ action: 'archive', docIds: arch.map((x) => x.docId), by: reviewer });
        archived = (r && r.moved) || 0; archFail = arch.length - archived;
      } catch (e) { archFail = arch.length; }
    }
    if (!syncs.length) { finishBatch({ ok: 0, fail: 0, skip: 0, list: [], source: 'fix', archived, archFail }); return; }
    const list = syncs.map((x) => ({ url: x.url, title: x.title, recordId: x.recordId, mode: x.action, audience: x.action === 'create' ? x.team : '' }));
    setBatch({ active: true, list, idx: 0, reviewer, ok: 0, fail: 0, skip: 0, source: 'fix', archived, archFail });
    location.href = list[0].url;
  }

  function getBatch() { try { return JSON.parse(GM_getValue(K_BATCH, '') || 'null'); } catch (e) { return null; } }
  function setBatch(b) { GM_setValue(K_BATCH, b ? JSON.stringify(b) : ''); }
  function slugOf(u) {
    const m = (u || '').toLowerCase().match(/\/articles\/knowledge\/(.+?)(?:[?#]|$)/);
    return m ? m[1] : (u || '').toLowerCase();
  }

  // source 'outdated' = only what the last audit marked outdated;
  // default = every Doc in ka_published (use after code/format changes).
  async function startBatch(limit, source) {
    if (_busy) return;
    if (getAudit() || getBatch()) { setStatus('error', 'Something else is still running in this tab.'); return; }
    const reviewer = await ensureReviewer();
    if (!reviewer) return;
    if (!(await ensureSecret())) return;
    const outdated = source === 'outdated';
    setStatus('loading', outdated ? 'Loading the outdated KAs from the last audit\u2026' : 'Loading the KA list\u2026');
    let list;
    try { list = outdated ? await fetchOutdatedList() : await fetchPublishedList(); } catch (e) { setStatus('error', e.message); return; }
    if (limit) list = list.slice(0, limit);
    if (!list.length) {
      setStatus(outdated ? 'success' : 'error', outdated ? 'Nothing outdated in the last audit.' : 'The list is empty.');
      return;
    }
    const mins = Math.max(1, Math.ceil((list.length * 8) / 60));
    if (!window.confirm('Refresh ' + list.length + ' KA' + (list.length > 1 ? 's' : '') +
      ' in place?\n\nThis re-opens each KA and re-syncs its Doc (~' + mins + ' min).\n' +
      'Keep this tab on Salesforce and don\u2019t close it.')) {
      setStatus('idle', 'Cancelled.'); return;
    }
    setBatch({ active: true, list, idx: 0, reviewer, ok: 0, fail: 0, skip: 0, source: outdated ? 'outdated' : 'all' });
    location.href = list[0].url;
  }

  let _batchTicked = false;
  async function batchTick() {
    const b = getBatch();
    if (!b || !b.active || _batchTicked) return;
    _batchTicked = true;
    if (b.idx >= b.list.length) { finishBatch(b); return; }
    const target = b.list[b.idx];
    setButtonsDisabled(true);
    setBatchStatus(b, 'Opening ' + (b.idx + 1) + '/' + b.list.length, target.title);

    // Wait for the TARGET KA to render (verify slug so we never sync the wrong Doc).
    let ka = null;
    for (let i = 0; i < 40; i++) {
      const cur = _readKa();
      const isTarget = target.recordId
        ? location.href.indexOf(target.recordId) !== -1      // record link (outdated / fix list)
        : slugOf(cur && cur.url) === slugOf(target.url);     // article link (ka_published)
      if (cur && cur.title && isTarget) { ka = cur; break; }
      await sleep(500);
    }

    if (ka) {
      setBatchStatus(b, 'Syncing ' + (b.idx + 1) + '/' + b.list.length, ka.title);
      try {
        const html = normalizeKaHtml(ka.richFields, ka.title);
        const res = await apiPost({
          action: 'sync', mode: target.mode || 'update', title: ka.title, kaId: ka.kaId, version: ka.version,
          lastModified: ka.lastModified, url: ka.url, html, reviewer: b.reviewer, audience: target.audience || '',
        });
        if (res && res.ok) b.ok++; else b.fail++;
      } catch (e) { b.fail++; }
    } else {
      b.skip++;  // didn't render / slug mismatch \u2192 skip (never sync the wrong KA)
    }

    b.idx++;
    setBatch(b);
    if (b.idx < b.list.length) {
      setBatchStatus(b, 'Next ' + (b.idx + 1) + '/' + b.list.length, '');
      setTimeout(() => { location.href = b.list[b.idx].url; }, 700);
    } else {
      finishBatch(b);
    }
  }

  function finishBatch(b) {
    setBatch(null);
    setButtonsDisabled(false);
    const body = _overlayBody();
    if (body) {
      body.innerHTML = '<div class="kar-title success">\u2713 ' + (b.source === 'fix' ? 'Fixes done' : 'Batch done') + '</div>' +
        (b.list.length ? '<div style="font-size:12px;color:#5B5D62">' + b.ok + ' synced \u00B7 ' + b.fail +
        ' failed \u00B7 ' + b.skip + ' skipped (of ' + b.list.length + ')</div>' : '') +
        (b.archived || b.archFail ? '<div style="font-size:12px;color:#5B5D62">' + (b.archived || 0) + ' Doc(s) archived' + (b.archFail ? ' \u00B7 ' + b.archFail + ' failed' : '') + '</div>' : '') +
        (b.source === 'outdated' || b.source === 'fix' ? '<div style="font-size:12px;color:#5B5D62;margin-top:4px">Run \uD83D\uDCCB Audit again to update the sheet.</div>' : '') +
        _reviewerFooter();
      _showOverlay(); _wireReviewerLink();
    }
  }

  function stopBatch() {
    setBatch(null);
    setButtonsDisabled(false);
    setStatus('idle', 'Batch stopped.');
  }

  function setBatchStatus(b, msg, sub) {
    const body = _overlayBody();
    if (!body) return;
    const pct = Math.round((b.idx / b.list.length) * 100);
    body.innerHTML =
      '<div class="kar-title loading"><span class="kar-spinner"></span>' + escHtml(msg) + '</div>' +
      (sub ? '<div style="font-size:12px;color:#5B5D62;margin:2px 0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(sub) + '</div>' : '') +
      '<div style="height:6px;background:#E8E9EB;border-radius:100px;overflow:hidden;margin:6px 0">' +
      '<div style="height:100%;width:' + pct + '%;background:#009FD9;transition:width .3s"></div></div>' +
      '<div style="font-size:11px;color:#8A8D91">' + b.ok + ' ok \u00B7 ' + b.fail + ' fail \u00B7 ' + b.skip + ' skip</div>' +
      '<button class="kar-mini-btn warn" id="kar-stop">Stop</button>';
    _showOverlay();
    const st = document.getElementById('kar-stop');
    if (st) st.addEventListener('click', stopBatch);
  }

  // ---------------------------------------------------------------------------
  // -- AUDIT: weekly Content Index check --------------------------------------
  // Reads the "Published Articles" list view (UI API, same session) and the 3
  // Content Index reports (drawn tables, scrolled to the end), then the
  // backend compares them with the Drive folders and writes the ka_audit tab.
  // Read-only in Salesforce and in Drive. State in GM storage -> survives the
  // navigation between reports.
  // ---------------------------------------------------------------------------

  function getAudit() { try { return JSON.parse(GM_getValue(K_AUDIT, '') || 'null'); } catch (e) { return null; } }
  function setAudit(a) { GM_setValue(K_AUDIT, a ? JSON.stringify(a) : ''); }
  function reportUrl(id) { return SF_BASE + '/lightning/r/Report/' + id + '/view'; }

  async function uiApiGet(url) {
    const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    const text = await resp.text();
    if (!resp.ok) throw new Error('Salesforce answered HTTP ' + resp.status);
    try { return JSON.parse(text); } catch (e) { throw new Error('Salesforce did not answer with data (signed out?)'); }
  }

  // The "LastModifiedBy" lookup: Salesforce sends the name as displayValue
  // (or inside value.fields.Name).
  function whoOf(fld) {
    if (!fld) return '';
    if (fld.displayValue) return String(fld.displayValue);
    const n = fld.value && fld.value.fields && fld.value.fields.Name;
    return n && n.value ? String(n.value) : '';
  }

  // Every published KA with number, URL Name, exact last-modified time and who did it.
  async function fetchPublishedArticles() {
    const base = '/services/data/v59.0/ui-api';
    // Two ways to list the views; in Thumbtack's org /list-info answers 404 and
    // /list-ui works (seen with the probe), so try both.
    let views = [];
    let lastErr = null;
    for (const path of ['/list-info/Knowledge__kav?recentListsOnly=false', '/list-ui/Knowledge__kav?pageSize=200']) {
      try {
        const info = await uiApiGet(base + path);
        const coll = (info.lists && info.lists.lists) || info.lists || info.listInfoBatch || [];
        views = coll.map(v => ({ apiName: v.apiName || (v.listReference && v.listReference.listViewApiName),
                                 label: v.label || '' })).filter(v => v.apiName);
        if (views.length) break;
      } catch (e) { lastErr = e; }
    }
    if (!views.length) throw new Error('Could not read the Knowledge list views' + (lastErr ? ' (' + lastErr.message + ')' : ''));
    const view = views.find(v => /^published articles$/i.test(v.label.trim())) || views.find(v => /publish/i.test(v.label));
    if (!view) throw new Error('The "Published Articles" list view was not found');
    const baseFields = ['Title', 'ArticleNumber', 'UrlName', 'VersionNumber', 'LastModifiedDate'];
    let fields = baseFields.concat('LastModifiedBy.Name').map(f => 'Knowledge__kav.' + f).join(',');
    const rows = [];
    let pageToken = null;
    for (let page = 0; page < 25; page++) {
      const listUrl = () => base + '/list-records/Knowledge__kav/' + encodeURIComponent(view.apiName) +
        '?pageSize=2000&optionalFields=' + encodeURIComponent(fields) +
        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      let json;
      try { json = await uiApiGet(listUrl()); }
      catch (e) {
        // if Salesforce refuses the editor's name, the audit still runs without it
        if (page > 0 || /LastModifiedBy/.test(fields) === false) throw e;
        fields = baseFields.map(f => 'Knowledge__kav.' + f).join(',');
        json = await uiApiGet(listUrl());
      }
      for (const rec of json.records || []) {
        const f = rec.fields || {};
        const v = (k) => (f[k] && f[k].value != null ? f[k].value : '');
        rows.push({ id: rec.id, articleNumber: v('ArticleNumber'), title: v('Title'), urlName: v('UrlName'),
                    version: v('VersionNumber'), lastModified: v('LastModifiedDate'), lastModifiedBy: whoOf(f.LastModifiedBy) });
      }
      pageToken = json.nextPageToken;
      if (!pageToken) break;
    }
    if (!rows.length) throw new Error('The "Published Articles" list came back empty');
    return rows;
  }

  // -- Reading a report table that Salesforce draws a few rows at a time --
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

  // Visible in its own document AND every iframe around it is visible (the
  // console keeps other report tabs loaded but hidden).
  function isShown(el) {
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
      const anchors = Array.from(tr.querySelectorAll('a[href]'));
      const rec = anchors.find(a => /\/lightning\/r\/(?:Knowledge__kav\/)?ka[0-9A-Za-z]{13,16}\//.test(a.getAttribute('href') || ''));
      if (!rec) continue;                         // header / total rows
      const recordId = (rec.getAttribute('href').match(/\/(ka[0-9A-Za-z]{13,16})\//) || [])[1];
      if (!recordId || into.has(recordId)) continue;
      const art = anchors.find(a => /\/articles\/Knowledge\//i.test(a.getAttribute('href') || ''));
      const urlName = art ? decodeURIComponent((art.getAttribute('href').split(/\/articles\/Knowledge\//i)[1] || '').split(/[?#]/)[0]) : '';
      into.set(recordId, { recordId: recordId, urlName: urlName, title: (rec.innerText || '').trim() });
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

  // The frame (document) a report renders in carries its ID in its URL or in
  // the src of the iframe around it. Salesforce IDs: match on the first 15 chars.
  function docMatchesReport(doc, reportId) {
    const id = String(reportId || '').slice(0, 15);
    if (!id) return false;
    try {
      if ((doc.location && doc.location.href || '').indexOf(id) !== -1) return true;
      const fe = doc.defaultView && doc.defaultView.frameElement;
      if (fe && (fe.getAttribute('src') || '').indexOf(id) !== -1) return true;
      // Inside a report frame, its own name is shown and no other report's.
      if (doc !== document && doc.body) {
        const rep = AUDIT_REPORTS.find(r => r.reportId === reportId);
        const text = doc.body.innerText || '';
        if (rep && text.indexOf(rep.label) !== -1 &&
            !AUDIT_REPORTS.some(o => o !== rep && text.indexOf(o.label) !== -1)) return true;
      }
    } catch (e) { /* cross-origin */ }
    return false;
  }

  // Largest visible table (the console keeps other report tabs loaded but hidden).
  // With strict=true only frames that belong to reportId count.
  function findReportTable(reportId, strict) {
    const docs = [];
    collectDocs(document, docs, 0);
    let best = null;
    for (const d of docs) {
      if (strict && !docMatchesReport(d, reportId)) continue;
      const tables = [];
      collectTables(d, tables, 0);
      for (const t of tables) {
        if (!isShown(t)) continue;
        const n = t.querySelectorAll('tbody tr').length;
        if (!best || n > best.n) best = { t: t, n: n, doc: d };
      }
    }
    return best && best.n >= 2 ? best : null;
  }

  function reportTotal(doc) {
    const m = ((doc.body && doc.body.innerText) || '').match(/Total Records\s*([\d,]+)/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  }

  // Long reports load in batches: at the bottom Salesforce needs a few seconds
  // to fetch the next rows, and it may swap the table element meanwhile. So:
  // re-find the table every step, wait at the bottom, give up on a pass only
  // after 15 s without new rows, and do up to 3 passes from the top.
  // Rows and the total always come from ONE frame; if the table shows up in a
  // different frame, start over there (never mix two reports).
  async function readReportTable(reportId, strict, onProgress) {
    let best = findReportTable(reportId, strict);
    if (!best) return { ok: false, why: 'the report table is not on screen yet' };
    let total = reportTotal(best.doc);
    if (total === null) return { ok: false, why: 'the report total ("Total Records") is not on screen yet' };
    const rows = new Map();
    readRows(best.t, rows);
    if (!rows.size) return { ok: false, why: 'the report rows have no KA links yet' };
    const STALL_MS = 15000;
    const done = () => rows.size >= total;
    const scrollerOf = (b) => scrollParent(b.t) || b.doc.scrollingElement;

    for (let pass = 0; pass < 3 && !done(); pass++) {
      let scroller = scrollerOf(best);
      if (pass > 0) { scroller.scrollTop = 0; await sleep(1500); }
      let lastNew = Date.now();
      while (!done() && Date.now() - lastNew < STALL_MS) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + Math.max(200, scroller.clientHeight * 0.8);
        await sleep(400);
        if (scroller.scrollTop === before) {
          // At the bottom: wait for the next batch, then nudge to trigger loading.
          await sleep(1200);
          scroller.scrollTop = Math.max(0, before - 300);
          await sleep(300);
          scroller.scrollTop = scroller.scrollHeight;
          await sleep(500);
        }
        const fresh = findReportTable(reportId, strict);
        if (fresh) {
          if (fresh.doc !== best.doc) {
            // Another frame: its rows belong to a different load of the page. Start over.
            const t2 = reportTotal(fresh.doc);
            if (t2 === null) continue;
            best = fresh; scroller = scrollerOf(best); total = t2; rows.clear(); lastNew = Date.now();
          } else if (fresh.t !== best.t) { best = fresh; scroller = scrollerOf(best); }
        }
        if (readRows(best.t, rows) > 0) lastNew = Date.now();
        if (onProgress) onProgress(rows.size, total);
      }
    }
    try { scrollerOf(best).scrollTop = 0; } catch (e) { /* table gone */ }
    return { ok: true, rows: Array.from(rows.values()), total: total, strict: strict };
  }

  // Check one report's rows against the Docs Drive has for that team.
  function verifyReport(rep, res, teamDocs) {
    const total = res.total, rows = res.rows || [];
    if (total === null || rows.length < total) return { ok: false, why: 'read ' + rows.length + ' of ' + total + ' rows' };
    const inRows = new Set(rows.map(r => r.urlName).filter(Boolean));
    const mine = (teamDocs[rep.team] || []);
    const missing = mine.filter(s => !inRows.has(s)).length;
    const others = new Set();
    Object.keys(teamDocs).forEach(t => { if (t !== rep.team) teamDocs[t].forEach(s => others.add(s)); });
    const mineSet = new Set(mine);
    const foreign = rows.filter(r => r.urlName && others.has(r.urlName) && !mineSet.has(r.urlName)).length;
    if (missing > 10) return { ok: false, why: missing + ' ' + rep.team + ' Docs are not in what was read', missing, foreign };
    if (foreign > 5) return { ok: false, why: foreign + ' rows belong to another team\'s report', missing, foreign };
    return { ok: true, missing, foreign };
  }

  function auditChecklist(a) {
    return a.reports.map((r, i) => (r.verified ? '\u2713 ' : (i === a.idx ? '\u2026 ' : '\u25CB ')) + r.label +
      (r.verified ? ' \u00B7 ' + r.rows.length + ' of ' + r.total + ' rows, verified' : '')).join('\n');
  }

  // -- Audit flow --
  async function startAudit() {
    if (_busy) return;
    if (getAudit() || getBatch()) { setStatus('error', 'Something else is still running in this tab.'); return; }
    const reviewer = await ensureReviewer();
    if (!reviewer) return;
    if (!(await ensureSecret())) return;
    if (!window.confirm('Run the Content Index audit?\n\nThis opens the 3 Content Index reports one by one in this tab ' +
      '(about 1\u20132 min) and compares them with the Drive folders.\nNothing is changed in Salesforce or Drive. ' +
      'Keep this tab open until it finishes.')) {
      setStatus('idle', 'Cancelled.'); return;
    }
    setButtonsDisabled(true);
    setStatus('loading', 'Reading the "Published Articles" list\u2026');
    let published, teamDocs = {};
    try {
      published = await fetchPublishedArticles();
      setStatus('loading', 'Reading the KA Docs in Drive\u2026');
      const d = await apiPost({ action: 'auditDocs' });
      if (!d || !d.ok) throw new Error(d && d.code === 'BAD_ACTION'
        ? 'the Google Script is older than this script. Paste the new Code.gs and deploy a New version.'
        : 'could not read the Docs in Drive (' + ((d && d.error) || 'no answer') + ')');
      (d.docs || []).forEach(x => { if (x.slug) (teamDocs[x.team] = teamDocs[x.team] || []).push(x.slug); });
    }
    catch (e) { setButtonsDisabled(false); setStatus('error', 'Audit stopped: ' + e.message); return; }
    setAudit({ active: true, idx: 0, by: reviewer, published: published, teamDocs: teamDocs,
               reports: AUDIT_REPORTS.map(r => ({ team: r.team, reportId: r.reportId, label: r.label })) });
    location.href = reportUrl(AUDIT_REPORTS[0].reportId);
  }

  function failAudit(msg) {
    setAudit(null);
    setButtonsDisabled(false);
    setStatus('error', 'Audit stopped: ' + msg);
  }

  let _auditTicked = false;
  async function auditTick() {
    const a = getAudit();
    if (!a || !a.active || _auditTicked) return;
    _auditTicked = true;
    setButtonsDisabled(true);
    if (a.idx >= a.reports.length) { await finishAudit(a); return; }
    const rep = a.reports[a.idx];
    if (location.href.indexOf(rep.reportId) === -1) { location.href = reportUrl(rep.reportId); return; }

    rep.attempts = rep.attempts || 0;
    setAuditStatus(a, 'Opening report ' + (a.idx + 1) + ' of ' + a.reports.length + (rep.attempts ? ' (try ' + (rep.attempts + 1) + ' of 3)' : ''), auditChecklist(a));
    let res = null;
    // Give the new tab a moment, so the previous report's tab is hidden first
    // (longer on a retry).
    await sleep(2000 + rep.attempts * 3000);
    for (let i = 0; i < 60; i++) {
      if (!getAudit()) return;                    // stopped
      // First 20 s: only a frame that carries this report's ID counts. After
      // that, if no frame carries it, fall back to the visible table.
      const strict = i < 20 || !!findReportTable(rep.reportId, true);
      res = await readReportTable(rep.reportId, strict, (n, total) =>
        setAuditStatus(a, 'Reading report ' + (a.idx + 1) + ' of ' + a.reports.length,
          auditChecklist(a) + '\n' + rep.label + ': ' + n + (total ? ' of ' + total : '') + ' rows'));
      if (res.ok) break;
      await sleep(1000);
    }
    if (!getAudit()) return;
    const check = res && res.ok ? verifyReport(rep, res, a.teamDocs || {}) : { ok: false, why: res ? res.why : 'no answer' };
    console.log('[KA Refresh] audit read', rep.label, 'try', rep.attempts + 1, res && { rows: res.rows && res.rows.length, total: res.total, strict: res.strict }, check);
    if (!check.ok) {
      rep.attempts++;
      if (rep.attempts >= 3) {
        failAudit('"' + rep.label + '" could not be verified after 3 tries (' + check.why + '). Nothing was written. ' +
          'Close the other report tabs in Salesforce and run the audit again.');
        return;
      }
      setAudit(a);
      setAuditStatus(a, '"' + rep.label + '" did not check out (' + check.why + '). Reading it again\u2026', auditChecklist(a));
      await sleep(1500);
      location.reload();
      return;
    }
    rep.total = res.total;
    rep.rows = res.rows;
    rep.verified = true;
    a.idx++;
    setAudit(a);
    if (a.idx < a.reports.length) {
      setAuditStatus(a, 'Saved and verified. Next report\u2026', auditChecklist(a));
      setTimeout(() => { location.href = reportUrl(a.reports[a.idx].reportId); }, 700);
    } else {
      await finishAudit(a);
    }
  }

  async function finishAudit(a) {
    // Each KA lives in one team's report. The same KA in two reports means a
    // report was read from the wrong tab: stop instead of writing bad results.
    const seen = {};
    for (const r of a.reports) {
      let shared = 0, other = '';
      for (const row of (r.rows || [])) {
        if (seen[row.recordId] && seen[row.recordId] !== r.label) { shared++; other = seen[row.recordId]; }
        seen[row.recordId] = seen[row.recordId] || r.label;
      }
      if (shared >= 5) {
        failAudit('"' + r.label + '" came back with ' + shared + ' of the same KAs as "' + other + '", so one report was read from the wrong tab. Nothing was written. Run the audit again.');
        return;
      }
    }
    setAuditStatus(a, 'Comparing with Drive\u2026', 'Writing the ka_audit tab');
    let res;
    try {
      res = await apiPost({
        action: 'audit', by: a.by, published: a.published, // teamDocs stay local

        reports: a.reports.map(r => ({ team: r.team, reportId: r.reportId, total: r.total, rows: r.rows })),
      });
    } catch (e) { failAudit(e.message); return; }
    setAudit(null);
    setButtonsDisabled(false);
    if (!res || !res.ok) { setStatus('error', 'Audit failed: ' + ((res && (res.code ? res.code + ': ' : '') + res.error) || 'no answer')); return; }
    setAuditDone(res);
  }

  function stopAudit() {
    setAudit(null);
    setButtonsDisabled(false);
    setStatus('idle', 'Audit stopped.');
  }

  function setAuditStatus(a, msg, sub) {
    const body = _overlayBody();
    if (!body) return;
    const pct = Math.round((a.idx / (a.reports.length + 1)) * 100);
    body.innerHTML =
      '<div class="kar-title loading"><span class="kar-spinner"></span>' + escHtml(msg) + '</div>' +
      (sub ? '<div style="font-size:12px;color:#5B5D62;margin:2px 0 6px;white-space:pre-line">' + escHtml(sub) + '</div>' : '') +
      '<div style="height:6px;background:#E8E9EB;border-radius:100px;overflow:hidden;margin:6px 0">' +
      '<div style="height:100%;width:' + pct + '%;background:#7A5AF8;transition:width .3s"></div></div>' +
      '<button class="kar-mini-btn warn" id="kar-audit-stop">Stop</button>';
    _showOverlay();
    const st = document.getElementById('kar-audit-stop');
    if (st) st.addEventListener('click', stopAudit);
  }

  const AUDIT_LABELS = [
    ['MISSING_DOC', 'In Salesforce, no Doc'], ['ARCHIVED_BUT_ACTIVE', 'Archived by mistake'],
    ['DUPLICATE_DOCS', 'Duplicate Docs'], ['OUTDATED', 'Outdated'], ['WRONG_TEAM', 'Different team'],
    ['EXTRA_DOC', 'Extra Doc (not in reports)'], ['NO_META', 'Doc without KA data'], ['OK', 'OK'],
  ];

  function setAuditDone(res) {
    const body = _overlayBody();
    if (!body) return;
    const c = res.counts || {};
    const pending = (res.total || 0) - (c.OK || 0);
    body.innerHTML =
      '<div class="kar-title ' + (pending ? 'skip' : 'success') + '">' +
      (pending ? pending + ' KAs need attention' : '\u2713 Everything is up to date') + '</div>' +
      '<div style="font-size:12px;line-height:1.7;margin:4px 0 6px">' +
      AUDIT_LABELS.filter(([k]) => c[k]).map(([k, label]) =>
        '<div style="display:flex;justify-content:space-between"><span>' + escHtml(label) + '</span><b>' + c[k] + '</b></div>').join('') +
      '</div>' +
      (res.sheetUrl ? '<a href="' + escHtml(res.sheetUrl) + '" target="_blank">Open the audit sheet \u2197</a>' : '') +
      '<div class="kar-meta">Summary emailed \u00B7 ' + escHtml(res.auditedAt || '') + '</div>';
    _showOverlay();
  }

  // ---------------------------------------------------------------------------
  // -- BOOTSTRAP --------------------------------------------------------------
  // ---------------------------------------------------------------------------

  function onKaPage() { return KA_URL_PATTERN.test(location.href); }

  GM_registerMenuCommand('Run Content Index audit', startAudit);
  GM_registerMenuCommand('Change sync key', () => { GM_setValue(K_SECRET, ''); ensureSecret(); });

  function resume() {
    const a = getAudit();
    if (a && a.active) { setTimeout(() => { injectUI(); auditTick(); }, 1600); return true; }
    const b = getBatch();
    if (b && b.active) { setTimeout(() => { injectUI(); batchTick(); }, 1600); return true; }
    return false;
  }

  function boot() {
    if (resume()) return;
    if (onKaPage()) setTimeout(injectUI, 1200);
  }

  let _lastHref = location.href;
  setInterval(() => {
    if (location.href !== _lastHref) {
      _lastHref = location.href;
      _batchTicked = false;
      _auditTicked = false;
      if (resume()) return;
      const bar = document.getElementById('kar-bar');
      const ov = document.getElementById('kar-overlay');
      if (!onKaPage()) {
        if (bar) bar.remove();
        if (ov) ov.remove();
      } else {
        setTimeout(injectUI, 1200);
      }
    }
  }, 1000);

  boot();
})();
