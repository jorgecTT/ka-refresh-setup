// ── Addition for HC Auto Sync (AutoSync.gs) — lets the Content Index Dashboard
// start a full sync after it adds an article. Two pastes:
//
// 1) In doPost, right ABOVE the line   if (req.action === 'save_history') {
//    paste:
//
//    if (req.action === 'run_manual') {
//      return _jsonResponse(startManualSyncSoon());
//    }
//
// 2) At the very end of the file, paste the function below.
//
// Then Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.

/**
 * Same as the "Run manual sync now" button, but starts the first batch on a
 * trigger a second later instead of inline, so the caller gets an answer
 * right away. Refuses while a run is in progress (same rule as runManualSync).
 */
function startManualSyncSoon() {
  var props = PropertiesService.getScriptProperties();
  var phase = props.getProperty('AS_PHASE') || 'idle';
  if (phase === 'starting' || phase === 'running') {
    var startMs = parseInt(props.getProperty('AS_RUN_START_MS') || '0', 10);
    var ageMin  = startMs ? (Date.now() - startMs) / 60000 : 999;
    if (ageMin < 30) return { ok: false, error: 'A sync is already running. Wait for it to finish.' };
    Logger.log('Stale run state detected (' + Math.round(ageMin) + ' min old). Auto-resetting.');
  }
  _deleteBatchTrigger(props);
  _ensureTickTrigger();
  _initRunState(props, 'manual');
  _scheduleNextBatch(props);
  return { ok: true, message: 'Manual sync started.' };
}
