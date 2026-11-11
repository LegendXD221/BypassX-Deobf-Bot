/**
 * BypassX Deobf Bot — dynamic constant harvester worker (jailed fengari VM).
 *
 * For escrow/anti-tamper VM builds (MoonSec V2/V3 escrow, Luraph v15.x, …) the
 * constant pool is decrypted at VM-INIT time. We run ONLY that deterministic
 * init inside fengari (pure-JS Lua 5.3 — no host access, no syscalls, no
 * network) with:
 *   • io/os/require/loadfile/dofile/package removed; os = {clock,time,date}
 *   • bit32/bit implemented over Lua 5.3 native int ops
 *   • getfenv/setfenv/unpack/loadstring 5.1 compat shims
 *   • LOAD-CHUNK CAPTURE (v1.8.0): every chunk passed to load()/loadstring()
 *     — text or bytecode — is recorded into _BX_CHUNKS. Decrypt-then-load
 *     builds (Luraph LPH_ENCSTR wrappers, PSU, MoonSec V2 load-stage variants,
 *     IronBrew lines, WeAreDevs, slua) hand their FULL DECRYPTED SOURCE to
 *     load() at init — capturing it is complete source recovery.
 *   • production-shaped Roblox env (v1.8.0): game.PlaceId/JobId/CreatorId are
 *     real numbers, RunService-style Is* probes return production booleans
 *     (IsStudio/IsEdit/IsRunMode → false, IsClient → true), executor-only
 *     service methods (HttpGet/HttpPost/…) read nil. Anti-dump checks that
 *     "see" an executor or a Studio env previously fed garbage keys — that
 *     was the MoonSec escrow fragment wall.
 *   • string sinks: char/sub/rep/reverse/upper/lower/format/gsub/table.concat
 *     record every produced string into _BX_SINK
 *   • instruction budget via debug count hook (hard SIGKILL by spawnHardened)
 *
 * stdout: ONE JSON line { ok, ran, runError, strings[], chunks[], log[] }
 * Never executes recovered code outside this jail; never touches the network.
 */
import fs from 'node:fs';
const writeOut = (obj) => {
  for (const data of [Buffer.from(JSON.stringify(obj) + '\n')]) {
    let off = 0;
    while (off < data.length) {
      try { off += fs.writeSync(1, data, off, data.length - off); } catch (e) { if (e.code !== 'EAGAIN') break; }
    }
  }
};
import fengari from 'fengari';
import { safeToJsString } from './fengari-safe.js';
import * as jailPrelude from './jail-prelude.js';
// v2.18.0 — antitamper identity escalation (tier4): the V2 catalog's
// 'escalate' counter wired into the recon path.
import { EXECUTOR_IDENTITIES } from './antitamper/catalog.js';
import { executorLua } from './antitamper/env-hardening.js';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const INPUT = process.argv[2];
const BUDGET_TOTAL = Number(process.env.BX_BUDGET) || 300e6;
const HOOK_INTERVAL = 2.5e6;
const MAX_SINK = 60_000;
const MAX_STR = 8192;
const MAX_OUT = 20_000;
const MAX_CHUNKS = 64;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS_TOTAL = 3 * 1024 * 1024;

if (!INPUT) {
  console.error('usage: harvester-worker <input>');
  process.exit(2);
}

let L = null;
let dumped = false;
// v2.10.0 nested-peel accumulators: data captured from re-running VM chunks
// in fresh jail states (merged into the result by dumpAndExit).
const extraStrings = [];
const extraChunks = [];
const extraLog = [];
const nestedStates = [];

