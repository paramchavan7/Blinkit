/**
 * IRD v2 | Recovery Engine | Code.gs (Google Sheets backend + web app entry points)
 *
 * Lives in the "IRD V0.6" sheet's Apps Script project, next to IRD_Core.gs, IRD_Service.gs and IRD_App.html.
 * Everything the app does is visible in this sheet:
 *   CFG         settings (edit here or in the app's Settings tab; every change is logged)
 *   USERS       who can do what (email, role SM/CM/PM, outlet_ids)
 *   ACTION_LOG  every confirm / replace / actuals / CM decision / settings change / daily job
 *   PLANS, PLAN_TASKS (S = suggested, P = planned), PLAN_ITEMS, ACTUALS, CM_REVIEWS, DAILY   append-only data
 *   HEALTH      data check written by the menu "Check data health"
 *   SOP         the handheld steps shown to captains
 *   IN_*        inputs, used only when inputs_sheet_id in CFG is blank
 * Printable captain sheets are separate Google Sheets in Drive (one tab per captain), linked from the app and ACTION_LOG.
 * Reads C (UPW&UK Inventory Recovery App) READ-ONLY for RAWItemlevel + Store_Master. Never writes to C or to the inputs sheet.
 */
var RE_TZ = 'Asia/Kolkata';
var RE_SVC_ = null;
/** Lazy: Apps Script loads files top to bottom, so REC (IRD_Core.gs) does not exist yet when this line of Code.gs runs. */
function re_svc() { return RE_SVC_ || (RE_SVC_ = RE_SERVICE_FACTORY(REC)); }
var RE_HTML_FILE = 'IRD_App';
var RE_CACHE_SEC = 6 * 3600;

// Input tabs. Columns are read by name (any order, extra columns ignored). `need` must exist; `cols` are read when present.
var RE_INPUTS = {
  IN_STORE_HEALTH: {cfgTab: 'tab_health', need: ['outlet_id'],
    cols: ['outlet_id', 'region', 'cohort', 'cohort_role', 'comparison_outlet_id', 'open_variance_3m', 'net_variance_2m', 'low_order_window']},
  IN_STORE_METRICS: {cfgTab: 'tab_store_metrics', need: ['outlet_id'],
    cols: ['outlet_id', 'metric_date', 'data_period_status', 'ppi', 'tfr_pct', 'r2a_sec', 'surge_pct']},
  IN_CAPTAINS: {cfgTab: 'tab_captains', need: ['outlet_id'],
    cols: ['snapshot_date', 'outlet_id', 'employee_id', 'employee_name', 'captain_id', 'captain_name', 'designation', 'active', 'auditor_active_hours_l7',
      'missing_complaint_pct_l7', 'wrong_item_complaint_pct_l7', 'recent_presence_status', 'complex_approved', 'iaph', 'qaph', 'bad_audit_pct', 'audits_30d']},
  IN_LOCATIONS: {cfgTab: 'tab_locations', need: ['outlet_id', 'location_id'],
    cols: ['outlet_id', 'location_id', 'aisle_id', 'rack_id', 'correction_days_7d', 'current_ppi', 'current_ideal_ppi', 'current_ppi_signal_status']},
  IN_AUDITS: {cfgTab: 'tab_audits', need: ['audit_date_ist', 'outlet_id', 'auditor_id', 'session_elapsed_seconds'],
    cols: ['audit_date_ist', 'outlet_id', 'location_id', 'rack_id', 'session_status', 'auditor_id', 'distinct_skus', 'found_qty', 'quality_status',
      'session_elapsed_seconds', 'end_time', 'expected_sku_coverage_pct']}
};
var RE_OWN_H = {
  CFG: ['key', 'value', 'default', 'what_it_does'],
  USERS: ['email', 'role', 'outlet_ids', 'name', 'note'],
  SOP: ['level', 'step_no', 'step'],
  HEALTH: ['checked_at', 'input', 'source', 'rows', 'outlets', 'latest_date', 'status', 'note']
};
var RE_RAW_NEEDED = ['update_date', 'outlet_id', 'item_id', 'item_name', 'variance', 'variance_qty', 'rnk', 'audit_decrement_qty', 'audit_increment_qty',
  'audit_decrement_dates', 'audit_increment_dates', 'neg_loc_array', 'probable_locations'];

