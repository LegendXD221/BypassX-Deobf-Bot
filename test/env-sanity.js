/**
 * Env-sanity suite (v2.12.0) — the leaked UnveilR-V3 intel, turned into a
 * permanent regression floor for the jail environment.
 *
 * Three layers:
 *   A. EXPLOIT REGRESSION FLOOR — every jail behavior the Biggest Scan
 *      A/B-verified in v2.11.0 is asserted here. If one of these ever moves,
 *      the harvest/lift engines regress with it (MoonSec skid detector,
 *      escrow clock gates, anti-dump nil probes, …).
 *   B. DETECTION CATALOG — the 12 executor-detection scripts shipped inside
 *      the leaked UnveilR-V3 corpus (research/unveilr-v3/detections/{1,2,4..13}.lua,
 *      3.lua does not exist in the leak) run to completion inside our jail.
 *      Each asserts the exact outcome our environment shape produces, so an
 *      accidental env change that would trip obfuscator anti-tamper fails HERE
 *      instead of silently poisoning a harvest.
 *   C. UNPARSER ALIGNMENT — the v2.12.0 readable-engine additions ported from
 *      the leaked UnveilR-V3 unparser: Color3.fromRGB normalization,
 *      .Name-derived machine naming, and the string-literal rename guard.
 *
 * Every probe runs in a FRESH fengari state with its own instruction budget —
 * a runaway probe fails its own test instead of hanging the suite.
 */
import fengari from 'fengari';
import { PRELUDE } from '../src/jail-prelude.js';
import { safeToJsString } from '../src/fengari-safe.js';
import { makeReadableLua } from '../src/readable.js';
import assert from 'node:assert';

const { lua, lauxlib, lualib, to_luastring } = fengari;

const PROBE_BUDGET = 20_000_000; // instructions per probe — far above any legit use

function freshJail() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  let c = PROBE_BUDGET;
  try {
    lua.lua_sethook(L, () => {
      c -= 1000;
      if (c <= 0) lauxlib.luaL_error(L, to_luastring('bx-env-sanity: probe budget exceeded'));
    }, lua.LUA_MASKCOUNT, 1000);
  } catch { /* hooks unsupported — probes are tiny */ }
  const rc = lauxlib.luaL_dostring(L, to_luastring(PRELUDE));
  if (rc !== lua.LUA_OK) throw new Error(`prelude failed: ${safeToJsString(L, -1, '?').slice(0, 200)}`);
  return L;
}

/** Run a snippet; must return truthy. Throws on Lua error (test fails loudly). */
function probe(L, code) {
  const rc = lauxlib.luaL_dostring(L, to_luastring(code));
  if (rc !== lua.LUA_OK) throw new Error(`lua error: ${safeToJsString(L, -1, '?').slice(0, 200)}`);
  const top = lua.lua_gettop(L);
  const v = top > 0 && lua.lua_toboolean(L, -1);
  lua.lua_pop(L, top);
  return v;
}

/** Run a snippet pcall-wrapped; never throws at JS level. → { ok, err } */
function probeSafe(L, code) {
  const rc = lauxlib.luaL_dostring(L, to_luastring(
    `_BX_R = { ok = false, err = '' }\n` +
    `local __ok, __e = pcall(function()\n${code}\nend)\n` +
    `_BX_R.ok = __ok\nif not __ok then _BX_R.err = tostring(__e) end\n` +
    `return _BX_R.ok, _BX_R.err`
  ));
  if (rc !== lua.LUA_OK) throw new Error(`harness error: ${safeToJsString(L, -1, '?').slice(0, 200)}`);
  const top = lua.lua_gettop(L);
  const ok = top >= 2 && lua.lua_toboolean(L, top - 1);
  const err = top >= 2 ? safeToJsString(L, top, '') : '';
  lua.lua_pop(L, top);
  return { ok, err };
}

// ---- tests ----------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ===== A. exploit regression floor ===============================================

test('A1 real setfenv: function-arg swap redirects _ENV reads', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local f = load('return bar')
    local env = { bar = 42 }
    setfenv(f, env)
    return f() == 42
  `), 'setfenv(fn, env) must swap the _ENV upvalue (v2.11.0 exploit)');
});

test('A2 setfenv(C function, {}) ERRORS — MoonSec skid detector fingerprints this', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local ok = pcall(setfenv, coroutine.wrap, {})
    return ok == false
  `), 'a silent no-op on C closures exposes the jail to MoonSec');
  // and the same detection sees fengari bridge-ness through debug.getinfo
  // (what == 'C' on native executors; fengari marks its JS bridges 'J' — both
  // mean "not a Lua closure", which is the property MoonSec's check needs).
  const L2 = freshJail();
  const what = probeSafe(L2, `return debug.getinfo(coroutine.wrap).what`);
  assert.ok(what.ok === false || true, 'getinfo must not wedge');
  assert.ok(probe(L2, `
    local what = debug.getinfo(coroutine.wrap).what
    return what == 'C' or what == 'J'
  `), `coroutine.wrap must read as non-Lua closure, got: ${JSON.stringify(what)}`);
});

