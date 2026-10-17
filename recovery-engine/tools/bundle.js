/** Builds the two files you paste into Apps Script: deploy/Code.gs (all backend code) and deploy/App.html (the app page). Run: node tools/bundle.js */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\nif \(typeof module[^\n]*/, '');
const banner = '// RECOVERY ENGINE - paste this whole file into Code.gs in Apps Script (replace everything that is there).\n' +
  '// Built ' + new Date().toISOString().slice(0, 10) + ' from IRD_Core.gs + IRD_Service.gs + Code.gs. Do not edit here; settings live in the CFG tab.\n\n';
fs.writeFileSync(path.join(root, 'deploy', 'Code.gs'), banner + read('IRD_Core.gs') + '\n\n' + read('IRD_Service.gs') + '\n\n' + read('Code.gs') + '\n// ===== END OF Code.gs. If this line is the last line in Apps Script, the paste is complete. =====\n');
fs.copyFileSync(path.join(root, 'IRD_App.html'), path.join(root, 'deploy', 'App.html'));
console.log('deploy/Code.gs', fs.statSync(path.join(root, 'deploy', 'Code.gs')).size, 'bytes | deploy/App.html', fs.statSync(path.join(root, 'deploy', 'App.html')).size, 'bytes');
