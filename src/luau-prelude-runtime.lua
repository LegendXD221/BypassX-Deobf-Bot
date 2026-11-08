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