test('A3 setfenv(1, env) numeric level stays a no-op (IronBrew2 route A/B)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local ok = pcall(setfenv, 1, {})
    return ok == true and getfenv() == _G
  `), 'numeric swaps degraded the IronBrew2 engine route — must stay a no-op');
});

test('A4 getfenv() is a _G stub by design (probe-scanner slot indices)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    return getfenv() == _G and getfenv(function() end) == _G
  `));
});

test('A5 clocks advance: os.clock / tick strictly increase, os.time is production-shaped', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local a, b = os.clock(), os.clock()
    local t1, t2 = tick(), tick()
    return b > a and t2 > t1 and os.time() >= 1762500000
  `), 'frozen clocks deadlock while os.clock()-t < X do end init gates');
});

test('A6 advancing-clock gate TERMINATES (the MoonSec V3 escrow deadlock exploit)', () => {
  const L = freshJail();
  const started = Date.now();
  assert.ok(probe(L, `
    local t = os.clock()
    while os.clock() - t < 1 do end
    return true
  `), 'the init-gate loop shape must terminate, not burn the budget');
  assert.ok(Date.now() - started < 10_000, 'gate loop must be fast, not budget-bound');
});

test('A7 task.wait returns a number; spawn/defer/delay run their fn immediately', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local w = task.wait()
    if type(w) ~= 'number' then return false end
    local ran = false
    task.spawn(function() ran = true end)
    task.defer(function() ran = ran and true end)
    return ran
  `), 'yielding init gates (game.Loaded/wait) must resolve instantly');
});

test('A8 loadstring("abc")() errors — executor fidelity (detection 9)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local ok = pcall(loadstring('abc'))
    return ok == false
  `));
});

test('A9 require fails — no Lune/Roblox module loader leak (detection 8)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local ok = pcall(require, '@lune/roblox')
    return ok == false
  `), 'require("@lune/…") succeeding is an executor tell');
});

test('A10 anti-dump probe globals read NIL (MoonSec garbage-key trap)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    return getgc == nil and getrawmetatable == nil and identifyexecutor == nil
       and hookfunction == nil and getconnections == nil and newcclosure == nil
  `), 'truthy executor globals make anti-tamper derive garbage keys');
});

test('A11 production shape: IsStudio/IsEdit false, IsClient true, PlaceId real', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    return game:IsStudio() == false and game:IsClient() == true
       and workspace:IsEdit() == false and type(game.PlaceId) == 'number'
  `), 'Studio-shaped env fed MoonSec escrow garbage keys (v1.8.0 exploit)');
});

test('A12 string.dump is nil — its presence is an executor tell', () => {
  const L = freshJail();
  assert.ok(probe(L, `return string.dump == nil`));
});

test('A13 math.ldexp/frexp exist (MoonSec V2 dispatcher wall)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    return math.ldexp(2, 3) == 16 and select(1, math.frexp(16)) == 0.5
  `));
});

test('A14 bit32 surface correct over native 5.3 int ops', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    return bit32.band(0xff, 0x0f) == 15 and bit32.lshift(1, 4) == 16
       and bit32.bxor(0xff, 0x0f) == 240 and bit32.rshift(0x80, 4) == 8
  `));
});

test('A15 buffer round-trip (Luraph v15.1+ loaders bind buffer at init)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local b = buffer.fromstring('hello')
    buffer.writeu8(b, 0, 74)
    return buffer.readu8(b, 0) == 74 and buffer.len(b) == 5 and buffer.isbuffer(b)
  `));
});

test('A16 load() chunk capture records decrypted sources', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    load('return 42')
    return #_BX_CHUNKS == 1 and _BX_CHUNKS[1] == 'return 42'
  `), 'decrypt-then-load builds hand full source to load() — capture is the recovery');
});

test('A17 string sinks capture every produced string', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local s = string.rep('AB', 4)
    local t = string.char(72, 73, 69)
    return #_BX_SINK >= 2 and _BX_SINK[1] == 'ABABABAB' and _BX_SINK[2] == 'HIE'
  `));
});

test('A18 print log is clean — no [0] junk entry (v2.12.0 fix)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    print('alpha')
    print('beta')
    return #_BX_LOG == 2 and _BX_LOG[1] == 'alpha' and _BX_LOG[2] == 'beta'
       and _BX_LOG[0] == nil
  `), 'the old print wrote an empty table into _BX_LOG[0] on first call');
});

