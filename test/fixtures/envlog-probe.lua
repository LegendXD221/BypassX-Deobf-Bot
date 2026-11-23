-- envlog probe fixture (v2.25.0): reads a MISSING global (polyglot __index
-- path — the envlog sensor) and writes two globals (raw-present _G writes —
-- __newindex path). game/print are raw-present in the jail, so they are NOT
-- recorded (Lua __index semantics) — the missing-global probe is the signal.
local leak = tostring(webhook_url)
local place = game.PlaceId
MARKER_ONE = 42
_G["MARKER_TWO"] = leak .. place
return MARKER_ONE
