/** End-to-end test of Core + Service on the fixture: SM plan -> confirm -> actuals -> CM -> tower. Run: node test/run.js */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'Core.gs'), 'utf8').replace(/if \(typeof module[^\n]*/, ''));
vm.runInThisContext(fs.readFileSync(path.join(root, 'Service.gs'), 'utf8'));
const sopSrc = /var RE_DEFAULT_SOP = (\[[\s\S]*?\n\]);/.exec(fs.readFileSync(path.join(root, 'Server.gs'), 'utf8'))[1];
const SOPS = vm.runInThisContext(sopSrc);
const RE_MEMREPO = require('./memrepo.js');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const svc = RE_SERVICE_FACTORY(REC);
const repo = RE_MEMREPO(fx, {sops: SOPS, cfg: [{key: 'cm_emails', value: 'cm@grofers.com'}]});

// unit checks on the C port
assert.strictEqual(REC.negativePriority('[2026-09-07]', '2026-09-08').priority, 'P0');
assert.strictEqual(REC.negativePriority('[2026-09-01]', '2026-09-08').priority, 'P3');
assert.deepStrictEqual(REC.parseArrayCell("['A-1', 'B-2']"), ['A-1', 'B-2']);
assert.strictEqual(REC.rackOf('F0-A01-001-01-A', REC.DEFAULTS), 'F0-A01-001');
assert.strictEqual(REC.aisleOf('F0-A01-001-01-A', REC.DEFAULTS), 'F0-A01');

const boot = svc.boot(repo);
assert.strictEqual(boot.role, 'PM');
assert.strictEqual(boot.stores.length, 10);
const t0 = Date.now();
const broken = fx.health.find(h => h.cohort_role === 'BROKEN').outlet_id, control = fx.health.find(h => h.cohort_role === 'CONTROL').outlet_id;
const v = svc.store(repo, broken);
console.log('store view ms', Date.now() - t0);
console.log('BROKEN', broken, v.severity.tier, 'mode', v.diagnosis.mode, 'tasks', v.diagnosis.tasks.length, 'hours', v.diagnosis.total_hours,
  'levels', Object.values(v.diagnosis.by_level).map(b => b.level + ':' + b.tasks + '/' + b.share_pct + '%').join(' '));
console.log('roster top5', v.roster.slice(0, 5).map(c => c.name + '(' + c.tier + ',' + c.score + ',' + c.basis + (c.complex_ready ? ',sweeps' : '') + ')').join(' | '));
console.log('suggested', v.suggestion);
assert.strictEqual(v.severity.tier, 'BROKEN');
assert.ok(v.diagnosis.tasks.length > 0);
assert.ok(v.roster.some(c => c.rated), 'audit metrics should rate some captains');
assert.ok(v.suggestion.crew.length > 0 && v.suggestion.crew.length <= 4);
const vc = svc.store(repo, control);
console.log('CONTROL', control, vc.severity.tier, 'mode', vc.diagnosis.mode, 'tasks', vc.diagnosis.tasks.length);

// confirm the suggestion unchanged -> no deviation reason needed
const r1 = svc.confirm(repo, {outlet_id: broken, feed_date: v.summary.feed_date, crew: v.suggestion.crew, skip: [], window: '14:00-17:00'});
assert.ok(r1.view.today_plan, 'today plan present');
assert.strictEqual(r1.view.today_plan.plan.deviation_reason, '');
// changed crew without reason -> refused
assert.throws(() => svc.confirm(repo, {outlet_id: broken, feed_date: v.summary.feed_date, crew: v.suggestion.crew.slice(0, 1), skip: [], replace_reason: 'x'}), /Pick a reason/);
// replace without replace reason -> refused
assert.throws(() => svc.confirm(repo, {outlet_id: broken, feed_date: v.summary.feed_date, crew: v.suggestion.crew.slice(0, 1), skip: [], deviation_reason: 'Captain absent'}), /already confirmed/);
const r2 = svc.confirm(repo, {outlet_id: broken, feed_date: v.summary.feed_date, crew: v.suggestion.crew.slice(0, 1), skip: [], deviation_reason: 'Captain absent', replace_reason: 'captain left'});
const tp = r2.view.today_plan;
assert.strictEqual(tp.plan.supersedes, r1.plan_id);
console.log('plan', tp.plan.plan_id, 'tasks', tp.tasks.length, 'lines', tp.lines.length);
console.log(REC.captainBrief(tp.lines[0].captain, {lines: tp.lines}, tp.tasks, r2.view.sops, r2.view.store.outlet_name, tp.plan.window).split('\n').slice(0, 14).join('\n'));

// simulate execution: feed shows an increment for the first planned item, audit data shows sessions at planned locations
const first = tp.tasks[0].items[0];
const rawItem = fx.raw.find(r => r.item_id === first.item_id);
rawItem.audit_increment_qty = rawItem.variance_qty; rawItem.audit_increment_dates = '[' + fx.today + ']';
tp.tasks[0].location_list.slice(0, 3).forEach(l => repo._audits.push({audit_date_ist: fx.today, outlet_id: broken, location_id: l.location_id, rack_id: REC.rackOf(l.location_id, REC.DEFAULTS),
  session_status: 'COMPLETED', auditor_id: 'X', distinct_skus: 3, found_qty: 10, quality_status: 'MEETS_PROVISIONAL_SOP', session_elapsed_seconds: 300}));
const tasks = {};
tp.lines.forEach(l => { tasks[l.task_id] = 'DONE'; });
const after = svc.actuals(repo, {plan_id: tp.plan.plan_id, rows: [{captain: tp.lines[0].captain, actual_hours: 2.5, tasks, note: ''}]});
const m = after.today_plan.measure;
console.log('measure S/P/A hours', m.suggested.hours, m.planned.hours, m.actual.hours, 'adherence', m.adherence, 'recovered', m.recovery.recovered_items, m.recovery.recovered_value, '₹/h', m.rupees_per_hour,
  'observed', m.observed && {aud: m.observed.locations_audited, plan: m.observed.locations_planned});
assert.strictEqual(m.recovery.recovered_items, 1);
assert.ok(m.observed.locations_audited >= 1);
assert.strictEqual(m.deviation_reason, 'Captain absent');

// CM + tower
const cmRepo = Object.assign({}, repo, {me: () => 'cm@grofers.com'});
const cm = svc.cm(cmRepo);
console.log('CM flags', cm.rows.map(r => r.outlet_id + ':' + r.flag.code).join(' '));
assert.throws(() => svc.tower(cmRepo), /needs role PM/);
svc.cmReview(cmRepo, {outlet_id: broken, decision: 'Coach SM on plan', owner: 'Rahul', note: 'test'});
const tw = svc.tower(repo);
console.log('regions', tw.regions.map(g => g.region + ' ' + g.stores + ' stores, rph ' + g.rupees_per_hour).join(' | '));
console.log('cohorts', tw.cohorts.map(c => c.cohort + ':' + c.stores).join(' '));
assert.strictEqual(tw.regions.reduce((v2, g) => v2 + g.stores, 0), 10);
assert.ok(svc.store(repo, broken).nudge !== undefined);
console.log('ALL TESTS PASSED');
