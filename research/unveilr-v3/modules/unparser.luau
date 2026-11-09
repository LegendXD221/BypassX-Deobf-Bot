local parser = require("@std/syntax/parser")
local fs = require("@std/fs")

local function writeFileCompat(path, content)
    if fs.writeFile then return fs.writeFile(path, content) end
    if fs.writestringtofile then return fs.writestringtofile(path, content) end
    if fs.writefile then return fs.writefile(path, content) end
    if fs.open and fs.write and fs.close then
        local handle = fs.open(path, "w")
        fs.write(handle, content)
        fs.close(handle)
        return
    end
    error("No fs write function available")
end
local prettyPrint = false

local format = string.format

local function readfile(path : string) : string?
    assert(fs.exists(path), "invalid argument #1 to 'readfile', file does not exist.")

    local handle = fs.open(path, "r");
    local content = fs.read(handle)
    fs.close(handle)
    return content
end

local maxNum, tab, visited, callId = 2^64, "    ", {}, nil;

local beautifyHandlers = {
    table = function(data, tabs)
        if visited[data] then return "{ 'recursive table' }" end

        tabs = tabs or 1

        local out = "{\n"
        local p = string.rep(tab, tabs);

        visited[data] = true

        for i, v in next, data do
            --if i == "location" or i == "position" or i == "trailingtrivia" or i == "leadingtrivia" then continue end

            out ..= `{p}[{beautify(i, tabs + 1)}] = {beautify(v, tabs + 1)},\n`
        end

        visited[data] = false

        if #out == 2 then return "{}" end

        return out:sub(1, -3) .. "\n" .. string.rep(tab, tabs - 1) .. "}"
    end,
    string = function(data, style)
        if (style == 'block') then return format("[=[%s]=]", data) end

        return ('"' .. data:gsub("\\'", "'") .. '"')
    end,
    number = function(data)
        local str = tostring(data)
        if str == "nan" then return "0/0" elseif str == "inf" then return "math.huge" elseif str == "-inf" then return "-math.huge" end

        return str
    end
}

function beautify(data : any, ...) : string
    local type = typeof(data);

    local f = beautifyHandlers[type] or tostring
    return f(data, ...);
end

local function callFormat(...)
    return callId .. format(...)
end

