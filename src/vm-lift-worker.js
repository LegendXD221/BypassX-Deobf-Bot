/**
 * BypassX Deobf Bot — VM lifter worker (jailed fengari, "lifting run").
 *
 * For VM-obfuscated builds (Luraph v15.x if-chain VMs, MoonSec V2/V3 escrow
 * table-dispatch VMs, IronBrew/PSU/77f-style row VMs) the obfuscator's own
 * interpreter executes the real program from a decoded in-memory state:
 * an instruction table, a constant pool and a register stack. That state IS
 * the whole program — capture it and the bytecode is lifted.
 *
 * The public deobfuscator playbook, implemented inside our existing jail:
 *   1. STATE CAPTURE — a count hook walks the live call stack
 *      (debug.getinfo + debug.getlocal, read-only) hunting the dispatcher
 *      frame: a table-of-records + a scalar constant pool. The full state is
 *      deep-serialized the moment the VM is sighted. Row-record validation
 *      (uniform arity + repeated opcodes) rejects string-pool byte tables.
 *   2. OPCODE PROBING (behavioral, per build — no signature tables): the
 *      REAL instruction table is MUTATED IN PLACE — probe records are
 *      written at the dispatcher's current pc, so the VM's own loop
 *      executes them next. The real STACK/CONSTS tables get logging
 *      METATABLES attached (metatable, not frame swap — fengari's
 *      debug.setlocal is unreliable on deep frames): every slot read/write
 *      is logged with its index, missing slots resolve to per-slot identity
 *      mocks so handlers never crash on sentinel types. Globals route
 *      through the instrumented _G metatable with REAL names.
 *   3. vm-lift.js classifies each opcode from its effect signature and
 *      transpiles the real instruction stream into readable Lua.
 *
 * Run strategy: run 1 = plain harvest (chunks + strings; identical to
 * harvester-worker). Only when run 1 captured NO load()-chunk (i.e. no
 * complete recovery) do we spend run 2 — a fresh state with capture/probe
 * instrumentation. Probing never starves the guest's lazy decryption.
 *
 * stdout: ONE JSON line { ok, ran, runError, strings[], chunks[], log[],
 *                         lift: {snap, probes, dbg, ended} | null, ... }
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
import * as jail from './jail-prelude.js';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const INPUT = process.argv[2];
const BUDGET_TOTAL = Number(process.env.BX_BUDGET) || 260e6;
const HOOK_INTERVAL = 2.5e6;
const LIFT_BUDGET = Math.floor(BUDGET_TOTAL * 0.45); // in-hook budget for run 2
const TIME_WALL_MS = 100_000;

if (!INPUT) {
  console.error('usage: vm-lift-worker <input>');
  process.exit(2);
}

let code;
try {
  code = fs.readFileSync(INPUT, 'utf8');
} catch (e) {
  writeOut({ ok: false, error: `read failed: ${e.message}` });
  process.exit(0);
}

const t0 = Date.now();

/** Forgiving-stack transform (retry tier): numeric reads on `local x={}`
 *  default to 0 so dispatchers reading unwritten registers keep running. */
function forgivingStack(src) {
  return src.replace(
    /local ([A-Za-z_][A-Za-z0-9_]*)=\{\};/g,
    (m, v) => `local ${v}=setmetatable({},{__index=function(t,k) if type(k)=='number' then return 0 end end});`,
  );
}

