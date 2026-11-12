'use strict';
// Runway Digital Twin simulation - web server. No dependencies: run with `node server.js`.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const engine = require('./engine');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'runway2026';
const SAVE = path.join(os.tmpdir(), 'runway-sim-state.json');
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

let state;
try { state = JSON.parse(fs.readFileSync(SAVE, 'utf8')); if (!state.rooms || !state.participants) throw 0; console.log('Restored saved state.'); }
catch (e) { state = engine.create(); }
setInterval(() => fs.writeFile(SAVE, JSON.stringify(state), () => {}), 5000);

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = engine.handle(state, JSON.parse(body || '{}'), Date.now(), ADMIN_KEY); }
      catch (e) { console.error(e); out = { error: 'Server error.' }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  let u = req.url.split('?')[0];
  if (u === '/') u = '/index.html';
  if (u === '/admin') u = '/admin.html';
  const file = path.join(PUB, path.normalize(u));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('Runway simulation running on port ' + PORT);
  console.log('Participants:  http://localhost:' + PORT + '/');
  console.log('Admin screen:  http://localhost:' + PORT + '/admin   (admin key: ' + ADMIN_KEY + ')');
});