local unparser = {}
local function readParams(statement)
    local code = "("

    local params = statement.parameters

    for i, param in params do
        code = code .. (i > 1 and ", " or "") .. unparser:readexpr(param)
    end
    if statement.vararg then
        code = code .. (#params == 0 and "" or ",") .. "..."
    end
    
    return code .. ")"
end

local function getValue(op, v1, v2)
    if op == "+" then return v1 + v2
    elseif op == "-" then return v1 - v2
    elseif op == "*" then return v1 * v2
    elseif op == "/" then return v1 / v2
    elseif op == "^" then return v1 ^ v2
    elseif op == "%" then return v1 % v2
    elseif op == ".." then return v1 .. v2
    elseif op == "//" then return v1 // v2
    elseif op == "and" then return v1 and v2
    elseif op == "or" then return v1 or v2
    elseif op == "==" then return v1 == v2
    elseif op == "~=" then return v1 ~= v2
    elseif op == ">" then return v1 > v2
    elseif op == "<" then return v1 < v2
    elseif op == ">=" then return v1 >= v2
    elseif op == "<=" then return v1 <= v2
    end
end

function unparser:construct(statement : table) : table
    if statement.istoken then
        return {
            class = "constant"
        }
    end

    if statement.kind == "stat" then --> statement
        return {
            class = "statement",
            kind = statement.tag
        }
    elseif statement.kind == "expr" then
        return {
            class = "expression",
            kind = statement.tag
        }
    end

    return {
        class = "other"
    }
end

function unparser:readstatement(statement, dontAddDo)
    local tag = statement.tag

    if tag == "local" then
        local code = "local ";
        for i, var in statement.variables do
            code = code .. (i > 1 and ", " or "") .. var.node.name.text
        end
        if #statement.values == 0 then return code end

        code = code .. " = "
        for i, val in statement.values do
            code = code .. (i > 1 and ", " or "") .. self:readexpr(val.node)
        end
        return code
    elseif tag == "assign" then
        local code = "";
        for i, var in statement.variables do
            code = code .. (i > 1 and ", " or "") .. self:readexpr(var.node)
        end
        code = code .. " = "
        for i, val in statement.values do
            code = code .. (i > 1 and ", " or "") .. self:readexpr(val.node)
        end
        return code
    elseif tag == "compoundassign" then
        return format("%s%s%s", self:readexpr(statement.variable), statement.operand.text, self:readexpr(statement.value))
    elseif tag == "expression" then
        return self:readexpr(statement.expression)
    elseif tag == "function" then
        local code = "function " .. self:readexpr(statement.name) .. readParams(statement.body)
        code = code .. self:readexpr(statement.body.body, true) .. "end"
        
        return code
    elseif tag == "block" then
        local code = dontAddDo and "" or "do "
        for _, stat in statement.statements do
            local str = self:readexpr(stat)
            code = code .. str .. (str ~= "..." and str:sub(#str) ~= ";" and ";" or "")
        end
        return code .. (dontAddDo and "" or "end;")
    elseif tag == "localfunction" then
        local code = "local function " .. self:readexpr(statement.name) .. readParams(statement.body)
        code = code .. self:readexpr(statement.body.body, true) .. "end"
        
        return code
    elseif tag == "conditional" then
        local code = format("if %s then %s", self:readexpr(statement.condition), self:readstatement(statement.thenblock, true))
        for _, elif in statement.elseifs do
            code = code .. format("elseif %s then %s", self:readexpr(elif.condition), self:readstatement(elif.thenblock, true))
        end

        if statement.elseblock then
            code = code .. format("else %s", self:readexpr(statement.elseblock, true))
        end

        return code .. "end"
    elseif tag == "while" then
        return format("while %s do %send", self:readexpr(statement.condition), self:readstatement(statement.body, true)) -- the str statement ends with ; so we can safely add 'end' right after, saving us a crazy 1 byte.
    elseif tag == "return" then
        if #statement.expressions == 0 then return "return" end

        local code = "return "
        for i, node in statement.expressions do
            code = code .. (i > 1 and ", " or "") .. self:readexpr(node.node)
        end
        return code
    elseif tag == "for" then
        local step = statement.step
        local code = format("for %s=%s,%s,%s do %send",
            statement.variable.name.text,
            self:readexpr(statement.from),
            self:readexpr(statement.to),
            step and self:readexpr(step) or "1",
            self:readstatement(statement.body, true)
        )
        return code
    elseif tag == "forin" then
        local code = "for "
        for i, node in statement.variables do
            code = code .. (i > 1 and ", " or "") .. node.node.name.text
        end
        local forin = ""
        for i, val in statement.values do
            forin = forin .. (i > 1 and ", " or "") .. self:readexpr(val.node)
        end

        code = code .. format(" in %s do %send", forin, self:readstatement(statement.body, true))
        return code
    elseif tag == "repeat" then
        return format("repeat %s until %s", self:readexpr(statement.body, true), self:readexpr(statement.condition))
    end

    print(beautify(statement))
    error("unsupported statement '" .. (statement.tag or "???") .. "'")
end

function unparser:readexpr(statement, ...)
    local expr = self:construct(statement)

    if expr.class == "statement" then
        return self:readstatement(statement, ...)
    elseif statement.istoken and not statement.tag then
        if statement.value ~= nil then return beautify(statement.value, statement.quotestyle) end

        return beautify(statement.text, statement.quotestyle)
    end

    local node = statement.node
    if node then statement = node end

    local tag = statement.tag or statement.kind;

    if tag == "number" then
        return statement.value or statement.text
    elseif tag == "string" then
        return beautify(statement.text, statement.quotestyle)
    elseif tag == "nil" then
        return "nil"
    elseif tag == "vararg" then
        return "..."
    elseif tag == "break" then
        return "break"
    elseif tag == "continue" then
        return "continue"
    elseif tag == "bool" or tag == "boolean" then
        return tostring(statement.value)
    elseif tag == "call" then --> call
        local code = self:readexpr(statement.func) .. "("
        for i, arg in statement.arguments do
            code = code .. (i > 1 and ", " or "") .. self:readexpr(arg.node)
        end
        return code .. ")"
    elseif tag == "local" or tag == "global" then --> variable name
        return (statement.name or statement.token).text
    elseif tag == "table" then
        local code = "{"
        local len = #statement.entries
        for i, entry in statement.entries do
            if entry.key then
                code = code .. format("[%s]=", self:readexpr(entry.key))
            end
            code = code .. self:readexpr(entry.value) .. (i ~= len and ";" or "")
        end

        return code .. "}"
    elseif tag == "binary" then --> comparison, math & eq
        local rhs = statement.rhsoperand
        local lhs = statement.lhsoperand
        local operator = statement.operator.text

        if not rhs.istoken or not lhs.istoken then --> Cant simplify, just return it raw (Or, apply the custom funcs)
            return format("%s %s %s", self:readexpr(lhs), operator, self:readexpr(rhs))
        end

        local value = getValue(operator, lhs.value, rhs.value)

        if typeof(value) == "number" and value >= maxNum then --> Results that are too large, for example 2^100 can break parsing.
            return format("%s%s%s", self:readexpr(lhs), operator, self:readexpr(rhs))
        end

        return beautifyHandlers.number(value) --> number beautifies booleans aswell
    elseif tag == "unary" then -- -, not, #
        local operator = statement.operator.text
        
        return format("%s(%s)", operator, self:readexpr(statement.operand))
    elseif tag == "group" then -- (...)
        return format("(%s)", self:readexpr(statement.expression))
    elseif tag == "indexname" then -- x.y
        return format("%s%s%s",
            self:readexpr(statement.expression),
            statement.accessor.text,
            statement.index.text -- indexname is always a constant
        )
    elseif tag == "index" then
        return format("%s[%s]",
            self:readexpr(statement.expression),
            self:readexpr(statement.index)
        )
    elseif tag == "function" then
        local code = "function" .. readParams(statement.body)

        code = code .. self:readexpr(statement.body.body, true) .. "end"
        
        return code
    elseif tag == "conditional" then
        local code = format("if %s then %s", self:readexpr(statement.condition), self:readexpr(statement.thenexpr))

        for _, elif in statement.elseifs do
            code = code .. format("elseif %s then %s", self:readexpr(elif.condition), self:readexpr(elif.thenexpr))
        end

        code = code .. format("else %s", self:readexpr(statement.elseexpr))
        return code
    elseif tag == "interpolatedstring" then
        local code = "`"
        local list = {}

        for _, str in statement.strings do
            table.insert(list, {
                kind = "string",
                at = str.position.column,
                expr = str.text
            })
        end

        for _, expr in statement.expressions do
            table.insert(list, {
                kind = "expr",
                at = (expr.position or expr.location.begin).column,
                expr = expr
            })
        end

        table.sort(list, function(a, b) return a.at < b.at end) --> works pretty well

        for _, v in list do
            if v.kind == "expr" then
                code = code .. format("{%s}", self:readexpr(v.expr))
            else
                code = code .. v.expr
            end
        end
        return code .. "`"
    end

    print(beautify(statement))
    error("unsupported expression '" .. (statement.tag or "???") .. "'")
end

local args = { ... }

local input = args[2]
local out = args[3]
callId = args[4] or ""

local lines = {}

local content = readfile(input)
--local s = os.clock()
for _, v in parser.parsefile(content).root.statements do
    lines[#lines+1] = unparser:readexpr(v)
end
--print("finished everything in",os.clock()-s,"seconds, file size:",#content / 1024,"kb.")

writeFileCompat(out, table.concat(lines, prettyPrint and "\n" or " "))