/**
 * KA HTML Snapshot — Google Apps Script web app (v1.0.0)
 *
 * A separate project from KA Sync: it never touches the KA Docs or KA Sync.
 * The Tampermonkey script "KA HTML Snapshot" sends the exact Salesforce HTML of
 * a KA (the rich text boxes as Salesforce stores them: anchors, dropdowns,
 * colors). This web app saves it as one file per KA in the Drive folder
 * "KA HTML - do not edit" and overwrites it on every save (Drive keeps the old
 * versions). The Content Index Dashboard reads these files for the KA Checkup.
 *
 * File name: <Url-Name>.html (lowercase), the last part of the KA's link
 * (https://thumbtack.lightning.force.com/articles/Knowledge/<Url-Name>).
 * File description: KA number, version, title, last modified (and by whom),
 * when it was saved.
 *
 * SETUP (once):
 *   1. Run setup() in the editor. It creates the folder and a secret key, and
 *      logs both (View > Logs). Copy the key.
 *   2. Deploy > New deployment > Web app: Execute as "Me", Who has access
 *      "Anyone". Copy the web app URL.
 *   3. In Salesforce, Tampermonkey menu > KA HTML Snapshot > "Set web app URL
 *      and key": paste the URL, then the key.
 */

var SNAPSHOT_VERSION = '1.0.0';
var FOLDER_NAME = 'KA HTML - do not edit';
var MAX_HTML_CHARS = 9000000;   // Drive's text file limit is 10 MB

function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('SNAPSHOT_SECRET');
  if (!key) { key = Utilities.getUuid().replace(/-/g, ''); props.setProperty('SNAPSHOT_SECRET', key); }
  var folder = _folder();
  Logger.log('KA HTML Snapshot ' + SNAPSHOT_VERSION);
  Logger.log('Folder: ' + folder.getName() + ' → ' + folder.getUrl());
  Logger.log('Secret key (paste it in Tampermonkey): ' + key);
}

function doGet() {
  return _json({ ok: true, app: 'KA HTML Snapshot', version: SNAPSHOT_VERSION });
}

function doPost(e) {
  try {
    var req;
    try { req = JSON.parse(e.postData.contents); } catch (_) { return _json({ ok: false, code: 'BAD_REQUEST', error: 'Invalid JSON body' }); }
    var key = PropertiesService.getScriptProperties().getProperty('SNAPSHOT_SECRET');
    if (!key) return _json({ ok: false, code: 'NO_SECRET', error: 'Run setup() in the editor first.' });
    if (req.secret !== key) return _json({ ok: false, code: 'BAD_SECRET', error: 'The key was not accepted.' });
    if (req.action === 'ping') return _json({ ok: true, version: SNAPSHOT_VERSION, folderUrl: _folder().getUrl() });
    if (req.action === 'save') return _json(_save(req));
    return _json({ ok: false, code: 'BAD_ACTION', error: 'Unknown action: ' + req.action });
  } catch (err) {
    return _json({ ok: false, code: 'INTERNAL', error: String(err && err.message || err) });
  }
}

function _save(req) {
  var urlName = String(req.urlName || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  if (!urlName) return { ok: false, code: 'BAD_REQUEST', error: 'Missing urlName' };
  var html = String(req.html || '');
  if (html.replace(/<[^>]+>/g, '').trim().length < 50) return { ok: false, code: 'EMPTY', error: 'The KA HTML came in empty. Nothing was saved.' };
  if (html.length > MAX_HTML_CHARS) return { ok: false, code: 'TOO_BIG', error: 'The KA HTML is too big (' + html.length + ' characters).' };

  var now = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm');
  var clean = function (s) { return String(s || '').replace(/--/g, '-').replace(/[\r\n|]+/g, ' ').trim(); };
  var info = 'KA ' + clean(req.kaNumber) + ' | v' + clean(req.version) + ' | ' + clean(req.title) +
    ' | modified ' + clean(req.lastModified) + (req.lastModifiedBy ? ' by ' + clean(req.lastModifiedBy) : '') +
    ' | saved ' + now + ' | ' + clean(req.source || 'salesforce');
  var content = '<!-- KA_HTML_SNAPSHOT v1 | ' + info + ' | ' + clean(req.url) + ' -->\n' + html;

  var name = urlName + '.html', folder = _folder(), it = folder.getFilesByName(name), file = null;
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) { if (!file) file = f; else f.setTrashed(true); } }
  var created = false;
  if (file) file.setContent(content);
  else { file = folder.createFile(name, content, MimeType.HTML); created = true; }
  file.setDescription(info.slice(0, 1000));
  return { ok: true, created: created, fileId: file.getId(), name: name, chars: html.length };
}

function _folder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var folder = DriveApp.createFolder(FOLDER_NAME);
  folder.setDescription('The exact Salesforce HTML of every KA, saved by the KA HTML Snapshot script. ' +
    'Do not edit or move these files: the next save overwrites them. Drive keeps the older versions.');
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
