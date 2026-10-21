// RECOVERY ENGINE · Code.gs (the backend). In Apps Script this file must be called Code.
// Paste the whole file, replacing everything in it. Built 2026-10-21 from Code.gs. Do not edit here; settings live in the CFG tab.

/**
 * Recovery Engine | backend (runs inside Google Apps Script, bound to its own Google Sheet)
 *
 * Fully independent: it only reads and writes tabs in its own sheet (or a separate inputs sheet, CFG inputs_sheet_id).
 *   START_HERE    what to paste where (written by setup)
 *   INPUT tabs    RAWItemlevel, STORE_VARIANCE_DAILY (required) + STORE_MASTER, PILOT_COHORT, STORE_HEALTH_RAW,
 *                 EMPLOYEE_CAPACITY_SYNC_RAW, LOCATION_RECOVERY_RAW, AUDIT_EXECUTION_RAW, AUDITOR_DAILY (optional, unlock more)
 *   CFG           settings (edit here or in the app's Settings tab; every change is logged)
 *   USERS         who can do what (email, role SM/CM/PM, outlet_ids, regions)
 *   ACTION_LOG    every view / confirm / replace / actuals / CM decision / settings change / print / error / alert
 *   PLANS, PLAN_TASKS (S = suggested, P = planned), PLAN_ITEMS, ACTUALS, CM_REVIEWS, DAILY   append-only app data
 *   STORE_STATE, PLAN_RESULTS, METRICS_DAILY   rewritten by the hourly refresh job (what the CM / PM screens read)
 *   JOB_RUNS      every refresh run (monitoring)   HEALTH   input check   SOP   the handheld steps printed for captains
 * Printable captain sheets are separate Google Sheets in Drive (one tab per captain), linked from the app and ACTION_LOG.
 */
var RE_TZ = 'Asia/Kolkata';
var RE_SVC_ = null;
/** Lazy: Apps Script loads files top to bottom, so REC (IRD_Core.gs) does not exist yet when this line of Code.gs runs. */
function re_svc() { return RE_SVC_ || (RE_SVC_ = RE_SERVICE_FACTORY(REC)); }
var RE_HTML_FILE = 'App';
var RE_CACHE_SEC = 6 * 3600;
var RE_CELL = 45000;   // a Google Sheets cell holds 50,000 characters

// Input tabs you fill (paste or sync a query result into them). Columns are read by name: any order, extra columns ignored.
// `need` must exist; `cols` are read when present and are the header row setup writes.
var RE_RAW_NEEDED = ['outlet_id', 'item_id', 'item_name', 'variance', 'variance_qty', 'rnk', 'neg_loc_array', 'probable_locations'];
var RE_RAW_OPTIONAL = ['month_start_date', 'outlet_name', 'city', 'raw_synced_at', 'update_date', 'audit_decrement_qty', 'audit_increment_qty',
  'audit_decrement_dates', 'audit_increment_dates', 'l0', 'upc', 'mrp', 'store_total_absolute_variance'];