// ---- lift instrumentation (Lua, run 2 only) -----------------------------------
// pcall-guarded everywhere: instrumentation must never kill the run early.
// NOTE: this is a JS template literal — `\\` here becomes `\` in Lua source.
const LIFT_LUA = `
_BX_LIFT_JSON = nil
do
  -- forward declarations (scope discipline: every local named here once)
  local __CUR = 0        -- opid currently executing (0 = guest / terminator)
  local __SNAP = nil
  local __PROBED = false
  local __ENDED = 'ran'
  local __GLOG = {}
  local __GCNT = 0
  local __SCANERR = 0
  local __HALF_LOGS = 0
  local __PROBE_TICK = -1
  local __DBG = {}
  local __DBGN = 0
  local __TICKS = 0
  local ev               -- forward (used by the _G wrapper below)
  local dbg

  local function __typ(v)
    local t = type(v)
    if t == 'string' then return 's' elseif t == 'number' then return 'n'
    elseif t == 'table' then return 't' elseif t == 'function' then return 'f'
    elseif t == 'boolean' then return 'b' end
    return '0'
  end

  -- ---- JSON serializer (byte-safe, capped) ------------------------------------
  -- _BX_MUTE: the prelude's string sinks record everything produced by the
  -- wrapped string APIs; mute (save/restore, composes under recursion) while
  -- instrumentation builds its own strings. Byte-loop escaping.
  local function jsq(s)
    local wasMuted = rawget(_G, '_BX_MUTE')
    rawset(_G, '_BX_MUTE', true)
    if #s > 4096 then s = s:sub(1, 4096) end
    local esc = ''
    for i = 1, #s do
      local b = string.byte(s, i)
      if b == 34 then esc = esc .. '\\\\"'
      elseif b == 92 then esc = esc .. '\\\\\\\\'
      elseif b >= 32 and b <= 126 then esc = esc .. string.char(b)
      else esc = esc .. string.format('\\\\u%04x', b) end
    end
    rawset(_G, '_BX_MUTE', wasMuted)
    return '"' .. esc .. '"'
  end

  local __bx_ser_body
  local __SEEN
  local function ser(v, depth)
    local wasMuted = rawget(_G, '_BX_MUTE')
    rawset(_G, '_BX_MUTE', true)
    local ok, r = pcall(__bx_ser_body, v, depth)
    rawset(_G, '_BX_MUTE', wasMuted)
    if ok then return r end
    return 'null'
  end

  local function serBody(v, depth)
    local t = type(v)
    if t == 'nil' then return 'null'
    elseif t == 'boolean' then return v and 'true' or 'false'
    elseif t == 'number' then
      if v ~= v then return 'null' end
      if v == math.floor(v) and math.abs(v) < 9007199254740991 then return string.format('%d', v) end
      return string.format('%.14g', v)
    elseif t == 'string' then return jsq(v)
    elseif t == 'table' then
      if depth >= 7 then return '"D"' end
      if __SEEN[v] then return '"C"' end
      __SEEN[v] = true
      local hasStrKey = false
      for k in pairs(v) do
        if type(k) == 'string' then hasStrKey = true break end
      end
      local parts = {}
      if hasStrKey then
        local hk = 0
        for k, vv in pairs(v) do
          hk = hk + 1
          if hk > 512 then break end
          parts[#parts + 1] = jsq(tostring(k)) .. ':' .. ser(vv, depth + 1)
        end
        return '{' .. table.concat(parts, ',') .. '}'
      end
      local n = math.min(#v, 3072)
      for i = 1, n do parts[#parts + 1] = ser(v[i], depth + 1) end
      return '[' .. table.concat(parts, ',') .. ']'
    elseif t == 'function' then return '"F"'
    end
    return 'null'
  end
  __bx_ser_body = serBody

  dbg = function(s)
    if __DBGN < 220 then
      __DBGN = __DBGN + 1
      __DBG[__DBGN] = jsq('t' .. __TICKS .. ' ' .. s)
    end
  end

  ev = function(s)
    if __CUR > 0 and __EVCOUNT > 0 then
      local cur = __EVIDX[__CUR] and __EV[__EVIDX[__CUR]] or nil
      if cur and #cur.ev < 4000 then
        cur.ev[#cur.ev + 1] = jsq(s)
      end
    end
  end

  -- probe state (declared before the _G wrapper uses them)
  local __EV = {}       -- probe effects: array of { op = opid, ev = {…} }
  local __EVIDX = {}    -- opid -> index in __EV
  __EVCOUNT = 0

  -- direct event append used by ALL probe metamethods (no indirection)
  local function evd(s)
    if __CUR > 0 then
      local cur = __EVIDX[__CUR] and __EV[__EVIDX[__CUR]] or nil
      if cur and #cur.ev < 4000 then cur.ev[#cur.ev + 1] = jsq(s) end
    end
  end
  -- ---- instrumented _G: probe-phase global events with REAL names ---------------
  -- Minimal + re-entrancy guarded: evd -> jsq -> string ops never touch _G,
  -- so the wrapper cannot recurse through itself. GR/GW events carry the
  -- actual global name the handler tried to resolve.
  do
    local mt = getmetatable(_G) or {}
    local oldidx = mt.__index
    local __INEV = false
    mt.__index = function(t, k)
      local v = oldidx and oldidx(t, k) or nil
      if __CUR > 0 and not __INEV then
        __INEV = true
        evd('GR:' .. tostring(k))
        __INEV = false
      end
      return v
    end
    mt.__newindex = function(t, k, v)
      rawset(t, k, v)
      if __CUR > 0 and not __INEV then
        __INEV = true
        evd('GW:' .. tostring(k) .. ':' .. __typ(v))
        __INEV = false
      end
    end
    setmetatable(_G, mt)
  end

  -- ---- per-slot identity mocks --------------------------------------------------
  -- Every MISSING stack/const slot read logs the slot index (SR<k>/CR<k>) and
  -- returns a mock tagged with that slot; its metamethods log exactly how the
  -- handler used the value (TR<k>:key, CALLR<k>:n, AR<k>:op, CMP<k>:kind).
  -- PRESENT slots return their real values (real consts = real global names).
  local __NEUTRAL
  local __SLOTCACHE = {}
  local function slotMock(k)
    local m = __SLOTCACHE[k]
    if m then return m end
    m = setmetatable({}, {
      __index = function(t, kk) evd('TR' .. k .. ':' .. tostring(kk)) return __NEUTRAL end,
      __newindex = function(t, kk, v) evd('TW' .. k .. ':' .. tostring(kk) .. ':' .. __typ(v)) end,
      __call = function(t, ...) evd('CALLR' .. k .. ':' .. select('#', ...)) return __NEUTRAL, __NEUTRAL end,
      __add = function() evd('AR' .. k .. ':add') return __NEUTRAL end,
      __sub = function() evd('AR' .. k .. ':sub') return __NEUTRAL end,
      __mul = function() evd('AR' .. k .. ':mul') return __NEUTRAL end,
      __div = function() evd('AR' .. k .. ':div') return __NEUTRAL end,
      __mod = function() evd('AR' .. k .. ':mod') return __NEUTRAL end,
      __pow = function() evd('AR' .. k .. ':pow') return __NEUTRAL end,
      __idiv = function() evd('AR' .. k .. ':idiv') return __NEUTRAL end,
      __band = function() evd('AR' .. k .. ':band') return __NEUTRAL end,
      __bor = function() evd('AR' .. k .. ':bor') return __NEUTRAL end,
      __bxor = function() evd('AR' .. k .. ':bxor') return __NEUTRAL end,
      __bnot = function() evd('AR' .. k .. ':bnot') return __NEUTRAL end,
      __shl = function() evd('AR' .. k .. ':shl') return __NEUTRAL end,
      __shr = function() evd('AR' .. k .. ':shr') return __NEUTRAL end,
      __unm = function() evd('AR' .. k .. ':unm') return __NEUTRAL end,
      __concat = function() evd('AR' .. k .. ':concat') return 'X' end,
      __len = function() evd('LEN' .. k) return 1 end,
      __eq = function() evd('CMP' .. k .. ':eq') return false end,
      __lt = function() evd('CMP' .. k .. ':lt') return false end,
      __le = function() evd('CMP' .. k .. ':le') return false end,
      __tostring = function() return 'V' .. k end,
      __metatable = 'BX',
    })
    __SLOTCACHE[k] = m
    return m
  end
  __NEUTRAL = slotMock('?')

  local STACKLOGMT = {
    -- FULLY VIRTUALIZED: reads always return per-slot identity mocks (never
    -- real values — probe records must not interact through leftover guest
    -- state), writes are logged and swallowed. Constants stay REAL so
    -- GETGLOBAL/SETGLOBAL probes carry the actual global names.
    __index = function(t, k)
      if type(k) ~= 'number' then return nil end
      evd('SR' .. k)
      return slotMock('r' .. k)
    end,
    __newindex = function(t, k, v)
      if type(k) == 'number' then evd('SW' .. k .. ':' .. __typ(v)) end
      -- swallow: probe state never lands in the guest stack
    end,
  }
  local CONSTLOGMT = {
    __index = function(t, k)
      if type(k) ~= 'number' then return nil end
      evd('CR' .. k)
      local v = rawget(t, k)
      if v ~= nil then return v end
      return slotMock('c' .. k)
    end,
    __newindex = function(t, k, v)
      if type(k) == 'number' then evd('CW' .. k .. ':' .. __typ(v)) end
      rawset(t, k, v)
    end,
  }

  -- ---- dispatcher frame scan (READ-ONLY debug API) --------------------------------
  local function tableShape(t)
    local nstr, nnum, nfun, ntot = 0, 0, 0, 0
    for k, v in pairs(t) do
      ntot = ntot + 1
      if ntot > 64 then break end
      if type(k) == 'string' then nstr = nstr + 1 end
      if type(k) == 'number' then nnum = nnum + 1 end
      if type(v) == 'function' then nfun = nfun + 1 end
    end
    return nstr, nnum, nfun, ntot
  end

  local function isAllFunctions(t)
    for _, v in pairs(t) do if type(v) ~= 'function' then return false end end
    return true
  end

  -- Strict row-record validation: real VM instruction streams have uniform
  -- record arity and REPEATED op codes; byte-array string pools (decryption
  -- inputs) have ragged rows of arbitrary bytes and near-unique first bytes.
  local function rowsLooksLikeInstrs(t)
    local rows = #t
    if rows < 6 then return false end
    local lenMin, lenMax = 99, 0
    local ops = {}
    for i = 1, math.min(rows, 256) do
      local r = t[i]
      if type(r) ~= 'table' then return false end
      local rl = #r
      if rl < 1 or rl > 8 then return false end
      if rl < lenMin then lenMin = rl end
      if rl > lenMax then lenMax = rl end
      if lenMax - lenMin > 1 then return false end -- early-exit: ragged arity
      local o = r[1]
      if type(o) ~= 'number' or o ~= o or o < 0 or o > 1023 then return false end
      ops[o] = true
    end
    local distinct = 0
    for _ in pairs(ops) do distinct = distinct + 1 end
    return distinct <= math.max(4, math.floor(rows * 0.8))
  end

  local function scanOneLevel(level)
    local instrs, constsRef, stackRef, pcIdx, pcObjIdx, pcObjField, pcObj = nil, nil, nil, nil, nil, nil, nil
    local i = 1
    while i <= 40 do
      local n, v = debug.getlocal(level, i)
      if not n then break end
      if type(v) == 'table' then
        local ln = #v
        local v1 = v[1]
        if type(v1) == 'table' and not instrs then
          local f1 = #v1
          if ln >= 6 and f1 >= 1 and f1 <= 8 and rowsLooksLikeInstrs(v) then
            instrs = { ref = v, idx = i, mode = 'rows' }
          end
        elseif (type(v1) == 'string' or type(v1) == 'number' or type(v1) == 'boolean') and ln >= 3 then
          if not constsRef and not isAllFunctions(v) then
            local scalars, total = 0, 0
            for _, vv in pairs(v) do
              total = total + 1
              local tt = type(vv)
              if tt == 'string' or tt == 'number' or tt == 'boolean' then scalars = scalars + 1 end
            end
            if total > 0 and scalars * 10 >= total * 6 then constsRef = v end
          end
        else
          local ns, nn, nf, nt = tableShape(v)
          if nf >= 1 and nf == nt then
            -- handler dispatch table — leave real, never touch
          else
            -- pc-object probe: small table holding ONE numeric field under
            -- ANY key type ({n=4} is the common shape — string keys happen).
            -- Only claims the table when a numeric field is actually found;
            -- otherwise the table falls through to the stack candidate.
            local claimed = false
            if not pcObjIdx and nt >= 1 and nt <= 4 then
              local fname, fval, nfields = nil, nil, 0
              for k, vv in pairs(v) do
                nfields = nfields + 1
                if type(vv) == 'number' and (fval == nil or vv < fval) then fname, fval = k, vv end
              end
              if fname and fval and fval >= 1 and fval <= 4096 and nfields == nt then
                pcObjIdx, pcObjField, pcObj = i, fname, v
                claimed = true
              end
            end
            if not claimed and ln <= 32 and getmetatable(v) == nil and v ~= instrs.ref then
              -- register stack candidate: prefer small tables (real stacks
              -- are mostly empty at sighting; byte pools are large)
              if type(v[1]) == 'table' and ln >= 6 then
                -- table-of-tables: decryption byte pool, not a stack
              elseif not stackRef or ln < #stackRef then
                stackRef = v
              end
            end
          end
        end
      elseif type(v) == 'number' and instrs and v >= 1 and v <= 4096 then
        if not pcIdx then pcIdx = i end
      end
      i = i + 1
    end
    if stackRef == constsRef then stackRef = nil end
    -- MATCH GATE: the register stack must be sighted — otherwise the match
    -- landed in the pre-loop setup window where probing would run against
    -- leftover/raw state (stackRef nil → unswallowed writes → contamination).
    if instrs and constsRef and stackRef then
      do
        local acc = ''
        local i2 = 1
        while i2 <= 16 do
          local n2, v2 = debug.getlocal(level, i2)
          if not n2 then break end
          acc = acc .. ' ' .. tostring(n2) .. ':' .. type(v2)
          if type(v2) == 'table' then acc = acc .. '#' .. #v2 end
          if type(v2) == 'number' then acc = acc .. '=' .. tostring(v2) end
          i2 = i2 + 1
        end
        dbg('MATCHFRAME' .. acc)
      end
      -- capture the CURRENT pc HERE (debug.getlocal is caller-relative — the
      -- same level reads a different frame from installProbes)
      local base = 1
      if pcIdx then
        local pn, pv = debug.getlocal(level, pcIdx)
        if type(pv) == 'number' and pv >= 1 then base = pv end
      end
      if pcObj then
        local fv = rawget(pcObj, pcObjField)
        if type(fv) == 'number' and fv >= 1 then base = fv end
      end
      return {
        instrs = instrs, constsRef = constsRef, stackRef = stackRef,
        base = base,
      }
    end
    if instrs and __HALF_LOGS < 4 then
      __HALF_LOGS = __HALF_LOGS + 1
      _BX_LOG[#_BX_LOG + 1] = 'BXDBG instrs-no-consts L' .. level .. ' rows=' .. #instrs.ref
    end
    return nil
  end

  local function collectOpids(ref)
    local seen, out = {}, {}
    for i = 1, math.min(#ref, 4096) do
      local r = ref[i]
      if type(r) == 'table' and type(r[1]) == 'number' and not seen[r[1]] then
        seen[r[1]] = true
        out[#out + 1] = r[1]
        if #out >= 48 then break end
      end
    end
    if #out == 0 then
      for op = 1, 40 do out[#out + 1] = op end
    end
    return out
  end

  -- ---- probe install: metatable-driven (NO frame writes) ---------------------------
  -- The REAL instruction table gets a metatable; the probe window is nilled so
  -- every dispatch read INSTRS[pc] fires __index: it tags the current opcode,
  -- logs the pc, and serves the synthetic record. Real STACK/CONSTS tables get
  -- logging metatables. The VM's own loop executes everything.
  local function installProbes(f)
    local instrRef = f.instrs.ref
    if getmetatable(instrRef) ~= nil then return nil, 'instrs has metatable' end
    local opids = collectOpids(instrRef)
    do
      local tailored = rawget(_G, '_BX_PROBE_OPS')
      if type(tailored) == 'table' and #tailored > 0 then
        local valid = {}
        for _, op in ipairs(tailored) do
          if type(op) == 'number' then valid[#valid + 1] = op end
        end
        if #valid > 0 then opids = valid end
      end
    end
    for _, op in ipairs(opids) do
      if not __EVIDX[op] then
        __EV[#__EV + 1] = { op = op, ev = {} }
        __EVIDX[op] = #__EV
      end
    end
    __EVCOUNT = #__EV
    -- probe records: ALL opids at arity 2 first, then ALL at arity 3, then
    -- unknown-op terminators. A mid-program RETURN-style exit still leaves
    -- every opid probed once (arity 3 may be truncated for late opids).
    local recs, tags = {}, {}
    for _, op in ipairs(opids) do
      recs[#recs + 1] = { op, 1, 2 }; tags[#tags + 1] = op
    end
    for _, op in ipairs(opids) do
      recs[#recs + 1] = { op, 1, 2, 3 }; tags[#tags + 1] = op
    end
    for _ = 1, 4 do recs[#recs + 1] = { 0, 0, 0 }; tags[#tags + 1] = 0 end
    local P = #recs
    -- current pc (captured inside the scan where getlocal is frame-correct)
    local base = f.base or 1
    -- the serving window: base .. base+P-1 -> probe records; beyond -> nil
    for k, v in pairs(instrRef) do
      if type(k) == 'number' and k >= base then instrRef[k] = nil end
    end
    local mt
    mt = {
      __index = function(t, k)
        if type(k) ~= 'number' then return nil end
        -- the in-flight dispatch already consumed the record at k=base raw;
        -- serve the probe program starting at the NEXT read (base+1)
        local i = k - base
        if i >= 1 and i <= P then
          local tag = tags[i] or 0
          if __EVIDX[tag] then __CUR = tag end
          local cur = __EVIDX[tag] and __EV[__EVIDX[tag]] or nil
          if cur then cur.ev[#cur.ev + 1] = jsq('PC' .. k) end
          return recs[i]
        end
        __CUR = 0
        return nil -- VM loop breaks cleanly on nil record
      end,
    }
    local okM, errM = pcall(setmetatable, instrRef, mt)
    if not okM then return nil, 'mt: ' .. tostring(errM) end
    -- logging metatables on the REAL stack/consts (never on _G-like tables)
    local constsMT, stackMT = false, false
    if f.constsRef and getmetatable(f.constsRef) == nil then
      local okC = pcall(setmetatable, f.constsRef, CONSTLOGMT)
      constsMT = okC == true
    end
    if f.stackRef and getmetatable(f.stackRef) == nil then
      local okS, errS = pcall(setmetatable, f.stackRef, STACKLOGMT)
      stackMT = okS == true
      if not okS then dbg('stackMT err: ' .. tostring(errS)) end
    elseif f.stackRef then
      dbg('stackRef has mt already: ' .. tostring(getmetatable(f.stackRef)))
    else
      dbg('stackRef is nil')
    end
    -- Lua metamethods fire ONLY for missing keys: existing stack/const slots
    -- would bypass the MTs silently (raw hits) and let probe records
    -- interact with leftover guest state (string-calls, nil arith). The
    -- real values are ALREADY captured in the snapshot — clear both tables
    -- so every probe read/write is intercepted.
    if constsMT then
      for k in pairs(f.constsRef) do rawset(f.constsRef, k, nil) end
    end
    if stackMT then
      for k in pairs(f.stackRef) do rawset(f.stackRef, k, nil) end
    end
    do
      local acc = ''
      if f.stackRef then
        local c = 0
        for k, vv in pairs(f.stackRef) do c = c + 1; if c <= 3 then acc = acc .. ' S' .. tostring(k) .. '=' .. type(vv) end end
        acc = acc .. ' (#S=' .. c .. ')'
      end
      if f.constsRef then
        local c2 = 0
        for k, vv in pairs(f.constsRef) do c2 = c2 + 1; if c2 <= 3 then acc = acc .. ' C' .. tostring(k) .. '=' .. type(vv) end end
        acc = acc .. ' (#C=' .. c2 .. ')'
      end
      dbg('installed base=' .. base .. ' P=' .. P .. ' constsMT=' .. tostring(constsMT) .. ' stackMT=' .. tostring(stackMT) .. acc)
    end
    return P, base
  end

  local __SCANNING = false
  local function scanAndProbeInner()
    rawset(_G, '_BX_MUTE', true)
    for level = 2, 12 do
      if not debug.getinfo(level, 'f') then break end
      local f = scanOneLevel(level)

      if f then
        dbg('match L' .. level)
        do
          local acc = ''
          local i2 = 1
          while i2 <= 16 do
            local n2, v2 = debug.getlocal(level, i2)
            if not n2 then break end
            acc = acc .. ' ' .. tostring(n2) .. ':' .. type(v2)
            if type(v2) == 'table' then acc = acc .. '#' .. #v2 end
            if type(v2) == 'number' then acc = acc .. '=' .. tostring(v2) end
            i2 = i2 + 1
          end
          dbg('frame' .. acc)
        end
        -- 1. snapshot BEFORE touching anything
        __SEEN = {}
        local instrSer = ser(f.instrs.ref, 0)
        __SEEN = {}
        local constSer = ser(f.constsRef, 0)
        local opids = collectOpids(f.instrs.ref)
        __SNAP = string.format(
          '{"mode":%s,"rows":%d,"opids":[%s],"instrs":%s,"consts":%s,"level":%d}',
          jsq(f.instrs.mode), #f.instrs.ref,
          table.concat(opids, ','), instrSer, constSer, level)
        -- 2. metatable-driven probe install (no frame writes)
        local okP, infoP = pcall(installProbes, f)
        __PROBED = okP == true and infoP ~= nil
        dbg('probe ok=' .. tostring(__PROBED) .. ' info=' .. tostring(infoP))
        __PROBE_TICK = __TICKS
        break
      end
    end
    rawset(_G, '_BX_MUTE', nil)
  end

  local function scanAndProbe()
    -- re-entrancy guard: the hook fires every 50 instructions, including
    -- DURING a scan (serialization is thousands of instructions); a nested
    -- scan would see shifted frames and double-probe.
    if __PROBED or __SCANNING then return end
    __SCANNING = true
    local ok, e1 = pcall(scanAndProbeInner)
    __SCANNING = false
    rawset(_G, '_BX_MUTE', nil)
    if not ok and __SCANERR < 6 then
      __SCANERR = __SCANERR + 1
      _BX_LOG[#_BX_LOG + 1] = 'BXDBG scanerr ' .. tostring(e1):sub(1, 160)
    end
  end

  -- The lift hook doubles as the run-2 budget (installing it replaced the
  -- C-API budget hook). Interval 150 (tuned): the probe scanner fires every 150 instructions — a coarse interval can phase-shift past
  -- the whole dispatch loop (prelude-length-dependent) and probes install
  -- after the loop already exited. 50 guarantees ≥1 sighting inside any
  -- realistic dispatch loop, independent of prelude size.
  debug.sethook(function()
    __TICKS = __TICKS + 1
    __BUD = __BUD - 150
    if __BUD <= 0 then error('bx: instruction budget exceeded', 0) end
    if not __PROBED then
      scanAndProbe()
      if __PROBED then __ENDED = 'probe-installed' end
    else
      local dt = __TICKS - __PROBE_TICK
      if dt >= 0 and dt <= 6 then
        local cur = __CUR > 0 and __EVIDX[__CUR] and __EV[__EVIDX[__CUR]] or nil
        dbg('probetick +' .. dt .. ' cur=' .. __CUR .. ' ev=' .. (cur and #cur.ev or -1))
      end
    end
  end, '', 150)

  -- ---- dump (called by the runner after pcall, and on budget unwind) -----------
  -- v2.11.0 probe-rerun gate: exposes whether the probe program installed but
  -- recorded ZERO effect events — the signature of a dispatch loop that
  -- exited between two hook ticks (phase shift; tiny VMs). The runner then
  -- re-executes the guest: each attempt re-enters the loop at a different
  -- tick phase, so within a handful of attempts the probes land mid-loop.
  -- Heavy VMs always have events on attempt 1 and never re-run.
  local function __bx_ev_total()
    local n = 0
    for _, e in ipairs(__EV) do n = n + #e.ev end
    return n
  end
  rawset(_G, '__bx_lift_wants_rerun', function()
    return __PROBED and __bx_ev_total() == 0 and __SNAP ~= nil
  end)
  -- re-arm the scanner for a probe-rerun attempt: the guest rebuilds its
  -- STACK/CONSTS/INSTRS tables every execution, so attempt N's fresh tables
  -- need a fresh scan+install (the old metatables point at run-1's dead
  -- tables). __EV/__EVIDX persist so events from any attempt accumulate
  -- under the same opids. __SNAP is KEPT: a rerun's rescan may fail to match
  -- (phase), and losing attempt-1's state snapshot would strip the
  -- state-devirt stage downstream (luraph14 pipeline). A successful rescan
  -- simply overwrites it with an equally-good fresh snapshot.
  rawset(_G, '__bx_lift_reset_for_rerun', function()
    __PROBED = false
    __SCANNING = false
  end)

  function __bx_lift_dump(endedNote)
    dbg('dump probed=' .. tostring(__PROBED) .. ' ended=' .. tostring(endedNote))
    if type(endedNote) == 'string' then __ENDED = endedNote end
    if __SNAP then
      local wasMuted = rawget(_G, '_BX_MUTE')
      rawset(_G, '_BX_MUTE', true)
      local evParts = {}
      for _, e in ipairs(__EV) do
        evParts[#evParts + 1] = '{"op":' .. tostring(e.op) .. ',"ev":[' .. table.concat(e.ev, ',') .. ']}'
      end
      _BX_LIFT_JSON = '{"snap":' .. (__SNAP or 'null')
        .. ',"probes":[' .. table.concat(evParts, ',') .. ']'
        .. ',"dbg":[' .. table.concat(__DBG, ',') .. ']'
        .. ',"ended":' .. jsq(__ENDED)
        .. '}'
      rawset(_G, '_BX_MUTE', wasMuted)
    end
  end
end
`;

