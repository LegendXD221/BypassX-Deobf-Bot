local myfunc = task.spawn(function() end)
task.cancel(myfunc)
if type(myfunc) == 'thread' then
print('ud')
else
print('dtc')
end