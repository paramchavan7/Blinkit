// RECOVERY ENGINE · Service.gs (the screens and the refresh job). In Apps Script this file must be called Service.
// Paste the whole file, replacing everything in it. Built 2026-10-22 from IRD_Service.gs. Do not edit here; settings live in the CFG tab.

/**
 * Recovery Engine v3 | Service (orchestration)
 * Talks only to a `repo` object, never to SpreadsheetApp directly, so the same code runs on the
 * real sheet (Code.gs), in Node tests and in the browser preview (in-memory repo).
 *
 * Scale model (all North stores, a few hundred):
 *   refresh()  hourly job. Reads every input once, computes every live store and writes
 *              STORE_STATE   one row per store: summary columns + the SM screen, packed (gzip) into a few cells
 *              PLAN_RESULTS  one row per plan: suggested / planned / actual hours, audit evidence, ₹ recovered, T+3 / T+7
 *              DAILY         one store snapshot per day (baseline for T+3 / T+7)
 *              METRICS_DAILY goodness metrics per day for ALL, each region and each pilot cohort
 *              JOB_RUNS      start / finish / failure of every run (monitoring)
 *   store()    SM screen: one STORE_STATE row + that store's own plans. Falls back to a live computation before the first refresh.
 *   cm(), tower(), monitor()  read only the tabs above, so they stay fast at any store count.
 *
 * repo contract:
 *   me() today() now() settingsRows() saveSettings(changes) users() sops() healthRows()
 *   inputs: raw() storeVariance() storeMaster() health() storeMetrics() captains() locations() audits() auditorDaily()
 *   app tabs: rows(tab, cols?, fromRow?) (objects carry _row) rowsWhere(tab, col, value, lastN?) tail(tab, n) append(tab, objs) writeAll(tab, objs)
 *   pack(obj) -> [cells]   unpack([cells]) -> obj
 *   exportSheet(title, pages, folderId)  getProp(k) setProp(k, v)  once(token, seconds)  lock(fn)
 */
