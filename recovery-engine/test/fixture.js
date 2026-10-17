/**
 * Builds test/preview data from the real exports. RAWItemlevel is SYNTHETIC (generated on real
 * location IDs) because the C export was not supplied; everything else is the real CSV.
 * Usage: node test/fixture.js <uploads dir> [maxStores]  -> writes test/fixture.json
 */
const fs = require('fs'), path = require('path');
const dir = process.argv[2], maxStores = Number(process.argv[3] || 10);
const TODAY = '2026-09-08';

function csv(file) {
  const s = fs.readFileSync(file, 'utf8'), rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const h = rows[0].map(x => x.toLowerCase().trim().replace(/[^\w]+/g, '_').replace(/^_|_$/g, ''));
  return rows.slice(1).filter(r => r.length > 1).map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; });
}
const find = re => path.join(dir, fs.readdirSync(dir).find(f => re.test(f)));

const cohort = csv(find(/PILOT_COHORT\.csv$/)).slice(0, maxStores);
const ids = cohort.map(c => c.outlet_id);
const keep = r => ids.indexOf(r.outlet_id) >= 0;
const locs = csv(find(/^fc20c5ec.*LOCATION_RECOVERY_RAW\.csv$/)).filter(keep).map(l => [l.outlet_id, l.location_id, l.aisle_id, l.rack_id, +l.correction_days_7d || 0, +l.current_ppi_broken_flag || 0]);
const audits = csv(find(/AUDIT_EXECUTION_RAW\.csv$/)).filter(keep).map(a => [a.audit_date_ist, a.outlet_id, a.location_id, a.rack_id, a.session_status, a.auditor_id, +a.distinct_skus || 0, +a.found_qty || 0, a.quality_status, +a.session_elapsed_seconds || 0]);
const emps = csv(find(/^c1759775.*EMPLOYEE_CAPACITY_SYNC_RAW\.csv$/)).filter(keep).map(e => ({snapshot_date: e.snapshot_date, outlet_id: e.outlet_id, employee_id: e.employee_id,
  employee_name: e.employee_name, designation: e.designation, auditor_active_hours_l7: e.auditor_active_hours_l7, missing_complaint_pct_l7: e.missing_complaint_pct_l7,
  wrong_item_complaint_pct_l7: e.wrong_item_complaint_pct_l7, recent_presence_status: e.recent_presence_status}));

// Synthetic variance: broken stores get clustered racks (one aisle heavily hit); control stores scattered items.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const L0 = ['Dairy', 'Snacks', 'Cigarettes', 'Personal Care', 'Staples', 'Beverages', 'Chocolates', 'Home Care'];
const raw = [];
cohort.forEach(c => {
  const mine = locs.filter(l => l[0] === c.outlet_id), broken = c.cohort_role === 'BROKEN';
  const racks = [...new Set(mine.map(l => l[3]))], hot = racks.slice(5, broken ? 13 : 6);
  const n = broken ? 160 : 70;
  for (let i = 0; i < n; i++) {
    const clustered = rnd() < (broken ? 0.55 : 0.1);
    const pool = clustered ? mine.filter(l => hot.indexOf(l[3]) >= 0) : mine;
    const loc = pool[Math.floor(rnd() * pool.length)], loc2 = mine[Math.floor(rnd() * mine.length)];
    const mrp = Math.round(20 + rnd() * 700), qty = 1 + Math.floor(rnd() * 6), daysAgo = 1 + Math.floor(rnd() * 9);
    const dec = new Date(Date.UTC(2026, 8, 8) - daysAgo * 86400000).toISOString().slice(0, 10);
    raw.push({update_date: TODAY, outlet_id: c.outlet_id, item_id: c.outlet_id + '-' + (10000 + i), item_name: L0[i % L0.length] + ' item ' + (i + 1), l0: L0[i % L0.length],
      upc: String(8900000000000 + i * 37), mrp, variance: mrp * qty, variance_qty: qty, rnk: i + 1, audit_decrement_qty: rnd() < 0.7 ? qty : 0, audit_increment_qty: 0,
      audit_decrement_dates: '[' + dec + ']', audit_increment_dates: '[]', neg_loc_array: rnd() < 0.85 ? '[' + loc[1] + ']' : '[]',
      probable_locations: rnd() < 0.08 ? '[]' : '[' + loc2[1] + ']', store_total_absolute_variance: ''});
  }
});
const health = cohort.map((c, i) => ({outlet_id: c.outlet_id, region: c.region, cohort_role: c.cohort_role, comparison_outlet_id: c.comparison_outlet_id,
  open_variance_3m: c.cohort_role === 'BROKEN' ? 450000 + i * 1000 : 120000, net_variance_2m: c.cohort_role === 'BROKEN' ? -90000 : 5000, low_order_window: '14:00-17:00'}));
const master = {};
cohort.forEach(c => { master[c.outlet_id] = {outlet_name: c.outlet_name, city: '', cluster: c.region, cm_sm: ''}; });
fs.writeFileSync(path.join(__dirname, 'fixture.json'), JSON.stringify({today: TODAY, raw, health, master, emps, locs, audits}));
console.log('stores', ids.length, 'raw', raw.length, 'locs', locs.length, 'audits', audits.length, 'emps', emps.length);