// __BUD is injected by the loader below (string interpolation).
// v2.11.0 probe-rerun: up to 8 attempts while the lift instrumentation reports
// "probed but zero events" (tiny dispatch loops that exit between two hook
// ticks). Guest execution is DETERMINISTIC — a plain re-run lands on the exact
// same tick phase and fails identically — so each attempt first burns a
// different number of no-op instructions (attempt × 53, coprime with the 150
// tick interval) to shift the scan/probe phase. Within a few attempts the
// probes land mid-loop. Heavy VMs never re-run (events on attempt 1); the
// shared instruction budget bounds the total work.
const RUNNER = `
_BX_RESULT = {}
local __ok, __e = pcall(_BX_F)
_BX_RESULT.ok = __ok
if not __ok then _BX_RESULT.err = tostring(__e) end
if __bx_lift_dump then pcall(__bx_lift_dump, __ok and 'clean-exit' or 'error') end
if __bx_lift_wants_rerun then
  for __attempt = 1, 8 do
    if not __bx_lift_wants_rerun() then break end
    if __bx_lift_reset_for_rerun then pcall(__bx_lift_reset_for_rerun) end
    local __burn = __attempt * 53
    for _ = 1, __burn do end
    __ok, __e = pcall(_BX_F)
    _BX_RESULT.ok = __ok
    if not __ok then _BX_RESULT.err = tostring(__e) end
    if __bx_lift_dump then pcall(__bx_lift_dump, __ok and 'clean-exit' or 'error') end
  end
end
`;