// DRAFT handheld SOP. Rahul's ground documentation replaces these rows in the SOP tab; the app reads the tab, not this list.
var RE_DEFAULT_SOP = [
  ['LOCATION', 1, 'SM: on HHD create a Location Audit for each listed location and assign it to the captain.'],
  ['LOCATION', 2, 'Captain: go to NEG locations first (where stock went negative), then the probable ones.'],
  ['LOCATION', 3, 'Count every unit at the location, not only the listed item. Submit the audit on HHD.'],
  ['LOCATION', 4, 'Item found elsewhere? Put it away to its correct location and audit both locations.'],
  ['RACK', 1, 'SM: create Location Audits for every location in the rack and assign them to this captain only.'],
  ['RACK', 2, 'Captain: sweep top shelf to bottom, left to right. Do not skip empty locations.'],
  ['RACK', 3, 'Misplaced stock: put away to its correct location before auditing the next location.'],
  ['RACK', 4, 'Use the item list as a watch-list; these are the items the variance feed says are missing here.'],
  ['AISLE', 1, 'SM: run this in the low-order window. Create Location Audits rack by rack, one captain per rack.'],
  ['AISLE', 2, 'Captain: finish one rack completely before starting the next. Same sweep rule as a rack sweep.'],
  ['AISLE', 3, 'Raise every damaged / expired unit found during the reset before closing the rack.'],
  ['SEARCH', 1, 'Open the item in the Recovery App and check its probable locations.'],
  ['SEARCH', 2, 'Found: audit that location on HHD so the increment shows in the feed.'],
  ['SEARCH', 3, 'Not found: mark Not Found with the reason in the Recovery App. Do not leave it blank.'],
  ['PILFERAGE', 1, 'Daily practice for pilferage-prone locations: SM creates a Location Audit for them every day at shift start.']
];

