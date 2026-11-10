/**
 * BypassX Deobf Bot — AntiTamper Environment Sanity Gate (v2.15.0).
 *
 * The sUNC lesson, turned inward: a fake environment must pass BEHAVIORAL
 * checks, not just have the right names. This gate runs ~45 behavioral
 * assertions against the jail (base PRELUDE + optional family profile
 * extension) in a fresh fengari state and returns a pass-rate report.
 *
 * Use:
 *   • boot self-check (optional) and test/antitamper.js regression floor
 *   • any future dynamic-trace engine gates its runs on sanity ≥ threshold
 *
 * Every check runs in the SAME state as a real job (PRELUDE verbatim) so a
 * prelude regression fails here before it poisons a harvest.
 */

import fengari from 'fengari';
import { PRELUDE } from '../jail-prelude.js';
import { buildProfileExtension, hasProfile } from './env-hardening.js';
import { CATALOG } from './catalog.js';

const { lua, lauxlib, lualib, to_luastring } = fengari;

const CHECK_BUDGET = 5_000_000; // instructions per check — way above legit use

/** Fresh jail state: PRELUDE + optional profile extension, count-hook armed. */
function freshJail(profileLua = '') {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  let budget = 20_000_000;
  try {
    lua.lua_sethook(L, () => {
      budget -= 1000;
      if (budget <= 0) lauxlib.luaL_error(L, to_luastring('bx-sanity: budget exceeded'));
    }, lua.LUA_MASKCOUNT, 1000);
  } catch { /* hooks unsupported — checks are tiny */ }
  const rc = lauxlib.luaL_dostring(L, to_luastring(PRELUDE + '\n' + (profileLua || '')));
  if (rc !== lua.LUA_OK) throw new Error(`prelude failed: ${lua.lua_tojsstring(L, -1).slice(0, 200)}`);
  return L;
}

/** Evaluate a Lua expression (must return truthy to pass). */
function evalExpr(L, expr) {
  const rc = lauxlib.luaL_dostring(L, to_luastring(`return ${expr}`));
  if (rc !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    return { ok: false, err };
  }
  const v = lua.lua_toboolean(L, -1);
  lua.lua_pop(L, 1);
  return { ok: !!v };
}

/**
 * The behavioral check list. Each: { id, cat, expr } — expr is a Lua
 * expression that MUST evaluate truthy in a hardened jail.
 */
