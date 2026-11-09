local Players = game:GetService("Players")
local function fly(state)
  local hum = Players.LocalPlayer.Character:FindFirstChildOfClass("Humanoid")
  if state then hum.WalkSpeed = 100 else hum.WalkSpeed = 16 end
end
local key = "E"
local enabled = false
if key == "E" and not enabled then
  enabled = true
  fly(true)
end
print("loaded", enabled)