function dumpAndExit(note) {
  if (dumped) return;
  dumped = true;
  try {
    const rawStrings = L ? readStrings('_BX_SINK', MAX_SINK) : [];
    for (const s of extraStrings) rawStrings.push(s);
    const logLines = L ? readStrings('_BX_LOG', 200) : [];
    for (const s of extraLog) if (!logLines.includes(s)) logLines.push(s);
    let ran = false;
    let runError = null;
    if (L) {
      lua.lua_getglobal(L, to_luastring('_BX_RESULT'));
      if (lua.lua_istable(L, -1)) {
        lua.lua_getfield(L, -1, to_luastring('ok'));
        ran = lua.lua_toboolean(L, -1);
        lua.lua_pop(L, 1);
        lua.lua_getfield(L, -1, to_luastring('err'));
        if (lua.lua_isstring(L, -1)) runError = safeToJsString(L, -1, 'run error').slice(0, 200);
        lua.lua_pop(L, 2);
      } else {
        lua.lua_pop(L, 1);
      }
    }
    const seen = new Set();
    const strings = [];
    let bytes = 0;
    for (const s of rawStrings) {
      if (strings.length >= MAX_OUT) break;
      if (seen.has(s)) continue;
      const bad = (s.match(/\uFFFD/g) || []).length;
      if (bad > Math.max(2, s.length * 0.3)) continue;
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s.slice(0, 64)) && s.length > 8) continue;
      seen.add(s);
      bytes += s.length;
      strings.push(s);
      if (bytes > 4 * 1024 * 1024) break;
    }
    const chunks = readChunks();
    let chunkBytes = chunks.reduce((a, s) => a + s.length, 0);
    for (const s of extraChunks) {
      if (chunks.length >= MAX_CHUNKS || chunkBytes >= MAX_CHUNKS_TOTAL) break;
      if (s.length < 8 || chunks.includes(s)) continue;
      chunks.push(s);
      chunkBytes += s.length;
    }
    writeOut({ ok: true, ran, runError, budgetHit: budget <= 0, partial: Boolean(note), note: note || null, strings, chunks, log: logLines.slice(0, 50) });
  } catch {
    writeOut({ ok: true, ran: false, strings: [], chunks: [], log: [] });
  }
  process.exit(0);
}
process.on('SIGTERM', () => dumpAndExit('time budget — partial pool'));
process.on('SIGINT', () => dumpAndExit('interrupted'));

let code;
try {
  code = fs.readFileSync(INPUT, 'utf8');
} catch (e) {
  writeOut({ ok: false, error: `read failed: ${e.message}` });
  process.exit(0);
}

L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

// ---- instruction + memory budget --------------------------------------------
let budget = BUDGET_TOTAL;
// v2.10.0: heap guard — fatal V8 OOM aborts are UNCAUGHT-BY-DESIGN and lose
// the partial pool; a luaL_error from inside the count hook is a normal Lua
// error the runner pcalls absorb. Checked every hook fire (2.5M instr) —
// allocation overshoot between fires is bounded far below the 256MB flag.
const HEAP_CAP = 192e6;
function heapOver() {
  try { return process.memoryUsage().heapUsed > HEAP_CAP; } catch { return false; }
}
// v2.11.0 spin-break (Biggest Scan exploit): MoonSec V3 escrow builds catch the
// budget error with an inner pcall and re-spin — each cycle costs ~2 VM
// instructions but re-fires the hook, so the budget never "runs out" from the
// sample's perspective and the worker burns the whole wall-clock timeout with
// ZERO captured strings. Fix: the first exhaustion raises the catchable error
// (still lets pcall-based VMs flush a clean result); if instructions keep
// flowing AFTER exhaustion, the sample is spinning — dump the partial pool and
// exit hard from inside the hook. Partial capture beats a 124-timeout with
// nothing. Same escalation applies to the heap guard.
let budgetSpin = false;
let heapSpin = false;
function spinBreak(note) {
  try { dumpAndExit(note); } catch { /* fall through to hard exit */ }
  process.exit(0);
}
try {
  lua.lua_sethook(L, () => {
    budget -= HOOK_INTERVAL;
    if (budget <= 0) {
      if (budgetSpin) spinBreak('instruction budget — partial pool (spin-break)');
      budgetSpin = true;
      lauxlib.luaL_error(L, to_luastring('bx: instruction budget exceeded'));
    }
    if (heapOver()) {
      if (heapSpin) spinBreak('memory budget — partial pool (spin-break)');
      heapSpin = true;
      lauxlib.luaL_error(L, to_luastring('bx: memory budget exceeded'));
    }
  }, lua.LUA_MASKCOUNT, HOOK_INTERVAL);
} catch { /* hooks unsupported — spawnHardened SIGKILL is the backstop */ }

