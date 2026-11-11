/**
 * BypassX Deobf Bot — AntiTamper V2 environment hardening.
 *
 * Two Lua layers, composed per run:
 *
 *   PRODUCTION_LUA   appended to the shared jail prelude on EVERY run.
 *                    Production-shape upgrades that are safe for all 16
 *                    supported families (they only REMOVE jail tells — they
 *                    never add executor surface):
 *                      • game's metatable locks (__metatable = 'The game'):
 *                        getmetatable(game) reads exactly like live Roblox and
 *                        setmetatable(game, {}) errors — a succeeding pcall
 *                        was an instant jail tell (catalog env-metatable-locked).
 *                      • hidden internals: pairs(_G) skips _BX_/__bx/_bx_
 *                        instrumentation keys via a __pairs shim (Lua 5.3
 *                        honors it) — self-scan probes find no jail residue.
 *
 *   executorLua(id)  the EXECUTOR MASQUERADE layer, applied only when the
 *                    catalog decides a sample is executor-gated (adaptive
 *                    escalation). Full UNC-shaped executor surface with
 *                    rotate-able identity (Synapse Z / Script-Ware / Krnl):
 *                      identifyexecutor, getexecutorname, checkcaller,
 *                      getgenv/getrenv, getregistry, cloneref,
 *                      compareinstances, islclosure/iscclosure pairs,
 *                      newcclosure, hookfunction/hookmetamethod,
 *                      getrawmetatable, setreadonly/isreadonly, getsenv,
 *                      getcallingscript, getscriptbytecode,
 *                      getloadedmodules, gethui, hidden-property API,
 *                      thread identity, in-memory filesystem, http stubs,
 *                      getgc, Drawing, console/setclipboard no-ops.
 *
 * The layers are pure Lua strings — the workers install them verbatim after
 * the prelude. This module imports nothing from src/ (no cycles).
 */

// Installation-time check for the layer itself: must parse standalone.
export const PRODUCTION_LUA = `
-- ==== AntiTamper V2 — production-shape upgrades (v2.15.0) ===================
-- 1. DataModel metatable lock: live Roblox sets game's __metatable to the
--    string 'The game' (documented easter-egg shape). Any probe reading
--    getmetatable(game) sees the production value; setmetatable(game, {})
--    errors with the exact protected-metatable message instead of succeeding
--    (a succeeding pcall was a jail tell — catalog env-metatable-locked).
do
  local __bx_gmt = debug.getmetatable(game)
  if type(__bx_gmt) == 'table' then
    __bx_gmt.__metatable = 'The game'
  end
end
-- 2. Hidden internals: pairs(_G) must not reveal jail instrumentation keys
--    (_BX_SINK/_BX_LOG/_BX_CHUNKS/_BX_MUTE/_BXCAP). A __pairs shim skips any
--    key prefixed _BX_ / __bx / _bx_ (Lua 5.3 honors __pairs; fengari is 5.3).
--    rawget-based internal access is unaffected — the workers keep working.
do
  local __bx_oldmt = getmetatable(_G)
  local __bx_newmt = {}
  if type(__bx_oldmt) == 'table' then
    for __bx_k, __bx_v in pairs(__bx_oldmt) do __bx_newmt[__bx_k] = __bx_v end
  end
  local function __bx_hidden(k)
    if type(k) ~= 'string' then return false end
    local p = k:sub(1, 4)
    return p == '_BX_' or p == '__bx' or p == '_bx_'
  end
  __bx_newmt.__pairs = function(t)
    local function __bx_iter(_t, k)
      local nk, nv
      while true do
        nk, nv = next(_t, k)
        if nk == nil then return nil, nil end
        if not __bx_hidden(nk) then return nk, nv end
        k = nk
      end
    end
    return __bx_iter, t, nil
  end
  setmetatable(_G, __bx_newmt)
end
-- 3. Sandbox-freeze probes read the env table as writable (production Lua
--    tables are not readonly; catalog misc-env-sandbox-check). No action
--    needed — recorded here as the contract: never install isreadonly in the
--    production profile.
`;

/**
 * Build the executor masquerade layer for one identity.
 * @param {{name:string, version:string, identity:number}} id executor identity
 * @returns {string} Lua source implementing the full executor surface.
 */
