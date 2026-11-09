local success = pcall(function()
    local v1 = Vector3.new(1, 2, 3)
    local v2 = Vector3.new(1.0001, 2.0001, 3.0001)
    return v1:FuzzyEq(v2)
end)
if not success then
    warn("hi")
    error("detected")
end
print("test1")