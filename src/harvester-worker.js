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
 *   • inert Roblox proxies (game/workspace/Instance/Enum/… chain to nothing)
 *   • string sinks: char/sub/rep/reverse/upper/lower/format/gsub/table.concat
 *     record every produced string into _BX_SINK
 *   • instruction budget via debug count hook (hard SIGKILL by spawnHardened)
 *
 * stdout: ONE JSON line { ok, ran, runError, strings[], log[] }
 * Never executes recovered code outside this jail; never touches the network.
 */
import fs from 'node:fs';
import fengari from 'fengari';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const INPUT = process.argv[2];
const BUDGET_TOTAL = Number(process.env.BX_BUDGET) || 300e6;
const HOOK_INTERVAL = 2.5e6;
const MAX_SINK = 60_000;
const MAX_STR = 8192;
const MAX_OUT = 20_000;

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
        if (lua.lua_isstring(L, -1)) runError = lua.lua_tojsstring(L, -1).slice(0, 200);
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
    console.log(JSON.stringify({ ok: true, ran, runError, budgetHit: budget <= 0, partial: Boolean(note), note: note || null, strings, log: logLines.slice(0, 50) }));
  } catch {
    console.log(JSON.stringify({ ok: true, ran: false, strings: [], log: [] }));
  }
  process.exit(0);
}
process.on('SIGTERM', () => dumpAndExit('time budget — partial pool'));
process.on('SIGINT', () => dumpAndExit('interrupted'));

let code;
try {
  code = fs.readFileSync(INPUT, 'utf8');
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: `read failed: ${e.message}` }));
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

// ---- sandbox prelude (Lua) --------------------------------------------------
const PRELUDE = `
-- sink
_BX_SINK = {}
_BX_LOG = {}
local __N = 0
function __bx_rec(v)
  if type(v) == 'string' then
    local n = #v
    if n >= 3 and n <= ${MAX_STR} and __N < ${MAX_SINK} then
      __N = __N + 1
      _BX_SINK[__N] = v
    end
  end
end

-- string/table sinks
local function __wrap1(mod, name)
  local orig = mod[name]
  if type(orig) ~= 'function' then return end
  mod[name] = function(...)
    local r = orig(...)
    __bx_rec(r)
    return r
  end
end
__wrap1(string, 'char')
__wrap1(string, 'sub')
__wrap1(string, 'rep')
__wrap1(string, 'reverse')
__wrap1(string, 'upper')
__wrap1(string, 'lower')
__wrap1(string, 'format')
__wrap1(table, 'concat')
local __gsub = string.gsub
string.gsub = function(s, pat, rep, ...)
  local a, b = __gsub(s, pat, rep, ...)
  __bx_rec(a)
  return a, b
end

-- remove host-reaching libraries
io = nil
package = nil
require = nil
dofile = nil
loadfile = nil
os = { clock = function() return 0 end, time = function() return 1762500000 end,
      date = function() return 'Thu Jan  1 00:00:00 2026' end }

-- 5.1 compat
getfenv = function() return _G end
setfenv = function(f) return f end
unpack = unpack or table.unpack
loadstring = load

-- bit32 / bit over native 5.3 int ops
local __f = 0xffffffff
bit32 = {
  band = function(...) local r = -1 for _, v in ipairs({ ... }) do r = r & v end return r & __f end,
  bor = function(...) local r = 0 for _, v in ipairs({ ... }) do r = r | v end return r & __f end,
  bxor = function(...) local r = 0 for _, v in ipairs({ ... }) do r = r ~ v end return r & __f end,
  bnot = function(a) return (~a) & __f end,
  lshift = function(a, b) b = b % 32 return (a << b) & __f end,
  rshift = function(a, b) b = b % 32 return (a >> b) & __f end,
  arshift = function(a, b) b = b % 32 return a >> b end,
  tobit = function(a) return a & __f end,
}
bit = bit32

-- inert Roblox universe: any index/call chains to itself, produces nothing
local __INERT
__INERT = setmetatable({}, {
  __index = function() return __INERT end,
  __newindex = function() end,
  __call = function() return __INERT end,
  __tostring = function() return 'BypassXInert' end,
  __metatable = 'BypassX',
})
local function __inertfn() return __INERT end
game = __INERT
workspace = __INERT
workspace = setmetatable({}, { __index = function() return __inertfn end, __call = __inertfn })
script = __INERT
shared = {}
Enum = __INERT
Instance = { new = function() return __INERT end }
task = {
  wait = function() error('bx: wait not permitted', 0) end,
  spawn = function() error('bx: spawn not permitted', 0) end,
  defer = function() error('bx: defer not permitted', 0) end,
  delay = function() error('bx: delay not permitted', 0) end,
}
wait = task.wait
spawn = task.spawn
delay = task.delay
tick = function() return 0 end
time = function() return 0 end
print = function(...) _BX_LOG[#_BX_LOG] = _BX_LOG[#_BX_LOG] or {} local t = {} for i = 1, select('#', ...) do t[#t + 1] = tostring(select(i, ...)) end if #_BX_LOG < 200 then _BX_LOG[#_BX_LOG + 1] = table.concat(t, ' ') end end
warn = print

-- polyglot fallback: ANY missing global resolves to a value that tolerates
-- indexing, calling, arithmetic and concat — obfuscator state machines that
-- probe odd globals keep running instead of dying on nil.
local __N; __N = setmetatable({}, {
  __index = function() return __N end, __call = function() return __N end,
  __add = function() return 0 end, __sub = function() return 0 end, __mul = function() return 0 end,
  __div = function() return 0 end, __mod = function() return 0 end, __pow = function() return 0 end, __idiv = function() return 0 end,
  __band = function() return 0 end, __bor = function() return 0 end, __bxor = function() return 0 end,
  __bnot = function() return 0 end, __shl = function() return 0 end, __shr = function() return 0 end,
  __concat = function() return '' end, __len = function() return 0 end, __unm = function() return 0 end,
  __tostring = function() return '0' end, __eq = function() return false end,
  __lt = function() return false end, __le = function() return false end, __metatable = 'BX',
})
setmetatable(_G, { __index = function() return __N end })
`;

