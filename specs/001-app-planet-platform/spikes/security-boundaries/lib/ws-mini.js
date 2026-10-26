'use strict';
// 僅供 Spike：最小 RFC 6455 文字框架（<126 位元組），不依賴第三方套件。
const crypto = require('crypto');
const http = require('http');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (k) => crypto.createHash('sha1').update(k + GUID).digest('base64');

function encode(text, mask) {
  const p = Buffer.from(text);
  if (p.length >= 126) throw new Error('frame too large for spike');
  if (!mask) return Buffer.concat([Buffer.from([0x81, p.length]), p]);
  const m = crypto.randomBytes(4);
  const o = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) o[i] = p[i] ^ m[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, o]);
}

function decode(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const op = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    const len = buf[off + 1] & 0x7f;
    const hdr = 2 + (masked ? 4 : 0);
    if (buf.length - off < hdr + len) break;
    let payload = buf.subarray(off + hdr, off + hdr + len);
    if (masked) {
      const m = buf.subarray(off + 2, off + 6);
      payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4]));
    }
    frames.push({ op, text: payload.toString() });
    off += hdr + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function serveEcho(req, socket, head) {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
  );
  let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  socket.on('data', (d) => {
    pending = Buffer.concat([pending, d]);
    const { frames, rest } = decode(pending);
    pending = rest;
    for (const f of frames) {
      if (f.op === 8) socket.end();
      else if (f.op === 1) socket.write(encode(`echo:${f.text}`, false));
    }
  });
  socket.on('error', () => {});
}

// 回傳 { status, socket?, send(text), next(timeoutMs) }；非 101 回應 status 為 HTTP 狀態碼
function connect({ port, host, path = '/ws', headers = {} }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Host: host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('upgrade', (res, socket, head) => {
      const queue = [];
      let waiter = null;
      let closed = false;
      let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const flush = (v) => {
        if (waiter) { const w = waiter; waiter = null; w(v); } else queue.push(v);
      };
      socket.on('data', (d) => {
        pending = Buffer.concat([pending, d]);
        const { frames, rest } = decode(pending);
        pending = rest;
        frames.forEach((f) => (f.op === 1 ? flush(f.text) : null));
      });
      const onClose = () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } };
      socket.on('close', onClose);
      socket.on('error', () => {});
      resolve({
        status: 101,
        socket,
        isClosed: () => closed || socket.destroyed,
        send: (t) => { try { socket.write(encode(t, true)); } catch (_) { /* closed */ } },
        next: (ms = 1500) =>
          new Promise((res) => {
            if (queue.length) return res(queue.shift());
            if (closed) return res(null);
            waiter = res;
            setTimeout(() => { if (waiter === res) { waiter = null; res(undefined); } }, ms);
          }),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { serveEcho, connect };
