local apiDump = require("@lune/serde").decode("json", require("@lune/fs").readFile("apidump.json"))

local hierarchy = {}
for _, class in pairs(apiDump.Classes) do
    hierarchy[class.Name] = class.Superclass
end

local function IsA(class, class2)
    local current = class
    while current do
        if current == class2 then return true end
        current = hierarchy[current]
    end
    return false
end

return {
    IsA = IsA
}