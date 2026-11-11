/**
 * BypassX Deobf Bot — shared jailed-sandbox Lua prelude.
 *
 * Installed in EVERY fengari worker before the sample runs. One source of
 * truth so the harvester and the VM lifter run in byte-identical jails:
 *   • io/os/require/loadfile/dofile/package removed; os = {clock,time,date}
 *   • bit32/bit implemented over Lua 5.3 native int ops
 *   • getfenv/setfenv/unpack/loadstring 5.1 compat shims
 *   • LOAD-CHUNK CAPTURE: every chunk passed to load()/loadstring() is
 *     recorded into _BX_CHUNKS. Decrypt-then-load builds (Luraph LPH_ENCSTR
 *     wrappers, PSU, MoonSec V2 load-stage variants, IronBrew lines,
 *     WeAreDevs, slua) hand their FULL DECRYPTED SOURCE to load() at init.
 *   • production-shaped Roblox env (v1.8.0): game.PlaceId/JobId/CreatorId are
 *     real numbers, RunService-style Is* probes return production booleans
 *     (IsStudio/IsEdit/IsRunMode → false, IsClient → true), executor-only
 *     service methods (HttpGet/HttpPost/…) read nil. Anti-dump checks that
 *     "see" an executor or a Studio env previously fed garbage keys.
 *   • string sinks: char/sub/rep/reverse/upper/lower/format/gsub/table.concat
 *     record every produced string into _BX_SINK
 *
 * The string is installed verbatim by both workers — edit with care and run
 * test/harvest-chunks.js after any change.
 */

export const MAX_STR = 8192;
export const MAX_SINK = 24_000;
export const MAX_CHUNKS = 64;
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_CHUNKS_TOTAL = 3 * 1024 * 1024;

