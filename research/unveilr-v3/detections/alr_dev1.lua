local total = 4
local dtc = 0
local passed = {}

local function g(v)
    return " , got: "..tostring(v)
end

-- 1
local mt = debug.getmetatable(_G)
if mt and rawequal(mt, getfenv(0)) == false then
    print("dtc by: _G metatable"..g(mt))
    dtc = dtc + 1
else
    table.insert(passed, "_G metatable")
end

-- 2
local ok, f = pcall(function()
    return debug.setstack(1, 1, function()
        return function()
            return 999999999
        end
    end)
end)

if not ok or type(f) ~= "function" then
    print("dtc by: debug.setstack, expected a function"..g(f))
    dtc = dtc + 1
else
    local ok2, r = pcall(f)
    if not (ok2 and r == 999999999) then
        print("dtc, expected number"..g(r))
        dtc = dtc + 1
    else
        table.insert(passed, "debug.setstack")
    end
end

-- 3
local o = pcall
local m = getmetatable

function c()
    local i = debug.getinfo(pcall, "Suf")
    local oi = debug.getinfo(o, "Suf")
    if i.what ~= "C" or i.source ~= "=[C]" then return i.what..","..i.source end
    if pcall ~= o then return tostring(pcall)..","..tostring(o) end
    if i.nups ~= oi.nups then return i.nups..","..oi.nups end
    for x = 1, i.nups do
        local n1, v1 = debug.getupvalue(pcall, x)
        local n2, v2 = debug.getupvalue(o, x)
        if n1 ~= n2 or v1 ~= v2 then return tostring(v1)..","..tostring(v2) end
    end
    if m and m(pcall) ~= nil then return tostring(m(pcall)) end
    return false
end

local r3 = c()
if r3 ~= false then
    print("dtc by: debug.getinfo and debug.getupvalue"..g(r3))
    dtc = dtc + 1
else
    table.insert(passed, "debug.getinfo / debug.getupvalue")
end

-- 4
if debug.getproto then
    local function dummy_function()
        local function dummy_proto_1() end
        local function dummy_proto_2() end
    end

    local function test()
        local ok1, r1 = pcall(function()
            return debug.getproto(dummy_function, 1)()
        end)
        local ok2, r2 = pcall(function()
            return debug.getproto(dummy_function, 2)()
        end)

        if ok1 or ok2 then
            print("dtc by: debug.getproto"..g(ok1 and r1 or r2))
            dtc = dtc + 1
        else
            table.insert(passed, "debug.getproto")
        end
    end
    test()
else
    table.insert(passed, "debug.getproto (not available)")
end

print("dtc rate: " .. ((dtc / total) * 100) .. "%")
print("passed tests: " .. table.concat(passed, ", "))