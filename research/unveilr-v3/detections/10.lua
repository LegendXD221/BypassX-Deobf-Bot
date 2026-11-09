local x = getmetatable(__call)
x = 534525252

local main = debug.info(x, 'l')
if main == nil then
    print('valid')
    else
    print('dtc')
end