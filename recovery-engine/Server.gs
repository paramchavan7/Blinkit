/**
 * Recovery Engine v2 | Server (Google Sheets repo + web app entry points)
 * Bound to its own sheet. Reads C (UPW&UK Inventory Recovery App) READ-ONLY: RAWItemlevel, Store_Master.
 * Writes only its own tabs. Plans, tasks, items, actuals, reviews and snapshots are append-only.
 */
var RE_TZ = 'Asia/Kolkata';
var RE_SVC = RE_SERVICE_FACTORY(REC);

// Input tabs: paste the exports as they are. Only the listed columns are required (any order, extra columns ignored).
var RE_INPUT_H = {
  CFG: ['key', 'value', 'default', 'what_it_does'],
  IN_STORE_HEALTH: ['outlet_id', 'region', 'cohort_role', 'comparison_outlet_id', 'open_variance_3m', 'net_variance_2m', 'low_order_window'],
  IN_CAPTAINS: ['snapshot_date', 'outlet_id', 'employee_id', 'employee_name', 'designation', 'auditor_active_hours_l7', 'missing_complaint_pct_l7',
    'wrong_item_complaint_pct_l7', 'recent_presence_status', 'complex_approved'],
  IN_LOCATIONS: ['outlet_id', 'location_id', 'aisle_id', 'rack_id', 'correction_days_7d', 'current_ppi_broken_flag'],
  IN_AUDITS: ['audit_date_ist', 'outlet_id', 'location_id', 'rack_id', 'session_status', 'auditor_id', 'distinct_skus', 'found_qty', 'quality_status', 'session_elapsed_seconds'],
  SOP: ['level', 'step_no', 'step']
};
var RE_REQUIRED = {CFG: ['key', 'value'], IN_STORE_HEALTH: ['outlet_id'], IN_CAPTAINS: ['outlet_id', 'employee_name'],
  IN_LOCATIONS: ['outlet_id', 'location_id'], IN_AUDITS: ['audit_date_ist', 'outlet_id', 'auditor_id', 'session_elapsed_seconds'], SOP: ['level', 'step_no', 'step']};
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

function re_text(x) { return x === null || x === undefined ? '' : String(x).trim(); }
function re_norm(v) { return String(v || '').toLowerCase().trim().replace(/[^\w]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''); }
function re_plain(v) { if (v instanceof Date) return Utilities.formatDate(v, RE_TZ, 'yyyy-MM-dd HH:mm:ss'); if (typeof v === 'number' && !isFinite(v)) return ''; return v; }
function re_ss() { return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('RE_SHEET_ID')); }

function re_rowsOf(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(re_norm);
  return sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues().map(function (v) {
    var r = {};
    h.forEach(function (k, i) { if (k) r[k] = re_plain(v[i]); });
    return r;
  });
}
function re_tab(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0b5d44').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  if (RE_REQUIRED[name]) {
    var got = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getDisplayValues()[0].map(re_norm);
    var miss = RE_REQUIRED[name].filter(function (k) { return got.indexOf(k) < 0; });
    if (miss.length) throw new Error('RE: ' + name + ' is missing column(s): ' + miss.join(', '));
    return sh;
  }
  var have = sh.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  if (JSON.stringify(have) !== JSON.stringify(headers)) throw new Error('RE: ' + name + ' header changed. Expected: ' + headers.join(', '));
  return sh;
}

