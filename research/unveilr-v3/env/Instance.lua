local function getBaseInstance(apiDump)
    local instance = {
        methods = {},
        properties = {},
        events = {}
    }
    
    for _, class in pairs(apiDump.Classes) do
        if class.Name == "Instance" or class.Name == "Object" then
            if class.Members then
                for _, member in pairs(class.Members) do
                    if member.MemberType == "Function" then
                        instance.methods[member.Name] = {
                            Name = member.Name,
                            Parameters = member.Parameters or {},
                            ReturnType = member.ReturnType or {},
                            Security = member.Security or "None",
                            Tags = member.Tags or {}
                        }
                    elseif member.MemberType == "Property" then
                        instance.properties[member.Name] = {
                            Name = member.Name,
                            ValueType = member.ValueType or {},
                            Security = member.Security or "None",
                            Tags = member.Tags or {},
                            Category = member.Category or "Data"
                        }
                    elseif member.MemberType == "Event" then
                        instance.events[member.Name] = {
                            Name = member.Name,
                            Parameters = member.Parameters or {},
                            Security = member.Security or "None",
                            Tags = member.Tags or {}
                        }
                    end
                end
            end
        end
    end
    
    return instance
end

return getBaseInstance(require("@lune/serde").decode("json", require("@lune/fs").readFile("apidump.json")))