// __BUD must exist before the hook runs: prepend a declaration to LIFT_LUA.
const LIFT_LUA_FULL = 'local __BUD = ' + LIFT_BUDGET + '\n' + LIFT_LUA;

// ---- state plumbing -----------------------------------------------------------
// v2.11.0 spin-break (Biggest Scan exploit): escrow builds that catch the
// budget error with an inner pcall and re-spin would burn the wall-clock
// timeout with zero capture — after the first exhaustion, a second fire means
// the sample is spinning: dump partial capture and exit hard.
let budgetSpin = false;
function freshState(budget) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  try {
    lua.lua_sethook(L, () => {
      budget.left -= HOOK_INTERVAL;
      if (budget.left <= 0) {
        if (budgetSpin) {
          try { dumpAndExit('instruction budget — partial capture (spin-break)'); } catch { /* hard exit below */ }
          process.exit(0);
        }
        budgetSpin = true;
        lauxlib.luaL_error(L, to_luastring('bx: instruction budget exceeded'));
      }
    }, lua.LUA_MASKCOUNT, HOOK_INTERVAL);
  } catch { /* spawnHardened SIGKILL is the backstop */ }
  return { L, budget };
}

function runLua(state, src, label) {
  const rc = lauxlib.luaL_dostring(state.L, to_luastring(src));
  if (rc !== lua.LUA_OK) throw new Error(`${label}: ${safeToJsString(state.L, -1, 'error').slice(0, 200)}`);
}

