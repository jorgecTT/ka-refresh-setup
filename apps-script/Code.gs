/**
 * KA Sync v2 — Google Apps Script backend (v2.3.1)
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
      default:
        return _json({ ok: false, error: 'Unknown action: ' + action, code: 'BAD_ACTION' });
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
  { key: 'MISSING_DOC',         label: 'En Salesforce sin Doc',          color: '#f4c7c3' },
  { key: 'ARCHIVED_BUT_ACTIVE', label: 'Archivado por error',            color: '#f4c7c3' },
  { key: 'DUPLICATE_DOCS',      label: 'Docs duplicados',                color: '#fce8b2' },
  { key: 'OUTDATED',            label: 'Desactualizado',                 color: '#fce8b2' },
  { key: 'WRONG_TEAM',          label: 'Equipo distinto',                color: '#fff2cc' },
  { key: 'EXTRA_DOC',           label: 'Doc de más (no está en reportes)', color: '#fff2cc' },
  { key: 'NO_META',             label: 'Doc sin datos del KA',           color: '#e8eaed' },
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
        team: team, title: info.title || row.title || '', articleNumber: num,
        recordId: row.recordId, lastModified: info.lastModified || '',
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
        var sfMs = ka.lastModified ? Date.parse(ka.lastModified) : 0;
        if (sfMs && doc.modifiedMs && sfMs - doc.modifiedMs > OUTDATED_TOLERANCE_MS) {
          // Same version in the Doc header and in Salesforce = same content.
          var docV = opts.docVersion ? String(opts.docVersion(doc.docId) || '') : '';
          var sfV = info.version != null ? String(info.version) : '';
          if (docV && sfV && docV === sfV) {
            notes.push('Misma versión (v' + sfV + '): en Salesforce solo cambió la fecha');
          } else {
            found.push('OUTDATED');
            notes.push(docV && sfV ? 'Doc en v' + docV + ', Salesforce en v' + sfV
                                   : 'Cambió en Salesforce después del último sync');
          }
        }
        if (doc.team && doc.team !== team) {
          found.push('WRONG_TEAM');
          notes.push('El Doc dice "' + doc.team + '", el reporte dice "' + team + '"');
        }
        if (!info.id) notes.push('No apareció en "Published Articles"');
        found.sort(function (a, b) { return _statusRank(a) - _statusRank(b); });
        status = found.length ? found[0] : 'OK';
      } else {
        var arc = find(arcIx, num, slug);
        if (arc.length) {
          status = 'ARCHIVED_BUT_ACTIVE';
          doc = arc[0];
          notes.push('Está en la carpeta de archivados pero sigue publicado en el reporte');
        } else {
          status = 'MISSING_DOC';
          notes.push('Nadie le dio "New"');
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
      note: st === 'NO_META' ? 'Correr "Update" en su KA para que guarde sus datos' : 'Ya no está en ningún reporte: ¿archivarlo?',
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

function handleAudit(req) {
  var problem = _validateAuditRequest(req);
  if (problem) return { ok: false, code: 'BAD_REQUEST', error: problem };

  var pubDocs = _auditDocs(KA_FOLDER_ID);
  var arcDocs = _auditDocs(ARCHIVED_FOLDER_ID);
  var result = runAudit(req.reports, req.published || [], pubDocs, arcDocs, { docVersion: _docHeaderVersion });

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

function _fmtIso(iso) {
  if (!iso) return '';
  var ms = Date.parse(iso);
  return isNaN(ms) ? String(iso) : Utilities.formatDate(new Date(ms), LOCAL_TZ, 'yyyy-MM-dd HH:mm');
}

function _writeAuditTab(ss, rows, now) {
  var header = ['estado', 'equipo', 'título', 'número KA', 'Salesforce', 'Doc',
                'modificado en Salesforce', 'último cambio del Doc', 'nota', 'auditado'];
  var data = rows.map(function (r) {
    var ka = r.ka || {}, doc = r.doc;
    return [
      // Leading apostrophe keeps "000015509" as text (no lost zeros).
      _statusInfo(r.status).label, ka.team || '', ka.title || '', ka.articleNumber ? "'" + ka.articleNumber : '',
      ka.recordId ? SF_LIGHTNING + '/lightning/r/Knowledge__kav/' + ka.recordId + '/view' : '',
      doc ? 'https://docs.google.com/document/d/' + doc.docId + '/edit' : '',
      _fmtIso(ka.lastModified),
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
    sh.appendRow(['auditado', 'por', 'KAs en reportes', 'Docs publicados'].concat(keys));
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
      (link ? '<a href="' + link + '">' + _esc(r.ka.title) + '</a>' : _esc(r.ka.title)) + '</li>';
  }).join('');
  var html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2f3033">' +
    '<h2 style="margin:0 0 6px">Auditoría del Content Index</h2>' +
    '<p style="margin:0 0 12px;color:#666">' + _esc(now) + ' · corrida por ' + _esc(by) + '</p>' +
    '<p>' + (problems ? '<b>' + problems + '</b> KAs necesitan atención.' : 'Todo está al día. ✅') + '</p>' +
    '<table style="border-collapse:collapse;margin:8px 0 14px">' + lines + '</table>' +
    (top ? '<p style="margin:0 0 4px"><b>Primeros pendientes:</b></p><ul>' + top + '</ul>' : '') +
    '<p><a href="' + sheetUrl + '">Ver la auditoría completa en el sheet</a></p></div>';
  MailApp.sendEmail({
    to: to.join(','),
    subject: 'Auditoría KAs ' + now.slice(0, 10) + (problems ? ' — ' + problems + ' pendientes' : ' — todo al día'),
    htmlBody: html,
  });
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
    subject: 'Recordatorio: auditoría semanal de KAs',
    htmlBody:
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#2f3033">' +
      '<p>Hora de la auditoría semanal del Content Index.</p>' +
      '<ol><li>Abre cualquier KA en Salesforce.</li>' +
      '<li>Dale clic al botón <b>📋 Audit</b> (abajo a la derecha).</li>' +
      '<li>Deja la pestaña abierta mientras pasa por los 3 reportes (1–2 min).</li></ol>' +
      '<p>Última auditoría: ' + _esc(last || 'ninguna todavía') + '</p>' +
      '<p>Reportes:</p><ul>' + links + '</ul></div>',
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

function doGet() {
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
