local apiDump = require("@lune/serde").decode("json", require("@lune/fs").readFile("apidump.json"))
local Hidden = {}

for _, API_Class in pairs(apiDump.Classes) do
    for _, Member in pairs(API_Class.Members) do
        if Member.MemberType == "Property" then
            local PropertyName = Member.Name

            local MemberTags = Member.Tags

            local Special

            if MemberTags then
                Special = table.find(MemberTags, "NotScriptable")
            end
            if Special then
                table.insert(Hidden, PropertyName)
            end
        end
    end
end

return Hidden;