// ---- sandbox prelude (Lua) -------------------------------------------------
// Shared jailed prelude lives in jail-prelude.js (identical for the harvester
// and the VM lifter — one jail, one behavior). v1.9.0: extracted verbatim.
const PRELUDE = jailPrelude.PRELUDE;

/** 25ms-style concat-capture injection (v2.10.0, retry tier 3 — technique
 *  credit: the leaked 25ms luraphdump.lua). Luraph-family VM wrappers rebuild
 *  decrypted strings with RAW `..` concatenation of pool-table reads
 *  (`v_a[v_b[v_c]] .. v_a[v_b[v_d]]`) — a shape no string/function sink ever
 *  sees. Wrapping each such expression in _BXCAP(...) records the joined
 *  string the instant the VM builds it; the capturer is a passthrough so
 *  expression semantics are unchanged. */
function injectConcatCapture(code) {
  const re = /([A-Za-z][A-Za-z]?\[[A-Za-z][A-Za-z]?\[[\w_]+\]\]\s*\.\.\s*[A-Za-z][A-Za-z]?\[[A-Za-z][A-Za-z]?\[[\w_]+\]\])/g;
  let matches = 0;
  const out = code.replace(re, (m) => { matches += 1; return `_BXCAP(${m})`; });
  return { code: out, matches };
}

/** Forgiving-stack source transform (retry tier 2): give every `local x={}`
 *  a metatable defaulting numeric reads to 0 so VM dispatchers that read
 *  unwritten registers keep running instead of crashing on nil arithmetic.
 *  Machine-generated stack tables are exactly this shape; real reads of
 *  string keys still return nil. */
function forgivingStack(code) {
  return code.replace(
    /local ([A-Za-z_][A-Za-z0-9_]*)=\{\};/g,
    (m, v) => `local ${v}=setmetatable({},{__index=function(t,k) if type(k)=='number' then return 0 end end});`,
  );
}

// ---- run --------------------------------------------------------------------
function fail(msg) {
  writeOut({ ok: false, error: String(msg).slice(0, 300) });
  process.exit(0);
}

/** Count sink strings that survive the worker's own quality filters. */
function usableCount() {
  try {
    const raw = readStrings('_BX_SINK', MAX_SINK);
    const seen = new Set();
    let n = 0;
    for (const s of raw) {
      if (seen.has(s)) continue;
      const bad = (s.match(/\uFFFD/g) || []).length;
      if (bad > Math.max(2, s.length * 0.3)) continue;
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s.slice(0, 64)) && s.length > 8) continue;
      seen.add(s);
      n += 1;
    }
    return n;
  } catch { return 0; }
}

/** Fresh jailed state: new fengari VM + budget hook (shared budget) + prelude.
 *  Used by the nested-peel tier to run captured VM chunks in isolation. */
function newState() {
  const NL = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(NL);
  try {
    lua.lua_sethook(NL, () => {
      budget -= HOOK_INTERVAL;
      if (budget <= 0) {
        if (budgetSpin) spinBreak('instruction budget — partial pool (spin-break)');
        budgetSpin = true;
        lauxlib.luaL_error(NL, to_luastring('bx: instruction budget exceeded'));
      }
      if (heapOver()) {
        if (heapSpin) spinBreak('memory budget — partial pool (spin-break)');
        heapSpin = true;
        lauxlib.luaL_error(NL, to_luastring('bx: memory budget exceeded'));
      }
    }, lua.LUA_MASKCOUNT, HOOK_INTERVAL);
  } catch { /* hooks unsupported — spawnHardened SIGKILL is the backstop */ }
  const rc = lauxlib.luaL_dostring(NL, to_luastring(PRELUDE));
  return rc === lua.LUA_OK ? NL : null;
}

/** v2.10.0 multi-layer peel: chunks the sample handed to load() that are
 *  themselves VM builds (`return(function(…` — Luraph-style) are re-run in a
 *  FRESH jail so the inner obfuscator decrypts ITS pool into our sinks too
 *  (technique credit: 25ms loadstring interception, applied recursively).
 *  Bounded: 2 chunks max, largest first, shared instruction budget with a
 *  hard floor so depth-0 data is never starved. */
