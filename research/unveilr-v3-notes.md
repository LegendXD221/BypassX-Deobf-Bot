# unveilr-v3 Extraction Notes — Intel for the Biggest Scan

Source: `research/unveilr-v3/restored_files/` (extracted from
`research/dumper-and-env-loggers/Threaded/unveilr-v3-owo.rar`, 581 files, 62 MB).
Archive owner is the UnveilR V3 bot ("Threaded"), which is the same product class as
BypassX-Deobf-Bot: a Discord bot that deobfuscates Luraph / MoonSec / Prometheus /
IronBrew / 25ms / wearedevs scripts and returns readable Lua. Everything below was
read directly from the extracted sources.

## 1. Why this package matters for the Biggest Scan

UnveilR V3 is the most complete *runtime-trace* deobfuscator we have ever had access
to. Its core idea (and the one we should adopt) is:

> Don't statically deobfuscate the VM. Instead, run the obfuscated script inside a
> fake Roblox/executor environment, instrument every expression, and rebuild a
> human-readable AST from what actually executed.

That is exactly the missing piece for our "full deobf not half" goal on VM targets
(Luraph V14/V15.1, MoonSec V1/V2/V3 escrow): our existing pipeline decrypts
constants/opcodes statically; unveilr additionally recovers *control flow and
behavior* by execution.

## 2. Proven architecture (verified in code)

```
input (.lua / Luau bytecode)
  └─ magic-byte check: A==6,B==3,C==159,D==1  → Luau bytecode  (main.luau:5505)
  └─ UseHookOp(Code, File)                    → mods/hookOpV2.luau
       Lune @std/syntax/parser → AST walk → rewrite every expr into CALLID..CHECK*(...)
       binary map: and→CHECKAND or→CHECKOR >→COMPG <→COMPL >=→COMPGE <=→COMPLE
                   ==→CHECKEQ ~=→CHECKNEQ ..→CONCAT
       unary map:  #→CHECKLEN -→CHECKUNM not→CHECKNOT
       if/while/for bodies wrapped in CHECKIF(cond,id,elseId) / CHECKIFEND(id)
  └─ compile(Code, {optimizationLevel=2}) + loadstring   (Luau compile, main.luau:5548)
  └─ EnvLog(Loaded, 0)  → runs it inside the fake env (env/*.lua + main.luau SecureEnv)
       every CHECK* call writes REAL behavior back into an output AST:
       - CHECKIF:  records branch as AST comments `ran, if id: N` / `didnt run (else)`
       - CONCAT:   folds decrypted string constants into ConstantList
       - CALL:     records calls on nil/number, hooked functions, LPH_CRASH
       - loop/branch cutoff: same condition used ≥20 times → break loop (anti-inf-loop)
  └─ AstLib.Minify + Stringify → readable Lua out (comments, decrypted constants,
       renamed vars, discord-invite stripping, "http GET requests sent to" header)
```

Entry point: `lune run main <in> out=<file> [settings]` (see `detections/run.luau`).

## 3. Per-obfuscator weaknesses (author's own notes + engine code)

