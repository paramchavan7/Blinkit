/**
 * Runs the deploy/ files inside the Apps Script simulator, the way they run after pasting:
 * setup -> paste inputs -> health -> hourly refresh -> SM / CM / PM / unlisted user -> print -> actuals -> alerts -> archive -> doGet.
 * Run: node test/gas_e2e.js
 */
const fs = require('fs'), path = require('path'), assert = require('assert');
const makeGas = require('./gas_sim.js'), buildInputs = require('./gas_inputs.js');
const root = path.join(__dirname, '..'), dep = path.join(root, 'deploy');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const g = makeGas({now: fx.today + 'T05:30:00Z', htmlDir: dep});   // 11:00 IST
// Apps Script runs files in the order they were created: Code.gs first (exists in every new project), then the two added.
g.load([path.join(dep, 'Code.gs'), path.join(dep, 'Engine.gs'), path.join(dep, 'Service.gs')]);
const ss = g.active, step = m => console.log('· ' + m);
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);   // objects from the simulator's context

g.ui(true);
step(g.call('RE_SETUP'));
['START_HERE', 'CFG', 'USERS', 'SOP', 'HEALTH', 'PLANS', 'STORE_STATE', 'PLAN_RESULTS', 'METRICS_DAILY', 'JOB_RUNS', 'RAWItemlevel', 'AUDITOR_DAILY'].forEach(t => assert.ok(ss.getSheetByName(t), t + ' created'));
assert.strictEqual(g.tab(ss, 'USERS')[0].email, 'param.chavan@grofers.com');
step(g.call('RE_SETUP') && 'setup again is safe');
assert.strictEqual(g.tab(ss, 'USERS').length, 1);

// Paste every input the way a sync / File > Import does (typed values: numbers and dates become numbers and dates).
const inputs = buildInputs(fx, 1, 11);
Object.keys(inputs).forEach(t => g.paste(ss, t, inputs[t]));
step('pasted ' + Object.keys(inputs).map(t => t + ' ' + inputs[t].length).join(', '));
const users = ss.getSheetByName('USERS');
users.appendRow(['cm.north@grofers.com', 'CM', '', 'Jammu, Tricity', 'CM North', '']);
users.appendRow(['sm.7184@grofers.com', 'SM', '7184', '', 'SM Gwalior', '']);
step(g.call('RE_HEALTH'));
const health = g.tab(ss, 'HEALTH');
assert.ok(health.filter(r => /required/.test(r.input)).every(r => r.status === 'OK'), 'required inputs OK');
assert.ok(health.find(r => /^AUDITOR_DAILY/.test(r.input)).status === 'OK');

// Before the first refresh the SM screen is computed live; then the hourly job takes over.
g.as('sm.7184@grofers.com'); g.ui(false);
const b0 = g.call('RE_BOOT');
same(b0.stores.map(s => s.outlet_id), ['7184']);
const live = g.call('RE_STORE', '7184');
assert.strictEqual(live.live, true);
g.as('param.chavan@grofers.com');
g.resetStats();
step(g.call('RE_REFRESH'));
console.log('  refresh API calls', g.stats.calls, 'cells', g.stats.cells, JSON.stringify(g.stats.byKind));
const state = g.tab(ss, 'STORE_STATE');
assert.strictEqual(state.length, 10);
assert.ok(state.every(r => Number(r.payload_parts) >= 1 && String(r.payload_1).charAt(0) === 'G'), 'packed screens');
const runs = g.tab(ss, 'JOB_RUNS');
same(runs.map(r => r.status), ['RUNNING', 'OK']);
assert.strictEqual(g.tab(ss, 'DAILY').length, 10, 'daily snapshots (11:00 is after snapshot_hour 10)');

// SM: stored screen, presence, racks, confirm with a rack chosen first, print, close shift
g.as('sm.7184@grofers.com');
g.resetStats();
const v = g.call('RE_STORE', '7184');
console.log('  SM store view API calls', g.stats.calls, JSON.stringify(g.stats.byKind));
assert.strictEqual(v.live, false);
assert.ok(v.presence.has_today && v.presence.in_today > 0, 'captains on the floor today');
assert.ok(v.roster[0].on_floor === 'NOW' || v.roster[0].on_floor === 'TODAY');
assert.ok(v.diagnosis.top_racks.length > 0);
console.log('  presence', JSON.stringify(v.presence), '| top rack', v.diagnosis.top_racks[0].rack, v.diagnosis.top_racks[0].level, '₹' + v.diagnosis.top_racks[0].value,
  '| crew', v.suggestion.crew.map(c => c.name).join(', '));