var RE_INPUTS = {
  RAW: {tab: 'RAWItemlevel', cfgTab: 'tab_raw', need: RE_RAW_NEEDED, cols: RE_RAW_NEEDED.concat(RE_RAW_OPTIONAL), required: true, date: 'raw_synced_at',
    fill: 'Query RAWItemlevel_north.sql: item-level variance, top 200 per store. Refresh daily before 10:00.', unlocks: 'Everything. The app cannot plan without it.'},
  STORE_VARIANCE: {tab: 'STORE_VARIANCE_DAILY', cfgTab: 'tab_store_variance', need: ['outlet_id'], required: true, date: 'date_',
    cols: ['date_', 'outlet_id', 'outlet_name', 'negative_amount', 'positive_amount', 'net_var', 'raw_synced_at'],
    fill: 'Query STORE_VARIANCE_DAILY.sql: daily store variance, last 3 months. Refresh daily.', unlocks: 'Store severity (open / net variance).'},
  MASTER: {tab: 'STORE_MASTER', cfgTab: 'tab_store_master', need: ['outlet_id'], date: '',
    cols: ['outlet_id', 'outlet_name', 'city', 'region', 'cluster', 'cm_sm', 'low_order_window'],
    fill: 'One row per live store (the North list): region, cluster, CM / SM names, low-order window like 14:00-17:00.', unlocks: 'Which stores are live, region / cluster names, CM scoping by region, best recovery window.'},
  COHORT: {tab: 'PILOT_COHORT', cfgTab: 'tab_health', need: ['outlet_id'], date: '',
    cols: ['pair_id', 'region', 'outlet_id', 'outlet_name', 'cohort_role', 'comparison_outlet_id'],
    fill: 'Pilot list: BROKEN / CONTROL pairs (the ready table on the copy page).', unlocks: 'Broken vs control comparison in the control tower.'},
  METRICS: {tab: 'STORE_HEALTH_RAW', cfgTab: 'tab_store_metrics', need: ['outlet_id'], date: 'metric_date',
    cols: ['metric_date', 'data_period_status', 'region', 'outlet_id', 'outlet_name', 'ppi', 'tfr_pct', 'r2a_sec', 'surge_pct'],
    fill: 'Parth\'s STORE_HEALTH_RAW query with the North outlet list. Refresh daily.', unlocks: 'PPI / TFR severity and capacity state.'},
  CAPTAINS: {tab: 'EMPLOYEE_CAPACITY_SYNC_RAW', cfgTab: 'tab_captains', need: ['outlet_id'], date: 'snapshot_date',
    cols: ['snapshot_date', 'outlet_id', 'employee_id', 'employee_name', 'designation', 'auditor_active_hours_l7', 'missing_complaint_pct_l7',
      'wrong_item_complaint_pct_l7', 'recent_presence_status', 'complex_approved', 'captain_id', 'captain_name', 'active', 'iaph', 'qaph', 'bad_audit_pct', 'audits_30d'],
    fill: 'Parth\'s EMPLOYEE_CAPACITY_SYNC_RAW query with the North outlet list. Optional column complex_approved = Y/N. Refresh daily.', unlocks: 'Captain roster for the suggested crew.'},
  LOCATIONS: {tab: 'LOCATION_RECOVERY_RAW', cfgTab: 'tab_locations', need: ['outlet_id'], date: '',
    cols: ['outlet_id', 'location_id', 'aisle_id', 'rack_id', 'correction_days_7d', 'current_ppi', 'current_ideal_ppi', 'current_ppi_signal_status',
      'rack_locations', 'direct_locations', 'signal_locations'],
    fill: 'LOCATION_RACKS_north.sql: one row per rack (Parth\'s location query summed per rack). Refresh daily.', unlocks: 'Real rack sizes and Parth\'s full-rack rule.'},
  AUDITS: {tab: 'AUDIT_EXECUTION_RAW', cfgTab: 'tab_audits', need: ['audit_date_ist', 'outlet_id', 'auditor_id'], date: 'audit_date_ist',
    cols: ['audit_date_ist', 'outlet_id', 'location_id', 'rack_id', 'session_status', 'end_time', 'auditor_id', 'auditor_first_name', 'auditor_last_name', 'distinct_skus',
      'found_qty', 'quality_status', 'session_elapsed_seconds', 'expected_sku_coverage_pct'],
    fill: 'AUDIT_SESSIONS_north.sql: audit sessions of today and yesterday. Refresh HOURLY: it tells the SM who is on the floor now.', unlocks: 'Who is on the floor now, and audit evidence (matched / quality gap / off-plan).'},
  AUDITOR_DAILY: {tab: 'AUDITOR_DAILY', cfgTab: 'tab_auditor_daily', need: ['audit_date_ist', 'outlet_id', 'auditor_id', 'sessions'], date: 'audit_date_ist',
    cols: ['audit_date_ist', 'outlet_id', 'auditor_id', 'auditor_name', 'sessions', 'elapsed_seconds', 'distinct_skus', 'found_qty', 'judged_sessions', 'below_sop_sessions',
      'first_end_time', 'last_end_time'],
    fill: 'AUDITOR_DAILY_north.sql: audits summed per auditor per day, last 8 days. Refresh hourly or daily.', unlocks: 'Captain IAPH / QAPH / bad-audit % (who is best).'}
};
var RE_OWN_H = {
  CFG: ['key', 'value', 'default', 'what_it_does'],
  USERS: ['email', 'role', 'outlet_ids', 'regions', 'name', 'note'],
  SOP: ['level', 'step_no', 'step'],
  HEALTH: ['checked_at', 'input', 'source', 'rows', 'outlets', 'latest_date', 'status', 'note']
};
// DRAFT handheld SOP. Rahul's ground documentation replaces these rows in the SOP tab; the app reads the tab, not this list.
var RE_DEFAULT_SOP = [
  ['LOCATION', 1, 'SM: on HHD create a Location Audit for each listed location and assign it to the captain.'],
  ['LOCATION', 2, 'Captain: go to NEG locations first (where an audit already found it short), then the probable ones.'],
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
/** The app sheet. openById first: getActiveSpreadsheet() can be null when the web app or a trigger runs. */
function re_ss() {
  var id = PropertiesService.getScriptProperties().getProperty('RE_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('RE: run menu > Recovery Engine > 1. Set up once first.');
  return ss;
}
function re_headers(sh) { return sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(re_norm) : []; }
function re_toObj(h, v, row) { var r = {}; h.forEach(function (k, i) { if (k) r[k] = re_plain(v[i]); }); if (row) r._row = row; return r; }
function re_rowsOf(sh, h) {
  var last = sh ? sh.getLastRow() : 0;
  if (last < 2) return [];
  h = h || re_headers(sh);
  return sh.getRange(2, 1, last - 1, h.length).getValues().map(function (v, i) { return re_toObj(h, v, i + 2); });
}
/** Reads only the wanted columns (one batch read per column) so large exports stay fast. */
function re_readCols(sh, need, cols, label, keyCol, fromRow, headers) {
  var h = headers || re_headers(sh), miss = need.filter(function (k) { return h.indexOf(k) < 0; });
  if (miss.length) throw new Error('RE: ' + label + ' is missing column(s): ' + miss.join(', '));
  var start = Math.max(2, fromRow || 2), n = sh.getLastRow() - start + 1;
  if (n < 1) return [];
  var present = cols.filter(function (k) { return h.indexOf(k) >= 0; });
  var data = present.map(function (k) { return sh.getRange(start, h.indexOf(k) + 1, n, 1).getValues(); });
  var out = [];
  for (var i = 0; i < n; i++) {
    var r = {_row: start + i};
    for (var j = 0; j < present.length; j++) r[present[j]] = re_plain(data[j][i][0]);
    if (re_text(r[keyCol || need[0]])) out.push(r);
  }
  return out;
}
/** Row numbers where column `col` equals value exactly (TextFinder runs inside Google, so no full read). */
function re_findRows(sh, h, col, value) {
  var ci = h.indexOf(col);
  if (ci < 0 || sh.getLastRow() < 2 || !re_text(value)) return [];
  return sh.getRange(2, ci + 1, sh.getLastRow() - 1, 1).createTextFinder(String(value)).matchEntireCell(true).findAll().map(function (r) { return r.getRow(); });
}
/** Reads the given rows in contiguous blocks. */
function re_readRows(sh, h, rows) {
  var out = [], i = 0;
  rows = rows.slice().sort(function (a, b) { return a - b; });
  while (i < rows.length) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    var vals = sh.getRange(rows[i], 1, j - i + 1, h.length).getValues();
    for (var k = 0; k < vals.length; k++) out.push(re_toObj(h, vals[k], rows[i] + k));
    i = j + 1;
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
/** A tab the app owns (green header): returned if it exists, created with its header if not. */
function re_ownTab(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0b5d44').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}
/**
 * Setup / upgrade of one tab's header. Tabs you edit (CFG, USERS, SOP, HEALTH) get missing columns added at the end; they are read by name.
 * App tabs are written by position: a shorter matching header is extended; an empty tab with an old header is re-headed;
 * a tab with data under an old header is kept as NAME_old_<date> and a fresh one is created. Never deletes data.
 */
function re_upgradeTab(ss, name, headers, byName) {
  var sh = re_ownTab(ss, name, headers), have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0] : [];
  var style = function (rg) { rg.setFontWeight('bold').setBackground('#0b5d44').setFontColor('#ffffff'); };
  if (JSON.stringify(have) === JSON.stringify(headers)) return sh;
  if (byName) {
    var miss = headers.filter(function (h) { return have.map(re_norm).indexOf(h) < 0; });
    if (miss.length) style(sh.getRange(1, have.length + 1, 1, miss.length).setValues([miss]));
    return sh;
  }
  if (have.length < headers.length && have.every(function (h, i) { return h === headers[i]; })) { style(sh.getRange(1, have.length + 1, 1, headers.length - have.length).setValues([headers.slice(have.length)])); return sh; }
  if (sh.getLastRow() < 2) { sh.getRange(1, 1, 1, Math.max(have.length, headers.length)).clearContent(); style(sh.getRange(1, 1, 1, headers.length).setValues([headers])); return sh; }
  sh.setName(name + '_old_' + Utilities.formatDate(new Date(), RE_TZ, 'yyyyMMdd_HHmm'));
  return re_ownTab(ss, name, headers);
}
/** Values written by the app: text format, and anything that looks like a formula is escaped (no formula injection from names / notes). */
function re_cells(hd, objs) {
  return objs.map(function (o) {
    return hd.map(function (k) {
      var v = o[k] === null || o[k] === undefined ? '' : String(o[k]);
      return /^[=+\-@]/.test(v) && isNaN(Number(v)) ? "'" + v : v;
    });
  });
}
function re_checkHeader(sh, hd, tab) {
  var have = sh.getRange(1, 1, 1, hd.length).getDisplayValues()[0];
  if (JSON.stringify(have) !== JSON.stringify(hd)) throw new Error('RE: header row of ' + tab + ' was changed. Expected: ' + hd.join(', ') + '. Run menu > 1. Set up / repair tabs.');
}

// ------------------------------------------------------------------ repo (one per request; reads memoised per request)
function re_repo(opts) {
  var ss = re_ss(), memo = {}, st = null, inSS, fresh = opts && opts.fresh;
  function settingsRows() { if (!memo.cfg) memo.cfg = re_rowsOf(re_ownTab(ss, 'CFG', RE_OWN_H.CFG)); return memo.cfg; }
  function settings() { if (!st) st = REC.resolveSettings(settingsRows()).settings; return st; }
  function inputsSS() {
    if (inSS !== undefined) return inSS;
    var id = re_text(settings().inputs_sheet_id);
    try { inSS = id ? SpreadsheetApp.openById(id) : null; } catch (e) { throw new Error('RE: cannot open inputs_sheet_id. ' + e.message); }
    return inSS;
  }
  /** Input tab from this sheet (or inputs_sheet_id if set). Cached for 6 h, keyed on the tab's size; the refresh job reads fresh. */
  function input(name) {
    if (memo[name]) return memo[name];
    var spec = RE_INPUTS[name], ext = inputsSS(), book = ext || ss, tab = re_text(settings()[spec.cfgTab]) || spec.tab, sh = book.getSheetByName(tab);
    if (!sh) { if (spec.required) throw new Error('RE: tab "' + tab + '" is missing. Run menu > Recovery Engine > 1. Set up.'); return (memo[name] = []); }
    var key = 'in' + (PropertiesService.getScriptProperties().getProperty('RE_CACHE_V') || '0') + '_' + book.getId().slice(0, 12) + '_' + name + '_' + sh.getLastRow() + '_' + sh.getLastColumn();
    var rows = fresh ? null : re_cacheGet(key);
    if (!rows) { rows = re_readCols(sh, spec.need, spec.cols, tab, 'outlet_id'); if (!fresh) re_cachePut(key, rows); }
    return (memo[name] = rows);
  }
  // App tabs and their header rows are looked up once per request (each lookup is a round trip to Google).
  var tabs = {}, heads = {};
  function hdr(tab) { return re_svc().H[tab] || RE_OWN_H[tab]; }
  function appTab(tab) { return tabs[tab] || (tabs[tab] = re_ownTab(ss, tab, hdr(tab))); }
  // App tabs (re_svc().H) are read with their declared header (setup guarantees it); tabs people edit are read by their own header row.
  function headOf(tab) { return heads[tab] || (heads[tab] = re_svc().H[tab] ? re_svc().H[tab].map(re_norm) : re_headers(appTab(tab))); }
  var repo = {
    me: function () { var e = Session.getActiveUser().getEmail(); if (!e) throw new Error('RE: your Google account could not be verified. Open the app while signed in to your work account.'); return e.toLowerCase(); },
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
    healthRows: function () { return re_rowsOf(re_ownTab(ss, 'HEALTH', RE_OWN_H.HEALTH)); },
    /** App tab rows; cols = only these columns (fast), fromRow = start at this sheet row. Objects carry _row. */
    rows: function (tab, cols, fromRow) {
      var sh = appTab(tab);
      if (cols) return re_readCols(sh, [], cols, tab, cols[0], fromRow, headOf(tab));
      var k = 't_' + tab;
      if (!memo[k]) memo[k] = re_rowsOf(sh, headOf(tab));
      return memo[k];
    },
    rowsWhere: function (tab, col, value, lastN) {
      var sh = appTab(tab), h = headOf(tab), found = re_findRows(sh, h, col, value);
      if (lastN && found.length > lastN) found = found.slice(found.length - lastN);
      return re_readRows(sh, h, found);
    },
    tail: function (tab, n) {
      var sh = appTab(tab), h = headOf(tab), last = sh.getLastRow();
      if (last < 2) return [];
      var start = Math.max(2, last - n + 1);
      return sh.getRange(start, 1, last - start + 1, h.length).getValues().map(function (v, i) { return re_toObj(h, v, start + i); });
    },
    health: function () { return input('COHORT'); },
    storeMetrics: function () { return input('METRICS'); },
    storeVariance: function () { return input('STORE_VARIANCE'); },
    exportSheet: function (title, pages, folderId) { return re_exportSheet(title, pages, folderId); },
    captains: function () { return input('CAPTAINS'); },
    locations: function () { return input('LOCATIONS'); },
    audits: function () { return input('AUDITS'); },
    auditorDaily: function () { return input('AUDITOR_DAILY'); },
    sops: function () { if (!memo.sop) memo.sop = re_rowsOf(re_ownTab(ss, 'SOP', RE_OWN_H.SOP)); return memo.sop; },
    raw: function () { return input('RAW'); },
    /**
     * Stores: STORE_MASTER rows (listed = live). Only when STORE_MASTER is empty (a small pilot) are the stores taken from RAWItemlevel
     * (in_feed), because reading the whole variance feed on every screen is too slow at North scale.
     */
    storeMaster: function () {
      if (memo.master) return memo.master;
      var m = {}, listed = input('MASTER');
      if (!listed.length) input('RAW').forEach(function (r) {
        var id = re_text(r.outlet_id);
        if (id && !m[id]) m[id] = {outlet_name: re_text(r.outlet_name) || id, city: re_text(r.city), cluster: '', region: '', cm_sm: '', in_feed: true};
      });
      listed.forEach(function (r) {
        var id = re_text(r.outlet_id), o = m[id] = m[id] || {outlet_name: id, city: '', cluster: '', region: '', cm_sm: ''};
        o.listed = true;
        ['outlet_name', 'city', 'cluster', 'region', 'cm_sm', 'low_order_window'].forEach(function (k) { if (re_text(r[k])) o[k] = re_text(r[k]); });
      });
      return (memo.master = m);
    },
    append: function (tab, objs) {
      if (!objs.length) return;
      var hd = hdr(tab), sh = appTab(tab);
      if (!heads['ok_' + tab]) { re_checkHeader(sh, hd, tab); heads['ok_' + tab] = true; }
      var vals = re_cells(hd, objs);
      sh.getRange(sh.getLastRow() + 1, 1, vals.length, hd.length).setNumberFormat('@').setValues(vals);
      delete memo['t_' + tab];
    },
    /** Replaces every data row of a tab the refresh job owns (STORE_STATE, PLAN_RESULTS, METRICS_DAILY). */
    writeAll: function (tab, objs) {
      var hd = hdr(tab), sh = appTab(tab);
      if (!heads['ok_' + tab]) { re_checkHeader(sh, hd, tab); heads['ok_' + tab] = true; }
      var old = sh.getLastRow() - 1;
      if (objs.length) sh.getRange(2, 1, objs.length, hd.length).setNumberFormat('@').setValues(re_cells(hd, objs));
      if (old > objs.length) sh.getRange(objs.length + 2, 1, old - objs.length, hd.length).clearContent();
      delete memo['t_' + tab];
    },
    /** gzip + base64 in cells of at most 45,000 characters, each prefixed with "G" so Sheets never reads one as a formula or number. */
    pack: function (obj) {
      var s = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(obj), 'application/json')).getBytes()), out = [];
      for (var i = 0; i < s.length; i += RE_CELL) out.push('G' + s.substr(i, RE_CELL));
      return out;
    },
    unpack: function (parts) {
      var s = parts.map(function (p) { return re_text(p).replace(/^'?G/, ''); }).join('');
      if (!s) return null;
      return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(s), 'application/x-gzip')).getDataAsString());
    },
    once: function (token, seconds) {
      var c = CacheService.getScriptCache(), k = 'tok_' + String(token).slice(0, 200);
      if (c.get(k)) return false;
      c.put(k, '1', Math.min(21600, seconds || 3600));
      return true;
    },
    getProp: function (k) { return PropertiesService.getScriptProperties().getProperty(k); },
    setProp: function (k, v) { PropertiesService.getScriptProperties().setProperty(k, v); },
    lock: function (fn) {
      var l = LockService.getScriptLock();
      if (!l.tryLock(30000)) throw new Error('RE: someone else is saving right now. Try again in a few seconds.');
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
    .addItem('3. Turn on hourly refresh + monitoring', 'RE_INSTALL_TRIGGER')
    .addSeparator()
    .addItem('Refresh all stores now', 'RE_REFRESH')
    .addItem('Send a test alert to me', 'RE_TEST_ALERT')
    .addItem('Archive old log rows now', 'RE_MAINTAIN')
    .addItem('Clear cached inputs', 'RE_CLEAR_CACHE')
    .addToUi();
}
function re_alert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); } return msg; }
function RE_SETUP() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || re_ss();
  PropertiesService.getScriptProperties().setProperty('RE_SHEET_ID', ss.getId());
  Object.keys(RE_OWN_H).forEach(function (t) { re_upgradeTab(ss, t, RE_OWN_H[t], true); });
  Object.keys(re_svc().H).forEach(function (t) { re_upgradeTab(ss, t, re_svc().H[t], false); });
  var cfg = ss.getSheetByName('CFG'), have = {};
  re_rowsOf(cfg).forEach(function (r) { have[re_text(r.key)] = true; });
  var add = REC.SETTINGS.filter(function (s) { return !have[s.key]; }).map(function (s) { return [s.key, '', String(s.def), s.label]; });
  if (add.length) cfg.getRange(cfg.getLastRow() + 1, 1, add.length, 4).setNumberFormat('@').setValues(add);
  // Defaults that changed between versions are refreshed in column C (your values in column B are never touched).
  re_rowsOf(cfg).forEach(function (r) { var s = REC.SETTINGS.filter(function (x) { return x.key === re_text(r.key); })[0]; if (s && re_text(r['default']) !== String(s.def)) cfg.getRange(r._row, 3, 1, 2).setNumberFormat('@').setValues([[String(s.def), s.label]]); });
  cfg.autoResizeColumns(1, 3);
  // Input tabs (blue header) with the exact columns each query should produce, in this sheet or in the inputs sheet.
  var inputsId = re_text(REC.resolveSettings(re_rowsOf(cfg)).settings.inputs_sheet_id), book = inputsId ? SpreadsheetApp.openById(inputsId) : ss;
  Object.keys(RE_INPUTS).forEach(function (k) {
    var spec = RE_INPUTS[k];
    if (book.getSheetByName(spec.tab)) return;
    var sh = book.insertSheet(spec.tab);
    sh.getRange(1, 1, 1, spec.cols.length).setValues([spec.cols]).setFontWeight('bold').setBackground('#1d4ed8').setFontColor('#ffffff');
    sh.getRange(1, 1).setNote('INPUT TAB. Paste / sync here: ' + spec.fill + ' Keep a header row; columns are matched by name.');
    sh.setFrozenRows(1);
  });
  re_startHere(ss);
  var sop = ss.getSheetByName('SOP');
  if (sop.getLastRow() < 2) sop.getRange(2, 1, RE_DEFAULT_SOP.length, 3).setValues(RE_DEFAULT_SOP);
  var users = ss.getSheetByName('USERS'), me = Session.getActiveUser().getEmail();
  if (users.getLastRow() < 2 && me) users.appendRow([me.toLowerCase(), 'PM', '', '', '', 'added by setup']);
  return re_alert_('Recovery Engine is set up. Open the START_HERE tab: it lists which query goes into which blue tab.');
}
/** START_HERE tab: plain-language map of what to fill, written by setup. */
function re_startHere(ss) {
  var sh = ss.getSheetByName('START_HERE') || ss.insertSheet('START_HERE', 0);
  sh.clear();
  var rows = [['RECOVERY ENGINE: START HERE', '', '', ''], ['', '', '', ''],
    ['Step', 'What to do', '', ''],
    ['1', 'Fill the BLUE tabs below with your query results (paste, or point your query tool\'s sheet sync at the tab). Keep the header row.', '', ''],
    ['2', 'Menu: Recovery Engine > 2. Check data health. Every required tab must say OK on the HEALTH tab.', '', ''],
    ['3', 'USERS tab: one row per person. email, role (SM / CM / PM), outlet_ids (SMs: their store; CMs: their stores) or regions (CMs: e.g. UP West).', '', ''],
    ['4', 'Extensions > Apps Script > Deploy > New deployment > Web app (Execute as: Me, Access: anyone in your organisation). Share that link.', '', ''],
    ['5', 'Menu: Recovery Engine > 3. Turn on hourly refresh + monitoring. The CM and PM screens and the alerts depend on it.', '', ''],
    ['', '', '', ''], ['Blue tab', 'Fill with', 'Required?', 'What it unlocks']];
  Object.keys(RE_INPUTS).forEach(function (k) { var s = RE_INPUTS[k]; rows.push([s.tab, s.fill, s.required ? 'REQUIRED' : 'optional', s.unlocks]); });
  rows.push(['', '', '', ''], ['Green tabs', 'Written by the app. Do not edit them by hand (CFG, USERS and SOP you may edit).', '', '']);
  sh.getRange(1, 1, rows.length, 4).setValues(rows).setWrap(true).setVerticalAlignment('top');
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sh.getRange(3, 1, 1, 4).setFontWeight('bold');
  sh.getRange(10, 1, 1, 4).setFontWeight('bold').setBackground('#1d4ed8').setFontColor('#ffffff');
  sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 520); sh.setColumnWidth(3, 100); sh.setColumnWidth(4, 360);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);
}
/** One row per input: rows, outlets, newest date, OK / STALE / EMPTY / ERROR. Also checks how full the spreadsheet is. */
function re_healthCheck(repo) {
  var ss = re_ss(), now = repo.now(), today = repo.today(), out = [];
  var st = REC.resolveSettings(repo.settingsRows()).settings;
  var fns = {RAW: repo.raw, STORE_VARIANCE: repo.storeVariance, MASTER: function () { var m = repo.storeMaster(); return Object.keys(m).filter(function (k) { return m[k].listed; }).map(function (k) { return {outlet_id: k}; }); },
    COHORT: repo.health, METRICS: repo.storeMetrics, CAPTAINS: repo.captains, LOCATIONS: repo.locations, AUDITS: repo.audits, AUDITOR_DAILY: repo.auditorDaily};
  Object.keys(RE_INPUTS).forEach(function (k) {
    var spec = RE_INPUTS[k], tab = re_text(st[spec.cfgTab]) || spec.tab, label = tab + (spec.required ? ' (required)' : ' (optional)');
    try {
      var rows = fns[k](), ids = {}, latest = '';
      rows.forEach(function (r) { if (re_text(r.outlet_id)) ids[re_text(r.outlet_id)] = true; var d = REC.day(r[spec.date]); if (d > latest) latest = d; });
      var age = latest ? Math.round((new Date(today) - new Date(latest)) / 86400000) : null;
      var stale = age !== null && age > (k === 'STORE_VARIANCE' || k === 'METRICS' || k === 'CAPTAINS' ? 2 : 1);   // store health and the roster arrive a day later
      out.push([now, label, spec.fill, rows.length, Object.keys(ids).length, latest, !rows.length ? (spec.required ? 'EMPTY' : 'OFF') : stale ? 'STALE' : 'OK',
        !rows.length ? 'No rows: ' + (spec.required ? 'the app cannot run.' : 'features using this input are off.') : stale ? latest + ' is ' + age + ' days old.' : '']);
    } catch (e) { out.push([now, label, spec.fill, 0, 0, '', 'ERROR', e.message]); }
  });
  var size = function (book, label, hint) {
    var cells = book.getSheets().reduce(function (v, s) { return v + s.getMaxRows() * s.getMaxColumns(); }, 0);
    out.push([now, 'Spreadsheet size', label, cells, '', '', cells > 8000000 ? 'STALE' : 'OK', Math.round(cells / 100000) + '% of the 10 million cell limit' + (cells > 6000000 ? '. ' + hint : '')]);
  };
  size(ss, 'App sheet', 'Move the input tabs to a separate sheet (CFG inputs_sheet_id), or run Archive old log rows now.');
  if (re_text(st.inputs_sheet_id)) { try { size(SpreadsheetApp.openById(st.inputs_sheet_id), 'Inputs sheet', 'Delete empty columns / rows in the input tabs, or shorten the audit window.'); } catch (e) { /* reported by the input rows */ } }
  var sh = re_ownTab(ss, 'HEALTH', RE_OWN_H.HEALTH);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, RE_OWN_H.HEALTH.length).clearContent();
  sh.getRange(2, 1, out.length, RE_OWN_H.HEALTH.length).setValues(out);
  return out;
}
function RE_HEALTH() {
  var out = re_healthCheck(re_repo({fresh: true}));
  try { re_ss().setActiveSheet(re_ss().getSheetByName('HEALTH')); } catch (e) { /* no UI */ }
  return out.map(function (r) { return r[1] + ': ' + r[6]; }).join(' | ');
}
function RE_INSTALL_TRIGGER() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['RE_DAILY', 'RE_REFRESH', 'RE_MAINTAIN', 'IRD_DAILY_SNAPSHOT'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('RE_REFRESH').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('RE_MAINTAIN').timeBased().everyDays(1).atHour(2).inTimezone(RE_TZ).create();
  return re_alert_('Hourly refresh (all stores, results, metrics, monitoring alerts) and a nightly 02:00 archive are on.');
}
function RE_CLEAR_CACHE() {
  var p = PropertiesService.getScriptProperties();
  p.setProperty('RE_CACHE_V', String(Number(p.getProperty('RE_CACHE_V') || 0) + 1));
  return re_alert_('Cached inputs cleared. The next page load reads the input tabs fresh.');
}

