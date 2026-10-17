/** In-memory repo (same contract as Server.gs re_repo). Used by Node tests and the browser preview. */
function RE_MEMREPO(fx, opts) {
  const tables = {}, props = {};
  let clock = 0;
  const locs = fx.locs.map(l => ({outlet_id: l[0], location_id: l[1], aisle_id: l[2], rack_id: l[3], correction_days_7d: l[4], current_ppi_broken_flag: l[5]}));
  const audits = fx.audits.map(a => ({audit_date_ist: a[0], outlet_id: a[1], location_id: a[2], rack_id: a[3], session_status: a[4], auditor_id: a[5], distinct_skus: a[6],
    found_qty: a[7], quality_status: a[8], session_elapsed_seconds: a[9]}));
  const sops = (opts.sops || []).map(s => ({level: s[0], step_no: s[1], step: s[2]}));
  return {
    me: () => opts.me || 'param.chavan@grofers.com',
    today: () => fx.today,
    now: () => fx.today + ' ' + String(10 + Math.floor(clock / 60)).padStart(2, '0') + ':' + String(clock++ % 60).padStart(2, '0') + ':00',
    settingsRows: () => opts.cfg || [],
    rows: tab => (tables[tab] || []).map(r => Object.assign({}, r)),
    raw: () => fx.raw, storeMaster: () => fx.master, health: () => fx.health, captains: () => fx.emps, locations: () => locs, audits: () => audits, sops: () => sops,
    append: (tab, objs) => { tables[tab] = (tables[tab] || []).concat(objs.map(o => { const r = {}; Object.keys(o).forEach(k => { r[k] = o[k] === null || o[k] === undefined ? '' : String(o[k]); }); return r; })); },
    getProp: k => props[k] || null, setProp: (k, v) => { props[k] = v; }, lock: fn => fn(),
    _tables: tables, _audits: audits
  };
}
if (typeof module !== 'undefined') module.exports = RE_MEMREPO;
