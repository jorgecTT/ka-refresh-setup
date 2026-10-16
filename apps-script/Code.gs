/**
 * KA Sync v2 — Google Apps Script backend (v2.9.3)
 *
 * PRODUCTION backend for the simplified architecture:
 *
 *   client extracts rich-field HTML from Salesforce
 *     → normalizer rewrites it (deterministic Montserrat styles, dead TOC
 *       links removed, accordions flattened, media placeholders, list glyphs
 *       by depth, duplicate Contents dropped)
 *     → this script: Drive.Files.insert / Drive.Files.update {convert:true}
 *     → post-process: whole-doc Montserrat pass + page header (6 lines)
 *
 * CHANGE DETECTION: the Doc's Drive description stores
 * KA_META:<kaId>|<url>|<lastModifiedTS>. checkKA compares the KA's
 * normalized Salesforce "Last Modified" against the stored value:
 *   no Doc → create | timestamp differs (or missing) → update | equal → skip.
 *
 * v2.3.0
 *   - Shared secret moved to Script Properties (SHARED_SECRET) so the code
 *     can live in a public repo. Set it once: Project Settings → Script
 *     properties.
 *   - checkKA never skips when Salesforce's "Last Modified" could not be
 *     read (it used to store "not listed" and then always say "no change").
 *   - inferAudience reads only the audience segment of the filename
 *     (" - internal - <audience> - EN"), not the whole title.
 *   - "Current refresh" date uses Pacific time instead of UTC.
 *   - NEW: weekly Content Index audit (action 'audit'), written to the
 *     ka_audit tab, logged in ka_audit_log and emailed; weekly reminder.
 *
 * v2.9.3
 *   - audit: a Doc that came out "Untitled" (a sync of a half-loaded KA) is EMPTY_DOC,
 *     "Doc is empty", and Fix from audit updates it. Before it counted as OK.
 *
 * v2.9.2
 *   - save page: an article that has no row in localization_tracker yet gets one
 *     (title, Doc ids and audience come from the dashboard) instead of being skipped.
 *
 * v2.9.1
 *   - sync refuses a KA that hadn't finished loading (title "Untitled" or almost no text):
 *     code EMPTY_KA, the Doc is not touched. In Oct 2026 four Docs were overwritten that way.
 *   - sync asks first (code WOULD_SHRINK) when the new text is under 30% of the Doc's;
 *     the admin script confirms and resends with allowShrink.
 *
 * v2.9.0
 *   - <web app URL>?sync=translation&k=<key>: Auto Sync rewrites the EN and ES Docs
 *     from Contentful now, then their text is copied for the re-audit.
 *     ?sync=all: full Auto Sync, texts copied again ~30 minutes later.
 *
 * v2.8.1
 *   - <web app URL>?save=audit (no data): a page to paste all the dashboard's
 *     results and save them at once (a link with many results was too long).
 *
 * v2.8.0 (translation re-audit, no API key)
 *   - buildAuditQueue(): copies the EN and ES text of every translation into
 *     translation_audit_queue for the dashboard (keeps a copy of the old scores first).
 *   - <web app URL>?save=audit&d=...: saves the dashboard's new scores to
 *     localization_tracker (aiScore, auditedDate, notes) after a confirm page.
 *
 * v2.7.5
 *   - setupSearchNames(): creates the search_names tab (other names for the same
 *     thing) that the dashboard searches with.
 *
 * v2.7.4 (Contentful)
 *   - "Add it" answers right away: Auto Sync creates the Doc from a background
 *     trigger (autoSyncPending), since it takes minutes, then runs a full sync.
 *
 * v2.7.3 (Contentful)
 *   - The log of the Create Doc button is now the hc_added tab (2.7.0 left a
 *     different log in hc_created, which made the dashboard show an article
 *     as on the Auto Sync list when it was not).
 *
 * v2.7.2 (Contentful)
 *   - After Auto Sync creates the Doc, it also asks Auto Sync to start a full
 *     sync of every article (action 'run_manual': needs the small addition in
 *     tools/autosync-run-manual.gs pasted into the Auto Sync project).
 *
 * v2.7.1 (Contentful)
 *   - <web app URL>?create=contentful&id=<entryId> puts an article in the
 *     Content Index through HC Auto Sync: it adds the article's Help Center
 *     URL to the Auto Sync "Articles" list, so Auto Sync creates the Doc (in
 *     its own format) and keeps it updated. With AUTO_SYNC_URL and
 *     AUTO_SYNC_SECRET set, it also asks Auto Sync to create it right away.
 *     Shows what it will do first; acts only on "Add it" (&go=1). Logged in
 *     the hc_added tab. hc_contentful gets an internalName column.
 *
 * v2.6.0 (Contentful)
 *   - <web app URL>?refresh=contentful reads Contentful right away (the
 *     dashboard's "Update from Contentful" button). One at a time, at most
 *     once a minute.
 *
 * v2.5.1 (Contentful)
 *   - Article types: only "Article", not "Article > Segment", "Article > Tip"...
 *     (those are the segments inside an article).
 *
 * v2.5.0 (Contentful)
 *   - NEW: syncContentful() (daily, setupContentfulTrigger) reads the Help
 *     Center space (read only) and writes hc_contentful: when each article was
 *     last changed in Contentful and by whom, counting its linked segments.
 *
 * v2.4.2 (diagnostics)
 *   - Every answer says which Code.gs is running ("server": "2.4.2"), and
 *     <web app URL>?version=1 shows it in the browser, so an old deployment
 *     (or another .gs file with its own doPost) is easy to spot.
 *
 * v2.4.1 (weekly report)
 *   - Only the changes: updated (new version / minor edit), new and archived
 *     KAs and who did each one. No Drive sync info.
 *
 * v2.4.0 (weekly report)
 *   - NEW: action 'weekly' (the "Weekly report" button): which KAs are new,
 *     got a new version or a minor edit since last week, who did it and
 *     whether they synced the Doc. Written to ka_weekly (+ ka_weekly_log)
 *     and emailed in English. ka_weekly_snapshot keeps the versions seen.
 *
 * v2.3.6 (audit)
 *   - The audit is in English: the email, the reminder and the ka_audit /
 *     ka_audit_log tabs (statuses, column names, notes).
 *   - KA titles come back to plain text ("Thumbtack's", not "Thumbtack&#39;s").
 *
 * v2.3.5 (audit)
 *   - Who last edited each KA in Salesforce: new "modificado por" column in
 *     ka_audit, and the email lists the outdated KAs grouped by that person.
 *   - resetAuditHistory(): run it once from the editor to empty ka_audit and
 *     ka_audit_log (headers stay) and start the audit history from zero.
 *
 * v2.3.4 (audit)
 *   - A KA edited in Salesforce after its last sync is "Desactualizado" even
 *     when the version number is the same: minor edits published without
 *     "new version" keep the number but change the content. (Undoes the
 *     same-version exemption from 2.3.1.)
 *
 * v2.3.3 (audit)
 *   - NEW action 'auditDocs' (read-only): the KA Docs in the Published folder
 *     per team. The admin script checks each report against it right after
 *     reading it, and re-reads the report when they don't agree.
 *
 * v2.3.2 (audit)
 *   - Safety stop: when a team suddenly has many "Doc de más" (more than
 *     AUDIT_MAX_EXTRA_PER_TEAM), its report was not read completely (or was
 *     read from the wrong tab). The audit is rejected and nothing is written,
 *     so a bad read never replaces a good ka_audit tab.
 *
 * v2.3.1 (audit)
 *   - "Outdated" now checks the version: when the Doc header's "Version"
 *     equals Salesforce's VersionNumber the content did not change (only the
 *     date moved), so it is not outdated. 10-minute tolerance on dates.
 *   - KA numbers keep their leading zeros in the ka_audit tab.
 *
 * Targets the PRODUCTION KA folder (Shared Drive) — all Drive calls use
 * supportsAllDrives.
 *
 * Deploy as: Web App | Execute as: Me | Access: Anyone
 * Required: Drive API advanced service (v2) enabled.
 */

// ─── CONFIG ────────────────────────────────────────────────────────────────

// PRODUCTION KA Docs folder (Shared Drive) — same as the old systems.
var KA_FOLDER_ID = '1y-wucQGJ2i0y3VSfr1Hv4v-AK5GcNNQf';

// 'Sales' stays ONLY so old filenames still infer correctly on update;
// new Docs use GTM. Order matters: inference checks in order.
var KNOWN_AUDIENCES = ['Support Ops', 'GTM', 'Trust & Safety', 'Sales'];
var MAX_DESCRIPTION_CHARS = 24000;

var PAGE_HEADER_STYLE = { font: 'Montserrat', size: 8, color: '#999999' };

// Dates written into Docs, the audit tab and emails.
var LOCAL_TZ = 'America/Los_Angeles';
var CODE_VERSION = '2.9.3';
var CODE_ACTIONS = ['checkKA', 'sync', 'archive', 'audit', 'auditDocs', 'weekly', 'version'];

// The secret lives in Script Properties, never in the code.
function _sharedSecret() {
  return PropertiesService.getScriptProperties().getProperty('SHARED_SECRET') || '';
}

// ─── ENTRY POINTS ──────────────────────────────────────────────────────────

// doGet is defined at the bottom (serves the team dashboard web app).

/**
 * doPost routes by `action`:
 *   'checkKA' : { secret, kaId, url, lastModified }
 *               → { ok, decision: 'create'|'update'|'skip', docId?, docUrl? }
 *   'sync'    : { secret, mode: 'create'|'update', title, kaId, version,
 *                 lastModified, url, html, reviewer, audience? }
 *               → { ok, mode, docId, docUrl, filename, elapsedMs }
 *   'archive' : { secret, docIds, by }
 *   'audit'   : { secret, reports: [{ team, reportId, total, rows }],
 *                 published: [...], by }
 *               → { ok, counts, total, sheetUrl }
 *   'weekly'  : { secret, published: [...with firstPublished, lastPublished,
 *                 lastModifiedBy, createdBy], archived: [...] | null, by }
 *               → { ok, counts, since, until, sheetUrl }
 */
function doPost(e) {
  var t0 = Date.now();
  try {
    var req;
    try { req = JSON.parse(e.postData.contents); }
    catch (_) { return _json({ ok: false, error: 'Invalid JSON body', code: 'BAD_REQUEST' }); }

    var secret = _sharedSecret();
    if (!secret) {
      return _json({ ok: false, error: 'Server secret is not set (Script Properties → SHARED_SECRET)', code: 'NO_SECRET' });
    }
    if (!req.secret || req.secret !== secret) {
      return _json({ ok: false, error: 'Unauthorized', code: 'BAD_SECRET' });
    }

    var action = req.action || (req.html ? 'sync' : '');
    switch (action) {
      case 'checkKA': return _json(checkKA(req));
      case 'sync':    return _json(handleSync(req, t0));
      case 'archive': return _json(handleArchive(req));
      case 'audit':   return _json(handleAudit(req));
      case 'auditDocs': return _json(handleAuditDocs());
      case 'weekly':  return _json(handleWeekly(req));
      case 'version': return _json({ ok: true, actions: CODE_ACTIONS });
      default:
        return _json({ ok: false, error: 'Unknown action: ' + action + ' (KA Sync ' + CODE_VERSION + ')', code: 'BAD_ACTION' });
    }
  } catch (err) {
    return _json({
      ok: false, code: 'INTERNAL',
      error: 'Internal error: ' + err.message,
      elapsedMs: Date.now() - t0,
    });
  }
}

// ─── CHANGE DETECTION ──────────────────────────────────────────────────────

function checkKA(req) {
  var match = findDocByKaIdOrUrl(req.kaId, req.url);

  if (match.status === 'NOT_FOUND') {
    return { ok: true, decision: 'create' };
  }
  if (match.status === 'MULTIPLE') {
    return {
      ok: true, decision: 'skip', reason: 'multiple-docs',
      message: 'Multiple Docs match this KA — resolve manually (delete the duplicates).',
    };
  }

  var fileId = match.doc.getId();
  var storedTs = _readStoredTimestamp(fileId);
  var incomingTs = normalizeTimestamp(req.lastModified || '');

  // Skip only when BOTH sides are real timestamps and they match.
  if (storedTs && incomingTs && _isRealTimestamp(storedTs) && storedTs === incomingTs) {
    return {
      ok: true, decision: 'skip', reason: 'no-change',
      docId: fileId,
      docUrl: 'https://docs.google.com/document/d/' + fileId + '/edit',
      message: 'No change since ' + incomingTs,
    };
  }

  return {
    ok: true, decision: 'update',
    docId: fileId,
    docUrl: 'https://docs.google.com/document/d/' + fileId + '/edit',
    storedTs: storedTs, incomingTs: incomingTs,
  };
}

function _isRealTimestamp(ts) {
  return /^\d{4}-\d{2}-\d{2}/.test(ts || '');
}

function _readStoredTimestamp(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    var desc = file.getDescription() || '';
    var m = desc.match(/^KA_META:[^|\n]*\|[^|\n]*\|([^\n]*)/);
    if (m) return (m[1] || '').trim();
  } catch (e) {}
  return '';
}

/**
 * Normalize a Salesforce "Last Modified" string to a stable comparison key:
 * "YYYY-MM-DD HH:MM" (24h), or "YYYY-MM-DD" if no time present.
 * Returns '' when no date can be found ("Not listed", empty, garbage), so a
 * failed read never looks like "no change".
 */
function normalizeTimestamp(raw) {
  if (!raw) return '';
  var s = raw.toString().trim();
  s = s.replace(/\s+by\s+.*$/i, '').trim();
  s = s.replace(/\s*(Open|Preview).*$/i, '').trim();
  var dm = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!dm) return '';
  var mo = ('0' + dm[1]).slice(-2);
  var da = ('0' + dm[2]).slice(-2);
  var datePart = dm[3] + '-' + mo + '-' + da;
  var tm = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!tm) return datePart;
  var hr = parseInt(tm[1], 10);
  var ap = (tm[3] || '').toUpperCase();
  if (ap === 'PM' && hr < 12) hr += 12;
  if (ap === 'AM' && hr === 12) hr = 0;
  return datePart + ' ' + ('0' + hr).slice(-2) + ':' + tm[2];
}

// ─── SYNC (convert + post-process) ─────────────────────────────────────────

