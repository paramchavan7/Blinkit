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
const small = {today: fx.today, raw: fx.raw.filter(r => keep(r.outlet_id)), health: fx.health.filter(h => keep(h.outlet_id)), master: fx.master,
  emps: fx.emps.filter(e => keep(e.outlet_id)), locs: fx.locs.filter(l => keep(l[0])), audits: fx.audits.filter(a => keep(a[1]) && a[0] >= '2026-08-09')};
const sops = /var RE_DEFAULT_SOP = (\[[\s\S]*?\n\]);/.exec(fs.readFileSync(path.join(root, 'Server.gs'), 'utf8'))[1];
const core = fs.readFileSync(path.join(root, 'Core.gs'), 'utf8').replace(/if \(typeof module[^\n]*/, '');
const service = fs.readFileSync(path.join(root, 'Service.gs'), 'utf8');
const mem = fs.readFileSync(path.join(root, 'test', 'memrepo.js'), 'utf8').replace(/if \(typeof module[^\n]*/, '');
const mock = `<script>${service}\n${mem}
var RE_FX = ${JSON.stringify(small)};
(function(){var repo = RE_MEMREPO(RE_FX, {me: ${JSON.stringify(me)}, sops: ${sops}, cfg: [{key:'cm_emails', value:'cm@grofers.com'}]}), svc = RE_SERVICE_FACTORY(REC);
window.RE_MOCK = {RE_BOOT: () => svc.boot(repo), RE_STORE: id => svc.store(repo, id), RE_CONFIRM: r => svc.confirm(repo, r), RE_ACTUALS: r => svc.actuals(repo, r),
  RE_CM: () => svc.cm(repo), RE_CM_REVIEW: r => svc.cmReview(repo, r), RE_TOWER: () => svc.tower(repo)};})();
</script>`;
let html = fs.readFileSync(path.join(root, 'App.html'), 'utf8')
  .replace('<?!= coreSrc ?>', () => core).replace("'<?= initialStore ?>'", "''")
  .replace('</script>\n<script>\n(function () {', () => '</script>\n' + mock + '\n<script>\n(function () {')
  .replace('<body>', '<body><div style="background:#fff3dc;color:#9a5b06;padding:6px 16px;font-size:12px">PREVIEW · real locations, audits and captains (Sep 2026) · variance is SYNTHETIC · data resets on reload</div>');
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('preview/index.html', Math.round(html.length / 1024) + ' KB', ids.join(','));