// ------------------------------------------------------------------ hourly refresh + monitoring alerts
/** The hourly job. Skips if another run started less than 20 minutes ago; alerts on failure, stale data and error spikes. */
function RE_REFRESH() {
  var p = PropertiesService.getScriptProperties(), started = Number(p.getProperty('RE_REFRESH_RUNNING') || 0);
  if (started && Date.now() - started < 20 * 60000) return 'A refresh is already running.';
  var stuck = started && Date.now() - started >= 20 * 60000;
  p.setProperty('RE_REFRESH_RUNNING', String(Date.now()));
  p.setProperty('RE_CACHE_V', String(Number(p.getProperty('RE_CACHE_V') || 0) + 1));
  var repo = re_repo({fresh: true}), info = null, err = null;
  try { info = re_svc().refresh(repo); }
  catch (e) { err = e; }
  finally { p.deleteProperty('RE_REFRESH_RUNNING'); }
  var health = [];
  try { health = re_healthCheck(repo); } catch (e) { console.warn('health check failed: ' + e.message); }
  try { re_alerts(repo, info, err, health, stuck); } catch (e) { console.warn('alerting failed: ' + e.message); }
  if (err) throw err;
  return info.stores + ' stores refreshed in ' + info.seconds + ' s';
}
/** Monitoring alerts by email (alert_emails, else pm_emails), each kind at most once per window. */
function re_alerts(repo, info, err, health, stuck) {
  var st = REC.resolveSettings(repo.settingsRows()).settings, now = repo.now(), hour = Number(now.slice(11, 13)), today = repo.today(), out = [];
  if (err) out.push(['refresh_failed', 3, 'Refresh failed', 'The hourly refresh failed: ' + (err.message || err) + '\nThe app still shows the last good refresh. Check JOB_RUNS and HEALTH.']);
  if (stuck) out.push(['refresh_stuck', 6, 'A refresh did not finish', 'The previous refresh was still marked running after 20 minutes (likely the 6-minute Apps Script limit). See JOB_RUNS.']);
  health.forEach(function (r) {
    if ((r[6] === 'EMPTY' || r[6] === 'ERROR') && /required/.test(r[1])) out.push(['input_' + re_norm(r[1]), 12, r[1] + ' is ' + r[6], r[1] + ': ' + r[7]]);
    if (r[1] === 'Spreadsheet size' && r[6] !== 'OK') out.push(['sheet_size_' + re_norm(r[2]), 24, r[2] + ' is almost full', r[2] + ': ' + r[7]]);
  });
  var raw = health.filter(function (r) { return /^RAWItemlevel/.test(r[1]); })[0];
  if (raw && raw[5] && raw[5] < today && hour >= st.feed_due_hour) out.push(['feed_stale_' + today, 24, 'Variance feed not refreshed today', 'RAWItemlevel newest date is ' + raw[5] + '. SMs are planning on yesterday\'s variance.']);
  if (hour >= 8 && hour <= 22) {
    try {
      var latest = 0;
      repo.audits().forEach(function (a) { var t = REC.toMs(a.end_time); if (t && t > latest) latest = t; });
      if (latest && Date.now() - latest > st.presence_stale_hours * 3600000) out.push(['presence_stale', 6, 'Audit sessions are stale', 'Newest audit session ended ' + REC.fmt(latest) +
        '. "On the floor now" is out of date. Check the hourly refresh of AUDIT_EXECUTION_RAW.']);
    } catch (e) { /* audits optional */ }
  }
  var errs = repo.tail('ACTION_LOG', 400).filter(function (r) { return re_text(r.action) === 'ERROR' && /^\[system\]/.test(re_text(r.detail)) && REC.toMs(r.at) > Date.now() - 3600000; });
  if (errs.length >= 5) out.push(['errors', 3, errs.length + ' app errors in the last hour', errs.slice(-5).map(function (r) { return r.at + ' ' + r.by + ' ' + r.detail; }).join('\n')]);
  var to = re_text(st.alert_emails) || re_text(st.pm_emails), p = PropertiesService.getScriptProperties(), sent = [];
  if (!to) return [];
  out.forEach(function (a) {
    var k = 'ALERT_' + a[0], last = Number(p.getProperty(k) || 0);
    if (Date.now() - last < a[1] * 3600000) return;
    MailApp.sendEmail({to: to, subject: '[Recovery Engine] ' + a[2], body: a[3] + '\n\nSheet: ' + re_ss().getUrl()});
    p.setProperty(k, String(Date.now()));
    sent.push(a[0]);
  });
  if (sent.length) repo.append('ACTION_LOG', [{at: now, by: 'system', role: 'PM', action: 'ALERT_SENT', outlet_id: '', plan_id: '', detail: sent.join(', ') + ' -> ' + to}]);
  return sent;
}
function RE_TEST_ALERT() {
  var me = Session.getActiveUser().getEmail();
  MailApp.sendEmail({to: me, subject: '[Recovery Engine] Test alert', body: 'Alerts reach you. Sheet: ' + re_ss().getUrl()});
  return re_alert_('Test alert sent to ' + me + '.');
}
/** Nightly: moves old rows of the log tabs to a separate archive spreadsheet so this one stays fast and under the cell limit. */
function RE_MAINTAIN() {
  var ss = re_ss(), repo = re_repo(), st = REC.resolveSettings(repo.settingsRows()).settings, moved = [];
  var limits = {PLAN_TASKS: st.archive_after_rows, PLAN_ITEMS: st.archive_after_rows, ACTION_LOG: st.archive_after_rows, JOB_RUNS: 3000, PLANS: 12000};
  Object.keys(limits).forEach(function (tab) {
    var sh = ss.getSheetByName(tab);
    if (!sh) return;
    var n = sh.getLastRow() - 1, max = limits[tab], keep = Math.round(max * 0.6);
    if (n <= max) return;
    var move = n - keep, cols = sh.getLastColumn(), vals = sh.getRange(2, 1, move, cols).getValues();
    var book = re_archiveBook(), dst = book.getSheetByName(tab) || book.insertSheet(tab);
    if (dst.getLastRow() === 0) dst.getRange(1, 1, 1, cols).setValues(sh.getRange(1, 1, 1, cols).getValues());
    dst.getRange(dst.getLastRow() + 1, 1, vals.length, cols).setNumberFormat('@').setValues(vals);
    sh.deleteRows(2, move);
    moved.push(tab + ' ' + move);
  });
  if (moved.length) repo.append('ACTION_LOG', [{at: repo.now(), by: 'system', role: 'PM', action: 'ARCHIVED', outlet_id: '', plan_id: '', detail: moved.join(', ')}]);
  return moved.length ? 'Archived: ' + moved.join(', ') : 'Nothing to archive.';
}
function re_archiveBook() {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('RE_ARCHIVE_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recreate below */ } }
  var b = SpreadsheetApp.create('Recovery Engine Archive');
  p.setProperty('RE_ARCHIVE_ID', b.getId());
  return b;
}

// ------------------------------------------------------------------ web app (called by the App page)
/** Every call is wrapped: failures are logged to ACTION_LOG ([user] = a message for the person, [system] = a bug or outage). */
function re_api(name, fn) {
  try { return fn(); }
  catch (e) {
    try {
      var msg = String(e && e.message || e), who = '';
      try { who = Session.getActiveUser().getEmail(); } catch (x) { who = '?'; }
      re_repo().append('ACTION_LOG', [{at: Utilities.formatDate(new Date(), RE_TZ, 'yyyy-MM-dd HH:mm:ss'), by: who || '?', role: '', action: 'ERROR', outlet_id: '', plan_id: '',
        detail: (/^RE: /.test(msg) ? '[user] ' : '[system] ') + name + ': ' + msg.slice(0, 400)}]);
    } catch (x) { console.warn('could not log error: ' + x.message); }
    throw e;
  }
}
function RE_DAILY() { return RE_REFRESH(); }
function RE_BOOT() { return re_api('RE_BOOT', function () { return re_svc().boot(re_repo()); }); }
function RE_PING() { return re_svc().ping(re_repo()); }
function RE_STORE(outletId) { return re_api('RE_STORE', function () { return re_svc().store(re_repo(), outletId); }); }
function RE_CONFIRM(req) { return re_api('RE_CONFIRM', function () { return re_svc().confirm(re_repo(), req); }); }
function RE_ACTUALS(req) { return re_api('RE_ACTUALS', function () { return re_svc().actuals(re_repo(), req); }); }
function RE_CM() { return re_api('RE_CM', function () { return re_svc().cm(re_repo()); }); }
function RE_CM_REVIEW(req) { return re_api('RE_CM_REVIEW', function () { return re_svc().cmReview(re_repo(), req); }); }
function RE_TOWER() { return re_api('RE_TOWER', function () { return re_svc().tower(re_repo()); }); }
function RE_MONITOR() {
  return re_api('RE_MONITOR', function () {
    var m = re_svc().monitor(re_repo());
    m.triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    return m;
  });
}
function RE_EXPORT(planId) { return re_api('RE_EXPORT', function () { return re_svc().exportPlan(re_repo(), planId); }); }
function RE_SETTINGS() { return re_api('RE_SETTINGS', function () { return re_svc().settingsView(re_repo()); }); }
function RE_SETTINGS_SAVE(changes) { return re_api('RE_SETTINGS_SAVE', function () { return re_svc().settingsSave(re_repo(), changes); }); }

function doGet(e) {
  var t = HtmlService.createTemplateFromFile(RE_HTML_FILE);
  t.initialStore = e && e.parameter && e.parameter.store ? re_text(e.parameter.store) : '';
  t.coreSrc = RE_CORE_FACTORY.toString();   // static code, no sheet reads: the page shell renders immediately
  return t.evaluate().setTitle('Recovery Engine').addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// ===== END OF Code.gs. If this line is the last line in Apps Script, the paste is complete. =====