/** One repo per request; tab reads are memoised for the request. */
function re_repo() {
  var ss = re_ss(), cache = {}, st = null, srcSS = null;
  function headersFor(tab) { return RE_SVC.H[tab] || RE_INPUT_H[tab]; }
  function rows(tab) { if (!cache[tab]) cache[tab] = re_rowsOf(re_tab(ss, tab, headersFor(tab))); return cache[tab]; }
  function settingsRows() { return rows('CFG'); }
  function settings() { if (!st) st = REC.resolveSettings(settingsRows()).settings; return st; }
  function src() {
    if (srcSS) return srcSS;
    try { srcSS = SpreadsheetApp.openById(settings().source_sheet_id); } catch (e) { throw new Error('RE: cannot open the variance source sheet (C). ' + e.message); }
    return srcSS;
  }
  var repo = {
    me: function () { var e = Session.getActiveUser().getEmail(); if (!e) throw new Error('RE: your Google account could not be verified.'); return e.toLowerCase(); },
    today: function () { return Utilities.formatDate(new Date(), RE_TZ, 'yyyy-MM-dd'); },
    now: function () { return Utilities.formatDate(new Date(), RE_TZ, 'yyyy-MM-dd HH:mm:ss'); },
    settingsRows: settingsRows,
    rows: rows,
    health: function () { return rows('IN_STORE_HEALTH'); },
    captains: function () { return rows('IN_CAPTAINS'); },
    locations: function () { return rows('IN_LOCATIONS'); },
    audits: function () { return rows('IN_AUDITS'); },
    sops: function () { return rows('SOP'); },
    raw: function () {
      if (cache.raw) return cache.raw;
      var sh = src().getSheetByName('RAWItemlevel');
      if (!sh) throw new Error('RE: RAWItemlevel not found in the source sheet.');
      var v = sh.getDataRange().getValues(), h = v[0].map(re_norm), out = [];
      RE_RAW_NEEDED.forEach(function (k) { if (h.indexOf(k) < 0) throw new Error('RE: RAWItemlevel is missing column ' + k); });
      for (var i = 1; i < v.length; i++) {
        var r = {};
        h.forEach(function (k, j) { if (k) r[k] = re_plain(v[i][j]); });
        if (re_text(r.outlet_id)) out.push(r);
      }
      return (cache.raw = out);
    },
    storeMaster: function () {
      if (cache.master) return cache.master;
      var m = {}, sh = src().getSheetByName('Store_Master');
      re_rowsOf(sh).forEach(function (r) {
        var id = re_text(r.outlet_id);
        if (id) m[id] = {outlet_name: re_text(r.store_name), city: re_text(r.city), cluster: re_text(r.cluster), cm_sm: re_text(r.cms_sms)};
      });
      return (cache.master = m);
    },
    append: function (tab, objs) {
      if (!objs.length) return;
      var hd = headersFor(tab), sh = re_tab(ss, tab, hd);
      var vals = objs.map(function (o) {
        return hd.map(function (k) {
          var v = o[k] === null || o[k] === undefined ? '' : String(o[k]);
          return /^[=+\-@]/.test(v) && isNaN(Number(v)) ? "'" + v : v;   // no formula injection from names / notes
        });
      });
      sh.getRange(sh.getLastRow() + 1, 1, vals.length, hd.length).setNumberFormat('@').setValues(vals);
      delete cache[tab];
    },
    getProp: function (k) { return PropertiesService.getScriptProperties().getProperty(k); },
    setProp: function (k, v) { PropertiesService.getScriptProperties().setProperty(k, v); },
    lock: function (fn) { var l = LockService.getDocumentLock(); l.waitLock(30000); try { return fn(); } finally { SpreadsheetApp.flush(); l.releaseLock(); } }
  };
  return repo;
}

// ------------------------------------------------------------------ setup (run once from the editor)
function RE_SETUP() {
  var ss = re_ss();
  PropertiesService.getScriptProperties().setProperty('RE_SHEET_ID', ss.getId());
  Object.keys(RE_INPUT_H).forEach(function (t) { re_tab(ss, t, RE_INPUT_H[t]); });
  Object.keys(RE_SVC.H).forEach(function (t) { re_tab(ss, t, RE_SVC.H[t]); });
  var cfg = ss.getSheetByName('CFG'), have = {};
  re_rowsOf(cfg).forEach(function (r) { have[re_text(r.key)] = true; });
  var add = REC.SETTINGS.filter(function (s) { return !have[s.key]; }).map(function (s) { return [s.key, '', String(s.def), s.label]; });
  if (add.length) cfg.getRange(cfg.getLastRow() + 1, 1, add.length, 4).setNumberFormat('@').setValues(add);
  var sop = ss.getSheetByName('SOP');
  if (sop.getLastRow() < 2) sop.getRange(2, 1, RE_DEFAULT_SOP.length, 3).setValues(RE_DEFAULT_SOP);
  re_repo().raw();
  return 'Recovery Engine ready. ' + add.length + ' settings added (blank value = default). Source sheet readable.';
}
function RE_INSTALL_TRIGGER() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'RE_DAILY') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('RE_DAILY').timeBased().everyDays(1).atHour(10).inTimezone(RE_TZ).create();
  return 'Daily snapshot scheduled for 10:00 IST.';
}

// ------------------------------------------------------------------ web app
function RE_DAILY() { return RE_SVC.daily(re_repo()); }
function RE_BOOT() { return RE_SVC.boot(re_repo()); }
function RE_STORE(outletId) { return RE_SVC.store(re_repo(), outletId); }
function RE_CONFIRM(req) { return RE_SVC.confirm(re_repo(), req); }
function RE_ACTUALS(req) { return RE_SVC.actuals(re_repo(), req); }
function RE_CM() { return RE_SVC.cm(re_repo()); }
function RE_CM_REVIEW(req) { return RE_SVC.cmReview(re_repo(), req); }
function RE_TOWER() { return RE_SVC.tower(re_repo()); }

function doGet(e) {
  var t = HtmlService.createTemplateFromFile('App');
  t.initialStore = e && e.parameter && e.parameter.store ? re_text(e.parameter.store) : '';
  t.coreSrc = RE_CORE_FACTORY.toString();
  return t.evaluate().setTitle('Recovery Engine').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