assert.throws(() => g.call('RE_STORE', '6406'), /do not have access/);
const rack = v.diagnosis.top_racks[0];
g.resetStats();
const c1 = g.call('RE_CONFIRM', {outlet_id: '7184', feed_date: v.summary.feed_date, crew: v.suggestion.crew, skip: [], pin: rack.task_ids, window: '14:00-17:00', token: 't1'});
console.log('  confirm API calls', g.stats.calls);
assert.ok(c1.plan_id && c1.view.today_plan.lines[0].task_id === rack.task_ids[0]);
const dup = g.call('RE_CONFIRM', {outlet_id: '7184', feed_date: v.summary.feed_date, crew: v.suggestion.crew, skip: [], token: 't1'});
assert.strictEqual(dup.duplicate, true, 'double tap ignored');
const plans = g.tab(ss, 'PLANS');
assert.strictEqual(plans.length, 1);
assert.ok(String(plans[0].frozen).charAt(0) === 'G' && String(plans[0].frozen).length < 50000);
assert.strictEqual(plans[0].plan_date, fx.today, 'plan_date stays text');
const ex = g.call('RE_EXPORT', c1.plan_id);
assert.ok(ex.file.url && ex.pages.length >= 1);
const tasks = {};
c1.view.today_plan.lines.forEach(l => { tasks[l.task_id] = 'DONE'; });
const a1 = g.call('RE_ACTUALS', {plan_id: c1.plan_id, rows: [{captain: c1.view.today_plan.lines[0].captain, actual_hours: 2, tasks}], token: 'a1'});
assert.ok(a1.today_plan.measure.actual.logged);
assert.strictEqual(g.call('RE_PING').refreshed_at.slice(0, 10), fx.today);

// CM scoped by region; PM tower and monitoring
g.as('cm.north@grofers.com');
const cm = g.call('RE_CM');
assert.ok(cm.rows.length === 4 && cm.rows.every(r => r.region === 'Jammu' || r.region === 'Tricity'));
g.call('RE_CM_REVIEW', {outlet_id: cm.rows[0].outlet_id, decision: 'Send support captain', owner: 'Rahul', note: 'sim'});
assert.throws(() => g.call('RE_TOWER'), /needs role PM/);
g.as('param.chavan@grofers.com');
g.advance(60 * 60000);
step(g.call('RE_REFRESH'));
const res = g.tab(ss, 'PLAN_RESULTS');
assert.ok(res.length === 1 && res[0].actuals_logged === 'TRUE' && res[0].plan_id === c1.plan_id);
const tw = g.call('RE_TOWER');
assert.strictEqual(tw.rows.length, 10);
assert.ok(tw.metrics.some(m => m.scope === 'ALL' && m.date === fx.today && Number(m.plans) === 1));
const mon = g.call('RE_MONITOR');
assert.ok(mon.last_ok && mon.usage.store_views_today >= 1 && Array.isArray(mon.triggers));
const sv = g.call('RE_SETTINGS_SAVE', {rack_sweep_min_items: '5'});
assert.strictEqual(sv.rows.find(r => r.key === 'rack_sweep_min_items').effective, '5');

// Unlisted person: blocked, and the error is logged for monitoring
g.as('stranger@grofers.com');
assert.throws(() => g.call('RE_BOOT'), /not in the USERS list/);
assert.ok(g.tab(ss, 'ACTION_LOG').some(r => r.action === 'ERROR' && /^\[user\] RE_BOOT/.test(r.detail)));

// Alerts: the variance feed is from yesterday and it is past 11:00 -> one email, not repeated within the hour
g.as('param.chavan@grofers.com');
g.paste(ss, 'RAWItemlevel', inputs.RAWItemlevel.map(r => Object.assign({}, r, {raw_synced_at: '2026-09-07 07:45:00'})));
g.advance(60 * 60000);
g.call('RE_REFRESH');
assert.ok(g.mails.some(m => /Variance feed not refreshed today/.test(m.subject)), 'stale feed alert');
g.advance(60 * 60000);
g.call('RE_REFRESH');
assert.strictEqual(g.mails.filter(m => /Variance feed not refreshed/.test(m.subject)).length, 1, 'same alert not repeated');
console.log('  alerts sent:', g.mails.map(m => m.subject).join(' | '));

