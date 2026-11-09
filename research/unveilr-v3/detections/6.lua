local e = game.Players.LocalPlayer
if type(e) ~= "userdata" or typeof(e) ~= "Instance" or not e.Name or not e.Parent or not e.Parent.Name then
    error("dtc")
    return
end
print("ok")