Directly lifted from `notes.md` (author's debug diary) and cross-checked in
`main.luau` / `hookOpV2.luau`. These are battle-tested — the exact failure modes and
bypasses for each obfuscator's anti-tamper, straight from a competitor that made all
of them work.

### MoonSec (V1/V2/V3 escrow)
- **getfenv is the #1 cause of failure.** Constant-encrypted MoonSec reads its
  constants through `fenv["<binary garbage>"][1]`; if our fake `getfenv()` doesn't
  return the *same spied table* the script sees, constants turn to garbage.
- **"attempt to perform arithmetic (mul) on nil and number"** → their `wait` shim
  must return a number (not nil). Our env must make `task.wait/wait` return elapsed.
- **"attempt to call a table value"** → `DefineTable` handling (table constructors
  must be spied before use).
- **"attempt to call a number value"** → hookOp's CALL() misfires; check arg replay.
- **MoonSec skid-detection**: `setfenv(func, {})` — if it does NOT error, the
  function is a Lua closure (their C-closure detector). Bypass: make `setfenv`
  error on our C-backed natives exactly like real Luau does.
- **`__type` / `__tostring` in output** → a `print` was spied; strip metamethods from
  printed values.
- **MoonSec for-loop desugar**: they compile `for i = x, y` into
  `local i = 0; while true do if i < y then break end end` — our branch-cutoff logic
  must not break on this pattern.
- **If detected, make setfenv look normal** (do not hook it visibly).
- **MoonVeil shares the CHECKINDEX failure mode with Luraph.**

### Luraph (V14/V15.1)
- **setfenv is everything.** Notes, all-caps: *if Luraph is not working, setfenv is
  broken*. Must IGNORE any `setfenv(0/1, fenv)` whose env already is the fake env —
  Luraph uses it to crash the tracer.
- **`tostring == 45195195` check**: Luraph fingerprints the env by stringifying
  functions; loadstring must return a proper Luau-style error message
  (`[string "..."]:N: ...`) or the check trips.
- **`loadstring("rf")` in output** = bug in CHECKOR (was calling runtime functions
  when evaluating `or`); fix: CHECKAND/CHECKOR must never call functions at runtime —
  substitute `function() end` when a call is detected.
- **Nested Luraph VM chunks** (`return(function(` signature) get re-intercepted —
  same technique as the 25ms dumper in the dumper repo.
- **`LPH_CRASH()`** is explicitly detected and turned into a comment
  (main.luau:3728, 4477).
- **coroutine.yield is the Luraph tell**: they flag `Luraph = true` when the script
  yields — used to switch per-obfuscator behavior (main.luau:3941).
- Auto-decompression signature (commented out but instructive):
  `"(does your environment support load/loadstring?"` +
  `"Luraph decompression error: "` — Luraph-compressed payload tell-tales.
- **"Fixed a rare case where loadstring("a")() would call the hook with the error
  message as first arg"** — replay args only on success, else propagate error.

### Prometheus
- **VM structure**: `while true do pc = 1234; if pc == 1234 then pc = 5678 else
  <branch that resets pc> end end` — the control-flow-flattened dispatch. Branch
  tracing (CHECKIF + comments) un-flattens it automatically.
- **Variable comparison heuristic** (main.luau:1743): `typeof(y)=="number" and
  y > 10000` flags Prometheus obfuscated variables — numeric compares on huge
  constants are VM register ops, log them but don't treat as real comparisons.
- **Logging threshold**: a variable must be compared ≥6 times before it gets logged
  as meaningful (main.luau:2302) — cuts noise massively.
- **Base64 constants**: "Fixed constant collection including base64 strings
  (Prometheus thing)" — don't dump the raw base64 pool, dump decoded values.

### 25ms
- **Antitamper**: checks `game`, `workspace`, `CFrame` existence → then tries the
  `task` lib (falls back to `spawn()`), skips check entirely if env is bare.
  Bypass = provide real-looking game/workspace/CFrame + working task lib.
- Sample `38errors.lua` is a 25ms-obfuscated file (credit string
  `obfuscator @ discord.gg/25ms`, base64 constant pool) — usable as fixture.

### IronBrew 1
- "missing argument #3" → `rawset` shim wrong.
- "not working AT ALL" → `pcall` shim broken (must behave like real pcall incl.
  error object identity).

### wearedevs
- Their obfuscator emits junk globals: env must force-nil `package`, `inf`
  (main.luau:588 `ForceNil`), and arithmetic-on-unm error strings get rewritten
  (main.luau:4538).
- Sample: top-level `deobfuscate.lua` = wearedevs obfuscator v1.0.0 sample
  (`--[[ v1.0.0 https://wearedevs.net/obfuscator ]]` header) — fixture material.

## 4. Anti-detection catalog (steal wholesale)

`detections/1.lua`–`13.lua` + `alr_dev1.lua` = the obfuscators' environment
fingerprint checks, one per file. Examples:
1. `Instance.new("Part").name` must error (case-sensitive `Name` in real Roblox);
2. `debug.getinfo(closure).what == 'C'` check on coroutine.wrap;
3. `getrawmetatable(game).__metatable == getmetatable(game)`;
4. `workspace.CurrentCamera.CFrame:Inverse()` must pcall;
5. `Vector3:FuzzyEq` must exist and work;
6. `type(LocalPlayer)=="userdata" and typeof(...)=="Instance"` + `.Name/.Parent` chain;
7. `task.spawn`/`task.cancel` thread identity;
8. `require("@lune/fs")` must NOT succeed (executor tell!);
9. `loadstring("abc")()` must error;
10. `debug.info(x, 'l')` on tampered values must be nil;
11. metatable pass-through equality;
12. `UDim2.fromOffset(10,5).X.Offset == 10`;
13. fresh `Enum().PartType.Cylinder.Name == "Cylinder"`.

Each has a working bypass in `main.luau` + `env/*`. Port these 13 checks as our
**env-sanity test suite** for the `.l` backend (goal: all 13 pass in our fake env).

## 5. Executor globals catalog (`env/Exec.lua`)

Full fingerprint list of a real executor env, categorized by `type()`:
~330 function names (getgenv, hookfunction, iscclosure, getscriptbytecode, crypt.*,
Drawing, WebSocket.connect, queueonteleport, ...), table globals (Delta, Drawing,
bit, base64, crypt, debug, http, shared, Color3, Vector3, TweenInfo, ...), number
globals (DELTA_VERSION_NUM, Drawing.Fonts.*). Obfuscators walk these to detect fake
envs — our fake env must expose (and log-access to) the same surface.

## 6. Sandbox recipe (prod-proven, directly portable to Render)

`sandbox/Dockerfile`:
- `node:20-slim` (same base as us) + `lua5.4`
- **rokit** installs **lune** (Lune runtime) + **lute** into `/usr/local/bin`
- works on linux x64, no display, no Roblox — proves Lune executes these scripts in
  a bare container. (`lute.exe` in archive is the Windows build; official lune
  releases are on GitHub.)

This validates our Render deployment path for `.l` / env-logging: install lune via
rokit in our Dockerfile, ship `main.luau`-style engine, invoke as child process.

## 7. Directly reusable code

| File | What it gives us |
| --- | --- |
| `mods/hookOpV2.luau` (839 lines) | complete AST→CHECK* instrumenter (latest variant) |
| `mods/hookOp.luau`, `mods/hookOpButNotReally.luau` | older/simpler variants — fallback paths |
| `mods/ast.luau` (63KB) | AST builder: addStatement, ExprToCode, Stringify, Minify |
| `modules/unparser-hookop.luau` / `unparser.luau` | readable-output unparser (tabbing, params, vararg) |
| `main.luau` (5604 lines) | SecureEnv runtime: CHECKIF/CALL/CONCAT/NAMECALL, Spy, branch cutoffs, per-obfuscator heuristics |
| `env/*.lua` (Exec, genv 623L, instances, Services, Enum, datetime, terrain, base64) | fake Roblox+executor env, incl. `HiddenProperties.lua`, `Garbage.lua` (junk-string filter `NON_ENGLISH = "[\0-\31\189-\255{}]"`) |
| `modules/lua_beautifier.js`, `minify.js`, `rename.js` | JS-side output polish (18.7KB beautifier) |
| `modules/lua_deobf.js`, `config.js` | bot-side orchestration glue |
| `detections/*.lua` | 13-test anti-detection suite (see §4) |
| `luraph/*.txt` (12 samples, 3.2MB) | Luraph corpus incl. anticheat samples — new fixtures |
| `detections/` inputs + `38errors.lua` (25ms), `deobfuscate.lua` (wearedevs) | per-obfuscator fixtures |
| `apidump.json` (2.2MB) | full Roblox API dump for env construction (classes/props/members) |
| `bot.db`, `botStats.json` | competitor feature telemetry (what users run through .l) |
| `TODO.md`/`TODO.txt` | their roadmap & changelog — tells us what still breaks for them (our edge) |

Not reusable / ignored: `konstant/lua.lua` = client for a third-party paid decompiler
API (`api.plusgiant5.com`) — network-locked, noted for awareness only. `bin/lune-linux/`
empty in archive (fetch official lune release instead). Lunr `.env` from the dumper
repo still off-limits (real keys).

## 8. What they admit is still broken (our openings)

From TODO/changelog: control-flow detection "no clue how to do it"; events broken;
CHECKOR/CHECKAND 3x speed possible; too many instances → perf drop; "Remake
prometheus if checks?"; task library no longer functions correctly (accuracy trade);
getconnections removed as "really annoying". Their dump outputs show
`pcall(setmetatable, game, {})`-style antitamper residue leaking into output.
⇒ Biggest Scan focus: MoonSec escrow full-readable acceptance + Prometheus
pc-flattening un-flattening via branch comments are both *proven feasible* — the
technique is here, the QA polish is what's missing.

## 9. Recommended integration order

1. **Env-sanity suite first**: port `detections/1..13` as `test/env-sanity.js` driver
   over a Lua child process (validates any env we build, before any obfuscator work).
2. **`.l` backend v0**: lune + trimmed hookOpV2 + SecureEnv subset (CHECKIF/CALL/
   CONCAT/NAMECALL only) → get MoonSec V1 scripts to run and dump constants+branches.
3. **Fixtures**: mine `luraph/` 12 samples + `38errors.lua` + `deobfuscate.lua` +
   dumper-repo `larry old src/` corpus into `test/fixtures/` for regression runs of
   the 15 live prefix commands.
4. **Unparser polish**: adopt `modules/unparser-hookop.luau` naming heuristics
   (`ScreenGui.Name = "hi"` → var named `hi`; `Color3.fromRGB` compression) for
   human-readable output parity.
5. **Then** attack Biggest Scan targets with combined static (our pipeline) +
   dynamic (this engine) passes — static decrypts constants, dynamic resolves
   branches; merge both ASTs.
