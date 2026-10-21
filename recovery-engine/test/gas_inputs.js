/**
 * Input tabs for the Apps Script simulator, built from test/fixture.json in the exact shapes the North queries produce:
 * RAWItemlevel, STORE_VARIANCE_DAILY, STORE_MASTER, PILOT_COHORT, STORE_HEALTH_RAW, EMPLOYEE_CAPACITY_SYNC_RAW,
 * LOCATION_RECOVERY_RAW (one row per rack), AUDIT_EXECUTION_RAW (yesterday + today), AUDITOR_DAILY.
 * copies > 1 clones every store with new outlet ids (scale test).
 */
function buildInputs(fx, copies, todayTimes) {
  copies = copies || 1;
  const out = {RAWItemlevel: [], STORE_VARIANCE_DAILY: [], STORE_MASTER: [], PILOT_COHORT: [], STORE_HEALTH_RAW: [], EMPLOYEE_CAPACITY_SYNC_RAW: [],
    LOCATION_RECOVERY_RAW: [], AUDIT_EXECUTION_RAW: [], AUDITOR_DAILY: []};
  const addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);
  const yday = addDays(fx.today, -1);
  for (let k = 0; k < copies; k++) {
    const idOf = id => k ? String(Number(id) * 10 + k) : String(id);
    fx.health.forEach(h => {
      const id = idOf(h.outlet_id), m = fx.master[h.outlet_id] || {};
      out.STORE_MASTER.push({outlet_id: id, outlet_name: m.outlet_name + (k ? ' #' + k : ''), city: '', region: h.region, cluster: h.region + ' C' + (k % 3 + 1), cm_sm: 'CM ' + h.region, low_order_window: '14:00-17:00'});
      out.PILOT_COHORT.push({pair_id: h.region + '_' + k, region: h.region, outlet_id: id, outlet_name: m.outlet_name, cohort_role: k ? '' : h.cohort_role, comparison_outlet_id: idOf(h.comparison_outlet_id)});
      for (let i = 1; i <= 90; i++) out.STORE_VARIANCE_DAILY.push({date_: addDays(fx.today, -i), outlet_id: id, outlet_name: m.outlet_name, negative_amount: h.cohort_role === 'BROKEN' ? 5200 : 1300,
        positive_amount: h.cohort_role === 'BROKEN' ? 2100 : 1250, net_var: 0, raw_synced_at: fx.today + ' 07:30:00'});
    });
    fx.raw.forEach(r => out.RAWItemlevel.push(Object.assign({}, r, {outlet_id: idOf(r.outlet_id), outlet_name: (fx.master[r.outlet_id] || {}).outlet_name, raw_synced_at: fx.today + ' 07:45:00'})));
    (fx.metrics || []).forEach(x => out.STORE_HEALTH_RAW.push(Object.assign({}, x, {outlet_id: idOf(x.outlet_id)})));
    fx.emps.forEach(e => out.EMPLOYEE_CAPACITY_SYNC_RAW.push(Object.assign({}, e, {outlet_id: idOf(e.outlet_id)})));
    const racks = {};
    fx.locs.forEach(l => {
      const key = l[0] + '|' + l[3], r = racks[key] = racks[key] || {outlet_id: idOf(l[0]), rack_id: l[3], aisle_id: l[2], rack_locations: 0, direct_locations: 0, signal_locations: 0};
      const meas = l[8] === 'MEASURABLE', ppi = Number(l[6]), ideal = Number(l[7]), cd = Number(l[4]) || 0;
      r.rack_locations++;
      if ((meas && ppi > ideal + 2) || cd >= 2) r.direct_locations++;
      if ((meas && ppi > ideal) || cd >= 1) r.signal_locations++;
    });
    Object.keys(racks).forEach(x => out.LOCATION_RECOVERY_RAW.push(racks[x]));
    const daily = {};
    fx.audits.forEach(a => {
      const [d, oid, loc, rack, status, aud, skus, qty, q, sec, end, cov] = a, id = idOf(oid);
      if (status === 'COMPLETED' && sec > 0 && sec <= 14400) {
        const key = d + '|' + id + '|' + aud, g = daily[key] = daily[key] || {audit_date_ist: d, outlet_id: id, auditor_id: aud, auditor_name: '', sessions: 0, elapsed_seconds: 0, distinct_skus: 0,
          found_qty: 0, judged_sessions: 0, below_sop_sessions: 0, first_end_time: end, last_end_time: end};
        g.sessions++; g.elapsed_seconds += sec; g.distinct_skus += skus; g.found_qty += qty;
        if (q) { g.judged_sessions++; if (/^BELOW/.test(q)) g.below_sop_sessions++; }
        if (end < g.first_end_time) g.first_end_time = end;
        if (end > g.last_end_time) g.last_end_time = end;
      }
      if (d === yday) {
        out.AUDIT_EXECUTION_RAW.push({audit_date_ist: d, outlet_id: id, location_id: loc, rack_id: rack, session_status: status, end_time: end, auditor_id: aud, auditor_first_name: '', auditor_last_name: '',
          distinct_skus: skus, found_qty: qty, quality_status: q, session_elapsed_seconds: sec, expected_sku_coverage_pct: cov});
        // Today's morning shift: yesterday's sessions before the "now" hour, replayed on today's date (who is on the floor now).
        const hh = Number(String(end).slice(11, 13).replace(':', ''));
        if (todayTimes && hh < todayTimes) out.AUDIT_EXECUTION_RAW.push({audit_date_ist: fx.today, outlet_id: id, location_id: loc, rack_id: rack, session_status: status,
          end_time: fx.today + String(end).slice(10), auditor_id: aud, auditor_first_name: '', auditor_last_name: '', distinct_skus: skus, found_qty: qty, quality_status: q,
          session_elapsed_seconds: sec, expected_sku_coverage_pct: cov});
      }
    });
    Object.keys(daily).forEach(x => out.AUDITOR_DAILY.push(daily[x]));
  }
  // The audit export writes timestamps as "2026-09-07 0:43:11"; normalise to two-digit hours like the sheet sync does.
  out.AUDIT_EXECUTION_RAW.forEach(a => { a.end_time = String(a.end_time).replace(/ (\d):/, ' 0$1:'); });
  out.AUDITOR_DAILY.forEach(a => { a.first_end_time = String(a.first_end_time).replace(/ (\d):/, ' 0$1:'); a.last_end_time = String(a.last_end_time).replace(/ (\d):/, ' 0$1:'); });
  return out;
}
module.exports = buildInputs;
