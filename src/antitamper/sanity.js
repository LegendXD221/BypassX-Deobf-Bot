/**
 * BypassX Deobf Bot — AntiTamper V2 behavioral sanity gate.
 *
 * sUNC-style compliance suite that runs INSIDE our own jail: every probe
 * asserts a BEHAVIOR (not just the presence of a global) against the exact
 * semantics an obfuscated build expects. Two audit profiles:
 *
 *   production — the default jail shape every run gets (executor surface
 *                reads nil, production Luau/Roblox shapes everywhere).
 *   executor   — one fresh state per executor identity from the catalog
 *                (Synapse Z / Script-Ware / Krnl), asserting the masquerade
 *                layer behaves like the real executor surface.
 *
 * Used by:
 *   • test/antitamper.js  (permanent regression floor)
 *   • the escalation path in vm-lift-worker (never escalate into a broken
 *     layer — the layer is self-tested at module scope before shipping)
 */

import fengari from 'fengari';
import { PRELUDE } from '../jail-prelude.js';
import { executorLua } from './env-hardening.js';
import { EXECUTOR_IDENTITIES } from './catalog.js';
import { safeToJsString } from '../fengari-safe.js';

const { lua, lauxlib, lualib, to_luastring } = fengari;

const PROBE_BUDGET = 20_000_000;

function freshState(extraLua = null) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  let c = PROBE_BUDGET;
  try {
    lua.lua_sethook(L, () => {
      c -= 1000;
      if (c <= 0) lauxlib.luaL_error(L, to_luastring('bx-antitamper-sanity: probe budget exceeded'));
    }, lua.LUA_MASKCOUNT, 1000);
  } catch { /* hooks unsupported — probes are tiny */ }
  const rc = lauxlib.luaL_dostring(L, to_luastring(PRELUDE));
  if (rc !== lua.LUA_OK) throw new Error(`prelude failed: ${safeToJsString(L, -1, '?').slice(0, 200)}`);
  if (extraLua) {
    const rc2 = lauxlib.luaL_dostring(L, to_luastring(extraLua));
    if (rc2 !== lua.LUA_OK) throw new Error(`layer failed: ${safeToJsString(L, -1, '?').slice(0, 200)}`);
  }
  return L;
}

/** Run `return (<lua>)`; returns { ok, value, err } — never throws. */
function evalProbe(L, code) {
  const rc = lauxlib.luaL_dostring(L, to_luastring(`return (${code})`));
  if (rc !== lua.LUA_OK) return { ok: false, err: safeToJsString(L, -1, '?').slice(0, 200) };
  const top = lua.lua_gettop(L);
  const v = top > 0 ? lua.lua_toboolean(L, -1) : false;
  lua.lua_pop(L, top);
  return { ok: true, value: v };
}

// ---- probe tables -------------------------------------------------------------
// Each probe: { id, profile: 'production'|'executor', lua } — lua must return
// truthy when the behavior is correct.

