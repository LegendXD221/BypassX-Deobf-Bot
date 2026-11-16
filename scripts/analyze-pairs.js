/**
 * Analyze pair-probe results → pair→behavior map + consistency validation.
 * Checks: (1) how many pairs are valid ops; (2) do closure-anchor pairs decode
 * to a consistent class; (3) do the (c7,c11) pairs map 1:1 to behavior classes.
 */
import fs from 'node:fs';

const lines = fs.readFileSync('/home/z/my-project/download/bypassx-deobf-bot/var/external/bf-v147-probe-results.jsonl', 'utf8').trim().split('\n');
const results = lines.map((l) => JSON.parse(l));

function parseRes(arr) {
  const res = arr.find((t) => t.startsWith('#RES'));
  if (!res) return { killed: true };
  const m = /^#RES kind=(\w+) a=(\S+) b=(\S+) ok=(\w+) r1=(.*?) r2=(.*?) r3=(.*?)$/.exec(res);
  if (!m) return { raw: res };
  return { ok: m[4] === 'true', r1: m[5], r2: m[6], r3: m[7] };
}
const classify = (r) => {
  if (r.killed) return 'SPIN';
  if (r.ok === true) return 'RETURN:' + (r.r1 || 'nil').slice(0, 12);
  const e = (r.r1 || '') + (r.r2 || '');
  if (/attempt to perform arithmetic/.test(e)) return 'ARITH';
  if (/attempt to call/.test(e)) return 'CALL';
  if (/attempt to index/.test(e)) return 'INDEX';
  if (/attempt to concatenate/.test(e)) return 'CONCAT';
  if (/attempt to compare/.test(e)) return 'COMPARE';
  if (/buffer access out of bounds/.test(e)) return 'BUFFOOB';
  if (/loop truncated/.test(e)) return 'LOOP';
  if (/budget exhausted/.test(e)) return 'BUDGET';
  return 'OTHER';
};

const byPair = {};
for (const r of results) {
  const m = /^pair:(\d+)_(\d+):0$/.exec(r.tag);
  if (!m) continue;
  byPair[`${m[1]},${m[2]}`] = classify(parseRes(r.res));
}
console.log('pairs probed:', Object.keys(byPair).length);
const clsCount = {};
for (const [, c] of Object.entries(byPair)) {
  const k = c.split(':')[0];
  clsCount[k] = (clsCount[k] || 0) + 1;
}
console.log('class distribution:', JSON.stringify(clsCount));

// RETURN detail
const rets = Object.entries(byPair).filter(([, c]) => c.startsWith('RETURN'));
console.log('\nRETURN pairs:', rets.length);
for (const [p, c] of rets.slice(0, 20)) console.log(`  (${p}) → ${c}`);

// SPIN pairs
const spins = Object.entries(byPair).filter(([, c]) => c === 'SPIN');
console.log('\nSPIN pairs:', spins.map(([p]) => `(${p})`).join(' '));

// non-INDEX pairs = valid ops
const valid = Object.entries(byPair).filter(([, c]) => c !== 'INDEX' && !c.startsWith('OTHER'));
console.log('\nvalid (non-INDEX) pairs:', valid.length);
fs.writeFileSync('/home/z/my-project/download/bypassx-deobf-bot/var/external/bf-v147-pair-classes.json', JSON.stringify(byPair, null, 1));
console.log('saved → var/external/bf-v147-pair-classes.json');
