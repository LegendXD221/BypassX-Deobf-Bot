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

function dumpAndExit(note) {
  if (dumped) return;
  dumped = true;
  try {
    const rawStrings = L ? readStrings('_BX_SINK', MAX_SINK) : [];
    const logLines = L ? readStrings('_BX_LOG', 200) : [];
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

// ---- instruction budget -----------------------------------------------------
let budget = BUDGET_TOTAL;
try {
  lua.lua_sethook(L, () => {
    budget -= HOOK_INTERVAL;
    if (budget <= 0) lauxlib.luaL_error(L, to_luastring('bx: instruction budget exceeded'));
  }, lua.LUA_MASKCOUNT, HOOK_INTERVAL);
} catch { /* hooks unsupported — spawnHardened SIGKILL is the backstop */ }

// ---- sandbox prelude (Lua) -------------------------------------------------
// Shared jailed prelude lives in jail-prelude.js (identical for the harvester
// and the VM lifter — one jail, one behavior). v1.9.0: extracted verbatim.
const PRELUDE = jailPrelude.PRELUDE;

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

/** One jailed run over `source`. Loads + pcalls it, leaves the sink populated. */
function runOnce(source) {
  const chunk = to_luastring(source, true);
  let rc = lauxlib.luaL_loadbuffer(L, chunk, chunk.length, to_luastring('@bypassx'));
  if (rc !== lua.LUA_OK) return { loaded: false, err: safeToJsString(L, -1, 'load error').slice(0, 200) };
  lua.lua_setglobal(L, to_luastring('_BX_F'));
  rc = lauxlib.luaL_dostring(L, to_luastring(`
    _BX_RESULT = {}
    local __ok, __e = pcall(_BX_F)
    _BX_RESULT.ok = __ok
    if not __ok then _BX_RESULT.err = tostring(__e) end
  `));
  if (rc !== lua.LUA_OK) return { loaded: true, err: `runner: ${safeToJsString(L, -1, 'runner error').slice(0, 160)}` };
  return { loaded: true, err: null };
}

let rcPrelude = lauxlib.luaL_dostring(L, to_luastring(PRELUDE));
if (rcPrelude !== lua.LUA_OK) fail(`prelude failed: ${safeToJsString(L, -1, 'prelude error')}`);

// Luau builds (MoonSec V2/V3 Luau targets, Luraph luau) use Luau-only syntax
// Lua 5.3 rejects — rewrite first, original second. Then a two-tier run:
// tier 1 strict semantics; tier 2 (only if < 3 usable strings) the forgiving
// stack transform keeps unwritten-register reads alive so VM dispatchers
// finish decrypting their pool instead of dying on nil arithmetic.
let best = null;
try {
  let transformed = code;
  try {
    const mod = await import('./luau-shim.js');
    if (mod.hasLuauCompoundAssign(code)) transformed = mod.transformLuauToLua(code);
  } catch { /* shim unavailable — original path */ }

  const attempts = [
    { name: 'strict', sources: [transformed, code].filter((s, i, a) => s && a.indexOf(s) === i) },
    { name: 'forgiving-stack', sources: [forgivingStack(transformed), forgivingStack(code)].filter((s, i, a) => s && a.indexOf(s) === i) },
  ];

  for (const tier of attempts) {
    for (const source of tier.sources) {
      let r;
      try { r = runOnce(source); } catch (e) {
        // budget longjmp / internal abort — sink data so far is still valid
        if (budget > 0) { if (!best) best = { note: `run aborted: ${String(e && e.message || e).slice(0, 120)}` }; continue; }
        r = { loaded: true, err: 'budget' };
      }
      const usable = usableCount();
      if (!best || usable > best.usable) {
        best = { usable, tier: tier.name, note: r && r.err ? String(r.err).slice(0, 120) : null };
      }
      if (usable >= 3) break; // good enough — keep the best run's sink
    }
    if (best && best.usable >= 3) break;
  }
  // The sink currently reflects the LAST run; if the best tier was an earlier
  // attempt we cannot rewind a destroyed state — accept last-run data when it
  // is at least as good, which the usableCount check above guarantees for the
  // common case (first successful tier wins because we stop at >= 3).
  if (best && best.note) dumpAndExit(`retry tier ${best.tier}: ${best.note}`);
} catch (e) {
  const budgetHit = budget <= 0;
  if (!budgetHit) fail(`run aborted: ${String(e && e.message || e).slice(0, 200)}`);
}

dumpAndExit(null);
function readStrings(name, cap) {
  const out = [];
  lua.lua_getglobal(L, to_luastring(name));
  if (!lua.lua_istable(L, -1)) { lua.lua_pop(L, 1); return out; }
  const n = lua.lua_rawlen(L, -1);
  for (let i = 1; i <= Math.min(n, cap); i += 1) {
    lua.lua_rawgeti(L, -1, i);
    if (lua.lua_isstring(L, -1)) {
      const s = safeToJsString(L, -1);
      if (s) out.push(s);
    }
    lua.lua_pop(L, 1);
  }
  lua.lua_pop(L, 1);
  return out;
}

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
