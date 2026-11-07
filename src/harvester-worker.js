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
// v1.6: full Luau-targeted stdlib (fengari lacks math.ldexp/frexp — Lua 5.3
// APIs MoonSec V2 binds at init — plus Luau-only math/table/string/bit32
// extensions VM dispatchers bind), exploit-probe globals read NIL (as in
// production Roblox — MoonSec anti-tamper feeds garbage keys when it "sees"
// exploit functions), and the polyglot fallback last.
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

-- Lua 5.3 APIs fengari does not implement (MoonSec V2 binds math.ldexp at
-- dispatcher init — its absence was the "attempt to call nil upvalue" wall)
math.ldexp = function(m, e) return m * 2.0 ^ e end
math.frexp = function(x)
  if x == 0 or x ~= x then return x, 0 end
  local e = 0; local m = math.abs(x)
  while m >= 1 do m = m / 2; e = e + 1 end
  while m < 0.5 do m = m * 2; e = e - 1 end
  return x < 0 and -m or m, e
end

-- Luau tolerates fractional numbers where Lua 5.3 demands integers
-- (string.char/string.rep) — Luraph v15.1 loaders hit this immediately.
local __uchar = string.char
string.char = function(...)
  local n = select('#', ...)
  local t = {}
  for i = 1, n do
    local v = select(i, ...)
    if type(v) == 'number' then v = v - v % 1 end
    t[i] = v
  end
  return __uchar(table.unpack(t, 1, n))
end
local __urep = string.rep
string.rep = function(s, n, sep)
  if type(n) == 'number' then n = n - n % 1 end
  return __urep(s, n, sep)
end

-- Luau-only stdlib extensions VM obfuscators bind (math/table/string/bit32)
math.round = function(x) return math.floor(x + 0.5) end
math.clamp = function(x, lo, hi) if x < lo then return lo elseif x > hi then return hi else return x end end
math.sign = function(x) if x > 0 then return 1 elseif x < 0 then return -1 else return 0 end end
string.split = function(s, sep)
  local out = {}
  if sep == nil or sep == '' then for i = 1, #s do out[i] = s:sub(i, i) end return out end
  local pat = '([^' .. sep .. ']*)'
  for m in string.gmatch(s, pat) do out[#out + 1] = m end
  return out
end
table.find = function(t, v) for i, x in ipairs(t) do if x == v then return i end end return nil end
table.findLast = function(t, v) local last = nil for i, x in ipairs(t) do if x == v then last = i end end return last end
table.create = function(n) return {} end
table.clear = function(t) for k in pairs(t) do t[k] = nil end end
table.clone = function(t) local o = {} for k, v in pairs(t) do o[k] = v end return o end
coroutine.close = function(co) return true end

-- bit32 / bit over native 5.3 int ops (full Luau surface incl. countlz etc.)
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
  btest = function(...) return bit32.band(...) ~= 0 end,
  extract = function(n, f, w) w = w or 1 if f < 0 then f = 0 end if w <= 0 then return 0 end
    return (n >> f) & ((1 << w) - 1) end,
  replace = function(n, v, f, w) w = w or 1 if f < 0 then f = 0 end if w <= 0 then return n & __f end
    local mask = ((1 << w) - 1) << f
    return ((n & __f) & ~mask) | ((v << f) & mask) end,
  countlz = function(n) n = n & __f if n == 0 then return 32 end local r = 0 while n < 0x80000000 do r = r + 1; n = n << 1 end return r end,
  countrz = function(n) n = n & __f if n == 0 then return 32 end local r = 0 while n & 1 == 0 do r = r + 1; n = n >> 1 end return r end,
  byteswap = function(n) n = n & __f
    return ((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >> 8) & 0xff00) | ((n >> 24) & 0xff) end,
  lrotate = function(n, d) d = d % 32 if d == 0 then return n & __f end
    return (((n & __f) << d) | ((n & __f) >> (32 - d))) & __f end,
  rrotate = function(n, d) d = d % 32 if d == 0 then return n & __f end
    return (((n & __f) >> d) | ((n & __f) << (32 - d))) & __f end,
}
bit = bit32

-- exploit-monitor / debug-probe globals MUST read nil (as in production
-- Roblox): MoonSec's anti-tamper derives garbage keys when they exist, which
-- poisons the decrypted pool. The inert fallback below would have made them
-- truthy — the anti-dump trap.
local __NILPROBE = {
  islclosure = true, is_l_closure = true, iscclosure = true, checkclosure = true,
  getconstants = true, getconstant = true, getprotos = true,
  getupvalue = true, getupvalues = true, setupvalue = true, setupvaluename = true,
  getregistry = true, getsenv = true, getcallingscript = true,
  hookfunction = true, hookmetamethod = true, newcclosure = true,
  getconnections = true, getgc = true, getloadedmodules = true,
  getrawmetatable = true, setreadonly = true, setclipboard = true,
  identifyexecutor = true, getexecutorname = true,
}

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
-- probe odd globals keep running instead of dying on nil. Installed LAST so
-- the compat shims above bind real values first.
local __N2; __N2 = setmetatable({}, {
  __index = function() return __N2 end, __call = function() return __N2 end,
  __add = function() return 0 end, __sub = function() return 0 end, __mul = function() return 0 end,
  __div = function() return 0 end, __mod = function() return 0 end, __pow = function() return 0 end, __idiv = function() return 0 end,
  __band = function() return 0 end, __bor = function() return 0 end, __bxor = function() return 0 end,
  __bnot = function() return 0 end, __shl = function() return 0 end, __shr = function() return 0 end,
  __concat = function() return '' end, __len = function() return 0 end, __unm = function() return 0 end,
  __tostring = function() return '0' end, __eq = function() return false end,
  __lt = function() return false end, __le = function() return false end, __metatable = 'BX',
})
setmetatable(_G, { __index = function(t, k)
  if __NILPROBE[k] then return nil end
  return __N2
end })
`;

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
  console.log(JSON.stringify({ ok: false, error: String(msg).slice(0, 300) }));
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
  if (rc !== lua.LUA_OK) return { loaded: false, err: lua.lua_tojsstring(L, -1).slice(0, 200) };
  lua.lua_setglobal(L, to_luastring('_BX_F'));
  rc = lauxlib.luaL_dostring(L, to_luastring(`
    _BX_RESULT = {}
    local __ok, __e = pcall(_BX_F)
    _BX_RESULT.ok = __ok
    if not __ok then _BX_RESULT.err = tostring(__e) end
  `));
  if (rc !== lua.LUA_OK) return { loaded: true, err: `runner: ${lua.lua_tojsstring(L, -1).slice(0, 160)}` };
  return { loaded: true, err: null };
}

let rcPrelude = lauxlib.luaL_dostring(L, to_luastring(PRELUDE));
if (rcPrelude !== lua.LUA_OK) fail(`prelude failed: ${lua.lua_tojsstring(L, -1)}`);

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
      const s = lua.lua_tojsstring(L, -1);
      if (s) out.push(s);
    }
    lua.lua_pop(L, 1);
  }
  lua.lua_pop(L, 1);
  return out;
}
