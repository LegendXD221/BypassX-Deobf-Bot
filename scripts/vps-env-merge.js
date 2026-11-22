#!/usr/bin/env node
// VPS-side: merge the fetched Render overlay (KEY=VALUE lines) into /opt/lucid-deobf/.env.
// Empty values are skipped (never blank out a configured key). PUBLIC_URL/NODE_VERSION
// are VPS-specific and intentionally not taken from Render.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , overlayPath] = process.argv;
if (!overlayPath) {
  console.error('usage: node vps-env-merge.js <overlay-file>');
  process.exit(2);
}
const ENV_PATH = '/opt/lucid-deobf/.env';
const SKIP = new Set(['PUBLIC_URL', 'NODE_VERSION']);

const overlay = new Map();
for (const line of readFileSync(overlayPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  const [, k, v] = m;
  if (SKIP.has(k)) continue;
  if (!v) continue; // skip empty — do not blank out existing values
  overlay.set(k, v);
}

const cur = readFileSync(ENV_PATH, 'utf8').split('\n');
const out = [];
const seen = new Set();
for (const line of cur) {
  if (/^# Fill DISCORD_TOKEN/i.test(line)) continue; // stale hint comment
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && overlay.has(m[1])) {
    out.push(`${m[1]}=${overlay.get(m[1])}`);
    seen.add(m[1]);
  } else {
    out.push(line);
  }
}
for (const [k, v] of overlay) if (!seen.has(k)) out.push(`${k}=${v}`);

const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
writeFileSync(ENV_PATH, cleaned);
console.log(`merged ${overlay.size} key(s): ${[...overlay.keys()].join(', ') || '(none)'}`);
