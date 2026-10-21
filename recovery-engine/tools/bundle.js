/**
 * Builds the files you paste into Apps Script (deploy/):
 *   Code.gs     backend: sheet menu, setup, refresh job, alerts, web app entry points   (from Code.gs)
 *   Engine.gs   pure recovery logic, also sent to the browser                            (from IRD_Core.gs)
 *   Service.gs  orchestration: SM / CM / PM screens, refresh, results, metrics            (from IRD_Service.gs)
 *   App.html    the app page                                                             (from IRD_App.html)
 * Three smaller script files instead of one large one: a cut-off paste is easier to spot, and Apps Script loads them in any order.
 * Run: node tools/bundle.js
 */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'deploy');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\nif \(typeof module[^\n]*/, '').replace(/\s+$/, '') + '\n';
const date = new Date().toISOString().slice(0, 10);
const files = [['Code.gs', 'Code.gs', 'the backend'], ['Engine.gs', 'IRD_Core.gs', 'the recovery logic'], ['Service.gs', 'IRD_Service.gs', 'the screens and the refresh job']];
files.forEach(([name, src, what]) => {
  const head = '// RECOVERY ENGINE · ' + name + ' (' + what + '). In Apps Script this file must be called ' + name.replace('.gs', '') + '.\n' +
    '// Paste the whole file, replacing everything in it. Built ' + date + ' from ' + src + '. Do not edit here; settings live in the CFG tab.\n\n';
  fs.writeFileSync(path.join(out, name), head + read(src) + '\n// ===== END OF ' + name + '. If this line is the last line in Apps Script, the paste is complete. =====\n');
});
fs.copyFileSync(path.join(root, 'IRD_App.html'), path.join(out, 'App.html'));
console.log(files.map(f => 'deploy/' + f[0] + ' ' + fs.statSync(path.join(out, f[0])).size + ' bytes').join(' | ') + ' | deploy/App.html ' + fs.statSync(path.join(out, 'App.html')).size + ' bytes');
