'use strict';
// 合成學生處理程式：從 stdin 讀 { request, data }，輸出 { status, body, writes? }
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const n = Number((input.data && input.data.counter) || 0) + 1;
process.stdout.write(JSON.stringify({
  status: 200,
  body: { echo: input.request, counter: n },
  writes: [{ key: 'counter', value: String(n) }],
}));
