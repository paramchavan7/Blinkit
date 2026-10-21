/**
 * Builds preview/index.html: the real App.html + Core + Service running on an in-memory repo with fixture data
 * (synthetic variance on real locations / audits / captains). Opens in any browser, no Apps Script needed.
 * Usage: node preview/build.js [stores=4] [role email]
 */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const fx = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixture.json'), 'utf8'));
const keepN = Number(process.argv[2] || 4), me = process.argv[3] || 'param.chavan@grofers.com';
const ids = fx.health.slice(0, keepN).map(h => h.outlet_id), keep = x => ids.indexOf(x) >= 0;
const master = {};
ids.forEach(id => { master[id] = fx.master[id]; });
const sessions = fx.audits.filter(a => keep(a[1]) && a[0] >= '2026-09-07').concat(fx.audits.filter(a => keep(a[1]) && a[0] === '2026-09-07' && Number(String(a[10]).slice(11, 13).replace(':', '')) < 10)
  .map(a => [fx.today].concat(a.slice(1, 10), [fx.today + String(a[10]).slice(10)], a.slice(11))));
const small = {today: fx.today, raw: fx.raw.filter(r => keep(r.outlet_id)), health: fx.health.filter(h => keep(h.outlet_id)), master,
  emps: fx.emps.filter(e => keep(e.outlet_id)), metrics: (fx.metrics || []).filter(m => keep(m.outlet_id)), locs: fx.locs.filter(l => keep(l[0])), audits: sessions};
const sops = /var RE_DEFAULT_SOP = (\[[\s\S]*?\n\]);/.exec(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'))[1];
const core = fs.readFileSync(path.join(root, 'IRD_Core.gs'), 'utf8').replace(/if \(typeof module[^\n]*/, '');
const service = fs.readFileSync(path.join(root, 'IRD_Service.gs'), 'utf8');
const mem = fs.readFileSync(path.join(root, 'test', 'memrepo.js'), 'utf8').replace(/if \(typeof module[^\n]*/, '');
const mock = `<script>${service}\n${mem}
var RE_FX = ${JSON.stringify(small)};
(function(){var repo = RE_MEMREPO(RE_FX, {me: ${JSON.stringify(me)}, sops: ${sops}, nowFn: () => RE_FX.today + ' 10:15:00',
  users: [{email: 'param.chavan@grofers.com', role: 'PM'}, {email: 'cm@grofers.com', role: 'CM', regions: 'UP West, Uttarakhand'}], cfg: [{key: 'snapshot_hour', value: '0'}]}), svc = RE_SERVICE_FACTORY(REC);
svc.refresh(repo);
window.RE_MOCK = {RE_BOOT: () => svc.boot(repo), RE_PING: () => svc.ping(repo), RE_STORE: id => svc.store(repo, id), RE_CONFIRM: r => svc.confirm(repo, r), RE_ACTUALS: r => svc.actuals(repo, r),
  RE_CM: () => svc.cm(repo), RE_CM_REVIEW: r => svc.cmReview(repo, r), RE_TOWER: () => svc.tower(repo), RE_EXPORT: id => svc.exportPlan(repo, id),
  RE_MONITOR: () => Object.assign(svc.monitor(repo), {triggers: ['RE_REFRESH', 'RE_MAINTAIN']}), RE_SETTINGS: () => svc.settingsView(repo), RE_SETTINGS_SAVE: ch => svc.settingsSave(repo, ch)};})();
</script>`;
let html = fs.readFileSync(path.join(root, 'IRD_App.html'), 'utf8')
  .replace('<?!= coreSrc ?>', () => core).replace("'<?= initialStore ?>'", "''")
  .replace('</script>\n<script>\n(function () {', () => '</script>\n' + mock + '\n<script>\n(function () {')
  .replace('<body>', '<body><div style="background:#fff3dc;color:#9a5b06;padding:6px 16px;font-size:12px">PREVIEW · real locations, audits and captains (Sep 2026) · variance is SYNTHETIC · data resets on reload</div>');
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('preview/index.html', Math.round(html.length / 1024) + ' KB', ids.join(','));
