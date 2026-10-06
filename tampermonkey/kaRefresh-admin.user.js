// ==UserScript==
// @name         KA Refresh - Sync to Drive
// @namespace    https://thumbtack.com/
// @version      2.3.0
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
 * v2.3.0 - "Refresh outdated": re-syncs only the KAs the last audit marked
 *   "Desactualizado" (ka_audit tab). "Refresh all" stays for code/format
 *   changes that need every Doc rebuilt.
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

  console.log('[KA Refresh] v2.3.0 loaded (admin)');

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
    #kar-batch5-btn { background: #7A7D82; color: #fff; }
    #kar-batch5-btn:hover:not(:disabled) { background: #64676B; }
    #kar-batch-btn { background: #2DB783; color: #fff; }
    #kar-batch-btn:hover:not(:disabled) { background: #269E70; }
    #kar-outdated-btn { background: #E8912D; color: #fff; }
    #kar-outdated-btn:hover:not(:disabled) { background: #CC7A1C; }
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

  function injectUI() {
    if (document.getElementById('kar-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'kar-bar';
    bar.innerHTML =
      '<button class="kar-main-btn" id="kar-update-btn">\u2191 Update</button>' +
      '<button class="kar-main-btn" id="kar-new-btn">+ New</button>' +
      '<button class="kar-main-btn" id="kar-batch5-btn">Test 5</button>' +
      '<button class="kar-main-btn" id="kar-outdated-btn">\u27F3 Refresh outdated</button>' +
      '<button class="kar-main-btn" id="kar-batch-btn">\u27F3 Refresh all</button>' +
      '<button class="kar-main-btn" id="kar-audit-btn">\uD83D\uDCCB Audit</button>';
    document.body.appendChild(bar);
    const overlay = document.createElement('div');
    overlay.id = 'kar-overlay';
    overlay.innerHTML = '<div id="kar-overlay-body"></div>';
    document.body.appendChild(overlay);
    document.getElementById('kar-update-btn').addEventListener('click', () => runIntent('update'));
    document.getElementById('kar-new-btn').addEventListener('click', () => runIntent('new'));
    document.getElementById('kar-batch5-btn').addEventListener('click', () => startBatch(5));
    document.getElementById('kar-batch-btn').addEventListener('click', () => startBatch(0));
    document.getElementById('kar-outdated-btn').addEventListener('click', () => startBatch(0, 'outdated'));
    document.getElementById('kar-audit-btn').addEventListener('click', () => startAudit());
  }

  function setButtonsDisabled(disabled) {
    for (const id of ['kar-update-btn', 'kar-new-btn', 'kar-batch5-btn', 'kar-outdated-btn', 'kar-batch-btn', 'kar-audit-btn']) {
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
        ? location.href.indexOf(target.recordId) !== -1      // record link (outdated list)
        : slugOf(cur && cur.url) === slugOf(target.url);     // article link (ka_published)
      if (cur && cur.title && isTarget) { ka = cur; break; }
      await sleep(500);
    }

    if (ka) {
      setBatchStatus(b, 'Syncing ' + (b.idx + 1) + '/' + b.list.length, ka.title);
      try {
        const html = normalizeKaHtml(ka.richFields, ka.title);
        const res = await apiPost({
          action: 'sync', mode: 'update', title: ka.title, kaId: ka.kaId, version: ka.version,
          lastModified: ka.lastModified, url: ka.url, html, reviewer: b.reviewer, audience: '',
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
      body.innerHTML = '<div class="kar-title success">\u2713 Batch done</div>' +
        '<div style="font-size:12px;color:#5B5D62">' + b.ok + ' updated \u00B7 ' + b.fail +
        ' failed \u00B7 ' + b.skip + ' skipped (of ' + b.list.length + ')</div>' +
        (b.source === 'outdated' ? '<div style="font-size:12px;color:#5B5D62;margin-top:4px">Run \uD83D\uDCCB Audit again to update the sheet.</div>' : '') +
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

  // Every published KA with number, URL Name and exact last-modified time.
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
    const fields = ['Title', 'ArticleNumber', 'UrlName', 'VersionNumber', 'LastModifiedDate']
      .map(f => 'Knowledge__kav.' + f).join(',');
    const rows = [];
    let pageToken = null;
    for (let page = 0; page < 25; page++) {
      const json = await uiApiGet(base + '/list-records/Knowledge__kav/' + encodeURIComponent(view.apiName) +
        '?pageSize=2000&optionalFields=' + encodeURIComponent(fields) +
        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
      for (const rec of json.records || []) {
        const f = rec.fields || {};
        const v = (k) => (f[k] && f[k].value != null ? f[k].value : '');
        rows.push({ id: rec.id, articleNumber: v('ArticleNumber'), title: v('Title'), urlName: v('UrlName'),
                    version: v('VersionNumber'), lastModified: v('LastModifiedDate') });
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

  // Largest visible table (the console keeps other report tabs loaded but hidden).
  function findReportTable() {
    const docs = [];
    collectDocs(document, docs, 0);
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
  async function readReportTable(onProgress) {
    let best = findReportTable();
    if (!best) return { ok: false, why: 'the report table is not on screen yet' };
    let total = reportTotal(best.doc);
    const rows = new Map();
    readRows(best.t, rows);
    if (!rows.size) return { ok: false, why: 'the report rows have no KA links yet' };
    const STALL_MS = 15000;
    const done = () => total !== null && rows.size >= total;
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
        const fresh = findReportTable();
        if (fresh) {
          if (fresh.t !== best.t || fresh.doc !== best.doc) { best = fresh; scroller = scrollerOf(best); }
          if (total === null) total = reportTotal(best.doc);
        }
        if (readRows(best.t, rows) > 0) lastNew = Date.now();
        if (onProgress) onProgress(rows.size, total);
      }
    }
    try { scrollerOf(best).scrollTop = 0; } catch (e) { /* table gone */ }
    return { ok: true, rows: Array.from(rows.values()), total: total };
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
    let published;
    try { published = await fetchPublishedArticles(); }
    catch (e) { setButtonsDisabled(false); setStatus('error', 'Audit stopped: ' + e.message); return; }
    setAudit({ active: true, idx: 0, by: reviewer, published: published,
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

    setAuditStatus(a, 'Opening report ' + (a.idx + 1) + ' of ' + a.reports.length, rep.label);
    let res = null;
    for (let i = 0; i < 60; i++) {
      if (!getAudit()) return;                    // stopped
      res = await readReportTable((n, total) =>
        setAuditStatus(a, 'Reading report ' + (a.idx + 1) + ' of ' + a.reports.length,
          rep.label + ': ' + n + (total ? ' of ' + total : '') + ' rows'));
      if (res.ok) break;
      await sleep(1000);
    }
    if (!getAudit()) return;
    if (!res || !res.ok) { failAudit('could not read "' + rep.label + '" (' + (res ? res.why : 'no answer') + ').'); return; }
    if (res.total !== null && res.rows.length < res.total) {
      failAudit('"' + rep.label + '" only showed ' + res.rows.length + ' of ' + res.total + ' rows. Try again.');
      return;
    }
    rep.total = res.total;
    rep.rows = res.rows;
    a.idx++;
    setAudit(a);
    if (a.idx < a.reports.length) {
      setAuditStatus(a, 'Next report\u2026', a.reports[a.idx].label);
      setTimeout(() => { location.href = reportUrl(a.reports[a.idx].reportId); }, 700);
    } else {
      await finishAudit(a);
    }
  }

  async function finishAudit(a) {
    setAuditStatus(a, 'Comparing with Drive\u2026', 'Writing the ka_audit tab');
    let res;
    try {
      res = await apiPost({
        action: 'audit', by: a.by, published: a.published,
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
      (sub ? '<div style="font-size:12px;color:#5B5D62;margin:2px 0 6px">' + escHtml(sub) + '</div>' : '') +
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