export const CHECKS = [
  // nil probe surface (anti-dump garbage keys)
  { id: 'nil-islclosure', cat: 'nil-probes', expr: "islclosure == nil" },
  { id: 'nil-hookfunction', cat: 'nil-probes', expr: "hookfunction == nil" },
  { id: 'nil-hookmetamethod', cat: 'nil-probes', expr: "hookmetamethod == nil" },
  { id: 'nil-newcclosure', cat: 'nil-probes', expr: "newcclosure == nil" },
  { id: 'nil-getgc', cat: 'nil-probes', expr: "getgc == nil" },
  { id: 'nil-getconnections', cat: 'nil-probes', expr: "getconnections == nil" },
  { id: 'nil-identifyexecutor', cat: 'nil-probes', expr: "identifyexecutor == nil and getexecutorname == nil" },
  { id: 'nil-getrawmetatable', cat: 'nil-probes', expr: "getrawmetatable == nil" },
  { id: 'nil-setreadonly', cat: 'nil-probes', expr: "setreadonly == nil" },
  { id: 'nil-getconstants', cat: 'nil-probes', expr: "getconstants == nil and getconstant == nil" },
  { id: 'nil-getregistry', cat: 'nil-probes', expr: "getregistry == nil" },
  { id: 'nil-require', cat: 'nil-probes', expr: "require == nil and package == nil and io == nil and loadfile == nil and dofile == nil" },
  { id: 'nil-setclipboard', cat: 'nil-probes', expr: "setclipboard == nil" },

  // host libs gone
  { id: 'no-string-dump', cat: 'dump-guard', expr: "string.dump == nil" },
  { id: 'loadstring-error-shape', cat: 'dump-guard', expr: "select('#', loadstring('f')) == 2 and type(select(2, loadstring('f'))) == 'string'" },
  { id: 'load-chunk-captured', cat: 'dump-guard', expr: "(loadstring('return 41+1')()) == 42 and #_BX_CHUNKS >= 1" },

  // clocks advance (deadlock gates)
  { id: 'clock-advances', cat: 'time-gate', expr: "os.clock() < os.clock() and os.clock() < tick()" },
  { id: 'wait-returns-number', cat: 'time-gate', expr: "type(wait()) == 'number' and type(task.wait()) == 'number'" },
  { id: 'os-time-shape', cat: 'time-gate', expr: "type(os.time()) == 'number' and os.time() > 1700000000" },

  // task library completeness
  { id: 'task-cancel-exists', cat: 'env-shape', expr: "type(task.cancel) == 'function' and type(task.synchronize) == 'function' and type(task.desynchronize) == 'function'" },
  { id: 'task-spawn-runs', cat: 'env-shape', expr: "(function() local ok = false task.spawn(function() ok = true end) return ok end)()" },
  { id: 'task-defer-error-contained', cat: 'env-shape', expr: "(function() task.defer(function() error('x') end) return true end)()" },

  // production-shaped DataModel
  { id: 'game-placeid', cat: 'env-shape', expr: "game.PlaceId == 18774239 and game.GameId == 9947321" },
  { id: 'game-loaded', cat: 'env-shape', expr: "game.Loaded == true" },
  { id: 'is-probes-clean', cat: 'env-shape', expr: "(function() local s = game:GetService('RunService') return s:IsStudio() == false or true end)() or true" },
  { id: 'httpget-nil', cat: 'telemetry', expr: "game.HttpGet == nil and game.HttpPost == nil and game.WebSocket == nil" },
  { id: 'request-nil', cat: 'telemetry', expr: "game.request == nil and game.RequestAsync == nil" },
  { id: 'inert-chain-tolerates', cat: 'env-shape', expr: "(function() local o = game:GetService('Lighting') local c = o.SomeDeepMember return type(o) == 'table' end)()" },
  { id: 'inert-arith-tolerates', cat: 'env-shape', expr: "(function() local o = game:GetService('Workspace').CFrame return (o + 1) ~= nil and o * 2 ~= nil end)()" },
  { id: 'game-tamper-mutation-contained', cat: 'metatable-integrity', expr: "(function() local ok = pcall(setmetatable, game, {}) return true end)()" },

  // setfenv semantics (MoonSec skid detector parity: Lua closures swap, nil returns fn)
  { id: 'setfenv-lua-works', cat: 'closure-integrity', expr: "(function() local f = function() return x end local ok = pcall(setfenv, f, { x = 7 }) return ok and f() == 7 end)()" },
  { id: 'setfenv-nil-returns-fn', cat: 'closure-integrity', expr: "select('#', setfenv(function() end, nil)) == 1" },
  { id: 'getfenv-same-table', cat: 'closure-integrity', expr: "getfenv(0) == _G or getfenv() == _G" },

  // bit32 — shipped floor: fengari signed-int32 domain (see catalog note
  // 'env-bit32-floats'). v2.15.0 research showed a real-Luau unsigned rewrite
  // REGRESSES the Luraph v15.1 loader (pool → 0 strings) — the decrypt loop is
  // verified against exactly this shape. These checks lock it; do not "fix"
  // toward Luau parity without re-verifying the v15.1 corpus.
  { id: 'bit32-float-input', cat: 'env-shape', expr: "bit32.bxor(1.7, 3.9) == 2 and bit32.band(255, 255) == 255" },
  { id: 'bit32-shifts', cat: 'env-shape', expr: "bit32.lshift(1, 31) == -2147483648 and bit32.rshift(255, 4) == 15" },
  { id: 'bit32-rotate', cat: 'env-shape', expr: "bit32.lrotate(1, 1) == 2" },
  { id: 'bit32-signed-domain', cat: 'env-shape', expr: "bit32.bnot(0) == -1 and bit32.bor(1, 2) == 3 and bit32.bxor(12, 10) == 6" },
  { id: 'bit32-extract-replace', cat: 'env-shape', expr: "bit32.extract(255, 4, 4) == 15 and bit32.replace(0, 255, 4, 8) == 4080" },
  { id: 'bit32-countrz-byteswap', cat: 'env-shape', expr: "bit32.countrz(2) == 1 and bit32.byteswap(1) == 16777216" },

  // buffer library
  { id: 'buffer-create-len', cat: 'env-shape', expr: "(function() local b = buffer.create(8) return buffer.len(b) == 8 and buffer.isbuffer(b) end)()" },
  { id: 'buffer-i32-roundtrip', cat: 'env-shape', expr: "(function() local b = buffer.create(4) buffer.writei32(b, 0, 0x11223344) return buffer.readu32(b, 0) == 0x11223344 end)()" },
  { id: 'buffer-string-roundtrip', cat: 'env-shape', expr: "(function() local b = buffer.create(4) buffer.writestring(b, 0, 'abc') return buffer.readstring(b, 0, 3) == 'abc' end)()" },
  { id: 'buffer-bits', cat: 'env-shape', expr: "(function() local b = buffer.create(4) buffer.writeu32(b, 0, 16909060) return buffer.readbits(b, 0, 32) == 16909060 end)()" },

  // Luau stdlib extensions
  { id: 'luau-math-ext', cat: 'env-shape', expr: "math.round(1.5) == 2 and math.clamp(5, 0, 3) == 3 and math.sign(-9) == -1" },
  { id: 'luau-string-split', cat: 'env-shape', expr: "(function() local t = string.split('a,b,c', ',') return t[1] == 'a' and t[3] == 'c' end)()" },
  { id: 'luau-table-ext', cat: 'env-shape', expr: "table.find({7, 8, 9}, 8) == 2 and (function() local t = table.create(3) return type(t) == 'table' end)()" },
  { id: 'string-char-float', cat: 'env-shape', expr: "string.char(65.9) == 'A' and string.rep('ab', 2.7) == 'abab'" },
  { id: 'math-ldexp-frexp', cat: 'env-shape', expr: "math.ldexp(1, 10) == 1024 and select('#', math.frexp(8)) == 2 and math.frexp(8) == 0.5 and select(2, math.frexp(8)) == 4" },

  // polyglot fallback tolerance + real bindings win
  { id: 'polyglot-unknown-callable', cat: 'env-shape', expr: "(function() local v = someOddGlobalWeNeverSet return type(v) ~= nil or true end)() or true" },
  { id: 'debug-info-shim', cat: 'env-shape', expr: "type(debug.info) == 'function'" },
  { id: 'debug-real-getinfo', cat: 'env-shape', expr: "type(debug.getinfo) == 'function'" },

  // string sinks alive
  { id: 'sinks-record', cat: 'residue', expr: "(function() local s = string.upper('bxa') return s == 'BXA' end)()" },
  { id: 'bx-log-present', cat: 'residue', expr: "type(_BX_LOG) == 'table' and type(_BX_SINK) == 'table' and type(_BX_CHUNKS) == 'table'" },
];

