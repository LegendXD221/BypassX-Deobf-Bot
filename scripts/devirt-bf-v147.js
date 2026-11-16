/**
 * Luraph v14.7 STATIC devirtualization — bloxfruits.lua (and any wire-shaped
 * v14.7 build). Full chain without fengari:
 *
 *   1. unwrap the base85+LZMA wire statically      (src/luraph14-wire.js)
 *   2. inject a cyclic-safe table dumper INTO the VM chunk (it is a separate
 *      loadstring'd chunk, so outer-chunk locals are invisible to it), and
 *      hook the end of the VM entry method O()'s init chain — right before
 *      the payload closure is invoked — to print the deserialized program
 *      graph (protos + operand columns + per-pc constants).
 *   3. run the driver on the vendored NATIVE luau runtime (harness.runOnce)
 *      — deserialization is 100x faster than fengari.
 *   4. parse the #TABLE/#SCALAR dump → liftVmProgram() → readable Lua.
 *
 * Usage: node scripts/devirt-bf-v147.js [--vm <vmchunk>] [--data <bin>] [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const { unwrapV14Wire } = await import(path.join(root, 'src', 'luraph14-wire.js'));
const { extractRecordedPrints, parseStateDump } = await import(path.join(root, 'src', 'luraph14.js'));
const { liftVmProgram, verifyLift } = await import(path.join(root, 'src', 'luraph14-lift.js'));

const hm = require(path.join(root, 'vendor', 'luraph-v15', 'src', 'harness.js'));
const LUAAU_BIN = path.join(root, 'vendor', 'luraph-v15', 'bin', 'luau');

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = argOf('--out', path.join(root, 'var', 'external', 'bf-v147-lifted.lua'));

// ---------- 1. wire unwrap ----------
const samplePath = argOf('--src', path.join(root, 'var', 'external', 'bloxfruits.lua'));
const sample = fs.readFileSync(samplePath, 'latin1');
const t0 = Date.now();
const wire = unwrapV14Wire(sample);
if (!wire || !wire.vmChunk || !wire.data) {
  console.error('FAIL: wire unwrap produced nothing');
  process.exit(1);
}
console.log(`[1] wire unwrapped: VM chunk ${wire.vmChunk.length}B + bytecode ${wire.data.length}B (${Date.now() - t0}ms)`);

// ---------- 2. patch the VM chunk ----------
const MINI_PRELUDE = `local __BXBUF={};local function __BXFLUSH()if #__BXBUF>0 then print(table.concat(__BXBUF,'\\n'));__BXBUF={} end end;local function __BXPUSH(line)__BXBUF[#__BXBUF+1]=line;if #__BXBUF>=300 then __BXFLUSH() end end;local function __BXD(E)local string=string;local type=type;local print=print;local fmt=string.format;local sub=string.sub;local byte=string.byte;local gsub=string.gsub;local tins=table.insert;local ids={};local nextId=0;local nnodes=0;local function esc(s)return gsub(s,'[%c"\\\\]',function(c)return fmt('x%02X',byte(c)) end) end;local function scal(v)local t=type(v)if t=='string' then local n=#v if n<=512 then return 's'..n..':'..esc(v) end return 'S'..n..':'..esc(sub(v,1,192)) elseif t=='number' then return 'n:'..fmt('%.17g',v) elseif t=='boolean' then return v and 'b:1' or 'b:0' elseif t=='nil' then return '~' elseif t=='function' then local id=ids[v]if not id then nextId=nextId+1;id=nextId;ids[v]='F'..id end return 'REF F'..id else return 'REF ?'..t end end;local queue={{E,'ROOT'}}ids[E]='T1';nextId=1;while #queue>0 do local item=table.remove(queue)local node=item[1]local label=item[2]if type(node)~='table' then __BXPUSH(fmt('#%s SCALAR %s',label,scal(node)))else label=ids[node]or label nnodes=nnodes+1 if nnodes>400000 then __BXPUSH('#LIMIT nodes')break end local mt=getmetatable(node)local arrN=#node local parts={}for k,v in pairs(node)do local kt=type(k)local kenc if kt=='number' then kenc='n:'..fmt('%.17g',k)elseif kt=='string' then kenc='s'..#k..':'..esc(k)elseif kt=='boolean' then kenc=k and 'b:1' or 'b:0'else kenc='K?'..kt end local vt=type(v)if vt=='table' then local vid=ids[v]if not vid then nextId=nextId+1;vid='T'..nextId;ids[v]=vid;tins(queue,{v,vid})end parts[#parts+1]=kenc..'\\tREF '..vid else parts[#parts+1]=kenc..'\\t'..scal(v)end end local buf={fmt('#%s TABLE arr=%d mt=%s n=%d',label,arrN,mt and 'Y' or '-',#parts)}for i=1,#parts do buf[#buf+1]=parts[i] end __BXPUSH(table.concat(buf,'\\n'))end end __BXPUSH('#DONE nodes='..nnodes)__BXFLUSH() end;`;

const vmSource0 = Buffer.from(wire.vmChunk).toString('latin1');
const HOOK_SITE = 'A=F[51](A,F[34])(M,d,M.l,F[21],f,F[35],F[37],F[40],F[44],F[45],M.B,F[51]);return F[51](A,F[34]);end';
const HOOK_DUMP = '__BXD({d=d,f=f,A=A,F=F,j=j,i=i,M=M});__BXFLUSH();' + HOOK_SITE;
let vmPatched = vmSource0;
if (!vmSource0.includes(HOOK_SITE)) {
  console.error('FAIL: O() hook site not found in VM chunk');
  process.exit(1);
}
vmPatched = vmPatched.replace(HOOK_SITE, HOOK_DUMP);
vmPatched = MINI_PRELUDE + vmPatched;
console.log('[2] VM chunk patched: mini-prelude injected + O() exit hook (dump state before payload call)');

// ---------- 3. driver for the native luau runtime ----------
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
const driver = [
  "print('#START v14.7 static devirt driver')",
  'local BXVM = ' + longBracket(vmPatched),
  'local BXDATA = "' + dataLit + '"',
  'local fn = loadstring(BXVM)',
  "if type(fn) ~= 'function' then print('#LOADFAIL compile'); return end",
  'print("#LOADOK vmchunk")',
  'local ok, err = pcall(fn, buffer.fromstring(BXDATA))',
  "print('#PCALL ' .. tostring(ok) .. ' ' .. tostring(err))",
].join('\n');

const cfg = {
  time_budget: 240,
  report_chunks: true,
  skip_protos: [],
  devirt: false,
  trace: false,
  probe: false,
  ptrace: false,
  max_block: 100_000_000,
  max_stmts: 400_000_000,
};

console.log('[3] running native luau (budget 240s)…');
const t1 = Date.now();
const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bx147-'));
const hpath = path.join(dir, 'harness.luau');
const r = await hm.runOnce(LUAAU_BIN, driver, cfg, hpath, 300, false, {});
console.log(`    runOnce done in ${((Date.now() - t1) / 1000).toFixed(1)}s — body=${r.body ? r.body.length + 'B' : 'null'}`);
if (!r.body) {
  console.error('RUN FAILED (no ENVLOG report):', (r.err || '').slice(-1500));
  process.exit(2);
}
fs.writeFileSync(path.join(root, 'var', 'external', 'bf-v147-run-body.txt'), r.body);

// ---------- 4. parse the dump ----------
const lines = extractRecordedPrints(r.body);
const start = lines.findIndex((l) => l.startsWith('#START'));
console.log(`[4] captured ${lines.length} recorded lines (first 3: ${lines.slice(0, 3).map((l) => l.slice(0, 60)).join(' | ')})`);
if (start === -1) {
  console.error('FAIL: driver did not start — report tail:');
  console.error(lines.slice(-20).join('\n'));
  process.exit(3);
}
const doneIdx = lines.findIndex((l) => l.startsWith('#DONE nodes='));
const state = parseStateDump(lines.slice(start));
const tableCount = Object.values(state.nodes).filter((n) => n.kind === 'table').length;
console.log(`    dump: ${tableCount} tables, ${state.order.length} nodes, DONE=${doneIdx !== -1}`);

// ---------- 5. lift ----------
const graph = { nodes: state.nodes, order: state.order };
const lifted = liftVmProgram(graph);
console.log(`[5] lift: protos=${lifted.protos} instructions=${lifted.instructions} reachable=${lifted.reachable} decoys=${lifted.decoys} stats=${JSON.stringify(lifted.stats)}`);
if (!lifted.instructions) {
  console.error('FAIL: zero instructions lifted — no 11-key proto tables in dump');
  process.exit(4);
}
const check = verifyLift(lifted.code);
console.log(`    verifyLift: ok=${check.ok} ${check.err ? String(check.err).slice(0, 300) : ''}`);

fs.writeFileSync(OUT, lifted.code, 'utf8');
console.log(`[6] lifted readable Lua → ${OUT} (${(lifted.code.length / 1024).toFixed(0)}KB)`);
fs.writeFileSync(OUT.replace(/\.lua$/, '.meta.json'), JSON.stringify({
  protos: lifted.protos, instructions: lifted.instructions, reachable: lifted.reachable,
  decoys: lifted.decoys, stats: lifted.stats, verified: check.ok === true,
  vmBytes: wire.vmChunk.length, dataBytes: wire.data.length, runMs: Date.now() - t1,
}, null, 2));