function handleSync(req, t0) {
  var required = ['title', 'html', 'reviewer', 'url'];
  for (var i = 0; i < required.length; i++) {
    if (!req[required[i]]) {
      return { ok: false, error: 'Missing field: ' + required[i], code: 'BAD_REQUEST' };
    }
  }

  // Never write a KA that didn't finish loading: no real title, or (almost) no text.
  // That is how 4 Docs became "Untitled" with 1 word in Oct 2026.
  var plain = _htmlText(req.html);
  var bodyLen = Math.max(0, plain.length - String(req.title).length);
  if (/^\s*untitled\s*$/i.test(req.title) || bodyLen < SYNC_MIN_CHARS) {
    return { ok: false, code: 'EMPTY_KA',
      error: 'The KA came in ' + (/^\s*untitled\s*$/i.test(req.title) ? 'without its title' : 'almost empty (' + bodyLen + ' characters)') +
        ', so the page probably had not finished loading. Nothing was changed. Reload the KA and sync again.' };
  }

  var mode = req.mode || 'update';
  var canonicalUrl = normalizeToSlugUrl(req.url);
  var match = findDocByKaIdOrUrl(req.kaId, canonicalUrl);

  // Defensive re-resolution: trust what's actually in Drive over the mode.
  if (match.status === 'MULTIPLE') {
    return { ok: false, error: 'Multiple Docs match this KA — delete the duplicates.', code: 'MULTIPLE_MATCHES' };
  }
  if (match.status === 'NOT_FOUND') mode = 'create';
  else mode = 'update';

  var fullHtml =
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="font-family:Montserrat,Arial,sans-serif;font-size:10pt;color:#2f3033;">' +
    req.html +
    '</body></html>';

  var fileId, filename, prevRefresh;
  var today = Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd');

  if (mode === 'update') {
    fileId = match.doc.getId();
    // A Doc with real content should not shrink to a sliver in one sync: ask first.
    if (!req.allowShrink) {
      var oldLen = 0;
      try { oldLen = DocumentApp.openById(fileId).getBody().getText().replace(/\s+/g, ' ').trim().length; } catch (eLen) {}
      if (oldLen > 1500 && plain.length < oldLen * SYNC_SHRINK_RATIO) {
        return { ok: false, code: 'WOULD_SHRINK', oldChars: oldLen, newChars: plain.length,
          error: 'The KA is much shorter than its Doc (' + plain.length + ' vs ' + oldLen + ' characters). Nothing was changed. If the KA really got shorter, sync again and confirm.' };
      }
    }
    var file = DriveApp.getFileById(fileId);
    var oldFilename = file.getName();
    var audience = inferAudience(oldFilename) || req.audience || 'general';
    filename = buildFilename(req.title, audience);
    // Previous refresh: from the description log (works even after the
    // convert replaces the doc's content), with the old header as fallback.
    prevRefresh = _readPrevRefresh(file, fileId);
    var blobU = Utilities.newBlob(fullHtml, 'text/html', filename + '.html');
    Drive.Files.update({ title: filename }, fileId, blobU, {
      convert: true, supportsAllDrives: true,
    });
  } else {
    var audienceC = req.audience && KNOWN_AUDIENCES.indexOf(req.audience) !== -1
      ? req.audience : (req.audience || 'general');
    filename = buildFilename(req.title, audienceC);
    prevRefresh = null;
    var blobC = Utilities.newBlob(fullHtml, 'text/html', filename + '.html');
    var created = Drive.Files.insert({
      title: filename,
      mimeType: 'application/vnd.google-apps.document',
      parents: [{ id: KA_FOLDER_ID }],
    }, blobC, { convert: true, supportsAllDrives: true });
    fileId = created.id;
  }

  // Post-process: whole-doc Montserrat + page header.
  _postProcess(fileId, req, today, prevRefresh);

  // Metadata for the next change detection + refresh log + named version.
  var newFile = DriveApp.getFileById(fileId);
  var logEntry = today + ' — ' + req.reviewer + (mode === 'create' ? ' (v2 created)' : ' (v2 sync)');
  updateDescriptionLog(newFile, logEntry, req.kaId || '', canonicalUrl,
    normalizeTimestamp(req.lastModified || ''));
  nameCurrentVersion(fileId, (mode === 'create' ? 'Created ' : 'Sync ') + today);

  return {
    ok: true, mode: mode,
    docId: fileId,
    docUrl: 'https://docs.google.com/document/d/' + fileId + '/edit',
    filename: filename,
    articleTitle: req.title,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Whole-doc Montserrat (one call) + the standard 6-line page header:
 * no underline anywhere, breathing room above and below, Previous refresh
 * carried over from the doc's history.
 */
function _postProcess(fileId, req, today, prevRefresh) {
  try {
    var doc = DocumentApp.openById(fileId);

    try {
      var bodyText = doc.getBody().editAsText();
      if (bodyText.getText().length > 0) bodyText.setFontFamily('Montserrat');
    } catch (eFont) {}

    var header;
    try { header = doc.getHeader(); } catch (e) { header = null; }
    if (!header) {
      try { header = doc.addHeader(); } catch (e2) { header = doc.getHeader(); }
    }
    if (!header) { doc.saveAndClose(); return; }
    header.clear();

    var prevLine = 'N/A';
    if (prevRefresh && prevRefresh.date) {
      prevLine = prevRefresh.date + (prevRefresh.reviewer ? ' — ' + prevRefresh.reviewer : '');
    }

    var lines = [
      'Published link: ' + (req.url || 'Not listed'),
      'KA ID: ' + (req.kaId || 'Not listed'),
      'Version: ' + (req.version || 'Not listed'),
      'Last modified in Salesforce: ' + (req.lastModified || 'Not listed'),
      'Current refresh: ' + today + ' — ' + (req.reviewer || ''),
      'Previous refresh: ' + prevLine,
    ];

    for (var i = 0; i < lines.length; i++) {
      var para = header.appendParagraph(lines[i]);
      para.setSpacingBefore(i === 0 ? 8 : 0);
      para.setSpacingAfter(i === lines.length - 1 ? 8 : 0);
      var t = para.editAsText();
      var len = t.getText().length;
      if (len > 0) {
        t.setFontFamily(0, len - 1, PAGE_HEADER_STYLE.font);
        t.setFontSize(0, len - 1, PAGE_HEADER_STYLE.size);
        t.setForegroundColor(0, len - 1, PAGE_HEADER_STYLE.color);
        t.setBold(0, len - 1, false);
        t.setUnderline(0, len - 1, false);
      }
      if (i === 0 && req.url) {
        try {
          var urlStart = 'Published link: '.length;
          t.setLinkUrl(urlStart, len - 1, req.url);
          t.setForegroundColor(urlStart, len - 1, PAGE_HEADER_STYLE.color);
          t.setUnderline(urlStart, len - 1, false);
        } catch (e) {}
      }
    }

    if (header.getNumChildren() > lines.length) {
      var first = header.getChild(0);
      if (first.getType() === DocumentApp.ElementType.PARAGRAPH &&
          first.asParagraph().getText() === '') {
        first.removeFromParent();
      }
    }
    doc.saveAndClose();
  } catch (e) {
    // Post-processing must never fail the sync.
  }
}

/**
 * Previous refresh = the most recent log line in the Drive description
 * ("YYYY-MM-DD — Reviewer (...)"). Falls back to the doc's current page
 * header (read BEFORE the convert replaces it).
 */
function _readPrevRefresh(file, fileId) {
  try {
    var desc = file.getDescription() || '';
    var lines = desc.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf('KA_META:') === 0) continue;
      var m = line.match(/^(\d{4}-\d{2}-\d{2})\s*(?:—|-)\s*([^(]+)/);
      if (m) return { date: m[1], reviewer: m[2].trim() };
    }
  } catch (e) {}
  // Fallback: old header (pre-conversion).
  try {
    var doc = DocumentApp.openById(fileId);
    var text = '';
    try {
      var header = doc.getHeader();
      if (header) text += (header.getText() || '') + '\n';
    } catch (he) {}
    text += doc.getBody().getText();
    var hLines = text.split('\n').slice(0, 15);
    for (var j = 0; j < hLines.length; j++) {
      if (hLines[j].indexOf('Current refresh:') === 0) {
        var val = hLines[j].substring('Current refresh:'.length).trim();
        var parts = val.split(/\s+[\u2014\-]\s+/);
        return { date: (parts[0] || '').trim(), reviewer: (parts[1] || '').trim() };
      }
    }
  } catch (e2) {}
  return null;
}

// ─── DOC LOOKUP & METADATA ─────────────────────────────────────────────────

function normalizeToSlugUrl(url) {
  if (!url) return '';
  var trimmed = url.trim().replace(/\/+$/, '');
  var slugMatch = trimmed.match(/^(https?:\/\/[^\/]+\/articles\/Knowledge\/)(.+)$/i);
  if (slugMatch) return slugMatch[1].toLowerCase() + slugMatch[2];
  return trimmed.toLowerCase();
}

/**
 * Audience from the filename's audience segment:
 * "<title> - internal - <audience> - EN". Looking only at that segment keeps
 * a title like "Support Ops handoff - internal - GTM - EN" as GTM.
 */
function inferAudience(filename) {
  var name = filename || '';
  var m = name.match(/ - internal - (.+?) - [A-Za-z]{2}$/);
  if (m) {
    var seg = m[1].trim();
    for (var i = 0; i < KNOWN_AUDIENCES.length; i++) {
      if (seg === KNOWN_AUDIENCES[i]) return KNOWN_AUDIENCES[i];
    }
    return null;
  }
  // Legacy names without the standard pattern: old whole-name search.
  for (var j = 0; j < KNOWN_AUDIENCES.length; j++) {
    if (name.indexOf(KNOWN_AUDIENCES[j]) !== -1) return KNOWN_AUDIENCES[j];
  }
  return null;
}

var SYNC_MIN_CHARS = 40;       // the broken syncs had 0: anything real is more
var SYNC_SHRINK_RATIO = 0.3;   // new text under 30% of the Doc's = ask first
function _htmlText(html) {
  return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function buildFilename(title, audience) {
  return title + ' - internal - ' + audience + ' - EN';
}

function updateDescriptionLog(file, newLine, kaId, kaUrl, lastModTs) {
  try {
    var current = file.getDescription() || '';
    current = current.replace(/^KA_META:[^\n]*\n/, '');
    var meta = 'KA_META:' + (kaId || '') + '|' + (kaUrl || '') + '|' + (lastModTs || '') + '\n';
    var combined = meta + newLine + '\n' + current;
    if (combined.length > MAX_DESCRIPTION_CHARS) {
      var lines = combined.split('\n');
      while (lines.join('\n').length > MAX_DESCRIPTION_CHARS && lines.length > 1) lines.pop();
      combined = lines.join('\n');
    }
    file.setDescription(combined);
  } catch (e) {}
}

function nameCurrentVersion(fileId, versionName) {
  try {
    // Drive API v2: revisions list returns `items`; pinning uses `pinned`.
    var revisions = Drive.Revisions.list(fileId);
    var list = revisions.items || [];
    if (list.length === 0) return;
    var latest = list[list.length - 1];
    Drive.Revisions.update({ pinned: true }, fileId, latest.id);
  } catch (e) {}
}

function getFirstLines(file, n) {
  try {
    var doc = DocumentApp.openById(file.getId());
    var text = '';
    try {
      var header = doc.getHeader();
      if (header) {
        var headerText = header.getText();
        if (headerText) text += headerText + '\n';
      }
    } catch (he) {}
    text += doc.getBody().getText();
    if (!text) return null;
    return text.split('\n').slice(0, n);
  } catch (e) {
    return null;
  }
}

/**
 * Find a Doc by KA ID or slug URL in the production folder. Fast path reads
 * KA_META from the Drive description (2- and 3-field formats both match);
 * slow path reads the doc header for pre-metadata docs.
 */
function findDocByKaIdOrUrl(targetKaId, targetUrl) {
  var matchesByKaId = [];
  var matchesByUrl = [];
  var normalizedTargetUrl = normalizeToSlugUrl(targetUrl);
  var normalizedKaId = (targetKaId || '').toString().trim();

  var pageToken = null;
  do {
    // Drive API v2 surface (required for convert:true on insert/update):
    // list uses maxResults and returns `items`.
    var resp = Drive.Files.list({
      q: "'" + KA_FOLDER_ID + "' in parents and mimeType='application/vnd.google-apps.document' and trashed=false",
      fields: 'nextPageToken, items(id, title, description, modifiedDate)',
      maxResults: 100, pageToken: pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    var items = resp.items || [];
    for (var x = 0; x < items.length; x++) {
      var item = items[x];
      var desc = item.description || '';
      var metaMatch = desc.match(/^KA_META:([^|\n]*)\|([^|\n]*)/);
      if (metaMatch) {
        var descKaId = (metaMatch[1] || '').trim();
        var descUrl  = normalizeToSlugUrl((metaMatch[2] || '').trim());
        if (normalizedKaId && descKaId && descKaId === normalizedKaId) {
          try { matchesByKaId.push(DriveApp.getFileById(item.id)); } catch (e) {}
        } else if (descUrl && descUrl === normalizedTargetUrl) {
          try { matchesByUrl.push(DriveApp.getFileById(item.id)); } catch (e) {}
        }
        continue;
      }
      var file;
      try { file = DriveApp.getFileById(item.id); } catch (e) { continue; }
      var lines = getFirstLines(file, 8);
      if (!lines) continue;
      var fileKaId = '', fileUrl = '';
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('Published link:') === 0) fileUrl = lines[i].substring('Published link:'.length).trim();
        if (lines[i].indexOf('KA ID:') === 0) fileKaId = lines[i].substring('KA ID:'.length).trim();
      }
      if (normalizedKaId && fileKaId && fileKaId === normalizedKaId) { matchesByKaId.push(file); continue; }
      if (fileUrl && normalizeToSlugUrl(fileUrl) === normalizedTargetUrl) matchesByUrl.push(file);
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);

  if (matchesByKaId.length === 1) return { status: 'FOUND', doc: matchesByKaId[0], matchedBy: 'kaId' };
  if (matchesByKaId.length > 1) {
    return { status: 'MULTIPLE', candidates: matchesByKaId.map(function(m) { return { id: m.getId(), name: m.getName() }; }) };
  }
  if (matchesByUrl.length === 1) return { status: 'FOUND', doc: matchesByUrl[0], matchedBy: 'url' };
  if (matchesByUrl.length > 1) {
    return { status: 'MULTIPLE', candidates: matchesByUrl.map(function(m) { return { id: m.getId(), name: m.getName() }; }) };
  }
  return { status: 'NOT_FOUND' };
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

function _json(obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.server == null) obj.server = CODE_VERSION;
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════
// ── WEEKLY CONTENT INDEX AUDIT ──────────────────────────────────────────────
// The admin Tampermonkey script reads Nichole's 3 "Content Index" reports
// (GTM / Support / T&S) and the "Published Articles" list view in the
// browser, then posts them here. This compares them with the Published and
// Archived Drive folders, writes the ka_audit tab, appends ka_audit_log and
// emails a summary to the script owner (+ AUDIT_EMAILS script property).
// ═══════════════════════════════════════════════════════════════════════════

var AUDIT_TAB = 'ka_audit';
var AUDIT_LOG_TAB = 'ka_audit_log';
var SF_LIGHTNING = 'https://thumbtack.lightning.force.com';

// Report → team, as named in Doc filenames.
var AUDIT_REPORTS = [
  { team: 'GTM',            reportId: '00OVx000006OQHFMA4', label: 'GTM KAs: Active' },
  { team: 'Support Ops',    reportId: '00OVx000006GGADMA4', label: 'Support KAs: Active' },
  { team: 'Trust & Safety', reportId: '00OVx000006ORWfMAO', label: 'T&S KAs: Active' },
];
var TEAM_ALIASES = { 'Sales': 'GTM' };
// A Doc synced a few minutes before the last Salesforce save is not outdated.
var OUTDATED_TOLERANCE_MS = 10 * 60 * 1000;

// Most urgent first. Each KA gets one row with its most urgent status.
var AUDIT_STATUSES = [
  { key: 'MISSING_DOC',         label: 'In Salesforce, no Doc',          color: '#f4c7c3' },
  { key: 'ARCHIVED_BUT_ACTIVE', label: 'Archived by mistake',            color: '#f4c7c3' },
  { key: 'EMPTY_DOC',           label: 'Doc is empty',                   color: '#f4c7c3' },
  { key: 'DUPLICATE_DOCS',      label: 'Duplicate Docs',                 color: '#fce8b2' },
  { key: 'OUTDATED',            label: 'Outdated',                       color: '#fce8b2' },
  { key: 'WRONG_TEAM',          label: 'Different team',                 color: '#fff2cc' },
  { key: 'EXTRA_DOC',           label: 'Extra Doc (not in any report)', color: '#fff2cc' },
  { key: 'NO_META',             label: 'Doc missing KA info',            color: '#e8eaed' },
  { key: 'OK',                  label: 'OK',                             color: '#d9ead3' },
];

function _statusInfo(key) {
  for (var i = 0; i < AUDIT_STATUSES.length; i++) if (AUDIT_STATUSES[i].key === key) return AUDIT_STATUSES[i];
  return { key: key, label: key, color: '#ffffff' };
}

function _statusRank(key) {
  for (var i = 0; i < AUDIT_STATUSES.length; i++) if (AUDIT_STATUSES[i].key === key) return i;
  return AUDIT_STATUSES.length;
}

// URL Names are case-sensitive: "Background-checks" and "Background-Checks"
// are two different KAs, so the slug keeps its case.
function _slugOf(url) {
  var m = (url || '').match(/\/articles\/Knowledge\/([^?#\/]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

function _teamFromTitle(title) {
  var m = (title || '').match(/ - internal - (.+?) - [A-Za-z]{2}$/);
  if (!m) return '';
  var t = m[1].trim();
  return TEAM_ALIASES[t] || t;
}

/** Docs of one folder with what the audit needs. */
function _auditDocs(folderId) {
  var out = [], pageToken = null;
  do {
    var resp = Drive.Files.list({
      q: "'" + folderId + "' in parents and mimeType='application/vnd.google-apps.document' and trashed=false",
      fields: 'nextPageToken, items(id, title, description, modifiedDate)',
      maxResults: 200, pageToken: pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    var items = resp.items || [];
    for (var i = 0; i < items.length; i++) {
      var d = items[i];
      var meta = _parseKaMetaLine(d.description || '');
      out.push({
        docId: d.id, title: d.title || '',
        kaId: meta.kaId, slug: _slugOf(meta.url),
        team: _teamFromTitle(d.title || ''),
        modifiedMs: d.modifiedDate ? new Date(d.modifiedDate).getTime() : 0,
      });
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Pure comparison (no Google services), so it can be tested offline.
 *   reports:   [{ team, rows: [{ recordId, urlName, title }] }]
 *   published: [{ id, articleNumber, title, urlName, version, lastModified }]
 *   pubDocs / arcDocs: output of _auditDocs
 *   opts.docVersion(docId) (optional): the "Version" in the Doc header, or ''
 * Returns { rows: [...], counts: { STATUS: n } }.
 */
function runAudit(reports, published, pubDocs, arcDocs, opts) {
  opts = opts || {};
  var pubById = {};
  for (var p = 0; p < published.length; p++) pubById[published[p].id] = published[p];

  function index(docs) {
    var byNum = {}, bySlug = {};
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (d.kaId) (byNum[d.kaId] = byNum[d.kaId] || []).push(d);
      if (d.slug) (bySlug[d.slug] = bySlug[d.slug] || []).push(d);
    }
    return { byNum: byNum, bySlug: bySlug };
  }
  // KA number first; the URL Name only counts for Docs that carry no number
  // (or the same one), so another KA's Doc is never pulled in by its slug.
  function find(ix, num, slug) {
    var seen = {}, out = [];
    function add(d) { if (!seen[d.docId]) { seen[d.docId] = true; out.push(d); } }
    (num ? ix.byNum[num] || [] : []).forEach(add);
    (slug ? ix.bySlug[slug] || [] : []).forEach(function (d) {
      if (!d.kaId || d.kaId === num) add(d);
    });
    return out;
  }

  var pubIx = index(pubDocs), arcIx = index(arcDocs);
  var used = {};
  var rows = [];
  var seenKa = {};

  for (var r = 0; r < reports.length; r++) {
    var team = reports[r].team;
    var list = reports[r].rows || [];
    for (var k = 0; k < list.length; k++) {
      var row = list[k];
      if (!row.recordId || seenKa[row.recordId]) continue;
      seenKa[row.recordId] = true;
      var info = pubById[row.recordId] || {};
      var num = info.articleNumber || '';
      var slug = info.urlName || row.urlName || '';
      var ka = {
        team: team, title: _plainTitle(info.title || row.title || ''), articleNumber: num,
        recordId: row.recordId, lastModified: info.lastModified || '', lastModifiedBy: info.lastModifiedBy || '',
      };
      var matches = find(pubIx, num, slug);
      var status, doc = null, notes = [];
      if (matches.length > 1) {
        status = 'DUPLICATE_DOCS';
        for (var m = 0; m < matches.length; m++) used[matches[m].docId] = true;
        doc = matches[0];
        notes.push(matches.length + ' Docs: ' + matches.map(function (x) { return x.title; }).join(' | '));
      } else if (matches.length === 1) {
        doc = matches[0];
        used[doc.docId] = true;
        var found = [];
        // a sync of a KA that hadn't finished loading left the Doc "Untitled" and empty
        if (/^\s*untitled\b/i.test(doc.title || '')) {
          found.push('EMPTY_DOC');
          notes.push('The Doc came out "Untitled" with no text from a sync: click Update on the KA');
        }
        var sfMs = ka.lastModified ? Date.parse(ka.lastModified) : 0;
        if (sfMs && doc.modifiedMs && sfMs - doc.modifiedMs > OUTDATED_TOLERANCE_MS) {
          // Salesforce changed after the last sync. The version number alone
          // can't tell us the content is the same: a minor edit published
          // without "new version" keeps the number. So it is outdated either way.
          var docV = opts.docVersion ? String(opts.docVersion(doc.docId) || '') : '';
          var sfV = info.version != null ? String(info.version) : '';
          found.push('OUTDATED');
          notes.push(docV && sfV && docV === sfV
            ? 'Edited in Salesforce after the last sync (same version v' + sfV + ', minor edit)'
            : docV && sfV ? 'Doc is v' + docV + ', Salesforce is v' + sfV
                          : 'Changed in Salesforce after the last sync');
        }
        if (doc.team && doc.team !== team) {
          found.push('WRONG_TEAM');
          notes.push('The Doc says "' + doc.team + '", the report says "' + team + '"');
        }
        if (!info.id) notes.push('Not found in "Published Articles"');
        found.sort(function (a, b) { return _statusRank(a) - _statusRank(b); });
        status = found.length ? found[0] : 'OK';
      } else {
        var arc = find(arcIx, num, slug);
        if (arc.length) {
          status = 'ARCHIVED_BUT_ACTIVE';
          doc = arc[0];
          notes.push('In the Archived folder, but still in a report');
        } else {
          status = 'MISSING_DOC';
          notes.push('Nobody clicked "+ New" yet');
        }
      }
      rows.push({ status: status, ka: ka, doc: doc, note: notes.join('; ') });
    }
  }

  for (var x = 0; x < pubDocs.length; x++) {
    var d = pubDocs[x];
    if (used[d.docId]) continue;
    var st = (!d.kaId && !d.slug) ? 'NO_META' : 'EXTRA_DOC';
    rows.push({
      status: st, doc: d,
      ka: { team: d.team, title: d.title.split(' - internal')[0], articleNumber: d.kaId, recordId: '', lastModified: '' },
      note: st === 'NO_META' ? 'Click "Update" on its KA so it saves its info' : 'Not in any report anymore: archive it?',
    });
  }

  rows.sort(function (a, b) {
    return (_statusRank(a.status) - _statusRank(b.status)) ||
      String(a.ka.team).localeCompare(String(b.ka.team)) ||
      String(a.ka.title).toLowerCase().localeCompare(String(b.ka.title).toLowerCase());
  });
  var counts = {};
  for (var s = 0; s < AUDIT_STATUSES.length; s++) counts[AUDIT_STATUSES[s].key] = 0;
  for (var q = 0; q < rows.length; q++) counts[rows[q].status] = (counts[rows[q].status] || 0) + 1;
  return { rows: rows, counts: counts };
}

function _validateAuditRequest(req) {
  var reports = req.reports || [];
  if (!reports.length) return 'No reports were sent';
  var teams = {};
  for (var i = 0; i < reports.length; i++) {
    var rep = reports[i];
    var n = (rep.rows || []).length;
    if (rep.total != null && n < rep.total) {
      return 'Report "' + rep.team + '" is incomplete: ' + n + ' of ' + rep.total + ' rows';
    }
    if (!n) return 'Report "' + rep.team + '" came back empty';
    teams[rep.team] = true;
  }
  for (var j = 0; j < AUDIT_REPORTS.length; j++) {
    if (!teams[AUDIT_REPORTS[j].team]) return 'Missing report: ' + AUDIT_REPORTS[j].team;
  }
  return '';
}

// Read-only: which KA (URL Name) each published Doc belongs to, per team.
function handleAuditDocs() {
  var docs = _auditDocs(KA_FOLDER_ID).map(function (d) {
    return { team: TEAM_ALIASES[d.team] || d.team, slug: d.slug, kaId: d.kaId };
  });
  return { ok: true, docs: docs };
}

// A normal week has a handful of extra Docs per team. Dozens in one team means
// that team's report was only partly read: never save that as the audit.
var AUDIT_MAX_EXTRA_PER_TEAM = 10;

function _suspectAudit(rows) {
  var extra = {};
  rows.forEach(function (r) {
    if (r.status !== 'EXTRA_DOC') return;
    var t = (r.ka && r.ka.team) || 'unknown';
    extra[t] = (extra[t] || 0) + 1;
  });
  var bad = Object.keys(extra).filter(function (t) { return extra[t] > AUDIT_MAX_EXTRA_PER_TEAM; });
  if (!bad.length) return '';
  return bad.map(function (t) { return extra[t] + ' ' + t + ' Docs are missing from the ' + t + ' report'; }).join('; ') +
    '. That report was not read completely. Nothing was written. Run the audit again.';
}

function handleAudit(req) {
  var problem = _validateAuditRequest(req);
  if (problem) return { ok: false, code: 'BAD_REQUEST', error: problem };

  var pubDocs = _auditDocs(KA_FOLDER_ID);
  var arcDocs = _auditDocs(ARCHIVED_FOLDER_ID);
  var result = runAudit(req.reports, req.published || [], pubDocs, arcDocs, { docVersion: _docHeaderVersion });
  var suspect = _suspectAudit(result.rows);
  if (suspect) return { ok: false, code: 'INCOMPLETE_REPORT', error: suspect, counts: result.counts };

  var now = Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd HH:mm');
  var by = (req.by || 'unknown').toString();
  var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
  var sheet = _writeAuditTab(ss, result.rows, now);
  _appendAuditLog(ss, now, by, req, result, pubDocs.length);

  var sheetUrl = 'https://docs.google.com/spreadsheets/d/' + CORPUS_SHEET_ID + '/edit#gid=' + sheet.getSheetId();
  try { _emailAuditSummary(now, by, result, sheetUrl); } catch (e) {}

  return {
    ok: true, auditedAt: now, total: result.rows.length, counts: result.counts,
    sheetUrl: sheetUrl, publishedDocs: pubDocs.length, archivedDocs: arcDocs.length,
  };
}

// "Version: N" from the Doc's page header ('' when it is not there).
function _docHeaderVersion(docId) {
  try {
    var doc = DocumentApp.openById(docId);
    var header = doc.getHeader();
    var text = header ? header.getText() : '';
    var m = text.match(/Version:\s*(\d+)/i);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

// Salesforce can send titles HTML-escaped ("Thumbtack&#39;s"): back to plain text.
function _plainTitle(t) {
  return String(t || '').replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function _fmtIso(iso) {
  if (!iso) return '';
  var ms = Date.parse(iso);
  return isNaN(ms) ? String(iso) : Utilities.formatDate(new Date(ms), LOCAL_TZ, 'yyyy-MM-dd HH:mm');
}

function _writeAuditTab(ss, rows, now) {
  var header = ['status', 'team', 'title', 'KA number', 'Salesforce', 'Doc',
                'modified in Salesforce', 'modified by', 'last Doc change', 'note', 'audited'];
  var data = rows.map(function (r) {
    var ka = r.ka || {}, doc = r.doc;
    return [
      // Leading apostrophe keeps "000015509" as text (no lost zeros).
      _statusInfo(r.status).label, ka.team || '', ka.title || '', ka.articleNumber ? "'" + ka.articleNumber : '',
      ka.recordId ? SF_LIGHTNING + '/lightning/r/Knowledge__kav/' + ka.recordId + '/view' : '',
      doc ? 'https://docs.google.com/document/d/' + doc.docId + '/edit' : '',
      _fmtIso(ka.lastModified), ka.lastModifiedBy || '',
      doc && doc.modifiedMs ? Utilities.formatDate(new Date(doc.modifiedMs), LOCAL_TZ, 'yyyy-MM-dd HH:mm') : '',
      r.note || '', now,
    ];
  });
  var sh = _writeTab(ss, AUDIT_TAB, header, data);
  if (data.length) {
    var colors = rows.map(function (r) { return [_statusInfo(r.status).color]; });
    sh.getRange(2, 1, data.length, 1).setBackgrounds(colors);
  }
  sh.autoResizeColumns(1, 4);
  return sh;
}

function _appendAuditLog(ss, now, by, req, result, pubDocCount) {
  var sh = ss.getSheetByName(AUDIT_LOG_TAB);
  var keys = AUDIT_STATUSES.map(function (s) { return s.key; });
  if (!sh) {
    sh = ss.insertSheet(AUDIT_LOG_TAB);
    sh.appendRow(['audited', 'by', 'KAs in reports', 'published Docs'].concat(keys));
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, 4 + keys.length).setFontWeight('bold');
  }
  var inReports = 0;
  for (var i = 0; i < req.reports.length; i++) inReports += (req.reports[i].rows || []).length;
  sh.appendRow([now, by, inReports, pubDocCount].concat(keys.map(function (k) { return result.counts[k] || 0; })));
}

function _auditRecipients() {
  var list = [];
  try { var me = Session.getEffectiveUser().getEmail(); if (me) list.push(me); } catch (e) {}
  var extra = PropertiesService.getScriptProperties().getProperty('AUDIT_EMAILS') || '';
  extra.split(',').forEach(function (x) { x = x.trim(); if (x && list.indexOf(x) === -1) list.push(x); });
  return list;
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function _emailAuditSummary(now, by, result, sheetUrl) {
  var to = _auditRecipients();
  if (!to.length) return;
  var problems = result.rows.length - (result.counts.OK || 0);
  var lines = AUDIT_STATUSES.map(function (s) {
    return '<tr><td style="padding:4px 10px;background:' + s.color + '">' + _esc(s.label) +
      '</td><td style="padding:4px 10px;text-align:right"><b>' + (result.counts[s.key] || 0) + '</b></td></tr>';
  }).join('');
  var top = result.rows.filter(function (r) { return r.status !== 'OK'; }).slice(0, 25).map(function (r) {
    var link = r.ka && r.ka.recordId ? SF_LIGHTNING + '/lightning/r/Knowledge__kav/' + r.ka.recordId + '/view'
      : (r.doc ? 'https://docs.google.com/document/d/' + r.doc.docId + '/edit' : '');
    return '<li><b>' + _esc(_statusInfo(r.status).label) + '</b> · ' + _esc(r.ka.team) + ' · ' +
      (link ? '<a href="' + link + '">' + _esc(r.ka.title) + '</a>' : _esc(r.ka.title)) +
      (r.ka.lastModifiedBy ? ' <span style="color:#666">· last edited by ' + _esc(r.ka.lastModifiedBy) + ' on ' + _esc(_fmtIso(r.ka.lastModified)) + '</span>' : '') + '</li>';
  }).join('');
  var byPerson = _outdatedByPerson(result.rows);
  var html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2f3033">' +
    '<h2 style="margin:0 0 6px">Content Index audit</h2>' +
    '<p style="margin:0 0 12px;color:#666">' + _esc(now) + ' · run by ' + _esc(by) + '</p>' +
    '<p>' + (problems ? '<b>' + problems + '</b> KA' + (problems === 1 ? ' needs' : 's need') + ' attention.' : 'Everything is up to date. ✅') + '</p>' +
    '<table style="border-collapse:collapse;margin:8px 0 14px">' + lines + '</table>' +
    (byPerson ? '<p style="margin:0 0 4px"><b>Not synced yet, by who last edited it in Salesforce:</b></p>' + byPerson : '') +
    (top ? '<p style="margin:0 0 4px"><b>To do:</b></p><ul>' + top + '</ul>' : '') +
    '<p><a href="' + sheetUrl + '">See the full audit in the sheet</a></p></div>';
  MailApp.sendEmail({
    to: to.join(','),
    subject: 'KA audit ' + now.slice(0, 10) + (problems ? ' — ' + problems + ' to do' : ' — all up to date'),
    htmlBody: html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ── WEEKLY REPORT ───────────────────────────────────────────────────────────
// The "📅 Weekly report" button (run it on Fridays) posts the Published
// Articles list. This compares it with what was seen last week:
//   NEW          first published this week
//   NEW_VERSION  the version number went up (published as a new version)
//   MINOR_EDIT   edited this week but the version number stayed the same
//   ARCHIVED     archived this week
// and who did each one in Salesforce.
// ═══════════════════════════════════════════════════════════════════════════

var WEEKLY_TAB = 'ka_weekly';
var WEEKLY_LOG_TAB = 'ka_weekly_log';
var WEEKLY_SNAP_TAB = 'ka_weekly_snapshot';
var DAY_MS = 24 * 60 * 60 * 1000;
var WEEKLY_KINDS = [
  { key: 'NEW_VERSION', label: 'New version', color: '#cfe2f3' },
  { key: 'MINOR_EDIT',  label: 'Minor edit',  color: '#fff2cc' },
  { key: 'NEW',         label: 'New KA',      color: '#d9ead3' },
  { key: 'ARCHIVED',    label: 'Archived',    color: '#f4c7c3' },
];

function _weeklyKind(key) {
  for (var i = 0; i < WEEKLY_KINDS.length; i++) if (WEEKLY_KINDS[i].key === key) return WEEKLY_KINDS[i];
  return { key: key, label: key, color: '#ffffff' };
}

/**
 * Pure (no Google services).
 *   published: [{ id, articleNumber, title, version, lastModified, lastModifiedBy,
 *                 firstPublished, lastPublished, createdBy }]
 *   archived:  [{ id, articleNumber, title, version, archived, archivedBy }] or
 *              null when Salesforce has no "Archived Articles" list
 *   baseline:  { articleNumber: { version, title } } from last week, or null (first run)
 *   docs:      _auditDocs of the Published folder (only for the team name)
 * Returns { rows: [{ kind, ka, prevVersion, by, at }], counts }.
 */
function runWeekly(published, archived, baseline, docs, sinceMs, untilMs) {
  var teamByNum = {};
  (docs || []).forEach(function (d) { if (d.kaId && d.team) teamByNum[d.kaId] = d.team; });
  var inWeek = function (ms) { return ms && ms > sinceMs && ms <= untilMs; };
  var ms = function (iso) { var t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? 0 : t; };
  var rows = [], counts = {};
  WEEKLY_KINDS.forEach(function (k) { counts[k.key] = 0; });
  var add = function (kind, p, v, prevVersion, by, at) {
    var num = String(p.articleNumber || '');
    counts[kind]++;
    rows.push({ kind: kind, prevVersion: prevVersion, by: by || '', at: at,
      ka: { recordId: p.id || '', articleNumber: num, title: _plainTitle(p.title), version: v ? String(v) : '', team: teamByNum[num] || '' } });
  };
  var live = {};
  (published || []).forEach(function (p) {
    var num = String(p.articleNumber || ''), v = +p.version || 0;
    live[num] = true;
    var lm = ms(p.lastModified), fp = ms(p.firstPublished), lp = ms(p.lastPublished);
    var prev = baseline ? baseline[num] : null;
    if (inWeek(fp) || (baseline && !prev && (inWeek(lm) || inWeek(lp))) || (!baseline && v === 1 && !fp && inWeek(lm))) {
      add('NEW', p, v, '', p.createdBy || p.lastModifiedBy, fp || lp || lm);
    } else if ((prev && v > (+prev.version || 0)) || (!baseline && v > 1 && inWeek(lp))) {
      add('NEW_VERSION', p, v, prev ? String(prev.version) : String(v - 1), p.lastModifiedBy, lp > lm ? lp : lm);
    } else if (inWeek(lm)) {
      add('MINOR_EDIT', p, v, '', p.lastModifiedBy, lm);
    }
  });
  // Archived this week. Publishing a new version archives the old one, so an
  // article that is still published was not archived.
  var seenArc = {};
  if (archived) {
    archived.forEach(function (a) {
      var num = String(a.articleNumber || ''), at = ms(a.archived);
      if (!num || live[num] || !inWeek(at)) return;
      if (seenArc[num] && seenArc[num].at >= at) return;
      seenArc[num] = { a: a, at: at };
    });
    Object.keys(seenArc).forEach(function (num) { var x = seenArc[num]; add('ARCHIVED', x.a, +x.a.version || 0, '', x.a.archivedBy, x.at); });
  } else if (baseline) {
    // no archived list: a KA that was published last week and is gone now
    Object.keys(baseline).forEach(function (num) {
      if (live[num]) return;
      add('ARCHIVED', { articleNumber: num, title: baseline[num].title || ('KA ' + num) }, +baseline[num].version || 0, '', '', untilMs);
    });
  }
  var rank = { NEW_VERSION: 0, MINOR_EDIT: 1, NEW: 2, ARCHIVED: 3 };
  rows.sort(function (x, y) { return rank[x.kind] - rank[y.kind] || y.at - x.at; });
  return { rows: rows, counts: counts };
}

// Two generations of versions seen: "cur" (last run) and "prev" (the run before).
function _readWeeklySnapshot(ss) {
  var sh = ss.getSheetByName(WEEKLY_SNAP_TAB);
  var out = { cur: null, prev: null };
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  data.forEach(function (r) {
    var gen = String(r[0]), num = String(r[1]).replace(/^'/, '');
    if (gen !== 'cur' && gen !== 'prev') return;
    var g = out[gen] || (out[gen] = { at: 0, map: {} });
    g.map[num] = { version: r[2], title: r[4] || '' };
    var at = r[3] instanceof Date ? r[3].getTime() : Date.parse(r[3]);
    if (at && at > g.at) g.at = at;
  });
  return out;
}

function _writeWeeklySnapshot(ss, snap) {
  var rows = [];
  ['cur', 'prev'].forEach(function (gen) {
    var g = snap[gen]; if (!g) return;
    var at = new Date(g.at).toISOString();
    Object.keys(g.map).forEach(function (num) { rows.push([gen, "'" + num, g.map[num].version, at, g.map[num].title || '']); });
  });
  _writeTab(ss, WEEKLY_SNAP_TAB, ['generation', 'KA number', 'version', 'seen at', 'title'], rows);
}

// Which baseline and window this run uses. A re-run within 3 days of the last
// one keeps the same week (and the same baseline) instead of starting a new one.
function _weeklyWindow(snap, nowMs) {
  if (snap.cur && nowMs - snap.cur.at < 3 * DAY_MS) {
    return { baseline: snap.prev ? snap.prev.map : null, sinceMs: snap.prev ? snap.prev.at : nowMs - 7 * DAY_MS, rerun: true };
  }
  return { baseline: snap.cur ? snap.cur.map : null, sinceMs: snap.cur ? snap.cur.at : nowMs - 7 * DAY_MS, rerun: false };
}

function handleWeekly(req) {
  var published = req.published || [];
  if (!published.length) return { ok: false, code: 'BAD_REQUEST', error: 'The Published Articles list came empty' };
  var archived = Array.isArray(req.archived) ? req.archived : null;
  var nowMs = Date.now();
  var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
  var snap = _readWeeklySnapshot(ss);
  var win = _weeklyWindow(snap, nowMs);
  var docs = [];
  try { docs = _auditDocs(KA_FOLDER_ID); } catch (e) {}
  var result = runWeekly(published, archived, win.baseline, docs, win.sinceMs, nowMs);

  var fmt = function (t) { return t ? Utilities.formatDate(new Date(t), LOCAL_TZ, 'yyyy-MM-dd HH:mm') : ''; };
  var day = function (t) { return Utilities.formatDate(new Date(t), LOCAL_TZ, 'MMM d'); };
  var week = day(win.sinceMs) + ' – ' + day(nowMs);
  var by = (req.by || 'unknown').toString();
  var header = ['change', 'team', 'title', 'KA number', 'version', 'previous version', 'by', 'when', 'Salesforce', 'week', 'run'];
  var data = result.rows.map(function (r) {
    return [_weeklyKind(r.kind).label, r.ka.team, r.ka.title, "'" + r.ka.articleNumber, r.ka.version, r.prevVersion, r.by, fmt(r.at),
      r.ka.recordId ? SF_LIGHTNING + '/lightning/r/Knowledge__kav/' + r.ka.recordId + '/view' : '', week, fmt(nowMs)];
  });
  var sh = _writeTab(ss, WEEKLY_TAB, header, data);
  if (data.length) sh.getRange(2, 1, data.length, 1).setBackgrounds(result.rows.map(function (r) { return [_weeklyKind(r.kind).color]; }));
  var log = ss.getSheetByName(WEEKLY_LOG_TAB);
  if (!log) { log = ss.insertSheet(WEEKLY_LOG_TAB); log.appendRow(header); log.setFrozenRows(1); log.getRange(1, 1, 1, header.length).setFontWeight('bold'); }
  if (data.length) log.getRange(log.getLastRow() + 1, 1, data.length, header.length).setValues(data);

  // remember the versions seen now
  var map = {};
  published.forEach(function (p) { if (p.articleNumber) map[String(p.articleNumber)] = { version: +p.version || 0, title: _plainTitle(p.title) }; });
  _writeWeeklySnapshot(ss, { cur: { at: nowMs, map: map }, prev: win.rerun ? snap.prev : snap.cur });

  var sheetUrl = 'https://docs.google.com/spreadsheets/d/' + CORPUS_SHEET_ID + '/edit#gid=' + sh.getSheetId();
  try { _emailWeekly(week, by, result, sheetUrl, !win.baseline, archived === null, fmt); } catch (e) {}
  return { ok: true, counts: result.counts, total: result.rows.length, week: week, firstRun: !win.baseline, sheetUrl: sheetUrl };
}

function _emailWeekly(week, by, result, sheetUrl, firstRun, noArchivedList, fmt) {
  var to = _auditRecipients();
  if (!to.length) return;
  var c = result.counts;
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
  var item = function (r) {
    var link = r.ka.recordId ? SF_LIGHTNING + '/lightning/r/Knowledge__kav/' + r.ka.recordId + '/view' : '';
    var ver = r.kind === 'NEW_VERSION' ? 'v' + r.prevVersion + ' → v' + r.ka.version
      : r.kind === 'MINOR_EDIT' ? 'still v' + r.ka.version : r.ka.version ? 'v' + r.ka.version : '';
    return '<li>' + (link ? '<a href="' + link + '">' + _esc(r.ka.title) + '</a>' : _esc(r.ka.title)) +
      ' <span style="color:#666">· ' + (r.ka.team ? _esc(r.ka.team) + ' · ' : '') + (ver ? ver + ' · ' : '') +
      'by <b>' + _esc(r.by || 'unknown') + '</b> on ' + _esc(fmt(r.at)) + '</span></li>';
  };
  var section = function (key, title, help) {
    var list = result.rows.filter(function (r) { return r.kind === key; });
    return '<h3 style="margin:16px 0 2px">' + title + ' (' + list.length + ')</h3>' +
      '<p style="margin:0 0 4px;color:#666;font-size:12px">' + help + '</p>' +
      (list.length ? '<ul style="margin:4px 0">' + list.map(item).join('') + '</ul>' : '<p style="margin:4px 0;color:#666">None this week.</p>');
  };
  var people = {}, order = [];
  result.rows.forEach(function (r) {
    var who = r.by || 'unknown';
    if (!people[who]) { people[who] = { NEW_VERSION: 0, MINOR_EDIT: 0, NEW: 0, ARCHIVED: 0, all: 0 }; order.push(who); }
    people[who][r.kind]++; people[who].all++;
  });
  order.sort(function (a, b) { return people[b].all - people[a].all || a.localeCompare(b); });
  var td = 'padding:3px 12px;text-align:right';
  var personRows = order.map(function (who) {
    var x = people[who];
    return '<tr><td style="padding:3px 12px"><b>' + _esc(who) + '</b></td><td style="' + td + '">' + x.NEW_VERSION + '</td><td style="' + td + '">' +
      x.MINOR_EDIT + '</td><td style="' + td + '">' + x.NEW + '</td><td style="' + td + '">' + x.ARCHIVED + '</td></tr>';
  }).join('');
  var updated = c.NEW_VERSION + c.MINOR_EDIT;
  var html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2f3033">' +
    '<h2 style="margin:0 0 6px">Weekly KA report</h2>' +
    '<p style="margin:0 0 12px;color:#666">' + _esc(week) + ' · run by ' + _esc(by) + '</p>' +
    (firstRun ? '<p style="background:#fff2cc;padding:8px 10px">First run: this week is read from Salesforce dates. From next week on, "New version" vs "Minor edit" is compared with the versions saved today.</p>' : '') +
    '<p><b>' + plural(updated, 'KA', 'KAs') + '</b> updated in Salesforce: <b>' + c.NEW_VERSION + '</b> with a new version, <b>' + c.MINOR_EDIT +
    '</b> minor edit' + (c.MINOR_EDIT === 1 ? '' : 's') + ' (no new version).<br><b>' + c.NEW + '</b> new · <b>' + c.ARCHIVED + '</b> archived.</p>' +
    (order.length ? '<table style="border-collapse:collapse;margin:8px 0 6px"><tr style="background:#f1f3f4"><th style="padding:3px 12px;text-align:left">Who</th>' +
      '<th style="padding:3px 12px">New version</th><th style="padding:3px 12px">Minor edit</th><th style="padding:3px 12px">New</th><th style="padding:3px 12px">Archived</th></tr>' +
      personRows + '</table>' : '') +
    section('NEW_VERSION', 'Updated with a new version', 'Published as a new version (the version number went up).') +
    section('MINOR_EDIT', 'Minor edits', 'Edited and published without a new version (same version number).') +
    section('NEW', 'New KAs', 'Published for the first time this week.') +
    section('ARCHIVED', 'Archived KAs', noArchivedList ? 'Published last week and not anymore (Salesforce did not send who archived them).' : 'Archived in Salesforce this week.') +
    '<p style="margin-top:16px"><a href="' + sheetUrl + '">See the weekly report in the sheet</a></p></div>';
  MailApp.sendEmail({
    to: to.join(','),
    subject: 'Weekly KA report ' + week + ' — ' + plural(updated, 'update', 'updates') + ' (' + c.NEW_VERSION + ' new version, ' + c.MINOR_EDIT + ' minor), ' +
      c.NEW + ' new, ' + c.ARCHIVED + ' archived',
    htmlBody: html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ── CONTENTFUL: last update of each Help Center article ─────────────────────
// Once a day (setupContentfulTrigger) syncContentful() reads the Help Center
// space with the Content Management API (read only: GET calls) and writes one
// row per article to the hc_contentful tab: when it was last changed and by
// whom, counting the article AND every segment linked inside it (sections,
// accordions, items...). A segment shared by several articles counts for all
// of them. The Content Index Dashboard reads that tab.
// Script Properties:
//   CONTENTFUL_TOKEN          Content Management API token (required)
//   CONTENTFUL_SPACE          space id (default zkjkphkd3oqx)
//   CONTENTFUL_ENV            environment (default master)
//   CONTENTFUL_ARTICLE_TYPES  content type ids of an article, comma-separated
//                             (default: the type named "Article"; types like
//                             "Article > Segment" are segments, not articles)
// ═══════════════════════════════════════════════════════════════════════════

var HC_CONTENTFUL_TAB = 'hc_contentful';
var CF_DEFAULT_SPACE = 'zkjkphkd3oqx';

function _cfGet(path, token) {
  var url = 'https://api.contentful.com' + path;
  for (var attempt = 0; attempt < 4; attempt++) {
    var resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token } });
    var code = resp.getResponseCode();
    if (code === 429) { Utilities.sleep(1000 * (attempt + 1)); continue; }
    if (code < 200 || code >= 300) throw new Error('Contentful answered HTTP ' + code + ' for ' + path.split('?')[0]);
    return JSON.parse(resp.getContentText());
  }
  throw new Error('Contentful kept saying "too many requests"');
}

// Every item of a CMA collection (pages of 1000).
function _cfAll(path, token) {
  var out = [], skip = 0, sep = path.indexOf('?') === -1 ? '?' : '&';
  for (var guard = 0; guard < 200; guard++) {
    var page = _cfGet(path + sep + 'limit=1000&skip=' + skip, token);
    var items = page.items || [];
    out = out.concat(items);
    skip += items.length;
    if (!items.length || skip >= (page.total || 0)) break;
  }
  return out;
}

// The entries an entry links to (in any field, any locale, rich text included).
function _cfLinks(entry) {
  var ids = [];
  (function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v.sys && v.sys.type === 'Link' && v.sys.linkType === 'Entry' && v.sys.id) { ids.push(v.sys.id); return; }
    Object.keys(v).forEach(function (k) { walk(v[k]); });
  })(entry.fields || {});
  return ids;
}

// The value of a field in the locale that starts with lang ("en", "es", "pt").
function _cfText(entry, names, locales, lang) {
  var f = entry.fields || {};
  for (var i = 0; i < names.length; i++) {
    var byLoc = f[names[i]];
    if (!byLoc || typeof byLoc !== 'object') continue;
    for (var j = 0; j < locales.length; j++) {
      if (locales[j].toLowerCase().indexOf(lang) === 0 && typeof byLoc[locales[j]] === 'string' && byLoc[locales[j]].trim()) return byLoc[locales[j]].trim();
    }
  }
  return '';
}

/**
 * Pure (no Google services), so it can be tested offline.
 *   entries:  CMA entries (sys + fields)
 *   types:    { contentTypeId: name }
 *   users:    { userId: name }
 *   locales:  ['en-US', 'es-US', ...]
 *   articleTypes: content type ids that are an article
 * Returns one row object per article.
 */
function contentfulArticleRows(entries, types, users, locales, articleTypes) {
  var byId = {}, isArticle = {}, usedBy = {};
  articleTypes.forEach(function (t) { isArticle[t] = true; });
  entries.forEach(function (e) { byId[e.sys.id] = e; });
  var typeOf = function (e) { return e.sys.contentType && e.sys.contentType.sys ? e.sys.contentType.sys.id : ''; };
  var who = function (link) { var id = link && link.sys ? link.sys.id : ''; return id ? (users[id] || 'Unknown user (' + id + ')') : ''; };
  var nameOf = function (e) {
    var t = _cfText(e, ['internalName', 'name', 'title', 'heading', 'label', 'question'], locales, 'en') ||
      _cfText(e, ['internalName', 'name', 'title', 'heading', 'label', 'question'], locales, '');
    return (types[typeOf(e)] || typeOf(e) || 'Segment') + (t ? ': ' + t.slice(0, 80) : '');
  };
  var articles = entries.filter(function (e) { return isArticle[typeOf(e)] && !e.sys.archivedAt; });
  // segments of each article: everything linked inside it, without walking into other articles
  var segsOf = {};
  articles.forEach(function (a) {
    var seen = {}, list = [], queue = _cfLinks(a).map(function (id) { return { id: id, d: 1 }; });
    while (queue.length) {
      var q = queue.shift();
      if (seen[q.id] || q.d > 6) continue;
      seen[q.id] = true;
      var e = byId[q.id];
      if (!e || isArticle[typeOf(e)] || e.sys.archivedAt) continue;
      list.push(e);
      (usedBy[e.sys.id] = usedBy[e.sys.id] || {})[a.sys.id] = true;
      _cfLinks(e).forEach(function (id) { queue.push({ id: id, d: q.d + 1 }); });
    }
    segsOf[a.sys.id] = list;
  });
  var ms = function (iso) { var t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? 0 : t; };
  return articles.map(function (a) {
    var parts = [a].concat(segsOf[a.sys.id]);
    var upd = parts[0], pub = null, unpublished = false;
    parts.forEach(function (e) {
      if (ms(e.sys.updatedAt) > ms(upd.sys.updatedAt)) upd = e;
      if (e.sys.publishedAt && (!pub || ms(e.sys.publishedAt) > ms(pub.sys.publishedAt))) pub = e;
      // a draft saved after the last publish: version is more than publishedVersion + 1
      if (e.sys.publishedVersion != null && e.sys.version > e.sys.publishedVersion + 1) unpublished = true;
      if (e.sys.publishedVersion == null && e === a) unpublished = true;
    });
    var shared = upd === a ? 0 : Object.keys(usedBy[upd.sys.id] || {}).length - 1;
    return {
      entryId: a.sys.id, contentType: types[typeOf(a)] || typeOf(a),
      titleEN: _cfText(a, ['title', 'name', 'internalName'], locales, 'en'),
      titleES: _cfText(a, ['title', 'name'], locales, 'es'),
      titlePT: _cfText(a, ['title', 'name'], locales, 'pt'),
      slug: _cfText(a, ['slug', 'urlSlug', 'url'], locales, 'en'),
      lastUpdated: upd.sys.updatedAt || '', lastUpdatedBy: who(upd.sys.updatedBy),
      changedIn: upd === a ? 'The article' : nameOf(upd), sharedWith: shared,
      lastPublished: pub ? pub.sys.publishedAt : '', lastPublishedBy: pub ? who(pub.sys.publishedBy) : '',
      unpublishedChanges: unpublished, segments: segsOf[a.sys.id].length,
      internalName: _cfText(a, ['name', 'internalName'], locales, 'en'),
    };
  }).sort(function (x, y) { return ms(y.lastUpdated) - ms(x.lastUpdated); });
}

// The content types that ARE an article. Types named like "Article > Segment" or
// "Article > Tip" are pieces inside an article, not articles. If there is a type
// called exactly "Article", only that one.
function _cfArticleTypes(typeList) {
  var exact = typeList.filter(function (t) { return /^\s*(help\s*center\s*)?article\s*$/i.test(t.name || ''); });
  if (exact.length) return exact.map(function (t) { return t.sys.id; });
  return typeList.filter(function (t) { return /article/i.test(t.sys.id + ' ' + (t.name || '')) && !/[>\/]/.test(t.name || ''); })
    .map(function (t) { return t.sys.id; });
}

function syncContentful() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('CONTENTFUL_TOKEN');
  if (!token) throw new Error('Set the Script Property CONTENTFUL_TOKEN (a Contentful Content Management API token) first.');
  var space = props.getProperty('CONTENTFUL_SPACE') || CF_DEFAULT_SPACE;
  var env = props.getProperty('CONTENTFUL_ENV') || 'master';
  var base = '/spaces/' + space + '/environments/' + env;

  var typeList = _cfAll(base + '/content_types', token);
  var types = {};
  typeList.forEach(function (t) { types[t.sys.id] = t.name || t.sys.id; });
  var wanted = (props.getProperty('CONTENTFUL_ARTICLE_TYPES') || '').split(',').map(function (x) { return x.trim(); }).filter(String);
  var articleTypes = wanted.length ? wanted : _cfArticleTypes(typeList);
  if (!articleTypes.length) throw new Error('No content type looks like an article. Set CONTENTFUL_ARTICLE_TYPES. Types: ' + Object.keys(types).join(', '));
  var locales = _cfAll(base + '/locales', token).map(function (l) { return l.code; });
  var entries = _cfAll(base + '/entries', token);
  var users = {};
  try {
    _cfAll('/spaces/' + space + '/users', token).forEach(function (u) {
      users[u.sys.id] = ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.email || u.sys.id;
    });
  } catch (e) { /* names are nice to have: ids stay */ }

  var rows = contentfulArticleRows(entries, types, users, locales, articleTypes);
  var now = Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd HH:mm');
  var appUrl = 'https://app.contentful.com/spaces/' + space + '/environments/' + env + '/entries/';
  var header = ['entryId', 'contentType', 'titleEN', 'titleES', 'titlePT', 'slug', 'lastUpdated', 'lastUpdatedBy', 'changedIn',
    'sharedWith', 'lastPublished', 'lastPublishedBy', 'unpublishedChanges', 'segments', 'contentfulUrl', 'syncedAt', 'internalName'];
  var data = rows.map(function (r) {
    return [r.entryId, r.contentType, r.titleEN, r.titleES, r.titlePT, r.slug, r.lastUpdated, r.lastUpdatedBy, r.changedIn,
      r.sharedWith, r.lastPublished, r.lastPublishedBy, r.unpublishedChanges ? 'yes' : 'no', r.segments, appUrl + r.entryId, now, r.internalName];
  });
  _writeTab(SpreadsheetApp.openById(CORPUS_SHEET_ID), HC_CONTENTFUL_TAB, header, data);
  var msg = rows.length + ' articles (' + articleTypes.join(', ') + ') from ' + entries.length + ' entries';
  Logger.log(msg);
  return msg;
}

/**
 * syncContentful on demand, for the dashboard button. Only one at a time, and
 * not more than once a minute (it only reads Contentful, so the limit is just
 * to not run it twice by double-clicking).
 */
function refreshContentfulNow() {
  var cache = CacheService.getScriptCache();
  var last = cache.get('cf_refresh_at');
  if (last) return { ok: true, skipped: true, message: 'Contentful was read less than a minute ago (' + last + '). The dashboard already has it.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: false, message: 'Someone else is updating from Contentful right now. Wait a minute and try again.' };
  try {
    var msg = syncContentful();
    cache.put('cf_refresh_at', Utilities.formatDate(new Date(), LOCAL_TZ, 'HH:mm'), 60);
    return { ok: true, message: msg };
  } catch (err) {
    return { ok: false, message: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function _refreshPage(r) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;' +
    'background:#f7f7f8;color:#2f3033;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;padding:16px}' +
    '.c{background:#fff;border:1px solid #e3e6e8;border-radius:10px;padding:28px 30px;max-width:460px}h1{font-size:22px;margin:0 0 8px}' +
    'p{margin:6px 0;line-height:1.5}.ok{color:#1b7a43}.bad{color:#c22d2d}</style></head><body><div class="c">' +
    (r.ok ? '<h1 class="ok">✓ Updated from Contentful</h1>' : '<h1 class="bad">Could not update</h1>') +
    '<p>' + _esc(r.message) + '</p>' +
    '<p>' + (r.ok ? 'You can close this tab. The dashboard reloads by itself when you go back to it.' : 'Close this tab and try again, or tell Claude what it says.') + '</p>' +
    '</div><script>setTimeout(function(){ try { window.close(); } catch (e) {} }, ' + (r.ok ? 2500 : 600000) + ');</script></body></html>';
}

/** Run once: syncContentful every day around 6am (script time zone). */
function setupContentfulTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncContentful') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncContentful').timeBased().everyDays(1).atHour(6).create();
  return 'syncContentful daily trigger set (about 6am, script time zone)';
}

/**
 * Run once: creates the search_names tab in the corpus sheet. Each row is a
 * list of names for the same thing (comma-separated). When an article's title
 * or concepts use one of them, the dashboard searches Linear, Enterpret and
 * Slack with all of them. Never touches the tab if it is already there.
 */
var SEARCH_NAMES_TAB = 'search_names';
function setupSearchNames() {
  var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
  if (ss.getSheetByName(SEARCH_NAMES_TAB)) return 'search_names already exists: nothing changed';
  var sh = ss.insertSheet(SEARCH_NAMES_TAB);
  sh.appendRow(['names', 'notes']);
  sh.appendRow(['preset jobs, claimable jobs, TToD', 'Preset Jobs used to be called claimable jobs; TToD in Linear']);
  sh.appendRow(['preset service calls, claimable service calls', '']);
  sh.setFrozenRows(1);
  return 'search_names created with 2 example rows: add your own';
}

// ═══════════════════════════════════════════════════════════════════════════
// Translation re-audit, without an API key (2.8.0)
//
// 1. buildAuditQueue() (run it, or setupAuditQueueTrigger() for every night)
//    copies the current English and Spanish text of every translated Help
//    Center article from its Doc into the translation_audit_queue tab. The
//    first time, it also keeps a copy of localization_tracker as it was
//    (translation_scores_before_reaudit), so nothing is lost.
// 2. The Content Index Dashboard (Scores tab) gives Claude 5 articles per
//    click from that tab, and keeps the new scores and notes.
// 3. Its "Save to tracker" link opens <web app URL>?save=audit&d=<results>:
//    it shows old → new and writes them to localization_tracker on "Save".
//    It only changes aiScore, auditedDate and notes (never accuracy or status).
// ═══════════════════════════════════════════════════════════════════════════

var TR_AUDIT_QUEUE_TAB = 'translation_audit_queue';
var TR_AUDIT_BEFORE_TAB = 'translation_scores_before_reaudit';
var TR_AUDIT_LOG_TAB = 'translation_audit_log';
var TR_AUDIT_TEXT_MAX = 45000;   // a sheet cell holds 50,000 characters

function _tabObjects(sh) {
  var v = sh ? sh.getDataRange().getValues() : [];
  if (v.length < 2) return { header: v[0] || [], rows: [] };
  var h = v[0];
  return { header: h, rows: v.slice(1).map(function (r, i) { var o = { _row: i + 2 }; h.forEach(function (k, j) { o[k] = r[j]; }); return o; }) };
}

function _docText(id) {
  var t = DocumentApp.openById(id).getBody().getText();
  return t.length > TR_AUDIT_TEXT_MAX ? t.slice(0, TR_AUDIT_TEXT_MAX) + '\n[text cut]' : t;
}

function buildAuditQueue() {
  var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
  var trackerSh = ss.getSheetByName('localization_tracker');
  if (!trackerSh) throw new Error('No localization_tracker tab in the corpus sheet.');
  if (!ss.getSheetByName(TR_AUDIT_BEFORE_TAB)) {
    var all = trackerSh.getDataRange().getValues();
    _writeTab(ss, TR_AUDIT_BEFORE_TAB, all[0], all.slice(1));
  }
  var tr = _tabObjects(trackerSh).rows.filter(function (r) { return r.translationKey && r.docIdEN && r.docIdES; });
  var now = Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd HH:mm');
  var rows = [], failed = [];
  tr.forEach(function (r) {
    try {
      var en = _docText(String(r.docIdEN)), es = _docText(String(r.docIdES));
      var we = en.split(/\s+/).filter(String).length, ws = es.split(/\s+/).filter(String).length;
      rows.push([r.translationKey, r.titleEN || '', String(r.docIdEN), String(r.docIdES), en, es, we, ws, now]);
    } catch (e) { failed.push(r.translationKey + ': ' + (e && e.message || e)); }
  });
  _writeTab(ss, TR_AUDIT_QUEUE_TAB, ['translationKey', 'titleEN', 'docIdEN', 'docIdES', 'enText', 'esText', 'enWords', 'esWords', 'preparedAt'], rows);
  var msg = rows.length + ' translations ready for the re-audit' + (failed.length ? '; could not read ' + failed.length + ': ' + failed.slice(0, 5).join(' | ') : '');
  Logger.log(msg);
  return msg;
}

/** Run once: buildAuditQueue every night around 5am (before the dashboard is used). */
function setupAuditQueueTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'buildAuditQueue') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('buildAuditQueue').timeBased().everyDays(1).atHour(5).create();
  return 'buildAuditQueue daily trigger set (about 5am, script time zone)';
}

// Results are [{k: translationKey, s: score, n: notes (JSON string or object)}]: as base64url JSON in the
// link (a few), or pasted into the save page (any number).
function _checkAuditList(list) {
  if (!Array.isArray(list) || !list.length || list.length > 300) throw new Error('No results to save.');
  return list.map(function (x) {
    var s = Number(x && x.s);
    if (!x || !x.k || isNaN(s) || s < 0 || s > 100) throw new Error('A result is not valid.');
    var n = x.n && typeof x.n === 'object' ? JSON.stringify(x.n) : String(x.n || '');
    var str = function (v, max) { return String(v == null ? '' : v).slice(0, max || 300); };
    return { k: String(x.k), s: Math.round(s), n: n.slice(0, 4000),
      t: str(x.t), en: str(x.en, 80), es: str(x.es, 80), a: str(x.a, 40) };
  });
}
function _readAuditResults(d) {
  var json = Utilities.newBlob(Utilities.base64DecodeWebSafe(String(d || ''))).getDataAsString('UTF-8');
  return _checkAuditList(JSON.parse(json));
}

/** Called from the save page (google.script.run) with the text pasted from the dashboard. */
function saveAuditPaste(text, go) {
  var list;
  try { list = _checkAuditList(JSON.parse(String(text || '').trim())); }
  catch (e) { return { ok: false, message: 'That is not the text copied from the dashboard (' + (e && e.message || e) + ').' }; }
  var r = _saveAuditList(list, go);
  if (r.items) r.items = r.items.map(function (i) { return { title: i.title, old: i.old === '' || i.old == null ? (i.add ? 'new row' : '—') : String(i.old), s: i.x.s, known: !!i.r || i.add }; });
  return r;
}

function saveAuditResults(d, go) {
  try { return _saveAuditList(_readAuditResults(d), go); }
  catch (err) { return { ok: false, message: String(err && err.message || err) }; }
}

function _saveAuditList(list, go) {
  try {
    var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID), sh = ss.getSheetByName('localization_tracker');
    var t = _tabObjects(sh), h = t.header;
    var col = function (name) { var i = h.indexOf(name); if (i < 0) throw new Error('localization_tracker has no "' + name + '" column.'); return i + 1; };
    var cScore = col('aiScore'), cDate = col('auditedDate'), cNotes = col('notes');
    var byKey = {}; t.rows.forEach(function (r) { byKey[String(r.translationKey)] = r; });
    var items = list.map(function (x) { var r = byKey[x.k]; return { x: x, r: r, title: r ? (r.titleEN || x.k) : (x.t || x.k), old: r ? r.aiScore : '', add: !r && !!(x.en && x.es) }; });
    // not in the tracker yet: added as a new row when the dashboard sent its Doc ids, otherwise skipped
    var unknown = items.filter(function (i) { return !i.r && !i.add; });
    if (!go) return { ok: true, preview: true, items: items, unknown: unknown.length };
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return { ok: false, message: 'Busy right now. Try again in a moment.' };
    try {
      var today = Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd'), by = _viewer();
      var log = ss.getSheetByName(TR_AUDIT_LOG_TAB);
      if (!log) { log = ss.insertSheet(TR_AUDIT_LOG_TAB); log.appendRow(['translationKey', 'title', 'oldScore', 'newScore', 'notes', 'savedAt', 'by']); }
      var saved = 0;
      items.forEach(function (i) {
        if (!i.r && i.add) {
          var row = h.map(function (name) {
            return ({ translationKey: i.x.k, titleEN: i.x.t || i.x.k, docIdEN: i.x.en, docIdES: i.x.es, audience: i.x.a,
              aiScore: i.x.s, auditedDate: today, notes: i.x.n })[name] || '';
          });
          sh.appendRow(row);
          log.appendRow([i.x.k, i.title, '', i.x.s, i.x.n, Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd HH:mm'), by]);
          saved++;
          return;
        }
        if (!i.r) return;
        sh.getRange(i.r._row, cScore).setValue(i.x.s);
        sh.getRange(i.r._row, cDate).setValue(today);
        sh.getRange(i.r._row, cNotes).setValue(i.x.n);
        log.appendRow([i.x.k, i.title, i.old, i.x.s, i.x.n, Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd HH:mm'), by]);
        saved++;
      });
      return { ok: true, saved: saved, items: items, unknown: unknown.length };
    } finally { lock.releaseLock(); }
  } catch (err) {
    return { ok: false, message: String(err && err.message || err) };
  }
}

// <web app URL>?save=audit with no data: a page to paste the results copied from the dashboard.
function _pastePage() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f7f7f8;color:#2f3033;margin:0;padding:24px 16px}' +
    '.c{background:#fff;border:1px solid #e3e6e8;border-radius:10px;padding:24px 26px;max-width:680px;margin:0 auto}h1{font-size:21px;margin:0 0 8px}p{margin:6px 0;line-height:1.5}' +
    'textarea{width:100%;height:150px;font:12px monospace;border:1px solid #ccc;border-radius:6px;padding:8px;box-sizing:border-box}button{background:#009fd9;color:#fff;border:0;padding:9px 16px;border-radius:7px;font-weight:600;margin-top:10px;cursor:pointer}' +
    'button:disabled{opacity:.5}table{border-collapse:collapse;width:100%;font-size:14px;margin-top:8px}td{border-bottom:1px solid #eee;padding:6px 4px}.n{text-align:right;white-space:nowrap}.muted{color:#6b7280;font-size:13px}.ok{color:#1b7a43}.bad{color:#c22d2d}</style></head><body><div class="c">' +
    '<h1>Save the new translation scores</h1><p>Paste here what you copied in the dashboard (Cmd + V), then click Check.</p>' +
    '<textarea id="t" placeholder="[{&quot;k&quot;: …"></textarea><div><button id="chk">Check</button> <button id="save" hidden>Save</button></div><div id="out"></div>' +
    '<p class="muted">Changes aiScore, auditedDate (today) and notes in localization_tracker. Accuracy and status stay as they are. Each change also goes to the translation_audit_log tab.</p></div>' +
    '<script>var t=document.getElementById("t"),out=document.getElementById("out"),chk=document.getElementById("chk"),sv=document.getElementById("save");' +
    'function esc(x){return String(x).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}' +
    'function show(r,done){if(!r.ok){out.innerHTML="<p class=bad>"+esc(r.message)+"</p>";sv.hidden=true;return}' +
    'out.innerHTML=(done?"<p class=ok><b>✓ Saved "+r.saved+"</b>. You can close this tab and click Refresh data in the dashboard.</p>":"<p><b>"+r.items.filter(function(i){return i.known}).length+" to save</b>"+(r.unknown?" · "+r.unknown+" not in localization_tracker (skipped)":"")+"</p>")+' +
    '"<table>"+r.items.map(function(i){return "<tr><td>"+esc(i.title)+(i.known?"":" <span class=bad>(skipped)</span>")+"</td><td class=n>"+esc(i.old)+" → <b>"+i.s+"</b></td></tr>"}).join("")+"</table>";sv.hidden=done}' +
    'chk.onclick=function(){chk.disabled=true;google.script.run.withSuccessHandler(function(r){chk.disabled=false;show(r,false)}).withFailureHandler(function(e){chk.disabled=false;out.innerHTML="<p class=bad>"+esc(e.message||e)+"</p>"}).saveAuditPaste(t.value,false)};' +
    'sv.onclick=function(){sv.disabled=true;sv.textContent="Saving…";google.script.run.withSuccessHandler(function(r){show(r,true)}).withFailureHandler(function(e){sv.disabled=false;sv.textContent="Save";out.innerHTML="<p class=bad>"+esc(e.message||e)+"</p>"}).saveAuditPaste(t.value,true)};' +
    '<' + '/script></body></html>';
}

// ═══════════════════════════════════════════════════════════════════════════
// Sync one translation now (2.9.0): <web app URL>?sync=translation&k=<key>
// For the dashboard's "⟳ Sync" button, after a fix is published in Contentful:
// asks HC Auto Sync to rewrite the English and the Spanish Docs from Contentful
// right away (its "sync_single"), then copies their new text into
// translation_audit_queue, so the next score reads the fixed text.
// ?sync=all starts a full Auto Sync and refreshes all the texts ~30 min later.
// ═══════════════════════════════════════════════════════════════════════════

function _publishedLink(docId) {
  try {
    var h = DocumentApp.openById(docId).getHeader();
    var m = (h ? h.getText() : '').match(/Published link:\s*(\S+)/i);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function _queueRow(ss, row) {
  var sh = ss.getSheetByName(TR_AUDIT_QUEUE_TAB);
  var header = ['translationKey', 'titleEN', 'docIdEN', 'docIdES', 'enText', 'esText', 'enWords', 'esWords', 'preparedAt'];
  if (!sh) { sh = ss.insertSheet(TR_AUDIT_QUEUE_TAB); sh.appendRow(header); }
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (String(v[i][0]) === String(row[0])) { sh.getRange(i + 1, 1, 1, row.length).setValues([row]); return; }
  sh.appendRow(row);
}

function syncTranslation(key) {
  try {
    var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
    var tr = _tabObjects(ss.getSheetByName('localization_tracker')).rows.filter(function (r) { return String(r.translationKey) === String(key); })[0];
    if (!tr) return { ok: false, message: 'No row for "' + key + '" in localization_tracker.' };
    if (!tr.docIdEN || !tr.docIdES) return { ok: false, title: tr.titleEN, message: 'This row in localization_tracker has no ' + (!tr.docIdEN ? 'English' : 'Spanish') + ' Doc id (docId' + (!tr.docIdEN ? 'EN' : 'ES') + '). Add it, then try again.' };
    var steps = [];
    var props = PropertiesService.getScriptProperties();
    var configured = !!(props.getProperty('AUTO_SYNC_URL') && props.getProperty('AUTO_SYNC_SECRET'));
    [['English', String(tr.docIdEN)], ['Spanish', String(tr.docIdES)]].forEach(function (x) {
      if (!configured) { steps.push(x[0] + ': Auto Sync not set up (AUTO_SYNC_URL / AUTO_SYNC_SECRET), so the Doc was not refreshed'); return; }
      var url = _publishedLink(x[1]);
      if (!url) { steps.push(x[0] + ': the Doc has no "Published link" in its header, so Auto Sync can\'t refresh it'); return; }
      var r;
      try { r = _autoSyncPost({ action: 'sync_single', url: url }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      steps.push(x[0] + ': ' + (r && r.ok ? 'Doc refreshed from Contentful' : 'Auto Sync could not refresh it (' + ((r && (r.error || r.code)) || 'no answer') + ')'));
    });
    var en = _docText(String(tr.docIdEN)), es = _docText(String(tr.docIdES));
    var now = Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd HH:mm');
    _queueRow(ss, [tr.translationKey, tr.titleEN || '', String(tr.docIdEN), String(tr.docIdES), en, es,
      en.split(/\s+/).filter(String).length, es.split(/\s+/).filter(String).length, now]);
    steps.push('Text copied for the audit (' + now + ')');
    var good = steps.filter(function (s) { return /refreshed from Contentful/.test(s); }).length === 2;
    return { ok: true, title: tr.titleEN || key, steps: steps, good: good };
  } catch (err) {
    return { ok: false, message: String(err && err.message || err) };
  }
}

function syncAllTranslations() {
  var all = _autoSyncRunAll();
  ScriptApp.newTrigger('buildAuditQueue').timeBased().after(30 * 60 * 1000).create();
  return { ok: true, steps: [all || 'Auto Sync is not set up (AUTO_SYNC_URL / AUTO_SYNC_SECRET): the Docs were not refreshed', 'All the texts for the audit will be copied again in about 30 minutes (buildAuditQueue).'] };
}

function _syncPage(r, all) {
  var css = '<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f7f7f8;color:#2f3033;margin:0;padding:24px 16px}' +
    '.c{background:#fff;border:1px solid #e3e6e8;border-radius:10px;padding:24px 26px;max-width:560px;margin:0 auto}h1{font-size:21px;margin:0 0 8px}' +
    'p,li{margin:6px 0;line-height:1.5}.ok{color:#1b7a43}.bad{color:#c22d2d}.warn{color:#9a5b00}.muted{color:#6b7280;font-size:13px}</style>';
  var body = !r.ok ? '<h1 class="bad">Could not sync</h1>' + (r.title ? '<p><b>' + _esc(r.title) + '</b></p>' : '') + '<p>' + _esc(r.message) + '</p>'
    : '<h1 class="' + (all || r.good ? 'ok' : 'warn') + '">' + (all ? '✓ Full sync started' : r.good ? '✓ Synced' : 'Synced, with a warning') + '</h1>' + (r.title ? '<p><b>' + _esc(r.title) + '</b></p>' : '') +
      '<ul>' + r.steps.map(function (s) { return '<li>' + _esc(s) + '</li>'; }).join('') + '</ul>' +
      '<p class="muted">' + (all ? 'You can close this tab.' : 'Close this tab and click the score in the dashboard to score it again.') + '</p>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' + css + '</head><body><div class="c">' + body + '</div>' +
    (r.ok && !all ? '<script>setTimeout(function(){ try { window.close(); } catch (e) {} }, 4000);<' + '/script>' : '') + '</body></html>';
}

function _savePage(r, d) {
  var css = '<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f7f7f8;color:#2f3033;margin:0;padding:24px 16px}' +
    '.c{background:#fff;border:1px solid #e3e6e8;border-radius:10px;padding:24px 26px;max-width:640px;margin:0 auto}h1{font-size:21px;margin:0 0 10px}' +
    'p{margin:6px 0;line-height:1.5}.ok{color:#1b7a43}.bad{color:#c22d2d}.btn{display:inline-block;background:#009fd9;color:#fff;text-decoration:none;padding:9px 16px;border-radius:7px;font-weight:600;margin-top:12px}' +
    'table{border-collapse:collapse;width:100%;font-size:14px;margin-top:8px}td{border-bottom:1px solid #eee;padding:6px 4px}.n{text-align:right;white-space:nowrap}.muted{color:#6b7280;font-size:13px}</style>';
  var rows = function () {
    return '<table>' + r.items.map(function (i) {
      return '<tr><td>' + _esc(i.title) + (i.r ? '' : ' <span class="bad">(not in localization_tracker: skipped)</span>') + '</td><td class="n">' + _esc(i.old === '' || i.old == null ? '—' : i.old) + ' → <b>' + i.x.s + '</b></td></tr>';
    }).join('') + '</table>';
  };
  var body;
  if (!r.ok) body = '<h1 class="bad">Could not save</h1><p>' + _esc(r.message) + '</p>';
  else if (r.preview) body = '<h1>Save ' + (r.items.length - r.unknown) + ' new scores to localization_tracker?</h1>' + rows() +
    '<p class="muted">Changes aiScore, auditedDate (today) and notes. Accuracy and status stay as they are. A copy of each change goes to the translation_audit_log tab.</p>' +
    '<a class="btn" href="' + _esc(ScriptApp.getService().getUrl() + '?save=audit&go=1&d=' + encodeURIComponent(d)) + '" target="_top" onclick="this.textContent=\'Saving…\';this.style.opacity=.6;this.style.pointerEvents=\'none\'">Save</a>';
  else body = '<h1 class="ok">✓ Saved ' + r.saved + '</h1>' + rows() + '<p class="muted">You can close this tab. In the dashboard, click Refresh data to see them.</p>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' + css + '</head><body><div class="c">' + body + '</div></body></html>';
}

// ═══════════════════════════════════════════════════════════════════════════
// Put a Contentful article in the Content Index (2.7.1)
//
// The Help Center Docs are made and kept up to date by HC Auto Sync, from the
// URLs in its "Articles" list. An article that is not on that list never gets
// a Doc. The dashboard's "+ Create Doc" link opens
//   <web app URL>?create=contentful&id=<entryId>
// which says what it will do; "Add it" (&go=1) adds the article's Help Center
// URL to the Auto Sync list. Auto Sync then creates the Doc in its own format
// on its next run (weeknights 2am UTC) and keeps it updated from then on.
// If AUTO_SYNC_URL and AUTO_SYNC_SECRET are set, it also asks Auto Sync to
// create the Doc right away (the same "create" its batch tool uses, which
// never makes a second Doc for the same slug).
//
// Script Properties (optional):
//   AUTO_SYNC_SHEET_ID  the Auto Sync article list (default below)
//   AUTO_SYNC_URL       the Auto Sync web app URL (.../exec)
//   AUTO_SYNC_SECRET    its SHARED_SECRET
// ═══════════════════════════════════════════════════════════════════════════

var AUTO_SYNC_SHEET_DEFAULT = '1_Ei7R5-BgWBiYySa0dxNS-fYq3ppTj9jlbofMKLYVOM';
var AUTO_SYNC_TAB = 'Articles';
// (2.7.0 wrote a different log to 'hc_created'; this one is new so the two never mix)
var HC_CREATED_TAB = 'hc_added';
var HC_ARTICLE_URL = 'https://help.thumbtack.com/article/';

// A field's value in en-US (where this space keeps it), else any locale.
function _cfVal(entry, name) {
  var byLoc = (entry && entry.fields || {})[name];
  if (byLoc == null || typeof byLoc !== 'object' || Array.isArray(byLoc)) return byLoc == null ? undefined : byLoc;
  if ('en-US' in byLoc) return byLoc['en-US'];
  var k = Object.keys(byLoc);
  return k.length ? byLoc[k[0]] : undefined;
}

function _cfStr(entry, name) {
  var v = _cfVal(entry, name);
  return typeof v === 'string' ? v.trim() : '';
}

// Same as Auto Sync's normalizeUrl: no #fragment, no ?query, no trailing slash, lower case.
function _normHcUrl(url) {
  return String(url || '').trim().replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
}

function _cfSetup() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('CONTENTFUL_TOKEN');
  if (!token) throw new Error('Set the Script Property CONTENTFUL_TOKEN first.');
  var space = props.getProperty('CONTENTFUL_SPACE') || CF_DEFAULT_SPACE;
  var env = props.getProperty('CONTENTFUL_ENV') || 'master';
  var base = '/spaces/' + space + '/environments/' + env;
  var wanted = (props.getProperty('CONTENTFUL_ARTICLE_TYPES') || '').split(',').map(function (x) { return x.trim(); }).filter(String);
  var types = wanted.length ? wanted : _cfArticleTypes(_cfAll(base + '/content_types', token));
  var isArticle = {};
  types.forEach(function (t) { isArticle[t] = true; });
  return { token: token, base: base, isArticle: isArticle };
}

function _viewer() {
  try { var u = Session.getActiveUser().getEmail(); if (u) return u.split('@')[0]; } catch (e) {}
  return '';
}

function _logCreated(entryId, url, status, docUrl, by) {
  var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
  var sh = ss.getSheetByName(HC_CREATED_TAB);
  if (!sh) { sh = ss.insertSheet(HC_CREATED_TAB); sh.appendRow(['entryId', 'url', 'status', 'docUrl', 'at', 'by']); }
  sh.appendRow([entryId, url, status, docUrl || '', Utilities.formatDate(new Date(), LOCAL_TZ, 'yyyy-MM-dd HH:mm'), by || '']);
}

// POST to the Auto Sync web app. null when AUTO_SYNC_URL / AUTO_SYNC_SECRET are not set.
function _autoSyncPost(body) {
  var props = PropertiesService.getScriptProperties();
  var app = props.getProperty('AUTO_SYNC_URL'), secret = props.getProperty('AUTO_SYNC_SECRET');
  if (!app || !secret) return null;
  var headers = {};
  try { headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken(); } catch (e) {}
  body.secret = secret;
  var resp = UrlFetchApp.fetch(app, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: headers, payload: JSON.stringify(body) });
  try { return JSON.parse(resp.getContentText()); } catch (e) { return { ok: false, code: 'NOT_JSON', error: 'Auto Sync answered HTTP ' + resp.getResponseCode() + ', not JSON (check AUTO_SYNC_URL)' }; }
}

// Ask Auto Sync to create the Doc now. Returns { ok, docUrl, exists, error }.
function _autoSyncCreate(url, by) {
  var r = _autoSyncPost({ mode: 'create', url: url, reviewer: by ? 'Content Index Dashboard (' + by + ')' : 'Content Index Dashboard' });
  if (!r) return null;
  if (r.code === 'NOT_JSON') return { ok: false, error: r.error };
  if (r.ok) return { ok: true, docUrl: r.docUrl || '' };
  if (r.code === 'ALREADY_EXISTS') return { ok: true, exists: true, docUrl: r.existingDocUrl || '' };
  return { ok: false, error: (r.code ? r.code + ': ' : '') + (r.error || 'unknown error') };
}

// Ask Auto Sync to start a full sync of every article on its list (it runs in
// the background, in batches). Needs the small 'run_manual' addition to the
// Auto Sync doPost (tools/autosync-run-manual.gs). Returns a sentence, or ''.
function _autoSyncRunAll() {
  var r;
  try { r = _autoSyncPost({ action: 'run_manual' }); } catch (e) { return 'The full Auto Sync did not start: ' + (e && e.message || e) + '.'; }
  if (!r) return '';
  if (r.ok) return 'Auto Sync also started a full sync of all articles (a few minutes, in the background).';
  if (/already running/i.test(r.error || '')) return 'A full Auto Sync was already running.';
  if (r.code === 'BAD_REQUEST' || /missing url/i.test(r.error || '')) return 'The full Auto Sync did not start: Auto Sync does not have the "run_manual" addition yet (see the guide, Part 8).';
  return 'The full Auto Sync did not start: ' + (r.error || 'unknown error') + '.';
}

/**
 * The "+ Create Doc" link. Without go: says what it will do. With go: adds
 * the article to the Auto Sync list (once) and, when set up, asks Auto Sync
 * to create the Doc now.
 */
function createDocFromContentful(entryId, go) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(entryId || '')) return { ok: false, message: 'That is not a Contentful entry id.' };
  try {
    var s = _cfSetup();
    var e = _cfGet(s.base + '/entries/' + encodeURIComponent(entryId), s.token);
    var type = e.sys.contentType && e.sys.contentType.sys ? e.sys.contentType.sys.id : '';
    if (!s.isArticle[type]) return { ok: false, message: 'That Contentful entry is not a Help Center article.' };
    var title = _cfStr(e, 'title') || _cfStr(e, 'name') || '(no title)', slug = _cfStr(e, 'slug');
    if (!slug) return { ok: false, title: title, message: 'This article has no slug in Contentful, so it has no Help Center URL yet.' };
    if (!e.sys.publishedVersion) return { ok: false, title: title, message: 'This article is not published in Contentful. Auto Sync only reads published articles: publish it first.' };
    var url = HC_ARTICLE_URL + slug;

    var props = PropertiesService.getScriptProperties();
    var sh = SpreadsheetApp.openById(props.getProperty('AUTO_SYNC_SHEET_ID') || AUTO_SYNC_SHEET_DEFAULT).getSheetByName(AUTO_SYNC_TAB);
    if (!sh) return { ok: false, title: title, message: 'The Auto Sync list has no "' + AUTO_SYNC_TAB + '" tab.' };
    var rows = sh.getDataRange().getValues(), row = null;
    for (var i = 1; i < rows.length; i++) if (_normHcUrl(rows[i][0]) === _normHcUrl(url)) { row = rows[i]; break; }
    var docLink = function (id) { return id ? 'https://docs.google.com/document/d/' + id + '/edit' : ''; };
    var canNow = !!(props.getProperty('AUTO_SYNC_URL') && props.getProperty('AUTO_SYNC_SECRET'));
    var base = { ok: true, title: title, url: url, now: canNow };
    if (row && String(row[3] || '').trim()) return Object.assign(base, { exists: true, docUrl: docLink(String(row[3]).trim()), message: 'Auto Sync already has this article and its Doc.' });
    if (!go) return Object.assign(base, { preview: true, listed: !!row });

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return { ok: false, title: title, message: 'Busy right now. Wait a moment and try again.' };
    try {
      var by = _viewer(), added = false;
      if (!row) {
        var again = sh.getDataRange().getValues().some(function (r, k) { return k > 0 && _normHcUrl(r[0]) === _normHcUrl(url); });
        if (!again) { sh.appendRow([url, '', 'Added by Content Index Dashboard' + (by ? ' (' + by + ')' : '') + ' — waiting for Auto Sync', '', '']); added = true; }
      }
      // Auto Sync takes minutes to create a Doc (it checks every Doc for a
      // duplicate first), so ask it from a background trigger and answer now.
      if (canNow) {
        var pend = JSON.parse(props.getProperty('CI_PENDING') || '[]');
        if (!pend.some(function (x) { return x.url === url; })) pend.push({ entryId: entryId, url: url, by: by });
        props.setProperty('CI_PENDING', JSON.stringify(pend));
        _scheduleAutoSyncPending();
        _logCreated(entryId, url, 'Auto Sync is creating the Doc', '', by);
        return Object.assign(base, { queued: true, added: added, working: true,
          message: (added ? 'Added to the Auto Sync list.' : 'It was already on the Auto Sync list.') +
            ' Auto Sync is creating the Doc now, in the background (about 2 to 6 minutes), and then runs a full sync of all articles.' });
      }
      _logCreated(entryId, url, 'on the Auto Sync list', '', by);
      return Object.assign(base, { queued: true, added: added,
        message: (added ? 'Added to the Auto Sync list.' : 'It was already on the Auto Sync list.') +
          ' Auto Sync creates the Doc on its next run (weeknights, 2am UTC) and keeps it updated after that.' });
    } finally { lock.releaseLock(); }
  } catch (err) {
    return { ok: false, message: String(err && err.message || err) };
  }
}

function _scheduleAutoSyncPending() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoSyncPending') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoSyncPending').timeBased().after(1000).create();
}

/**
 * Background step of "+ Create Doc" (runs from a trigger a second later):
 * asks Auto Sync to create each waiting Doc, logs the result in hc_added,
 * then asks Auto Sync for one full sync.
 */
function autoSyncPending() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 'busy';
  var props = PropertiesService.getScriptProperties();
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'autoSyncPending') ScriptApp.deleteTrigger(t);
    });
    var pend = JSON.parse(props.getProperty('CI_PENDING') || '[]');
    props.deleteProperty('CI_PENDING');
    if (!pend.length) return 'nothing to do';
    pend.forEach(function (x) {
      var made;
      try { made = _autoSyncCreate(x.url, x.by) || { ok: false, error: 'AUTO_SYNC_URL / AUTO_SYNC_SECRET not set' }; }
      catch (e) { made = { ok: false, error: String(e && e.message || e) }; }
      _logCreated(x.entryId, x.url, made.ok ? (made.exists ? 'already had a Doc' : 'Doc created')
        : 'create failed: ' + made.error + ' (Auto Sync makes it on its next run)', made.docUrl || '', x.by);
    });
    var all = _autoSyncRunAll();
    Logger.log(all);
    return pend.length + ' done. ' + all;
  } finally { lock.releaseLock(); }
}

function _createPage(r, entryId) {
  var css = '<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f7f7f8;color:#2f3033;margin:0;padding:24px 16px}' +
    '.c{background:#fff;border:1px solid #e3e6e8;border-radius:10px;padding:24px 26px;max-width:620px;margin:0 auto}h1{font-size:21px;margin:0 0 8px}' +
    'p{margin:6px 0;line-height:1.5}.ok{color:#1b7a43}.bad{color:#c22d2d}.btn{display:inline-block;background:#009fd9;color:#fff;text-decoration:none;' +
    'padding:9px 16px;border-radius:7px;font-weight:600;margin-top:10px}.muted{color:#6b7280;font-size:13px}a{color:#007fad}</style>';
  var head = r.title ? '<p><b>' + _esc(r.title) + '</b>' + (r.url ? '<br><a href="' + _esc(r.url) + '" target="_blank">' + _esc(r.url) + '</a>' : '') + '</p>' : '';
  var open = r.docUrl ? '<a class="btn" href="' + _esc(r.docUrl) + '" target="_blank">Open the Doc</a>' : '';
  var body;
  if (!r.ok) body = '<h1 class="bad">Could not add it</h1>' + head + '<p>' + _esc(r.message) + '</p><p class="muted">Close this tab and try again, or tell Claude what it says.</p>';
  else if (r.created) body = '<h1 class="ok">✓ Doc created</h1>' + head + '<p>' + _esc(r.message) + '</p>' + (r.fullSync ? '<p>' + _esc(r.fullSync) + '</p>' : '') + open;
  else if (r.exists) body = '<h1 class="ok">Already in the Content Index</h1>' + head + '<p>' + _esc(r.message) + '</p>' + (r.fullSync ? '<p>' + _esc(r.fullSync) + '</p>' : '') + open;
  else if (r.queued) body = '<h1 class="ok">✓ On the Auto Sync list</h1>' + head + '<p>' + _esc(r.message) + '</p>' +
    '<p class="muted">You can close this tab. In the dashboard, click Refresh data in a few minutes: the row changes to Open Doc.</p>';
  else {
    body = '<h1>Add this article to the Content Index?</h1>' + head +
      '<p>' + (r.listed ? 'It is already on the Auto Sync list but has no Doc yet.' : 'This adds its Help Center URL to the HC Auto Sync list.') + ' ' +
      (r.now ? 'Then Auto Sync creates the Doc right away and starts a full sync of all articles,' : 'Auto Sync creates the Doc on its next run (weeknights, 2am UTC),') +
      ' in the same format as every other Help Center Doc, and keeps it updated after that.</p>' +
      '<p class="muted">Nothing changes in Contentful. Auto Sync never makes a second Doc for the same article.</p>' +
      '<a class="btn" id="go" href="' + _esc(ScriptApp.getService().getUrl() + '?create=contentful&id=' + encodeURIComponent(entryId) + '&go=1') + '" target="_top"' +
      ' onclick="this.textContent=\'Adding…\';this.style.opacity=.6;this.style.pointerEvents=\'none\'">Add it</a>';
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' + css + '</head><body><div class="c">' + body + '</div></body></html>';
}

/**
 * Outdated KAs (edited in Salesforce after the last sync) grouped by the
 * person who last edited them, as HTML; '' when there are none.
 */
function _outdatedByPerson(rows) {
  var groups = {}, order = [];
  rows.forEach(function (r) {
    if (r.status !== 'OUTDATED' || !r.ka) return;
    var who = r.ka.lastModifiedBy || 'No name';
    if (!groups[who]) { groups[who] = []; order.push(who); }
    groups[who].push(r);
  });
  if (!order.length) return '';
  order.sort(function (a, b) { return groups[b].length - groups[a].length || a.localeCompare(b); });
  return '<ul>' + order.map(function (who) {
    return '<li><b>' + _esc(who) + '</b> (' + groups[who].length + ')<ul>' + groups[who].map(function (r) {
      var link = r.ka.recordId ? SF_LIGHTNING + '/lightning/r/Knowledge__kav/' + r.ka.recordId + '/view' : '';
      return '<li>' + (link ? '<a href="' + link + '">' + _esc(r.ka.title) + '</a>' : _esc(r.ka.title)) +
        ' <span style="color:#666">· edited on ' + _esc(_fmtIso(r.ka.lastModified)) + '</span></li>';
    }).join('') + '</ul></li>';
  }).join('') + '</ul>';
}

/**
 * Run ONCE from the Apps Script editor to start the audit history from zero:
 * empties ka_audit and ka_audit_log (the header rows stay). Emails already
 * sent are not touched.
 */
function resetAuditHistory() {
  var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
  var done = [];
  [AUDIT_TAB, AUDIT_LOG_TAB].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { done.push(name + ': not there'); return; }
    var n = sh.getLastRow() - 1;
    // clear instead of delete: Sheets refuses to delete every non-frozen row
    if (n > 0) sh.getRange(2, 1, n, Math.max(sh.getLastColumn(), 1)).clearContent().setBackground(null);
    done.push(name + ': ' + Math.max(n, 0) + ' rows removed');
  });
  Logger.log(done.join(' | '));
  return done.join(' | ');
}

/** Weekly reminder email (run setupAuditReminderTrigger once). */
function sendAuditReminder() {
  var to = _auditRecipients();
  if (!to.length) return;
  var last = '';
  try {
    var sh = SpreadsheetApp.openById(CORPUS_SHEET_ID).getSheetByName(AUDIT_LOG_TAB);
    if (sh && sh.getLastRow() > 1) last = String(sh.getRange(sh.getLastRow(), 1).getValue());
  } catch (e) {}
  var links = AUDIT_REPORTS.map(function (r) {
    return '<li><a href="' + SF_LIGHTNING + '/lightning/r/Report/' + r.reportId + '/view">' + _esc(r.label) + '</a></li>';
  }).join('');
  MailApp.sendEmail({
    to: to.join(','),
    subject: 'Reminder: weekly KA audit',
    htmlBody:
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2f3033">' +
      '<p>Time for the weekly Content Index audit.</p>' +
      '<ol><li>Open any KA in Salesforce.</li>' +
      '<li>Click the <b>📋 Audit</b> button (bottom right).</li>' +
      '<li>Keep the tab open while it goes through the 3 reports (1–2 min).</li></ol>' +
      '<p>Last audit: ' + _esc(last || 'none yet') + '</p>' +
      '<p>Reports:</p><ul>' + links + '</ul></div>',
  });
}

function setupAuditReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendAuditReminder') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendAuditReminder').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  return 'sendAuditReminder weekly trigger set (Mondays ~9am, script time zone)';
}

// ═══════════════════════════════════════════════════════════════════════════
// ── ARCHIVED RECONCILIATION + TEAM DASHBOARD ────────────────────────────────
// Reconciliation (folders ↔ corpus sheet, no Salesforce auth) writes:
//   ka_published (live), ka_archived (double control), ka_reconcile_flags.
// The dashboard is an HtmlService web app (deploy: Execute as me, Access =
// anyone in the Thumbtack domain) so the whole team can view + archive; the
// archiver's email is captured from their Google login.
// ═══════════════════════════════════════════════════════════════════════════

var CORPUS_SHEET_ID = '16X-I4oT-W96XTwx1qs7ErqTAT6sJI7du3_vnYFp9MIo';
var ARCHIVED_FOLDER_ID = '1j7HzWhwCFGCQyopxzKp7CL7tuyixuguG';
// Published folder = KA_FOLDER_ID (defined at the top of this project).
var KA_INDEX_TAB = 'ka_url_index';

function _parseKaMetaLine(desc) {
  var m = (desc || '').match(/^KA_META:([^|\n]*)\|([^|\n]*)\|?([^\n]*)/);
  return m ? { kaId: (m[1] || '').trim(), url: (m[2] || '').trim(), ts: (m[3] || '').trim() }
           : { kaId: '', url: '', ts: '' };
}
function _parseArchivedStamp(desc) {
  var m = (desc || '').match(/^ARCHIVED:([^\n]*?) by ([^\n]*)$/m);
  return m ? { at: (m[1] || '').trim(), by: (m[2] || '').trim() } : { at: '', by: '' };
}

function _listFolderDocs(folderId) {
  var out = [], pageToken = null;
  do {
    var resp = Drive.Files.list({
      q: "'" + folderId + "' in parents and mimeType='application/vnd.google-apps.document' and trashed=false",
      fields: 'nextPageToken, items(id, title, description, modifiedDate)',
      maxResults: 200, pageToken: pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    var items = resp.items || [];
    for (var i = 0; i < items.length; i++) {
      var d = items[i], meta = _parseKaMetaLine(d.description || ''), arc = _parseArchivedStamp(d.description || '');
      var team = ((d.title || '').match(/ - internal - (.+?) - /) || [])[1] || '';
      out.push({ docId: d.id, title: d.title || '', kaId: meta.kaId, url: meta.url,
                 lastModifiedSF: meta.ts, lastSynced: (d.modifiedDate ? Utilities.formatDate(new Date(d.modifiedDate), 'America/Chicago', 'yyyy-MM-dd HH:mm') : ''), team: team, archivedAt: arc.at, archivedBy: arc.by });
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

function _writeTab(ss, name, header, rows) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  var data = [header].concat(rows);
  sh.getRange(1, 1, data.length, header.length).setValues(data);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  return sh;
}

function reconcileArchived() {
  var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
  var published = _listFolderDocs(KA_FOLDER_ID);
  var archived = _listFolderDocs(ARCHIVED_FOLDER_ID);
  var pubIds = {}; published.forEach(function (d) { pubIds[d.docId] = d; });
  var arcIds = {}; archived.forEach(function (d) { arcIds[d.docId] = d; });

  var idxIds = {};
  var idxSheet = ss.getSheetByName(KA_INDEX_TAB);
  if (idxSheet) {
    var vals = idxSheet.getDataRange().getValues();
    var hdr = vals[0] || [], col = hdr.indexOf('docId');
    if (col === -1) col = 0;
    for (var r = 1; r < vals.length; r++) {
      var id = (vals[r][col] || '').toString().trim();
      if (id) idxIds[id] = true;
    }
  }
  var now = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm');

  _writeTab(ss, 'ka_published',
    ['docId', 'title', 'team', 'salesforceUrl', 'kaId', 'driveDoc', 'indexStatus', 'lastModifiedSF', 'lastSynced', 'reconciledAt'],
    published.map(function (d) {
      return [d.docId, d.title, d.team, d.url, d.kaId,
        'https://docs.google.com/document/d/' + d.docId + '/edit',
        idxIds[d.docId] ? 'active' : 'non-active', d.lastModifiedSF, d.lastSynced, now];
    }));

  _writeTab(ss, 'ka_archived',
    ['docId', 'title', 'team', 'salesforceUrl', 'kaId', 'driveDoc', 'lastModifiedSF', 'lastSynced', 'archivedAt', 'archivedBy', 'reconciledAt'],
    archived.map(function (d) {
      return [d.docId, d.title, d.team, d.url, d.kaId,
        'https://docs.google.com/document/d/' + d.docId + '/edit',
        d.lastModifiedSF, d.lastSynced, d.archivedAt, d.archivedBy, now];
    }));

  var flags = [];
  archived.forEach(function (d) { if (pubIds[d.docId]) flags.push(['IN_BOTH_FOLDERS', d.docId, d.title, d.url]); });
  published.forEach(function (d) { if (!idxIds[d.docId]) flags.push(['PUBLISHED_NOT_IN_INDEX', d.docId, d.title, d.url]); });
  Object.keys(idxIds).forEach(function (id) { if (!pubIds[id] && !arcIds[id]) flags.push(['INDEX_NOT_IN_ANY_FOLDER', id, '', '']); });
  _writeTab(ss, 'ka_reconcile_flags', ['flag', 'docId', 'title', 'salesforceUrl'], flags);

  var summary = 'reconcileArchived @ ' + now + ' | published=' + published.length +
    ' archived=' + archived.length + ' index=' + Object.keys(idxIds).length + ' flags=' + flags.length;
  Logger.log(summary);
  return summary;
}

function setupReconcileTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'reconcileArchived') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('reconcileArchived').timeBased().everyDays(1).atHour(6).create();
  return 'reconcileArchived nightly trigger set (6-7am PT)';
}

// ─── DASHBOARD WEB APP ───────────────────────────────────────────────────

function _readTab(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return [];
  var v = sh.getDataRange().getValues(), h = v[0] || [];
  return v.slice(1).map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o; });
}

function _tabViaGviz(tab) {
  try {
    var url = 'https://docs.google.com/spreadsheets/d/' + CORPUS_SHEET_ID + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(tab);
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var t = resp.getContentText();
    if (resp.getResponseCode() === 200 && t.slice(0, 9) !== '<!DOCTYPE') {
      var rows = Utilities.parseCsv(t), h = rows.shift() || [];
      return rows.map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o; });
    }
  } catch (e) {}
  var ss = SpreadsheetApp.openById(CORPUS_SHEET_ID);
  return _readTab(ss, tab);
}

function getDashboardData() {
  return {
    published: _tabViaGviz('ka_published'),
    archived: _tabViaGviz('ka_archived'),
    user: (Session.getActiveUser().getEmail() || ''),
  };
}

// Move one or more Docs Published → Archived, stamping who/when. Returns fresh data.
function archiveDocs(docIds) {
  var who = Session.getActiveUser().getEmail() || 'unknown';
  var when = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm');
  var moved = 0, errors = [];
  (docIds || []).forEach(function (id) {
    try {
      Drive.Files.update({}, id, null,
        { addParents: ARCHIVED_FOLDER_ID, removeParents: KA_FOLDER_ID, supportsAllDrives: true });
      try {
        var f = DriveApp.getFileById(id);
        f.setDescription((f.getDescription() || '').replace(/\nARCHIVED:[^\n]*/g, '') + '\nARCHIVED:' + when + ' by ' + who);
      } catch (e) {}
      moved++;
    } catch (e) { errors.push(id + ': ' + e.message); }
  });
  try { reconcileArchived(); } catch (e) {}
  var d = getDashboardData();
  d.result = { moved: moved, errors: errors, by: who, at: when };
  return d;
}

function handleArchive(req) {
  var ids = req.docIds || [];
  var by = (req.by || 'unknown').toString();
  var when = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm');
  var moved = 0, errors = [];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    try {
      Drive.Files.update({}, id, null, { addParents: ARCHIVED_FOLDER_ID, removeParents: KA_FOLDER_ID, supportsAllDrives: true });
      try { var f = DriveApp.getFileById(id); f.setDescription((f.getDescription() || '').replace(/\nARCHIVED:[^\n]*/g, '') + '\nARCHIVED:' + when + ' by ' + by); } catch (e) {}
      moved++;
    } catch (e) { errors.push(id + ': ' + e.message); }
  }
  try { reconcileArchived(); } catch (e) {}
  return { ok: true, moved: moved, errors: errors, by: by, at: when };
}

function doGet(e) {
  // <web app URL>?version=1 -> which Code.gs this deployment is running
  if (e && e.parameter && e.parameter.version) {
    return _json({ ok: true, app: 'KA Sync v2', actions: CODE_ACTIONS });
  }
  // <web app URL>?refresh=contentful -> read Contentful now (the dashboard's "Update from Contentful" button)
  if (e && e.parameter && e.parameter.refresh === 'contentful') {
    return HtmlService.createHtmlOutput(_refreshPage(refreshContentfulNow()))
      .setTitle('Update from Contentful').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  // <web app URL>?sync=translation&k=<key> | ?sync=all -> the dashboard's Sync buttons
  if (e && e.parameter && (e.parameter.sync === 'translation' || e.parameter.sync === 'all')) {
    var allSync = e.parameter.sync === 'all';
    return HtmlService.createHtmlOutput(_syncPage(allSync ? syncAllTranslations() : syncTranslation(String(e.parameter.k || '')), allSync))
      .setTitle('Sync').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  // <web app URL>?save=audit&d=<results>[&go=1] -> save the dashboard's new translation scores to localization_tracker
  if (e && e.parameter && e.parameter.save === 'audit') {
    if (!e.parameter.d) return HtmlService.createHtmlOutput(_pastePage()).setTitle('Save translation scores').addMetaTag('viewport', 'width=device-width, initial-scale=1');
    return HtmlService.createHtmlOutput(_savePage(saveAuditResults(String(e.parameter.d || ''), e.parameter.go === '1'), String(e.parameter.d || '')))
      .setTitle('Save translation scores').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  // <web app URL>?create=contentful&id=<entryId>[&go=1] -> copy a Contentful article into the Content Index
  if (e && e.parameter && e.parameter.create === 'contentful') {
    var made = createDocFromContentful(String(e.parameter.id || ''), e.parameter.go === '1');
    return HtmlService.createHtmlOutput(_createPage(made, String(e.parameter.id || '')))
      .setTitle('Create Doc from Contentful').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutput(DASHBOARD_HTML)
    .setTitle('KA Index — Live & Archived')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

var DASHBOARD_HTML = `<!DOCTYPE html><html><head><base target="_top"><meta charset="utf-8">
<style>
  :root{--tt:#009FD9;--ink:#1e2226;--muted:#6b7280;--line:#eef1f4;--bg:#f5f7f9;
    --green-bg:#e7f7ef;--green:#0f7b52;--amber-bg:#fdf3d7;--amber:#946200;--red-bg:#fdecec;--red:#c0392b;}
  *,*::before,*::after{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;background:var(--bg);color:var(--ink);font-size:14px}
  .bar{background:linear-gradient(180deg,#2b2d31,#1c1e21);color:#fff;padding:22px 22px 18px}
  .bar h1{margin:0;font-size:20px;font-weight:750}
  .bar p{margin:8px 0 0;font-size:13px;color:#c3c7cd;max-width:820px;line-height:1.55}
  .bar .who{margin-top:8px;font-size:12px;color:#8fd4ee}
  .wrap{max-width:1200px;margin:0 auto;padding:16px 22px 70px}
  .tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 6px}
  .tab{padding:8px 15px;border-radius:100px;border:1.5px solid var(--line);background:#fff;cursor:pointer;font-weight:650;color:#475569;font-size:13px}
  .tab.on{background:var(--tt);border-color:var(--tt);color:#fff}
  .row2{display:flex;gap:10px;align-items:center;margin:8px 0 12px;flex-wrap:wrap}
  .seg{display:flex;border:1.5px solid var(--line);border-radius:9px;overflow:hidden}
  .seg button{border:none;background:#fff;padding:7px 13px;font-size:12.5px;font-weight:650;color:#475569;cursor:pointer}
  .seg button.on{background:#eef7fc;color:var(--tt)}
  #q{flex:1;min-width:200px;padding:9px 13px;border:1.5px solid var(--line);border-radius:9px;outline:none}
  #q:focus{border-color:var(--tt)}
  .showing{font-size:12px;color:var(--muted)}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
  th{background:#fafbfc;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;position:sticky;top:0}
  tbody tr:hover{background:#fafcfe}
  td.t{font-weight:650;max-width:420px}
  td.t .m{display:block;font-weight:400;font-size:11px;color:#9aa3ad;margin-top:2px}
  .aud{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:5px;background:#eef4f8;color:#4a6a7d;font-size:10px;font-weight:700}
  .badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:100px;font-size:11px;font-weight:700;white-space:nowrap}
  .badge::before{content:"";width:6px;height:6px;border-radius:50%}
  .b-active{background:var(--green-bg);color:var(--green)}.b-active::before{background:var(--green)}
  .b-non{background:var(--amber-bg);color:var(--amber)}.b-non::before{background:var(--amber)}
  .b-arch{background:var(--red-bg);color:var(--red)}.b-arch::before{background:var(--red)}
  .lnk{color:var(--tt);text-decoration:none;font-weight:650;font-size:12px;margin-right:10px;white-space:nowrap}
  .lnk.doc{color:#5b6470}
  .lnk:hover{text-decoration:underline}
  .btn{padding:5px 11px;border-radius:7px;border:1.5px solid #f3c6c2;background:#fdecec;color:var(--red);font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap}
  .btn:hover{background:#fbdedb}
  .selbar{position:sticky;bottom:0;background:#fff;border-top:1px solid var(--line);padding:10px 14px;display:none;align-items:center;gap:12px;box-shadow:0 -2px 8px rgba(0,0,0,.05)}
  .selbar.show{display:flex}
  .selbar .primary{padding:8px 16px;border-radius:8px;border:none;background:var(--red);color:#fff;font-weight:700;cursor:pointer}
  #state{padding:40px;text-align:center;color:var(--muted)}
  .spin{display:inline-block;width:16px;height:16px;border:2.5px solid #d7dee5;border-top-color:var(--tt);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-3px;margin-right:8px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .foot{margin-top:14px;font-size:11.5px;color:#9aa3ad;text-align:center}
  [title]{cursor:help}
</style></head><body>
<div class="bar">
  <h1>KA Index — Live &amp; Archived</h1>
  <p><b>What this is:</b> the live inventory of internal Knowledge Articles mirrored into the Content Index. It feeds the support-content audit tool and the nightly corpus sync — so what's marked live vs archived here is what everything downstream trusts. View by team, and archive a KA (or several) in one click.</p>
  <div class="who" id="who"></div>
</div>
<div class="wrap">
  <div class="tabs" id="teamTabs"></div>
  <div class="row2">
    <div class="seg" id="statusSeg">
      <button data-s="active" class="on" title="Live KAs that are permanent, in the active index">Active</button>
      <button data-s="non" title="Live KAs that are experiments, pilots, ended, sunset or discontinued (excluded from the active index)">Experiments &amp; pilots</button>
      <button data-s="archived" title="KAs moved to the Archived folder (out of the corpus)">Archived</button>
    </div>
    <input id="q" placeholder="Search by title…" autocomplete="off">
    <span class="showing" id="showing"></span>
  </div>
  <div class="card">
    <div id="state"><span class="spin"></span>Loading…</div>
    <table id="tbl" style="display:none">
      <thead><tr>
        <th style="width:28px"><input type="checkbox" id="all" title="Select all shown"></th>
        <th>Title</th><th>Status</th><th title="Last modified in Salesforce">SF modified</th>
        <th title="When it was archived and by whom (captured at archive time)">Archived</th>
        <th>Open</th><th></th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="selbar" id="selbar">
      <span id="selcount">0 selected</span>
      <button class="primary" id="archiveSel" title="Move the selected KAs to the Archived folder">Archive selected</button>
    </div>
  </div>
  <div class="foot" id="foot"></div>
</div>
<script>
  var DATA={published:[],archived:[]}, team='all', status='active', ME='';
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function clean(t){return (t||'').split(' - internal')[0];}
  function auds(t){return (clean(t).match(/\\((Pro|Customer|Rep)\\)/g)||[]).map(function(s){return s.replace(/[()]/g,'');});}
  function badge(k){return k==='active'?'<span class="badge b-active">Active</span>':k==='archived'?'<span class="badge b-arch">Archived</span>':'<span class="badge b-non">Experiment/Pilot</span>';}

  function current(){
    var live = DATA.published.map(function(x){x._kind=(x.indexStatus==='active')?'active':'non';return x;});
    var arc = DATA.archived.map(function(x){x._kind='archived';return x;});
    var base = (status==='archived')?arc:live.filter(function(x){return x._kind===status;});
    if(team!=='all') base = base.filter(function(x){return (x.team||'')===team;});
    var term=(document.getElementById('q').value||'').toLowerCase().trim();
    if(term) base = base.filter(function(x){return clean(x.title).toLowerCase().indexOf(term)>=0;});
    return base.sort(function(a,b){return clean(a.title).toLowerCase().localeCompare(clean(b.title).toLowerCase());});
  }

  function render(){
    var rows=current();
    document.getElementById('rows').innerHTML = rows.map(function(x){
      var title=esc(clean(x.title)).replace(/\\s\\((Pro|Customer|Rep)\\)/g,'');
      var pills=auds(x.title).map(function(a){return '<span class="aud">'+a+'</span>';}).join('');
      var links=(x.salesforceUrl?'<a class="lnk" href="'+esc(x.salesforceUrl)+'" target="_blank">Salesforce</a>':'')+
                (x.driveDoc?'<a class="lnk doc" href="'+esc(x.driveDoc)+'" target="_blank">Doc</a>':'');
      var arch = x._kind==='archived' ? (esc(x.archivedAt||'—')+(x.archivedBy?'<span class="m">by '+esc(x.archivedBy)+'</span>':'')) : '';
      var actionCell = x._kind==='archived' ? '' :
        '<button class="btn" title="Move this KA to the Archived folder" onclick="archiveOne(\\''+x.docId+'\\',this)">Archive</button>';
      var cb = x._kind==='archived' ? '' : '<input type="checkbox" class="sel" value="'+x.docId+'">';
      return '<tr><td>'+cb+'</td><td class="t">'+title+pills+'<span class="m">'+esc((x.team||''))+'</span></td>'+
        '<td>'+badge(x._kind)+'</td><td>'+esc(x.lastModifiedSF||'—')+'</td><td>'+arch+'</td>'+
        '<td>'+links+'</td><td>'+actionCell+'</td></tr>';
    }).join('') || '<tr><td colspan="7" style="color:#9aa3ad;padding:26px">No matches.</td></tr>';
    document.getElementById('showing').textContent=rows.length+' shown';
    wireSel();
  }

  function wireSel(){
    var boxes=[].slice.call(document.querySelectorAll('.sel'));
    function upd(){var n=boxes.filter(function(b){return b.checked;}).length;
      document.getElementById('selcount').textContent=n+' selected';
      document.getElementById('selbar').classList.toggle('show',n>0);}
    boxes.forEach(function(b){b.onchange=upd;});
    var all=document.getElementById('all'); all.checked=false;
    all.onchange=function(){boxes.forEach(function(b){b.checked=all.checked;});upd();};
    upd();
  }
  function selected(){return [].slice.call(document.querySelectorAll('.sel:checked')).map(function(b){return b.value;});}

  function doArchive(ids,label){
    if(!ids.length) return;
    if(!confirm('Archive '+ids.length+' KA'+(ids.length>1?'s':'')+'?\\n\\nThis moves '+(ids.length>1?'them':'it')+' to the Archived folder and out of the corpus. You can move '+(ids.length>1?'them':'it')+' back manually in Drive.')) return;
    document.getElementById('state').style.display='';
    document.getElementById('state').innerHTML='<span class="spin"></span>Archiving '+ids.length+'… (moving + re-reconciling)';
    document.getElementById('tbl').style.display='none';
    google.script.run.withSuccessHandler(function(d){DATA=d;boot2();
      alert('Archived '+d.result.moved+' of '+ids.length+(d.result.errors.length?('\\n'+d.result.errors.length+' error(s):\\n'+d.result.errors.join('\\n')):''));
    }).withFailureHandler(function(e){alert('Archive failed: '+e.message);boot2();}).archiveDocs(ids);
  }
  window.archiveOne=function(id){doArchive([id]);};
  document.getElementById('archiveSel').onclick=function(){doArchive(selected());};

  function boot2(){
    document.getElementById('state').style.display='none';
    document.getElementById('tbl').style.display='';
    var teams=['all'].concat(uniqTeams());
    document.getElementById('teamTabs').innerHTML=teams.map(function(t){
      return '<div class="tab'+(t===team?' on':'')+'" data-t="'+esc(t)+'">'+(t==='all'?'All teams':esc(t))+'</div>';
    }).join('');
    [].slice.call(document.querySelectorAll('.tab')).forEach(function(el){el.onclick=function(){team=el.getAttribute('data-t');document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('on');});el.classList.add('on');render();};});
    document.getElementById('foot').textContent='Source: Corpus Cache sheet · reconciled nightly · you: '+(ME||'—');
    render();
  }
  function uniqTeams(){var s={};DATA.published.concat(DATA.archived).forEach(function(x){if(x.team)s[x.team]=1;});return Object.keys(s).sort();}

  document.getElementById('q').addEventListener('input',render);
  [].slice.call(document.querySelectorAll('#statusSeg button')).forEach(function(b){b.onclick=function(){status=b.getAttribute('data-s');document.querySelectorAll('#statusSeg button').forEach(function(x){x.classList.remove('on');});b.classList.add('on');render();};});

  google.script.run.withSuccessHandler(function(d){DATA=d;ME=d.user||'';
    document.getElementById('who').textContent=ME?('Signed in as '+ME+' — archives are recorded under your name.'):'';
    boot2();
  }).withFailureHandler(function(e){document.getElementById('state').innerHTML='Error: '+e.message;}).getDashboardData();
</script></body></html>`;
