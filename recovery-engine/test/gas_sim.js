/**
 * A small Google Apps Script simulator: enough of SpreadsheetApp, Utilities, PropertiesService, CacheService, LockService,
 * Session, ScriptApp, MailApp, DriveApp and HtmlService to run the deploy/ files exactly as pasted into Apps Script.
 * It mimics the quirks that bite in production: typed values in pasted tabs (numbers, dates), text format '@' keeping strings,
 * 50,000-character cells, TextFinder, the clock in IST. It also counts API calls and cells moved, to estimate Apps Script time.
 */
const vm = require('vm'), fs = require('fs'), zlib = require('zlib');

function makeGas(opts) {
  opts = opts || {};
  const stats = {calls: 0, cells: 0, byKind: {}};
  const hit = (k, cells) => { stats.calls++; stats.cells += cells || 0; stats.byKind[k] = (stats.byKind[k] || 0) + 1; };
  const IST = 330 * 60000;
  const clock = {ms: opts.now ? Date.parse(opts.now) : Date.now()};
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock.ms); else super(...a); }
    static now() { return clock.ms; }
  }
  const pad = n => String(n).padStart(2, '0');
  function fmtIST(d, pattern) {
    const t = new RealDate(d.getTime() + IST);
    const map = {yyyy: t.getUTCFullYear(), MM: pad(t.getUTCMonth() + 1), dd: pad(t.getUTCDate()), HH: pad(t.getUTCHours()), mm: pad(t.getUTCMinutes()), ss: pad(t.getUTCSeconds())};
    return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, k => map[k]);
  }
  // Values typed into a General-format cell are parsed like Sheets does: numbers and ISO dates / date-times.
  function parseTyped(v) {
    if (typeof v !== 'string') return v;
    if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
    if (m) return new FakeDate(RealDate.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - IST);
    return v;
  }
  const display = v => v instanceof RealDate ? fmtIST(v, 'yyyy-MM-dd') : v === null || v === undefined ? '' : String(v);

  let idSeq = 1;
  const books = {};
  class Range {
    constructor(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr || 1; this.nc = nc || 1; }
    _cells(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); }
    getRow() { return this.r; }
    getValues() {
      hit('getValues', this.nr * this.nc);
      const out = [];
      for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const cell = this.sh._get(this.r + i, this.c + j); row.push(cell ? cell.v : ''); } out.push(row); }
      return out;
    }
    getDisplayValues() { hit('getDisplayValues', this.nr * this.nc); return this.getValuesRaw().map(r => r.map(display)); }
    getValuesRaw() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const c = this.sh._get(this.r + i, this.c + j); row.push(c ? c.v : ''); } out.push(row); } return out; }
    setValues(vals) {
      hit('setValues', this.nr * this.nc);
      if (vals.length !== this.nr || vals.some(r => r.length !== this.nc)) throw new Error('The number of rows or columns in the data does not match the range (' + vals.length + 'x' + (vals[0] || []).length + ' vs ' + this.nr + 'x' + this.nc + ')');
      this._cells((r, c, i, j) => {
        let v = vals[i][j];
        if (typeof v === 'string' && v.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
        const cell = this.sh._cell(r, c);
        if (cell.fmt === '@') cell.v = v instanceof RealDate ? v : v === null || v === undefined ? '' : (typeof v === 'number' ? String(v) : String(v).replace(/^'/, ''));
        else cell.v = typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : parseTyped(v);
      });
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    setNumberFormat(f) { hit('format', 0); this._cells((r, c) => { this.sh._cell(r, c).fmt = f; }); return this; }
    clearContent() { hit('clear', this.nr * this.nc); this._cells((r, c) => { const cell = this.sh._get(r, c); if (cell) cell.v = ''; }); return this; }
    createTextFinder(text) {
      const self = this;
      let whole = false;
      return {matchEntireCell(b) { whole = b; return this; }, matchCase() { return this; },
        findAll() {
          hit('textFinder', 0);
          const t = String(text).toLowerCase(), out = [];
          for (let i = 0; i < self.nr; i++) for (let j = 0; j < self.nc; j++) {
            const c = self.sh._get(self.r + i, self.c + j), d = c ? display(c.v).toLowerCase() : '';
            if (whole ? d === t : d.indexOf(t) >= 0 && t) out.push(new Range(self.sh, self.r + i, self.c + j));
          }
          return out;
        }};
    }
  }
  ['setFontWeight', 'setBackground', 'setFontColor', 'setNote', 'setVerticalAlignment', 'setWrap', 'setFontSize', 'setFontFamily', 'merge', 'setBorder', 'setHorizontalAlignment']
    .forEach(k => { Range.prototype[k] = function () { hit('style', 0); return this; }; });

  class Sheet {
    constructor(book, name) { this.book = book; this.name = name; this.rows = []; this.maxR = 1000; this.maxC = 26; }
    _get(r, c) { const row = this.rows[r - 1]; return row ? row[c - 1] : undefined; }
    _cell(r, c) { const row = this.rows[r - 1] = this.rows[r - 1] || []; if (r > this.maxR) this.maxR = r; if (c > this.maxC) this.maxC = c; return row[c - 1] = row[c - 1] || {v: '', fmt: ''}; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getLastRow() { hit('meta', 0); for (let r = this.rows.length; r >= 1; r--) { const row = this.rows[r - 1]; if (row && row.some(c => c && c.v !== '' && c.v !== null && c.v !== undefined)) return r; } return 0; }
    getLastColumn() { hit('meta', 0); let m = 0; this.rows.forEach(row => { if (row) for (let c = row.length; c >= 1; c--) { const cell = row[c - 1]; if (cell && cell.v !== '') { m = Math.max(m, c); break; } } }); return m; }
    getMaxRows() { return this.maxR; }
    getMaxColumns() { return this.maxC; }
    getRange(r, c, nr, nc) {
      if (typeof r === 'string') throw new Error('A1 notation not supported in the simulator');
      if (r < 1 || c < 1 || (nr !== undefined && nr < 1) || (nc !== undefined && nc < 1)) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      return new Range(this, r, c, nr, nc);
    }
    setFrozenRows() { return this; }
    setColumnWidth() { return this; }
    setHiddenGridlines() { return this; }
    autoResizeColumns() { return this; }
    deleteColumns(c, n) { this.rows.forEach(row => { if (row) row.splice(c - 1, n); }); this.maxC -= n; return this; }
    deleteRows(r, n) { hit('deleteRows', 0); this.rows.splice(r - 1, n); this.maxR = Math.max(1, this.maxR - n); return this; }
    clear() { this.rows = []; return this; }
    clearContents() { this.rows.forEach(row => { if (row) row.forEach(c => { if (c) c.v = ''; }); }); return this; }
    insertRowsAfter(r, n) { this.maxR += n; return this; }
    insertColumnsAfter(c, n) { this.maxC += n; return this; }
    appendRow(vals) { hit('appendRow', vals.length); const r = this.getLastRow() + 1; this.getRange(r, 1, 1, vals.length).setValues([vals]); return this; }
  }
  class Book {
    constructor(name) { this.id = 'sim' + (idSeq++) + 'x'.repeat(12); this.name = name; this.sheets = [new Sheet(this, 'Sheet1')]; books[this.id] = this; }
    getId() { return this.id; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
    getName() { return this.name; }
    getSheetByName(n) { hit('meta', 0); return this.sheets.find(s => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    insertSheet(n, idx) {
      if (n && this.getSheetByName(n)) throw new Error('A sheet with the name "' + n + '" already exists.');
      const s = new Sheet(this, n || 'Sheet' + (this.sheets.length + 1));
      if (idx === undefined) this.sheets.push(s); else this.sheets.splice(idx, 0, s);
      return s;
    }
    setActiveSheet(s) { this.active = s; return s; }
    moveActiveSheet() { return this; }
  }
  const active = new Book('Recovery Engine');
  const props = {}, cache = {}, mails = [], triggers = [], logs = [];
  let user = opts.user || 'param.chavan@grofers.com', uiAvailable = false;
  const toBytes = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
  const fromBytes = arr => Buffer.from(arr.map(b => (b < 0 ? b + 256 : b)));
  class Blob {
    constructor(buf, type) { this.buf = buf; this.type = type; }
    getBytes() { return toBytes(this.buf); }
    getDataAsString() { return this.buf.toString('utf8'); }
  }
  const ctx = {
    Date: FakeDate, console: {log: m => logs.push(String(m)), warn: m => logs.push('WARN ' + m), error: m => logs.push('ERR ' + m)},
    SpreadsheetApp: {
      getActiveSpreadsheet: () => active, openById: id => { if (!books[id]) throw new Error('Unexpected error while getting the method or property openById'); return books[id]; },
      create: name => new Book(name), flush: () => {}, BorderStyle: {SOLID: 'SOLID'},
      getUi: () => { if (!uiAvailable) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); return {alert: m => logs.push('ALERT ' + m), createMenu: () => ({addItem() { return this; }, addSeparator() { return this; }, addToUi() {}})}; }
    },
    Utilities: {
      formatDate: (d, tz, p) => { if (tz !== 'Asia/Kolkata') throw new Error('sim only knows IST'); return fmtIST(d, p); },
      newBlob: (data, type) => new Blob(typeof data === 'string' ? Buffer.from(data, 'utf8') : fromBytes(data), type),
      gzip: b => new Blob(zlib.gzipSync(b.buf), 'application/x-gzip'),
      ungzip: b => new Blob(zlib.gunzipSync(b.buf), 'application/octet-stream'),
      base64Encode: bytes => fromBytes(bytes).toString('base64'),
      base64Decode: s => toBytes(Buffer.from(s, 'base64')),
      sleep: () => {}
    },
    PropertiesService: {getScriptProperties: () => ({getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { if (String(v).length > 9000) throw new Error('Property value too large'); props[k] = String(v); }, deleteProperty: k => { delete props[k]; }})},
    CacheService: {getScriptCache: () => ({
      get: k => (cache[k] !== undefined ? cache[k] : null), put: (k, v) => { if (String(v).length > 100000) throw new Error('Argument too large: value'); cache[k] = String(v); },
      getAll: ks => { const o = {}; ks.forEach(k => { if (cache[k] !== undefined) o[k] = cache[k]; }); return o; },
      putAll: m => { Object.keys(m).forEach(k => { if (String(m[k]).length > 100000) throw new Error('Argument too large: value'); cache[k] = String(m[k]); }); }})},
    LockService: {getScriptLock: () => ({tryLock: () => true, waitLock: () => {}, releaseLock: () => {}})},
    Session: {getActiveUser: () => ({getEmail: () => user})},
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: fn => { const spec = {fn}; const b = {timeBased: () => b, everyHours: n => { spec.hours = n; return b; }, everyDays: n => { spec.days = n; return b; }, atHour: h => { spec.at = h; return b; }, inTimezone: () => b,
        create: () => { const t = {spec, getHandlerFunction: () => fn}; triggers.push(t); return t; }}; return b; }
    },
    MailApp: {sendEmail: m => mails.push(m)},
    // Redash API mock: opts.redash = {key, queries: {id: {columns, rows} | 'fail'}}. First call returns a job, like a real run.
    UrlFetchApp: {fetch: (url, o) => {
      hit('urlFetch', 0);
      const R = opts.redash || {queries: {}}, reply = (code, obj) => ({getResponseCode: () => code, getContentText: () => typeof obj === 'string' ? obj : JSON.stringify(obj)});
      if (!o.headers || o.headers.Authorization !== 'Key ' + R.key) return reply(403, {message: 'Invalid API key'});
      let m = /\/api\/queries\/(\w+)\/results$/.exec(url);
      if (m) { const q = R.queries[m[1]]; if (!q) return reply(404, {message: 'Query not found'}); return reply(200, {job: {id: 'job-' + m[1], status: 1}}); }
      m = /\/api\/jobs\/job-(\w+)$/.exec(url);
      if (m) { const q = R.queries[m[1]]; return reply(200, {job: q === 'fail' ? {id: 'job-' + m[1], status: 4, error: 'Query failed: table not found'} : {id: 'job-' + m[1], status: 3, query_result_id: 'r' + m[1]}}); }
      m = /\/api\/query_results\/r(\w+)$/.exec(url);
      if (m) return reply(200, {query_result: {id: 'r' + m[1], retrieved_at: '2026-10-21T10:00:00', data: R.queries[m[1]]}});
      return reply(404, 'not found');
    }},
    DriveApp: {getFileById: () => ({moveTo() {}, setSharing() {}}), getFolderById: () => ({}), Access: {DOMAIN_WITH_LINK: 'D'}, Permission: {VIEW: 'V'}},
    HtmlService: {
      createTemplateFromFile: name => {
        const src = fs.readFileSync(opts.htmlDir + '/' + name + '.html', 'utf8'), t = {};
        // Real HtmlService treats every "<?" as the start of a scriptlet: any stray one breaks doGet with a SyntaxError.
        const stray = src.replace(/<\?!?=\s*\w+\s*\?>/g, '').indexOf('<?');
        if (stray >= 0) throw new Error('SyntaxError: Invalid or unexpected token (HtmlService scriptlet at character ' + stray + ' of ' + name + '.html)');
        t.evaluate = () => {
          const html = src.replace(/<\?!=\s*(\w+)\s*\?>/g, (m, k) => String(t[k])).replace(/<\?=\s*(\w+)\s*\?>/g, (m, k) => String(t[k]).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'));
          const out = {html, setTitle() { return out; }, addMetaTag() { return out; }, setXFrameOptionsMode() { return out; }, getContent: () => html};
          return out;
        };
        return t;
      },
      XFrameOptionsMode: {DEFAULT: 'DEFAULT'}
    }
  };
  vm.createContext(ctx);
  return {
    ctx, stats, books, active, props, cache, mails, triggers, logs,
    load: files => files.forEach(f => vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, {filename: f})),
    call: (fn, ...args) => ctx[fn](...args),
    as: email => { user = email; },
    ui: b => { uiAvailable = b; },
    advance: ms => { clock.ms += ms; },
    setNow: iso => { clock.ms = Date.parse(iso); },
    /** Paste rows into a tab the way File > Import / a sync does: header row + typed values (General format). */
    paste: (book, tab, rows, cols) => {
      const sh = book.getSheetByName(tab) || book.insertSheet(tab);
      sh.clear();
      const h = cols || Object.keys(rows[0] || {});
      const vals = [h].concat(rows.map(r => h.map(k => (r[k] === undefined || r[k] === null ? '' : typeof r[k] === 'number' ? r[k] : String(r[k])))));
      const saved = stats.calls;
      sh.getRange(1, 1, vals.length, h.length).setValues(vals);
      stats.calls = saved;
      return sh;
    },
    tab: (book, name) => { const sh = book.getSheetByName(name); if (!sh) return []; const v = sh.getRange(1, 1, Math.max(1, sh.getLastRow()), Math.max(1, sh.getLastColumn())).getValuesRaw(); const h = v[0];
      return v.slice(1).map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); },
    resetStats: () => { stats.calls = 0; stats.cells = 0; stats.byKind = {}; }
  };
}
module.exports = makeGas;
