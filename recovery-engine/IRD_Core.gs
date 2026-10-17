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
    {key:'source_sheet_id', def:'1_JdCO5anThU-AqXTXiJ61jQyPBjT7FDi5mMzyiW1ktM', type:'text', label:'Variance source sheet (C) ID'},
    {key:'recovery_app_url', def:'', type:'text', label:'Recovery App (C) web app link'},
    {key:'pilot_outlets', def:'', type:'list', label:'Pilot outlet IDs (blank = all in feed)'},
    {key:'inputs_sheet_id', def:'', type:'text', label:'Sheet that already syncs the input exports (e.g. Instore Recovery Engine V2). Blank = use the IN_ tabs in this sheet'},
    {key:'tab_captains', def:'EMPLOYEE_CAPACITY_SYNC_RAW', type:'text', label:'Tab name for captains in the inputs sheet'},
    {key:'tab_locations', def:'LOCATION_RECOVERY_RAW', type:'text', label:'Tab name for locations in the inputs sheet'},
    {key:'tab_audits', def:'AUDIT_EXECUTION_RAW', type:'text', label:'Tab name for audit sessions in the inputs sheet'},
    {key:'tab_health', def:'PILOT_COHORT', type:'text', label:'Tab name for the pilot cohort in the inputs sheet'},
    {key:'tab_store_metrics', def:'STORE_HEALTH_RAW', type:'text', label:'Tab name for daily store health (PPI, TFR, R2A, surge) in the inputs sheet'},
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
    if (t.level === 'LOCATION') return t.item_count + ' item' + (t.item_count === 1 ? '' : 's') + ' at known locations. Check NEG locations first, then probable.';
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
    measure, flag, nudge, median, stableHash, storeMetrics, planDiff, printPages, TIER_RANK};
}
var REC = RE_CORE_FACTORY();
if (typeof module !== 'undefined' && module.exports) module.exports = REC;