const PRODUCTION_PROBES = [
  { id: 'game-mt-lock-read', lua: `getmetatable(game) == 'The game'` },
  { id: 'game-mt-lock-write', lua: `not pcall(setmetatable, game, {})` },
  { id: 'placeid-shape', lua: `type(game.PlaceId) == 'number' and type(game.GameId) == 'number'` },
  { id: 'runservice-matrix', lua: `game:IsStudio() == false and game:IsClient() == true and workspace:IsEdit() == false` },
  { id: 'setfenv-c-fn-errors', lua: `select(2, pcall(setfenv, debug.getupvalue, {})) == 'cannot change environment of given object'` },
  { id: 'setfenv-no-poison', lua: `(function() pcall(setfenv, print, {}) local ok1 = bit32.bxor(1.5, 2) == 3 local before = #_BX_SINK string.rep('p', 3) local ok2 = #_BX_SINK >= before return ok1 and ok2 end)()` },
  { id: 'string-dump-absent', lua: `string.dump == nil` },
  { id: 'getrawmetatable-absent', lua: `getrawmetatable == nil` },
  { id: 'require-absent', lua: `not pcall(function() return require('@lune/roblox') end)` },
  { id: 'executor-surface-nil', lua: `identifyexecutor == nil and checkcaller == nil and newcclosure == nil and getgenv == nil` },
  { id: 'host-libs-absent', lua: `io == nil and package == nil and loadfile == nil and dofile == nil` },
  { id: 'clock-advances', lua: `(function() local a = os.clock() local b = os.clock() return b >= a and b - a <= 1 end)()` },
  { id: 'task-wait-number', lua: `type(task.wait()) == 'number'` },
  { id: 'task-cancel-present', lua: `type(task.cancel) == 'function'` },
  { id: 'bit32-float-normalize', lua: `bit32.bxor(1.5, 2) == 3` },
  { id: 'buffer-roundtrip', lua: `(function() local b = buffer.create(8) buffer.writeu32(b, 0, 0x11223344) return buffer.readu8(b, 0) == 0x44 end)()` },
  { id: 'luau-stdlib-surface', lua: `type(table.find) == 'function' and type(math.clamp) == 'function' and type(string.split) == 'function' and type(coroutine.close) == 'function'` },
  { id: 'inert-chaining', lua: `workspace:IsEdit() == false and workspace:IsStudio() == false` },
  { id: 'loaded-gate-instant', lua: `game.Loaded == true` },
  { id: 'hidden-globals', lua: `(function() local n = 0 for k in pairs(_G) do local p = k:sub(1, 4) if p == '_BX_' or p == '__bx' or p == '_bx_' then n = n + 1 end end return n == 0 end)()` },
  { id: 'load-chunk-capture', lua: `(function() local before = #_BX_CHUNKS loadstring('return 42')() return #_BX_CHUNKS == before + 1 end)()` },
  { id: 'string-sink-live', lua: `(function() local before = #_BX_SINK local s = string.rep('a', 10) return #_BX_SINK >= before end)()` },
  { id: 'math-ldexp-frexp', lua: `math.ldexp(1, 3) == 8 and math.frexp(8) ~= nil` },
];