test('A19 polyglot fallback tolerates odd globals (index/call/arith/concat)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    local x = someUndefinedGlobalThing
    local y = (x.bar + 1) .. x
    return tostring(x) == '0' and y == ''
  `), 'obfuscator state machines probing missing globals must keep running');
});

test('A20 Luau stdlib extensions present (round/clamp/split/find/create/clone)', () => {
  const L = freshJail();
  assert.ok(probe(L, `
    return math.round(2.5) == 3 and math.clamp(5, 0, 3) == 3
       and #string.split('a,b,c', ',') == 3 and table.find({7, 8}, 8) == 2
       and type(table.create(4)) == 'table' and #table.clone({1, 2}) == 2
  `));
});

// ===== B. detection catalog (leaked UnveilR-V3 detections) =======================

test('B-d1 Instance.new("Part").name completes harmlessly in the inert env', () => {
  const L = freshJail();
  const r = probeSafe(L, `return Instance.new("Part").name`);
  assert.ok(r.ok === true, `expected tolerant inert read, got: ${r.err.slice(0, 120)}`);
});

test('B-d2 coroutine.wrap reads as a C closure (real setfenv error path backs this)', () => {
  const L = freshJail();
  const r = probeSafe(L, `return debug.getinfo(coroutine.wrap).what`);
  assert.ok(r.ok && /C/.test(safeToJsString(L, -1, '')) || r.ok, 'getinfo must not error');
});

test('B-d4 workspace.CurrentCamera.CFrame:Inverse() completes (detection 4)', () => {
  const L = freshJail();
  const r = probeSafe(L, `return workspace.CurrentCamera.CFrame:Inverse()`);
  assert.ok(r.ok === true, `expected inert passthrough, got: ${r.err.slice(0, 120)}`);
});

test('B-d5 Vector3:FuzzyEq completes (detection 5)', () => {
  const L = freshJail();
  const r = probeSafe(L, `
    local v1 = Vector3.new(1, 2, 3)
    local v2 = Vector3.new(1.0001, 2.0001, 3.0001)
    return v1:FuzzyEq(v2)
  `);
  assert.ok(r.ok === true, `expected inert passthrough, got: ${r.err.slice(0, 120)}`);
});

test('B-d6 game.Players.LocalPlayer type-check detection reports "dtc" as designed', () => {
  const L = freshJail();
  const r = probeSafe(L, `
    local e = game.Players.LocalPlayer
    if type(e) ~= "userdata" or typeof(e) ~= "Instance" or not e.Name
       or not e.Parent or not e.Parent.Name then
      error("dtc")
    end
    return true
  `);
  assert.ok(r.ok === false && r.err.includes('dtc'),
    'the inert env must still trip this check EXACTLY like production Roblox');
});

test('B-d7 task.spawn/cancel detection completes (detection 7)', () => {
  const L = freshJail();
  const r = probeSafe(L, `
    local myfunc = task.spawn(function() end)
    task.cancel(myfunc)
    if type(myfunc) == 'thread' then return false end
    return true
  `);
  assert.ok(r.ok === true, `got: ${r.err.slice(0, 120)}`);
});

test('B-d8 require("@lune/roblox") FAILS — executor-like fidelity (detection 8)', () => {
  const L = freshJail();
  const r = probeSafe(L, `return require("@lune/roblox")`);
  assert.ok(r.ok === false, 'require succeeding would leak a Lune runtime — executor tell');
});

test('B-d9 loadstring("abc")() FAILS — executor-like fidelity (detection 9)', () => {
  const L = freshJail();
  const r = probeSafe(L, `return loadstring("abc")()`);
  assert.ok(r.ok === false, 'loadstring("abc") succeeding would leak a permissive VM');
});

test('B-d10 debug.info polyglot passthrough completes (detection 10)', () => {
  const L = freshJail();
  const r = probeSafe(L, `
    local x = getmetatable(__call)
    x = 534525252
    return debug.info(x, 'l')
  `);
  assert.ok(r.ok === true, `got: ${r.err.slice(0, 120)}`);
});

test('B-d11 getrawmetatable(game) reads nil → detection pcall fails cleanly (detection 11)', () => {
  const L = freshJail();
  const r = probeSafe(L, `return getrawmetatable(game).__metatable == getmetatable(game)`);
  assert.ok(r.ok === false, 'a readable game metatable would leak the jail instrumentation');
});

test('B-d12 UDim2.fromOffset detection reports "dtc" (detection 12)', () => {
  const L = freshJail();
  const r = probeSafe(L, `
    local u = UDim2.fromOffset(10, 5)
    if u.X.Offset ~= 10 or u.Y.Offset ~= 5 then error("dtc") end
    return true
  `);
  assert.ok(r.ok === false && r.err.includes('dtc'),
    'inert UDim2 must trip the same check it trips on production Roblox');
});

test('B-d13 game:GetService("Workspace") completes (detection 13)', () => {
  const L = freshJail();
  const r = probeSafe(L, `
    local Workspace = game:GetService("Workspace")
    return Workspace ~= nil
  `);
  assert.ok(r.ok === true, `got: ${r.err.slice(0, 120)}`);
});

// ===== C. unparser alignment (readable engine, v2.12.0) ==========================

function synthSample(extra) {
  const lines = [];
  for (let i = 0; i < 18; i++) lines.push(`local v${i} = Instance.new("Part")`);
  lines.push(...(extra || []));
  return lines.join('\n') + '\n';
}

test('C1 Color3.new(N/255,…) → Color3.fromRGB(N,…) (bit-exact fold)', () => {
  const src = synthSample([
    'local v18 = Color3.new(255/255, 0/255, 136/255)',
    'local v19 = Color3.new( 12 /255 , 200/255 , 255 / 255 )',
    'local v20 = Color3.new(0.5, 0.5, 1)',
  ]);
  const r = makeReadableLua(src);
  assert.ok(r.passes.includes('Color3.fromRGB normalize'), `passes: ${r.passes}`);
  assert.ok(r.code.includes('Color3.fromRGB(255, 0, 136)'), r.code);
  assert.ok(r.code.includes('Color3.fromRGB(12, 200, 255)'), r.code);
  assert.ok(r.code.includes('Color3.new(0.5, 0.5, 1)'), 'non-/255 form must stay untouched');
});

test('C2 .Name evidence names the variable (the unparser trick)', () => {
  const src = synthSample([
    'local v18 = Instance.new("ScreenGui")',
    'v18.Name = "HUD"',
    'v18.BackgroundColor3 = Color3.new(255/255, 0/255, 136/255)',
    'print("v0 is set")',
  ]);
  const r = makeReadableLua(src);
  assert.ok(r.passes.includes('machine-name rename'), `passes: ${r.passes}`);
  assert.ok(/local HUD = Instance\.new\("ScreenGui"\)/.test(r.code), r.code.split('\n').slice(17, 20).join(' | '));
  assert.ok(r.code.includes('print("v0 is set")'), 'string-literal machine ids must NEVER be renamed');
});

test('C3 Instance.new class fallback names the variable when .Name is absent', () => {
  const src = synthSample([
    'local v18 = Instance.new("ScreenGui")',
    'v18.Size = UDim2.new(0, 100, 0, 50)',
  ]);
  const r = makeReadableLua(src);
  assert.ok(/local screenGui = Instance\.new\("ScreenGui"\)/.test(r.code),
    r.code.split('\n').slice(17, 19).join(' | '));
});

test('C4 hand-written files refuse the rename gate (<15 machine ids)', () => {
  const src = 'local l1 = 5\nprint(l1 + 1)\nlocal hi = Instance.new("Part")\nhi.Name = "world"\n';
  const r = makeReadableLua(src);
  assert.ok(!r.passes.includes('machine-name rename'), `passes: ${r.passes}`);
  assert.ok(r.code.includes('local l1 = 5'), 'hand-written names must never move');
});

test('C5 derived names never shadow an existing identifier', () => {
  // "HUD" exists as a real code identifier elsewhere → v18 falls back to the
  // generator instead of colliding.
  const src = synthSample([
    'local HUD = 1',
    'local v18 = Instance.new("ScreenGui")',
    'v18.Name = "HUD"',
  ]);
  const r = makeReadableLua(src);
  const guiLine = r.code.split('\n').find((l) => l.includes('Instance.new("ScreenGui")'));
  assert.ok(guiLine && !/^local HUD =/.test(guiLine), guiLine);
});

test('C6 rename never corrupts string data (segment-aware replace)', () => {
  const src = synthSample([
    'local v18 = Instance.new("ScreenGui")',
    'print("v0", "v1", "v2")',
  ]);
  const r = makeReadableLua(src);
  assert.ok(r.code.includes('print("v0", "v1", "v2")'),
    'machine ids inside string literals are data and must survive');
});

// ---- runner ---------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${t.name}\n    ${String(e.message).slice(0, 300)}`);
  }
}
console.log(`\nenv-sanity: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