// Redash sync: two queries with ids in the SYNC tab, one failing; results land in the input tabs, failures are recorded and alerted
const toRedash = rows => ({columns: Object.keys(rows[0]).map(n => ({name: n})), rows});
g.props.REDASH_URL = 'https://redash.test'; g.props.REDASH_API_KEY = 'k1';
const syncTab = ss.getSheetByName('SYNC');
const syncNames = g.tab(ss, 'SYNC').map(r => r.tab);
same(syncNames, ['RAWItemlevel', 'STORE_VARIANCE_DAILY', 'EMPLOYEE_CAPACITY_SYNC_RAW', 'LOCATION_RECOVERY_RAW', 'AUDIT_EXECUTION_RAW', 'FLOOR_NOW', 'AUDITOR_DAILY', 'STORE_HEALTH_RAW', 'STORE_MASTER', 'USERS_AUTO']);
const rowOf = t => syncNames.indexOf(t) + 2;
syncTab.getRange(rowOf('AUDIT_EXECUTION_RAW'), 2).setValue('701');
syncTab.getRange(rowOf('AUDIT_EXECUTION_RAW'), 4).setValue('0');    // run mode for this one; the others download stored results
syncTab.getRange(rowOf('FLOOR_NOW'), 2).setValue('702');      // fails in Redash
syncTab.getRange(rowOf('USERS_AUTO'), 2).setValue('703');     // auto users from the North master
const gs = require('./gas_sim.js');
const fewer = inputs.AUDIT_EXECUTION_RAW.slice(0, 50);
const auto = [{email: 'cm.auto@grofers.com', role: 'CM', outlet_ids: '8468,8211', regions: '', name: 'CM Auto', note: 'north master'},
  {email: 'sm.7184@grofers.com', role: 'SM', outlet_ids: '6406', regions: '', name: 'should lose to USERS', note: ''}];
const redash = {key: 'k1', queries: {701: toRedash(fewer), 702: 'fail', 703: toRedash(auto)}};
g.ctx.UrlFetchApp.fetch = gs({redash}).ctx.UrlFetchApp.fetch;   // a Redash that knows queries 701-703
step(g.call('RE_SYNC_HOURLY'));
let syncRows = g.tab(ss, 'SYNC');
assert.strictEqual(syncRows[rowOf('AUDIT_EXECUTION_RAW') - 2].status, 'OK');
assert.strictEqual(Number(syncRows[rowOf('AUDIT_EXECUTION_RAW') - 2].rows), 50);
assert.strictEqual(syncRows[rowOf('FLOOR_NOW') - 2].status, 'ERROR');
assert.strictEqual(g.tab(ss, 'AUDIT_EXECUTION_RAW').length, 50, 'tab replaced by the Redash result (CSV download)');
step(g.call('RE_SYNC_DAILY'));
assert.strictEqual(g.tab(ss, 'USERS_AUTO').length, 2, 'USERS_AUTO written to the app sheet');
g.as('cm.auto@grofers.com');
assert.strictEqual(g.call('RE_CM').rows.length, 2, 'auto-listed CM sees their 2 stores');
g.as('sm.7184@grofers.com');
same(g.call('RE_BOOT').stores.map(s2 => s2.outlet_id), ['7184'], 'typed USERS row wins over the synced one');
g.as('param.chavan@grofers.com');
assert.ok(/already done today|Nothing to sync/.test(g.call('RE_SYNC_DAILY')), 'daily rows synced OK today are skipped');
g.advance(60 * 60000);
g.call('RE_REFRESH');
assert.ok(g.mails.some(m => /Redash sync failed: FLOOR_NOW/.test(m.subject)), 'sync failure alerted');
const mon2 = g.call('RE_MONITOR');
assert.ok(mon2.sync.length === 10 && mon2.sync[rowOf('FLOOR_NOW') - 2].status === 'ERROR');
g.props.REDASH_API_KEY = 'wrong';
g.call('RE_SYNC_HOURLY');
assert.ok(/HTTP 403/.test(g.tab(ss, 'SYNC')[rowOf('AUDIT_EXECUTION_RAW') - 2].note), 'bad key reported per row');

// Triggers, archive, web page
g.ui(true);
step(g.call('RE_INSTALL_TRIGGER'));
same(g.triggers.map(t => t.getHandlerFunction()).sort(), ['RE_MAINTAIN', 'RE_REFRESH', 'RE_SYNC_DAILY', 'RE_SYNC_DAILY', 'RE_SYNC_DAILY', 'RE_SYNC_HOURLY']);
g.call('RE_SETTINGS_SAVE', {archive_after_rows: '5'});
step(g.call('RE_MAINTAIN'));
assert.ok(g.props.RE_ARCHIVE_ID && g.tab(ss, 'ACTION_LOG').length <= 5);
const page = g.call('doGet', {parameter: {store: '7184'}});
assert.ok(/function RE_CORE_FACTORY/.test(page.html) && !/<\?!?=/.test(page.html), 'page renders with the engine inlined');
fs.writeFileSync(path.join(__dirname, 'sim_page.html'), page.html);
console.log('GAS SIMULATION PASSED');