// ---- run --------------------------------------------------------------------
function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: String(msg).slice(0, 300) }));
  process.exit(0);
}

let rc = lauxlib.luaL_dostring(L, to_luastring(PRELUDE));
if (rc !== lua.LUA_OK) fail(`prelude failed: ${lua.lua_tojsstring(L, -1)}`);

try {
  // Luau builds (MoonSec V2/V3 Luau targets, Luraph luau) use compound
  // assignments Lua 5.3 rejects — best-effort rewrite first, original second.
  let loaded = false;
  let compileErr = null;
  let transformed = code;
  try {
    const mod = await import('./luau-shim.js');
    if (mod.hasLuauCompoundAssign(code)) transformed = mod.transformLuauToLua(code);
  } catch { /* shim unavailable — original path */ }
  for (const candidate of [transformed, code]) {
    const chunk = to_luastring(candidate, true);
    rc = lauxlib.luaL_loadbuffer(L, chunk, chunk.length, to_luastring('@bypassx'));
    if (rc === lua.LUA_OK) { loaded = true; break; }
    compileErr = lua.lua_tojsstring(L, -1).slice(0, 200);
  }
  if (!loaded) fail(`compile: ${compileErr}`);
  lua.lua_setglobal(L, to_luastring('_BX_F'));

  rc = lauxlib.luaL_dostring(L, to_luastring(`
    _BX_RESULT = {}
    local __ok, __e = pcall(_BX_F)
    _BX_RESULT.ok = __ok
    if not __ok then _BX_RESULT.err = tostring(__e) end
  `));
  if (rc !== lua.LUA_OK) fail(`runner failed: ${lua.lua_tojsstring(L, -1).slice(0, 200)}`);
} catch (e) {
  // budget longjmp / internal abort — sink data collected so far is still valid
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
      const s = lua.lua_tojsstring(L, -1);
      if (s) out.push(s);
    }
    lua.lua_pop(L, 1);
  }
  lua.lua_pop(L, 1);
  return out;
}