function tryNestedPeel() {
  try {
    const eligible = readChunks()
      .filter((s) => /^return\s*\(?\s*function\s*\(/.test(s.slice(0, 64)) && s.length >= 512)
      .sort((a, b) => b.length - a.length)
      .slice(0, 2);
    for (let i = 0; i < eligible.length; i += 1) {
      if (budget <= 20e6) break;
      const NL = newState();
      if (!NL) break;
      nestedStates.push(NL);
      let r;
      try { r = runOnceOn(NL, eligible[i]); } catch { r = null; }
      const got = readStringsFrom(NL, '_BX_SINK', MAX_SINK);
      extraStrings.push(...got);
      extraChunks.push(...readStringsFrom(NL, '_BX_CHUNKS', 32));
      extraLog.push(`peel: nested chunk ${i + 1} (${eligible[i].length}B) → ${got.length} strings${r && r.err ? ` — ${String(r.err).slice(0, 80)}` : ''}`);
    }
  } catch { /* peel is best-effort — depth-0 data stands alone */ }
}

/** One jailed run over `source`. Loads + pcalls it, leaves the sink populated. */
function runOnceOn(state, source) {
  const chunk = to_luastring(source, true);
  let rc = lauxlib.luaL_loadbuffer(state, chunk, chunk.length, to_luastring('@bypassx'));
  if (rc !== lua.LUA_OK) return { loaded: false, err: safeToJsString(state, -1, 'load error').slice(0, 200) };
  lua.lua_setglobal(state, to_luastring('_BX_F'));
  rc = lauxlib.luaL_dostring(state, to_luastring(`
    _BX_RESULT = {}
    local __ok, __e = pcall(_BX_F)
    _BX_RESULT.ok = __ok
    if not __ok then _BX_RESULT.err = tostring(__e) end
  `));
  if (rc !== lua.LUA_OK) return { loaded: true, err: `runner: ${safeToJsString(state, -1, 'runner error').slice(0, 160)}` };
  return { loaded: true, err: null };
}

function runOnce(source) { return runOnceOn(L, source); }

let rcPrelude = lauxlib.luaL_dostring(L, to_luastring(PRELUDE));
if (rcPrelude !== lua.LUA_OK) fail(`prelude failed: ${safeToJsString(L, -1, 'prelude error')}`);

// Luau builds (MoonSec V2/V3 Luau targets, Luraph luau) use Luau-only syntax
// Lua 5.3 rejects — rewrite first, original second. Then a two-tier run:
// tier 1 strict semantics; tier 2 (only if < 3 usable strings) the forgiving
// stack transform keeps unwritten-register reads alive so VM dispatchers
// finish decrypting their pool instead of dying on nil arithmetic.
let best = null;
let transformed = code;
let repaired = null; // v2.14.0 — lenient invalid-\X-escape repair tier
try {
  const mod = await import('./luau-shim.js');
  // v2.14.0: same fix as vm-lift-worker — normalize ANY Luau-only syntax
  // (binary literals / separators / continue), not just compound assigns.
  if (mod.hasLuauCompoundAssign(code) || mod.hasLuauOnlyLiterals(code)) transformed = mod.transformLuauToLua(code);
  const rep = mod.repairInvalidEscapes(transformed);
  if (rep.changed && rep.code !== transformed) repaired = rep.code;
} catch { /* shim unavailable — original path */ }

// ---- v2.18.0 helpers: parse filter, escalation bridge, static floor ----------

/** Compile-only check on the jailed state: does this source parse? (never runs) */
function parsable(s) {
  try {
    const rc = lauxlib.luaL_loadstring(L, to_luastring(s));
    const ok = rc === lua.LUA_OK;
    lua.lua_pop(L, 1);
    return ok;
  } catch { return false; }
}

/** Push recon strings straight into the jailed sink (tier5 static floor). */
function pushSinkStrings(arr) {
  try {
    lua.lua_getglobal(L, to_luastring('_BX_SINK'));
    if (!lua.lua_istable(L, -1)) { lua.lua_pop(L, 1); return; }
    let at = lua.lua_rawlen(L, -1);
    for (const s of arr) {
      at += 1;
      lua.lua_pushstring(L, s);
      lua.lua_rawseti(L, -2, at);
    }
    lua.lua_pop(L, 1);
  } catch { /* sink missing — nothing to push into */ }
}

/** Static short-string literal extraction (code position, ≥4 chars, deduped,
 *  capped). Raw escaped text — exactly what the source ships. */
function extractStaticStrings(src) {
  if (!src || src.length < 8) return [];
  const out = [];
  const seen = new Set();
  let i = 0;
  const n = src.length;
  while (i < n && out.length < 5000) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      const m = /^--\[(=*)\[/.exec(src.slice(i, i + 64));
      if (m) {
        const close = ']' + m[1] + ']';
        const e = src.indexOf(close, i + m[0].length);
        i = e < 0 ? n : e + close.length;
      } else {
        const e = src.indexOf('\n', i);
        i = e < 0 ? n : e + 1;
      }
      continue;
    }
    if (c === '[') {
      const m = /^\[(=*)\[/.exec(src.slice(i, i + 64));
      if (m) {
        const close = ']' + m[1] + ']';
        const e = src.indexOf(close, i + m[0].length);
        i = e < 0 ? n : e + close.length;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let raw = '';
      while (j < n) {
        if (src[j] === '\\') { raw += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === c || src[j] === '\n') break;
        raw += src[j];
        j += 1;
      }
      i = j + 1;
      if (raw.length >= 4 && !seen.has(raw)) { seen.add(raw); out.push(raw); }
      continue;
    }
    i += 1;
  }
  return out;
}

try { // outer guard — budget longjmp / internal abort keeps sink data
const attempts = [
  { name: 'strict', sources: [transformed, repaired, code].filter((s, i, a) => s && a.indexOf(s) === i) },
  { name: 'forgiving-stack', sources: [forgivingStack(transformed), forgivingStack(code)].filter((s, i, a) => s && a.indexOf(s) === i) },
];

for (const tier of attempts) {
    for (const source of tier.sources) {
      // v2.18.0 pre-parse filter: a source that cannot COMPILE can never run —
      // spend no budget on it and say why in the log. This kills wasted runs
      // of corrupted repair variants (verified live: moonveil's repaired
      // source broke syntax and burned two full runs per harvest).
      if (!parsable(source)) { extraLog.push(`tier ${tier.name}: skip — source does not parse`); continue; }
      let r;
      try { r = runOnce(source); } catch (e) {
        // budget longjmp / internal abort — sink data so far is still valid
        if (budget > 0) { if (!best) best = { note: `run aborted: ${String(e && e.message || e).slice(0, 120)}` }; continue; }
        r = { loaded: true, err: 'budget' };
      }
      const usable = usableCount();
      extraLog.push(`tier ${tier.name}: ${usable} usable strings${r && r.err ? ` — err: ${String(r.err).slice(0, 140)}` : ''}`);
      if (!best || usable > best.usable) {
        best = { usable, tier: tier.name, note: r && r.err ? String(r.err).slice(0, 120) : null };
      }
      if (usable >= 3) break; // good enough — keep the best run's sink
    }
    if (best && best.usable >= 3) break;
  }
  // v2.10.0 tier 3 (25ms concat-capture injection): only when the sinks are
  // still starving — instrumented runs are a last resort, never the default.
  if (!best || best.usable < 3) {
    for (const source of [transformed, code]) {
      if (!source || budget <= 20e6) continue;
      const inj = injectConcatCapture(source);
      if (inj.matches < 1 || inj.code === source) continue;
      let r;
      try { r = runOnce(inj.code); } catch { continue; }
      const usable = usableCount();
      if (!best || usable > best.usable) {
        best = { usable, tier: 'concat-inject', note: r && r.err ? String(r.err).slice(0, 120) : null };
      }
      if (best.usable >= 3) break;
    }
    extraLog.push(`tier3 concat-inject: ${best ? `${best.usable} usable strings (tier ${best.tier})` : 'no effect'}`);
  }
  // v2.18.0 tier4 — antitamper identity escalation: silent guard exits
  // (production-shaped env reads nil → `if not x then return end`) starve the
  // sinks with ZERO errors (verified live: junkie/luarmor/25ms finish in 0.1s
  // without a single capture or error line). Re-run the best parsing source
  // under an executor identity layer from the AntiTamper V2 catalog.
  if (!best || best.usable < 3) {
    const escSources = [transformed, code].filter((s, i, a) => s && parsable(s) && a.indexOf(s) === i);
    if (escSources.length) {
      for (const id of EXECUTOR_IDENTITIES) {
        try {
          const rcE = lauxlib.luaL_dostring(L, to_luastring(executorLua(id)));
          if (rcE !== lua.LUA_OK) { lua.lua_pop(L, 1); extraLog.push(`tier4 escalate(${id.key}): layer install failed`); continue; }
        } catch { extraLog.push(`tier4 escalate(${id.key}): layer threw`); continue; }
        let got = usableCount();
        for (const source of escSources) {
          try { runOnce(source); } catch { /* sink data so far survives */ }
          got = usableCount();
          if (got >= 3) break;
        }
        extraLog.push(`tier4 escalate(${id.key}): ${got} usable strings`);
        if (!best || got > best.usable) best = { usable: got, tier: `escalate:${id.key}`, note: null };
        if (best.usable >= 3) break;
      }
    }
  }
  // v2.18.0 tier5 — static literal floor: NEVER return zero recon. Loaders
  // and config stubs (LuArmor _bsdata, Junkie loader config, 25ms pool heads)
  // keep their static string table even when every runtime tier starves.
  if (!best || best.usable < 3) {
    const statics = extractStaticStrings(code || '');
    if (statics.length) {
      pushSinkStrings(statics);
      const got = usableCount();
      extraLog.push(`tier5 static-literals: +${statics.length} strings → ${got} usable`);
      if (!best || got > best.usable) best = { usable: got, tier: 'static-literals', note: null };
    } else {
      extraLog.push('tier5 static-literals: 0 found');
    }
  }
  // The sink currently reflects the LAST run; if the best tier was an earlier
  // attempt we cannot rewind a destroyed state — accept last-run data when it
  // is at least as good, which the usableCount check above guarantees for the
  // common case (first successful tier wins because we stop at >= 3).
  if (best && best.note && budget <= 0) dumpAndExit(`retry tier ${best.tier}: ${best.note}`);
} catch (e) {
  const budgetHit = budget <= 0;
  if (!budgetHit) fail(`run aborted: ${String(e && e.message || e).slice(0, 200)}`);
}

// v2.10.0: captured VM chunks get their own jailed pass before the dump.
tryNestedPeel();
dumpAndExit(null);
function readStringsFrom(state, name, cap) {
  const out = [];
  lua.lua_getglobal(state, to_luastring(name));
  if (!lua.lua_istable(state, -1)) { lua.lua_pop(state, 1); return out; }
  const n = lua.lua_rawlen(state, -1);
  for (let i = 1; i <= Math.min(n, cap); i += 1) {
    lua.lua_rawgeti(state, -1, i);
    if (lua.lua_isstring(state, -1)) {
      const s = safeToJsString(state, -1);
      if (s) out.push(s);
    }
    lua.lua_pop(state, 1);
  }
  lua.lua_pop(state, 1);
  return out;
}

function readStrings(name, cap) { return readStringsFrom(L, name, cap); }

/** Read captured load()/loadstring() chunks (byte-budgeted, deduped). */
function readChunks() {
  const out = [];
  let total = 0;
  try {
    lua.lua_getglobal(L, to_luastring('_BX_CHUNKS'));
    if (!lua.lua_istable(L, -1)) { lua.lua_pop(L, 1); return out; }
    const n = lua.lua_rawlen(L, -1);
    for (let i = 1; i <= Math.min(n, MAX_CHUNKS); i += 1) {
      if (total >= MAX_CHUNKS_TOTAL) break;
      lua.lua_rawgeti(L, -1, i);
      if (lua.lua_isstring(L, -1)) {
        const s = safeToJsString(L, -1);
        if (s && s.length >= 8 && !out.includes(s)) { out.push(s); total += s.length; }
      }
      lua.lua_pop(L, 1);
    }
    lua.lua_pop(L, 1);
  } catch { /* sink missing — return what we have */ }
  return out;
}
