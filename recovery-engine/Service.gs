/**
 * Recovery Engine v2 | Service (orchestration)
 * Talks only to a `repo` object, never to SpreadsheetApp directly, so the same code runs on the
 * real sheet (Server.gs), in Node tests and in the browser preview (in-memory repo).
 *
 * repo contract:
 *   me() today() now() raw() storeMaster() health() captains() locations() audits() sops()
 *   rows(tab) append(tab, objs) getProp(key) setProp(key, value) settingsRows() lock(fn)
 */
function RE_SERVICE_FACTORY(REC) {
  'use strict';
  const H = {
    PLANS: ['plan_id', 'version', 'status', 'outlet_id', 'outlet_name', 'plan_date', 'window', 'confirmed_at', 'confirmed_by', 'feed_date',
      'suggested_hours', 'planned_hours', 'deviation_reason', 'supersedes', 'baseline_pending', 'severity', 'mode', 'build'],
    PLAN_TASKS: ['plan_id', 'kind', 'task_id', 'level', 'target', 'captain', 'hours', 'share', 'est_hours', 'locations', 'items', 'value', 'detail_json'],
    PLAN_ITEMS: ['plan_id', 'item_id', 'item_name', 'task_id', 'priority', 'baseline_variance', 'baseline_variance_qty', 'baseline_increment_qty'],
    ACTUALS: ['plan_id', 'outlet_id', 'captain', 'actual_hours', 'tasks_json', 'note', 'logged_by', 'logged_at'],
    CM_REVIEWS: ['reviewed_at', 'reviewed_by', 'outlet_id', 'plan_id', 'flag', 'decision', 'owner', 'next_review', 'note'],
    DAILY: ['snapshot_date', 'outlet_id', 'total_absolute_pending', 'worklist_value', 'worklist_skus', 'p0', 'severity', 'mode', 'feed_date']
  };
  const DEVIATION = ['Captain absent', 'Captain needed for other work', 'Inbound / GRN load', 'High order load', 'Ground knowledge: different racks', 'Other'];
  const text = x => (x === null || x === undefined) ? '' : String(x).trim();
  const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
  const fail = m => { throw new Error('RE: ' + m); };

  function ctx(repo) {
    const r = REC.resolveSettings(repo.settingsRows()), me = repo.me();
    return {repo, st: r.settings, errors: r.errors, me, role: REC.role(r.settings, me), today: repo.today()};
  }
  const need = (c, roles) => { if (roles.indexOf(c.role) < 0) fail('This needs role ' + roles.join('/') + '. You are ' + c.role + '.'); };

  function sopMap(repo) {
    const m = {};
    repo.sops().slice().sort((a, b) => num(a.step_no) - num(b.step_no)).forEach(s => { const k = text(s.level).toUpperCase(); (m[k] = m[k] || []).push(text(s.step)); });
    return m;
  }
  function healthOf(repo, id) {
    const h = repo.health().find(x => text(x.outlet_id) === text(id)) || {};
    return Object.assign({}, h, {cohort: text(h.cohort) || text(h.cohort_role)});
  }
  /** The employee export has one row per snapshot_date; keep the latest row per employee. */
  function latestRoster(rows) {
    const by = {};
    rows.forEach(r => { const k = text(r.employee_id) || text(r.captain_id) || text(r.captain_name) || text(r.employee_name); if (!by[k] || text(r.snapshot_date) >= text(by[k].snapshot_date)) by[k] = r; });
    return Object.keys(by).map(k => by[k]).filter(r => !text(r.designation) || /captain|auditor|associate/i.test(text(r.designation)));
  }
  function regionOf(repo, id, master) {
    const h = healthOf(repo, id), m = master[text(id)] || {};
    return text(h.region) || m.cluster || m.city || 'Unassigned';
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
    const sev = REC.severity(wl.summary, healthOf(c.repo, outletId), c.st);
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
  function boot(repo) {
    const c = ctx(repo), master = repo.storeMaster();
    let ids = text(c.st.pilot_outlets) ? text(c.st.pilot_outlets).split(',') : null;
    if (!ids) { const s = {}; repo.raw().forEach(r => { if (text(r.outlet_id)) s[text(r.outlet_id)] = true; }); ids = Object.keys(s).sort(); }
    return {
      build: REC.BUILD, me: c.me, role: c.role, today: c.today, settings_errors: c.errors, deviation_reasons: DEVIATION,
      settings: {recovery_app_url: c.st.recovery_app_url, max_hours_per_captain: c.st.max_hours_per_captain, t3_offset: c.st.t3_offset, t7_offset: c.st.t7_offset},
      stores: ids.map(id => ({outlet_id: id, outlet_name: (master[id] || {}).outlet_name || id, region: regionOf(repo, id, master)}))
    };
  }

  // ------------------------------------------------------------------ SM store view
  function store(repo, outletId) {
    const c = ctx(repo), raw = repo.raw(), master = repo.storeMaster(), m = master[text(outletId)] || {}, h = healthOf(repo, outletId);
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
      store: {outlet_id: text(outletId), outlet_name: m.outlet_name || text(outletId), city: m.city || '', region, cm_sm: m.cm_sm || '', cohort: text(h.cohort), low_order_window: text(h.low_order_window)},
      freshness: REC.freshness(a.wl.summary.feed_date, c.today, c.st), summary: a.wl.summary, severity: a.sev, diagnosis: a.diag,
      roster: a.roster, suggestion: {budget_hours: a.suggestion.budget_hours, crew: a.suggestion.crew}, sops: sopMap(repo),
      settings: c.st, today_plan: todayPlan, history,
      nudge: last ? REC.nudge(last.rupees_per_hour, regional[region] === undefined ? null : regional[region], a.diag.mode) : ''
    };
  }

  // ------------------------------------------------------------------ confirm
  /** req: {outlet_id, feed_date, crew:[{name,hours}], skip:[task_id], deviation_reason, window, replace_reason} */
  function confirm(repo, req) {
    const c = ctx(repo), raw = repo.raw(), id = text(req.outlet_id), a = analyse(c, id, raw);
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
    const sugg = a.suggestion.plan;
    const deviates = REC.stableHash(JSON.stringify(sugg.lines)) !== REC.stableHash(JSON.stringify(planned.lines));
    if (deviates && !text(req.deviation_reason)) fail('Your plan differs from the suggestion. Pick a reason so the CM sees your call.');
    const out = repo.lock(() => {
      const plans = repo.rows('PLANS').filter(p => text(p.outlet_id) === id);
      const sameDay = plans.filter(p => text(p.plan_date) === c.today);
      const prior = currentPlans(sameDay)[id];
      if (prior && !text(req.replace_reason)) fail('A plan is already confirmed today. Give a reason to replace it.');
      const v = sameDay.length + 1, planId = 'P-' + id + '-' + c.today.replace(/-/g, '') + '-V' + v;
      const m = repo.storeMaster()[id] || {};
      repo.append('PLANS', [{plan_id: planId, version: v, status: 'CONFIRMED', outlet_id: id, outlet_name: m.outlet_name || id, plan_date: c.today,
        window: text(req.window), confirmed_at: repo.now(), confirmed_by: c.me, feed_date: a.wl.summary.feed_date,
        suggested_hours: sugg.used_hours, planned_hours: planned.used_hours, deviation_reason: deviates ? text(req.deviation_reason) : '',
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
      return planId;
    });
    return {plan_id: out, view: store(repo, id)};
  }

  // ------------------------------------------------------------------ close shift
  /** req: {plan_id, rows:[{captain, actual_hours, tasks:{task_id:DONE|PARTIAL|NOT_DONE}, note}]} */
  function actuals(repo, req) {
    const c = ctx(repo), plan = repo.rows('PLANS').find(p => p.plan_id === text(req.plan_id));
    if (!plan) fail('Plan not found.');
    const rows = (req.rows || []).filter(r => text(r.captain));
    if (!rows.length) fail('Log at least one captain.');
    rows.forEach(r => { const h = Number(r.actual_hours); if (!isFinite(h) || h < 0 || h > 12) fail('Actual hours for ' + r.captain + ' must be 0 to 12.'); });
    repo.lock(() => repo.append('ACTUALS', rows.map(r => ({plan_id: plan.plan_id, outlet_id: plan.outlet_id, captain: text(r.captain), actual_hours: Number(r.actual_hours),
      tasks_json: JSON.stringify(r.tasks || {}), note: text(r.note), logged_by: c.me, logged_at: repo.now()}))));
    return store(repo, plan.outlet_id);
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
    const repo = c.repo, raw = repo.raw(), master = repo.storeMaster(), b = boot(repo);
    const plans = livePlans(repo.rows('PLANS')).filter(p => text(p.status) === 'CONFIRMED'), cur = currentPlans(plans), reviews = repo.rows('CM_REVIEWS');
    const from = REC.addDays(c.today, -(days - 1)), snaps = repo.rows('DAILY');
    const snapList = [];
    const rows = b.stores.map(s => {
      const wl = REC.worklist(raw, s.outlet_id, c.st), diag = REC.diagnose(wl, c.st, repo.locations().filter(l => text(l.outlet_id) === s.outlet_id)), sev = REC.severity(wl.summary, healthOf(repo, s.outlet_id), c.st);
      const p = cur[s.outlet_id] || null, m = p ? measureFor(c, p, raw) : null;
      const recent = plans.filter(x => x.outlet_id === s.outlet_id && text(x.plan_date) >= from).map(x => measureFor(c, x, raw));
      const sum = k => Math.round(10 * recent.reduce((v, x) => v + x[k].hours, 0)) / 10;
      const actH = sum('actual'), rec = recent.reduce((v, x) => v + x.recovery.recovered_value, 0);
      snapList.push({id: s.outlet_id, wl, sev, diag});
      const old = snaps.filter(x => x.outlet_id === s.outlet_id && REC.day(x.snapshot_date) <= from).slice(-1)[0];
      return {outlet_id: s.outlet_id, outlet_name: s.outlet_name, region: s.region, cohort: text(healthOf(repo, s.outlet_id).cohort), cm_sm: (master[s.outlet_id] || {}).cm_sm || '',
        pending: Math.round(wl.summary.total_absolute_pending), p0: wl.summary.priority_counts.P0, severity: sev.tier, mode: diag.mode, full_recon: diag.full_recon,
        plan: p ? {plan_id: p.plan_id, plan_date: p.plan_date, deviation_reason: p.deviation_reason, confirmed_by: p.confirmed_by} : null, measure: m,
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
    return cm(repo);
  }
  function tower(repo) {
    const c = ctx(repo);
    need(c, ['PM']);
    const rows = storeRows(c, 7), regions = {};
    rows.forEach(r => {
      const g = regions[r.region] = regions[r.region] || {region: r.region, stores: 0, broken: 0, at_risk: 0, sorted: 0, planned_stores: 0, suggested_hours: 0, planned_hours: 0,
        actual_hours: 0, recovered_value: 0, pending: 0, pending_then: 0, flags: 0, rph: []};
      g.stores++;
      g[r.severity === 'BROKEN' ? 'broken' : r.severity === 'AT_RISK' ? 'at_risk' : 'sorted']++;
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
  function daily(repo) { return tower(Object.assign({}, repo, {me: () => (REC.resolveSettings(repo.settingsRows()).settings.pm_emails.split(',')[0])})).regions.length; }

  return {H, DEVIATION, boot, store, confirm, actuals, cm, cmReview, tower, daily};
}
