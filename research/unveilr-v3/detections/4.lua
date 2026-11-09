local success = pcall(function()
    return workspace.CurrentCamera.CFrame:Inverse()
end)
if not success then
    error("detected")
end
print("test")