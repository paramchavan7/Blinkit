// RECOVERY ENGINE - paste this whole file into Code.gs in Apps Script (replace everything that is there).
// Built 2026-10-17 from IRD_Core.gs + IRD_Service.gs + Code.gs. Do not edit here; settings live in the CFG tab.

/**
 * Recovery Engine v2 | Core logic
 * Pure functions only: no Sheets, no network, no clock. Runs in Apps Script,
 * Node (tests) and the browser (the page receives this factory's source so
 * plan edits re-allocate instantly without a server round-trip).
 *
 * Journey: Diagnose -> Prescribe -> Suggest crew -> SM plans -> Execute -> Close shift -> Measure
 *   Suggested = engine's plan, Planned = SM's confirmed plan, Actual = hours/tasks the SM logs.
 *   Recovery is only counted when the variance feed shows it.
 *
 * Ported 1:1 from C (UPW&UK Inventory Recovery App) Code.gs: parseArrayCell, negativePriority,
 * recoveryStatus, worklist eligibility. Everything else is new.
 */
function RE_CORE_FACTORY() {
  'use strict';
  const BUILD = 'RE_V2_20261017';

  // ---------------------------------------------------------------- settings
  // Every threshold the engine uses. Values marked (provisional) need calibration from pan-India data.
  const SETTINGS = [
    {key:'recovery_app_url', def:'', type:'text', label:'Optional: link to the old Recovery App, shown to SMs on the plan'},
    {key:'pilot_outlets', def:'', type:'list', label:'Pilot outlet IDs (blank = all in feed)'},
    {key:'inputs_sheet_id', def:'', type:'text', label:'Leave blank (inputs are the blue tabs in this sheet). Only set if your query sync writes to a different sheet'},
    {key:'tab_raw', def:'RAWItemlevel', type:'text', label:'Tab name for item-level variance (query 2)'},
    {key:'tab_store_master', def:'STORE_MASTER', type:'text', label:'Tab name for the store list'},
    {key:'tab_captains', def:'EMPLOYEE_CAPACITY_SYNC_RAW', type:'text', label:'Tab name for the captain roster'},
    {key:'tab_locations', def:'LOCATION_RECOVERY_RAW', type:'text', label:'Tab name for locations'},
    {key:'tab_audits', def:'AUDIT_EXECUTION_RAW', type:'text', label:'Tab name for audit sessions'},
    {key:'tab_health', def:'PILOT_COHORT', type:'text', label:'Tab name for the pilot cohort'},
    {key:'tab_store_metrics', def:'STORE_HEALTH_RAW', type:'text', label:'Tab name for daily store health (PPI, TFR, R2A, surge)'},
    {key:'tab_store_variance', def:'STORE_VARIANCE_DAILY', type:'text', label:'Tab name for daily store variance (query 1)'},
    {key:'export_folder_id', def:'', type:'text', label:'Drive folder for printable captain sheets (blank = My Drive)'},
    {key:'restrict_sm_to_users', def:'FALSE', type:'text', label:'TRUE = only people in the USERS tab can open the app, and SMs only see their outlets'},
    {key:'pm_emails', def:'param.chavan@grofers.com', type:'list', label:'PM / admin emails (control tower)'},
    {key:'cm_emails', def:'', type:'list', label:'CM emails (cluster review)'},
    {key:'rank_limit', def:200, type:'num', label:'Rank limit (same as C)'},
    {key:'prob_locations_per_item', def:2, type:'num', label:'Probable locations checked per item'},
    {key:'rack_segments', def:3, type:'num', label:'Location code segments that make a rack (A-01-02-03 -> A-01-02)'},
    {key:'aisle_segments', def:2, type:'num', label:'Location code segments that make an aisle (A-01)'},
    {key:'rack_sweep_min_items', def:4, type:'num', label:'Variance items in one rack before it needs a full rack sweep (provisional)'},
    {key:'aisle_sweep_min_racks', def:3, type:'num', label:'Broken racks in one aisle before it needs an aisle reset (provisional)'},
    {key:'full_recon_min_aisles', def:3, type:'num', label:'Broken aisles before full inventory reconciliation is advised (provisional)'},
    {key:'locations_per_rack', def:17, type:'num', label:'Locations per rack when IN_LOCATIONS has no row for the rack'},
    {key:'direct_ppi_delta_sec', def:2, type:'num', label:'Direct target: location PPI above ideal PPI by this many seconds (Parth V1 rule)'},
    {key:'direct_correction_days', def:2, type:'num', label:'Direct target: stock-correction days in last 7 (Parth V1 rule)'},
    {key:'signal_correction_days', def:1, type:'num', label:'Any signal: stock-correction days in last 7 (Parth V1 rule)'},
    {key:'full_rack_direct_pct', def:25, type:'num', label:'Full rack sweep when direct targets are at least this % of the rack (Parth V1 rule)'},
    {key:'full_rack_signal_pct', def:50, type:'num', label:'Full rack sweep when any-signal locations are at least this % of the rack (Parth V1 rule)'},
    {key:'audit_min_coverage_pct', def:80, type:'num', label:'Audit counts as MATCHED only at or above this expected-SKU coverage % (V2 quality gate)'},
    {key:'minutes_per_location', def:4.7, type:'num', label:'Measured minutes per location (V2 engine)'},
    {key:'measured_to_gross', def:0.4, type:'num', label:'Measured-to-gross conversion (V2 engine)'},
    {key:'upc_search_minutes', def:10, type:'num', label:'Measured minutes per unmapped item search'},
    {key:'max_hours_per_captain', def:3, type:'num', label:'Max recovery hours per captain per day'},
    {key:'max_budget_hours', def:12, type:'num', label:'Cap on suggested daily recovery hours per store'},
    {key:'audit_lookback_days', def:30, type:'num', label:'Days of audit sessions used for captain IAPH / QAPH / bad-audit %'},
    {key:'min_audits_for_rating', def:20, type:'num', label:'Audits a captain needs before the rating is trusted'},
    {key:'complex_max_bad_pct', def:5, type:'num', label:'Bad-audit % that always clears a captain for sweeps (the more accurate half of the store is also cleared)'},
    {key:'suggest_max_bad_pct', def:50, type:'num', label:'Captains above this bad-audit % are never suggested (SM can still add them)'},
    {key:'pilferage_l0', def:'cigarettes,tobacco,liquor,chocolates,personal care,fragrances', type:'list', label:'L0 categories treated as pilferage-prone'},
    {key:'pilferage_keywords', def:'marlboro,classic ,gold flake,dunhill,cigarette,condom,personal massager,whey,protein powder,creatine,earbuds,tws,smart watch,power bank,trimmer,perfume,eau de,attar,ghee,cashew,almond,pistachio,walnut', type:'list', label:'Item-name words treated as pilferage-prone (used when the feed has no L0)'},
    {key:'min_item_variance', def:20, type:'num', label:'Ignore items with variance ₹ below this (rounding noise)'},
    {key:'high_value_mrp', def:500, type:'num', label:'MRP at or above which an item is pilferage-prone'},
    {key:'sev_ppi_target', def:18, type:'num', label:'Severity (Parth LiveHealth): store PPI above this = broken'},
    {key:'sev_tfr_target', def:99.5, type:'num', label:'Severity (Parth LiveHealth): TFR % below this = broken. PPI and TFR both broken = SEVERELY BROKEN'},
    {key:'sev_r2a_target', def:30, type:'num', label:'Capacity (Parth LiveHealth): R2A seconds above this = capacity risk'},
    {key:'sev_surge_target', def:2, type:'num', label:'Capacity (Parth LiveHealth): surge % above this = capacity risk (both = CONSTRAINED)'},
    {key:'sev_health_days', def:1, type:'num', label:'Completed days of store health averaged for severity (1 = latest day, as Parth)'},
    {key:'sev_broken_pending', def:150000, type:'num', label:'Severity (variance): absolute pending ₹ at which a store is BROKEN (half = AT RISK)'},
    {key:'sev_broken_open_3m', def:400000, type:'num', label:'Severity (variance): last-3-month open variance ₹ at which a store is BROKEN (half = AT RISK)'},
    {key:'sev_open_days', def:90, type:'num', label:'Severity (variance): days summed for "open variance" (gross negative ₹)'},
    {key:'sev_net_days', def:60, type:'num', label:'Severity (variance): days summed for "net variance" (positive ₹ minus negative ₹)'},
    {key:'sev_fresh_negatives', def:10, type:'num', label:'Severity (variance): T-1 negatives that add a severity point'},
    {key:'low_adherence_pct', def:70, type:'num', label:'Actual hours below this % of planned is flagged'},
    {key:'feed_stale_after_days', def:1, type:'num', label:'Feed older than this many days shows a warning'},
    {key:'t3_offset', def:3, type:'num', label:'Outcome check 1 (days after plan)'},
    {key:'t7_offset', def:7, type:'num', label:'Outcome check 2 (days after plan)'}
  ];
  const DEFAULTS = {};
  SETTINGS.forEach(s => { DEFAULTS[s.key] = s.def; });

  const text = x => (x === null || x === undefined) ? '' : String(x).trim();
  const num = x => {
    if (x === '' || x === null || x === undefined || typeof x === 'boolean') return 0;
    const n = Number(String(x).replace(/[,₹%]/g, ''));
    return isFinite(n) ? n : 0;
  };
  const has = x => text(x) !== '' && isFinite(Number(String(x).replace(/[,₹%]/g, '')));
  const round = (x, d) => { const p = Math.pow(10, d || 0); return Math.round(x * p) / p; };
  const fail = m => { throw new Error('RE: ' + m); };
  const median = arr => { const a = arr.filter(x => x !== null && isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };

  function resolveSettings(rows) {
    const out = Object.assign({}, DEFAULTS), errors = [];
    (rows || []).forEach(r => {
      const s = SETTINGS.find(x => x.key === text(r.key));
      if (!s || text(r.value) === '') return;
      if (s.type === 'num') { if (has(r.value)) out[s.key] = num(r.value); else errors.push(s.key + ' must be a number'); }
      else if (s.type === 'list') out[s.key] = text(r.value).toLowerCase().split(/\s*[,;]\s*/).filter(Boolean).join(',');
      else out[s.key] = text(r.value);
    });
    return {settings: out, errors};
  }
  const inList = (list, v) => !!text(v) && text(list).toLowerCase().split(',').map(x => x.trim()).indexOf(text(v).toLowerCase()) >= 0;
  /** USERS tab (email, role, outlet_ids) wins; otherwise pm_emails / cm_emails; everyone else is an SM. */
  function access(st, email, users) {
    const u = (users || []).find(x => text(x.email).toLowerCase() === text(email).toLowerCase());
    const strict = text(st.restrict_sm_to_users).toUpperCase() === 'TRUE';
    if (u) {
      const r = text(u.role).toUpperCase();
      return {role: ['PM', 'CM', 'SM'].indexOf(r) >= 0 ? r : 'SM', outlets: text(u.outlet_ids) ? text(u.outlet_ids).split(/\s*[,;]\s*/).filter(Boolean) : null, listed: true};
    }
    if (inList(st.pm_emails, email)) return {role: 'PM', outlets: null, listed: true};
    if (inList(st.cm_emails, email)) return {role: 'CM', outlets: null, listed: true};
    if (strict) fail('You are not in the USERS list for this app. Ask the PM to add ' + email + '.');
    return {role: 'SM', outlets: null, listed: false};
  }
  const role = (st, email, users) => access(st, email, users).role;
  const isPilot = (st, id) => !text(st.pilot_outlets) || inList(st.pilot_outlets, id);

  // ---------------------------------------------------------------- time (IST)
  const IST = 330 * 60000;
  const p2 = n => ('0' + n).slice(-2);
  function toMs(x) {
    if (x instanceof Date) return x.getTime();
    if (typeof x === 'number') return isFinite(x) ? x : null;
    const t = text(x);
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
    if (!m) { const u = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t); if (u) m = [u[0], u[3], u[1], u[2], u[4], u[5], u[6]]; }
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - IST;
  }
  function fmt(ms) {
    if (ms === null || ms === undefined) return '';
    const d = new Date(ms + IST);
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  }
  const day = x => { const ms = toMs(x); return ms === null ? '' : fmt(ms).slice(0, 10); };
  const utc = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const addDays = (d, n) => new Date(utc(d) + n * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
  function freshness(feedDate, today, st) {
    if (!feedDate) return {status: 'UNKNOWN', label: 'Feed date unknown'};
    const age = daysBetween(feedDate, today), stale = age > st.feed_stale_after_days;
    return {status: stale ? 'STALE' : 'CURRENT', age_days: age, label: (stale ? 'Stale feed: ' : 'Feed: ') + feedDate + ' (' + age + 'd old)'};
  }

  // ---------------------------------------------------------------- C worklist port
  function parseArrayCell(v) {
    let s = text(v);
    if (!s || s === '[]') return [];
    s = s.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!s) return [];
    return s.split(',').map(x => x.trim().replace(/^['"]/, '').replace(/['"]$/, '').trim()).filter(Boolean);
  }
  function negativePriority(decDates, anchor) {
    const a = day(anchor);
    let best = null;
    (Array.isArray(decDates) ? decDates : parseArrayCell(decDates)).forEach(v => {
      const m = /(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(text(v));
      if (!m || !a) return;
      const age = daysBetween(m[1] + '-' + p2(+m[2]) + '-' + p2(+m[3]), a);
      if (age < 1 || age > 7) return;
      if (best === null || age < best) best = age;
    });
    if (best === 1) return {score: 0, priority: 'P0', bucket: 'T-1 negative'};
    if (best !== null && best <= 3) return {score: 1, priority: 'P1', bucket: 'T-3 negative'};
    if (best !== null && best <= 5) return {score: 2, priority: 'P2', bucket: 'T-5 negative'};
    if (best !== null && best <= 7) return {score: 3, priority: 'P3', bucket: 'T-7 negative'};
    return {score: 4, priority: 'P4', bucket: 'High value'};
  }
  function recoveryStatus(dec, inc, vq) {
    if (dec > 0 && inc < dec) return 'PENDING_RECOVERY';
    if (dec > 0 && inc >= dec) return 'RECOVERED_BY_INCREMENT';
    if (dec <= 0 && vq > 0) return 'NO_AUDIT_LOG';
    return 'NO_PENDING_RECOVERY';
  }
  const segs = (loc, n) => { const p = text(loc).split('-'); return p.length >= n ? p.slice(0, n).join('-') : text(loc); };
  const rackOf = (loc, st) => segs(loc, st.rack_segments);
  const aisleOf = (loc, st) => segs(loc, st.aisle_segments);

  /** Variance source bucket (provisional rules; Rahul's documented cases should replace them). */
  function sourceBucket(it, st) {
    const name = it.item_name.toLowerCase(), kw = text(st.pilferage_keywords).toLowerCase().split(',').filter(Boolean);
    if (inList(st.pilferage_l0, it.l0) || Math.max(it.mrp, it.unit_value) >= st.high_value_mrp || kw.some(k => name.indexOf(k) >= 0)) return 'PILFERAGE';
    if (it.recovery_status === 'NO_AUDIT_LOG') return 'AUDIT_GAP';
    if (it.neg_locations.length) return 'MISPLACED';
    return 'OTHER';
  }

  /** A real shelf location: drops INTERIM_LOCATION and anything too short to have a rack. */
  const physical = (locs, st) => locs.filter(l => !/INTERIM/i.test(l) && text(l).split('-').length > st.rack_segments);

  /**
   * rows = RAWItemlevel records (normalised headers). Same eligibility as C's Recovery Worklist mode.
   * Works with the full C schema (update_date, audit_* columns) and with the lean monthly export
   * (month_start_date, raw_synced_at, no audit columns). Without audit dates, priority comes from rank.
   */
  function worklist(rows, outletId, st) {
    const items = [];
    let totalAbs = 0, storeTotal = 0, feedDate = '', month = '', hasAudit = false;
    rows.forEach(r => {
      if (text(r.outlet_id) !== text(outletId)) return;
      totalAbs += Math.abs(num(r.variance));
      storeTotal = Math.max(storeTotal, Math.abs(num(r.store_total_absolute_variance)));
      const ud = day(r.update_date || r.raw_synced_at || r.month_start_date);
      if (ud > feedDate) feedDate = ud;
      const ms = day(r.month_start_date);
      if (ms > month) month = ms;
      const rank = num(r.rnk), variance = num(r.variance);
      if (rank <= 0 || rank > st.rank_limit || variance <= 0 || variance < st.min_item_variance) return;
      const audit = has(r.audit_decrement_qty) || text(r.audit_decrement_dates) !== '';
      if (audit) hasAudit = true;
      const vq = num(r.variance_qty), dec = num(r.audit_decrement_qty), inc = num(r.audit_increment_qty);
      const pr = audit ? negativePriority(r.audit_decrement_dates, r.update_date || r.raw_synced_at)
        : rank <= 25 ? {score: 1, priority: 'TOP25', bucket: 'Top 25 by ₹'} : rank <= 100 ? {score: 3, priority: 'TOP100', bucket: 'Top 100 by ₹'} : {score: 4, priority: 'RANKED', bucket: 'Ranked'};
      const it = {
        item_id: text(r.item_id), item_name: text(r.item_name), l0: text(r.l0), upc: text(r.upc), mrp: num(r.mrp), rnk: rank,
        variance, variance_qty: vq, unit_value: vq > 0 ? variance / vq : 0, audit_increment_qty: inc, recovery_status: audit ? recoveryStatus(dec, inc, vq) : 'UNKNOWN',
        priority: pr.priority, priority_score: pr.score, bucket: pr.bucket,
        neg_locations: physical(parseArrayCell(r.neg_loc_array), st), prob_locations: physical(parseArrayCell(r.probable_locations), st)
      };
      it.source = sourceBucket(it, st);
      items.push(it);
    });
    items.sort((a, b) => a.priority_score - b.priority_score || b.variance - a.variance || a.rnk - b.rnk);
    const counts = {P0: 0, P1: 0, P2: 0, P3: 0, P4: 0};
    items.forEach(x => { counts[x.priority] = (counts[x.priority] || 0) + 1; });
    return {items, summary: {
      outlet_id: text(outletId), feed_date: feedDate, month_start: month, has_audit_columns: hasAudit,
      total_absolute_pending: storeTotal > 0 ? storeTotal : totalAbs,
      worklist_value: items.reduce((v, x) => v + x.variance, 0), worklist_skus: items.length, priority_counts: counts
    }};
  }

  // ---------------------------------------------------------------- 1. diagnose
  const gross = (minutes, st) => minutes / 60 / st.measured_to_gross;   // captain hours for measured minutes
  const LEVEL = {
    AISLE: {label: 'Aisle reset', complex: true},
    RACK: {label: 'Rack sweep', complex: true},
    LOCATION: {label: 'Location check', complex: false},
    SEARCH: {label: 'Item search', complex: false}
  };

  /** Latest (or averaged) completed-day store health from STORE_HEALTH_RAW rows of one outlet. */
  function storeMetrics(rows, outletId, st) {
    const mine = (rows || []).filter(r => text(r.outlet_id) === text(outletId) && has(r.ppi) && text(r.data_period_status).toUpperCase() !== 'PARTIAL')
      .sort((a, b) => day(b.metric_date).localeCompare(day(a.metric_date))).slice(0, Math.max(1, st.sev_health_days));
    if (!mine.length) return null;
    const avg = k => { const v = mine.filter(r => has(r[k])).map(r => num(r[k])); return v.length ? round(v.reduce((x, y) => x + y, 0) / v.length, 2) : null; };
    return {date: day(mine[0].metric_date), days: mine.length, ppi: avg('ppi'), tfr_pct: avg('tfr_pct'), r2a_sec: avg('r2a_sec'), surge_pct: avg('surge_pct')};
  }
  /**
   * Open / net variance from the daily store table (query 1). Open = gross negative ₹ over sev_open_days.
   * Net = positive ₹ minus negative ₹ over sev_net_days (below zero = net loss). Uses the amounts, not net_var, so its sign convention cannot flip the rule.
   */
  function varianceHistory(rows, outletId, today, st) {
    const fromO = addDays(today, -st.sev_open_days), fromN = addDays(today, -st.sev_net_days);
    let open = 0, net = 0, days = 0;
    (rows || []).forEach(r => {
      if (text(r.outlet_id) !== text(outletId)) return;
      const d = day(r.date_ || r.date);
      if (!d || d >= today) return;
      if (d >= fromO) { open += Math.abs(num(r.negative_amount)); days++; }
      if (d >= fromN) net += Math.abs(num(r.positive_amount)) - Math.abs(num(r.negative_amount));
    });
    return days ? {open_variance_3m: Math.round(open), net_variance_2m: Math.round(net), days} : null;
  }
  const TIER_RANK = {SEVERELY_BROKEN: 3, BROKEN: 2, AT_RISK: 1, SORTED: 0};
  /**
   * Severity = the worse of two views:
   *  ops (Parth's LiveHealth rule): PPI > target and TFR < target = SEVERELY_BROKEN, one of them = BROKEN, else SORTED
   *  inventory (variance): pending ₹, 3-month open variance, net loss over 2 months, fresh T-1 negatives
   * Capacity (R2A, surge) is reported next to it because it changes how many hours a store can give.
   */
  function severity(summary, health, st, metrics) {
    const h = health || {}, pending = summary.total_absolute_pending, reasons = [];
    const open3 = has(h.open_variance_3m) ? num(h.open_variance_3m) : null, net2 = has(h.net_variance_2m) ? num(h.net_variance_2m) : null;
    let score = 0;
    if (pending >= st.sev_broken_pending) { score += 2; reasons.push('pending ₹ above broken line'); }
    else if (pending >= st.sev_broken_pending / 2) { score += 1; reasons.push('pending ₹ above half the broken line'); }
    if (open3 !== null) {
      if (open3 >= st.sev_broken_open_3m) { score += 2; reasons.push('3-month open variance high'); }
      else if (open3 >= st.sev_broken_open_3m / 2) { score += 1; reasons.push('3-month open variance elevated'); }
    }
    if (net2 !== null && net2 < 0 && open3 !== null && open3 >= st.sev_broken_open_3m / 2) { score += 1; reasons.push('net loss persisting over 2 months'); }
    if (summary.priority_counts.P0 >= st.sev_fresh_negatives) { score += 1; reasons.push(summary.priority_counts.P0 + ' fresh (T-1) negatives'); }
    const inventory = score >= 3 ? 'BROKEN' : score >= 1 ? 'AT_RISK' : 'SORTED';
    let ops = null, capacity = null;
    const m = metrics || null;
    if (m && m.ppi !== null && m.tfr_pct !== null) {
      const pb = m.ppi > st.sev_ppi_target, tb = m.tfr_pct < st.sev_tfr_target;
      ops = pb && tb ? 'SEVERELY_BROKEN' : pb || tb ? 'BROKEN' : 'SORTED';
      if (pb) reasons.push('PPI ' + m.ppi + 's > ' + st.sev_ppi_target + 's');
      if (tb) reasons.push('TFR ' + m.tfr_pct + '% < ' + st.sev_tfr_target + '%');
    }
    if (m && m.r2a_sec !== null && m.surge_pct !== null) {
      const rb = m.r2a_sec > st.sev_r2a_target, sb = m.surge_pct > st.sev_surge_target;
      capacity = rb && sb ? 'CONSTRAINED' : rb || sb ? 'AT_RISK' : 'HEALTHY';
    }
    const tier = ops && TIER_RANK[ops] > TIER_RANK[inventory] ? ops : inventory;
    return {tier, inventory, ops, capacity, metrics: m, score, reasons, pending, open_variance_3m: open3, net_variance_2m: net2};
  }

  /**
   * Decides the recovery level for every variance item: the coarsest broken unit that contains one of its locations.
   * Broken rack = >= rack_sweep_min_items variance items. Broken aisle = >= aisle_sweep_min_racks broken racks.
   * Returns tasks (units of work) in priority order.
   */
  function diagnose(wl, st, locRows) {
    const racks = {}, aisles = {}, master = {};
    // Physical location master + stock-correction evidence (LOCATION_RECOVERY_RAW export), optional.
    (locRows || []).forEach(l => {
      const loc = text(l.location_id);
      if (!loc) return;
      const rk = text(l.rack_id) || rackOf(loc, st), m = master[rk] = master[rk] || {aisle: text(l.aisle_id) || aisleOf(loc, st), size: 0, direct: 0, signal: 0};
      // Parth's V1 targeting: direct target = PPI > ideal + delta or repeated corrections; any signal = PPI > ideal or any correction.
      const measurable = !text(l.current_ppi_signal_status) || text(l.current_ppi_signal_status).toUpperCase() === 'MEASURABLE';
      const ppi = num(l.current_ppi), ideal = num(l.current_ideal_ppi), cd = num(l.correction_days_7d), hasPpi = measurable && has(l.current_ppi) && has(l.current_ideal_ppi);
      m.size++;
      if ((hasPpi && ppi > ideal + st.direct_ppi_delta_sec) || cd >= st.direct_correction_days) m.direct++;
      if ((hasPpi && ppi > ideal) || cd >= st.signal_correction_days) m.signal++;
    });
    const fullRack = m => m.size > 0 && (100 * m.direct / m.size >= st.full_rack_direct_pct || 100 * m.signal / m.size >= st.full_rack_signal_pct);
    const rackRec = (rk, aisle) => racks[rk] = racks[rk] || {rack: rk, aisle: aisle, items: {}, locs: {}};
    Object.keys(master).forEach(rk => { if (fullRack(master[rk])) rackRec(rk, master[rk].aisle); });
    const locsOf = it => it.neg_locations.map(l => ({loc: l, type: 'NEG'}))
      .concat(it.prob_locations.filter(l => it.neg_locations.indexOf(l) < 0).slice(0, st.prob_locations_per_item).map(l => ({loc: l, type: 'PROB'})));
    wl.items.forEach(it => {
      locsOf(it).forEach(x => {
        const rk = rackOf(x.loc, st), r = rackRec(rk, aisleOf(x.loc, st));
        r.items[it.item_id] = it;
        r.locs[x.loc] = true;
      });
    });
    Object.keys(racks).forEach(k => {
      const r = racks[k];
      r.evidence = master[k] && fullRack(master[k]) ? master[k] : null;
      r.broken = Object.keys(r.items).length >= st.rack_sweep_min_items || !!r.evidence;
      const a = aisles[r.aisle] = aisles[r.aisle] || {aisle: r.aisle, racks: [], broken: []};
      a.racks.push(k);
      if (r.broken) a.broken.push(k);
    });
    Object.keys(aisles).forEach(k => { aisles[k].isBroken = aisles[k].broken.length >= st.aisle_sweep_min_racks; });

    const tasks = {};
    const task = (id, level, target, rack, aisle) => tasks[id] = tasks[id] || {task_id: id, level, label: LEVEL[level].label, complex: LEVEL[level].complex,
      target, rack, aisle, items: [], locations: {}, value: 0, best_score: 9};
    wl.items.forEach(it => {
      const locs = locsOf(it);
      let t;
      if (!locs.length) t = task('S:' + it.item_id, 'SEARCH', it.item_name, '', '');
      else {
        const inAisle = locs.find(x => aisles[aisleOf(x.loc, st)] && aisles[aisleOf(x.loc, st)].isBroken);
        const inRack = locs.find(x => racks[rackOf(x.loc, st)].broken);
        if (inAisle) { const rk = rackOf(inAisle.loc, st); t = task('A:' + rk, 'AISLE', rk, rk, aisleOf(inAisle.loc, st)); }
        else if (inRack) { const rk = rackOf(inRack.loc, st); t = task('R:' + rk, 'RACK', rk, rk, aisleOf(inRack.loc, st)); }
        else { const rk = rackOf(locs[0].loc, st); t = task('L:' + rk, 'LOCATION', rk, rk, aisleOf(locs[0].loc, st)); }
        locs.forEach(x => {
          if (!t.complex || rackOf(x.loc, st) === t.rack) t.locations[x.loc] = t.locations[x.loc] === 'NEG' ? 'NEG' : x.type;
        });
      }
      t.items.push({item_id: it.item_id, item_name: it.item_name, upc: it.upc, priority: it.priority, variance: it.variance, variance_qty: it.variance_qty,
        audit_increment_qty: it.audit_increment_qty, source: it.source, locations: locs.map(x => x.loc)});
      t.value += it.variance;
      t.best_score = Math.min(t.best_score, it.priority_score);
    });
    // Unstable racks with no variance item still get a sweep: persistent stock corrections there.
    Object.keys(racks).forEach(k => { const r = racks[k]; if (r.broken && !aisles[r.aisle].isBroken && !Object.keys(r.items).length) task('R:' + k, 'RACK', k, k, r.aisle); });
    // Every rack in a broken aisle is swept, even racks with no variance item of their own.
    Object.keys(aisles).forEach(k => {
      if (!aisles[k].isBroken) return;
      aisles[k].racks.forEach(rk => { task('A:' + rk, 'AISLE', rk, rk, k); });
      const ts = aisles[k].racks.map(rk => tasks['A:' + rk]), best = Math.min.apply(null, ts.map(t => t.best_score));
      ts.forEach(t => { if (t.best_score === 9) t.best_score = best; });   // empty racks of a broken aisle travel with the aisle
    });

    const list = Object.keys(tasks).map(k => {
      const t = tasks[k], nLoc = Object.keys(t.locations).length;
      t.location_list = Object.keys(t.locations).sort((a, b) => (t.locations[a] === 'NEG' ? 0 : 1) - (t.locations[b] === 'NEG' ? 0 : 1) || a.localeCompare(b))
        .map(l => ({location_id: l, type: t.locations[l]}));
      delete t.locations;
      t.items.sort((a, b) => b.variance - a.variance);
      t.item_count = t.items.length;
      t.best_priority = t.best_score >= 5 ? 'EV' : 'P' + t.best_score;
      t.location_count = t.complex ? Math.max(master[t.rack] ? master[t.rack].size : st.locations_per_rack, nLoc) : t.level === 'SEARCH' ? 0 : nLoc;
      if (t.best_score === 9) t.best_score = 5;   // evidence-only racks rank after every variance-led task
      t.est_hours = round(t.level === 'SEARCH' ? gross(st.upc_search_minutes, st) : gross(t.location_count * st.minutes_per_location, st), 2);
      t.reason = reasonFor(t, racks, aisles, st);
      return t;
    });
    const order = {AISLE: 0, RACK: 1, LOCATION: 2, SEARCH: 3};
    list.sort((a, b) => a.best_score - b.best_score || b.value / b.est_hours - a.value / a.est_hours || order[a.level] - order[b.level] || a.task_id.localeCompare(b.task_id));
    list.forEach((t, i) => { t.seq = i + 1; });

    const byLevel = {};
    Object.keys(LEVEL).forEach(l => { byLevel[l] = {level: l, label: LEVEL[l].label, tasks: 0, items: 0, value: 0, hours: 0}; });
    list.forEach(t => { const b = byLevel[t.level]; b.tasks++; b.items += t.item_count; b.value += t.value; b.hours += t.est_hours; });
    const total = list.reduce((v, t) => v + t.value, 0);
    Object.keys(byLevel).forEach(l => { byLevel[l].share_pct = total ? Math.round(100 * byLevel[l].value / total) : 0; byLevel[l].hours = round(byLevel[l].hours, 1); });
    const mode = ['AISLE', 'RACK', 'LOCATION', 'SEARCH'].reduce((m, l) => byLevel[l].value > (m ? byLevel[m].value : -1) ? l : m, null) || 'LOCATION';
    const brokenAisles = Object.keys(aisles).filter(k => aisles[k].isBroken).length;
    const brokenRacks = Object.keys(racks).filter(k => racks[k].broken).length;

    const sources = {};
    wl.items.forEach(it => { const s = sources[it.source] = sources[it.source] || {source: it.source, items: 0, value: 0}; s.items++; s.value += it.variance; });

    return {
      tasks: list, by_level: byLevel, mode: mode === 'SEARCH' ? 'LOCATION' : mode, broken_racks: brokenRacks, broken_aisles: brokenAisles,
      full_recon: brokenAisles >= st.full_recon_min_aisles, total_hours: round(list.reduce((v, t) => v + t.est_hours, 0), 1),
      sources: Object.keys(sources).map(k => sources[k]).sort((a, b) => b.value - a.value)
    };
  }
  function reasonFor(t, racks, aisles, st) {
    if (t.level === 'AISLE') return aisles[t.aisle].broken.length + ' broken racks in aisle ' + t.aisle + '. Reset the whole aisle rack by rack.';
    if (t.level === 'RACK') {
      const r = racks[t.rack], n = Object.keys(r.items).length, parts = [];
      if (n) parts.push(n + ' variance item' + (n === 1 ? '' : 's'));
      if (r.evidence) parts.push(r.evidence.direct + ' of ' + r.evidence.size + ' locations are direct targets (slow picks / repeated corrections)');
      return parts.join(' + ') + ': persistent instability. Sweep every location.';
    }
    if (t.level === 'LOCATION') return t.item_count + ' item' + (t.item_count === 1 ? '' : 's') + ' at known locations. Check NEG locations (audit found it short) first, then probable.';
    return 'No mapped location. Use the Recovery App probable locations to search.';
  }

  // ---------------------------------------------------------------- 2. crew
  /** Ranks captains on efficacy = speed (IAPH vs store median) x accuracy (1 - bad audit %). */
  /**
   * Accepts either an audit-quality feed (captain_name, iaph, qaph, bad_audit_pct, audits_30d) or the
   * EMPLOYEE_CAPACITY_SYNC_RAW export (employee_name, auditor_active_hours_l7, missing/wrong complaint %).
   * Without IAPH the score is a proxy (auditor hours L7 x complaint-free rate) and is labelled as such.
   * complex_approved (Y/N) overrides the metric rule for rack/aisle sweeps.
   */
  function rankCaptains(rows, st, extraNames) {
    const nameOf = r => text(r.captain_name) || text(r.employee_name);
    const live = rows.filter(r => nameOf(r) && text(r.active).toUpperCase() !== 'N');
    const rated = live.filter(r => num(r.audits_30d) >= st.min_audits_for_rating && num(r.iaph) > 0).map(r => num(r.iaph));
    const med = median(rated), medAud = median(live.map(r => num(r.auditor_active_hours_l7)).filter(x => x > 0));
    // Sweep clearance: bad-audit % within the absolute limit, or in the more accurate half of this store's rated captains.
    const medBad = median(live.filter(r => num(r.audits_30d) >= st.min_audits_for_rating && num(r.iaph) > 0 && has(r.bad_audit_pct)).map(r => num(r.bad_audit_pct)));
    const seen = {};
    const out = live.map(r => {
      const name = nameOf(r), isRated = med > 0 && num(r.audits_30d) >= st.min_audits_for_rating && num(r.iaph) > 0;
      let speed = 1, acc, basis;
      const bad = has(r.bad_audit_pct) ? num(r.bad_audit_pct) : null;
      if (isRated) { speed = Math.min(1.6, Math.max(0.6, num(r.iaph) / med)); acc = bad === null ? 0.9 : Math.max(0, 1 - bad / 100); basis = 'IAPH + bad audit %'; }
      else {
        const complaints = num(r.missing_complaint_pct_l7) + num(r.wrong_item_complaint_pct_l7);
        acc = Math.max(0, 1 - complaints / 100) * 0.9;
        speed = medAud > 0 ? Math.min(1.3, Math.max(0.7, Math.sqrt(num(r.auditor_active_hours_l7) / medAud) || 0.7)) : 1;
        basis = medAud > 0 ? 'proxy: auditor hours L7' : 'no audit data';
      }
      const approved = text(r.complex_approved).toUpperCase();
      const presence = text(r.recent_presence_status).toUpperCase();
      seen[name.toLowerCase()] = true;
      return {name, captain_id: text(r.captain_id) || text(r.employee_id), designation: text(r.designation), iaph: num(r.iaph), qaph: num(r.qaph), bad_audit_pct: bad,
        audits_30d: num(r.audits_30d), auditor_hours_l7: num(r.auditor_active_hours_l7), rated: isRated, basis, speed: round(speed, 2), score: Math.round(100 * speed * acc),
        present_t1: presence ? presence.indexOf('NOT T-1') < 0 && presence.indexOf('INACTIVE') < 0 : true,
        complex_ready: approved === 'Y' || approved === 'TRUE' ? true : approved === 'N' || approved === 'FALSE' ? false
          : isRated && bad !== null && (bad <= st.complex_max_bad_pct || (medBad !== null && bad <= medBad))};
    });
    (extraNames || []).forEach(n => {
      if (text(n) && !seen[text(n).toLowerCase()]) { seen[text(n).toLowerCase()] = true; out.push({name: text(n), rated: false, basis: 'not in roster', speed: 1, score: 0, present_t1: true, complex_ready: false}); }
    });
    // Present first, then audit-evidence ratings above proxy scores (they are not on the same scale), then score.
    out.sort((a, b) => (b.present_t1 ? 1 : 0) - (a.present_t1 ? 1 : 0) || (b.rated ? 1 : 0) - (a.rated ? 1 : 0) || b.score - a.score || a.name.localeCompare(b.name));
    let i = 0;
    const ratedN = out.filter(c => c.rated).length;
    out.forEach(c => {
      if (!c.rated) { c.tier = c.score ? 'PROXY' : 'NEW'; return; }
      c.tier = i < Math.ceil(ratedN / 3) ? 'A' : i < Math.ceil(2 * ratedN / 3) ? 'B' : 'C'; i++;
    });
    return out;
  }

  /**
   * Captain efficacy from AUDIT_EXECUTION_RAW sessions: IAPH = distinct SKUs / hour, QAPH = found qty / hour,
   * bad audit % = sessions BELOW_PROVISIONAL_SOP. Joined to the roster on employee_id = auditor_id.
   */
  function auditMetrics(auditRows, outletId, today, st) {
    const from = addDays(today, -st.audit_lookback_days), by = {};
    auditRows.forEach(a => {
      if (text(a.outlet_id) !== text(outletId) || text(a.session_status).toUpperCase() !== 'COMPLETED') return;
      const d = day(a.audit_date_ist);
      if (!d || d < from || d >= today) return;
      const id = text(a.auditor_id), sec = num(a.session_elapsed_seconds);
      if (!id || sec <= 0 || sec > 4 * 3600) return;
      const m = by[id] = by[id] || {sessions: 0, sec: 0, skus: 0, qty: 0, bad: 0, judged: 0};
      m.sessions++; m.sec += sec; m.skus += num(a.distinct_skus); m.qty += num(a.found_qty);
      const q = text(a.quality_status).toUpperCase();
      if (q) { m.judged++; if (q.indexOf('BELOW') === 0) m.bad++; }
    });
    const out = {};
    Object.keys(by).forEach(id => {
      const m = by[id], h = m.sec / 3600;
      out[id] = {iaph: round(m.skus / h, 1), qaph: round(m.qty / h, 1), bad_audit_pct: m.judged ? round(100 * m.bad / m.judged, 1) : '', audits_30d: m.sessions};
    });
    return out;
  }
  /** Roster rows (employee capacity export) enriched with audit metrics where the employee has sessions. */
  function withAuditMetrics(rosterRows, metrics) {
    return rosterRows.map(r => {
      const m = metrics[text(r.employee_id) || text(r.captain_id)];
      return m && !has(r.iaph) ? Object.assign({}, r, m) : r;
    });
  }

  /**
   * System-observed execution: audit sessions on the plan date at planned locations / racks.
   * This is what lets a CM check actual work without relying on the SM's own log.
   */
  function observed(tasks, auditRows, plan, st) {
    // Every audit session on the plan date is classified (V2/V3 rules):
    //   BASELINE = finished before the plan was confirmed (routine counts never count as recovery)
    //   MATCHED = planned location, coverage at or above the quality gate; QUALITY_GAP = planned but coverage below it
    //   OFF_PLAN = after confirmation at a location the plan did not include
    const d = text(plan.plan_date), conf = toMs(plan.confirmed_at), locTask = {}, rackTask = {}, perTask = {}, byAuditor = {}, counts = {MATCHED: 0, QUALITY_GAP: 0, OFF_PLAN: 0, BASELINE: 0};
    tasks.forEach(t => {
      perTask[t.task_id] = {audited: 0, planned: t.location_count};
      if (t.complex) rackTask[t.rack] = t.task_id;
      else (t.location_list || []).forEach(l => { locTask[l.location_id] = t.task_id; });
    });
    const matched = {}, events = [];
    auditRows.forEach(a => {
      if (text(a.outlet_id) !== text(plan.outlet_id) || day(a.audit_date_ist) !== d) return;
      const loc = text(a.location_id), tid = locTask[loc] || rackTask[text(a.rack_id) || rackOf(loc, st)], end = toMs(a.end_time);
      const cov = has(a.expected_sku_coverage_pct) ? num(a.expected_sku_coverage_pct) : null, q = text(a.quality_status).toUpperCase();
      let cls;
      if (conf !== null && end !== null && end <= conf) cls = 'BASELINE';
      else if (!tid) cls = 'OFF_PLAN';
      else if (cov !== null ? cov < st.audit_min_coverage_pct : q.indexOf('BELOW') === 0) cls = 'QUALITY_GAP';
      else cls = 'MATCHED';
      counts[cls]++;
      const id = text(a.auditor_id);
      if (cls !== 'BASELINE') byAuditor[id] = round((byAuditor[id] || 0) + num(a.session_elapsed_seconds) / 3600, 2);
      if (cls === 'MATCHED' && !matched[loc]) { matched[loc] = true; perTask[tid].audited++; }
      if (events.length < 300) events.push({location_id: loc, task_id: tid || '', auditor_id: id, end_time: text(a.end_time), coverage_pct: cov, class: cls});
    });
    const planned = tasks.reduce((v, t) => v + t.location_count, 0), audited = Object.keys(matched).length;
    events.sort((a, b) => text(b.end_time).localeCompare(text(a.end_time)));
    return {sessions: counts.MATCHED + counts.QUALITY_GAP + counts.OFF_PLAN, counts, events, locations_audited: audited, locations_planned: planned,
      pct: planned ? Math.round(100 * Math.min(audited, planned) / planned) : null, per_task: perTask, hours_by_auditor: byAuditor,
      hours: round(Object.keys(byAuditor).reduce((v, k) => v + byAuditor[k], 0), 2)};
  }

  // ---------------------------------------------------------------- 3. allocate
  /**
   * Greedy fill in task priority order. Complex tasks (rack/aisle) go to the highest-score complex-ready captain;
   * item tasks go to the fastest. A task can be split between captains. Captain hours = task hours / captain speed.
   */
  function allocate(tasks, crewIn, roster, skip) {
    const byName = {};
    roster.forEach(c => { byName[c.name.toLowerCase()] = c; });
    const crew = crewIn.filter(c => text(c.name) && num(c.hours) > 0).map(c => {
      const r = byName[text(c.name).toLowerCase()] || {speed: 1, score: 0, complex_ready: false};
      return {name: text(c.name), hours: num(c.hours), left: num(c.hours), speed: r.speed || 1, score: r.score || 0, complex_ready: !!r.complex_ready};
    });
    const anyComplex = crew.some(c => c.complex_ready), skipSet = {};
    (skip || []).forEach(id => { skipSet[id] = true; });
    const lines = [], deferred = [];
    tasks.forEach(t => {
      if (skipSet[t.task_id]) { deferred.push({task_id: t.task_id, reason: 'SKIPPED_BY_SM'}); return; }
      let need = t.est_hours, covered = 0;
      while (need > 0.01) {
        const pool = crew.filter(c => c.left > 0.05 && (!t.complex || c.complex_ready || !anyComplex));
        if (!pool.length) break;
        pool.sort(t.complex ? (a, b) => b.score - a.score || b.left - a.left : (a, b) => b.speed - a.speed || b.left - a.left);
        const c = pool[0], give = Math.min(c.left, need / c.speed);
        c.left -= give;
        need -= give * c.speed;
        covered += give * c.speed;
        lines.push({task_id: t.task_id, captain: c.name, hours: round(give, 2), share: round(give * c.speed / t.est_hours, 2)});
      }
      if (covered < 0.01) deferred.push({task_id: t.task_id, reason: 'NO_HOURS_LEFT'});
    });
    const taskById = {};
    tasks.forEach(t => { taskById[t.task_id] = t; });
    const planned = {};
    lines.forEach(l => { planned[l.task_id] = (planned[l.task_id] || 0) + l.share; });
    return {
      lines, deferred,
      crew: crew.map(c => ({name: c.name, hours: c.hours, used: round(c.hours - c.left, 2)})),
      hours: round(crew.reduce((v, c) => v + c.hours, 0), 2),
      used_hours: round(crew.reduce((v, c) => v + c.hours - c.left, 0), 2),
      tasks_covered: Object.keys(planned).length,
      locations: Math.round(Object.keys(planned).reduce((v, k) => v + taskById[k].location_count * Math.min(1, planned[k]), 0)),
      value: Math.round(Object.keys(planned).reduce((v, k) => v + taskById[k].value * Math.min(1, planned[k]), 0)),
      complex_without_ready: tasks.some(t => t.complex && !skipSet[t.task_id]) && !anyComplex && crew.length > 0
    };
  }

  /** Engine suggestion: budget = hours to clear the work (capped), crew = best captains first. */
  function suggest(diag, roster, st) {
    const budget = Math.min(st.max_budget_hours, Math.ceil(diag.total_hours * 2) / 2);
    const crew = [];
    let left = budget;
    roster.forEach(c => {
      if (left <= 0 || !c.name || !c.present_t1 || (c.rated && c.bad_audit_pct !== null && c.bad_audit_pct > st.suggest_max_bad_pct)) return;
      const h = Math.min(st.max_hours_per_captain, Math.ceil(left * 2) / 2);
      crew.push({name: c.name, hours: h});
      left -= h;
    });
    return {budget_hours: budget, crew, plan: allocate(diag.tasks, crew, roster, [])};
  }

  // ---------------------------------------------------------------- 4. measure
  /** Latest actual row per captain wins. */
  function latestActuals(actuals, planId) {
    const by = {};
    actuals.filter(a => text(a.plan_id) === text(planId)).forEach(a => {
      const k = text(a.captain).toLowerCase();
      if (!by[k] || text(a.logged_at) >= text(by[k].logged_at)) by[k] = a;
    });
    return Object.keys(by).map(k => {
      let tasks = {};
      try { tasks = JSON.parse(text(by[k].tasks_json) || '{}'); } catch (e) { tasks = {}; }
      return {captain: text(by[k].captain), actual_hours: num(by[k].actual_hours), tasks, note: text(by[k].note), logged_at: text(by[k].logged_at), logged_by: text(by[k].logged_by)};
    });
  }

  /** Feed-verified recovery for the items of a plan (ported from IRD V0.6, which got this part right). */
  function verify(plan, items, feedRows) {
    const feed = {};
    feedRows.forEach(r => { if (text(r.outlet_id) === text(plan.outlet_id)) feed[text(r.item_id)] = r; });
    const since = text(plan.plan_date);
    let recovered = 0, reduced = 0, base = 0, leftFeed = 0;
    const out = items.map(l => {
      const f = feed[text(l.item_id)], b = num(l.baseline_variance);
      base += b;
      let status, cur = f ? num(f.variance) : null;
      const newMonth = f && text(f.month_start_date) && day(f.month_start_date).slice(0, 7) > since.slice(0, 7);
      if (!f) status = 'NOT_IN_FEED';
      else if (newMonth) status = 'NEW_MONTH';   // month-to-date feed reset: a drop here is not recovery
      else if (num(f.audit_increment_qty) > num(l.baseline_increment_qty) && parseArrayCell(f.audit_increment_dates).some(d => day(d) >= since)) status = 'FOUND';
      else if (cur <= 0) status = 'CLEARED';
      else if (cur < b - 0.5) status = 'REDUCED';   // lean feed has no audit increments: a lower open variance is the evidence
      else status = 'OPEN';
      if (status === 'CLEARED' || status === 'REDUCED') { recovered++; reduced += Math.max(0, b - Math.max(cur || 0, 0)); }
      if (status === 'NOT_IN_FEED') leftFeed += b;
      if (status === 'FOUND') {
        // Value of the units found = increment since plan x baseline unit value, capped at the baseline variance.
        const bq = num(l.baseline_variance_qty), unit = bq > 0 ? b / bq : 0, found = num(f.audit_increment_qty) - num(l.baseline_increment_qty);
        recovered++; reduced += Math.min(b, Math.max(found * unit, b - Math.max(cur, 0)));
      }
      return {item_id: text(l.item_id), item_name: text(l.item_name), task_id: text(l.task_id), priority: text(l.priority), baseline_variance: b, current_variance: cur, status};
    });
    // Items that dropped out of the ranked feed are shown separately: likely cleared, but not proven, so never counted.
    return {items: out, planned_items: out.length, recovered_items: recovered, baseline_value: Math.round(base), recovered_value: Math.round(reduced), left_feed_value: Math.round(leftFeed)};
  }

  function snapAt(snaps, outlet, d, exact) {
    let best = null;
    snaps.forEach(s => {
      if (text(s.outlet_id) !== text(outlet)) return;
      const sd = day(s.snapshot_date);
      if (sd <= d && (!best || sd > day(best.snapshot_date))) best = s;
    });
    return best && (!exact || day(best.snapshot_date) === d) ? best : null;
  }
  function storeOutcome(plan, snaps, st, today) {
    const D = text(plan.plan_date), b = snapAt(snaps, plan.outlet_id, D, false);
    const at = off => {
      const d = addDays(D, off), s = snapAt(snaps, plan.outlet_id, d, true);
      if (!s) return {date: d, state: today < d ? 'PENDING' : 'NO_DATA', value: null};
      const v = num(s.total_absolute_pending);
      if (!b) return {date: d, state: 'NO_BASELINE', value: v};
      const bv = num(b.total_absolute_pending);
      return {date: d, value: v, change_pct: bv ? round(100 * (v - bv) / bv, 1) : null, state: v < bv ? 'BETTER' : v > bv ? 'WORSE' : 'FLAT'};
    };
    const t3 = at(st.t3_offset), t7 = at(st.t7_offset);
    const overall = t3.state === 'BETTER' && t7.state === 'BETTER' ? 'SUSTAINED' : t3.state === 'BETTER' && t7.state === 'WORSE' ? 'RELAPSED' : t7.state !== 'PENDING' && t7.state !== 'NO_DATA' ? t7.state : t3.state;
    return {baseline: b ? {date: day(b.snapshot_date), value: num(b.total_absolute_pending)} : null, t3, t7, overall};
  }

  /** Suggested vs Planned vs Actual for one plan. */
  function measure(plan, planTasks, planItems, actuals, feedRows, snaps, st, today, auditRows) {
    const S = planTasks.filter(l => text(l.kind) === 'S'), P = planTasks.filter(l => text(l.kind) === 'P');
    const act = latestActuals(actuals, plan.plan_id);
    const taskIds = {};
    P.forEach(l => { taskIds[text(l.task_id)] = true; });
    const statusScore = {DONE: 1, PARTIAL: 0.5, NOT_DONE: 0};
    let done = 0;
    Object.keys(taskIds).forEach(id => {
      let best = 0;
      act.forEach(a => { if (a.tasks[id] !== undefined) best = Math.max(best, statusScore[a.tasks[id]] || 0); });
      done += best;
    });
    const sCrew = {}, pCrew = {};
    S.forEach(l => { sCrew[text(l.captain).toLowerCase()] = true; });
    P.forEach(l => { pCrew[text(l.captain).toLowerCase()] = true; });
    const overlap = Object.keys(pCrew).filter(k => sCrew[k]).length;
    const sumH = arr => round(arr.reduce((v, l) => v + num(l.hours), 0), 2);
    const v = verify(plan, planItems, feedRows);
    const actualHours = round(act.reduce((x, a) => x + a.actual_hours, 0), 2), plannedHours = sumH(P);
    const pct = (a, b) => b ? Math.round(100 * a / b) : null;
    return {
      plan_id: text(plan.plan_id), plan_date: text(plan.plan_date),
      suggested: {hours: sumH(S), captains: Object.keys(sCrew).length, tasks: new Set(S.map(l => text(l.task_id))).size},
      planned: {hours: plannedHours, captains: Object.keys(pCrew).length, tasks: Object.keys(taskIds).length},
      actual: {hours: actualHours, captains: act.length, tasks_done: round(done, 1), logged: act.length > 0, rows: act},
      adherence: {
        plan_vs_suggested_hours_pct: pct(plannedHours, sumH(S)),
        crew_overlap_pct: pct(overlap, Object.keys(sCrew).length),
        actual_vs_planned_hours_pct: pct(actualHours, plannedHours),
        tasks_done_pct: pct(done, Object.keys(taskIds).length)
      },
      recovery: v,
      rupees_per_hour: actualHours > 0 ? Math.round(v.recovered_value / actualHours) : null,
      outcome: storeOutcome(plan, snaps, st, today),
      observed: auditRows && auditRows.length ? observed(P.filter(l => text(l.detail_json)).map(l => JSON.parse(l.detail_json)), auditRows, plan, st) : null,
      changes: text(plan.changes_vs_suggested)
    };
  }

  /** CM flag for one store. Lower severity number = more urgent. */
  function flag(plan, m, today, st) {
    if (!plan) return {code: 'NO_PLAN', sev: 2, text: 'No recovery plan confirmed recently.'};
    const past = text(plan.plan_date) < today;
    if (past && !m.actual.logged) return {code: 'NO_ACTUALS', sev: 1, text: 'Shift not closed: no actual hours logged for ' + plan.plan_date + '.'};
    if (m.observed && past && m.observed.pct !== null && m.observed.pct < st.low_adherence_pct)
      return {code: 'LOW_EXECUTION', sev: 1, text: 'Audit data shows only ' + m.observed.pct + '% of planned locations audited on ' + plan.plan_date + '.'};
    if (m.actual.logged && m.adherence.actual_vs_planned_hours_pct !== null && m.adherence.actual_vs_planned_hours_pct < st.low_adherence_pct)
      return {code: 'LOW_ADHERENCE', sev: 1, text: 'Only ' + m.adherence.actual_vs_planned_hours_pct + '% of planned hours were worked.'};
    if (m.outcome.overall === 'RELAPSED' || m.outcome.overall === 'WORSE') return {code: m.outcome.overall, sev: 1, text: 'Store variance is ' + m.outcome.overall.toLowerCase() + ' after recovery.'};
    if (m.actual.logged && m.recovery.recovered_items === 0 && past) return {code: 'NO_YIELD', sev: 2, text: 'Hours were spent but the feed shows no item recovered yet.'};
    if (!past) return {code: 'IN_PROGRESS', sev: 3, text: 'Plan for today is running.'};
    return {code: 'ON_TRACK', sev: 4, text: 'Plan executed. Watch T+' + st.t3_offset + ' / T+' + st.t7_offset + '.'};
  }

  /** Nudge that compares a store's ₹ per hour with its region (Rahul's ask in the call). */
  function nudge(storeRph, regionRph, mode) {
    if (storeRph === null || regionRph === null || !regionRph) return '';
    if (storeRph >= regionRph) return 'Your ₹ recovered per hour is at or above the region median. Keep the same crew pattern.';
    const tip = mode === 'LOCATION' ? 'Put your top-score captain on NEG locations first.' : 'Give rack/aisle sweeps only to your lowest bad-audit captains.';
    return 'Your ₹ recovered per hour is ' + Math.round(100 - 100 * storeRph / regionRph) + '% below the region median. ' + tip;
  }

  function stableHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /** What the SM changed versus the suggestion. Recorded automatically; the SM is never asked to justify it. */
  function planDiff(sugg, mine) {
    const hrs = p => { const o = {}; p.crew.forEach(c => { o[c.name] = c.hours; }); return o; };
    const a = hrs(sugg), b = hrs(mine), out = [];
    Object.keys(b).forEach(n => { if (a[n] === undefined) out.push('+' + n); else if (a[n] !== b[n]) out.push(n + ' ' + a[n] + '→' + b[n] + 'h'); });
    Object.keys(a).forEach(n => { if (b[n] === undefined) out.push('−' + n); });
    const ta = {}, tb = {};
    sugg.lines.forEach(l => { ta[l.task_id] = true; });
    mine.lines.forEach(l => { tb[l.task_id] = true; });
    const dropped = Object.keys(ta).filter(k => !tb[k]).length, added = Object.keys(tb).filter(k => !ta[k]).length;
    if (dropped) out.push(dropped + ' suggested task' + (dropped === 1 ? '' : 's') + ' not planned');
    if (added) out.push(added + ' extra task' + (added === 1 ? '' : 's'));
    return out.join(', ');
  }

  /**
   * Print model: one page per captain, only what is needed to execute. Rendered as a Google Sheet (one tab per captain)
   * on the server and as printable HTML in the browser.
   */
  function printPages(plan, tasks, lines, sops, storeName) {
    const byId = {};
    tasks.forEach(t => { byId[t.task_id] = t; });
    const caps = [];
    lines.forEach(l => { if (caps.indexOf(l.captain) < 0) caps.push(l.captain); });
    return caps.map(c => {
      const mine = lines.filter(l => l.captain === c);
      const rows = [];
      mine.forEach((l, i) => {
        const t = byId[l.task_id];
        if (!t) return;
        const where = t.level === 'LOCATION' ? t.location_list.map(x => x.location_id + (x.type === 'NEG' ? ' (first)' : '')).join(', ')
          : t.level === 'SEARCH' ? 'Search (see Recovery App)' : 'Whole rack ' + t.rack + (l.share < 0.99 ? ' (about ' + Math.round(l.share * 100) + '%, split with a colleague)' : '');
        const items = t.items.slice(0, t.complex ? 10 : 15);
        rows.push({no: i + 1, task: t.label, target: t.level === 'SEARCH' ? t.target : t.target, where, hours: round(l.hours, 2), items: items.map(x => ({name: x.item_name, qty: x.variance_qty, upc: t.level === 'SEARCH' ? x.upc : ''})),
          more_items: Math.max(0, t.items.length - items.length), level: t.level});
      });
      const levels = rows.map(r => r.level).filter((v, i, a) => a.indexOf(v) === i);
      return {captain: c, store: storeName, date: text(plan.plan_date), window: text(plan.window), plan_id: text(plan.plan_id), hours: round(mine.reduce((v, l) => v + l.hours, 0), 2),
        locations: Math.round(mine.reduce((v, l) => v + (byId[l.task_id] ? byId[l.task_id].location_count * Math.min(1, l.share) : 0), 0)),
        rows, how: levels.map(lv => ({level: lv, label: LEVEL[lv].label, steps: sops[lv] || []}))};
    });
  }

  return {BUILD, SETTINGS, DEFAULTS, LEVEL, resolveSettings, role, access, isPilot, toMs, fmt, day, addDays, freshness, parseArrayCell, negativePriority,
    recoveryStatus, rackOf, aisleOf, worklist, severity, diagnose, rankCaptains, auditMetrics, withAuditMetrics, observed, allocate, suggest, latestActuals, verify, storeOutcome,
    measure, flag, nudge, median, stableHash, storeMetrics, varianceHistory, planDiff, printPages, TIER_RANK};
}
var REC = RE_CORE_FACTORY();


/**
 * Recovery Engine v2 | Service (orchestration)
 * Talks only to a `repo` object, never to SpreadsheetApp directly, so the same code runs on the
 * real sheet (Code.gs), in Node tests and in the browser preview (in-memory repo).
 *
 * repo contract:
 *   me() today() now() raw() storeMaster() health() storeMetrics() captains() locations() audits() sops() users()
 *   exportSheet(title, pages, folderId) -> {url, pdf_url}
 *   rows(tab) append(tab, objs) getProp(key) setProp(key, value) settingsRows() saveSettings(changes) once(token) lock(fn)
 */
function RE_SERVICE_FACTORY(REC) {
  'use strict';
  const H = {
    PLANS: ['plan_id', 'version', 'status', 'outlet_id', 'outlet_name', 'plan_date', 'window', 'confirmed_at', 'confirmed_by', 'feed_date',
      'suggested_hours', 'planned_hours', 'changes_vs_suggested', 'supersedes', 'baseline_pending', 'severity', 'mode', 'build'],
    PLAN_TASKS: ['plan_id', 'kind', 'task_id', 'level', 'target', 'captain', 'hours', 'share', 'est_hours', 'locations', 'items', 'value', 'detail_json'],
    PLAN_ITEMS: ['plan_id', 'item_id', 'item_name', 'task_id', 'priority', 'baseline_variance', 'baseline_variance_qty', 'baseline_increment_qty'],
    ACTUALS: ['plan_id', 'outlet_id', 'captain', 'actual_hours', 'tasks_json', 'note', 'logged_by', 'logged_at'],
    CM_REVIEWS: ['reviewed_at', 'reviewed_by', 'outlet_id', 'plan_id', 'flag', 'decision', 'owner', 'next_review', 'note'],
    ACTION_LOG: ['at', 'by', 'role', 'action', 'outlet_id', 'plan_id', 'detail'],
    DAILY: ['snapshot_date', 'outlet_id', 'total_absolute_pending', 'worklist_value', 'worklist_skus', 'p0', 'severity', 'mode', 'feed_date']
  };
  const text = x => (x === null || x === undefined) ? '' : String(x).trim();
  const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
  const fail = m => { throw new Error('RE: ' + m); };

  function ctx(repo, system) {
    const r = REC.resolveSettings(repo.settingsRows());
    if (system) return {repo, st: r.settings, errors: r.errors, me: 'system', role: 'PM', outlets: null, today: repo.today()};
    const me = repo.me(), a = REC.access(r.settings, me, repo.users());
    return {repo, st: r.settings, errors: r.errors, me, role: a.role, outlets: a.outlets, today: repo.today()};
  }
  const need = (c, roles) => { if (roles.indexOf(c.role) < 0) fail('This needs role ' + roles.join('/') + '. You are ' + c.role + '.'); };
  const canSee = (c, id) => { if (c.outlets && c.outlets.indexOf(text(id)) < 0) fail('You do not have access to outlet ' + id + '.'); };
  /** Every write is also logged to ACTION_LOG so the sheet shows who did what, when. */
  function log(c, action, outletId, planId, detail) {
    c.repo.append('ACTION_LOG', [{at: c.repo.now(), by: c.me, role: c.role, action, outlet_id: text(outletId), plan_id: text(planId), detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {})}]);
  }
  /** Double-tap / network-retry guard: the same client token is only applied once. */
  const firstTime = (repo, token) => !text(token) || repo.once(text(token));

  function sopMap(repo) {
    const m = {};
    repo.sops().slice().sort((a, b) => num(a.step_no) - num(b.step_no)).forEach(s => { const k = text(s.level).toUpperCase(); (m[k] = m[k] || []).push(text(s.step)); });
    return m;
  }
  function healthOf(repo, id) {
    const h = repo.health().find(x => text(x.outlet_id) === text(id)) || {}, out = Object.assign({}, h, {cohort: text(h.cohort) || text(h.cohort_role)});
    // Open / net variance come from the daily store table when the health row does not carry them.
    if (!text(h.open_variance_3m) && repo.storeVariance) {
      const v = REC.varianceHistory(repo.storeVariance(), id, repo.today(), REC.resolveSettings(repo.settingsRows()).settings);
      if (v) Object.assign(out, v);
    }
    return out;
  }
  /** The employee export has one row per snapshot_date; keep the latest row per employee. */
  function latestRoster(rows) {
    const by = {};
    rows.forEach(r => { const k = text(r.employee_id) || text(r.captain_id) || text(r.captain_name) || text(r.employee_name); if (!by[k] || text(r.snapshot_date) >= text(by[k].snapshot_date)) by[k] = r; });
    return Object.keys(by).map(k => by[k]).filter(r => !text(r.designation) || /captain|auditor|associate/i.test(text(r.designation)));
  }
  function regionOf(repo, id, master) {
    const h = healthOf(repo, id), m = master[text(id)] || {};
    return text(h.region) || m.region || m.cluster || m.city || 'Unassigned';
  }

  /** Current plan per outlet: latest confirmed version that nothing supersedes. */
  function currentPlans(plans) {
    const sup = {}, cur = {};
    plans.forEach(p => { if (text(p.supersedes)) sup[text(p.supersedes)] = true; });
    plans.forEach(p => {
      if (sup[text(p.plan_id)] || text(p.status) !== 'CONFIRMED') return;
      const o = text(p.outlet_id);
      if (!cur[o] || text(p.confirmed_at) >= text(cur[o].confirmed_at)) cur[o] = p;
    });
    return cur;
  }
  function livePlans(plans) { const sup = {}; plans.forEach(p => { if (text(p.supersedes)) sup[text(p.supersedes)] = true; }); return plans.filter(p => !sup[text(p.plan_id)]); }

  function analyse(c, outletId, raw) {
    const wl = REC.worklist(raw, outletId, c.st), diag = REC.diagnose(wl, c.st, c.repo.locations().filter(l => text(l.outlet_id) === text(outletId)));
    const sev = REC.severity(wl.summary, healthOf(c.repo, outletId), c.st, REC.storeMetrics(c.repo.storeMetrics(), outletId, c.st));
    const plans = c.repo.rows('PLANS').filter(p => text(p.outlet_id) === text(outletId));
    const lastCrew = [];
    const cur = currentPlans(plans)[text(outletId)];
    if (cur) c.repo.rows('PLAN_TASKS').forEach(l => { if (l.plan_id === cur.plan_id && l.kind === 'P' && lastCrew.indexOf(text(l.captain)) < 0) lastCrew.push(text(l.captain)); });
    const metrics = REC.auditMetrics(c.repo.audits(), outletId, c.today, c.st);
    const roster = REC.rankCaptains(REC.withAuditMetrics(latestRoster(c.repo.captains().filter(x => text(x.outlet_id) === text(outletId))), metrics), c.st, lastCrew);
    return {wl, diag, sev, roster, suggestion: REC.suggest(diag, roster, c.st), plans, cur};
  }

  function measureFor(c, plan, raw) {
    const tasks = c.repo.rows('PLAN_TASKS').filter(l => l.plan_id === plan.plan_id);
    const items = c.repo.rows('PLAN_ITEMS').filter(l => l.plan_id === plan.plan_id);
    return REC.measure(plan, tasks, items, c.repo.rows('ACTUALS'), raw, c.repo.rows('DAILY'), c.st, c.today, c.repo.audits());
  }

  /** Frozen planned tasks (as confirmed) for the execute view. */
  function frozenPlan(c, plan) {
    const rows = c.repo.rows('PLAN_TASKS').filter(l => l.plan_id === plan.plan_id && l.kind === 'P');
    const tasks = [], seen = {};
    rows.forEach(l => { if (!seen[l.task_id] && text(l.detail_json)) { seen[l.task_id] = true; tasks.push(JSON.parse(l.detail_json)); } });
    return {tasks, lines: rows.map(l => ({task_id: text(l.task_id), captain: text(l.captain), hours: num(l.hours), share: num(l.share)}))};
  }

  // ------------------------------------------------------------------ boot
  function boot(repo, cIn) {
    const c = cIn || ctx(repo), master = repo.storeMaster();
    let ids = text(c.st.pilot_outlets) ? text(c.st.pilot_outlets).split(',') : null;
    if (!ids) { const s = {}; repo.raw().forEach(r => { if (text(r.outlet_id)) s[text(r.outlet_id)] = true; }); ids = Object.keys(s).sort(); }
    if (c.outlets) ids = ids.filter(id => c.outlets.indexOf(id) >= 0);
    return {
      build: REC.BUILD, me: c.me, role: c.role, today: c.today, settings_errors: c.errors,
      settings: {recovery_app_url: c.st.recovery_app_url, max_hours_per_captain: c.st.max_hours_per_captain, t3_offset: c.st.t3_offset, t7_offset: c.st.t7_offset},
      stores: ids.map(id => ({outlet_id: id, outlet_name: (master[id] || {}).outlet_name || id, region: regionOf(repo, id, master)}))
    };
  }

  // ------------------------------------------------------------------ SM store view
  function store(repo, outletId) {
    const c = ctx(repo);
    canSee(c, outletId);
    const raw = repo.raw(), master = repo.storeMaster(), m = master[text(outletId)] || {}, h = healthOf(repo, outletId);
    const a = analyse(c, outletId, raw);
    snapshot(c, [{id: outletId, wl: a.wl, sev: a.sev, diag: a.diag}]);
    const history = livePlans(a.plans).filter(p => text(p.status) === 'CONFIRMED').slice(-6).reverse().map(p => measureFor(c, p, raw));
    let todayPlan = null;
    if (a.cur && text(a.cur.plan_date) === c.today) {
      const fp = frozenPlan(c, a.cur);
      todayPlan = {plan: a.cur, tasks: fp.tasks, lines: fp.lines, measure: history.find(x => x.plan_id === a.cur.plan_id) || measureFor(c, a.cur, raw)};
    }
    let regional = {};
    try { regional = JSON.parse(repo.getProp('REGION_RPH') || '{}'); } catch (e) { regional = {}; }
    const region = regionOf(repo, outletId, master), last = history.find(x => x.actual.logged);
    return {
      store: {outlet_id: text(outletId), outlet_name: m.outlet_name || text(outletId), city: m.city || '', region, cm_sm: m.cm_sm || '', cohort: text(h.cohort), low_order_window: text(h.low_order_window) || text(m.low_order_window)},
      freshness: REC.freshness(a.wl.summary.feed_date, c.today, c.st), summary: a.wl.summary, severity: a.sev, diagnosis: a.diag,
      roster: a.roster, suggestion: {budget_hours: a.suggestion.budget_hours, crew: a.suggestion.crew}, sops: sopMap(repo),
      settings: c.st, today_plan: todayPlan, history,
      nudge: last ? REC.nudge(last.rupees_per_hour, regional[region] === undefined ? null : regional[region], a.diag.mode) : ''
    };
  }

  // ------------------------------------------------------------------ confirm
  /** req: {outlet_id, feed_date, crew:[{name,hours}], skip:[task_id], window, token}. The SM is never asked why; changes vs the suggestion are recorded automatically. */
  function confirm(repo, req) {
    const c = ctx(repo), id = text(req.outlet_id);
    canSee(c, id);
    if (!firstTime(repo, req.token)) return {plan_id: '', duplicate: true, view: store(repo, id)};
    const raw = repo.raw(), a = analyse(c, id, raw);
    if (text(req.feed_date) !== a.wl.summary.feed_date) fail('The variance feed refreshed since you opened the plan. Reload and check again.');
    const crew = (req.crew || []).filter(x => text(x.name) && num(x.hours) > 0);
    if (!crew.length) fail('Add at least one captain with hours.');
    const names = {};
    crew.forEach(x => {
      const k = text(x.name).toLowerCase();
      if (names[k]) fail('Captain ' + x.name + ' is listed twice.');
      names[k] = true;
      if (num(x.hours) > c.st.max_hours_per_captain) fail(x.name + ': max ' + c.st.max_hours_per_captain + ' h per captain.');
    });
    const planned = REC.allocate(a.diag.tasks, crew, a.roster, req.skip || []);
    if (!planned.lines.length) fail('Nothing would be planned. Add hours or un-skip tasks.');
    const sugg = a.suggestion.plan, changes = REC.planDiff(sugg, planned);
    const out = repo.lock(() => {
      const plans = repo.rows('PLANS').filter(p => text(p.outlet_id) === id);
      const sameDay = plans.filter(p => text(p.plan_date) === c.today);
      const prior = currentPlans(sameDay)[id];
      const v = sameDay.length + 1, planId = 'P-' + id + '-' + c.today.replace(/-/g, '') + '-V' + v;
      const m = repo.storeMaster()[id] || {};
      repo.append('PLANS', [{plan_id: planId, version: v, status: 'CONFIRMED', outlet_id: id, outlet_name: m.outlet_name || id, plan_date: c.today,
        window: text(req.window), confirmed_at: repo.now(), confirmed_by: c.me, feed_date: a.wl.summary.feed_date,
        suggested_hours: sugg.used_hours, planned_hours: planned.used_hours, changes_vs_suggested: changes,
        supersedes: prior ? prior.plan_id : '', baseline_pending: Math.round(a.wl.summary.total_absolute_pending), severity: a.sev.tier, mode: a.diag.mode, build: REC.BUILD}]);
      const byId = {};
      a.diag.tasks.forEach(t => { byId[t.task_id] = t; });
      const lineRows = (kind, lines) => {
        const first = {};
        return lines.map(l => {
          const t = byId[l.task_id], row = {plan_id: planId, kind, task_id: l.task_id, level: t.level, target: t.target, captain: l.captain, hours: l.hours, share: l.share,
            est_hours: t.est_hours, locations: t.location_count, items: t.item_count, value: Math.round(t.value), detail_json: ''};
          if (kind === 'P' && !first[l.task_id]) { first[l.task_id] = true; row.detail_json = JSON.stringify(t); }
          return row;
        });
      };
      repo.append('PLAN_TASKS', lineRows('S', sugg.lines).concat(lineRows('P', planned.lines)));
      const covered = {};
      planned.lines.forEach(l => { covered[l.task_id] = true; });
      const items = [];
      Object.keys(covered).forEach(tid => byId[tid].items.forEach(it => items.push({plan_id: planId, item_id: it.item_id, item_name: it.item_name, task_id: tid,
        priority: it.priority, baseline_variance: it.variance, baseline_variance_qty: it.variance_qty, baseline_increment_qty: it.audit_increment_qty})));
      repo.append('PLAN_ITEMS', items);
      log(c, prior ? 'PLAN_REPLACED' : 'PLAN_CONFIRMED', id, planId, 'Planned ' + planned.used_hours + 'h vs suggested ' + sugg.used_hours + 'h · crew: ' +
        crew.map(x => x.name + ' ' + x.hours + 'h').join(', ') + ((req.skip || []).length ? ' · skipped ' + req.skip.length + ' tasks' : '') + (changes ? ' · changes: ' + changes : ' · same as suggested') +
        (prior ? ' · replaces ' + prior.plan_id : ''));
      return planId;
    });
    return {plan_id: out, view: store(repo, id)};
  }

  // ------------------------------------------------------------------ close shift
  /** req: {plan_id, rows:[{captain, actual_hours, tasks:{task_id:DONE|PARTIAL|NOT_DONE}, note}]} */
  function actuals(repo, req) {
    const c = ctx(repo), plan = repo.rows('PLANS').find(p => p.plan_id === text(req.plan_id));
    if (!plan) fail('Plan not found.');
    canSee(c, plan.outlet_id);
    if (!firstTime(repo, req.token)) return store(repo, plan.outlet_id);
    const rows = (req.rows || []).filter(r => text(r.captain));
    if (!rows.length) fail('Log at least one captain.');
    rows.forEach(r => { const h = Number(r.actual_hours); if (!isFinite(h) || h < 0 || h > 12) fail('Actual hours for ' + r.captain + ' must be 0 to 12.'); });
    repo.lock(() => repo.append('ACTUALS', rows.map(r => ({plan_id: plan.plan_id, outlet_id: plan.outlet_id, captain: text(r.captain), actual_hours: Number(r.actual_hours),
      tasks_json: JSON.stringify(r.tasks || {}), note: text(r.note), logged_by: c.me, logged_at: repo.now()}))));
    log(c, 'ACTUALS_LOGGED', plan.outlet_id, plan.plan_id, rows.map(r => r.captain + ' ' + r.actual_hours + 'h').join(', '));
    return store(repo, plan.outlet_id);
  }

  // ------------------------------------------------------------------ print sheets
  /** One printable page per captain for a confirmed plan. Created once per plan; later calls return the same file. */
  function exportPlan(repo, planId) {
    const c = ctx(repo), plan = repo.rows('PLANS').find(p => p.plan_id === text(planId));
    if (!plan) fail('Plan not found.');
    canSee(c, plan.outlet_id);
    const fp = frozenPlan(c, plan), pages = REC.printPages(plan, fp.tasks, fp.lines, sopMap(repo), text(plan.outlet_name));
    let file = null;
    try { file = JSON.parse(repo.getProp('EXP_' + plan.plan_id) || 'null'); } catch (e) { file = null; }
    if (!file) {
      file = repo.lock(() => repo.exportSheet('Recovery ' + plan.outlet_name + ' ' + plan.plan_date + ' (' + plan.plan_id + ')', pages, c.st.export_folder_id));
      if (file && file.url) { repo.setProp('EXP_' + plan.plan_id, JSON.stringify(file)); log(c, 'PRINT_SHEET_CREATED', plan.outlet_id, plan.plan_id, file.url); }
    }
    return {file, pages};
  }

  // ------------------------------------------------------------------ snapshots
  function snapshot(c, list) {
    const have = {};
    c.repo.rows('DAILY').forEach(s => { if (REC.day(s.snapshot_date) === c.today) have[text(s.outlet_id)] = true; });
    const add = list.filter(x => !have[text(x.id)] && x.wl.summary.feed_date).map(x => ({snapshot_date: c.today, outlet_id: text(x.id),
      total_absolute_pending: Math.round(x.wl.summary.total_absolute_pending), worklist_value: Math.round(x.wl.summary.worklist_value),
      worklist_skus: x.wl.summary.worklist_skus, p0: x.wl.summary.priority_counts.P0, severity: x.sev.tier, mode: x.diag.mode, feed_date: x.wl.summary.feed_date}));
    if (add.length) c.repo.lock(() => c.repo.append('DAILY', add));
    return add.length;
  }

  // ------------------------------------------------------------------ CM + tower
  function storeRows(c, days) {
    const repo = c.repo, raw = repo.raw(), master = repo.storeMaster(), b = boot(repo, c);
    const plans = livePlans(repo.rows('PLANS')).filter(p => text(p.status) === 'CONFIRMED'), cur = currentPlans(plans), reviews = repo.rows('CM_REVIEWS');
    const from = REC.addDays(c.today, -(days - 1)), snaps = repo.rows('DAILY');
    const snapList = [];
    const rows = b.stores.map(s => {
      const wl = REC.worklist(raw, s.outlet_id, c.st), diag = REC.diagnose(wl, c.st, repo.locations().filter(l => text(l.outlet_id) === s.outlet_id));
      const sev = REC.severity(wl.summary, healthOf(repo, s.outlet_id), c.st, REC.storeMetrics(repo.storeMetrics(), s.outlet_id, c.st));
      const p = cur[s.outlet_id] || null, m = p ? measureFor(c, p, raw) : null;
      const recent = plans.filter(x => x.outlet_id === s.outlet_id && text(x.plan_date) >= from).map(x => measureFor(c, x, raw));
      const sum = k => Math.round(10 * recent.reduce((v, x) => v + x[k].hours, 0)) / 10;
      const actH = sum('actual'), rec = recent.reduce((v, x) => v + x.recovery.recovered_value, 0);
      snapList.push({id: s.outlet_id, wl, sev, diag});
      const old = snaps.filter(x => x.outlet_id === s.outlet_id && REC.day(x.snapshot_date) <= from).slice(-1)[0];
      return {outlet_id: s.outlet_id, outlet_name: s.outlet_name, region: s.region, cohort: text(healthOf(repo, s.outlet_id).cohort), cm_sm: (master[s.outlet_id] || {}).cm_sm || '',
        pending: Math.round(wl.summary.total_absolute_pending), p0: wl.summary.priority_counts.P0, severity: sev.tier, capacity: sev.capacity, mode: diag.mode, full_recon: diag.full_recon,
        plan: p ? {plan_id: p.plan_id, plan_date: p.plan_date, changes: p.changes_vs_suggested, confirmed_by: p.confirmed_by} : null, measure: m,
        flag: REC.flag(p, m, c.today, c.st), last_review: reviews.filter(r => r.outlet_id === s.outlet_id).slice(-1)[0] || null,
        window: {days, plans: recent.length, suggested_hours: sum('suggested'), planned_hours: sum('planned'), actual_hours: actH, recovered_value: Math.round(rec),
          rupees_per_hour: actH ? Math.round(rec / actH) : null, pending_then: old ? num(old.total_absolute_pending) : null}};
    });
    snapshot(c, snapList);
    return rows;
  }
  function cm(repo) {
    const c = ctx(repo);
    need(c, ['CM', 'PM']);
    const rows = storeRows(c, 7);
    rows.sort((a, b) => a.flag.sev - b.flag.sev || b.pending - a.pending);
    return {rows, decisions: ['Coach SM on plan', 'Ask SM to re-plan', 'Send support captain', 'Escalate to SLP', 'Escalate to Ops head', 'Monitor']};
  }
  function cmReview(repo, req) {
    const c = ctx(repo);
    need(c, ['CM', 'PM']);
    if (!text(req.outlet_id) || !text(req.decision)) fail('Store and decision are required.');
    if (text(req.decision) !== 'Monitor' && !text(req.owner)) fail('Name an owner for this action.');
    repo.lock(() => repo.append('CM_REVIEWS', [{reviewed_at: repo.now(), reviewed_by: c.me, outlet_id: text(req.outlet_id), plan_id: text(req.plan_id), flag: text(req.flag),
      decision: text(req.decision), owner: text(req.owner), next_review: text(req.next_review), note: text(req.note)}]));
    log(c, 'CM_DECISION', req.outlet_id, req.plan_id, text(req.decision) + (text(req.owner) ? ' · owner ' + text(req.owner) : '') + (text(req.note) ? ' · ' + text(req.note) : ''));
    return cm(repo);
  }
  function tower(repo) {
    const c = ctx(repo);
    need(c, ['PM']);
    return towerFor(c);
  }
  function towerFor(c) {
    const repo = c.repo, rows = storeRows(c, 7), regions = {};
    rows.forEach(r => {
      const g = regions[r.region] = regions[r.region] || {region: r.region, stores: 0, broken: 0, at_risk: 0, sorted: 0, planned_stores: 0, suggested_hours: 0, planned_hours: 0,
        actual_hours: 0, recovered_value: 0, pending: 0, pending_then: 0, flags: 0, rph: []};
      g.stores++;
      g[r.severity === 'BROKEN' || r.severity === 'SEVERELY_BROKEN' ? 'broken' : r.severity === 'AT_RISK' ? 'at_risk' : 'sorted']++;
      if (r.window.plans) g.planned_stores++;
      ['suggested_hours', 'planned_hours', 'actual_hours', 'recovered_value', 'pending'].forEach(k => { g[k] += k === 'pending' ? r.pending : r.window[k]; });
      if (r.window.pending_then !== null) g.pending_then += r.window.pending_then; else g.pending_then += r.pending;
      if (r.flag.sev === 1) g.flags++;
      if (r.window.rupees_per_hour !== null) g.rph.push(r.window.rupees_per_hour);
    });
    const regionRph = {};
    const list = Object.keys(regions).sort().map(k => {
      const g = regions[k];
      g.rupees_per_hour = g.actual_hours ? Math.round(g.recovered_value / g.actual_hours) : null;
      regionRph[k] = REC.median(g.rph);
      g.median_store_rph = regionRph[k];
      delete g.rph;
      ['suggested_hours', 'planned_hours', 'actual_hours'].forEach(x => { g[x] = Math.round(g[x] * 10) / 10; });
      g.pending_change_pct = g.pending_then ? Math.round(1000 * (g.pending - g.pending_then) / g.pending_then) / 10 : null;
      return g;
    });
    repo.setProp('REGION_RPH', JSON.stringify(regionRph));
    const cohort = {};
    rows.forEach(r => {
      const k = r.cohort || '(no cohort)', g = cohort[k] = cohort[k] || {cohort: k, stores: 0, actual_hours: 0, recovered_value: 0, pending: 0, pending_then: 0};
      g.stores++; g.actual_hours += r.window.actual_hours; g.recovered_value += r.window.recovered_value; g.pending += r.pending;
      g.pending_then += r.window.pending_then === null ? r.pending : r.window.pending_then;
    });
    return {regions: list, cohorts: Object.keys(cohort).map(k => cohort[k]), rows};
  }

  /** Time-driven job: daily snapshots and the region ₹/hour medians used for nudges. */
  function daily(repo) { const c = ctx(repo, true), n = towerFor(c).rows.length; log(c, 'DAILY_JOB', '', '', n + ' stores snapshotted'); return n; }

  // ------------------------------------------------------------------ settings (PM edits in the app; same values as the CFG tab)
  function settingsView(repo) {
    const c = ctx(repo);
    need(c, ['PM']);
    const cur = {};
    repo.settingsRows().forEach(r => { cur[text(r.key)] = text(r.value); });
    return {errors: c.errors, rows: REC.SETTINGS.map(s => ({key: s.key, label: s.label, type: s.type, default: String(s.def), value: cur[s.key] || '', effective: String(c.st[s.key])})),
      log: repo.rows('ACTION_LOG').slice(-40).reverse()};
  }
  function settingsSave(repo, changes) {
    const c = ctx(repo);
    need(c, ['PM']);
    const keys = Object.keys(changes || {});
    keys.forEach(k => { if (!REC.SETTINGS.find(s => s.key === k)) fail('Unknown setting ' + k); });
    const merged = repo.settingsRows().map(r => ({key: r.key, value: Object.prototype.hasOwnProperty.call(changes, text(r.key)) ? changes[text(r.key)] : r.value}));
    keys.forEach(k => { if (!merged.find(r => text(r.key) === k)) merged.push({key: k, value: changes[k]}); });
    const chk = REC.resolveSettings(merged);
    if (chk.errors.length) fail(chk.errors.join('; '));
    const before = {};
    repo.settingsRows().forEach(r => { before[text(r.key)] = text(r.value); });
    const changed = keys.filter(k => text(changes[k]) !== (before[k] || ''));
    if (!changed.length) return settingsView(repo);
    repo.lock(() => { repo.saveSettings(changed.reduce((o, k) => { o[k] = text(changes[k]); return o; }, {})); });
    log(c, 'SETTINGS_CHANGED', '', '', changed.map(k => k + ': "' + (before[k] || '') + '" -> "' + text(changes[k]) + '"').join('; '));
    return settingsView(repo);
  }

  return {H, boot, store, confirm, actuals, exportPlan, cm, cmReview, tower, daily, settingsView, settingsSave};
}


/**
 * Recovery Engine | backend (runs inside Google Apps Script, bound to its own Google Sheet)
 *
 * Fully independent: it only reads and writes tabs in its own sheet.
 *   START_HERE  what to paste where (written by setup)
 *   INPUT tabs  RAWItemlevel, STORE_VARIANCE_DAILY (required) + STORE_MASTER, PILOT_COHORT, STORE_HEALTH_RAW,
 *               EMPLOYEE_CAPACITY_SYNC_RAW, LOCATION_RECOVERY_RAW, AUDIT_EXECUTION_RAW (optional, unlock more features)
 *   CFG         settings (edit here or in the app's Settings tab; every change is logged)
 *   USERS       who can do what (email, role SM/CM/PM, outlet_ids)
 *   ACTION_LOG  every confirm / replace / actuals / CM decision / settings change / print / daily job
 *   PLANS, PLAN_TASKS (S = suggested, P = planned), PLAN_ITEMS, ACTUALS, CM_REVIEWS, DAILY   append-only app data
 *   HEALTH      data check (menu > Check data health)
 *   SOP         the handheld steps printed for captains
 * Printable captain sheets are separate Google Sheets in Drive (one tab per captain), linked from the app and ACTION_LOG.
 */
var RE_TZ = 'Asia/Kolkata';
var RE_SVC_ = null;
/** Lazy: Apps Script loads files top to bottom, so REC (IRD_Core.gs) does not exist yet when this line of Code.gs runs. */
function re_svc() { return RE_SVC_ || (RE_SVC_ = RE_SERVICE_FACTORY(REC)); }
var RE_HTML_FILE = 'App';
var RE_CACHE_SEC = 6 * 3600;

// Input tabs you fill (paste or sync a query result into them). Columns are read by name: any order, extra columns ignored.
// `need` must exist; `cols` are read when present and are the header row setup writes.
var RE_RAW_NEEDED = ['outlet_id', 'item_id', 'item_name', 'variance', 'variance_qty', 'rnk', 'neg_loc_array', 'probable_locations'];
var RE_RAW_OPTIONAL = ['month_start_date', 'outlet_name', 'city', 'raw_synced_at', 'update_date', 'audit_decrement_qty', 'audit_increment_qty',
  'audit_decrement_dates', 'audit_increment_dates', 'l0', 'upc', 'mrp', 'store_total_absolute_variance'];
var RE_INPUTS = {
  RAW: {tab: 'RAWItemlevel', cfgTab: 'tab_raw', need: RE_RAW_NEEDED, cols: RE_RAW_NEEDED.concat(RE_RAW_OPTIONAL), required: true, date: 'raw_synced_at',
    fill: 'Query 2: item-level variance (sql/RAWItemlevel.sql). Refresh daily.', unlocks: 'Everything. The app cannot plan without it.'},
  STORE_VARIANCE: {tab: 'STORE_VARIANCE_DAILY', cfgTab: 'tab_store_variance', need: ['outlet_id'], required: true, date: 'date_',
    cols: ['date_', 'outlet_id', 'outlet_name', 'negative_amount', 'positive_amount', 'net_var', 'raw_synced_at'],
    fill: 'Query 1: daily store variance, last 3 months (sql/STORE_VARIANCE_DAILY.sql). Refresh daily.', unlocks: 'Store severity (open / net variance).'},
  MASTER: {tab: 'STORE_MASTER', cfgTab: 'tab_store_master', need: ['outlet_id'], date: '',
    cols: ['outlet_id', 'outlet_name', 'city', 'region', 'cluster', 'cm_sm', 'low_order_window'],
    fill: 'Type it once: one row per store. low_order_window like 14:00-17:00.', unlocks: 'Region / CM names in the views, best recovery window. Without it, names come from RAWItemlevel.'},
  COHORT: {tab: 'PILOT_COHORT', cfgTab: 'tab_health', need: ['outlet_id'], date: '',
    cols: ['pair_id', 'region', 'outlet_id', 'outlet_name', 'cohort_role', 'comparison_outlet_id'],
    fill: 'Pilot list: BROKEN / CONTROL pairs (the PILOT_COHORT export you already have).', unlocks: 'Broken vs control comparison in the control tower.'},
  METRICS: {tab: 'STORE_HEALTH_RAW', cfgTab: 'tab_store_metrics', need: ['outlet_id'], date: 'metric_date',
    cols: ['metric_date', 'data_period_status', 'region', 'outlet_id', 'outlet_name', 'ppi', 'tfr_pct', 'r2a_sec', 'surge_pct'],
    fill: 'Daily store health (Parth\'s STORE_HEALTH_RAW query).', unlocks: 'PPI / TFR severity and capacity state.'},
  CAPTAINS: {tab: 'EMPLOYEE_CAPACITY_SYNC_RAW', cfgTab: 'tab_captains', need: ['outlet_id'], date: 'snapshot_date',
    cols: ['snapshot_date', 'outlet_id', 'employee_id', 'employee_name', 'designation', 'auditor_active_hours_l7', 'missing_complaint_pct_l7',
      'wrong_item_complaint_pct_l7', 'recent_presence_status', 'complex_approved', 'captain_id', 'captain_name', 'active', 'iaph', 'qaph', 'bad_audit_pct', 'audits_30d'],
    fill: 'Captain roster (Parth\'s EMPLOYEE_CAPACITY_SYNC_RAW query). Optional column complex_approved = Y/N.', unlocks: 'Suggested crew (pre-ticked best captains).'},
  LOCATIONS: {tab: 'LOCATION_RECOVERY_RAW', cfgTab: 'tab_locations', need: ['outlet_id', 'location_id'], date: '',
    cols: ['outlet_id', 'location_id', 'aisle_id', 'rack_id', 'correction_days_7d', 'current_ppi', 'current_ideal_ppi', 'current_ppi_signal_status'],
    fill: 'Location master + correction / PPI evidence (Parth\'s LOCATION_RECOVERY_RAW query).', unlocks: 'Real rack sizes and Parth\'s full-rack rule.'},
  AUDITS: {tab: 'AUDIT_EXECUTION_RAW', cfgTab: 'tab_audits', need: ['audit_date_ist', 'outlet_id', 'auditor_id', 'session_elapsed_seconds'], date: 'audit_date_ist',
    cols: ['audit_date_ist', 'outlet_id', 'location_id', 'rack_id', 'session_status', 'end_time', 'auditor_id', 'distinct_skus', 'found_qty',
      'quality_status', 'session_elapsed_seconds', 'expected_sku_coverage_pct'],
    fill: 'Audit sessions, last 30 days (Parth\'s AUDIT_EXECUTION_RAW query).', unlocks: 'Captain IAPH / bad-audit %, and audit evidence (matched / quality gap / off-plan).'}
};
var RE_OWN_H = {
  CFG: ['key', 'value', 'default', 'what_it_does'],
  USERS: ['email', 'role', 'outlet_ids', 'name', 'note'],
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
  var ss = re_ss(), memo = {}, st = null, inSS;
  function settingsRows() { if (!memo.cfg) memo.cfg = re_rowsOf(re_ownTab(ss, 'CFG', RE_OWN_H.CFG)); return memo.cfg; }
  function settings() { if (!st) st = REC.resolveSettings(settingsRows()).settings; return st; }
  function inputsSS() {
    if (inSS !== undefined) return inSS;
    var id = re_text(settings().inputs_sheet_id);
    try { inSS = id ? SpreadsheetApp.openById(id) : null; } catch (e) { throw new Error('RE: cannot open inputs_sheet_id. ' + e.message); }
    return inSS;
  }
  /** Input tab from this sheet (or inputs_sheet_id if set). Cached for 6 h, keyed on the tab's size so a refresh busts it. */
  function input(name) {
    if (memo[name]) return memo[name];
    var spec = RE_INPUTS[name], ext = inputsSS(), book = ext || ss, tab = re_text(settings()[spec.cfgTab]) || spec.tab, sh = book.getSheetByName(tab);
    if (!sh) { if (spec.required) throw new Error('RE: tab "' + tab + '" is missing. Run menu > Recovery Engine > 1. Set up.'); return (memo[name] = []); }
    var key = 'in' + (PropertiesService.getScriptProperties().getProperty('RE_CACHE_V') || '0') + '_' + book.getId().slice(0, 12) + '_' + name + '_' + sh.getLastRow() + '_' + sh.getLastColumn();
    var rows = re_cacheGet(key);
    if (!rows) { rows = re_readCols(sh, spec.need, spec.cols, tab, 'outlet_id'); re_cachePut(key, rows); }
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
    health: function () { return input('COHORT'); },
    storeMetrics: function () { return input('METRICS'); },
    storeVariance: function () { return input('STORE_VARIANCE'); },
    exportSheet: function (title, pages, folderId) { return re_exportSheet(title, pages, folderId); },
    captains: function () { return input('CAPTAINS'); },
    locations: function () { return input('LOCATIONS'); },
    audits: function () { return input('AUDITS'); },
    sops: function () { if (!memo.sop) memo.sop = re_rowsOf(re_ownTab(ss, 'SOP', RE_OWN_H.SOP)); return memo.sop; },
    raw: function () { return input('RAW'); },
    /** Store names: STORE_MASTER where filled, otherwise the outlet_name / city that RAWItemlevel already carries. */
    storeMaster: function () {
      if (memo.master) return memo.master;
      var m = {};
      input('RAW').forEach(function (r) {
        var id = re_text(r.outlet_id);
        if (id && !m[id]) m[id] = {outlet_name: re_text(r.outlet_name) || id, city: re_text(r.city), cluster: '', region: '', cm_sm: ''};
      });
      input('MASTER').forEach(function (r) {
        var id = re_text(r.outlet_id), o = m[id] = m[id] || {outlet_name: id, city: '', cluster: '', region: '', cm_sm: ''};
        ['outlet_name', 'city', 'cluster', 'region', 'cm_sm', 'low_order_window'].forEach(function (k) { if (re_text(r[k])) o[k] = re_text(r[k]); });
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
  // Input tabs (blue header) with the exact columns each query should produce.
  var inputsId = re_text(REC.resolveSettings(re_rowsOf(cfg)).settings.inputs_sheet_id);
  if (!inputsId) Object.keys(RE_INPUTS).forEach(function (k) {
    var spec = RE_INPUTS[k];
    if (ss.getSheetByName(spec.tab)) return;
    var sh = ss.insertSheet(spec.tab);
    sh.getRange(1, 1, 1, spec.cols.length).setValues([spec.cols]).setFontWeight('bold').setBackground('#1d4ed8').setFontColor('#ffffff');
    sh.getRange(1, 1).setNote('INPUT TAB. Paste / sync here: ' + spec.fill + ' Keep a header row; columns are matched by name.');
    sh.setFrozenRows(1);
  });
  re_startHere(ss);
  var sop = ss.getSheetByName('SOP');
  if (sop.getLastRow() < 2) sop.getRange(2, 1, RE_DEFAULT_SOP.length, 3).setValues(RE_DEFAULT_SOP);
  var users = ss.getSheetByName('USERS'), me = Session.getActiveUser().getEmail();
  if (users.getLastRow() < 2 && me) users.appendRow([me.toLowerCase(), 'PM', '', '', 'added by setup']);
  var msg = 'Recovery Engine is set up. Open the START_HERE tab: it lists which query goes into which blue tab.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
  return msg;
}
/** START_HERE tab: plain-language map of what to fill, written by setup. */
function re_startHere(ss) {
  var sh = ss.getSheetByName('START_HERE') || ss.insertSheet('START_HERE', 0);
  sh.clear();
  var rows = [['RECOVERY ENGINE: START HERE', '', '', ''], ['', '', '', ''],
    ['Step', 'What to do', '', ''],
    ['1', 'Fill the BLUE tabs below with your query results (paste, or point your sheet sync at the tab). Keep the header row.', '', ''],
    ['2', 'Menu: Recovery Engine > 2. Check data health. Every required tab must say OK on the HEALTH tab.', '', ''],
    ['3', 'Add people to the USERS tab (email, role SM / CM / PM, outlet_ids for SMs).', '', ''],
    ['4', 'Extensions > Apps Script > Deploy > New deployment > Web app (Execute as: Me, Access: anyone in your organisation). Share that link.', '', ''],
    ['5', 'Menu: Recovery Engine > 3. Turn on daily job (keeps the before / after numbers for results).', '', ''],
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
  var st = REC.resolveSettings(repo.settingsRows()).settings;
  var fns = {RAW: repo.raw, STORE_VARIANCE: repo.storeVariance, MASTER: function () { return Object.keys(repo.storeMaster()).map(function (k) { return {outlet_id: k}; }); },
    COHORT: repo.health, METRICS: repo.storeMetrics, CAPTAINS: repo.captains, LOCATIONS: repo.locations, AUDITS: repo.audits};
  Object.keys(RE_INPUTS).forEach(function (k) {
    var spec = RE_INPUTS[k], tab = re_text(st[spec.cfgTab]) || spec.tab;
    check(tab + (spec.required ? ' (required)' : ' (optional)'), spec.fill, fns[k], spec.date);
  });
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

// ------------------------------------------------------------------ web app (called by the App page)
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
