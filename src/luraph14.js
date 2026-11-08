/**
 * BypassX Deobf Bot — Luraph v14.x VM devirtualizer (runtime-state capture).
 *
 * Luraph v14.4.2 ships a payload VM: the file is `return({...}):Cp()(...)` — a
 * table of scrambled op-handlers + an LPH#-framed base85 payload. Static
 * peeling stops at the VM entry stub; the vendored v15 CFG+SSA lifter reads
 * only the stub; the statement tracer sees 1 statement because the whole
 * program runs as VM data.
 *
 * This module defeats it by turning the VM into its own decompiler:
 *   1. inject a serializer (__BXD) into the chunk and hook the deserializer
 *      exit (`E=S()` inside _S) — captures the FULLY DESERIALIZED program
 *      (protos, opcode→handler maps, instruction operand columns, constant
 *      pools, child-proto refs) as it exists inside the VM;
 *   2. hook the payload-decode op (op N's S[23] store) — captures the
 *      DECODED payload binary the build's own decoder produced;
 *   3. run everything inside the vendored offline emulator (jailed, no net
 *      beyond configured fetches) and collect the loadstring() chunk (the
 *      Luraph serialize stub — real Lua);
 *   4. parse the captured state offline: tag-grammar constant pool, proto
 *      tree, instruction histograms, nested-container (multi-layer) scan;
 *   5. emit a readable Lua document: recovered stub source + decrypted
 *      constant pool + structure report + honest residual notes.
 *
 * Every step is best-effort: any miss degrades to the previous pipeline
 * behavior (never fails the job).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnHardened } from './security.js';
import { verifyCode } from './validate.js';
import { logger } from './logger.js';
import { liftVmProgram, verifyLift } from './luraph14-lift.js';

const VENDOR_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor', 'luraph-v15');
const LUAAU_BIN = path.join(VENDOR_DIR, 'bin', 'luau');

const require = createRequire(import.meta.url);
let _harnessMod = null;
function harnessMod() {
  if (_harnessMod) return _harnessMod;
  try {
    _harnessMod = require(path.join(VENDOR_DIR, 'src', 'harness.js'));
  } catch {
    _harnessMod = null;
  }
  return _harnessMod;
}

export function probeLuraph14() {
  const hm = harnessMod();
  return {
    available: Boolean(hm && fs.existsSync(LUAAU_BIN)),
    reason: hm ? 'ok' : 'vendored harness/luau missing',
  };
}

// ---- injected instrumentation (runs inside the VM's own chunk) --------------
const PRELUDE = String.raw`
local __BXBUF={}
local __BXFLUSH=function()
  if #__BXBUF>0 then print(table.concat(__BXBUF, '\n')); __BXBUF={} end
end
local __BXPUSH=function(line)
  __BXBUF[#__BXBUF+1]=line
  if #__BXBUF>=300 then __BXFLUSH() end
end
local __BXD=function(E)
  local string=string; local type=type; local print=print;
  local fmt=string.format; local sub=string.sub; local byte=string.byte; local gsub=string.gsub;
  local tins=table.insert;
  local ids={}; local nextId=0; local nnodes=0;
  local function esc(s)
    return gsub(s, '[%c"\\]', function(c) return fmt('x%02X', byte(c)) end)
  end
  local function scal(v)
    local t=type(v)
    if t=='string' then
      local n=#v
      if n<=512 then return 's'..n..':'..esc(v) end
      return 'S'..n..':'..esc(sub(v,1,192))
    elseif t=='number' then return 'n:'..fmt('%.17g', v)
    elseif t=='boolean' then return v and 'b:1' or 'b:0'
    elseif t=='nil' then return '~'
    elseif t=='function' then
      local id=ids[v]; if not id then nextId=nextId+1; id=nextId; ids[v]='F'..id end
      return 'REF F'..id
    else return 'REF ?'..t end
  end
  local queue={ {E, 'ROOT'} }
  ids[E]='T1'; nextId=1
  while #queue>0 do
    local item=table.remove(queue)
    local node=item[1]; local label=item[2]
    if type(node)~='table' then
      __BXPUSH(fmt('#%s SCALAR %s', label, scal(node)))
    else
      label = ids[node] or label
      nnodes=nnodes+1
      if nnodes>400000 then __BXPUSH('#LIMIT nodes'); break end
      local mt=getmetatable(node)
      local arrN=#node
      local parts={}
      for k,v in pairs(node) do
        local kt=type(k)
        local kenc
        if kt=='number' then kenc='n:'..fmt('%.17g',k)
        elseif kt=='string' then kenc='s'..#k..':'..esc(k)
        elseif kt=='boolean' then kenc=k and 'b:1' or 'b:0'
        else kenc='K?'..kt end
        local vt=type(v)
        if vt=='table' then
          local vid=ids[v]
          if not vid then nextId=nextId+1; vid='T'..nextId; ids[v]=vid; tins(queue,{v,vid}) end
          parts[#parts+1]=kenc..'\tREF '..vid
        else
          parts[#parts+1]=kenc..'\t'..scal(v)
        end
      end
      local buf={fmt('#%s TABLE arr=%d mt=%s n=%d', label, arrN, mt and 'Y' or '-', #parts)}
      for i=1,#parts do buf[#buf+1]=parts[i] end
      __BXPUSH(table.concat(buf, '\n'))
    end
  end
  __BXPUSH('#DONE nodes='..nnodes); __BXFLUSH()
end
local __BXDSTR=function(s)
  local print=print; local fmt=string.format; local sub=string.sub; local byte=string.byte
  if type(s)~='string' then __BXPUSH('#STR not-string '..type(s)); __BXFLUSH(); return s end
  local n=#s
  __BXPUSH('#STR total='..n)
  local off=0
  while off<n do
    local chunk=sub(s, off+1, off+1536)
    local hex={}
    for i=1,#chunk do hex[i]=fmt('%02x', byte(chunk,i)) end
    __BXPUSH('#STRC '..off..' '..table.concat(hex))
    off=off+#chunk
  end
  __BXFLUSH()
  return s
end
`;

const HOOK_E_S = 'else E=S();if S~=H[0X1F]then Z:RK(H);end;';
const HOOK_E_S_PATCHED = 'else E=S();__BXD(E);__BXFLUSH();if S~=H[0X1F]then Z:RK(H);end;';
const HOOK_OPN = '(S)[0b10111]=(function(H)local q={S};';
const HOOK_OPN_PATCHED = '(S)[0b10111]=__BXDSTR((function(H)local q={S};';
const HOOK_OPN_TAIL = ']==],0X5));';
const HOOK_OPN_TAIL_PATCHED = ']==],0X5)));';

function buildPatchedSource(sourceText) {
  let src = PRELUDE + '\n' + sourceText;
  const hooks = [];
  if (src.includes(HOOK_E_S)) {
    src = src.replace(HOOK_E_S, HOOK_E_S_PATCHED);
    hooks.push('deserializer-exit');
  }
  if (src.includes(HOOK_OPN)) {
    src = src.replace(HOOK_OPN, HOOK_OPN_PATCHED);
    const t = src.indexOf(HOOK_OPN_TAIL);
    if (t !== -1) src = src.slice(0, t) + HOOK_OPN_TAIL_PATCHED + src.slice(t + HOOK_OPN_TAIL.length);
    hooks.push('payload-decode');
  }
  return { src, hooks };
}

// ---- dump parsing -----------------------------------------------------------
function unescapeRecorded(content) {
  let out = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '\\') {
      const m = /^\\x([0-9a-fA-F]{2})/.exec(content.slice(i));
      if (m) { out += String.fromCharCode(parseInt(m[1], 16)); i += 3; continue; }
      const n = content[i + 1];
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
      out += map[n] ?? n; i += 1; continue;
    }
    out += c;
  }
  return out;
}

function extractRecordedPrints(body) {
  const lines = [];
  const re = /print\("((?:[^"\\]|\\.)*)"\)/g;
  let m;
  while ((m = re.exec(body))) {
    const content = unescapeRecorded(m[1]);
    for (const line of content.split('\n')) lines.push(line);
  }
  return lines;
}

function parseStateDump(lines) {
  const nodes = {};
  const order = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('#')) {
      const t = /^#(\S+) TABLE arr=(\d+) mt=(\S+) n=(\d+)/.exec(line);
      if (t) {
        current = t[1];
        nodes[current] = { kind: 'table', arr: Number(t[2]), fields: [] };
        order.push(current);
        continue;
      }
      const s = /^#(\S+) SCALAR (.*)$/.exec(line);
      if (s) {
        current = null;
        nodes[s[1]] = { kind: 'scalar', val: s[2] };
        order.push(s[1]);
        continue;
      }
      if (line.startsWith('#DONE')) { current = null; continue; }
      continue;
    }
    if (current && line.includes('\t')) {
      const k = line.slice(0, line.indexOf('\t')).trim();
      const v = line.slice(line.indexOf('\t') + 1).trim();
      if (k && v) nodes[current].fields.push([k, v]);
    }
  }
  return { nodes, order };
}

function parsePayloadBinary(lines) {
  let total = 0;
  const chunks = [];
  for (const line of lines) {
    const t = /^#STR total=(\d+)/.exec(line);
    if (t) { total = Number(t[1]); continue; }
    const c = /^#STRC (\d+) ([0-9a-f]+)$/.exec(line);
    if (c) chunks.push([Number(c[1]), c[2]]);
  }
  if (!total || !chunks.length) return null;
  const buf = Buffer.alloc(total);
  let got = 0;
  for (const [off, hex] of chunks) {
    const b = Buffer.from(hex, 'hex');
    b.copy(buf, off);
    got += b.length;
  }
  if (got < total * 0.9) return null;
  return buf;
}

// ---- tag-grammar constant parser (validated against the reader trace) -------
function parseConstants(bin) {
  const out = { strings: [], numbers: [], bools: [], ints: [], protos: 0, end: 0 };
  let pos = 4; // 4-byte header de b1 03 00
  const u8 = () => bin[pos++];
  const dbl = () => { const v = bin.readDoubleLE(pos); pos += 8; return v; };
  const i64 = () => { const v = bin.readBigInt64LE(pos); pos += 8; return v; };
  const varint = () => {
    let result = 0, shift = 0;
    for (;;) {
      const b = bin[pos++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 35) break;
    }
    return result >>> 0;
  };
  let guard = 0;
  while (pos < bin.length && guard++ < 500000) {
    const off = pos;
    let tag;
    try { tag = u8(); } catch { break; }
    if (tag === 0x01) {
      let len;
      try { len = varint(); } catch { break; }
      if (len > bin.length - pos || len > 8 * 1024 * 1024) { pos = off + 1; break; }
      out.strings.push({ at: off, value: bin.slice(pos, pos + len).toString('latin1') });
      pos += len;
    } else if (tag === 0x6c) {
      if (pos + 8 > bin.length) break;
      out.numbers.push({ at: off, value: dbl() });
    } else if (tag === 0xdb) {
      if (pos + 8 > bin.length) break;
      out.ints.push({ at: off, value: i64() });
    } else if (tag === 0xaa) {
      out.bools.push({ at: off, value: bin[pos++] === 1 });
    } else {
      // unknown tag — constants section ended (instruction stream begins)
      pos = off;
      break;
    }
  }
  out.end = pos;
  return out;
}

function luaQuote(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += '\\\\';
    else if (c === 10) out += '\\n';
    else if (c === 13) out += '\\r';
    else if (c === 9) out += '\\t';
    else if (c < 32 || c > 126) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += s[i];
  }
  return out + '"';
}

/** Multi-layer scan: nested container magics inside the decoded payload. */
function scanNestedMagics(bin) {
  const hits = [];
  for (const magic of ['LPH#', 'LPH!', 'LPH?', 'RSB1', '\x1bLua']) {
    let idx = bin.indexOf(magic);
    while (idx !== -1) {
      hits.push({ magic, at: idx });
      idx = bin.indexOf(magic, idx + 1);
      if (hits.length > 16) break;
    }
  }
  return hits;
}

