/**
 * Extract all distinct (c7,c11) pairs whose c7 is in the valid-row set
 * (from probe round 1: rows that did NOT hit ERR-INDEX at pc1) and emit
 * the pair list for the pair-probe suite.
 */
import fs from 'node:fs';

const root = '/home/z/my-project/download/bypassx-deobf-bot';
const dump = fs.readFileSync(path0(root), 'latin1').split('\n');
function path0(root) { return root + '/var/external/bf-v147-dump-lines.txt'; }

const nodes = {}; let current = null;
for (const line of dump) {
  if (line.startsWith('#')) {
    let t = /^#(\S+) TABLE arr=(\d+) mt=(\S+) n=(\d+)/.exec(line);
    if (t) { current = t[1]; nodes[t[1]] = { kind: 'table', fields: [] }; continue; }
    t = /^#(\S+) SCALAR (.*)$/.exec(line);
    if (t) { current = null; continue; }
    current = null; continue;
  }
  if (current && line.includes('\t')) {
    const k = line.slice(0, line.indexOf('\t')).trim();
    const v = line.slice(line.indexOf('\t') + 1).trim();
    if (k && v) nodes[current].fields.push([k, v]);
  }
}
const fkey = (k) => (k.startsWith('n:') ? Number(k.slice(2)) : k);
function resolveArray(label) {
  const n = nodes[label];
  if (!n || n.kind !== 'table') return [];
  const arr = new Map();
  for (const [k, v] of n.fields) {
    const kt = fkey(k);
    if (typeof kt === 'number' && v.startsWith('n:')) arr.set(kt, Number(v.slice(2)));
  }
  const mx = Math.max(...arr.keys());
  const out = [];
  for (let i = 1; i <= mx; i++) out.push(arr.has(i) ? arr.get(i) : 0);
  return out;
}

// valid rows from probe round 1 (non ERR-INDEX classes)
const classes = JSON.parse(fs.readFileSync(root + '/var/external/bf-v147-isa-classes.json', 'utf8'));
const validRows = new Set(classes.filter((c) => !c.c0.startsWith('ERR-INDEX') && c.c0 !== 'SPIN' || c.c0 === 'SPIN' || true).filter((c) => c.c0 !== 'ERR-INDEX').map((c) => c.op));
console.log('valid rows (round-1 non-ERR-INDEX):', [...validRows].sort((a, b) => a - b).join(','));

// all distinct pairs with c7 in validRows
const pairCount = {};
const protos = [];
for (const [label, n] of Object.entries(nodes)) {
  if (n.kind !== 'table') continue;
  const keys = n.fields.map(([k]) => fkey(k));
  if (keys.length === 11 && keys.every((k, i) => k === i + 1)) {
    const f = {};
    for (const [k, v] of n.fields) f[fkey(k)] = v;
    const c7 = f[7].startsWith('REF T') ? resolveArray(f[7].slice(4)) : [];
    const c11 = f[11].startsWith('REF T') ? resolveArray(f[11].slice(4)) : [];
    protos.push({ label, c7, c11 });
    for (let i = 0; i < Math.min(c7.length, c11.length); i++) {
      if (!validRows.has(c7[i])) continue;
      const key = `${c7[i]},${c11[i]}`;
      pairCount[key] = (pairCount[key] || 0) + 1;
    }
  }
}
const pairs = Object.entries(pairCount).sort((a, b) => b[1] - a[1]);
console.log('protos:', protos.length, 'distinct valid-row pairs:', pairs.length);
console.log('top 20:', pairs.slice(0, 20).map(([p, c]) => `(${p})x${c}`).join(' '));
fs.writeFileSync(root + '/var/external/bf-v147-pairs.json', JSON.stringify(pairs.map(([p]) => p.split(',').map(Number)), null, 0));
console.log('saved → var/external/bf-v147-pairs.json');