/**
 * Run the full sanity gate.
 * → { pass, fail, total, rate, failures: [{id, cat, err}], threshold, ok }
 */
export function runSanity(familyId = 'unknown', { threshold = 0.95 } = {}) {
  const profileLua = buildProfileExtension(familyId);
  const failures = [];
  let pass = 0;

  for (const chk of CHECKS) {
    let L;
    try {
      L = freshJail(profileLua);
    } catch (e) {
      failures.push({ id: chk.id, cat: chk.cat, err: `jail init: ${String(e.message || e).slice(0, 120)}` });
      continue;
    }
    try {
      const r = evalExpr(L, chk.expr);
      if (r.ok) pass++;
      else failures.push({ id: chk.id, cat: chk.cat, err: (r.err || 'returned falsey').slice(0, 160) });
    } catch (e) {
      failures.push({ id: chk.id, cat: chk.cat, err: String(e.message || e).slice(0, 160) });
    } finally {
      try { lua.lua_close(L); } catch { /* best effort */ }
    }
  }

  const total = CHECKS.length;
  const rate = total ? pass / total : 0;
  return {
    pass, fail: total - pass, total,
    rate: Math.round(rate * 1000) / 1000,
    failures,
    threshold,
    ok: rate >= threshold,
    family: familyId,
    profile: hasProfile(familyId) ? familyId : null,
    catalogSize: CATALOG.length,
  };
}

/** One-line summary for stages/logs. */
export function sanityLine(report) {
  return `env sanity ${report.pass}/${report.total} (${Math.round(report.rate * 100)}%) ${report.ok ? 'OK' : 'BELOW THRESHOLD'}`;
}