export function executorLua(id) {
  const name = String(id.name || 'Synapse Z').replace(/['\\]/g, '');
  const version = String(id.version || 'v2.0.3').replace(/['\\]/g, '');
  const ident = Number.isFinite(+id.identity) ? +id.identity : 8;
  return `
-- ==== AntiTamper V2 — executor masquerade (${name} ${version}) ================
-- Installed ONLY on escalation (catalog: executor-gated sample). Provides the
-- UNC-shaped executor surface with behavior-level implementations of the
-- functions anti-tamper actually calls. Production-shape keys (NILPROBE) are
-- overridden by real assignments — rawset bypasses the polyglot __index.
do
  local __bx_cc = setmetatable({}, { __mode = 'k' })   -- newcclosure registry
  local __bx_nc = nil                                  -- last namecall method
  local __bx_fs = {}                                   -- in-memory filesystem
  local __bx_queue = {}                                -- queue_on_teleport
  local __bx_reg = nil

  -- identity ----------------------------------------------------------------
  identifyexecutor = function()
    return '${name} ${version}'
  end
  getexecutorname = function()
    return '${name}', '${version}'
  end
  getthreadidentity = function() return ${ident} end
  setthreadidentity = function() end
  checkcaller = function() return true end

  -- env tables (distinct, like real executors) --------------------------------
  getgenv = function() return _G end
  local __bx_renv = setmetatable({}, { __index = _G, __metatable = 'locked' })
  getrenv = function() return __bx_renv end
  __bx_reg = { [_G] = _G }
  getregistry = function()
    local t = { _G = _G, script = script, game = game }
    return t
  end
  getreg = getregistry

  -- references ----------------------------------------------------------------
  cloneref = function(ref)
    if type(ref) ~= 'table' and type(ref) ~= 'userdata' then return ref end
    local proxy = setmetatable({}, {
      __index = function(_, k) local v = ref[k] return v end,
      __newindex = function(_, k, v) ref[k] = v end,
      __call = function(_, ...) return ref(...) end,
      __tostring = function() return tostring(ref) end,
      __eq = function() return false end,
      __metatable = 'The game',
    })
    return proxy
  end
  compareinstances = function(a, b) return a == b end
  gethui = function() return Instance.new('Folder') end
  gethiddenproperty = function(obj, prop)
    return rawget(obj, prop), true
  end
  sethiddenproperty = function() return false end

  -- closure classification (weak-registry: no proxies, type() stays honest) ---
  iscclosure = function(f)
    if type(f) ~= 'function' then return false end
    if __bx_cc[f] then return true end
    local ok, info = pcall(debug.getinfo, f, 'S')
    if ok and info and info.what == 'C' then return true end
    return false
  end
  checkclosure = iscclosure
  islclosure = function(f)
    if type(f) ~= 'function' then return false end
    if __bx_cc[f] then return false end
    local ok, info = pcall(debug.getinfo, f, 'S')
    if ok and info and info.what == 'Lua' then return true end
    return false
  end
  isLclosure = islclosure
  is_l_closure = islclosure
  isexecutorclosure = function(f) return type(f) == 'function' end
  is_executor_closure = isexecutorclosure
  newcclosure = function(f)
    if type(f) ~= 'function' then error("bad argument #1 to 'newcclosure' (function expected)", 2) end
    -- real executors return a DISTINCT C-wrapped closure: iscclosure(wrapped)
    -- is true while the original stays an L-closure. A wrapper + weak-registry
    -- marker reproduces both semantics (identity differs, behavior forwards).
    local w = function(...) return f(...) end
    __bx_cc[w] = true
    return w
  end
  clonefunction = function(f)
    if type(f) ~= 'function' then error("bad argument #1 to 'clonefunction' (function expected)", 2) end
    -- behavior-identical callable with independent closure identity
    return function(...) return f(...) end
  end

  -- hooks (globals + metamethod fields — the two shapes antitamper uses) ------
  hookfunction = function(target, hook)
    if type(target) ~= 'function' or type(hook) ~= 'function' then
      error("bad argument (function expected)", 2)
    end
    -- global function swap: find the global bound to this exact function
    for k, v in next, _G do
      if v == target then
        _G[k] = hook
        return target
      end
    end
    -- non-global target: return original (call sites keep working)
    return target
  end
  replaceclosure = hookfunction
  getrawmetatable = function(obj) return debug.getmetatable(obj) end
  setreadonly = function() return true end
  isreadonly = function(obj)
    if type(obj) ~= 'table' then return false end
    local mt = debug.getmetatable(obj)
    return type(mt) == 'table' and mt.__metatable ~= nil
  end
  hookmetamethod = function(obj, metamethod, hook)
    if type(obj) ~= 'table' then error("bad argument #1 to 'hookmetamethod' (table expected)", 2) end
    local mt = debug.getmetatable(obj)
    if type(mt) ~= 'table' then error('metatable not found', 2) end
    local old = rawget(mt, metamethod)
    rawset(mt, metamethod, hook)
    return old
  end
  getnamecallmethod = function() return __bx_nc end

  -- script identity ------------------------------------------------------------
  getsenv = function(s)
    return setmetatable({}, { __index = _G })
  end
  getcallingscript = function() return script end
  getscriptbytecode = function()
    return '\\x4C\\x75\\x61\\x75\\x01\\x00\\x00\\x00\\x42\\x59\\x50\\x41\\x53\\x53\\x58\\x02'
  end
  getscriptclosure = function(s) return function() end end
  getloadedmodules = function() return { script } end
  getconnections = function() return {} end
  firesignal = function() end

  -- debug introspection (real where fengari gives it to us) ---------------------
  getupvalue = debug.getupvalue
  getupvalues = function(f)
    local t = {}
    local i = 1
    while true do
      local ok, name, v = pcall(debug.getupvalue, f, i)
      if not ok or not name then break end
      t[i] = v
      i = i + 1
    end
    return t
  end
  setupvalue = debug.setupvalue
  setupvaluename = function() return true end
  getconstants = function() return {} end
  getconstant = function() return nil end
  getprotos = function() return {} end
  getstack = function() return {} end
  getgc = function()
    return { checkcaller, newcclosure, identifyexecutor, hookfunction, game, script, string, math, table, task }
  end

  -- filesystem (in-memory; executor workspace semantics) ------------------------
  writefile = function(p, c)
    if type(p) ~= 'string' then error("bad argument #1 to 'writefile' (string expected)", 2) end
    __bx_fs[p] = tostring(c or '')
  end
  appendfile = function(p, c)
    if type(p) ~= 'string' then error("bad argument #1 to 'appendfile' (string expected)", 2) end
    __bx_fs[p] = (__bx_fs[p] or '') .. tostring(c or '')
  end
  readfile = function(p)
    if type(p) ~= 'string' then error("bad argument #1 to 'readfile' (string expected)", 2) end
    if __bx_fs[p] ~= nil then return __bx_fs[p] end
    error('File does not exist', 2)
  end
  isfile = function(p) return type(p) == 'string' and __bx_fs[p] ~= nil end
  delfile = function(p) __bx_fs[p] = nil end
  isfolder = function() return false end
  makefolder = function() end
  delfolder = function() end
  listdir = function() return {} end
  israwfile = isfile

  -- misc executor surface ---------------------------------------------------------
  setclipboard = function() end
  toclipboard = setclipboard
  setfpscap = function() end
  queue_on_teleport = function(c) __bx_queue[#__bx_queue + 1] = tostring(c or '') end
  fireclickdetector = function() end
  firetouchinterest = function() end
  fireproximityprompt = function() end
  messagebox = function() end
  rconsoleprint = function() end
  rconsoleinfo = function() end
  rconsolewarn = function() end
  rconsoleerr = function() end
  rconsoleclear = function() end
  rconsolename = function() end
  printconsole = function() end

  -- http (failure-shaped; nothing leaves the jail) ---------------------------------
  local __bx_httpresp = { Success = false, StatusCode = 0, Headers = {}, Body = '', FinalUrl = '' }
  request = function() return __bx_httpresp end
  http_request = request
  syn = { request = request, protect_gui = function() end, unprotect_gui = function() end }

  -- Drawing (inert shapes) ----------------------------------------------------------
  Drawing = {
    Fonts = { UI = 0, System = 1, Plex = 2, Monospace = 3 },
    new = function()
      return setmetatable({}, {
        __index = function() return 0 end,
        __newindex = function() end,
        __tostring = function() return 'Drawing' end,
      })
    end,
  }
end
`;
}

/**
 * Compose the hardening layer set for a profile.
 * @param {string} profile 'production' | executor identity key
 * @returns {{lua: string, features: string[]}}
 */
export function harden(profile = 'production') {
  if (profile === 'production') {
    return { lua: PRODUCTION_LUA, features: ['game-mt-lock', 'hidden-globals', 'production-shape'] };
  }
  return { lua: executorLua(profile), features: ['executor-masquerade', String(profile && profile.name ? profile.name : 'identity')] };
}

/**
 * Full escalation ladder Lua — one layer per identity, pre-rendered so the
 * workers do not import this module (they install strings verbatim).
 * @param {Array<{key,name,version,identity}>} identities from catalog
 * @returns {Array<{key:string, lua:string}>}
 */
export function executorLadder(identities) {
  return (identities || []).map((id) => ({ key: id.key, lua: executorLua(id) }));
}