function loadSample(state, source) {
  const chunk = to_luastring(source, true);
  const rc = lauxlib.luaL_loadbuffer(state.L, chunk, chunk.length, to_luastring('@bypassx'));
  if (rc !== lua.LUA_OK) return { loaded: false, err: safeToJsString(state.L, -1, 'error').slice(0, 200) };
  lua.lua_setglobal(state.L, to_luastring('_BX_F'));
  return { loaded: true };
}

function readStrings(L, name, cap) {
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

function readChunks(L) {
  const out = [];
  let total = 0;
  try {
    lua.lua_getglobal(L, to_luastring('_BX_CHUNKS'));
    if (!lua.lua_istable(L, -1)) { lua.lua_pop(L, 1); return out; }
    const n = lua.lua_rawlen(L, -1);
    for (let i = 1; i <= Math.min(n, jail.MAX_CHUNKS); i += 1) {
      if (total >= jail.MAX_CHUNKS_TOTAL) break;
      lua.lua_rawgeti(L, -1, i);
      if (lua.lua_isstring(L, -1)) {
        const s = safeToJsString(L, -1);
        if (s && s.length >= 8 && !out.includes(s)) { out.push(s); total += s.length; }
      }
      lua.lua_pop(L, 1);
    }
    lua.lua_pop(L, 1);
  } catch { /* state gone */ }
  return out;
}

function dumpState(state, { withLift }) {
  const { L } = state;
  const strings = readStrings(L, '_BX_SINK', jail.MAX_SINK);
  const log = readStrings(L, '_BX_LOG', 300);
  const chunks = readChunks(L);
  let ran = false;
  let runError = null;
  let lift = null;
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
  if (withLift) {
    try {
      lua.lua_getglobal(L, to_luastring('_BX_LIFT_JSON'));
      if (lua.lua_isstring(L, -1)) {
        const raw = safeToJsString(L, -1);
        try {
          lift = JSON.parse(raw);
        } catch (pe) {
          console.error(`[lift] JSON parse failed: ${pe.message}; raw[:200]=${raw.slice(0, 200)}`);
          lift = null;
        }
      } else {
        console.error('[lift] _BX_LIFT_JSON missing');
      }
      lua.lua_pop(L, 1);
    } catch (e) {
      console.error(`[lift] dump read failed: ${e.message}`);
      lift = null;
    }
  }
  return { ran, runError, strings, chunks, log, lift };
}

function fail(msg) {
  writeOut({ ok: false, error: String(msg).slice(0, 300) });
  process.exit(0);
}

// ---- main ---------------------------------------------------------------------
let dumped = false;
const out = { ok: true, ran: false, runError: null, strings: [], chunks: [], log: [], lift: null };
function dumpAndExit(note) {
  if (dumped) return;
  dumped = true;
  if (note) { out.partial = true; out.note = note; }
  writeOut(out);
  process.exit(0);
}
process.on('SIGTERM', () => dumpAndExit('time budget — partial data'));
process.on('SIGINT', () => dumpAndExit('interrupted'));

async function main() {
  let transformed = code;
  try {
    const mod = await import('./luau-shim.js');
    if (mod.hasLuauCompoundAssign(code)) transformed = mod.transformLuauToLua(code);
  } catch { /* shim unavailable — original path */ }

  // ---- run 1: plain harvest (identical jail to harvester-worker) ---------------
  const s1 = freshState({ left: Math.floor(BUDGET_TOTAL * 0.55) });
  runLua(s1, jail.PRELUDE, 'prelude');
  const l1 = loadSample(s1, transformed);
  let d1 = { ran: false, runError: null, strings: [], chunks: [], log: [] };
  if (l1.loaded) {
    try { runLua(s1, RUNNER, 'runner'); } catch { /* budget longjmp — sink survives */ }
    d1 = dumpState(s1, { withLift: false });
  } else {
    d1.runError = l1.err || 'load failed';
    const s1b = freshState({ left: Math.floor(BUDGET_TOTAL * 0.3) });
    runLua(s1b, jail.PRELUDE, 'prelude');
    const l1b = loadSample(s1b, code);
    if (l1b.loaded) {
      try { runLua(s1b, RUNNER, 'runner'); } catch { /* budget longjmp */ }
      d1 = dumpState(s1b, { withLift: false });
    }
  }
  out.ran = d1.ran;
  out.runError = d1.runError;
  out.strings = d1.strings;
  out.chunks = d1.chunks;
  out.log = d1.log.slice(0, 120);

  // v2.11.0 incremental flush (Biggest Scan exploit): run 2's instrumented
  // lift phase can wedge INSIDE a single blocking fengari call (opcode probing
  // on hostile dispatchers) — when that happens the event loop is stuck and
  // neither the SIGTERM dump nor the spin-break can fire, so the parent sees a
  // bare timeout with zero capture EVEN THOUGH run 1 just decrypted the pool.
  // Flush run 1's result NOW as an intermediate stdout line. The parent takes
  // the LAST line: if run 2 completes normally its full result wins; if it
  // wedges and dies on the wall clock, run 1's partial pool is the recovery.
  if (out.strings.length > 0 || out.chunks.length > 0) {
    writeOut({ ...out, phase: 'run1-partial', partial: true });
  }

  const chunkHit = d1.chunks.length > 0;
  const timeLeft = Date.now() - t0 < TIME_WALL_MS;

  // ---- run 2+: lifting runs (fresh states + capture/probe instrumentation) -----
  // Multi-pass: the RETURN-style op exits the dispatcher mid-probe-program,
  // truncating later opids. Each pass probes on a fresh state; uncovered opids
  // are retried with the known-exit op placed LAST.
  if (!chunkHit && timeLeft) {
    const attempt = (source, tag, probeOps) => {
      const s2 = freshState({ left: Math.floor(BUDGET_TOTAL * 0.35) });
      runLua(s2, jail.PRELUDE, 'prelude');
      runLua(s2, LIFT_LUA_FULL, 'lift-instrumentation');
      if (probeOps && probeOps.length) {
        lua.lua_getglobal(s2.L, to_luastring('_G'));
        lua.lua_createtable(s2.L, probeOps.length, 0);
        probeOps.forEach((op, i) => {
          lua.lua_pushinteger(s2.L, op);
          lua.lua_rawseti(s2.L, -2, i + 1);
        });
        lua.lua_setfield(s2.L, -2, to_luastring('_BX_PROBE_OPS'));
        lua.lua_pop(s2.L, 1);
      }
      const l2 = loadSample(s2, source);
      if (!l2.loaded) return null;
      try { runLua(s2, RUNNER, 'runner'); } catch { /* budget longjmp — lift data survives */ }
      const d = dumpState(s2, { withLift: true });
      if (d.lift) d.lift.attempt = tag;
      return d;
    };
    const mergeLift = (dst, src) => {
      if (!src || !src.lift || !src.lift.snap) return;
      if (!dst.snap) { Object.assign(dst, src.lift); return; }
      if (src.lift.ended) dst.ended = src.lift.ended;
      const seenOps = new Set(dst.probes.map((p) => p.op));
      for (const p of src.lift.probes) {
        if (seenOps.has(p.op)) {
          const dp = dst.probes.find((q) => q.op === p.op);
          if (dp && dp.ev.length < p.ev.length) dp.ev = p.ev;
        } else dst.probes.push(p);
      }
    };
    let acc = { snap: null, probes: [], ended: null };
    let bestStrings = [];
    const seenAll = new Set(out.strings);
    const passes = [
      { src: transformed, tag: 'strict', ops: null },
      { src: forgivingStack(transformed), tag: 'forgiving', ops: null },
    ];
    let cleanExitOp = null;
    for (let pass = 0; pass < passes.length + 2 && Date.now() - t0 < TIME_WALL_MS; pass++) {
      let spec = passes[pass];
      if (!spec) {
        // targeted pass: probe uncovered opids, exit op last
        const covered = new Set(acc.probes.filter((p) => p.ev.length > 0).map((p) => p.op));
        const all = acc.snap ? acc.snap.opids || [] : [];
        const uncovered = all.filter((op) => !covered.has(op));
        if (!uncovered.length) break;
        const ops = uncovered.slice(0, 40);
        if (cleanExitOp) ops.push(cleanExitOp);
        spec = { src: transformed, tag: 'targeted-' + pass, ops };
      }
      let d2 = null;
      try { d2 = attempt(spec.src, spec.tag, spec.ops); } catch (e) { d2 = null; out.log.push('BXDBG pass ' + spec.tag + ' threw: ' + String(e && e.message || e).slice(0, 120)); }
      out.log.push('BXDBG pass ' + spec.tag + ' lift=' + (d2 && d2.lift && d2.lift.snap ? 'yes' : 'no') + ' ended=' + (d2 && d2.lift ? d2.lift.ended : '-') + ' probed=' + (d2 && d2.lift && d2.lift.probes ? d2.lift.probes.filter(p => p.ev.length > 0).length : 0));
      if (!d2 || !d2.lift || !d2.lift.snap) continue;
      mergeLift(acc, d2);
      if (d2.lift.ended === 'clean-exit') {
        // find the opid whose probe record was served last
        let lastPc = 0;
        for (const p of d2.lift.probes) {
          for (const e of p.ev) {
            const m = /^PC(\d+)$/.exec(e);
            if (m) lastPc = Math.max(lastPc, Number(m[1]));
          }
        }
        for (const p of d2.lift.probes) {
          if (p.ev.some((e) => e === 'PC' + lastPc)) { cleanExitOp = p.op; break; }
        }
      }
      for (const st of d2.strings) if (!seenAll.has(st)) { seenAll.add(st); bestStrings.push(st); }
      out.ran = out.ran || d2.ran;
      if (!out.runError && d2.runError) out.runError = d2.runError;
      const covered = new Set(acc.probes.filter((p) => p.ev.length > 0).map((p) => p.op));
      const all = acc.snap ? acc.snap.opids || [] : [];
      if (all.length && all.every((op) => covered.has(op))) break; // full coverage
    }
    if (acc.snap) {
      out.lift = acc;
      for (const s of bestStrings) out.strings.push(s);
      const seenL = new Set(out.log);
      for (const l of out.log.slice()) { /* keep */ }
    }
  }

  dumpAndExit(null);
}

main().catch((e) => fail(String(e && e.message || e).slice(0, 200)));
