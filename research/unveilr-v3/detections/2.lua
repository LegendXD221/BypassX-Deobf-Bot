_G.coroutine = coroutine
local main = debug.getinfo(_G.coroutine.wrap)
if main.what == 'C' then
else
print('dtc')
end