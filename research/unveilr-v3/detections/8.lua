local succ, err = pcall(function()
    require("@lune/roblox")
end)
if succ then
    warn('dtc')
    return
end
print('pass')
