'use strict';
const crypto = require('crypto');

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function b32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
// 16 隨機位元組＝128 位元；base32 後 26 字元（單一 DNS 標籤 ≤63）
const newPreviewId = () => b32(crypto.randomBytes(16));

// 確定性時鐘：只在 advance() 時前進，避免真實耗時干擾 TTL 邊界測試
class Clock {
  constructor() { this.t = Date.UTC(2026, 9, 21, 9, 0, 0); }
  now() { return this.t; }
  advance(ms) { this.t += ms; }
}

module.exports = { sha256, hmac, safeEq, b32, newPreviewId, Clock };
