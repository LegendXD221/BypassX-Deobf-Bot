local Env = {
    DynamicSpy = {}, --> Functions that should ONLY log when a spied variable is used.
    StaticSpy = {}, --> Functions that should ALWAYS log when called
    Tables = {} --> Global tables (Like Drawing & debug)
}
--& Tables:
local Variables, Internal, InstanceData, Output, CClosures, WaitingEnds = {}, {}, {}, {}, {}, {}
--& Functions:
local Spy, Append, GetVar, DefineVars, AddNest, Beautify, BeautifyTuple, InlineComment, FallbackValue, GetWaitingEnds, CloseAllEnds, GetNest, SetNest =
    nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil;
--& Booleans:
local IsInPcall;
--& Numbers:
local PcallId = 0;
--& Localization:
local pack, insert, concat = table.pack, table.insert, table.concat
local find = string.find
local max = math.max
local rawTypeof = typeof

type InstanceData = {
    Created: boolean,
    Properties: table?,
    Methods: table?,
    Instance: Instance
}

local function GetInternalValue(Object : any) : any
    local Var = Variables[Object]
    local Value = Internal[Var]

    if not Value then return Object end

    return GetInternalValue(Value[1])
end

local function SetInternalValue(Var : string, Value : any) : nil
    Internal[Var] = { Value }
end

local function BeautifyButIgnoreFunctions(...)
    local Out = ""
    local Packed = pack(...)

    for i = 1, Packed.n do
        local Value = Packed[i]
        if typeof(Value) == "function" then
            Out ..= "function()end, "
        else
            Out ..= Beautify(Value) .. ", "
        end
    end

    return Out:sub(1, -3)
end

local function typeof(Object : any) : string
    --> Returns the type of the internal value.

    return rawTypeof(GetInternalValue(Object));
end

local function getInstanceData(Object : table)
    return InstanceData[Object] or {}
end

local function Unpack(Variable: string?, tbl : table, i : number?, j : number?)
    if Variable then --> Either tbl or i or j is spied
        return Spy(Variable)
    end
    return unpack(tbl, i, j);
end

Env.DynamicSpy.unpack = Unpack
Env.StaticSpy.xpcall = function(_ : string?, f, onFail)
    return xpcall(f, onFail)
end

return function(InitData)
    Variables, Internal, Spy, Append, GetVar, DefineVars, AddNest, Output, Beautify, BeautifyTuple, InlineComment, FallbackValue, GetWaitingEnds, WaitingEnds,
    CloseAllEnds, GetNest, SetNest =
        InitData.Variables, InitData.Internal, InitData.Spy, InitData.Append, InitData.GetVar, InitData.DefineVars, InitData.AddNest, InitData.Output, InitData.Beautify,
        InitData.BeautifyTuple, InitData.InlineComment, InitData.FallbackValue, InitData.GetWaitingEnds, InitData.WaitingEnds, InitData.CloseAllEnds, InitData.GetNest, InitData.SetNest;

    return Env
end