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
export const MAX_SINK = 60_000;
export const MAX_CHUNKS = 64;
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_CHUNKS_TOTAL = 3 * 1024 * 1024;

export const PRELUDE = `
-- sink
_BX_SINK = {}
_BX_LOG = {}
_BX_CHUNKS = {}
local __N = 0
local __C = 0
function __bx_rec(v)
  -- _BX_MUTE: instrumentation (lift worker serialization/probing) sets this
  -- while building its own strings so jail chatter never pollutes the pool.
  -- rawget — a plain read would hit the polyglot __index and return a
  -- truthy object for this (normally unset) global, muting everything.
  if rawget(_G, '_BX_MUTE') then return end
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
  __tostring = function() return 'BypassXInert' end,
  __eq = function() return false end, __lt = function() return false end, __le = function() return false end,
  __metatable = 'BypassX',
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