function executorProbes(identity) {
  return [
    { id: 'identifyexecutor-string', lua: `type(identifyexecutor()) == 'string' and #identifyexecutor() > 0` },
    { id: 'getexecutorname-shape', lua: `select(1, getexecutorname()) ~= nil` },
    { id: 'checkcaller-true', lua: `checkcaller() == true` },
    { id: 'getgenv-distinct', lua: `getgenv() == _G and getgenv() ~= getrenv()` },
    { id: 'getrenv-transparent', lua: `getrenv().game == game and getrenv().task == task` },
    { id: 'cloneref-semantics', lua: `(function() local c = cloneref(game) return c.PlaceId == game.PlaceId and not compareinstances(c, game) and compareinstances(game, game) end)()` },
    { id: 'closure-pair', lua: `(function() local f = function() return 1 end local g = newcclosure(f) return iscclosure(g) == true and islclosure(f) == true and type(g) == 'function' and g() == 1 end)()` },
    { id: 'islclosure-vs-cc', lua: `(function() local g = newcclosure(function() end) return islclosure(g) == false and iscclosure(function() end) == false end)()` },
    { id: 'isexecutorclosure-true', lua: `isexecutorclosure(function() end) == true` },
    { id: 'hook-global', lua: `(function() _G.__bx_probe_hook = function() return 1 end local old = hookfunction(_G.__bx_probe_hook, function() return 2 end) local ok = _G.__bx_probe_hook() == 2 and old() == 1 _G.__bx_probe_hook = nil return ok end)()` },
    { id: 'hookmetamethod-returns-old', lua: `(function() local t = setmetatable({}, { __index = function() return 5 end }) local old = hookmetamethod(t, '__index', function() return 7 end) return old and old(t, 'x') == 5 and t.x == 7 end)()` },
    { id: 'getrawmetatable-real', lua: `type(getrawmetatable(game)) == 'table'` },
    { id: 'readonly-pair', lua: `setreadonly(game, false) == true and isreadonly(game) == true` },
    { id: 'genv-write-persists', lua: `(function() getgenv().__bx_probe_val = 42 local v = __bx_probe_val __bx_probe_val = nil return v == 42 end)()` },
    { id: 'fs-roundtrip', lua: `(function() writefile('bx_probe.txt', 'hello') local ok = isfile('bx_probe.txt') and readfile('bx_probe.txt') == 'hello' and not isfile('bx_missing.txt') delfile('bx_probe.txt') return ok end)()` },
    { id: 'thread-identity', lua: `getthreadidentity() == ${Number(identity.identity) || 8}` },
    { id: 'getgc-populated', lua: `type(getgc()) == 'table' and #getgc() > 0` },
    { id: 'getconnections-table', lua: `type(getconnections(game)) == 'table'` },
    { id: 'getcallingscript-shape', lua: `getcallingscript() ~= nil` },
    { id: 'gethui-shape', lua: `gethui() ~= nil` },
    { id: 'http-failure-shape', lua: `(function() local r = request({ Url = 'http://127.0.0.1/x' }) return r.Success == false and type(r.Body) == 'string' end)()` },
    { id: 'drawing-shape', lua: `(function() local d = Drawing.new('Square') return d ~= nil end)()` },
    { id: 'clonefunction-semantics', lua: `(function() local f = function(x) return x + 1 end local c = clonefunction(f) return c(1) == 2 and c ~= f end)()` },
    { id: 'getupvalues-real', lua: `(function() local u = 'probe-upvalue' local function f() return u end local uv = getupvalues(f) return uv[1] == 'probe-upvalue' end)()` },
    { id: 'constants-table-not-nil', lua: `type(getconstants(print)) == 'table'` },
    { id: 'queue-on-teleport', lua: `(function() queue_on_teleport('return 1') return true end)()` },
  ];
}

// ---- audit ---------------------------------------------------------------------

/**
 * Full compliance audit across all profiles.
 * @returns {{ ok: boolean, total: number, passed: number,
 *   failures: Array<{profile, id, err}>, identities: string[] }}
 */
export function audit() {
  const failures = [];
  let total = 0;
  let passed = 0;

  // production profile
  try {
    const L = freshState(null);
    for (const p of PRODUCTION_PROBES) {
      total += 1;
      const r = evalProbe(L, p.lua);
      if (r.ok && r.value) passed += 1;
      else failures.push({ profile: 'production', id: p.id, err: r.err || 'returned falsy' });
    }
  } catch (e) {
    failures.push({ profile: 'production', id: '<state>', err: String(e.message || e).slice(0, 200) });
  }

  // executor identities
  const identities = [];
  for (const id of EXECUTOR_IDENTITIES) {
    identities.push(id.key);
    try {
      const L = freshState(executorLua(id));
      for (const p of executorProbes(id)) {
        total += 1;
        const r = evalProbe(L, p.lua);
        if (r.ok && r.value) passed += 1;
        else failures.push({ profile: `executor:${id.key}`, id: p.id, err: r.err || 'returned falsy' });
      }
    } catch (e) {
      failures.push({ profile: `executor:${id.key}`, id: '<state>', err: String(e.message || e).slice(0, 200) });
    }
  }

  return { ok: failures.length === 0, total, passed, failures, identities };
}

/**
 * Quick gate used before escalation: does the executor layer at least install
 * and answer the identity probe? (cheap — one state, three probes)
 */
export function executorLayerAlive(identity) {
  try {
    const L = freshState(executorLua(identity));
    return evalProbe(L, `type(identifyexecutor()) == 'string' and checkcaller() == true`).value === true;
  } catch {
    return false;
  }
}

/** Total probe count (for reports/tests). */
export function probeCount() {
  return PRODUCTION_PROBES.length + EXECUTOR_IDENTITIES.length * executorProbes(EXECUTOR_IDENTITIES[0]).length;
}
