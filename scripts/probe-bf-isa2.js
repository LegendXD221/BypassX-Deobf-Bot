/**
 * Phase 2b — behavioral ISA prober, one luau process per probe (hard-killed),
 * parallel 8. Live stdout parsing (native=false → print goes straight out).
 *
 *   node scripts/probe-bf-isa2.js --mode uniform            # op-column + RET discovery
 *   node scripts/probe-bf-isa2.js --mode ops                # probe every op in the global set
 *
 * Results appended to var/external/bf-v147-probe-results.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { unwrapV14Wire } = await import(path.join(root, 'src', 'luraph14-wire.js'));
const hm = require(path.join(root, 'vendor', 'luraph-v15', 'src', 'harness.js'));
const LUAAU_BIN = path.join(root, 'vendor', 'luraph-v15', 'bin', 'luau');

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MODE = argOf('--mode', 'uniform');
const WORKERS = Number(argOf('--workers', 8));
const KILL_MS = Number(argOf('--kill', 9000));
const OUT_JSONL = path.join(root, 'var', 'external', 'bf-v147-probe-results.jsonl');

// ---------- sample + wire ----------
const sample = fs.readFileSync(path.join(root, 'var', 'external', 'bloxfruits.lua'), 'latin1');
const wire = unwrapV14Wire(sample);
const vmSource0 = Buffer.from(wire.vmChunk).toString('latin1');
const MINI_PRELUDE = fs.readFileSync(path.join(root, 'scripts', 'devirt-bf-v147.js'), 'utf8')
  .match(/const MINI_PRELUDE = `([\s\S]*?)`;/)[1];

// global op set from c7 across all protos
const dump = fs.readFileSync(path.join(root, 'var', 'external', 'bf-v147-dump-lines.txt'), 'latin1').split('\n');
{
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
  const opSet = new Set();
  for (const [label, n] of Object.entries(nodes)) {
    if (n.kind !== 'table') continue;
    const keys = n.fields.map(([k]) => fkey(k));
    if (keys.length === 11 && keys.every((k, i) => k === i + 1)) {
      const f7 = n.fields.find(([k]) => fkey(k) === 7);
      if (f7 && f7[1].startsWith('REF T')) {
        const col = nodes[f7[1].slice(4)];
        for (const [, v] of col.fields) if (v.startsWith('n:')) opSet.add(Number(v.slice(2)));
      }
    }
  }
  globalThis.OP_SET = [...opSet].sort((a, b) => a - b);
}
console.log('global op set:', globalThis.OP_SET.length, 'values:', globalThis.OP_SET.slice(0, 60).join(','));

// ---------- data literal ----------
let dataLit = '';
for (const b of wire.data) {
  if (b === 0x5c) dataLit += '\\\\';
  else if (b === 0x27) dataLit += "\\'";
  else if (b === 0x22) dataLit += '\\"';
  else if (b === 0x0a) dataLit += '\\n';
  else if (b === 0x0d) dataLit += '\\r';
  else if (b >= 32 && b < 127) dataLit += String.fromCharCode(b);
  else dataLit += '\\' + String(b).padStart(3, '0');
}
function longBracket(s) {
  let level = 0;
  while (s.includes(']' + '='.repeat(level) + ']')) level++;
  const eq = '='.repeat(level);
  return '[' + eq + '[' + s + ']' + eq + ']';
}

// ---------- probe hook generator ----------
function hookLua(kind, a, b) {
  // probe = the REAL program with pc1's opcode replaced by `a`.
  // b: 0 = keep real operands at pc1, 1 = patterned operands (1,2,3)
  const isPair = kind === 'pair';
  const variant = kind === 'op' ? b : 0;
  const opv = kind === 'op' ? a : null;
  const pairV = isPair ? String(a).split(',')[0] : null;
  const pairW = isPair ? String(a).split(',')[1] : null;
  return `
do
  local N = #A[7]
  local r7, r8, r9, r11 = {}, {}, {}, {}
  for i = 1, N do r7[i] = A[7][i]; r8[i] = A[8][i]; r9[i] = A[9][i]; r11[i] = A[11][i] end
  local s1, s2, s3, s4, s5, s6, s10 = A[1], A[2], A[3], A[4], A[5], A[6], A[10]
  local function sh(v)
    local s = tostring(v)
    if s:find('Luraph Script') then
      s = s:gsub('.*%]:%d+: ', '')
      s = s:gsub('.*%]: ', '')
      return (s:sub(-110))
    end
    return #s > 90 and (s:sub(1, 90) .. '...') or s
  end
  print('#PRE kind=${kind} a=${a} b=${variant}')
${opv !== null ? `  A[7][1] = ${opv}
` : ''}${isPair ? `  A[7][1] = ${pairV}; A[11][1] = ${pairW}
` : ''}${variant === 1 ? "  A[8][1] = 1; A[9][1] = 2; A[11][1] = 3\n" : ""}
  local ok, r1, r2, r3 = pcall((F[51](A, F[34])), M, d, M.l, F[21], f, F[35], F[37], F[40], F[44], F[45], M.B, F[51])
  print('#RES kind=${kind} a=${a} b=${variant} ok=' .. tostring(ok) .. ' r1=' .. sh(r1) .. ' r2=' .. sh(r2) .. ' r3=' .. sh(r3))
  for i = 1, N do A[7][i] = r7[i]; A[8][i] = r8[i]; A[9][i] = r9[i]; A[11][i] = r11[i] end
  A[1], A[2], A[3], A[4], A[5], A[6], A[10] = s1, s2, s3, s4, s5, s6, s10
  print('#PROBEEND')
end
`;
}

const HOOK_SITE = 'A=F[51](A,F[34])(M,d,M.l,F[21],f,F[35],F[37],F[40],F[44],F[45],M.B,F[51]);return F[51](A,F[34]);end';

function buildDriver(hook) {
  let vmPatched = vmSource0.replace(HOOK_SITE, hook + HOOK_SITE);
  vmPatched = MINI_PRELUDE + vmPatched;
  return [
    "print('#START')",
    'local BXVM = ' + longBracket(vmPatched),
    'local BXDATA = "' + dataLit + '"',
    'local fn = loadstring(BXVM)',
    "if type(fn) ~= 'function' then print('#LOADFAIL') return end",
    'local ok, err = pcall(fn, buffer.fromstring(BXDATA))',
    "print('#PCALL ' .. tostring(ok) .. ' ' .. tostring(err))",
  ].join('\n');
}

// ---------- runner ----------
function runProbe(tag, hook) {
  return new Promise((resolve) => {
    const driver = buildDriver(hook);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxp-'));
    const hpath = path.join(dir, 'h.luau');
    fs.writeFileSync(hpath, hm.buildHarness(driver, {
      time_budget: 60, report_chunks: false, live_prints: true, skip_protos: [], devirt: false,
      trace: false, probe: false, ptrace: false, max_block: 100_000_000, max_stmts: 400_000_000,
    }, {}), 'latin1');
    const proc = spawn(LUAAU_BIN, [hpath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let doneEarly = false;
    const t0 = Date.now();
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, KILL_MS);
    proc.stdout.on('data', (b) => {
      out += b.toString('latin1');
      // early kill: the live channel already delivered the probe result —
      // skip the big end-of-run report entirely
      if (!doneEarly && out.includes('#RES ') && out.split('#RES ').length > 1 && out.includes('#PROBEEND')) {
        doneEarly = true;
        try { proc.kill('SIGKILL'); } catch {}
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      clearTimeout(timer);
      try { fs.mkdirSync(path.join(root, 'var', 'external', 'probe-debug'), { recursive: true }); fs.writeFileSync(path.join(root, 'var', 'external', 'probe-debug', tag.replace(/[^a-z0-9]+/gi, '_') + '.txt'), out); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      const res = [...out.matchAll(/^#RES (.*)$/gm)].map((m) => m[1]);
      {
        const unesc = (t) => t.replace(/\\\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[c] ?? c));
        const lv = [...out.matchAll(/\[LIVE\]\s*print\("(.*)"\)\s*$/gm)].map((m) => unesc(m[1]));
        res.push(...lv.filter((t) => t.startsWith('#RES') || t.startsWith('#PRE') || t.startsWith('#PROBEEND')));
      }
      const end = out.includes('#PROBEEND');
      resolve({ tag, res, end, ms: Date.now() - t0 });
    });
  });
}

async function pool(items, worker, n) {
  const results = [];
  let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < items.length) {
      const i = idx++;
      const r = await worker(items[i], i);
      results[i] = r;
      process.stdout.write(`[${i + 1}/${items.length}] ${r.tag} → ${(r.res[0] || '(killed)').slice(0, 90)}\n`);
    }
  }));
  return results;
}

fs.mkdirSync(path.dirname(OUT_JSONL), { recursive: true });
const jobs = [];
if (MODE === 'ctrl') {
  jobs.push({ kind: 'ctrl', a: '0', b: 0 });
} else if (MODE === 'pair') {
  const pairs = JSON.parse(fs.readFileSync(path.join(root, 'var', 'external', 'bf-v147-pairs.json'), 'utf8'));
  for (const [v, w] of pairs) jobs.push({ kind: 'pair', a: `${v},${w}`, b: 0 });
} else {
  for (const v of globalThis.OP_SET) for (const variant of [0, 1]) {
    jobs.push({ kind: 'op', a: String(v), b: variant });
  }
}
console.log(`mode=${MODE} jobs=${jobs.length} workers=${WORKERS} kill=${KILL_MS}ms`);
const results = await pool(jobs, (j) => runProbe(`${j.kind}:${String(j.a).replace(/,/g, '_')}:${j.b ?? ''}`, hookLua(j.kind, j.a, j.b)), WORKERS);
const stream = fs.createWriteStream(OUT_JSONL, { flags: 'a' });
for (const r of results) stream.write(JSON.stringify(r) + '\n');
await new Promise((r) => stream.end(r));
console.log(`wrote ${results.length} results → ${OUT_JSONL}`);