// ------------------------------------------------------------------ helpers
function re_text(x) { return x === null || x === undefined ? '' : String(x).trim(); }
function re_norm(v) { return String(v || '').toLowerCase().trim().replace(/[^\w]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''); }
function re_plain(v) { if (v instanceof Date) return Utilities.formatDate(v, RE_TZ, 'yyyy-MM-dd HH:mm:ss'); if (typeof v === 'number' && !isFinite(v)) return ''; return v; }
/** The IRD sheet. openById first: getActiveSpreadsheet() can be null when the web app runs. */
function re_ss() {
  var id = PropertiesService.getScriptProperties().getProperty('RE_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('RE: run RE_SETUP once from the editor first.');
  return ss;
}
function re_headers(sh) { return sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(re_norm) : []; }
function re_rowsOf(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  var h = re_headers(sh);
  return sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues().map(function (v) {
    var r = {};
    h.forEach(function (k, i) { if (k) r[k] = re_plain(v[i]); });
    return r;
  });
}
/** Reads only the wanted columns (one batch read per column) so 40-50k row exports stay fast. */
function re_readCols(sh, need, cols, label, keyCol) {
  var h = re_headers(sh), miss = need.filter(function (k) { return h.indexOf(k) < 0; });
  if (miss.length) throw new Error('RE: ' + label + ' is missing column(s): ' + miss.join(', '));
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var present = cols.filter(function (k) { return h.indexOf(k) >= 0; });
  var data = present.map(function (k) { return sh.getRange(2, h.indexOf(k) + 1, n, 1).getValues(); });
  var out = [];
  for (var i = 0; i < n; i++) {
    var r = {};
    for (var j = 0; j < present.length; j++) r[present[j]] = re_plain(data[j][i][0]);
    if (re_text(r[keyCol || need[0]])) out.push(r);
  }
  return out;
}
/** Chunked CacheService (100 KB per key). Cache misses are normal; failures are logged, never hidden. */
function re_cacheGet(key) {
  try {
    var c = CacheService.getScriptCache(), head = c.get(key);
    if (!head) return null;
    var n = Number(head), keys = [];
    for (var i = 0; i < n; i++) keys.push(key + '_' + i);
    var parts = c.getAll(keys), s = '';
    for (var k = 0; k < n; k++) { if (!parts[keys[k]]) return null; s += parts[keys[k]]; }
    return JSON.parse(s);
  } catch (e) { console.warn('cache read failed ' + key + ': ' + e.message); return null; }
}
function re_cachePut(key, obj) {
  try {
    var s = JSON.stringify(obj), size = 90000, map = {}, n = Math.ceil(s.length / size);
    if (n > 200) return;   // too big to be worth caching
    for (var i = 0; i < n; i++) map[key + '_' + i] = s.substr(i * size, size);
    var c = CacheService.getScriptCache();
    c.putAll(map, RE_CACHE_SEC);
    c.put(key, String(n), RE_CACHE_SEC);
  } catch (e) { console.warn('cache write failed ' + key + ': ' + e.message); }
}
function re_ownTab(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0b5d44').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ------------------------------------------------------------------ repo (one per request; reads memoised per request)
function re_repo() {
  var ss = re_ss(), memo = {}, st = null, srcSS = null, inSS;
  function settingsRows() { if (!memo.cfg) memo.cfg = re_rowsOf(re_ownTab(ss, 'CFG', RE_OWN_H.CFG)); return memo.cfg; }
  function settings() { if (!st) st = REC.resolveSettings(settingsRows()).settings; return st; }
  function src() {
    if (srcSS) return srcSS;
    try { srcSS = SpreadsheetApp.openById(settings().source_sheet_id); } catch (e) { throw new Error('RE: cannot open the variance source sheet (C). ' + e.message); }
    return srcSS;
  }
  function inputsSS() {
    if (inSS !== undefined) return inSS;
    var id = re_text(settings().inputs_sheet_id);
    try { inSS = id ? SpreadsheetApp.openById(id) : null; } catch (e) { throw new Error('RE: cannot open inputs_sheet_id. ' + e.message); }
    return inSS;
  }
  /** Input tab from the inputs sheet (if set) or the local IN_ tab. Cached for 6 h, keyed on the tab's size so new data busts it. */
  function input(name) {
    if (memo[name]) return memo[name];
    var spec = RE_INPUTS[name], ext = inputsSS(), book = ext || ss, tab = ext ? settings()[spec.cfgTab] : name, sh = book.getSheetByName(tab);
    if (!sh) { if (ext) throw new Error('RE: tab "' + tab + '" not found in the inputs sheet.'); return (memo[name] = []); }
    var key = 'in' + (PropertiesService.getScriptProperties().getProperty('RE_CACHE_V') || '0') + '_' + book.getId().slice(0, 12) + '_' + name + '_' + sh.getLastRow() + '_' + sh.getLastColumn();
    var rows = re_cacheGet(key);
    if (!rows) { rows = re_readCols(sh, spec.need, spec.cols, tab); re_cachePut(key, rows); }
    return (memo[name] = rows);
  }
  var repo = {
    me: function () { var e = Session.getActiveUser().getEmail(); if (!e) throw new Error('RE: your Google account could not be verified.'); return e.toLowerCase(); },
    today: function () { return Utilities.formatDate(new Date(), RE_TZ, 'yyyy-MM-dd'); },
    now: function () { return Utilities.formatDate(new Date(), RE_TZ, 'yyyy-MM-dd HH:mm:ss'); },
    settingsRows: settingsRows,
    saveSettings: function (changes) {
      var sh = re_ownTab(ss, 'CFG', RE_OWN_H.CFG), rows = re_rowsOf(sh);
      Object.keys(changes).forEach(function (k) {
        var i = rows.map(function (r) { return re_text(r.key); }).indexOf(k);
        if (i >= 0) sh.getRange(i + 2, 2).setNumberFormat('@').setValue(changes[k]);
        else sh.appendRow([k, changes[k], '', '']);
      });
      memo.cfg = null; st = null;
    },
    users: function () { if (!memo.users) memo.users = re_rowsOf(re_ownTab(ss, 'USERS', RE_OWN_H.USERS)); return memo.users; },
    rows: function (tab) { if (!memo['t_' + tab]) memo['t_' + tab] = re_rowsOf(re_ownTab(ss, tab, re_svc().H[tab])); return memo['t_' + tab]; },
    health: function () { return input('IN_STORE_HEALTH'); },
    storeMetrics: function () { return input('IN_STORE_METRICS'); },
    exportSheet: function (title, pages, folderId) { return re_exportSheet(title, pages, folderId); },
    captains: function () { return input('IN_CAPTAINS'); },
    locations: function () { return input('IN_LOCATIONS'); },
    audits: function () { return input('IN_AUDITS'); },
    sops: function () { if (!memo.sop) memo.sop = re_rowsOf(re_ownTab(ss, 'SOP', RE_OWN_H.SOP)); return memo.sop; },
    raw: function () {
      if (memo.raw) return memo.raw;
      var sh = src().getSheetByName('RAWItemlevel');
      if (!sh) throw new Error('RE: RAWItemlevel not found in the source sheet (C).');
      var cols = RE_RAW_NEEDED.concat(['l0', 'upc', 'mrp', 'store_total_absolute_variance']);
      return (memo.raw = re_readCols(sh, RE_RAW_NEEDED, cols, 'RAWItemlevel', 'outlet_id'));
    },
    storeMaster: function () {
      if (memo.master) return memo.master;
      var m = {};
      re_rowsOf(src().getSheetByName('Store_Master')).forEach(function (r) {
        var id = re_text(r.outlet_id);
        if (id) m[id] = {outlet_name: re_text(r.store_name), city: re_text(r.city), cluster: re_text(r.cluster), cm_sm: re_text(r.cms_sms)};
      });
      return (memo.master = m);
    },
    append: function (tab, objs) {
      if (!objs.length) return;
      var hd = re_svc().H[tab], sh = re_ownTab(ss, tab, hd);
      var have = sh.getRange(1, 1, 1, hd.length).getDisplayValues()[0];
      if (JSON.stringify(have) !== JSON.stringify(hd)) throw new Error('RE: header row of ' + tab + ' was changed. Expected: ' + hd.join(', '));
      var vals = objs.map(function (o) {
        return hd.map(function (k) {
          var v = o[k] === null || o[k] === undefined ? '' : String(o[k]);
          return /^[=+\-@]/.test(v) && isNaN(Number(v)) ? "'" + v : v;   // no formula injection from names / notes
        });
      });
      sh.getRange(sh.getLastRow() + 1, 1, vals.length, hd.length).setNumberFormat('@').setValues(vals);
      delete memo['t_' + tab];
    },
    once: function (token) {
      var c = CacheService.getScriptCache(), k = 'tok_' + token;
      if (c.get(k)) return false;
      c.put(k, '1', 3600);
      return true;
    },
    getProp: function (k) { return PropertiesService.getScriptProperties().getProperty(k); },
    setProp: function (k, v) { PropertiesService.getScriptProperties().setProperty(k, v); },
    lock: function (fn) {
      var l = LockService.getScriptLock();
      if (!l.tryLock(20000)) throw new Error('RE: someone else is saving right now. Try again in a few seconds.');
      try { var out = fn(); SpreadsheetApp.flush(); return out; } finally { l.releaseLock(); }
    }
  };
  return repo;
}

// ------------------------------------------------------------------ printable captain sheets
/** Builds a Google Sheet with one A4-portrait tab per captain: header, task table with tick boxes, how-to steps, signatures. */
function re_exportSheet(title, pages, folderId) {
  var book = SpreadsheetApp.create(title), used = {};
  var W = [28, 110, 190, 230, 40, 46, 120];   // column widths (px) that fit A4 portrait
  pages.forEach(function (pg, i) {
    var sh = i === 0 ? book.getSheets()[0] : book.insertSheet();
    var name = String(pg.captain).replace(/[\[\]\*\?\/\\:]/g, ' ').slice(0, 90) || 'Captain ' + (i + 1);
    while (used[name]) name += ' ';
    used[name] = true;
    sh.setName(name);
    var v = [], fmt = [];
    function row(cells, kind) { while (cells.length < 7) cells.push(''); v.push(cells); fmt.push(kind || ''); }
    row(['RECOVERY TASKS · ' + pg.captain.toUpperCase()], 'title');
    row(['', 'Store', pg.store, 'Date: ' + pg.date + (pg.window ? '   Window: ' + pg.window : ''), '', '', 'Plan ' + pg.plan_id], 'meta');
    row(['', 'Your time', pg.hours + ' h', pg.locations + ' locations', '', '', ''], 'meta');
    row([''], '');
    row(['#', 'Task', 'Where', 'Look for (item)', 'Qty', 'Done', 'Found qty / remarks'], 'head');
    pg.rows.forEach(function (r) {
      var items = r.items.length ? r.items : [{name: '', qty: ''}];
      items.forEach(function (it, j) {
        row([j ? '' : r.no, j ? '' : r.task + (r.level === 'SEARCH' ? ': ' + r.target : '') + '\n' + r.hours + ' h', j ? '' : r.where,
          it.name + (it.upc ? '  (UPC ' + it.upc + ')' : ''), it.qty, '☐', ''], j ? 'item' : 'task');
      });
      if (r.more_items) row(['', '', '', '+ ' + r.more_items + ' more items: check every unit at each location', '', '', ''], 'item');
    });
    row([''], '');
    pg.how.forEach(function (h) {
      row(['', 'How: ' + h.label], 'howhead');
      h.steps.forEach(function (st, k) { row(['', (k + 1) + '.', st], 'how'); });
    });
    row([''], '');
    row(['', 'Captain sign', '', 'SM sign', '', '', 'Time done'], 'sign');
    sh.getRange(1, 1, v.length, 7).setValues(v).setVerticalAlignment('top').setWrap(true).setFontSize(10).setFontFamily('Arial');
    W.forEach(function (w, c) { sh.setColumnWidth(c + 1, w); });
    if (sh.getMaxColumns() > 7) sh.deleteColumns(8, sh.getMaxColumns() - 7);
    if (sh.getMaxRows() > v.length) sh.deleteRows(v.length + 1, sh.getMaxRows() - v.length);
    sh.getRange(1, 1, 1, 7).merge().setFontSize(14).setFontWeight('bold');
    fmt.forEach(function (k, r) {
      var rg = sh.getRange(r + 1, 1, 1, 7);
      if (k === 'head') rg.setFontWeight('bold').setBackground('#0b5d44').setFontColor('#ffffff');
      else if (k === 'task') rg.setBorder(true, null, null, null, null, null, '#999999', SpreadsheetApp.BorderStyle.SOLID);
      else if (k === 'meta') sh.getRange(r + 1, 2).setFontWeight('bold');
      else if (k === 'howhead') rg.setFontWeight('bold');
      else if (k === 'how') sh.getRange(r + 1, 3, 1, 5).merge();
      else if (k === 'sign') rg.setFontWeight('bold').setBorder(true, null, null, null, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID);
      if (k === 'task' || k === 'item') { sh.getRange(r + 1, 3).setFontFamily('Roboto Mono').setFontWeight('bold'); sh.getRange(r + 1, 5, 1, 2).setHorizontalAlignment('center'); }
    });
    sh.setHiddenGridlines(true);
  });
  var file = DriveApp.getFileById(book.getId());
  if (re_text(folderId)) {
    try { file.moveTo(DriveApp.getFolderById(folderId)); } catch (e) { console.warn('export_folder_id not usable: ' + e.message); }
  }
  try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (e) { console.warn('Could not share the print sheet with the domain: ' + e.message + '. SMs can still use "Print here" in the app.'); }
  var id = book.getId();
  return {url: book.getUrl(), pdf_url: 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=pdf&size=A4&portrait=true&fitw=true&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED&fzr=false&top_margin=0.4&bottom_margin=0.4&left_margin=0.4&right_margin=0.4'};
}

// ------------------------------------------------------------------ sheet menu + one-time setup
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Recovery Engine')
    .addItem('1. Set up / repair tabs', 'RE_SETUP')
    .addItem('2. Check data health', 'RE_HEALTH')
    .addItem('3. Turn on daily 10:00 job', 'RE_INSTALL_TRIGGER')
    .addSeparator()
    .addItem('Run daily job now', 'RE_DAILY')
    .addItem('Clear cached inputs', 'RE_CLEAR_CACHE')
    .addToUi();
}
function RE_SETUP() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || re_ss();
  PropertiesService.getScriptProperties().setProperty('RE_SHEET_ID', ss.getId());
  Object.keys(RE_OWN_H).forEach(function (t) { re_ownTab(ss, t, RE_OWN_H[t]); });
  Object.keys(re_svc().H).forEach(function (t) { re_ownTab(ss, t, re_svc().H[t]); });
  var cfg = ss.getSheetByName('CFG'), have = {};
  re_rowsOf(cfg).forEach(function (r) { have[re_text(r.key)] = true; });
  var add = REC.SETTINGS.filter(function (s) { return !have[s.key]; }).map(function (s) { return [s.key, '', String(s.def), s.label]; });
  if (add.length) cfg.getRange(cfg.getLastRow() + 1, 1, add.length, 4).setNumberFormat('@').setValues(add);
  cfg.autoResizeColumns(1, 3);
  // Local IN_ tabs only when inputs are not read from another sheet.
  var inputsId = re_text(REC.resolveSettings(re_rowsOf(cfg)).settings.inputs_sheet_id);
  if (!inputsId) Object.keys(RE_INPUTS).forEach(function (t) { re_ownTab(ss, t, RE_INPUTS[t].need); });
  var sop = ss.getSheetByName('SOP');
  if (sop.getLastRow() < 2) sop.getRange(2, 1, RE_DEFAULT_SOP.length, 3).setValues(RE_DEFAULT_SOP);
  var users = ss.getSheetByName('USERS'), me = Session.getActiveUser().getEmail();
  if (users.getLastRow() < 2 && me) users.appendRow([me.toLowerCase(), 'PM', '', '', 'added by setup']);
  // The V0.6 daily trigger points at a function that no longer exists; remove it.
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'IRD_DAILY_SNAPSHOT') ScriptApp.deleteTrigger(t); });
  var msg = 'Recovery Engine ready. ' + add.length + ' settings added to CFG (blank value = default). Next: menu > Check data health.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
  return msg;
}
/** Writes one row per input to HEALTH so anyone can see whether the data behind the app is complete and fresh. */
function RE_HEALTH() {
  var ss = re_ss(), repo = re_repo(), now = repo.now(), out = [];
  function check(label, sourceName, fn, dateKey) {
    try {
      var rows = fn(), ids = {}, latest = '';
      rows.forEach(function (r) { if (re_text(r.outlet_id)) ids[re_text(r.outlet_id)] = true; var d = REC.day(r[dateKey]); if (d > latest) latest = d; });
      var age = latest ? Math.round((new Date(repo.today()) - new Date(latest)) / 86400000) : null;
      out.push([now, label, sourceName, rows.length, Object.keys(ids).length, latest, !rows.length ? 'EMPTY' : age !== null && age > 2 ? 'STALE' : 'OK',
        !rows.length ? 'No rows: features using this input are off.' : age !== null && age > 2 ? latest + ' is ' + age + ' days old.' : '']);
    } catch (e) { out.push([now, label, sourceName, 0, 0, '', 'ERROR', e.message]); }
  }
  var st = REC.resolveSettings(repo.settingsRows()).settings, ext = re_text(st.inputs_sheet_id) ? 'inputs sheet: ' : 'this sheet: ';
  check('Variance (RAWItemlevel)', 'C: RAWItemlevel', repo.raw, 'update_date');
  check('Pilot cohort / store health', ext + (re_text(st.inputs_sheet_id) ? st.tab_health : 'IN_STORE_HEALTH'), repo.health, '');
  check('Store health (PPI / TFR / R2A / surge)', ext + (re_text(st.inputs_sheet_id) ? st.tab_store_metrics : 'IN_STORE_METRICS'), repo.storeMetrics, 'metric_date');
  check('Captains', ext + (re_text(st.inputs_sheet_id) ? st.tab_captains : 'IN_CAPTAINS'), repo.captains, 'snapshot_date');
  check('Locations + PPI evidence', ext + (re_text(st.inputs_sheet_id) ? st.tab_locations : 'IN_LOCATIONS'), repo.locations, '');
  check('Audit sessions', ext + (re_text(st.inputs_sheet_id) ? st.tab_audits : 'IN_AUDITS'), repo.audits, 'audit_date_ist');
  var sh = re_ownTab(ss, 'HEALTH', RE_OWN_H.HEALTH);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, RE_OWN_H.HEALTH.length).clearContent();
  sh.getRange(2, 1, out.length, RE_OWN_H.HEALTH.length).setValues(out);
  ss.setActiveSheet(sh);
  return out.map(function (r) { return r[1] + ': ' + r[6]; }).join(' | ');
}
function RE_INSTALL_TRIGGER() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'RE_DAILY' || t.getHandlerFunction() === 'IRD_DAILY_SNAPSHOT') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('RE_DAILY').timeBased().everyDays(1).atHour(10).inTimezone(RE_TZ).create();
  var msg = 'Daily job scheduled for 10:00 IST (snapshots + region benchmarks).';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
  return msg;
}
function RE_CLEAR_CACHE() {
  var p = PropertiesService.getScriptProperties();
  p.setProperty('RE_CACHE_V', String(Number(p.getProperty('RE_CACHE_V') || 0) + 1));
  var msg = 'Cached inputs cleared. The next page load reads the input tabs fresh.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
  return msg;
}

