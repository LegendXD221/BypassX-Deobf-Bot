local a, b = pcall(function()loadstring("abc")()end)
if a then
 print('meow')
 return
end
if not b then
 print('meow')
 return
end
print('yay')