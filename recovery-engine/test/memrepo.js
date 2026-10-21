/** In-memory repo (same contract as Code.gs re_repo). Used by Node tests and the browser preview. */
const ZLIB = typeof require === 'function' && typeof Buffer !== 'undefined' ? require('zlib') : null;
function RE_MEMREPO(fx, opts) {
  const tables = {}, props = {}, tokens = {}, cfg = (opts.cfg || []).map(r => Object.assign({}, r));
  let clock = opts.clock || 0;
  const locs = fx.locs.map(l => Array.isArray(l) ? {outlet_id: l[0], location_id: l[1], aisle_id: l[2], rack_id: l[3], correction_days_7d: l[4], current_ppi_broken_flag: l[5],
    current_ppi: l[6], current_ideal_ppi: l[7], current_ppi_signal_status: l[8]} : l);
  const audits = fx.audits.map(a => Array.isArray(a) ? {audit_date_ist: a[0], outlet_id: a[1], location_id: a[2], rack_id: a[3], session_status: a[4], auditor_id: a[5], distinct_skus: a[6],
    found_qty: a[7], quality_status: a[8], session_elapsed_seconds: a[9], end_time: a[10], expected_sku_coverage_pct: a[11]} : a);
  const sops = (opts.sops || []).map(s => ({level: s[0], step_no: s[1], step: s[2]}));
  const str = o => { const r = {}; Object.keys(o).forEach(k => { if (k !== '_row') r[k] = o[k] === null || o[k] === undefined ? '' : String(o[k]); }); return r; };
  const withRow = (t, i) => Object.assign({}, t, {_row: i + 2});
  const tab = name => (tables[name] = tables[name] || []);
  const master = () => {
    const m = {};
    fx.raw.forEach(r => { if (!m[r.outlet_id]) m[r.outlet_id] = {outlet_name: r.outlet_name || r.outlet_id, city: r.city || '', cluster: '', region: '', cm_sm: '', in_feed: true}; });
    Object.keys(fx.master || {}).forEach(k => { m[k] = Object.assign({}, m[k] || {}, fx.master[k], {listed: true}); });
    return m;
  };
  const pad = n => String(n).padStart(2, '0');
  return {
    me: () => opts.me || 'param.chavan@grofers.com',
    today: () => fx.today,
    now: () => opts.nowFn ? opts.nowFn() : fx.today + ' ' + pad(10 + Math.floor(clock / 60) % 13) + ':' + pad(clock++ % 60) + ':00',
    settingsRows: () => cfg.map(r => Object.assign({}, r)),
    saveSettings: ch => { Object.keys(ch).forEach(k => { const r = cfg.find(x => x.key === k); if (r) r.value = ch[k]; else cfg.push({key: k, value: ch[k]}); }); },
    users: () => opts.users || [],
    healthRows: () => [],
    once: t => { if (tokens[t]) return false; tokens[t] = true; return true; },
    rows: (name, cols, fromRow) => tab(name).map(withRow).filter(r => !fromRow || r._row >= fromRow),
    rowsWhere: (name, col, value, lastN) => { const out = tab(name).map(withRow).filter(r => String(r[col]) === String(value)); return lastN ? out.slice(-lastN) : out; },
    tail: (name, n) => tab(name).map(withRow).slice(-n),
    raw: () => fx.raw, storeMaster: master, health: () => fx.health, storeMetrics: () => fx.metrics || [], storeVariance: () => fx.variance || [],
    exportSheet: (title, pages) => (opts.exportSheet ? opts.exportSheet(title, pages) : null), captains: () => fx.emps, locations: () => locs, audits: () => audits,
    auditorDaily: () => fx.dailies || [], sops: () => sops,
    append: (name, objs) => { tables[name] = tab(name).concat(objs.map(str)); },
    writeAll: (name, objs) => { tables[name] = objs.map(str); },
    // Same cells as the sheet: gzip + base64 in Node (zlib), plain JSON in the browser preview; 45,000 characters per cell, "G" prefix.
    pack: obj => { const s = ZLIB ? ZLIB.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64') : JSON.stringify(obj), out = [];
      for (let i = 0; i < s.length; i += 45000) out.push('G' + s.substr(i, 45000)); return out.length ? out : ['G']; },
    unpack: parts => { const s = parts.map(p => String(p).replace(/^G/, '')).join(''); return !s ? null : JSON.parse(ZLIB ? ZLIB.gunzipSync(Buffer.from(s, 'base64')).toString() : s); },
    getProp: k => props[k] || null, setProp: (k, v) => { props[k] = v; }, lock: fn => fn(),
    _tables: tables, _audits: audits, _props: props
  };
}
if (typeof module !== 'undefined') module.exports = RE_MEMREPO;