// ------------------------------------------------------------------ web app (called by IRD_App.html)
function RE_DAILY() { return re_svc().daily(re_repo()); }
function RE_BOOT() { return re_svc().boot(re_repo()); }
function RE_STORE(outletId) { return re_svc().store(re_repo(), outletId); }
function RE_CONFIRM(req) { return re_svc().confirm(re_repo(), req); }
function RE_ACTUALS(req) { return re_svc().actuals(re_repo(), req); }
function RE_CM() { return re_svc().cm(re_repo()); }
function RE_CM_REVIEW(req) { return re_svc().cmReview(re_repo(), req); }
function RE_TOWER() { return re_svc().tower(re_repo()); }
function RE_EXPORT(planId) { return re_svc().exportPlan(re_repo(), planId); }
function RE_SETTINGS() { return re_svc().settingsView(re_repo()); }
function RE_SETTINGS_SAVE(changes) { return re_svc().settingsSave(re_repo(), changes); }

function doGet(e) {
  var t = HtmlService.createTemplateFromFile(RE_HTML_FILE);
  t.initialStore = e && e.parameter && e.parameter.store ? re_text(e.parameter.store) : '';
  t.coreSrc = RE_CORE_FACTORY.toString();   // static code, no sheet reads: the page shell renders immediately
  return t.evaluate().setTitle('Recovery Engine').addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
