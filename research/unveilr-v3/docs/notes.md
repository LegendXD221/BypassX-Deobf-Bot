> if you get an 'attempt to perform arithmetic (mul) on nil and number' in moonsec, it's because 'wait' is not returning anything.
> if you get '__type' and '__tostring', its because of a print.
> the issue in moonsec when "attempt to call a table value" is because of DefineTable

> If check structure: if x then pointer = pointer + 1 else ... end, thats why checkifend doesnt work very well.
> if you get detected in moonsec, make sure setfenv is normal
> making 'Beautify' a global function breaks everything?
> if luraph isn't working, make sure loadstring & setfenv are.

> how 25ms' antitamper works:
> it checks if game, workspace or CFrame exist, if so then it tries to use the task lib, otherwise it just skips that check entirely (And it also tries to use spawn())
> now, im not sure how the task lib checks work.

> if with moonsec constant encryption you get weird vars like fenv["�B\21I#\25=\281#I\286&;:"][1], make sure getfenv() is working correctly (Thats the main issue.)
> regarding the UI library detections, heres a few things to know:
    UI libraries can ONLY be loaded from urls (Nobody places the raw content in their script), so rule out ANY other possibility. (Apparently yes they do in luraph 😭😭😭)
    Most of them use CoreGui (I think all, actually.)

> If you get 'attempt to call a number value' in moonsec, make sure hookOp's CALL() is working properly.
> MoonSec's for i = x, y:
    local i = 0 (or probably x, idk) while true do if i < y then break end end
> Luraph's tostring == 45195195: make sure loadstring is returning a proper error message.

> If MoonSec says that you're a skid, make sure loadstring is a proper C function
> The way moonsec detects C functions is by doing setfenv(func, {}), if it does not error then it's a lua function.
> If the 'or' or 'and' operator is broken, make sure CHECKAND does not call functions at runtime, if a call is detected use function()end

> If MoonVeil doesn't run, it's due to CHECKINDEX (Same goes for luraph)
> If you see loadstring("rf") in Luraph, it's due to an issue in CHECKOR in hookOp.

> If there's a bug where the code gets repeated 4 times or :connect(function()end) isn't outputting properly, make sure Signals are working well.
> If the performance dropped DRASTICALLY, make sure the SafeWrap function isn't recursively checking the args.

> If the code looks like it's repopulating, make sure task is working fine.
> If you get an 'attempt to yield across ...' error, make sure you're not trying to write a file or call something that takes more than 0.01 seconds to run.

> If LuaObfuscator.com isn't working, make sure unary (-, # and not) aren't broken.
> If MoonSec or luraph say 'invalid argument #1 to 'char', invalid value' its an issue in hookOp (Make sure you're not returning incorrect numbers??)

> If you get a 'missing argument #3' on ib1, it's probably rawset.
> If ib1 is not working AT ALL, make sure pcall is fine!
> If performance is HORRIBLE, it's probably due to COMPG, COMPL, COMPGE, COMPLE.
> If you get 'attempt to index nil with gmatch', its either an issue in `setfenv` (I dont care what you think, review it VERY VERY clearly.) or an issue in `CHECKOR`

# IF LURAPH IS NOT WORKING, MAKE SURE SETFENV IS WORKING FINE! (MAKE SURE TO IGNORE ANY SETFENV CALL WHO'S ENV IS FENV (GETFENV()), AS IT CAN BE USED BY LURAPH TO CRASH???????)

> Prometheus' while true do:
> pc = 1234
> if pc == 1234 (enum solved) then
> pc = 5678
> else
> --> sum code that does pc = 1234
> end