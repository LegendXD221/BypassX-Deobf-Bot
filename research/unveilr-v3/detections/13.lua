local Workspace = game:GetService("Workspace")
local ok12 = true
local newenum = function() return Enum end

if newenum().PartType.Cylinder.Name ~= "Cylinder" then
    print("Not ok #0")
    ok12 = false
end

if newenum().PartType.Cylinder.Value ~= 2 then
    print("Not ok #1")
    ok12 = false
end

if tostring(newenum().PartType.Cylinder.EnumType) ~= "PartType" then
    print("Not ok #2")
    ok12 = false
end

local part = Instance.new("Part")

local success1 = pcall(function()
    part.Shape = newenum().PartType.Cylinder
end)

local success2 = pcall(function()
    part.Shape = "Cylinder"
end)

if not success1 or not success2 then
    print("Not ok #3")
    ok12 = false
end

part.Parent = Workspace

if part.Parent ~= Workspace then
    print("Not ok #4")
    ok12 = false
end

if part.Shape ~= newenum().PartType.Cylinder then
    print("Not ok #5")
    ok12 = false
end


if ok12 then
print('ud')
else
    print('dtc')
    
end