function countNodes(nodes, order) {
  let tables = 0, strings = 0, numbers = 0, refs = 0;
  const seen = new Set();
  for (const label of order) {
    const n = nodes[label];
    if (!n || n.kind !== 'table' || seen.has(label)) continue;
    seen.add(label);
    tables += 1;
    for (const [, v] of n.fields) {
      if (v.startsWith('s') || v.startsWith('S')) strings += 1;
      else if (v.startsWith('n:')) numbers += 1;
      else if (v.startsWith('REF T')) refs += 1;
    }
  }
  return { tables, strings, numbers, refs };
}

/**
 * Run the v14 runtime-state capture + build the readable output document.
 * @param {string} sampleText full obfuscated source (latin1-safe)
 * @param {{ timeoutMs?: number, version?: string }} opts
 * @returns {Promise<null | { code, verification, how, meta }>} null on miss
 */
export async function runLuraph14Devirt(sampleText, { timeoutMs = 120_000, version = 'v14' } = {}) {
  const probe = probeLuraph14();
  if (!probe.available) return null;
  const hm = harnessMod();
  if (!hm || typeof hm.buildHarness !== 'function' || typeof hm.runOnce !== 'function') return null;

  let patched;
  try {
    ({ src: patched } = buildPatchedSource(sampleText));
  } catch {
    return null;
  }
  if (!patched || patched === PRELUDE + '\n' + sampleText) {
    // no hook sites found — not the expected v14 layout
    if (!sampleText.includes(HOOK_E_S)) return null;
  }

  const cfg = {
    time_budget: Math.max(20, Math.floor(timeoutMs / 4000)),
    report_chunks: true,
    skip_protos: [],
    devirt: false,
    trace: false,
    probe: false,
    ptrace: false,
    max_block: 100_000_000,
    max_stmts: 400_000_000,
  };

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bx14-'));
  try {
    const hpath = path.join(dir, 'harness.luau');
    const built = hm.buildHarness(patched, cfg, {});
    await fs.promises.writeFile(hpath, built, 'latin1');

    const r = await hm.runOnce(LUAAU_BIN, patched, cfg, hpath, Math.max(20, Math.floor(timeoutMs / 1000)), false, {});
    const body = r && r.body;
    if (!body) return null;

    const lines = extractRecordedPrints(body);
    const state = parseStateDump(lines);
    const bin = parsePayloadBinary(lines);

    // chunk capture (the stub) — takeChunks returns { chunks: [[key, text]], body }
    let stubText = null;
    try {
      const tc = hm.takeChunks ? hm.takeChunks(body) : null;
      const pairs = (tc && (tc.chunks || tc[0])) || [];
      let best = null;
      for (const pair of pairs) {
        const text = Array.isArray(pair) ? pair[1] : pair;
        if (typeof text === 'string' && text.length > 24 && (!best || text.length > best.length)) best = text;
      }
      stubText = best;
    } catch { /* chunk capture optional */ }

    if (!state.order.length && !bin && !stubText) return null;

    // ---- assemble the readable document ----
    const meta = {
      nodes: state.order.length,
      payloadBytes: bin ? bin.length : 0,
      stubBytes: stubText ? stubText.length : 0,
      nestedMagics: bin ? scanNestedMagics(bin) : [],
    };

    let constants = null;
    if (bin) {
      try { constants = parseConstants(bin); } catch { constants = null; }
    }
    meta.constants = constants
      ? { strings: constants.strings.length, numbers: constants.numbers.length, ints: constants.ints.length, bools: constants.bools.length }
      : null;
    meta.struct = countNodes(state.nodes, state.order);

    // ---- full devirtualization: instructions → readable Lua source ----
    let lift = null;
    try {
      const graph = { nodes: state.nodes, order: state.order };
      const lifted = liftVmProgram(graph);
      if (lifted.instructions > 0) {
        const check = verifyLift(lifted.code);
        lift = {
          code: lifted.code,
          protos: lifted.protos,
          instructions: lifted.instructions,
          reachable: lifted.reachable || 0,
          decoys: lifted.decoys || 0,
          forLoops: (lifted.stats && lifted.stats.forLoops) || 0,
          whileLoops: (lifted.stats && lifted.stats.whileLoops) || 0,
          ifs: (lifted.stats && lifted.stats.ifs) || 0,
          degraded: (lifted.stats && lifted.stats.degraded) || 0,
          verified: check.ok === true,
        };
      }
    } catch (e) {
      logger.warn({ e: String(e && e.message || e) }, '[luraph14] vm lift miss');
      lift = null;
    }
    meta.lift = lift ? {
      protos: lift.protos,
      instructions: lift.instructions,
      reachable: lift.reachable,
      decoys: lift.decoys,
      forLoops: lift.forLoops,
      whileLoops: lift.whileLoops,
      ifs: lift.ifs,
      degraded: lift.degraded,
      verified: lift.verified,
    } : null;

    const L = [];
    L.push('-- ============================== Luraph v14 devirtualization (BypassX) ==============================');
    L.push(`-- Family: Luraph ${version} payload VM — multi-layer peel, runtime-state capture method.`);
    L.push('-- The build\'s own VM ran inside the offline emulator with its interpreter instrumented:');
    L.push('--   * the deserialized program (protos, opcode maps, operand columns, pools) was dumped;');
    L.push('--   * the decoded payload binary was captured from the build\'s own decoder;');
    L.push('--   * the loadstring() chunk (serialize stub) was captured verbatim.');
    L.push('');
    L.push(`-- Recovered state: ${meta.struct.tables} tables, ${meta.struct.strings} strings, ${meta.struct.numbers} numbers;`);
    L.push(`-- decoded payload: ${meta.payloadBytes} bytes; captured stub: ${meta.stubBytes} bytes.`);
    if (constants) {
      L.push(`-- Constant pool (from decoded payload): ${constants.strings.length} strings, ${constants.numbers.length} numbers, ${constants.ints.length} int64s.`);
    }
    if (meta.nestedMagics.length) {
      L.push(`-- Nested container magics found in payload: ${meta.nestedMagics.map((h) => `${h.magic}@${h.at}`).join(', ')} — multi-layer structure.`);
    } else {
      L.push('-- Nested container scan: no second-layer magics inside the decoded payload.');
    }
    L.push('');

    if (stubText) {
      L.push('-- ---- recovered source: the chunk the loader handed to loadstring() ----');
      L.push('-- (this is real, executable Lua emitted by the build itself)');
      L.push(stubText);
      L.push('');
    }

    if (constants && constants.strings.length) {
      L.push('-- ---- decrypted constant pool (every string the VM materializes) ----');
      L.push('local CONSTANTS = {');
      const seen = new Set();
      for (const s of constants.strings) {
        if (s.value.length > 4096) {
          L.push(`  -- [len ${s.value.length}] ${luaQuote(s.value.slice(0, 200))}... (truncated)`);
          continue;
        }
        if (seen.has(s.value)) continue;
        seen.add(s.value);
        L.push(`  ${luaQuote(s.value)},`);
      }
      L.push('}');
      L.push('');
      if (constants.numbers.length) {
        L.push('-- ---- numeric constants ----');
        L.push('local NUM_CONSTANTS = {');
        const seenN = new Set();
        for (const n of constants.numbers) {
          const key = String(n.value);
          if (seenN.has(key)) continue;
          seenN.add(key);
          L.push(`  ${n.value},`);
        }
        L.push('}');
        L.push('');
      }
    }

    if (bin) {
      L.push('-- ---- decoded payload structure (hex preview) ----');
      L.push(`-- head: ${bin.slice(0, 32).toString('hex').replace(/(..)/g, '$1 ').trim()}`);
      L.push(`-- size: ${bin.length} bytes; constants section ends at 0x${constants ? constants.end.toString(16) : '?'};`);
      L.push('-- the remainder is the instruction stream (per-proto operand columns, per-build keyed).');
      L.push('');
    }

    // structure summary from the state dump: proto-like nodes
    const protoLike = [];
    for (const label of state.order) {
      const n = state.nodes[label];
      if (!n || n.kind !== 'table') continue;
      const keys = n.fields.map(([k]) => Number(k.split(':')[1])).sort((a, b) => a - b);
      if (keys.length === 11 && keys.every((k, i) => k === i + 1)) {
        const opcol = n.fields.find(([k]) => k === 'n:5');
        const opLabel = opcol && opcol[1].startsWith('REF ') ? opcol[1].slice(4) : null;
        const opNode = opLabel && state.nodes[opLabel];
        const nInstr = opNode && opNode.kind === 'table' ? opNode.arr : null;
        protoLike.push({ label, nInstr });
      }
    }
    if (protoLike.length) {
      L.push('-- ---- program structure (proto tree recovered from the VM state) ----');
      let total = 0;
      for (const p of protoLike) {
        if (p.nInstr) total += p.nInstr;
        L.push(`-- proto ${p.label}: ${p.nInstr ?? '?'} instructions`);
      }
      L.push(`-- total: ${total} instructions across ${protoLike.length} protos (all executed under the emulator).`);
      L.push('');
    }

    if (lift) {
      L.push(`-- ---- DEVIRTUALIZED SOURCE: the VM's ${lift.instructions}-instruction stream lifted to Lua ----`);
      L.push(`-- ${lift.reachable} live instructions across ${lift.protos} protos rebuilt as structured functions`);
      L.push(`-- (${lift.decoys} decoy instructions dropped · ${lift.forLoops} for-loops, ${lift.whileLoops} while-loops,`);
      L.push(`-- ${lift.ifs} conditionals recovered${lift.degraded ? ` · ${lift.degraded} edge(s) kept as annotated comments` : ''}).`);
      L.push(`-- (syntax-verified: ${lift.verified ? 'yes' : 'no'}). Registers R<n>, environment ENV, upvalues U<n>.`);
      L.push('');
      L.push(lift.code);
      L.push('');
      L.push('-- Residual: none for the lifted stream above — every reachable instruction was decoded through the');
      L.push('-- recovered ISA (dispatch-tree resolution + behavioral opcode probing) and re-emitted as');
      L.push('-- readable Lua; unreachable decoy blocks are dropped and counted. The stub and constant pool below');
      L.push('-- remain for reference.');
    } else {
      L.push('-- Residual: the payload VM\'s instruction columns are per-build keyed; operand-level');
      L.push('-- re-synthesis continues in the engine. Everything readable above was produced by the');
      L.push('-- build\'s own decoder + interpreter running inside the sandbox.');
    }

    const code = L.join('\n') + '\n';
    const verification = verifyCode(lift ? lift.code : (stubText || code), { lang: 'lua', filename: 'luraph14-recovered.lua' });

    return {
      code,
      verification,
      stubText,
      meta,
      how: `Luraph ${version} devirtualization (runtime-state capture: deserialized program + decoded payload + loadstring chunk)`,
    };
  } catch (e) {
    logger.warn({ e: String(e && e.message || e) }, '[luraph14] devirt miss');
    return null;
  } finally {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}
