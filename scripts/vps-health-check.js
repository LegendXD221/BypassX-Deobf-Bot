#!/usr/bin/env node
// VPS-side health probe: hits the local /health endpoint and prints a compact result.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const req = createRequire(import.meta.url);
let port = 3000;
try {
  for (const line of readFileSync('/opt/lucid-deobf/.env', 'utf8').split('\n')) {
    const m = line.match(/^PORT=(\d+)\s*$/);
    if (m) port = Number(m[1]);
  }
} catch { /* default */ }

await new Promise((resolve) => {
  const r = req('http').get({ host: '127.0.0.1', port, path: '/health', timeout: 4000 }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => {
      const ready = /"discordReady"\s*:\s*true/.test(b) || /discordReady['"]?\s*[:=]\s*true/.test(b);
      console.log(`http ${res.statusCode} discordReady=${ready ? 'true' : 'false'}`);
      if (res.statusCode !== 200 || !ready) process.exitCode = 1;
      resolve();
    });
  });
  r.on('error', (e) => { console.log(`ERR ${e.code || e.message}`); process.exitCode = 1; resolve(); });
  r.on('timeout', () => { r.destroy(); console.log('ERR timeout'); process.exitCode = 1; resolve(); });
});
