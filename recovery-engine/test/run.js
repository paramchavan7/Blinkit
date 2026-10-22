/** End-to-end test of Core + Service on the fixture: SM plan -> confirm -> actuals -> refresh job -> CM -> tower -> monitor. Run: node test/run.js */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'IRD_Core.gs'), 'utf8').replace(/if \(typeof module[^\n]*/, ''));
vm.runInThisContext(fs.readFileSync(path.join(root, 'IRD_Service.gs'), 'utf8'));
const sopSrc = /var RE_DEFAULT_SOP = (\[[\s\S]*?\n\]);/.exec(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'))[1];
const SOPS = vm.runInThisContext(sopSrc);
const RE_MEMREPO = require('./memrepo.js');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const svc = RE_SERVICE_FACTORY(REC);
const exported = [];
const users = [{email: 'param.chavan@grofers.com', role: 'PM'}, {email: 'cm@grofers.com', role: 'CM', regions: 'Jammu, Tricity'}];
const repo = RE_MEMREPO(fx, {sops: SOPS, users, cfg: [{key: 'snapshot_hour', value: '0'}], exportSheet: (t, p) => { exported.push(t); return {url: 'https://sheet/' + exported.length, pdf_url: 'https://pdf'}; }});

// unit checks on the C port
assert.strictEqual(REC.negativePriority('[2026-09-07]', '2026-09-08').priority, 'P0');
assert.strictEqual(REC.negativePriority('[2026-09-01]', '2026-09-08').priority, 'P3');
assert.deepStrictEqual(REC.parseArrayCell("['A-1', 'B-2']"), ['A-1', 'B-2']);
assert.strictEqual(REC.rackOf('F0-A01-001-01-A', REC.DEFAULTS), 'F0-A01-001');
assert.strictEqual(REC.aisleOf('F0-A01-001-01-A', REC.DEFAULTS), 'F0-A01');

const boot = svc.boot(repo);
assert.strictEqual(boot.role, 'PM');
assert.strictEqual(boot.stores.length, 10);
const broken = fx.health.find(h => h.cohort_role === 'BROKEN').outlet_id, control = fx.health.find(h => h.cohort_role === 'CONTROL').outlet_id;

// presence: two auditors audited this morning (one within 90 min of "now" = on the floor), others only yesterday
const rosterIds = fx.emps.filter(e => e.outlet_id === broken).map(e => e.employee_id);
repo._audits.push({audit_date_ist: fx.today, outlet_id: broken, location_id: 'F0-A01-001-01-A', rack_id: 'F0-A01-001', session_status: 'COMPLETED', auditor_id: rosterIds[3], session_elapsed_seconds: 200, end_time: fx.today + ' 09:50:00', expected_sku_coverage_pct: 100});
repo._audits.push({audit_date_ist: fx.today, outlet_id: broken, location_id: 'F0-A01-001-02-A', rack_id: 'F0-A01-001', session_status: 'COMPLETED', auditor_id: rosterIds[5], session_elapsed_seconds: 200, end_time: fx.today + ' 06:10:00', expected_sku_coverage_pct: 100});
repo._audits.push({audit_date_ist: fx.today, outlet_id: broken, location_id: 'F0-A01-001-03-A', rack_id: 'F0-A01-001', session_status: 'COMPLETED', auditor_id: 'GHOST1', auditor_first_name: 'Walk', auditor_last_name: 'In', session_elapsed_seconds: 200, end_time: fx.today + ' 09:40:00', expected_sku_coverage_pct: 100});

const t0 = Date.now();
const v = svc.store(repo, broken);
console.log('store view ms (live, no refresh yet)', Date.now() - t0, 'live', v.live);
console.log('severity', v.severity.tier, 'ops', v.severity.ops, 'inv', v.severity.inventory, 'cap', v.severity.capacity, v.severity.reasons.join('; '));
console.log('BROKEN', broken, 'mode', v.diagnosis.mode, 'tasks', v.diagnosis.tasks.length, 'hours', v.diagnosis.total_hours);
console.log('top racks', v.diagnosis.top_racks.slice(0, 4).map(r => r.rack + ' ' + r.level + ' ₹' + r.value + ' ' + r.items + ' items ' + r.hours + 'h tasks=' + r.task_ids.join('/')).join(' | '));
console.log('roster top6', v.roster.slice(0, 6).map(c => c.name + '(' + c.on_floor + (c.last_seen ? ' ' + c.last_seen : '') + ',' + c.tier + ',' + c.score + ')').join(' | '));
console.log('presence', v.presence, 'suggested', v.suggestion);
assert.ok(REC.TIER_RANK[v.severity.tier] >= 2, 'broken store should be BROKEN or worse');
assert.ok(v.diagnosis.tasks.length > 0);
assert.ok(v.diagnosis.top_racks.length > 0 && v.diagnosis.top_racks[0].value >= v.diagnosis.top_racks[v.diagnosis.top_racks.length - 1].value, 'racks sorted by ₹');
assert.ok(v.roster.some(c => c.rated), 'audit metrics should rate some captains');
assert.strictEqual(v.roster[0].on_floor === 'NOW' || v.roster[0].on_floor === 'TODAY', true, 'on-floor captains listed first');
assert.ok(v.roster.some(c => c.name === 'Walk In' && c.on_floor === 'NOW'), 'auditor missing from the roster but auditing now is listed');
assert.ok(v.suggestion.crew.length > 0 && v.suggestion.crew.every(c => v.roster.find(r => r.name === c.name).available), 'only captains on the floor today are suggested');
assert.strictEqual(v.presence.has_today, true);

// confirm the suggestion unchanged -> nothing recorded as a change
const r1 = svc.confirm(repo, {outlet_id: broken, feed_date: v.summary.feed_date, crew: v.suggestion.crew, skip: [], window: '14:00-17:00'});
assert.ok(r1.view.today_plan, 'today plan present');
assert.strictEqual(r1.view.today_plan.plan.changes_vs_suggested, '');
// SM picks a rack from "Racks with most variance" to do first, and drops a captain: never asked why, recorded automatically
const pick = v.diagnosis.top_racks.find(r => r.level !== 'LOCATION') || v.diagnosis.top_racks[0];
const r2 = svc.confirm(repo, {outlet_id: broken, feed_date: v.summary.feed_date, crew: v.suggestion.crew.slice(0, 1), skip: [], pin: pick.task_ids});
console.log('auto changes:', r2.view.today_plan.plan.changes_vs_suggested);
assert.ok(/−/.test(r2.view.today_plan.plan.changes_vs_suggested) && /first/.test(r2.view.today_plan.plan.changes_vs_suggested));
const tp = r2.view.today_plan;
assert.strictEqual(tp.plan.supersedes, r1.plan_id);
assert.ok(pick.task_ids.indexOf(tp.lines[0].task_id) >= 0, 'the chosen rack is allocated first');
console.log('plan', tp.plan.plan_id, 'tasks', tp.tasks.length, 'lines', tp.lines.length, 'first', tp.lines[0].task_id);
const ex = svc.exportPlan(repo, tp.plan.plan_id), ex2 = svc.exportPlan(repo, tp.plan.plan_id);
assert.strictEqual(exported.length, 1, 'print sheet created once per plan');
assert.strictEqual(ex.file.url, ex2.file.url);
console.log('print page', ex.pages[0].captain, ex.pages[0].hours + 'h', ex.pages[0].locations + ' loc', ex.pages[0].rows.length + ' tasks');
assert.ok(repo._tables.PLAN_TASKS.length > 0 && repo._tables.PLAN_ITEMS.length > 0, 'human-readable plan rows written');

// simulate execution: feed shows an increment for the first planned item, audit data shows sessions at planned locations
const first = tp.tasks[0].items[0];
const rawItem = fx.raw.find(r => r.item_id === first.item_id);
rawItem.audit_increment_qty = rawItem.variance_qty; rawItem.audit_increment_dates = '[' + fx.today + ']';
const locsOf = t => t.complex ? fx.locs.filter(l => l[0] === broken && l[3] === t.rack).map(l => l[1]) : t.location_list.map(l => l.location_id);
locsOf(tp.tasks[0]).slice(0, 3).forEach(l => repo._audits.push({audit_date_ist: fx.today, outlet_id: broken, location_id: l, rack_id: REC.rackOf(l, REC.DEFAULTS),
  session_status: 'COMPLETED', auditor_id: 'X', distinct_skus: 3, found_qty: 10, quality_status: 'MEETS_PROVISIONAL_SOP', session_elapsed_seconds: 300, end_time: fx.today + ' 23:00:00', expected_sku_coverage_pct: 100}));
const pl = locsOf(tp.tasks[0])[0];
repo._audits.push({audit_date_ist: fx.today, outlet_id: broken, location_id: pl, rack_id: REC.rackOf(pl, REC.DEFAULTS), session_status: 'COMPLETED', auditor_id: 'Y', session_elapsed_seconds: 120, end_time: fx.today + ' 23:10:00', expected_sku_coverage_pct: 40});
repo._audits.push({audit_date_ist: fx.today, outlet_id: broken, location_id: 'Z9-Z99-999-01-A', rack_id: 'Z9-Z99-999', session_status: 'COMPLETED', auditor_id: 'Y', session_elapsed_seconds: 120, end_time: fx.today + ' 23:20:00', expected_sku_coverage_pct: 100});
repo._audits.push({audit_date_ist: fx.today, outlet_id: broken, location_id: pl, rack_id: REC.rackOf(pl, REC.DEFAULTS), session_status: 'COMPLETED', auditor_id: 'Y', session_elapsed_seconds: 120, end_time: fx.today + ' 00:05:00', expected_sku_coverage_pct: 100});
const tasks = {};
tp.lines.forEach(l => { tasks[l.task_id] = 'DONE'; });
const after = svc.actuals(repo, {plan_id: tp.plan.plan_id, rows: [{captain: tp.lines[0].captain, actual_hours: 2.5, tasks, note: ''}]});
const m = after.today_plan.measure;
console.log('measure S/P/A hours', m.suggested.hours, m.planned.hours, m.actual.hours, 'adherence', m.adherence, 'recovered', m.recovery.recovered_items, m.recovery.recovered_value, '₹/h', m.rupees_per_hour,
  'observed', m.observed && {aud: m.observed.locations_audited, plan: m.observed.locations_planned, counts: m.observed.counts});
assert.strictEqual(m.recovery.recovered_items, 1);
assert.ok(m.observed.locations_audited >= 1);
assert.ok(m.observed.counts.MATCHED >= 1 && m.observed.counts.QUALITY_GAP >= 1 && m.observed.counts.OFF_PLAN >= 1 && m.observed.counts.BASELINE >= 1);
// double tap: same token twice -> one ACTUALS write
const before = repo._tables.ACTUALS.length;
svc.actuals(repo, {plan_id: tp.plan.plan_id, token: 'tok-1', rows: [{captain: tp.lines[0].captain, actual_hours: 2, tasks}]});
svc.actuals(repo, {plan_id: tp.plan.plan_id, token: 'tok-1', rows: [{captain: tp.lines[0].captain, actual_hours: 2, tasks}]});
assert.strictEqual(repo._tables.ACTUALS.length, before + 1);
// settings: PM saves, change logged, bad value refused
const sv = svc.settingsSave(repo, {rack_sweep_min_items: '5'});
assert.strictEqual(sv.rows.find(r => r.key === 'rack_sweep_min_items').effective, '5');
assert.throws(() => svc.settingsSave(repo, {rack_sweep_min_items: 'abc'}), /must be a number/);
svc.settingsSave(repo, {rack_sweep_min_items: ''});

// ---------------------------------------------------------------- hourly refresh job
const t1 = Date.now(), info = svc.refresh(repo);
console.log('refresh', info, 'ms', Date.now() - t1);
assert.strictEqual(info.status, 'OK');
assert.strictEqual(repo._tables.STORE_STATE.length, 10);
assert.ok(repo._tables.PLAN_RESULTS.length >= 1);
assert.ok(repo._tables.DAILY.length === 10, 'one snapshot per store');
assert.ok(repo._tables.METRICS_DAILY.length > 0);
assert.deepStrictEqual(repo._tables.JOB_RUNS.map(r => r.status), ['RUNNING', 'OK']);
const res = repo._tables.PLAN_RESULTS.find(r => r.plan_id === tp.plan.plan_id);
console.log('plan result', JSON.stringify(res));
assert.strictEqual(res.actuals_logged, 'TRUE');
assert.ok(Number(res.audited_locations) >= 1 && Number(res.recovered_items) === 1);
const met = repo._tables.METRICS_DAILY.filter(r => r.date === fx.today && r.scope === 'ALL')[0];
console.log('goodness ALL today', JSON.stringify(met));
assert.strictEqual(Number(met.plans), 1);
// a second run is idempotent (no duplicate snapshots or results)
svc.refresh(repo);
assert.strictEqual(repo._tables.DAILY.length, 10);
assert.strictEqual(repo._tables.PLAN_RESULTS.filter(r => r.plan_id === tp.plan.plan_id).length, 1);
// SM screen now comes from STORE_STATE, not a live computation, and is the same store
const v2 = svc.store(repo, broken);
assert.strictEqual(v2.live, false);
assert.strictEqual(v2.diagnosis.tasks.length, v.diagnosis.tasks.length);
assert.strictEqual(v2.today_plan.plan.plan_id, tp.plan.plan_id);
assert.ok(v2.history.length >= 1 && v2.history[0].actual.logged);
// confirm works from the stored state too
const r3 = svc.confirm(repo, {outlet_id: control, feed_date: svc.store(repo, control).summary.feed_date, crew: [{name: 'Test Captain', hours: 2}], skip: []});
assert.ok(r3.plan_id);

// ---------------------------------------------------------------- access
const smRepo = Object.assign({}, repo, {me: () => 'sm@grofers.com', users: () => users.concat([{email: 'sm@grofers.com', role: 'SM', outlet_ids: control}])});
assert.strictEqual(svc.boot(smRepo).stores.length, 1);
assert.throws(() => svc.store(smRepo, broken), /do not have access/);
assert.throws(() => svc.settingsView(smRepo), /needs role PM/);
assert.throws(() => svc.cm(smRepo), /needs role CM/);
const nobody = Object.assign({}, repo, {me: () => 'stranger@grofers.com'});
assert.throws(() => svc.boot(nobody), /not in the USERS list/);
const noOutlet = Object.assign({}, repo, {me: () => 'sm2@grofers.com', users: () => [{email: 'sm2@grofers.com', role: 'SM'}]});
assert.throws(() => svc.boot(noOutlet), /no outlet_ids/);
// CM scoped by region
const cmRepo = Object.assign({}, repo, {me: () => 'cm@grofers.com'});
const cm = svc.cm(cmRepo);
console.log('CM (Jammu, Tricity) rows', cm.rows.map(r => r.outlet_id + ':' + r.region + ':' + r.flag.code).join(' '));
assert.strictEqual(cm.rows.length, 4);
assert.ok(cm.rows.every(r => r.region === 'Jammu' || r.region === 'Tricity'));
assert.throws(() => svc.tower(cmRepo), /needs role PM/);
const other = fx.health.find(h => h.region === 'UP West').outlet_id;
assert.throws(() => svc.store(cmRepo, other), /do not have access/);
svc.cmReview(cmRepo, {outlet_id: cm.rows[0].outlet_id, decision: 'Coach SM on plan', owner: 'Rahul', note: 'test'});
assert.throws(() => svc.cmReview(cmRepo, {outlet_id: other, decision: 'Monitor'}), /do not have access/);
// PM tower + monitor
const tw = svc.tower(repo);
console.log('regions', tw.regions.map(g => g.region + ' ' + g.stores + ' stores, floor ' + g.on_floor_now + ', rph ' + g.rupees_per_hour).join(' | '));
console.log('cohorts', tw.cohorts.map(c => c.cohort + ':' + c.stores).join(' '), '| metrics rows', tw.metrics.length);
assert.strictEqual(tw.regions.reduce((v3, g) => v3 + g.stores, 0), 10);
assert.ok(tw.rows.find(r => r.outlet_id === control).plan, 'plan confirmed after the refresh shows straight away');
const mon = svc.monitor(repo);
console.log('monitor usage', mon.usage, 'last ok', mon.last_ok && mon.last_ok.status);
assert.ok(mon.usage.store_views_today >= 1 && mon.last_ok);
// live_regions switches a wave on
svc.settingsSave(repo, {live_regions: 'Jammu'});
svc.refresh(repo);
assert.strictEqual(repo._tables.STORE_STATE.length, 2);
svc.settingsSave(repo, {live_regions: ''});
console.log('action log', [...new Set(repo._tables.ACTION_LOG.map(r => r.action))].join(', '));
// presence: an open shift means "at the store now", even with no recent audit
const pr = REC.presence([{outlet_id: '1', audit_date_ist: fx.today, auditor_id: 'S1', last_end_time: fx.today + ' 06:00:00', on_shift: '1', sessions: 0},
  {outlet_id: '1', audit_date_ist: fx.today, auditor_id: 'S2', last_end_time: fx.today + ' 06:00:00', on_shift: '0', sessions: 0}], '1', fx.today + ' 11:00:00', REC.DEFAULTS);
assert.strictEqual(pr.S1.now, true); assert.strictEqual(pr.S2.now, false);
// high-value SKUs go to the top
const hv = REC.worklist([{outlet_id: '1', item_id: 'A', item_name: 'Phone', variance: 24000, variance_qty: 2, rnk: 9, neg_loc_array: '[F0-A01-001-01-A]', probable_locations: '[]'},
  {outlet_id: '1', item_id: 'B', item_name: 'Milk', variance: 90, variance_qty: 3, rnk: 1, neg_loc_array: '[F0-A01-002-01-A]', probable_locations: '[]'}], '1', REC.DEFAULTS);
assert.strictEqual(hv.items[0].item_id, 'A'); assert.strictEqual(hv.items[0].priority, 'HV');
console.log('ALL TESTS PASSED');
