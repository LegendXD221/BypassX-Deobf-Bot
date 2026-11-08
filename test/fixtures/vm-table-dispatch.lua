--[[ MoonSec V3 ]]
-- fixture: table-dispatch VM (MoonSec V3 escrow shape) — encrypted pool,
-- handler table, pc-object, env local. Guest program sets VM_OUT.
local __KEY = 42
local CONSTS = {}
local __ENCPOOL = {
  [1] = { 90, 88, 67, 68, 94 }, -- "print"
  [2] = { 98, 79, 70, 70, 69, 10, 76, 88, 69, 71, 10, 103, 69, 69, 68, 121, 79, 73, 10, 124, 103 }, -- "Hello from MoonSec VM"
  [3] = { 120, 79, 90, 70, 67, 73, 75, 94, 79, 78, 121, 94, 69, 88, 75, 77, 79 }, -- "ReplicatedStorage"
  [4] = { 124, 103, 117, 101, 127, 126 }, -- "VM_OUT"
  [5] = { 109, 79, 94, 121, 79, 88, 92, 67, 73, 79 }, -- "GetService"
  [6] = { 77, 75, 71, 79 }, -- "game"
  [8] = { 70, 75, 68, 77 }, -- "lang"
  [9] = { 70, 95, 75 }, -- "lua"
  [10] = { 79, 88, 88, 69, 88 }, -- "error"
  [11] = { 89, 66, 69, 95, 70, 78, 7, 68, 69, 94, 7, 88, 95, 68 }, -- "should-not-run"
}
for __i = 1, 11 do
  local __enc = __ENCPOOL[__i]
  if __enc then
    local __parts = {}
    for __j = 1, #__enc do
      __parts[__j] = string.char(bit32.bxor(__enc[__j], __KEY))
    end
    CONSTS[__i] = table.concat(__parts)
  end
end
CONSTS[7] = 2.0

local HANDLERS = {}
HANDLERS[1] = function(S, I, C, E) S[I[2]] = C[I[3]] end
HANDLERS[2] = function(S, I, C, E) S[I[2]] = S[I[3]] end
HANDLERS[3] = function(S, I, C, E) S[I[2]] = E[C[I[3]]] end
HANDLERS[4] = function(S, I, C, E) E[C[I[2]]] = S[I[3]] end
HANDLERS[5] = function(S, I, C, E) S[I[2]] = S[I[2]](S[I[3]]) end
HANDLERS[6] = function(S, I, C, E) S[I[2]] = {} end
HANDLERS[7] = function(S, I, C, E) S[I[2]][C[I[3]]] = S[I[4]] end
HANDLERS[8] = function(S, I, C, E) S[I[2]] = S[I[3]][C[I[4]]] end
HANDLERS[9] = function(S, I, C, E) S[I[2]] = S[I[3]] + S[I[4]] end
HANDLERS[10] = function(S, I, C, E) return I[3] end
HANDLERS[11] = function(S, I, C, E) if S[I[2]] == S[I[3]] then return I[4] end return 1 end
HANDLERS[12] = function(S, I, C, E) return 'halt' end

local INSTRS = {
  { 3, 1, 1 },      --  1 GETGLOBAL V1 = K1(print)
  { 1, 2, 2 },      --  2 LOADK    V2 = K2
  { 5, 1, 2 },      --  3 CALL     V1 = V1(V2)
  { 3, 3, 6 },      --  4 GETGLOBAL V3 = K6(game)
  { 1, 4, 3 },      --  5 LOADK    V4 = K3(ReplicatedStorage)
  { 8, 6, 3, 5 },   --  6 GETTABLE V6 = V3[K5(GetService)]
  { 5, 6, 4 },      --  7 CALL     V6 = V6(V4)
  { 4, 4, 6 },      --  8 SETGLOBAL K4(VM_OUT) = V6
  { 1, 7, 7 },      --  9 LOADK    V7 = K7(2.0)
  { 9, 8, 7, 7 },   -- 10 ADD      V8 = V7 + V7
  { 6, 9, 0 },      -- 11 NEWTABLE V9
  { 1, 10, 9 },     -- 12 LOADK    V10 = K9(lua)
  { 1, 11, 8 },     -- 13 LOADK    V11 = K8(lang)
  { 7, 9, 11, 10 }, -- 14 SETTABLE V9[K8(lang)] = V10
  { 11, 8, 8, 4 },  -- 15 TEST     V8 == V8 -> skip trap
  { 3, 12, 10 },    -- 16 (trap)   GETGLOBAL V12 = K10(error)
  { 1, 13, 11 },    -- 17 (trap)   LOADK V13 = K11
  { 5, 12, 13 },    -- 18 (trap)   CALL V12(V13)
  { 12, 0, 0 },     -- 19 RETURN
}

local PC = { n = 1 }
local STACK = {}
local ENV2 = getfenv()
while true do
  local I = INSTRS[PC.n]
  if not I then break end
  local h = HANDLERS[I[1]]
  if not h then break end
  local d = h(STACK, I, CONSTS, ENV2)
  if d == 'halt' then break end
  PC.n = PC.n + (d or 1)
end
