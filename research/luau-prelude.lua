-- bx-luau-prelude: minimal Roblox-shaped env for running Luraph v15.1 VMs in the Luau CLI.
-- Everything is inert; the goal is VM init + decode + guest calls surfacing through print.
local __LOG = {}
local function log(s) __LOG[#__LOG + 1] = tostring(s) end

-- inert datatype constructors: return tables that tolerate indexing/calls/arith
local function inert()
	return setmetatable({}, {
		__index = function() return inert() end,
		__call = function() return inert() end,
		__add = function() return inert() end, __sub = function() return inert() end,
		__mul = function() return inert() end, __div = function() return inert() end,
		__mod = function() return inert() end, __pow = function() return inert() end,
		__unm = function() return inert() end,
		__concat = function() return inert() end,
		__tostring = function() return "Inert" end,
		__eq = function() return false end, __lt = function() return false end, __le = function() return false end,
		__len = function() return 0 end,
	})
end

Color3 = setmetatable({}, { __index = function() return function() return inert() end end, __call = function() return inert() end })
Vector3 = setmetatable({}, { __index = function() return function() return inert() end end, __call = function() return inert() end })
Vector2 = setmetatable({}, { __index = function() return function() return inert() end end, __call = function() return inert() end })
UDim2 = setmetatable({}, { __index = function() return function() return inert() end end, __call = function() return inert() end })
UDim = setmetatable({}, { __index = function() return function() return inert() end end, __call = function() return inert() end })
Rect = setmetatable({}, { __index = function() return function() return inert() end end, __call = function() return inert() end })
CFrame = setmetatable({}, { __index = function() return function() return inert() end end, __call = function() return inert() end })
Enum = inert()
Instance = { new = function() return inert() end }

local INERT = inert()
game = setmetatable({}, {
	__index = function(t, k)
		if k == "PlaceId" then return 18774239 end
		if k == "GameId" then return 9947321 end
		if k == "CreatorId" then return 1 end
		if k == "JobId" then return "b1a2c3d4-e5f6-7890-abcd-ef1234567890" end
		if k == "Loaded" then return true end
		if k == "Workspace" then return INERT end
		if k == "HttpGet" or k == "HttpPost" then return nil end
		return INERT
	end,
	__call = function() return INERT end,
})
workspace = INERT
script = INERT
shared = {}

task = {
	wait = function() return 0 end,
	spawn = function(f, ...) if type(f) == "function" then return f(...) end end,
	defer = function(f, ...) if type(f) == "function" then return f(...) end end,
	delay = function(t, f, ...) if type(f) == "function" then return f(...) end end,
}
wait = task.wait
spawn = task.spawn
delay = task.delay
tick = function() return 0 end
time = function() return 0 end
warn = print

-- executor probes must read nil (production Roblox)
-- getgenv absent in plain Luau
-- identifyexecutor absent

__BX_LOG = __LOG

-- instrumentation: surface swallowed errors
local __realpcall = pcall
pcall = function(...)
	local r = table.pack(__realpcall(...))
	if not r[1] then __LOG[#__LOG + 1] = "PCALL-ERR: " .. tostring(r[2]) end
	return table.unpack(r, 1, r.n)
end
local __realxpcall = xpcall
xpcall = function(f, h, ...)
	local r = table.pack(__realxpcall(f, h, ...))
	if not r[1] then __LOG[#__LOG + 1] = "XPCALL-ERR: " .. tostring(r[2]) end
	return table.unpack(r, 1, r.n)
end
local __realerror = error
error = function(msg, lvl) __LOG[#__LOG + 1] = "ERROR-CALLED: " .. tostring(msg) .. " lvl=" .. tostring(lvl) return __realerror(msg, lvl) end
local __realprint = print
print = function(...)
	local parts = table.create(select("#", ...))
	for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
	local line = table.concat(parts, " ")
	__LOG[#__LOG + 1] = "PRINT: " .. line
	__realprint(line)
end
warn = print

-- trace getfenv usage
local __realgetfenv = getfenv
getfenv = function(...)
	local r = __realgetfenv(...)
	__LOG[#__LOG + 1] = "GETFENV args=" .. select("#", ...) .. " -> " .. tostring(r)
	return r
end
local __realsetfenv = setfenv
setfenv = function(f, t)
	__LOG[#__LOG + 1] = "SETFENV " .. tostring(f) .. " -> " .. tostring(t)
	return __realsetfenv(f, t)
end
-- trace newproxy (Luau env proxy trick)
local __realnewproxy = newproxy
if __realnewproxy then
	newproxy = function(...)
		__LOG[#__LOG + 1] = "NEWPROXY " .. select("#", ...)
		return __realnewproxy(...)
	end
end
