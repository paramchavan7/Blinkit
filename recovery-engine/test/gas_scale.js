/**
 * North-scale run in the Apps Script simulator: N copies of the 10 fixture stores (default 20 = 200 stores).
 * Reports refresh time, API calls, cells moved, the size of the packed screens, and the SM screen cost at that scale.
 * Run: node test/gas_scale.js [copies]
 */
const fs = require('fs'), path = require('path'), assert = require('assert');
const makeGas = require('./gas_sim.js'), buildInputs = require('./gas_inputs.js');
const dep = path.join(__dirname, '..', 'deploy'), copies = Number(process.argv[2] || 20);
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const g = makeGas({now: fx.today + 'T05:30:00Z', htmlDir: dep});
g.load([path.join(dep, 'Code.gs'), path.join(dep, 'Engine.gs'), path.join(dep, 'Service.gs')]);
g.call('RE_SETUP');
const inputs = buildInputs(fx, copies, 11), ss = g.active;
Object.keys(inputs).forEach(t => g.paste(ss, t, inputs[t]));
const cellsIn = Object.keys(inputs).reduce((v, t) => v + inputs[t].length * Object.keys(inputs[t][0] || {}).length, 0);
console.log('stores', copies * 10, '| input rows', Object.keys(inputs).map(t => t + ' ' + inputs[t].length).join(', '), '| input cells', cellsIn);
// Rough Apps Script cost model (verify against JOB_RUNS.seconds on the first real run): 40 ms per call + 1.5 µs per cell read, 4 µs per cell written.
const est = s => Math.round((s.calls * 0.04 + (s.cells) * 0.0000025) * 10) / 10;
g.resetStats();
let t = Date.now();
g.call('RE_REFRESH');
const cpu = (Date.now() - t) / 1000, rs = JSON.parse(JSON.stringify(g.stats));
const state = g.tab(ss, 'STORE_STATE'), sizes = state.map(r => [1, 2, 3, 4, 5, 6, 7, 8].reduce((v, i) => v + String(r['payload_' + i] || '').length, 0));
console.log('refresh: node cpu', cpu + 's', '| API calls', rs.calls, '| cells moved', rs.cells, '| est. Apps Script I/O ~' + est(rs) + 's + cpu', '| byKind', JSON.stringify(rs.byKind));
console.log('packed SM screen per store: max', Math.max.apply(null, sizes), 'chars, median', sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)], '| cells per store max', Math.max.apply(null, state.map(r => Number(r.payload_parts))));
assert.strictEqual(state.length, copies * 10);
const users = ss.getSheetByName('USERS');
users.appendRow(['sm@grofers.com', 'SM', '71841', '', '', '']);
users.appendRow(['cm@grofers.com', 'CM', '', 'Jammu', '', '']);
g.as('sm@grofers.com'); g.resetStats(); t = Date.now();
const v = g.call('RE_STORE', '71841');
console.log('SM store view: node', (Date.now() - t) + 'ms', '| API calls', g.stats.calls, '| est. Apps Script ~' + est(g.stats) + 's', '| tasks', v.diagnosis.tasks.length);
const c1 = g.call('RE_CONFIRM', {outlet_id: '71841', feed_date: v.summary.feed_date, crew: v.suggestion.crew, skip: []});
assert.ok(c1.plan_id);
g.as('cm@grofers.com'); g.resetStats(); t = Date.now();
const cm = g.call('RE_CM');
console.log('CM view (Jammu,', cm.rows.length, 'stores): node', (Date.now() - t) + 'ms', '| API calls', g.stats.calls, '| est. ~' + est(g.stats) + 's');
g.as('param.chavan@grofers.com'); g.resetStats(); t = Date.now();
const tw = g.call('RE_TOWER');
console.log('PM tower (' + tw.rows.length + ' stores): node', (Date.now() - t) + 'ms', '| API calls', g.stats.calls, '| est. ~' + est(g.stats) + 's', '| response', Math.round(JSON.stringify(tw).length / 1024) + ' KB');
const cells = ss.getSheets().reduce((v2, s) => v2 + s.getMaxRows() * s.getMaxColumns(), 0);
console.log('spreadsheet cells', cells, '(' + Math.round(cells / 100000) + '% of 10M)');
console.log('SCALE RUN DONE');