function RE_SERVICE_FACTORY(REC) {
  'use strict';
  const PARTS = 8;
  const PAYLOAD = Array.from({length: PARTS}, (x, i) => 'payload_' + (i + 1));
  const H = {
    PLANS: ['plan_id', 'version', 'status', 'outlet_id', 'outlet_name', 'plan_date', 'window', 'confirmed_at', 'confirmed_by', 'feed_date',
      'suggested_hours', 'planned_hours', 'changes_vs_suggested', 'supersedes', 'baseline_pending', 'severity', 'mode', 'pinned', 'build', 'frozen'],
    PLAN_TASKS: ['plan_id', 'plan_date', 'outlet_id', 'kind', 'task_id', 'level', 'target', 'captain', 'hours', 'share', 'est_hours', 'locations', 'items', 'value'],
    PLAN_ITEMS: ['plan_id', 'plan_date', 'outlet_id', 'item_id', 'item_name', 'task_id', 'priority', 'baseline_variance', 'baseline_variance_qty', 'baseline_increment_qty'],
    ACTUALS: ['plan_id', 'outlet_id', 'plan_date', 'captain', 'actual_hours', 'tasks_json', 'note', 'logged_by', 'logged_at'],
    CM_REVIEWS: ['reviewed_at', 'reviewed_by', 'outlet_id', 'plan_id', 'flag', 'decision', 'owner', 'next_review', 'note'],
    ACTION_LOG: ['at', 'by', 'role', 'action', 'outlet_id', 'plan_id', 'detail'],
    DAILY: ['snapshot_date', 'outlet_id', 'total_absolute_pending', 'worklist_value', 'worklist_skus', 'p0', 'severity', 'mode', 'feed_date'],
    STORE_STATE: ['outlet_id', 'outlet_name', 'region', 'cluster', 'cm_sm', 'cohort', 'refreshed_at', 'feed_date', 'severity', 'capacity', 'pending', 'worklist_value',
      'p0', 'mode', 'full_recon', 'tasks', 'hours_to_clear', 'top_rack', 'top_rack_value', 'on_floor_now', 'in_today', 'plan_id', 'plan_date', 'flag', 'row_json', 'payload_parts'].concat(PAYLOAD),
    PLAN_RESULTS: ['plan_id', 'outlet_id', 'outlet_name', 'region', 'cohort', 'plan_date', 'confirmed_by', 'severity', 'mode', 's_hours', 'p_hours', 'a_hours', 's_captains',
      'p_captains', 'crew_overlap_pct', 'plan_vs_suggested_pct', 'actual_vs_planned_pct', 'tasks_done_pct', 'actuals_logged', 'planned_locations', 'audited_locations',
      'audited_pct', 'matched', 'quality_gap', 'off_plan', 'baseline', 'planned_items', 'recovered_items', 'recovered_value', 'left_feed_value', 'rupees_per_hour',
      't3_state', 't3_change_pct', 't7_state', 't7_change_pct', 'outcome', 'flag', 'changes', 'updated_at'],
    METRICS_DAILY: ['date', 'scope', 'stores', 'stores_need', 'plans', 'plan_rate_pct', 'closed_pct', 'sm_views', 's_hours', 'p_hours', 'a_hours', 'hours_vs_suggested_pct',
      'actual_vs_planned_pct', 'crew_overlap_pct', 'planned_locations', 'audited_locations', 'audited_pct', 'quality_gap_pct', 'planned_items', 'recovered_items',
      'recovered_value', 'rupees_per_hour', 'locations_per_hour', 't7_better_pct'],
    JOB_RUNS: ['run_id', 'at', 'status', 'seconds', 'stores', 'plans_measured', 'detail']
  };
  const PLAN_SLIM = ['plan_id', 'version', 'status', 'outlet_id', 'outlet_name', 'plan_date', 'window', 'confirmed_at', 'confirmed_by', 'feed_date',
    'suggested_hours', 'planned_hours', 'changes_vs_suggested', 'supersedes', 'severity', 'mode', 'pinned'];
  const text = x => (x === null || x === undefined) ? '' : String(x).trim();
  const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
  const fail = m => { throw new Error('RE: ' + m); };
  const group = rows => { const g = {}; (rows || []).forEach(r => { const k = text(r.outlet_id); if (k) (g[k] = g[k] || []).push(r); }); return g; };
  const index = (rows, k) => { const m = {}; (rows || []).forEach(r => { m[text(r[k])] = r; }); return m; };
  const day = x => REC.day(x);

  // ------------------------------------------------------------------ context + access
  function ctx(repo, system) {
    const r = REC.resolveSettings(repo.settingsRows());
    if (system) return {repo, st: r.settings, errors: r.errors, me: 'system', role: 'PM', outlets: null, regions: null, today: repo.today()};
    const me = repo.me(), a = REC.access(r.settings, me, repo.users());
    return {repo, st: r.settings, errors: r.errors, me, role: a.role, outlets: a.outlets, regions: a.regions || null, today: repo.today()};
  }
  const need = (c, roles) => { if (roles.indexOf(c.role) < 0) fail('This needs role ' + roles.join('/') + '. You are ' + c.role + '.'); };
  function regionOf(m, h) { return text(h && h.region) || text(m && m.region) || text(m && m.cluster) || text(m && m.city) || 'Unassigned'; }
  /** Live stores: pilot_outlets if set, else every store in STORE_MASTER, else every store in RAWItemlevel; then live_regions. */
  function scopeIds(c, master, rawIds) {
    const listed = Object.keys(master).filter(k => master[k].listed);
    let ids = text(c.st.pilot_outlets) ? text(c.st.pilot_outlets).split(',').map(text).filter(Boolean) : listed.length ? listed : rawIds.slice();
    if (text(c.st.live_regions)) {
      const coh = index(c.repo.health(), 'outlet_id'), want = text(c.st.live_regions).toLowerCase().split(',');
      ids = ids.filter(id => want.indexOf(regionOf(master[id], coh[id]).toLowerCase()) >= 0);
    }
    return ids.filter((x, i, a) => a.indexOf(x) === i).sort();
  }
  /** What this user may open: SM = outlet_ids, CM = outlet_ids or regions, PM = everything live. */
  function allowedIds(c, master, ids) {
    if (c.outlets) return ids.filter(id => c.outlets.indexOf(id) >= 0);
    if (c.regions) {
      const coh = index(c.repo.health(), 'outlet_id'), want = c.regions.map(x => x.toLowerCase());
      return ids.filter(id => { const m = master[id] || {}; return [regionOf(m, coh[id]), text(m.cluster), text(m.region)].some(x => x && want.indexOf(x.toLowerCase()) >= 0); });
    }
    return ids;
  }
  function canSee(c, id, master) {
    if (!c.outlets && !c.regions) return;
    if (allowedIds(c, master, [text(id)]).length) return;
    fail('You do not have access to outlet ' + id + '.');
  }
  /** Every write is also logged to ACTION_LOG so the sheet shows who did what, when. */
  function log(c, action, outletId, planId, detail) {
    c.repo.append('ACTION_LOG', [{at: c.repo.now(), by: c.me, role: c.role, action, outlet_id: text(outletId), plan_id: text(planId), detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {})}]);
  }
  /** Double-tap / network-retry guard: the same client token is only applied once. */
  const firstTime = (repo, token) => !text(token) || repo.once(text(token), 3600);

  function sopMap(repo) {
    const m = {};
    repo.sops().slice().sort((a, b) => num(a.step_no) - num(b.step_no)).forEach(s => { const k = text(s.level).toUpperCase(); (m[k] = m[k] || []).push(text(s.step)); });
    return m;
  }
  /** The employee export has one row per snapshot_date; keep the latest row per employee. */
  function latestRoster(rows) {
    const by = {};
    rows.forEach(r => { const k = text(r.employee_id) || text(r.captain_id) || text(r.captain_name) || text(r.employee_name); if (!by[k] || text(r.snapshot_date) >= text(by[k].snapshot_date)) by[k] = r; });
    // Floor staff only: managers and admin roles are left out (the roster query passes the warehouse role through as designation).
    return Object.keys(by).map(k => by[k]).filter(r => !/manager|admin|supervisor|\bsm\b|\bcm\b|cluster|city|security/i.test(text(r.designation)));
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
  function livePlans(plans) { const sup = {}; plans.forEach(p => { if (text(p.supersedes)) sup[text(p.supersedes)] = true; }); return plans.filter(p => !sup[text(p.plan_id)] && text(p.status) === 'CONFIRMED'); }
  const unpackCell = (repo, s) => { try { return text(s) ? repo.unpack([s]) : null; } catch (e) { return null; } };
  /** One packed cell (a cell holds 50,000 characters). Large plans keep their first 25 items per task. */
  function packCell(repo, obj, shrink) {
    let parts = repo.pack(obj);
    if (parts.length > 1 && shrink) { shrink(obj); parts = repo.pack(obj); }
    if (parts.length > 1) fail('This plan is too large to store. Skip some tasks and confirm again.');
    return parts[0];
  }

  // ------------------------------------------------------------------ inputs
  /** All inputs once, grouped by outlet (refresh job). */
  function readAll(repo) {
    return {raw: group(repo.raw()), locs: group(repo.locations()), sessions: group(repo.audits()), dailies: group(repo.auditorDaily()), floor: group(repo.floorNow ? repo.floorNow() : []), caps: group(repo.captains()),
      metrics: group(repo.storeMetrics()), variance: group(repo.storeVariance()), cohort: index(repo.health(), 'outlet_id'), snaps: group(repo.rows('DAILY'))};
  }
  const slice = (G, id) => ({raw: G.raw[id] || [], locs: G.locs[id] || [], sessions: G.sessions[id] || [], dailies: G.dailies[id] || [], floor: G.floor[id] || [], caps: G.caps[id] || [],
    metrics: G.metrics[id] || [], variance: G.variance[id] || [], cohort: G.cohort[id] || null, snaps: G.snaps[id] || []});
  /** One store's inputs without the job (first use, tests). Reads whole input tabs: fine for a pilot, slow at North scale. */
  function sliceLive(repo, id) {
    const f = rows => (rows || []).filter(r => text(r.outlet_id) === text(id));
    return {raw: f(repo.raw()), locs: f(repo.locations()), sessions: f(repo.audits()), dailies: f(repo.auditorDaily()), floor: f(repo.floorNow ? repo.floorNow() : []), caps: f(repo.captains()), metrics: f(repo.storeMetrics()),
      variance: f(repo.storeVariance()), cohort: index(repo.health(), 'outlet_id')[text(id)] || null, snaps: f(repo.rows('DAILY'))};
  }

  // ------------------------------------------------------------------ the SM screen for one store (what STORE_STATE packs)
  function buildPayload(c, id, D, master, lastCrew) {
    const st = c.st, m = master[id] || {}, now = c.repo.now();
    const wl = REC.worklist(D.raw, id, st), diag = REC.diagnose(wl, st, D.locs);
    const h = Object.assign({}, D.cohort || {}, {cohort: text(D.cohort && (D.cohort.cohort || D.cohort.cohort_role))});
    if (!text(h.open_variance_3m)) { const v = REC.varianceHistory(D.variance, id, c.today, st); if (v) Object.assign(h, v); }
    const sev = REC.severity(wl.summary, h, st, REC.storeMetrics(D.metrics, id, st));
    const metrics = REC.auditMetrics(D.dailies.length ? D.dailies : D.sessions, id, c.today, st);
    const pres = REC.presence(D.sessions.concat(D.dailies, D.floor || []), id, now, st);
    const rows = latestRoster(D.caps), known = {};
    rows.forEach(r => { known[text(r.employee_id) || text(r.captain_id)] = true; });
    // Auditors who audited today but are missing from the roster export still show up (named from the audit export).
    const floorRole = {};
    (D.floor || []).forEach(f => { floorRole[text(f.auditor_id)] = text(f.designation); });
    Object.keys(pres).forEach(aid => { if (!known[aid]) rows.push({outlet_id: id, employee_id: aid, employee_name: pres[aid].name || aid, designation: floorRole[aid] || 'Auditor (seen today)'}); });
    const roster = REC.rankCaptains(REC.withAuditMetrics(rows, metrics), st, lastCrew || [], pres);
    const sugg = REC.suggest(diag, roster, st);
    const latest = Object.keys(pres).reduce((v, k) => Math.max(v, pres[k].last_ms), 0);
    const sessFrom = REC.addDays(c.today, -1);
    return {
      v: 3, refreshed_at: now,
      store: {outlet_id: text(id), outlet_name: m.outlet_name || text(id), city: m.city || '', region: regionOf(m, D.cohort), cluster: text(m.cluster), cm_sm: m.cm_sm || '',
        cohort: h.cohort, low_order_window: text(h.low_order_window) || text(m.low_order_window)},
      summary: wl.summary, severity: sev, diagnosis: diag, roster, suggestion: {budget_hours: sugg.budget_hours, crew: sugg.crew},
      presence: {on_floor_now: roster.filter(r => r.on_floor === 'NOW').length, in_today: roster.filter(r => r.on_floor === 'NOW' || r.on_floor === 'TODAY').length,
        latest_audit: latest ? REC.fmt(latest).slice(11, 16) : '', has_today: Object.keys(pres).length > 0},
      // Compact rows (arrays) so the packed screen stays small: the feed for verify(), today's and yesterday's sessions for observed().
      feed: D.raw.map(r => [text(r.item_id), r.variance, text(r.month_start_date), r.audit_increment_qty, text(r.audit_increment_dates)]),
      sessions: D.sessions.filter(a => day(a.audit_date_ist) >= sessFrom).map(a => [day(a.audit_date_ist), text(a.location_id), text(a.rack_id), text(a.auditor_id),
        text(a.end_time), a.expected_sku_coverage_pct, text(a.quality_status), a.session_elapsed_seconds]),
      sessions_from: D.sessions.length ? D.sessions.reduce((v, a) => { const d = day(a.audit_date_ist); return d && (!v || d < v) ? d : v; }, '') : '',
      snaps: D.snaps.filter(s => day(s.snapshot_date) >= REC.addDays(c.today, -40))
    };
  }
  function statePayload(repo, id) {
    const r = repo.rowsWhere('STORE_STATE', 'outlet_id', text(id), 1)[0];
    if (!r || !num(r.payload_parts)) return null;
    try { return repo.unpack(PAYLOAD.slice(0, num(r.payload_parts)).map(k => text(r[k]))); } catch (e) { return null; }
  }
  const feedRows = (P, id) => P.feed.map(f => ({outlet_id: text(id), item_id: f[0], variance: f[1], month_start_date: f[2], audit_increment_qty: f[3], audit_increment_dates: f[4]}));
  const sessionRows = (P, id) => P.sessions.map(a => ({outlet_id: text(id), audit_date_ist: a[0], location_id: a[1], rack_id: a[2], auditor_id: a[3], end_time: a[4],
    expected_sku_coverage_pct: a[5], quality_status: a[6], session_elapsed_seconds: a[7], session_status: 'COMPLETED'}));

  // ------------------------------------------------------------------ measure one plan
  /** frozen = what the SM confirmed: {s: suggested lines, p: planned lines, tasks: planned tasks with their items}. basis = the same, shaped for measure(). */
  function basisFrom(fz) {
    if (!fz) return {s: [], p: [], tasks: [], items: []};
    const items = [];
    (fz.tasks || []).forEach(t => (t.items || []).forEach(it => items.push({item_id: it.item_id, item_name: it.item_name, task_id: t.task_id, priority: it.priority,
      baseline_variance: it.variance, baseline_variance_qty: it.variance_qty, baseline_increment_qty: it.audit_increment_qty})));
    return {s: fz.s || [], p: fz.p || [], tasks: fz.tasks || [], items};
  }
  const basisOf = (repo, p) => basisFrom(unpackCell(repo, p.frozen));
  /** sessions: audit sessions of this store, used only when they still cover the plan date (the export keeps 2 days at North scale). */
  function measurePlan(c, p, basis, actualRows, feed, snaps, sessions, sessionsFrom, prev) {
    const covered = sessions && sessionsFrom && text(p.plan_date) >= sessionsFrom;
    let prevObs = null;
    if (prev && text(prev.planned_locations) !== '') prevObs = {locations_audited: num(prev.audited_locations), locations_planned: num(prev.planned_locations),
      pct: text(prev.audited_pct) === '' ? null : num(prev.audited_pct), counts: {MATCHED: num(prev.matched), QUALITY_GAP: num(prev.quality_gap), OFF_PLAN: num(prev.off_plan), BASELINE: num(prev.baseline)},
      events: [], hours: 0, per_task: {}, hours_by_auditor: {}, sessions: num(prev.matched) + num(prev.quality_gap) + num(prev.off_plan)};
    return REC.measure(p, basis, actualRows, feed, snaps, c.st, c.today, covered ? sessions : null, prevObs);
  }
  function resultRow(c, p, m, store, f) {
    const ob = m.observed, a = m.adherence;
    return {plan_id: p.plan_id, outlet_id: text(p.outlet_id), outlet_name: text(p.outlet_name), region: store ? store.region : '', cohort: store ? store.cohort : '', plan_date: day(p.plan_date),
      confirmed_by: text(p.confirmed_by), severity: text(p.severity), mode: text(p.mode), s_hours: m.suggested.hours, p_hours: m.planned.hours, a_hours: m.actual.hours,
      s_captains: m.suggested.captains, p_captains: m.planned.captains, crew_overlap_pct: a.crew_overlap_pct, plan_vs_suggested_pct: a.plan_vs_suggested_hours_pct,
      actual_vs_planned_pct: a.actual_vs_planned_hours_pct, tasks_done_pct: a.tasks_done_pct, actuals_logged: m.actual.logged ? 'TRUE' : 'FALSE',
      planned_locations: ob ? ob.locations_planned : '', audited_locations: ob ? ob.locations_audited : '', audited_pct: ob && ob.pct !== null ? ob.pct : '',
      matched: ob ? ob.counts.MATCHED : '', quality_gap: ob ? ob.counts.QUALITY_GAP : '', off_plan: ob ? ob.counts.OFF_PLAN : '', baseline: ob ? ob.counts.BASELINE : '',
      planned_items: m.recovery.planned_items, recovered_items: m.recovery.recovered_items, recovered_value: m.recovery.recovered_value, left_feed_value: m.recovery.left_feed_value,
      rupees_per_hour: m.rupees_per_hour === null ? '' : m.rupees_per_hour, t3_state: m.outcome.t3.state, t3_change_pct: m.outcome.t3.change_pct === undefined || m.outcome.t3.change_pct === null ? '' : m.outcome.t3.change_pct,
      t7_state: m.outcome.t7.state, t7_change_pct: m.outcome.t7.change_pct === undefined || m.outcome.t7.change_pct === null ? '' : m.outcome.t7.change_pct,
      outcome: m.outcome.overall, flag: f ? f.code : '', changes: text(p.changes_vs_suggested), updated_at: c.repo.now()};
  }

  // ------------------------------------------------------------------ the whole region (refresh job, and CM / PM before the first refresh)
  function computeAll(c) {
    const repo = c.repo, st = c.st, master = repo.storeMaster(), G = readAll(repo), now = repo.now();
    const ids = scopeIds(c, master, Object.keys(G.raw));
    const slim = repo.rows('PLANS', PLAN_SLIM), live = livePlans(slim), cur = currentPlans(live);
    const from = REC.addDays(c.today, -(st.t7_offset + 1)), oldest = REC.addDays(c.today, -30);
    const want = live.filter(p => (day(p.plan_date) >= from || cur[text(p.outlet_id)] === p) && day(p.plan_date) >= oldest);
    const wantIds = index(want, 'plan_id'), firstRow = want.reduce((v, p) => Math.min(v, p._row || 2), Infinity);
    const basis = {};
    if (want.length) repo.rows('PLANS', ['plan_id', 'frozen'], isFinite(firstRow) ? firstRow : 2).forEach(r => { if (wantIds[text(r.plan_id)]) basis[text(r.plan_id)] = basisFrom(unpackCell(repo, r.frozen)); });
    const actuals = group(repo.rows('ACTUALS')), prevAll = repo.rows('PLAN_RESULTS'), prev = index(prevAll, 'plan_id');
    const reviews = group(repo.rows('CM_REVIEWS'));
    const payloads = {}, results = [], rows = [];
    ids.forEach(id => {
      const D = slice(G, id), p = cur[id], lastCrew = p && basis[p.plan_id] ? basis[p.plan_id].p.map(l => l.captain).filter((x, i, a) => a.indexOf(x) === i) : [];
      payloads[id] = buildPayload(c, id, D, master, lastCrew);
    });
    // Measures for every plan still inside the T+7 window, plus each store's current plan.
    const measures = {};
    want.forEach(p => {
      const id = text(p.outlet_id), P = payloads[id], b = basis[p.plan_id];
      if (!b) return;
      const D = slice(G, id), sessFrom = D.sessions.reduce((v, a) => { const d = day(a.audit_date_ist); return d && (!v || d < v) ? d : v; }, '');
      const m = measurePlan(c, p, b, actuals[id] || [], D.raw, D.snaps, D.sessions, sessFrom, prev[p.plan_id]);
      measures[p.plan_id] = m;
      const f = cur[id] === p ? REC.flag(p, m, c.today, st) : null;
      results.push(resultRow(c, p, m, P ? P.store : null, f));
    });
    // Older results stay as they were last computed (their audit sessions and T+7 are final).
    const liveIds = index(live, 'plan_id');
    prevAll.forEach(r => { if (!measures[text(r.plan_id)] && liveIds[text(r.plan_id)]) results.push(Object.assign({}, r, {_row: undefined})); });
    results.sort((a, b) => text(a.outlet_id).localeCompare(text(b.outlet_id)) || text(a.plan_date).localeCompare(text(b.plan_date)));
    const resBy = group(results), from7 = REC.addDays(c.today, -6);
    ids.forEach(id => {
      const P = payloads[id], p = cur[id] || null, m = p ? measures[p.plan_id] : null;
      const recent = (resBy[id] || []).filter(r => day(r.plan_date) >= from7);
      const sum = k => Math.round(10 * recent.reduce((v, r) => v + num(r[k]), 0)) / 10;
      const aH = sum('a_hours'), rec = recent.reduce((v, r) => v + num(r.recovered_value), 0);
      const old = (G.snaps[id] || []).filter(x => day(x.snapshot_date) <= from7).slice(-1)[0];
      const f = p && m ? REC.flag(p, m, c.today, st) : p && day(p.plan_date) >= oldest ? {code: 'IN_PROGRESS', sev: 3, text: 'Plan confirmed; results after the next refresh.'}
        : p ? {code: 'NO_PLAN', sev: 2, text: 'No recovery plan in the last 30 days.'} : REC.flag(null, null, c.today, st);
      const rv = (reviews[id] || []).slice(-1)[0] || null;
      rows.push({outlet_id: id, outlet_name: P.store.outlet_name, region: P.store.region, cluster: P.store.cluster, cohort: P.store.cohort, cm_sm: P.store.cm_sm,
        pending: Math.round(P.summary.total_absolute_pending), p0: P.summary.priority_counts.P0, severity: P.severity.tier, capacity: P.severity.capacity, mode: P.diagnosis.mode,
        full_recon: P.diagnosis.full_recon, feed_date: P.summary.feed_date, worklist_value: Math.round(P.summary.worklist_value), tasks: P.diagnosis.tasks.length,
        hours_to_clear: P.diagnosis.total_hours, top_rack: P.diagnosis.top_racks[0] ? P.diagnosis.top_racks[0].rack : '', top_rack_value: P.diagnosis.top_racks[0] ? P.diagnosis.top_racks[0].value : '',
        on_floor_now: P.presence.on_floor_now, in_today: P.presence.in_today, latest_audit: P.presence.latest_audit,
        plan: p ? {plan_id: p.plan_id, plan_date: day(p.plan_date), changes: text(p.changes_vs_suggested), confirmed_by: text(p.confirmed_by)} : null, flag: f,
        last_review: rv ? {reviewed_at: text(rv.reviewed_at), reviewed_by: text(rv.reviewed_by), decision: text(rv.decision), owner: text(rv.owner)} : null,
        window: {days: 7, plans: recent.length, suggested_hours: sum('s_hours'), planned_hours: sum('p_hours'), actual_hours: aH, recovered_value: Math.round(rec),
          rupees_per_hour: aH ? Math.round(rec / aH) : null, pending_then: old ? num(old.total_absolute_pending) : null},
        refreshed_at: now});
    });
    // Daily snapshot (baseline for T+3 / T+7), once a day after snapshot_hour.
    const haveSnap = {};
    Object.keys(G.snaps).forEach(id => { if (G.snaps[id].some(s => day(s.snapshot_date) === c.today)) haveSnap[id] = true; });
    const snaps = Number(now.slice(11, 13)) >= st.snapshot_hour ? ids.filter(id => !haveSnap[id] && payloads[id].summary.feed_date).map(id => {
      const P = payloads[id];
      return {snapshot_date: c.today, outlet_id: id, total_absolute_pending: Math.round(P.summary.total_absolute_pending), worklist_value: Math.round(P.summary.worklist_value),
        worklist_skus: P.summary.worklist_skus, p0: P.summary.priority_counts.P0, severity: P.severity.tier, mode: P.diagnosis.mode, feed_date: P.summary.feed_date};
    }) : [];
    // Goodness metrics: last 14 days for ALL, each region and each pilot cohort.
    const views = {};
    repo.tail('ACTION_LOG', 8000).forEach(r => { if (text(r.action) === 'VIEW_STORE') { const d = day(r.at), k = d + '|' + text(r.outlet_id); views[k] = (views[k] || 0) + 1; } });
    const scopes = {ALL: rows};
    rows.forEach(r => { (scopes['region:' + r.region] = scopes['region:' + r.region] || []).push(r); if (r.cohort) (scopes['cohort:' + r.cohort] = scopes['cohort:' + r.cohort] || []).push(r); });
    const metrics = [];
    for (let i = 13; i >= 0; i--) {
      const d = REC.addDays(c.today, -i);
      Object.keys(scopes).forEach(k => {
        const inScope = index(scopes[k], 'outlet_id'), res = results.filter(r => inScope[text(r.outlet_id)]);
        const v = Object.keys(inScope).filter(id => views[d + '|' + id]).length;
        metrics.push(Object.assign({scope: k}, REC.goodness(res, scopes[k], d, v)));
      });
    }
    const regionRph = {};
    Object.keys(scopes).filter(k => /^region:/.test(k)).forEach(k => { regionRph[k.slice(7)] = REC.median(scopes[k].map(r => r.window.rupees_per_hour).filter(x => x !== null)); });
    return {ids, payloads, rows, results, snaps, metrics, regionRph, plans_measured: Object.keys(measures).length};
  }

  /** Hourly job. Never runs twice at once (script lock); every run is logged to JOB_RUNS. */
  function refresh(repo) {
    const c = ctx(repo, true), t0 = Date.now(), runId = 'R' + repo.now().replace(/\D/g, '');
    repo.append('JOB_RUNS', [{run_id: runId, at: repo.now(), status: 'RUNNING'}]);
    try {
      const out = computeAll(c);
      const state = out.rows.map(r => {
        const parts = repo.pack(out.payloads[r.outlet_id]);
        if (parts.length > PARTS) fail('store ' + r.outlet_id + ' screen is too large to store (' + parts.length + ' cells)');
        const o = {outlet_id: r.outlet_id, outlet_name: r.outlet_name, region: r.region, cluster: r.cluster, cm_sm: r.cm_sm, cohort: r.cohort, refreshed_at: r.refreshed_at,
          feed_date: r.feed_date, severity: r.severity, capacity: r.capacity || '', pending: r.pending, worklist_value: r.worklist_value, p0: r.p0, mode: r.mode,
          full_recon: r.full_recon ? 'TRUE' : 'FALSE', tasks: r.tasks, hours_to_clear: r.hours_to_clear, top_rack: r.top_rack, top_rack_value: r.top_rack_value,
          on_floor_now: r.on_floor_now, in_today: r.in_today, plan_id: r.plan ? r.plan.plan_id : '', plan_date: r.plan ? r.plan.plan_date : '', flag: r.flag.code,
          row_json: JSON.stringify(r), payload_parts: parts.length};
        parts.forEach((s, i) => { o[PAYLOAD[i]] = s; });
        return o;
      });
      state.sort((a, b) => text(a.region).localeCompare(text(b.region)) || text(a.outlet_id).localeCompare(text(b.outlet_id)));
      const keepOld = repo.rows('METRICS_DAILY').filter(r => day(r.date) < REC.addDays(c.today, -13)).map(r => Object.assign({}, r, {_row: undefined}));
      repo.lock(() => {
        repo.writeAll('STORE_STATE', state);
        repo.writeAll('PLAN_RESULTS', out.results);
        repo.writeAll('METRICS_DAILY', keepOld.concat(out.metrics));
        if (out.snaps.length) repo.append('DAILY', out.snaps);
      });
      repo.setProp('REGION_RPH', JSON.stringify(out.regionRph));
      repo.setProp('RE_LAST_REFRESH', repo.now());
      const info = {run_id: runId, status: 'OK', seconds: Math.round((Date.now() - t0) / 100) / 10, stores: out.ids.length, plans_measured: out.plans_measured,
        detail: out.snaps.length + ' snapshots; ' + out.rows.filter(r => r.flag.sev === 1).length + ' stores flagged'};
      repo.append('JOB_RUNS', [Object.assign({at: repo.now()}, info)]);
      return info;
    } catch (e) {
      repo.append('JOB_RUNS', [{run_id: runId, at: repo.now(), status: 'FAILED', seconds: Math.round((Date.now() - t0) / 100) / 10, detail: String(e && e.message || e).slice(0, 400)}]);
      throw e;
    }
  }

  // ------------------------------------------------------------------ boot
  function boot(repo) {
    const c = ctx(repo), master = repo.storeMaster(), rawIds = Object.keys(master).filter(k => master[k].in_feed);
    const state = repo.rows('STORE_STATE', ['outlet_id', 'outlet_name', 'region', 'severity']);
    const ids = allowedIds(c, master, state.length ? state.map(r => text(r.outlet_id)) : scopeIds(c, master, rawIds));
    const st = index(state, 'outlet_id'), coh = index(repo.health(), 'outlet_id');
    return {
      build: REC.BUILD, me: c.me, role: c.role, today: c.today, settings_errors: c.errors, refreshed_at: repo.getProp('RE_LAST_REFRESH') || '',
      settings: {recovery_app_url: c.st.recovery_app_url, max_hours_per_captain: c.st.max_hours_per_captain, t3_offset: c.st.t3_offset, t7_offset: c.st.t7_offset},
      stores: ids.map(id => ({outlet_id: id, outlet_name: (st[id] && text(st[id].outlet_name)) || (master[id] || {}).outlet_name || id,
        region: (st[id] && text(st[id].region)) || regionOf(master[id], coh[id]), severity: st[id] ? text(st[id].severity) : ''}))
    };
  }
  /** Cheap call the page makes every few minutes to know whether newer data exists. */
  function ping(repo) { return {refreshed_at: repo.getProp('RE_LAST_REFRESH') || '', build: REC.BUILD}; }

  // ------------------------------------------------------------------ SM store view
  function store(repo, outletId) {
    const c = ctx(repo), id = text(outletId), master = repo.storeMaster();
    canSee(c, id, master);
    const plans = repo.rowsWhere('PLANS', 'outlet_id', id, 14), live = livePlans(plans), cur = currentPlans(live)[id] || null;
    let P = statePayload(repo, id), isLive = false;
    if (!P) {
      const b = cur ? basisOf(repo, cur) : null;
      P = buildPayload(c, id, sliceLive(repo, id), master, b ? b.p.map(l => l.captain) : []);
      isLive = true;
    }
    if (repo.once('view_' + c.me + '_' + id + '_' + c.today, 6 * 3600)) log(c, 'VIEW_STORE', id, '', c.role);
    const actuals = repo.rowsWhere('ACTUALS', 'outlet_id', id, 80), prev = index(repo.rowsWhere('PLAN_RESULTS', 'outlet_id', id, 30), 'plan_id');
    const sessFrom = P.sessions_from && P.sessions_from > REC.addDays(c.today, -1) ? P.sessions_from : REC.addDays(c.today, -1);
    const feed = feedRows(P, id), sess = sessionRows(P, id);
    const mOf = p => measurePlan(c, p, basisOf(repo, p), actuals, feed, P.snaps, sess, sess.length ? sessFrom : '', prev[p.plan_id]);
    const history = live.slice(-6).reverse().map(mOf);
    let todayPlan = null;
    if (cur && day(cur.plan_date) === c.today) {
      const fz = unpackCell(repo, cur.frozen) || {tasks: [], p: []};
      todayPlan = {plan: Object.assign({}, cur, {frozen: undefined, _row: undefined}), tasks: fz.tasks, lines: fz.p,
        measure: history.find(x => x.plan_id === cur.plan_id) || mOf(cur)};
    }
    let regional = {};
    try { regional = JSON.parse(repo.getProp('REGION_RPH') || '{}'); } catch (e) { regional = {}; }
    const last = history.find(x => x.actual.logged);
    return {
      store: P.store, freshness: REC.freshness(P.summary.feed_date, c.today, c.st), summary: P.summary, severity: P.severity, diagnosis: P.diagnosis,
      roster: P.roster, suggestion: P.suggestion, presence: P.presence, refreshed_at: P.refreshed_at, live: isLive, sops: sopMap(repo),
      settings: c.st, today_plan: todayPlan, history: history.map(h => Object.assign({}, h, {plan_date: day(h.plan_date)})),
      nudge: last ? REC.nudge(last.rupees_per_hour, regional[P.store.region] === undefined ? null : regional[P.store.region], P.diagnosis.mode) : ''
    };
  }

  // ------------------------------------------------------------------ confirm
  /** req: {outlet_id, feed_date, crew:[{name,hours}], skip:[task_id], pin:[task_id], window, token}. The SM is never asked why; changes vs the suggestion are recorded automatically. */
  function confirm(repo, req) {
    const c = ctx(repo), id = text(req.outlet_id), master = repo.storeMaster();
    canSee(c, id, master);
    if (!firstTime(repo, req.token)) return {plan_id: '', duplicate: true, view: store(repo, id)};
    const P = statePayload(repo, id) || buildPayload(c, id, sliceLive(repo, id), master, []);
    if (text(req.feed_date) !== text(P.summary.feed_date)) fail('The variance feed refreshed since you opened the plan. Reload and check again.');
    const crew = (req.crew || []).filter(x => text(x.name) && num(x.hours) > 0);
    if (!crew.length) fail('Add at least one captain with hours.');
    const names = {};
    crew.forEach(x => {
      const k = text(x.name).toLowerCase();
      if (names[k]) fail('Captain ' + x.name + ' is listed twice.');
      names[k] = true;
      if (num(x.hours) > c.st.max_hours_per_captain) fail(x.name + ': max ' + c.st.max_hours_per_captain + ' h per captain.');
    });
    const tasks = P.diagnosis.tasks, planned = REC.allocate(tasks, crew, P.roster, req.skip || [], req.pin || []);
    if (!planned.lines.length) fail('Nothing would be planned. Add hours or un-skip tasks.');
    const sugg = REC.allocate(tasks, P.suggestion.crew, P.roster, []), changes = REC.planDiff(sugg, planned);
    const byId = index(tasks, 'task_id'), covered = planned.lines.map(l => l.task_id).filter((x, i, a) => a.indexOf(x) === i).map(tid => byId[tid]);
    const frozen = {s: sugg.lines, p: planned.lines, tasks: covered.map(t => Object.assign({}, t, {items: t.items.map(it => ({item_id: it.item_id, item_name: String(it.item_name).slice(0, 80),
      upc: it.upc, priority: it.priority, variance: it.variance, variance_qty: it.variance_qty, audit_increment_qty: it.audit_increment_qty, source: it.source}))}))};
    const items = basisFrom(frozen).items;
    const out = repo.lock(() => {
      const plans = repo.rowsWhere('PLANS', 'outlet_id', id, 30), sameDay = plans.filter(p => day(p.plan_date) === c.today);
      const prior = currentPlans(sameDay)[id];
      const v = sameDay.length + 1, planId = 'P-' + id + '-' + c.today.replace(/-/g, '') + '-V' + v, m = master[id] || {};
      repo.append('PLANS', [{plan_id: planId, version: v, status: 'CONFIRMED', outlet_id: id, outlet_name: m.outlet_name || P.store.outlet_name || id, plan_date: c.today,
        window: text(req.window), confirmed_at: repo.now(), confirmed_by: c.me, feed_date: P.summary.feed_date, suggested_hours: sugg.used_hours, planned_hours: planned.used_hours,
        changes_vs_suggested: changes, supersedes: prior ? prior.plan_id : '', baseline_pending: Math.round(P.summary.total_absolute_pending), severity: P.severity.tier,
        mode: P.diagnosis.mode, pinned: planned.pinned.join(','), build: REC.BUILD,
        frozen: packCell(repo, frozen, f => { f.tasks.forEach(t => { t.items = t.items.slice(0, 25); }); })}]);
      const lineRows = (kind, lines) => lines.map(l => {
        const t = byId[l.task_id];
        return {plan_id: planId, plan_date: c.today, outlet_id: id, kind, task_id: l.task_id, level: t.level, target: t.target, captain: l.captain, hours: l.hours, share: l.share,
          est_hours: t.est_hours, locations: t.location_count, items: t.item_count, value: Math.round(t.value)};
      });
      repo.append('PLAN_TASKS', lineRows('S', sugg.lines).concat(lineRows('P', planned.lines)));
      repo.append('PLAN_ITEMS', items.map(it => Object.assign({plan_id: planId, plan_date: c.today, outlet_id: id}, it)));
      log(c, prior ? 'PLAN_REPLACED' : 'PLAN_CONFIRMED', id, planId, 'Planned ' + planned.used_hours + 'h vs suggested ' + sugg.used_hours + 'h · crew: ' +
        crew.map(x => x.name + ' ' + x.hours + 'h').join(', ') + ((req.skip || []).length ? ' · skipped ' + req.skip.length + ' tasks' : '') +
        (planned.pinned.length ? ' · first: ' + planned.pinned.join(' ') : '') + (changes ? ' · changes: ' + changes : ' · same as suggested') + (prior ? ' · replaces ' + prior.plan_id : ''));
      return planId;
    });
    return {plan_id: out, view: store(repo, id)};
  }

  // ------------------------------------------------------------------ close shift
  /** req: {plan_id, rows:[{captain, actual_hours, tasks:{task_id:DONE|PARTIAL|NOT_DONE}, note}]} */
  function actuals(repo, req) {
    const c = ctx(repo), plan = repo.rowsWhere('PLANS', 'plan_id', text(req.plan_id), 1)[0];
    if (!plan) fail('Plan not found.');
    canSee(c, plan.outlet_id, repo.storeMaster());
    if (!firstTime(repo, req.token)) return store(repo, plan.outlet_id);
    const rows = (req.rows || []).filter(r => text(r.captain));
    if (!rows.length) fail('Log at least one captain.');
    rows.forEach(r => { const h = Number(r.actual_hours); if (!isFinite(h) || h < 0 || h > 12) fail('Actual hours for ' + r.captain + ' must be 0 to 12.'); });
    repo.lock(() => repo.append('ACTUALS', rows.map(r => ({plan_id: plan.plan_id, outlet_id: text(plan.outlet_id), plan_date: day(plan.plan_date), captain: text(r.captain),
      actual_hours: Number(r.actual_hours), tasks_json: JSON.stringify(r.tasks || {}), note: text(r.note), logged_by: c.me, logged_at: repo.now()}))));
    log(c, 'ACTUALS_LOGGED', plan.outlet_id, plan.plan_id, rows.map(r => r.captain + ' ' + r.actual_hours + 'h').join(', '));
    return store(repo, plan.outlet_id);
  }

  // ------------------------------------------------------------------ print sheets
  /** One printable page per captain for a confirmed plan. Created once per plan; later calls return the same file. */
  function exportPlan(repo, planId) {
    const c = ctx(repo), plan = repo.rowsWhere('PLANS', 'plan_id', text(planId), 1)[0];
    if (!plan) fail('Plan not found.');
    canSee(c, plan.outlet_id, repo.storeMaster());
    const fz = unpackCell(repo, plan.frozen) || {tasks: [], p: []}, p = Object.assign({}, plan, {plan_date: day(plan.plan_date)});
    const pages = REC.printPages(p, fz.tasks, fz.p, sopMap(repo), text(plan.outlet_name));
    let file = null;
    try { file = JSON.parse(repo.getProp('EXP_' + plan.plan_id) || 'null'); } catch (e) { file = null; }
    if (!file) {
      file = repo.lock(() => repo.exportSheet('Recovery ' + plan.outlet_name + ' ' + p.plan_date + ' (' + plan.plan_id + ')', pages, c.st.export_folder_id));
      if (file && file.url) { repo.setProp('EXP_' + plan.plan_id, JSON.stringify(file)); log(c, 'PRINT_SHEET_CREATED', plan.outlet_id, plan.plan_id, file.url); }
    }
    return {file, pages};
  }

  // ------------------------------------------------------------------ CM + tower (read the refresh job's output)
  function storeRows(c) {
    const repo = c.repo, master = repo.storeMaster();
    let rows = repo.rows('STORE_STATE', ['outlet_id', 'row_json']).map(r => { try { return JSON.parse(text(r.row_json)); } catch (e) { return null; } }).filter(Boolean);
    let fresh = repo.getProp('RE_LAST_REFRESH') || '';
    if (!rows.length) { rows = computeAll(Object.assign({}, c, {outlets: null, regions: null})).rows; fresh = repo.now() + ' (live)'; }
    const ok = index(allowedIds(c, master, rows.map(r => r.outlet_id)).map(id => ({id})), 'id');
    rows = rows.filter(r => ok[r.outlet_id]);
    // Plans confirmed since the last refresh show straight away.
    const todays = currentPlans(livePlans(repo.rowsWhere('PLANS', 'plan_date', c.today)));
    const rv = group(repo.tail('CM_REVIEWS', 2000));
    rows.forEach(r => {
      const p = todays[r.outlet_id];
      if (p && (!r.plan || r.plan.plan_id !== p.plan_id)) {
        r.plan = {plan_id: p.plan_id, plan_date: c.today, changes: text(p.changes_vs_suggested), confirmed_by: text(p.confirmed_by)};
        r.flag = {code: 'IN_PROGRESS', sev: 3, text: 'Plan for today is running.'};
      }
      const last = (rv[r.outlet_id] || []).slice(-1)[0];
      if (last) r.last_review = {reviewed_at: text(last.reviewed_at), reviewed_by: text(last.reviewed_by), decision: text(last.decision), owner: text(last.owner)};
    });
    return {rows, refreshed_at: fresh};
  }
  function cm(repo) {
    const c = ctx(repo);
    need(c, ['CM', 'PM']);
    const s = storeRows(c);
    s.rows.sort((a, b) => a.flag.sev - b.flag.sev || b.pending - a.pending);
    return {rows: s.rows, refreshed_at: s.refreshed_at, decisions: ['Coach SM on plan', 'Ask SM to re-plan', 'Send support captain', 'Escalate to SLP', 'Escalate to Ops head', 'Monitor']};
  }
  function cmReview(repo, req) {
    const c = ctx(repo);
    need(c, ['CM', 'PM']);
    if (!text(req.outlet_id) || !text(req.decision)) fail('Store and decision are required.');
    canSee(c, req.outlet_id, repo.storeMaster());
    if (text(req.decision) !== 'Monitor' && !text(req.owner)) fail('Name an owner for this action.');
    repo.lock(() => repo.append('CM_REVIEWS', [{reviewed_at: repo.now(), reviewed_by: c.me, outlet_id: text(req.outlet_id), plan_id: text(req.plan_id), flag: text(req.flag),
      decision: text(req.decision), owner: text(req.owner), next_review: text(req.next_review), note: text(req.note)}]));
    log(c, 'CM_DECISION', req.outlet_id, req.plan_id, text(req.decision) + (text(req.owner) ? ' · owner ' + text(req.owner) : '') + (text(req.note) ? ' · ' + text(req.note) : ''));
    return cm(repo);
  }
  function tower(repo) {
    const c = ctx(repo);
    need(c, ['PM']);
    const s = storeRows(c), rows = s.rows, regions = {};
    rows.forEach(r => {
      const g = regions[r.region] = regions[r.region] || {region: r.region, stores: 0, broken: 0, at_risk: 0, sorted: 0, planned_stores: 0, suggested_hours: 0, planned_hours: 0,
        actual_hours: 0, recovered_value: 0, pending: 0, pending_then: 0, flags: 0, on_floor_now: 0, rph: []};
      g.stores++;
      g[r.severity === 'BROKEN' || r.severity === 'SEVERELY_BROKEN' ? 'broken' : r.severity === 'AT_RISK' ? 'at_risk' : 'sorted']++;
      if (r.window.plans) g.planned_stores++;
      ['suggested_hours', 'planned_hours', 'actual_hours', 'recovered_value'].forEach(k => { g[k] += r.window[k]; });
      g.pending += r.pending;
      g.pending_then += r.window.pending_then !== null ? r.window.pending_then : r.pending;
      g.on_floor_now += num(r.on_floor_now);
      if (r.flag.sev === 1) g.flags++;
      if (r.window.rupees_per_hour !== null) g.rph.push(r.window.rupees_per_hour);
    });
    const list = Object.keys(regions).sort().map(k => {
      const g = regions[k];
      g.rupees_per_hour = g.actual_hours ? Math.round(g.recovered_value / g.actual_hours) : null;
      g.median_store_rph = REC.median(g.rph);
      delete g.rph;
      ['suggested_hours', 'planned_hours', 'actual_hours'].forEach(x => { g[x] = Math.round(g[x] * 10) / 10; });
      g.pending_change_pct = g.pending_then ? Math.round(1000 * (g.pending - g.pending_then) / g.pending_then) / 10 : null;
      return g;
    });
    const cohort = {};
    rows.forEach(r => {
      const k = r.cohort || '(no cohort)', g = cohort[k] = cohort[k] || {cohort: k, stores: 0, actual_hours: 0, recovered_value: 0, pending: 0, pending_then: 0};
      g.stores++; g.actual_hours += r.window.actual_hours; g.recovered_value += r.window.recovered_value; g.pending += r.pending;
      g.pending_then += r.window.pending_then === null ? r.pending : r.window.pending_then;
    });
    const from = REC.addDays(c.today, -13);
    const metrics = repo.rows('METRICS_DAILY').filter(m => day(m.date) >= from).map(m => Object.assign({}, m, {date: day(m.date), _row: undefined}));
    return {regions: list, cohorts: Object.keys(cohort).map(k => cohort[k]), rows, metrics, refreshed_at: s.refreshed_at};
  }

  /** PM monitoring: is the job running, is the data fresh, are people using it, what is failing. */
  function monitor(repo) {
    const c = ctx(repo);
    need(c, ['PM']);
    const tailRuns = repo.tail('JOB_RUNS', 60), done = {};
    tailRuns.forEach(r => { if (text(r.status) !== 'RUNNING') done[text(r.run_id)] = true; });
    const runs = tailRuns.filter(r => text(r.status) !== 'RUNNING' || !done[text(r.run_id)]).reverse(), logs = repo.tail('ACTION_LOG', 5000), since = REC.addDays(c.today, -1);
    const errors = logs.filter(r => text(r.action) === 'ERROR' && day(r.at) >= since).reverse().slice(0, 80);
    const todayLog = logs.filter(r => day(r.at) === c.today), uniq = f => todayLog.filter(f).map(r => text(r.by)).filter((x, i, a) => a.indexOf(x) === i).length;
    const users = repo.users(), byRole = {};
    users.forEach(u => { const r = text(u.role).toUpperCase() || 'SM'; byRole[r] = (byRole[r] || 0) + 1; });
    const lastOk = runs.find(r => text(r.status) === 'OK') || null;
    return {runs: runs.slice(0, 40), last_ok: lastOk, running: runs[0] && text(runs[0].status) === 'RUNNING' ? runs[0] : null, health: repo.healthRows(), errors,
      usage: {users_today: uniq(() => true), store_views_today: todayLog.filter(r => text(r.action) === 'VIEW_STORE').length,
        plans_today: todayLog.filter(r => text(r.action) === 'PLAN_CONFIRMED' || text(r.action) === 'PLAN_REPLACED').length,
        actuals_today: todayLog.filter(r => text(r.action) === 'ACTUALS_LOGGED').length, users_listed: byRole}, now: repo.now()};
  }

  // ------------------------------------------------------------------ settings (PM edits in the app; same values as the CFG tab)
  function settingsView(repo) {
    const c = ctx(repo);
    need(c, ['PM']);
    const cur = {};
    repo.settingsRows().forEach(r => { cur[text(r.key)] = text(r.value); });
    return {errors: c.errors, rows: REC.SETTINGS.map(s => ({key: s.key, label: s.label, type: s.type, default: String(s.def), value: cur[s.key] || '', effective: String(c.st[s.key])})),
      log: repo.tail('ACTION_LOG', 60).filter(r => text(r.action) !== 'VIEW_STORE').reverse().slice(0, 40)};
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

  return {H, PAYLOAD, boot, ping, store, confirm, actuals, exportPlan, cm, cmReview, tower, monitor, refresh, daily: refresh, computeAll, settingsView, settingsSave};
}

// ===== END OF Service.gs. If this line is the last line in Apps Script, the paste is complete. =====
