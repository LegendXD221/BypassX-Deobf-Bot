local function getServices(apiDump)
    local services = {}
    
    for _, class in pairs(apiDump.Classes) do
        if class.Tags then
            for _, tag in pairs(class.Tags) do
                if tag == "Service" or class.Name == "DataModel" then
                    local service = {
                        methods = {},
                        properties = {},
                        events = {},
                        callbacks = {}
                    }
                    
                    -- Parse members
                    if class.Members then
                        for _, member in pairs(class.Members) do
                            if member.MemberType == "Function" then
                                service.methods[member.Name] = {
                                    Name = member.Name,
                                    Parameters = member.Parameters or {},
                                    ReturnType = member.ReturnType or {},
                                    Security = member.Security or "None",
                                    Tags = member.Tags or {}
                                }
                            elseif member.MemberType == "Property" then
                                service.properties[member.Name] = {
                                    Name = member.Name,
                                    ValueType = member.ValueType or {},
                                    Security = member.Security or "None",
                                    Tags = member.Tags or {},
                                    Category = member.Category or "Data"
                                }
                            elseif member.MemberType == "Event" then
                                service.events[member.Name] = {
                                    Name = member.Name,
                                    Parameters = member.Parameters or {},
                                    Security = member.Security or "None",
                                    Tags = member.Tags or {}
                                }
                            elseif member.MemberType == "Callback" then
                                service.callbacks[member.Name] = {Name = member.Name, Parameters = member.Parameters or {}, ReturnType = member.ReturnType}
                            end
                        end
                    end

                    services[class.Name] = service
                    
                    break
                end
            end
        end
    end
    
    return services
end

local content = require("@lune/fs").readFile("apidump.json")
return getServices(require("@lune/serde").decode("json", content))