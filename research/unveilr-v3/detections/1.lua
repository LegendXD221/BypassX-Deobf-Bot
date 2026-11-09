local s, e = pcall(function()
    return Instance.new("Part").name
end)

if not s or e ~= "Part" then
    warn("bruh")
end