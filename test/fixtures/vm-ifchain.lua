--[[ Luraph v15.1 ]]
-- fixture: if-chain VM (Luraph v15 shape) — handlers inlined in the dispatch
-- loop, numeric pc, encrypted constant pool decrypted with bit32.bxor.
local __KEY = 42
local CONSTS = {}
local __ENCPOOL = {
  [1] = { 90, 88, 67, 68, 94 }, -- "print"
  [2] = { 98, 79, 70, 70, 69, 10, 76, 88, 69, 71, 10, 94, 66, 79, 10, 67, 76, 7, 73, 66, 75, 67, 68, 10, 124, 103 }, -- "Hello from the if-chain VM"
  [3] = { 125, 69, 88, 65, 89, 90, 75, 73, 79 }, -- "Workspace"
  [4] = { 99, 108, 105, 98, 107, 99, 100, 117, 101, 127, 126 }, -- "IFCHAIN_OUT"
  [5] = { 109, 79, 94, 121, 79, 88, 92, 67, 73, 79 }, -- "GetService"
  [6] = { 77, 75, 71, 79 }, -- "game"
  [8] = { 65, 67, 68, 78 }, -- "kind"
  [9] = { 76, 67, 82, 94, 95, 88, 79 }, -- "fixture"
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

local INSTRS = {
  { 3, 1, 1 },      --  1 GETGLOBAL V1 = K1(print)
  { 1, 2, 2 },      --  2 LOADK    V2 = K2
  { 5, 1, 2 },      --  3 CALL     V1 = V1(V2)
  { 3, 3, 6 },      --  4 GETGLOBAL V3 = K6(game)
  { 1, 4, 3 },      --  5 LOADK    V4 = K3(Workspace)
  { 8, 6, 3, 5 },   --  6 GETTABLE V6 = V3[K5(GetService)]
  { 5, 6, 4 },      --  7 CALL     V6 = V6(V4)
  { 4, 4, 6 },      --  8 SETGLOBAL K4(IFCHAIN_OUT) = V6
  { 1, 7, 7 },      --  9 LOADK    V7 = K7(2.0)
  { 9, 8, 7, 7 },   -- 10 ADD      V8 = V7 + V7
  { 6, 9, 0 },      -- 11 NEWTABLE V9
  { 1, 10, 9 },     -- 12 LOADK    V10 = K9(fixture)
  { 1, 11, 8 },     -- 13 LOADK    V11 = K8(kind)
  { 7, 9, 11, 10 }, -- 14 SETTABLE V9[K8(kind)] = V10
  { 11, 8, 8, 4 },  -- 15 TEST     V8 == V8 -> skip trap
  { 3, 12, 10 },    -- 16 (trap)   GETGLOBAL V12 = K10(error)
  { 1, 13, 11 },    -- 17 (trap)   LOADK V13 = K11
  { 5, 12, 13 },    -- 18 (trap)   CALL V12(V13)
  { 12, 0, 0 },     -- 19 RETURN
}

local pc = 1
local STACK = {}
local ENV3 = getfenv()
while true do
  local I = INSTRS[pc]
  if not I then break end
  local op = I[1]
  if op == 1 then
    STACK[I[2]] = CONSTS[I[3]]
    pc = pc + 1
  elseif op == 2 then
    STACK[I[2]] = STACK[I[3]]
    pc = pc + 1
  elseif op == 3 then
    STACK[I[2]] = ENV3[CONSTS[I[3]]]
    pc = pc + 1
  elseif op == 4 then
    ENV3[CONSTS[I[2]]] = STACK[I[3]]
    pc = pc + 1
  elseif op == 5 then
    STACK[I[2]] = STACK[I[2]](STACK[I[3]])
    pc = pc + 1
  elseif op == 6 then
    STACK[I[2]] = {}
    pc = pc + 1
  elseif op == 7 then
    STACK[I[2]][CONSTS[I[3]]] = STACK[I[4]]
    pc = pc + 1
  elseif op == 8 then
    STACK[I[2]] = STACK[I[3]][CONSTS[I[4]]]
    pc = pc + 1
  elseif op == 9 then
    STACK[I[2]] = STACK[I[3]] + STACK[I[4]]
    pc = pc + 1
  elseif op == 10 then
    pc = pc + I[3]
  elseif op == 11 then
    if STACK[I[2]] == STACK[I[3]] then pc = pc + I[4] else pc = pc + 1 end
  elseif op == 12 then
    break
  else
    pc = pc + 1
  end
end