// v2.15.0 AntiTamper V2: the prelude string now COMPOSES the production-shape
// hardening layer (src/antitamper/env-hardening.js — game metatable lock +
// hidden internals __pairs). Both workers keep installing one byte-identical
// string; the layer is generated, not hand-maintained here.
import { PRODUCTION_LUA } from './antitamper/env-hardening.js';
export const PRELUDE = `
-- sink
_BX_SINK = {}
_BX_LOG = {}
_BX_CHUNKS = {}
local __N = 0
local __C = 0
local __B = 0
function __bx_rec(v)
  -- _BX_MUTE: instrumentation (lift worker serialization/probing) sets this
  -- while building its own strings so jail chatter never pollutes the pool.
  -- rawget — a plain read would hit the polyglot __index and return a
  -- truthy object for this (normally unset) global, muting everything.
  if rawget(_G, '_BX_MUTE') then return end
  if type(v) == 'string' then
    local n = #v
    -- v2.10.0 byte budget: retained sink bytes are capped so decryptors that
    -- synthesize megabytes of string data cannot balloon the VM heap (the
    -- 2GB-abort class of failure). The best strings arrive early; late noise
    -- is dropped, not retained.
    if n >= 3 and n <= ${MAX_STR} and __N < ${MAX_SINK} and __B + n <= 2097152 then
      __N = __N + 1
      __B = __B + n
      _BX_SINK[__N] = v
    end
  end
end

-- _BXCAP: passthrough capturer for source-transform instrumentation
-- (v2.10.0). The harvester's 25ms-style concat-injection tier rewrites
-- pool-table concat expressions into _BXCAP(<expr>) before the run; strings
-- the VM builds by raw '..' concatenation — invisible to the function sinks
-- above — are recorded the moment they are joined. Passthrough keeps
-- expression semantics identical.
function _BXCAP(v)
  __bx_rec(v)
  return v
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
-- v2.11.0: clocks ADVANCE (leaked-corpus exploit). A frozen os.clock()/tick()
-- deadlocks any init loop shaped like 'while os.clock() - t < X do end' (MoonSec
-- V3 escrow init does exactly this) — the loop burns the whole instruction
-- budget on one wait gate and the pool stays empty. Each call now steps ~10ms so
-- such gates terminate after a bounded number of polls while the count hook
-- still bounds total work.
local __bx_clock = 0
io = nil
package = nil
require = nil
dofile = nil
loadfile = nil
os = { clock = function() __bx_clock = __bx_clock + 0.01; return __bx_clock end, time = function() return 1762500000 + math.floor(__bx_clock * 100) end,
      date = function() return 'Thu Jan  1 00:00:00 2026' end }

-- 5.1 compat — REAL setfenv + stub getfenv (v2.11.0, leaked-corpus exploit).
-- The old stubs ignored their arguments. Fengari is 5.3: every loaded
-- function carries its environment in an _ENV upvalue, so setfenv is
-- implementable exactly:
--   setfenv(fn, env) → swap fn's _ENV upvalue (real)
--   setfenv(n, env)  → swap the level-n caller's _ENV (real, via getinfo)
--   setfenv(C-fn, _) → 5.1 error (MoonSec's C-closure detector needs this)
-- getfenv stays a _G stub DELIBERATELY: even the no-arg call's frame residue
-- perturbs debug.getlocal slot indices that the run-2 lift probe scanner
-- depends on (probes install at a shifted base → the dispatcher reads nil and
-- breaks before executing a single probe record; verified empirically —
-- replacing the probe fixture's getfenv() with _G restores 10/10 probes).
-- The devirtualization scanner covers more builds than a numeric-getfenv
-- nicety; MoonSec's constant-pool reads go through setfenv'd tables and the
-- pool capture, both of which work with this pairing.
-- All probes are pcall-guarded: the jail never throws on a sample.
local function __bx_env_of(fn)
  if type(fn) ~= 'function' then return nil, nil end
  local i = 1
  while true do
    local ok, name, v = pcall(debug.getupvalue, fn, i)
    if not ok or not name then return nil, nil end
    if name == '_ENV' then return v, i end
    i = i + 1
  end
end
local function __bx_level_func(lvl)
  local ok, info = pcall(debug.getinfo, lvl, 'f')
  if ok and info then return info.func end
  return nil
end
getfenv = function() return _G end
-- v2.15.0 (AntiTamper V2): SHARED-_ENV POISON GUARD (swap → canary → rollback).
-- fengari binds prelude-chunk closures (bit32 members, sink wrappers, INERT
-- handlers, …) to the SAME _ENV upvalue object as several stdlib closures
-- (print shares it). Swapping that upvalue rewires the environment of every
-- prelude-internal function at once: __bx_rec reads nil, string sinks die,
-- decrypt pools go silent — a jail self-poison no capture could recover from.
-- So setfenv performs the swap, then checks a canary that reads globals
-- through the prelude's own _ENV (bit32.bxor → ipairs). If the canary dies
-- the swap hit the shared upvalue and is ROLLED BACK; runtime load()-ed
-- closures (MoonSec dispatchers, second-stage chunks) have their own _ENV
-- upvalue, pass the canary, and keep full real-swap semantics — the
-- A/B-verified v2.11.0 MoonSec behavior is preserved exactly where it matters.
-- The canary ERRORS when poisoned: reading bit32 (a prelude-internal global
-- via the shared _ENV) yields nil under the swap → indexing nil raises.
-- CRITICAL: every reference setfenv touches AFTER the swap must be a LOCAL
-- (upvalue), because a poisoned _ENV makes global reads (pcall, debug) nil —
-- the rollback itself would die before restoring. Captured below as locals.
local __bx_pcall = pcall
local __bx_setupvalue = debug.setupvalue
local __bx_getupvalue = debug.getupvalue
local __bx_sentinel = function() return bit32.bxor(1.5, 2) end
setfenv = function(f, env)
  if env == nil then return f end
  if type(f) == 'function' then
    local _, i = __bx_env_of(f)
    if i then
      -- v2.15.0: swap, canary, rollback (see the guard comment above). The
      -- canary reads globals through the prelude's _ENV — if the swap hit the
      -- shared persistent upvalue the canary dies and the original value is
      -- restored via the LOCAL-captured debug refs.
      local _, oldv = __bx_getupvalue(f, i)
      __bx_pcall(__bx_setupvalue, f, i, env)
      local canok = __bx_pcall(__bx_sentinel)
      if not canok then
        __bx_pcall(__bx_setupvalue, f, i, oldv)
      end
      return f
    end
    -- no _ENV upvalue = C function in 5.3 terms: 5.1 setfenv ERRORS here.
    -- MoonSec fingerprints exactly this ("skid" detector does
    -- pcall(setfenv, suspect, {}); a silent no-op exposes the jail).
    error('cannot change environment of given object', 2)
  end
  -- numeric levels (setfenv(1, fenv) — IronBrew2's env setup, MoonSec V1's
  -- self-sandbox) stay a no-op: actually swapping the caller's _ENV here
  -- redirects VM global reads away from the instrumented _G and degraded the
  -- IronBrew2 engine route (corpus sample regressed to an input echo in the
  -- Biggest Scan A/B). Function-arg swaps above carry the MoonSec semantics.
  return f
end
unpack = unpack or table.unpack

-- LOAD-CHUNK CAPTURE (v1.8.0): record every chunk the sample hands to
-- load()/loadstring(). Decrypt-then-load obfuscators pass their FULL
-- decrypted source (or bytecode) here — capture is complete recovery.
-- Function chunks are drained (capped); strings are taken as-is.
local __bx_orig_load = load
local __bx_chunk_bytes = 0
load = function(chunk, chunkname, mode, env)
  if type(chunk) == 'string' then
    local n = #chunk
    if n >= 8 and n <= ${MAX_CHUNK_BYTES} and __C < ${MAX_CHUNKS} and __bx_chunk_bytes < ${MAX_CHUNKS_TOTAL} then
      __C = __C + 1
      _BX_CHUNKS[__C] = chunk
      __bx_chunk_bytes = __bx_chunk_bytes + n
    end
  elseif type(chunk) == 'function' then
    local parts = {}
    local total = 0
    for _ = 1, 100000 do
      local s = chunk()
      if type(s) ~= 'string' or s == '' then break end
      parts[#parts + 1] = s
      total = total + #s
      if total >= ${MAX_CHUNK_BYTES} or __bx_chunk_bytes + total >= ${MAX_CHUNKS_TOTAL} then break end
    end
    local src = table.concat(parts)
    local n = #src
    if n >= 8 and __C < ${MAX_CHUNKS} and __bx_chunk_bytes < ${MAX_CHUNKS_TOTAL} then
      __C = __C + 1
      _BX_CHUNKS[__C] = src
      __bx_chunk_bytes = __bx_chunk_bytes + n
    end
  end
  -- env=nil explicitly would bind _ENV=nil in fengari (loaded chunk loses
  -- globals); omitting the arg gives the real global env — production shape.
  if env == nil then return __bx_orig_load(chunk, chunkname, mode) end
  return __bx_orig_load(chunk, chunkname, mode, env)
end
loadstring = load

-- production Luau disables string.dump entirely — its presence is an
-- executor tell and some anti-dump checks look for exactly that.
string.dump = nil

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
    if type(v) == 'number' then v = math.tointeger(v - v % 1) or 0 end
    t[i] = v
  end
  return __uchar(table.unpack(t, 1, n))
end
local __urep = string.rep
string.rep = function(s, n, sep)
  if type(n) == 'number' then n = math.tointeger(n - n % 1) or 0 end
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
-- v2.14.0: Lua 5.3 bitwise ops demand integers — Luraph v15's decrypt
-- arithmetic feeds FLOATS into bit32 (verified live: 'number (local v) has no
-- integer representation' killed the loader at bit32.bxor). bit32 semantics:
-- every input is reduced mod 2^32 (floats floored, negatives normalized).
local __n32 = function(v)
  if type(v) ~= 'number' then v = 0 end
  -- math.floor(v) % 2^32 returns a FLOAT when the left operand is float —
  -- bitwise ops still reject it. math.tointeger makes the value a real
  -- integer; inf/nan fall back to 0.
  return math.tointeger(math.floor(v) % 4294967296) or 0
end
bit32 = {
  band = function(...) local r = -1 for _, v in ipairs({ ... }) do r = r & __n32(v) end return r & __f end,
  bor = function(...) local r = 0 for _, v in ipairs({ ... }) do r = r | __n32(v) end return r & __f end,
  bxor = function(...) local r = 0 for _, v in ipairs({ ... }) do r = r ~ __n32(v) end return r & __f end,
  bnot = function(a) return (~__n32(a)) & __f end,
  lshift = function(a, b) b = __n32(b) % 32 return (__n32(a) << b) & __f end,
  rshift = function(a, b) b = __n32(b) % 32 return (__n32(a) >> b) & __f end,
  arshift = function(a, b) b = __n32(b) % 32 return __n32(a) >> b end,
  tobit = function(a) return __n32(a) end,
  btest = function(...) return bit32.band(...) ~= 0 end,
  extract = function(n, f, w) n = __n32(n) w = w or 1 if f < 0 then f = 0 end if w <= 0 then return 0 end
    return (n >> f) & ((1 << w) - 1) end,
  replace = function(n, v, f, w) n = __n32(n) v = __n32(v) w = w or 1 if f < 0 then f = 0 end if w <= 0 then return n & __f end
    local mask = ((1 << w) - 1) << f
    return ((n & __f) & ~mask) | ((v << f) & mask) end,
  countlz = function(n) n = __n32(n) if n == 0 then return 32 end local r = 0 while n < 0x80000000 do r = r + 1; n = n << 1 end return r end,
  countrz = function(n) n = __n32(n) if n == 0 then return 32 end local r = 0 while n & 1 == 0 do r = r + 1; n = n >> 1 end return r end,
  byteswap = function(n) n = __n32(n)
    return ((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >> 8) & 0xff00) | ((n >> 24) & 0xff) end,
  lrotate = function(n, d) n = __n32(n) d = d % 32 if d == 0 then return n & __f end
    return (((n & __f) << d) | ((n & __f) >> (32 - d))) & __f end,
  rrotate = function(n, d) n = __n32(n) d = d % 32 if d == 0 then return n & __f end
    return (((n & __f) >> d) | ((n & __f) << (32 - d))) & __f end,
}
bit = bit32

-- Luau buffer library (Luraph v15.1+ loaders bind it at init). Buffers are
-- represented as { __bx_buf = true, s = <string> }; reads via string.byte +
-- string.unpack, writes rebuild the string (loader workloads are read-heavy).
buffer = {}
local function bx_isbuf(t) return type(t) == 'table' and t.__bx_buf == true end
local function bx_pad(s, n) if #s >= n then return s end return s .. string.rep('\\0', n - #s) end
buffer.create = function(size) return { __bx_buf = true, s = string.rep('\\0', math.max(0, size)) } end
buffer.fromstring = function(s) return { __bx_buf = true, s = s or '' } end
buffer.tostring = function(b) if bx_isbuf(b) then return b.s end return '' end
buffer.isbuffer = function(b) return bx_isbuf(b) end
buffer.len = function(b) if bx_isbuf(b) then return #b.s end return 0 end
buffer.readstring = function(b, o, n) if not bx_isbuf(b) then return '' end return b.s:sub(o + 1, o + n) end
buffer.writestring = function(b, o, s)
  if not bx_isbuf(b) then return end
  s = s or ''
  b.s = b.s:sub(1, o) .. s .. b.s:sub(o + #s + 1)
end
buffer.readi8 = function(b, o) if not bx_isbuf(b) then return 0 end local v = b.s:byte(o + 1) or 0; if v >= 128 then v = v - 256 end return v end
buffer.readu8 = function(b, o) if not bx_isbuf(b) then return 0 end return b.s:byte(o + 1) or 0 end
local function bx_int(b, o, n, signed)
  if not bx_isbuf(b) then return 0 end
  local part = bx_pad(b.s:sub(o + 1, o + n), n)
  local fmt = signed and ('<i' .. n) or ('<I' .. n)
  local ok, v = pcall(string.unpack, fmt, part)
  if ok then return v end
  return 0
end
buffer.readi16 = function(b, o) return bx_int(b, o, 2, true) end
buffer.readu16 = function(b, o) return bx_int(b, o, 2, false) end
buffer.readi32 = function(b, o) return bx_int(b, o, 4, true) end
buffer.readu32 = function(b, o) return bx_int(b, o, 4, false) end
buffer.readf32 = function(b, o) if not bx_isbuf(b) then return 0 end local ok, v = pcall(string.unpack, '<f', bx_pad(b.s:sub(o + 1, o + 4), 4)); if ok then return v end return 0 end
buffer.readf64 = function(b, o) if not bx_isbuf(b) then return 0 end local ok, v = pcall(string.unpack, '<d', bx_pad(b.s:sub(o + 1, o + 8), 8)); if ok then return v end return 0 end
local function bx_write(b, o, n, v)
  if not bx_isbuf(b) then return end
  local fmt = n == 1 and '<B' or ('<I' .. n)
  local ok, packed = pcall(string.pack, fmt, v)
  if not ok then return end
  b.s = b.s:sub(1, o) .. packed .. b.s:sub(o + n + 1)
end
buffer.writei8 = function(b, o, v) bx_write(b, o, 1, v) end
buffer.writeu8 = function(b, o, v) bx_write(b, o, 1, v) end
buffer.writei16 = function(b, o, v) bx_write(b, o, 2, v) end
buffer.writeu16 = function(b, o, v) bx_write(b, o, 2, v) end
buffer.writei32 = function(b, o, v) bx_write(b, o, 4, v) end
buffer.writeu32 = function(b, o, v) bx_write(b, o, 4, v) end
buffer.writef32 = function(b, o, v) if bx_isbuf(b) then local ok, packed = pcall(string.pack, '<f', v); if ok then b.s = b.s:sub(1, o) .. packed .. b.s:sub(o + 5) end end end
buffer.writef64 = function(b, o, v) if bx_isbuf(b) then local ok, packed = pcall(string.pack, '<d', v); if ok then b.s = b.s:sub(1, o) .. packed .. b.s:sub(o + 9) end end end
-- Luau readbits/writebits: LSB-first bit fields crossing byte boundaries
buffer.readbits = function(b, o, n)
  if not bx_isbuf(b) or n <= 0 then return 0 end
  local bytes = math.ceil(n / 8)
  local acc = 0
  for i = 0, bytes - 1 do acc = acc + (b.s:byte(o + i + 1) or 0) * 256 ^ i end
  return acc % (2 ^ n)
end
buffer.writebits = function(b, o, n, v)
  if not bx_isbuf(b) or n <= 0 then return end
  v = math.floor(v) % (2 ^ n)
  local bytes = math.ceil(n / 8)
  for i = 0, bytes - 1 do
    local byte = b.s:byte(o + i + 1) or 0
    local mask = 255
    b.s = b.s:sub(1, o + i) .. string.char(byte) .. b.s:sub(o + i + 2)
  end
  -- simplified: write full bytes from the value (matches readbits for n%8==0)
  for i = 0, bytes - 1 do
    local byte = math.floor(v / 256 ^ i) % 256
    b.s = b.s:sub(1, o + i) .. string.char(byte) .. b.s:sub(o + i + 2)
  end
end
buffer.copy = function(target, to, source, from, count)
  if not bx_isbuf(target) or not bx_isbuf(source) then return end
  local part = source.s:sub(from + 1, from + count)
  target.s = target.s:sub(1, to) .. part .. target.s:sub(to + #part + 1)
end
buffer.fill = function(b, o, count, value)
  if not bx_isbuf(b) then return end
  local byte = math.max(0, math.min(255, math.floor((value or 0) % 256)))
  b.s = b.s:sub(1, o) .. string.rep(string.char(byte), math.max(0, count)) .. b.s:sub(o + count + 1)
end

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
  -- v2.12.0 (env-sanity suite): host-reaching libraries nil-assigned above are
  -- ABSENT keys — without this list the polyglot __index resurrected them as
  -- callable polyglot objects (pcall(require, '@lune/roblox') SUCCEEDED — an
  -- executor tell; leaked UnveilR-V3 detection 8 fingerprints exactly this).
  require = true, package = true, loadfile = true, dofile = true, io = true,
  -- v2.15.0 (AntiTamper V2): the complete executor-only surface reads NIL in
  -- production shape. Every name here ships as a REAL implementation in the
  -- executor masquerade layer (src/antitamper/env-hardening.js) on escalation;
  -- in the default jail they read nil exactly like live Roblox. Previously
  -- several of these (checkcaller, getgenv, getrenv, clonefunction,
  -- compareinstances, writefile/readfile, request, Drawing, …) fell through
  -- to the polyglot object — a truthy read was an executor tell.
  checkcaller = true, getgenv = true, getrenv = true, getreg = true,
  clonefunction = true, replaceclosure = true, compareinstances = true,
  isexecutorclosure = true, is_executor_closure = true,
  queue_on_teleport = true, gethui = true, getscriptbytecode = true,
  getscriptclosure = true, getthreadidentity = true, setthreadidentity = true,
  isfile = true, readfile = true, writefile = true, appendfile = true,
  delfile = true, isfolder = true, makefolder = true, delfolder = true,
  listdir = true, request = true, http_request = true,
  gethiddenproperty = true, sethiddenproperty = true, toclipboard = true,
  getnamecallmethod = true, firesignal = true, Drawing = true, syn = true,
  messagebox = true, rconsoleprint = true, rconsoleinfo = true,
  rconsolewarn = true, rconsoleerr = true, rconsoleclear = true,
  rconsolename = true, printconsole = true, setfpscap = true,
  fireclickdetector = true, firetouchinterest = true, fireproximityprompt = true,
}

-- inert Roblox universe (v1.8.0 production-shaped):
--   • executor-only service methods (HttpGet/HttpPost/websocket/…) read NIL —
--     a truthy read used to make anti-dump think an executor was present.
--   • calling an inert member returns production booleans for Is*/Has* probes
--     (IsStudio/IsEdit/IsRunMode/IsServer/IsRemote/IsMobile → false,
--     IsClient → true) instead of a truthy object — MoonSec escrow feeds
--     garbage keys when IsStudio() reads truthy ("Studio env" path).
--   • game exposes real-shaped identity fields (PlaceId/JobId/CreatorId/…).
--   • PER-OBJECT keys (v1.8.0 fix): every member read yields a fresh object
--     carrying ITS OWN key — a shared "last indexed key" went stale across
--     statements (GetService after IsStudio returned false → "index a
--     boolean" crash) and poisoned whole runs.
local __NILSERVICE = {
  HttpGet = true, HttpPost = true, HttpRequest = true, request = true,
  websocket = true, WebSocket = true, RequestAsync = true,
  GetAsync = true, PostAsync = true, execConsoleCommand = true,
}
local __INERTMT
__INERTMT = {
  __index = function(t, k)
    if __NILSERVICE[k] then return nil end
    local o = setmetatable({}, __INERTMT)
    rawset(o, '__bx_key', k)
    return o
  end,
  __newindex = function() end,
  __call = function(t, ...)
    local k = rawget(t, '__bx_key')
    if type(k) == 'string' then
      if k == 'IsClient' or k == 'IsRobloxClient' or k == 'IsLua' then return true end
      if k:sub(1, 2) == 'Is' or k:sub(1, 2) == 'Has' then return false end
    end
    return setmetatable({}, __INERTMT) -- neutral object for further chaining
  end,
  __add = function() return 0 end, __sub = function() return 0 end, __mul = function() return 0 end,
  __div = function() return 0 end, __mod = function() return 0 end, __pow = function() return 1 end,
  __idiv = function() return 0 end, __band = function() return 0 end, __bor = function() return 0 end,
  __bxor = function() return 0 end, __bnot = function() return -1 end, __shl = function() return 0 end,
  __shr = function() return 0 end, __concat = function() return '' end, __len = function() return 0 end,
  __unm = function() return 0 end,
  -- v2.15.0 (AntiTamper V2): production-shaped tostring — live Roblox renders
  -- instances as their class/key name; a jail-branded string ("BypassXInert")
  -- was a self-scan tell (catalog fp-regex-self).
  __tostring = function(self) local k = rawget(self, '__bx_key') if type(k) == 'string' then return k end return 'Instance' end,
  __eq = function() return false end, __lt = function() return false end, __le = function() return false end,
  -- v2.15.0: live Roblox sets game's __metatable to the string 'The game'
  -- (documented shape); a branded string fingerprinted the jail.
  __metatable = 'The game',
}
local __INERT = setmetatable({}, __INERTMT)
game = setmetatable({}, {
  __index = function(t, k)
    if __NILSERVICE[k] then return nil end
    if k == 'PlaceId' then return 18774239 end
    if k == 'GameId' then return 9947321 end
    if k == 'CreatorId' then return 1 end
    if k == 'JobId' then return 'b1a2c3d4-e5f6-7890-abcd-ef1234567890' end
    if k == 'Workspace' then return __INERT end
    if k == 'Loaded' then return true end
    return __INERT[k]
  end,
  __call = function() return __INERT end,
})
workspace = __INERT
script = __INERT
shared = {}
Enum = __INERT
Instance = { new = function() return __INERT end }
-- v2.8.0 exploit upgrade: YIELDING PRIMITIVES RESOLVE INSTANTLY.
-- Hard-erroring on wait/spawn used to KILL builds whose init yields (MoonSec
-- V2/V3 escrow gates on game.Loaded/wait before decrypting the constant pool)
-- — the jail then captured only pre-decryption garbage. wait() returns 0 and
-- spawn/defer/delay run their function immediately; runaway yield-loops are
-- still bounded by the instruction budget (count hook → partial capture).
task = {
  wait = function() return 0 end,
  spawn = function(f, ...) if type(f) == 'function' then local ok, err = pcall(f, ...) if not ok and _BX_LOG and #_BX_LOG < 200 then _BX_LOG[#_BX_LOG + 1] = 'spawn-error: ' .. tostring(err) end return end end,
  defer = function(f, ...) if type(f) == 'function' then local ok, err = pcall(f, ...) if not ok and _BX_LOG and #_BX_LOG < 200 then _BX_LOG[#_BX_LOG + 1] = 'defer-error: ' .. tostring(err) end return end end,
  delay = function(_, f, ...) if type(f) == 'function' then local ok, err = pcall(f, ...) if not ok and _BX_LOG and #_BX_LOG < 200 then _BX_LOG[#_BX_LOG + 1] = 'delay-error: ' .. tostring(err) end return end end,
  -- v2.12.0 (env-sanity suite / leaked detection 7): task.cancel exists on the
  -- real Luau task library — its absence made task.bindings error mid-init.
  cancel = function() return end,
  synchronize = function() return end,
  desynchronize = function() return end,
}
wait = task.wait
spawn = task.spawn
delay = task.delay
tick = function() __bx_clock = __bx_clock + 0.01; return __bx_clock end
time = function() return math.floor(__bx_clock) end
print = function(...) local t = {} for i = 1, select('#', ...) do t[#t + 1] = tostring(select(i, ...)) end if #_BX_LOG < 200 then _BX_LOG[#_BX_LOG + 1] = table.concat(t, ' ') end end
warn = print

-- v2.12.0 (env-sanity suite / leaked detection 10): Luau's debug.info exists
-- on every executor; fengari's 5.3 debug lib lacks it. A nil-returning shim
-- keeps obfuscator probes alive without leaking a fake line number.
debug.info = function(...) return nil end

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
  __lt = function() return false end, __le = function() return false end, __metatable = 'The game',
})
setmetatable(_G, { __index = function(t, k)
  if __NILPROBE[k] then return nil end
  return __N2
end })
` + PRODUCTION_LUA;
