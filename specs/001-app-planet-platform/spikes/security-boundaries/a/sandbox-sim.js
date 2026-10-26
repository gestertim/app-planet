'use strict';
// 沙箱預覽埠模擬：requireToken 為 null 代表「公開可達的供應商預覽網址」（官方文件描述 sandbox.domain() 為 publicly accessible URL）
const http = require('http');
const { serveEcho } = require('../lib/ws-mini');

function createSandbox({ requireToken = null, appJs = 'window.synthetic = true;' } = {}) {
  const hits = [];
  const denied = (req) => requireToken && req.headers['x-upstream-token'] !== requireToken;
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, cookie: req.headers.cookie || null, authorization: req.headers.authorization || null });
    if (denied(req)) { res.writeHead(401).end('upstream-denied'); return; }
    const path = req.url.split('?')[0];
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><script src="/app.js"></script><body>SYNTHETIC-STUDENT-APP</body></html>');
    } else if (path === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(appJs);
    } else {
      res.writeHead(404).end('nf');
    }
  });
  server.on('upgrade', (req, socket, head) => {
    hits.push({ url: req.url, ws: true, cookie: req.headers.cookie || null });
    if (denied(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    serveEcho(req, socket, head);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, port: server.address().port, hits, close: () => server.close() })));
}

module.exports = { createSandbox };
