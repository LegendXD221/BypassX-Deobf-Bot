[/ADD] Add actual implementations (Like LogService, RunService, ...) (PRIORITY 3)
[/ADD] Add support for a function's params being used outside of it, for example:
local x;
function main(a)
    x = a
end
function Callback()
    HumanoidRootPart.Size = Vector3.new(x, x, x)
end
[/ADD] Fix #jobid ~= 30
[/ADD] Add getrawmetatable & things like it (Make sure to make it work with stuff like setrawmetatable() to bypass detections.)
[/ADD] Add http requests & stuff (and add the chainer setting)
[/ADD] Creating too many instances causes performance drops, so...? (Only create stuff when needed!)
[/ADD] Add better control flow detection.. i have no clue how to do this
[/ADD] Fix events
[/ADD] Add http requests
[/ADD] Add :GetFullName()
[/ADD] add TweenInfo.
[/ADD] Make Heartbeat & RenderStepped run the given function 10 times (But don't log anything!)
[/ADD] Optimize CHECKOR and CHECKAND? Doing so will make stuff run at least 3x faster.
[/ADD] Remake prometheus if checks?

[BOT] Add limited finder tier 2
[BOT] Add a better obfuscator compiler
[BOT] Make premium users get a higher timeout number (freemium = 60; tier1 = 60 * 3 * 1; tier2 = 60 * 3 * 2)
[BOT] Make it so there's 1 lune child process per user, use `stdin`. (Idk what to do)

- change your mindset so mar does not keep getting mad at you

[BOT/STUFF]
+ Added recovery codes
+ Remade .help
+ Remade captchas
+ Fixed a few issues in .l
+ Fixed the issue where you can get to -1 credits

+ Added namecalls
+ Added support for ==, >= and other operators without hookOp
+ Added params
+ Added hookOp
+ Added too many operations
+ Added iterators
+ Added proper if checks
+ Added :Clone() & Instance.fromExisting
+ Added a working task.delay
+ Added task
+ Added task.defer & task.cancel
+ Added getgenv() & _G
+ Added a renamer, beautifier & a minifier.
+ `not not x` automatically becomes `x`, `-(-(x))` -> `x`, `x ~= true` -> `not x`, `x ~= false` -> `x` if minifier is on
+ Fixed upvalues
+ Optimized hookOp
+ Fixed for loops
+ Added constant collection
+ Added lua setting
+ Added missing libraries (Might need to modify the code though, they might have some vulns / bugs)
+ Added if checks to prometheus
+ Added automatic luraph decompression
+ Added IsA (ADD game.IsA(Instance, ...) NEXT)
+ Fixed a rare case in hookOp where loadstring("a")() would call the loadstringed thing with the error message as the first arg 
+ Added interpolated strings