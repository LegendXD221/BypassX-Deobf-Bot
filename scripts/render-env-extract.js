#!/usr/bin/env node
// Runner-side: parse Render env-vars API response -> envv.txt (KEY=VALUE lines).
// Values are never printed — only lengths / EMPTY flags.
import { readFileSync, writeFileSync } from 'node:fs';

const j = JSON.parse(readFileSync('envs.json', 'utf8'));
const arr = Array.isArray(j) ? j : (j.env_vars || []);
const pick = (k) => {
  const e = arr.find((x) => (x.key || (x.envVar && x.envVar.key)) === k);
  if (!e) return '';
  return String(e.value ?? (e.envVar && e.envVar.value) ?? '');
};

const wanted = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'DATABASE_URL', 'PASTEFY_TOKEN'];
const lines = [];
for (const k of wanted) {
  const v = pick(k);
  lines.push(`${k}=${v}`);
  console.log(`${k}: ${v ? `set (len ${v.length})` : 'EMPTY'}`);
}
writeFileSync('envv.txt', lines.join('\n') + '\n');
console.log('envv.txt written');
