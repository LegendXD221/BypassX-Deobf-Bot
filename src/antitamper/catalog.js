/**
 * BypassX Deobf Bot — AntiTamper V2 vector catalog.
 *
 * The intelligence database. Every known anti-tamper / integrity-check /
 * environment-validation vector used by the 16 supported obfuscator families
 * (and by generic leaked detection suites) lives here as a structured record:
 *
 *   id        stable identifier
 *   family    technique group (drives escalation strategy + reply wording)
 *   name      human-readable vector name
 *   severity  1 (cosmetic probe) … 5 (kills the run / poisons decrypt keys)
 *   signals   case-insensitive source regexes that flag the vector in a sample
 *   goal      'static'  — the neutralizer can defuse it before any run
 *             'dynamic' — the environment layer must answer it correctly
 *             'both'    — defense in depth
 *   counter   how our engine answers it:
 *               neutralize  — AST/regex defuse (kill switch removed)
 *               env         — jail answers the probe with production shape
 *               escalate    — re-run under an executor identity profile
 *   note      why the vector exists and what our counter buys
 *   source    where the vector was documented (research provenance)
 *
 * Sources: UNC NamingStandard (UNCCheckEnv.lua, 7 check categories), sUNC
 * behavioral suite (~8k lines of behavior-level checks), aihkw/exe-test
 * executor_vuln_test.lua (precise Luau error strings per dangerous service),
 * pqr-692/Roblox-Detections (defender techniques — each maps to one of our
 * counters), Luraph official macro documentation (LPH_* family incl.
 * LPH_PRECHECK semantics), and the vendored unveilr-v3 research notes
 * (research/unveilr-v3-notes.md) cross-referenced with our own Biggest-Scan
 * A/B results recorded in WorklogBot.md.
 */

export const CATALOG = [
  // ---- luraph-lph: the LPH macro family -----------------------------------
  {
    id: 'lph-crash', family: 'luraph-lph', name: 'LPH_CRASH kill switch', severity: 5,
    signals: ['\\bLPH_CRASH\\s*\\(', '\\bLPH_CRASH\\s*='],
    goal: 'static', counter: 'neutralize',
    note: 'Deliberate crash macro. Compiles to a hard abort at the marker site; under Luraph v14+ its body derives from the un-tampered build, so any environment edit turns it into a kill. Removed before the run — a crash macro has zero informational value for us.',
    source: 'lura.ph macro docs (changelog index) + LPH family table',
  },
  {
    id: 'lph-precheck', family: 'luraph-lph', name: 'LPH_PRECHECK environment validator', severity: 5,
    signals: ['\\bLPH_PRECHECK\\s*\\(', '\\bfunction\\s+LPH_PRECHECK\\b'],
    goal: 'static', counter: 'neutralize',
    note: 'Embeds a whitelist / anti-tamper / environment validation whose failure PREVENTS execution — the decrypted payload only makes sense when validation ran un-tampered. We empty the function body so every caller invokes a no-op; the decrypt path then runs under our (possibly escalated) env without the validator gating it.',
    source: 'lura.ph docs: "embed whitelist, anti-tamper, or environment validation whose failure prevents execution"',
  },
  {
    id: 'lph-encstr', family: 'luraph-lph', name: 'LPH_ENCSTR wrapper (legit construct)', severity: 1,
    signals: ['\\bLPH_ENCSTR\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'NOT a kill switch — a compiled decrypt wrapper. Stripping it would destroy the payload. Our load()-chunk capture already recovers what it decrypts; the env must simply keep the wrapper running.',
    source: 'Luraph macro family table',
  },
  {
    id: 'lph-encnum', family: 'luraph-lph', name: 'LPH_ENCNUM wrapper (legit construct)', severity: 1,
    signals: ['\\bLPH_ENCNUM\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Numeric decrypt wrapper — same rule as lph-encstr: never strip, let it run, harvest the output.',
    source: 'Luraph macro family table',
  },
  {
    id: 'lph-encfunc', family: 'luraph-lph', name: 'LPH_ENCFUNC wrapper (legit construct)', severity: 1,
    signals: ['\\bLPH_ENCFUNC\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Function-body encryptor macro; runs as a wrapper. Env-layer concern only.',
    source: 'Luraph macro family table',
  },
  {
    id: 'lph-jit', family: 'luraph-lph', name: 'LPH_JIT / LPH_JIT_MAX hints', severity: 1,
    signals: ['\\bLPH_JIT_MAX?\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'JIT hint wrappers. Harmless in our jail; must not be stripped (they may carry payload code as arguments).',
    source: 'Luraph macro family table',
  },
  {
    id: 'lph-no-virtualize', family: 'luraph-lph', name: 'LPH_NO_VIRTUALIZE marker', severity: 1,
    signals: ['\\bLPH_NO_VIRTUALIZE\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Marks a region to skip VM serialization. Its argument is real code — always executed, never stripped.',
    source: 'Luraph macro family table',
  },
  {
    id: 'lph-no-upvalues', family: 'luraph-lph', name: 'LPH_NO_UPVALUES marker', severity: 1,
    signals: ['\\bLPH_NO_UPVALUES\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Upvalue-hoisting hint; argument is real code.',
    source: 'Luraph macro family table',
  },
  {
    id: 'luraph-tostring-magic', family: 'luraph-lph', name: 'tostring fingerprint 45195195', severity: 4,
    signals: ['45195195'],
    goal: 'dynamic', counter: 'escalate',
    note: 'Known Luraph fingerprint: a magic number compared against tostring output of an executor-native object; mismatch flips a flag that degrades or kills the run. Our jail must produce a matching shape or the run escalates to an executor profile.',
    source: 'unveilr-v3 notes (Luraph section)',
  },
  {
    id: 'luraph-v14-keygate', family: 'luraph-lph', name: 'v14 runtime-state key gate', severity: 4,
    signals: ['bit32\\.bxor\\s*\\([^,]{1,40},', 'LPH_ENCSTR.{0,80}loadstring'],
    goal: 'dynamic', counter: 'env',
    note: 'v14 decrypt keys derive from un-tampered runtime state (clock, tostring shapes, table lengths). Env must return production-shaped values or the pool decrypts to garbage — the exact failure our 2.11.0 advancing-clock exploit fixed.',
    source: 'v2.6.0 devirtualizer research + WorklogBot 2.11.0',
  },

  // ---- executor-whitelist: identity gating ---------------------------------
  {
    id: 'exwl-identifyexecutor', family: 'executor-whitelist', name: 'identifyexecutor() whitelist', severity: 4,
    signals: ['\\bidentifyexecutor\\s*\\(', '\\bidentifyexecutor\\b[^\\n]{0,60}=='],
    goal: 'both', counter: 'escalate',
    note: 'Script refuses to run unless identifyexecutor() names a known executor. Production shape (nil) fails the whitelist → run escalates to an executor identity (Synapse Z / Script-Ware / Krnl rotation).',
    source: 'UNC Closures category + executor_vuln_test.lua',
  },
  {
    id: 'exwl-getexecutorname', family: 'executor-whitelist', name: 'getexecutorname() gate', severity: 4,
    signals: ['\\bgetexecutorname\\s*\\('],
    goal: 'both', counter: 'escalate',
    note: 'Alternate identity probe (Script-Ware style). Same rotation countermeasure.',
    source: 'UNC Closures category',
  },
  {
    id: 'exwl-name-compare', family: 'executor-whitelist', name: 'executor name string compare', severity: 4,
    signals: ['(synapse|script.?ware|krnl|fluxus|hydrogen|oxygen.?u|sentinel|protosmasher|delta|solara)[^\\n]{0,40}(==|~=|find|lower|match|gsub)'],
    goal: 'both', counter: 'escalate',
    note: 'Direct name comparison against a known executor list — often lowercased. Identity rotation answers it; the neutralizer also defuses the paired kill switch when the consequent is error/while-true.',
    source: 'executor_vuln_test.lua + common whitelist builds',
  },
  {
    id: 'exwl-checkcaller', family: 'executor-whitelist', name: 'checkcaller() thread gate', severity: 3,
    signals: ['\\bcheckcaller\\s*\\(', 'not\\s+checkcaller\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'true when the caller is an executor thread. Anti-tamper patterns require it true (executor context) or use `not checkcaller()` to detect game threads. Executor profile returns true.',
    source: 'UNC Closures category',
  },
  {
    id: 'exwl-whitelist-table', family: 'executor-whitelist', name: 'executor whitelist table scan', severity: 3,
    signals: ['whitelist\\s*=\\s*\\{[^}]{0,400}(synapse|script.?ware|krnl)', 'allowed.{0,20}=.{0,20}\\{.{0,200}(executor|synapse)'],
    goal: 'both', counter: 'escalate',
    note: 'A literal table of accepted executor names scanned with string.find/match. Rotation + name compare coverage.',
    source: 'common whitelist builds',
  },
  {
    id: 'exwl-file-wait', family: 'executor-whitelist', name: 'executor file presence gate', severity: 3,
    signals: ['\\bisfile\\s*\\(\\s*["\']', '\\breadfile\\s*\\(\\s*["\']'],
    goal: 'dynamic', counter: 'env',
    note: 'Checks for executor workspace files (settings, markers). Executor profile ships an in-memory filesystem answering isfile/readfile with executor-shaped results.',
    source: 'UNC Filesystem category',
  },
  {
    id: 'exwl-cloneref-require', family: 'executor-whitelist', name: 'cloneref/compareinstances probe', severity: 3,
    signals: ['\\bcloneref\\s*\\(', '\\bcompareinstances\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'cloneref must return a distinct reference to the same object and compareinstances must distinguish them — the UNC Cache category pair. Executor profile implements both.',
    source: 'UNC Cache category',
  },
  {
    id: 'exwl-getgenv', family: 'executor-whitelist', name: 'getgenv() executor-env probe', severity: 3,
    signals: ['\\bgetgenv\\s*\\(', 'getgenv\\s*\\(\\s*\\)\\s*=='],
    goal: 'dynamic', counter: 'env',
    note: 'Executor profile: getgenv() returns the shared executor globals table (distinct from getrenv()); writes must land in _G.',
    source: 'UNC Scripts category',
  },

  // ---- env-probe: environment validation -----------------------------------
  {
    id: 'env-placeid', family: 'env-probe', name: 'game.PlaceId / GameId shape check', severity: 3,
    signals: ['game\\.PlaceId', 'game\\.GameId', 'game:\\s*GetService\\s*\\(\\s*["\']Players'],
    goal: 'dynamic', counter: 'env',
    note: 'Scripts validate they run in a real game. Jail returns real-shaped numbers (PlaceId 18774239…). Production shape since 1.8.0.',
    source: 'jail-prelude 1.8.0 + UNC Instances',
  },
  {
    id: 'env-isstudio', family: 'env-probe', name: 'RunService Is* probe matrix', severity: 4,
    signals: ['IsStudio\\s*\\(', 'IsEdit\\s*\\(', 'IsRunMode\\s*\\(', 'IsClient\\s*\\(', 'IsServer\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'IsStudio/IsEdit/IsRunMode/IsServer must be false, IsClient true — a truthy Studio answer feeds garbage keys into MoonSec escrow. Pinned by env-sanity A11.',
    source: 'jail-prelude 1.8.0 + MoonSec escrow research',
  },
  {
    id: 'env-game-loaded', family: 'env-probe', name: 'game.Loaded yield gate', severity: 3,
    signals: ['game\\.Loaded', 'while\\s+not\\s+game\\.Loaded'],
    goal: 'dynamic', counter: 'env',
    note: 'Init loops wait on game.Loaded. Jail resolves instantly (v2.8.0 yielding primitives) so the instruction budget is not burned on one gate.',
    source: 'jail-prelude 2.8.0',
  },
  {
    id: 'env-setfenv-skid', family: 'env-probe', name: 'setfenv(suspect, {}) skid detector', severity: 5,
    signals: ['setfenv\\s*\\([^)]{0,40},\\s*\\{\\s*\\}\\s*\\)', 'pcall\\s*\\(\\s*setfenv'],
    goal: 'dynamic', counter: 'env',
    note: 'MoonSec fingerprints naively-jailed environments: setfenv on a C closure MUST error ("cannot change environment of given object"), a silent no-op exposes the jail. Pinned by env-sanity A-suite.',
    source: 'v2.11.0 leaked-corpus exploit + unveilr-v3 notes (MoonSec)',
  },
  {
    id: 'env-getfenv-pair', family: 'env-probe', name: 'getfenv/setfenv same-table check', severity: 4,
    signals: ['getfenv\\s*\\(', 'setfenv\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'MoonSec requires getfenv/setfenv to agree on the same table. Our pairing is deliberately shaped (getfenv → _G; setfenv real for _ENV upvalues) — verified across the MoonSec corpus.',
    source: 'unveilr-v3 notes (MoonSec getfenv requirement)',
  },
  {
    id: 'env-nil-resurrection', family: 'env-probe', name: 'nil-assigned library resurrection probe', severity: 5,
    signals: ['pcall\\s*\\(\\s*require', 'require\\s*\\(\\s*["\']@', 'io\\.?read', 'loadfile\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'A polyglot __index that resurrects removed libraries (io/package/require) as callable objects is an instant executor tell (leaked detection 8 fingerprints exactly this). NILPROBE keeps them reading nil; pcall(require,…) must fail.',
    source: 'unveilr-v3 detection 8 + v2.12.0 env-sanity',
  },
  {
    id: 'env-garbage-globals', family: 'env-probe', name: 'wearedevs garbage-global nil check', severity: 3,
    signals: ['_G\\s*\\.\\s*[A-Z]\\w+\\s*=\\s*nil', 'rawset\\s*\\(\\s*_G'],
    goal: 'dynamic', counter: 'env',
    note: 'Skid loaders pollute _G with junk globals then check their presence. Production shape: absent globals stay nil after nil-assignment; our polyglot must not resurrect them.',
    source: 'unveilr-v3 notes (wearedevs)',
  },
  {
    id: 'env-string-dump', family: 'env-probe', name: 'string.dump presence check', severity: 3,
    signals: ['string\\.dump'],
    goal: 'dynamic', counter: 'env',
    note: 'Production Luau disables string.dump — its presence is an executor tell. Jail nil-assigns it; env-sanity pins the nil read.',
    source: 'jail-prelude + UNC',
  },
  {
    id: 'env-task-library', family: 'env-probe', name: 'task library surface check', severity: 2,
    signals: ['task\\.wait', 'task\\.defer', 'task\\.cancel', 'task\\.bindings'],
    goal: 'dynamic', counter: 'env',
    note: 'task.wait must return a number and spawn/defer/delay must run their function; task.cancel exists on real Luau (v2.12.0). Instant resolution keeps escrow gates terminating.',
    source: 'jail-prelude 2.8.0/2.12.0',
  },
  {
    id: 'env-clock-advance', family: 'env-probe', name: 'frozen-clock deadlock probe', severity: 5,
    signals: ['os\\.clock\\s*\\(\\s*\\)', '\\btick\\s*\\(\\s*\\)', 'os\\.time\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'env',
    note: 'A frozen clock deadlocks `while os.clock()-t < X do end` gates (MoonSec V3 escrow init). Clocks advance ~10ms/call so gates terminate inside the instruction budget.',
    source: 'v2.11.0 leaked-corpus exploit',
  },
  {
    id: 'env-buffer-lib', family: 'env-probe', name: 'Luau buffer library binding', severity: 3,
    signals: ['\\bbuffer\\s*\\.\\s*(create|fromstring|readu8|writeu32|readf32)'],
    goal: 'dynamic', counter: 'env',
    note: 'Luraph v15.1+ loaders bind buffer at init; absence killed loaders before 2.14.0. Full read/write surface including readbits/writebits.',
    source: 'v2.14.0 loader exploit',
  },
  {
    id: 'env-bit32-floats', family: 'env-probe', name: 'bit32 float-input semantics', severity: 4,
    signals: ['bit32\\.bxor', 'bit32\\.band', 'bit32\\.lshift'],
    goal: 'dynamic', counter: 'env',
    note: 'Luau bit32 reduces every input mod 2^32 (floats floored). Lua 5.3 native ops demand integers — v15 decrypt arithmetic feeds floats; the __n32 normalization keeps loaders alive.',
    source: 'v2.14.0 loader exploit (live-verified)',
  },
  {
    id: 'env-debug-info', family: 'env-probe', name: 'debug.info presence', severity: 2,
    signals: ['debug\\.info\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Every executor has Luau debug.info; fengari 5.3 lacks it. Nil-returning shim keeps probes alive without leaking fake line numbers.',
    source: 'v2.12.0 (leaked detection 10)',
  },
  {
    id: 'env-metatable-locked', family: 'env-probe', name: 'setmetatable(game, {}) lock probe', severity: 4,
    signals: ['setmetatable\\s*\\(\\s*game', 'getmetatable\\s*\\(\\s*game\\s*\\)'],
    goal: 'dynamic', counter: 'env',
    note: "A pcall(setmetatable, game, {}) that SUCCEEDS is a jail tell (production DataModel resists re-metatable). V2 locks game's metatable: getmetatable(game) == 'The game' exactly like live Roblox, setmetatable errors.",
    source: 'pqr-692 IndexCheck family + Roblox DataModel semantics',
  },
  {
    id: 'env-gc-probe', family: 'env-probe', name: 'getgc() scan for dumpers', severity: 3,
    signals: ['\\bgetgc\\s*\\(\\s*true\\s*\\)', '\\bgetgc\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'escalate',
    note: 'Scans the GC heap for dumper artifacts / foreign closures. Executor profile returns a populated table; production reads nil.',
    source: 'UNC Scripts category (getgc)',
  },
  {
    id: 'env-genv-poison', family: 'env-probe', name: 'genv write-persistence check', severity: 2,
    signals: ['getgenv\\s*\\(\\s*\\)\\s*\\.\\s*\\w+\\s*=', 'getgenv\\s*\\(\\s*\\)\\s*\\['],
    goal: 'dynamic', counter: 'env',
    note: "Writes through getgenv() must persist and read back (scripts stash decrypt state there across loadstring calls). genv = _G guarantees persistence.",
    source: 'UNC Scripts category',
  },

  // ---- closure-integrity ----------------------------------------------------
  {
    id: 'cl-islclosure', family: 'closure-integrity', name: 'islclosure / is_l_closure', severity: 4,
    signals: ['\\bislclosure\\s*\\(', '\\bis_l_closure\\s*\\(', '\\bisLclosure\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: "Distinguishes Lua closures from C closures. Production: absent (nil read). Executor profile: islclosure(f) true for plain Lua functions, false for newcclosure-wrapped ones.",
    source: 'UNC Closures category',
  },
  {
    id: 'cl-iscclosure', family: 'closure-integrity', name: 'iscclosure / checkclosure', severity: 4,
    signals: ['\\biscclosure\\s*\\(', '\\bcheckclosure\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Companion of islclosure. Executor profile tracks newcclosure-wrapped functions in a weak set so iscclosure answers true for them.',
    source: 'UNC Closures category',
  },
  {
    id: 'cl-isexecutorclosure', family: 'closure-integrity', name: 'isexecutorclosure / is_executor_closure', severity: 3,
    signals: ['\\bisexecutorclosure\\s*\\(', '\\bis_executor_closure\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: "Executor-loaded chunks are executor closures — our load()-based jail loads the sample exactly like an executor would, so the answer is true under the executor profile.",
    source: 'UNC Closures category',
  },
  {
    id: 'cl-newcclosure', family: 'closure-integrity', name: 'newcclosure identity', severity: 4,
    signals: ['\\bnewcclosure\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: "newcclosure(f) must be callable with f's behavior and type()=='function'; iscclosure on it must be true. Implemented over a weak registry (no table proxies — type() must not leak).",
    source: 'UNC Closures category',
  },
  {
    id: 'cl-hookfunction', family: 'closure-integrity', name: 'hookfunction on globals/metatables', severity: 4,
    signals: ['\\bhookfunction\\s*\\(', '\\breplaceclosure\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: "Returns the original and swaps the target. Implemented for globals (rawset swap) and metamethod fields (hookmetamethod shares the mechanism) — the two shapes anti-tamper actually uses.",
    source: 'UNC Closures category',
  },
  {
    id: 'cl-clonefunction', family: 'closure-integrity', name: 'clonefunction upvalue isolation', severity: 3,
    signals: ['\\bclonefunction\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'clonefunction(f) returns a callable copy sharing behavior but with isolated state. Executor profile provides a load()-rebuilt clone; probes only require callability + same result shape.',
    source: 'UNC Closures category',
  },
  {
    id: 'cl-closure-ms', family: 'closure-integrity', name: 'MoonSec C-closure detector', severity: 4,
    signals: ['iscclosure.{0,60}(error|crash|detected)', 'select\\s*\\(\\s*2\\s*,\\s*pcall\\s*\\(\\s*setfenv'],
    goal: 'dynamic', counter: 'env',
    note: "MoonSec V1/V2 pcall(setfenv, suspect, {}) and read the error message to classify closures. Our setfenv errors with the exact 5.1 message on C functions — the detector classifies correctly.",
    source: 'v2.11.0 exploit notes',
  },
  {
    id: 'cl-hook-detector', family: 'closure-integrity', name: 'hook residue detection (defender)', severity: 3,
    signals: ['hookfunction.{0,80}(restore|revert|undetected)', 'hookmetamethod.{0,80}__namecall'],
    goal: 'dynamic', counter: 'env',
    note: 'Defender technique from pqr-692: detect foreign hooks on __namecall/metatables. Mirrored as env capability: hookmetamethod returns the original so hooks are cleanly reversible.',
    source: 'pqr-692/Roblox-Detections (hooks)',
  },
  {
    id: 'cl-getconstants', family: 'closure-integrity', name: 'getconstants introspection', severity: 3,
    signals: ['\\bgetconstants?\\s*\\(', '\\bgetconstant\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Bytecode-level constant reads. Executor profile returns empty tables (never nil — indexing nil errors mid-probe); production reads nil.',
    source: 'UNC Debug category',
  },
  {
    id: 'cl-getupvalues', family: 'closure-integrity', name: 'getupvalues/getupvalue', severity: 3,
    signals: ['\\bgetupvalues?\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Upvalue enumeration. Same profile split as getconstants.',
    source: 'UNC Debug category',
  },

  // ---- debug-introspection ---------------------------------------------------
  {
    id: 'dbg-getinfo', family: 'debug-introspection', name: 'debug.getinfo / debug.info frames', severity: 3,
    signals: ['debug\\.getinfo\\s*\\(', 'debug\\.info\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Probes read caller frames to spot jail residue. debug.info is a nil-returning shim; getinfo stays real but our frames carry no jail markers.',
    source: 'UNC Debug category + v2.12.0 detection 10',
  },
  {
    id: 'dbg-xpcall-path', family: 'debug-introspection', name: 'xpcall stack-path check (defender)', severity: 3,
    signals: ['xpcall\\s*\\(', 'debug\\.traceback\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: "pqr-692 XpcallPath: abnormal stack shapes flag dumped environments. Our jail frames look like a normal load() run — no executor residue strings in traceback output.",
    source: 'pqr-692 (XpcallPath)',
  },
  {
    id: 'dbg-getstack', family: 'debug-introspection', name: 'debug.getstack', severity: 2,
    signals: ['\\bgetstack\\s*\\(', 'debug\\.getstack'],
    goal: 'dynamic', counter: 'escalate',
    note: 'Local-slot reads. Executor profile returns tables; nil reads would error mid-probe.',
    source: 'UNC Debug category',
  },
  {
    id: 'dbg-getprotos', family: 'debug-introspection', name: 'getprotos / getprotosindex', severity: 2,
    signals: ['\\bgetprotos?\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Prototype enumeration — same pattern as getconstants.',
    source: 'UNC Debug category',
  },
  {
    id: 'dbg-error-format', family: 'debug-introspection', name: 'loadstring error-string format check', severity: 4,
    signals: ['loadstring\\s*\\([^)]{0,60}\\)', 'Attempt to call a string value'],
    goal: 'dynamic', counter: 'env',
    note: "executor_vuln_test probes read the EXACT error message malformed loadstring produces ('Expected identifier' family / 'Argument 1 missing or nil'). Our load passes through to fengari 5.3 whose messages are the closest production shape; the jail never swaps in custom strings.",
    source: 'aihkw/exe-test precise error strings',
  },
  {
    id: 'dbg-arg1-missing', family: 'debug-introspection', name: "'Argument 1 missing or nil' service probe", severity: 4,
    signals: ['Argument 1 missing or nil'],
    goal: 'dynamic', counter: 'env',
    note: "The literal expected message when calling dangerous services with no args (HttpRbxApiService, MessageBusService, BrowserService…). Inert service members respond with production-shaped results, never custom jail errors.",
    source: 'aihkw/exe-test (701-line probe suite)',
  },
  {
    id: 'dbg-setupvalue', family: 'debug-introspection', name: 'setupvalue / setupvaluename writes', severity: 2,
    signals: ['\\bsetupvalue\\s*\\(', '\\bsetupvaluename\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Upvalue tamper — some builds VERIFY their own upvalues after setup. Executor profile provides real writes via debug.setupvalue.',
    source: 'UNC Debug category',
  },
  {
    id: 'dbg-getregistry', family: 'debug-introspection', name: 'getregistry() scan', severity: 3,
    signals: ['\\bgetregistry\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'escalate',
    note: "Lua registry table — dumps enumerate it for the script L-state. Executor profile returns a populated registry-shaped table.",
    source: 'UNC Scripts category',
  },
  {
    id: 'dbg-setreadonly', family: 'debug-introspection', name: 'setreadonly / isreadonly', severity: 3,
    signals: ['\\bsetreadonly\\s*\\(', '\\bisreadonly\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Readonly-table machinery. Executor profile: isreadonly true for our locked surfaces, setreadonly a tolerant no-op returning true.',
    source: 'UNC Metatable category',
  },
  {
    id: 'dbg-thread-identity', family: 'debug-introspection', name: 'getthreadidentity / setthreadidentity', severity: 3,
    signals: ['getthreadidentity\\s*\\(', 'setthreadidentity\\s*\\(', 'identity\\s*==\\s*[248]'],
    goal: 'dynamic', counter: 'escalate',
    note: 'Context identity levels (2 client, 8 executor-plugin). Executor profile returns 8 and tolerates sets; scripts gate decrypted payload on identity — garbage identity = garbage keys.',
    source: 'UNC Scripts category + executor_vuln_test',
  },

  // ---- metatable-integrity ----------------------------------------------------
  {
    id: 'mt-getrawmetatable', family: 'metatable-integrity', name: 'getrawmetatable(game) readability', severity: 4,
    signals: ['getrawmetatable\\s*\\(\\s*game', 'getrawmetatable\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: "Production shape: getrawmetatable reads nil → any pcall chain on it fails cleanly (env-sanity B-d11 pins this). Executor profile returns a guarded metatable instead.",
    source: 'UNC Metatable category + env-sanity B-d11',
  },
  {
    id: 'mt-hookmetamethod', family: 'metatable-integrity', name: 'hookmetamethod __namecall', severity: 4,
    signals: ['hookmetamethod\\s*\\(', '__namecall'],
    goal: 'dynamic', counter: 'escalate',
    note: "Executor antitampers hook __namecall to catch remote logging. Executor profile: game metatable carries __namecall and hookmetamethod swaps it, returning the original (pqr-692 hook-detector mirror).",
    source: 'UNC Metatable + pqr-692 hooks',
  },
  {
    id: 'mt-getnamecallmethod', family: 'metatable-integrity', name: 'getnamecallmethod', severity: 2,
    signals: ['getnamecallmethod\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Returns the current namecall method inside __namecall hooks. Pairs with hookmetamethod coverage.',
    source: 'UNC Metatable category',
  },
  {
    id: 'mt-mt-mutation', family: 'metatable-integrity', name: 'metatable mutation monitor (defender)', severity: 3,
    signals: ['__newindex.{0,80}(metamethod|metatable|hook)', 'rawset.{0,40}getrawmetatable'],
    goal: 'dynamic', counter: 'env',
    note: 'Defenders monitor mt writes to catch dumpers. Our production env never mutates foreign metatables; inert objects tolerate writes (__newindex no-op).',
    source: 'pqr-692 (metatable checks)',
  },
  {
    id: 'mt-compareinstances', family: 'metatable-integrity', name: 'compareinstances semantics', severity: 3,
    signals: ['compareinstances\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Must be false for cloneref results and true for the same reference — the core Cache-category behavior pair.',
    source: 'UNC Cache category',
  },
  {
    id: 'mt-protected-mt', family: 'metatable-integrity', name: '__metatable protection read', severity: 3,
    signals: ['__metatable'],
    goal: 'dynamic', counter: 'env',
    note: "getmetatable(game) must read 'The game' (live Roblox easter-egg shape) — a table or a 'BypassX' string would fingerprint the jail. V2 prelude upgrade.",
    source: 'Roblox DataModel semantics (documented)',
  },
  {
    id: 'mt-fenv-mt', family: 'metatable-integrity', name: 'environment-table metatable probes', severity: 3,
    signals: ['getfenv\\s*\\(\\s*\\d\\s*\\)', 'setfenv\\s*\\(\\s*\\d\\s*,'],
    goal: 'dynamic', counter: 'env',
    note: "Numeric-level fenv probes (IronBrew2 env setup, MoonSec V1 self-sandbox). Our numeric setfenv stays a deliberate no-op — an A/B-verified engine-critical behavior.",
    source: 'Biggest Scan A/B (IronBrew2 route)',
  },
  {
    id: 'mt-instance-new', family: 'metatable-integrity', name: 'Instance.new chain probes', severity: 2,
    signals: ['Instance\\.new\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: "Chained property writes on created instances must tolerate everything (inert objects). UI-antitamper builds draw markers via Instance.new chains.",
    source: 'UNC Instances category',
  },
  {
    id: 'mt-hiddengui', family: 'metatable-integrity', name: 'gethui() hidden container', severity: 2,
    signals: ['\\bgethui\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'escalate',
    note: 'Executor UI container. Executor profile returns an inert instance-shaped object.',
    source: 'UNC Instances category',
  },
  {
    id: 'mt-hidden-property', family: 'metatable-integrity', name: 'get/sethiddenproperty', severity: 2,
    signals: ['gethiddenproperty\\s*\\(', 'sethiddenproperty\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Hidden instance property API — executor profile returns (value, true) shapes.',
    source: 'UNC Instances category',
  },

  // ---- script-identity ---------------------------------------------------------
  {
    id: 'sc-getsenv', family: 'script-identity', name: 'getsenv(script) env fetch', severity: 3,
    signals: ['\\bgetsenv\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Executor profile returns a table shaped like the script env; production reads nil.',
    source: 'UNC Scripts category',
  },
  {
    id: 'sc-getcallingscript', family: 'script-identity', name: 'getcallingscript()', severity: 3,
    signals: ['getcallingscript\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'escalate',
    note: "Must return an instance-shaped object under the executor profile; antitamper chains .Name reads on it.",
    source: 'UNC Scripts category',
  },
  {
    id: 'sc-bytecode', family: 'script-identity', name: 'getscriptbytecode dump', severity: 3,
    signals: ['getscriptbytecode\\s*\\(', 'getscriptclosure\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Bytecode/closure extraction from game scripts. Executor profile returns a Luau-bytecode-shaped string (magic header) — enough for shape probes, never used for real lifting.',
    source: 'UNC Scripts category',
  },
  {
    id: 'sc-loadedmodules', family: 'script-identity', name: 'getloadedmodules enumeration', severity: 2,
    signals: ['getloadedmodules\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'escalate',
    note: 'Module scan — executor profile returns a table containing script.',
    source: 'UNC Scripts category',
  },
  {
    id: 'sc-namecall-spy', family: 'script-identity', name: 'remote-spy detection (defender)', severity: 3,
    signals: ['FireServer', 'InvokeServer', 'namecall.{0,60}(spy|log|remote)'],
    goal: 'dynamic', counter: 'env',
    note: 'Defenders detect remote spies on __namecall. Mirrored: our inert __namecall surface stays consistent — no spy residue for a probe to find.',
    source: 'pqr-692 (remote-spy detection)',
  },
  {
    id: 'sc-dex-envleak', family: 'script-identity', name: 'Dex environment leak scan (defender)', severity: 3,
    signals: ['gethui|CoreGui|getgc.{0,40}(Dex|dex)'],
    goal: 'dynamic', counter: 'env',
    note: "Defenders scan for Dex-explorer artifacts in CoreGui/getgc. Our env exposes no explorer artifacts; executor profile's getgc contains only executor-native shapes.",
    source: 'pqr-692 (DexEnvLeak)',
  },
  {
    id: 'sc-self-location', family: 'script-identity', name: 'script.Name / Source shape', severity: 2,
    signals: ['script\\.Name', 'script\\.Source'],
    goal: 'dynamic', counter: 'env',
    note: 'Chained reads on script must be instance-consistent. Inert object answers with its own key chains.',
    source: 'UNC Instances category',
  },
  {
    id: 'sc-queue-teleport', family: 'script-identity', name: 'queue_on_teleport presence', severity: 1,
    signals: ['queue_on_teleport\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'Executor-only teleport queue. Executor profile: records and no-ops.',
    source: 'UNC Scripts category',
  },

  // ---- fingerprint ----------------------------------------------------------
  {
    id: 'fp-error-string', family: 'fingerprint', name: 'exact error-message validation', severity: 4,
    signals: ['(Expected identifier|invalid argument|missing or nil).{0,60}(==|find|match)', 'select\\s*\\(\\s*2\\s*,\\s*pcall'],
    goal: 'dynamic', counter: 'env',
    note: 'Builds pcall() a malformed operation and string-match the exact Luau error text. Fengari 5.3 messages are kept verbatim — the jail never overrides error formatting.',
    source: 'aihkw/exe-test',
  },
  {
    id: 'fp-magic-number', family: 'fingerprint', name: 'magic-number env compare', severity: 4,
    signals: ['==\\s*45\\d{6}', '==\\s*13\\d{6}'],
    goal: 'dynamic', counter: 'escalate',
    note: 'Magic constants compared against env-derived values. Handled by keygate env shapes or escalation when identity-gated.',
    source: 'unveilr-v3 notes',
  },
  {
    id: 'fp-lua53-tell', family: 'fingerprint', name: 'Lua 5.3-vs-Luau version tell', severity: 4,
    signals: ['_VERSION', 'table\\.unpack'],
    goal: 'dynamic', counter: 'env',
    note: 'Probes distinguish Luau from vanilla Lua (unpack vs table.unpack, utf8 surface). Jail provides the Luau extension surface (split/find/findLast/create/clone/clear, math round/clamp/sign, coroutine.close).',
    source: 'UNC + jail-prelude Luau extensions',
  },
  {
    id: 'fp-utf8-surface', family: 'fingerprint', name: 'utf8 library surface', severity: 2,
    signals: ['utf8\\.(char|codepoint|len|graphemes)\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Luau utf8 exists in production; fengari ships it natively (5.3). Coverage asserted in sanity probes.',
    source: 'UNC environment checks',
  },
  {
    id: 'fp-error-in-vector', family: 'fingerprint', name: 'vector-length fingerprint', severity: 2,
    signals: ['#\\s*tostring', '\\btostring\\s*\\(\\s*\\w+\\s*\\)\\s*\\.\\s*len'],
    goal: 'dynamic', counter: 'env',
    note: 'tostring shapes (nil → "nil", booleans, floats) feed fingerprints. Native tostring semantics kept — no jail overrides.',
    source: 'unveilr-v3 notes',
  },
  {
    id: 'fp-regex-self', family: 'fingerprint', name: 'self-string scan for jail markers', severity: 4,
    signals: ['fengari|bypassx|_BX_'],
    goal: 'dynamic', counter: 'env',
    note: "Scripts scan _G/strings/frames for the jail's own names. Defense in depth: hidden-key __pairs (no _BX_ leakage), no jail-branded strings in inert/metatable surfaces (v2.15.0 removes the 'BypassX' __metatable string).",
    source: 'V2 design — defense in depth',
  },

  // ---- kill-switch -----------------------------------------------------------
  {
    id: 'ks-error-gate', family: 'kill-switch', name: 'error() validator gate', severity: 5,
    signals: ['if\\s+[^\\n]{0,120}(checkcaller|identifyexecutor|islclosure|getrawmetatable|45195195)[^\\n]{0,60}then[^\\n]{0,60}error\\s*\\(', 'error\\s*\\(\\s*["\']?(detected|tamper|dump|skid)'],
    goal: 'static', counter: 'neutralize',
    note: "if <fingerprint> then error(...) end — the classic kill gate. AST-defused when the consequent is only kill statements; the fingerprint compare has no value we need.",
    source: 'universal pattern across all families',
  },
  {
    id: 'ks-while-true', family: 'kill-switch', name: 'while-true spin bomb', severity: 5,
    signals: ['while\\s+true\\s+do\\s+end', 'repeat\\s+until\\s+false'],
    goal: 'static', counter: 'neutralize',
    note: 'Empty infinite loop used as a crash primitive (sometimes under a fingerprint flag). Empty-body instances are removed statically; guarded ones die to the instruction budget.',
    source: 'universal pattern',
  },
  {
    id: 'ks-os-exit', family: 'kill-switch', name: 'os.exit kill gate', severity: 5,
    signals: ['os\\.exit\\s*\\('],
    goal: 'static', counter: 'neutralize',
    note: 'os.exit in a validator consequent. Our os table has no exit (reads nil → call errors, caught by pcall) AND the gate is AST-defused when paired with a fingerprint test.',
    source: 'universal pattern',
  },
  {
    id: 'ks-crash-func', family: 'kill-switch', name: 'named crash function', severity: 4,
    signals: ['(function|local function)\\s+(crash|die|kill|anticrash|fail)\\w*\\s*\\(', '(crash|die|kill)\\w*\\s*\\(\\s*\\)\\s*;?'],
    goal: 'static', counter: 'neutralize',
    note: 'Local crash helpers whose body is error/while-true. Tracked by the neutralizer (function named crash* whose body is only kill statements) and their call sites defused.',
    source: 'common builds',
  },
  {
    id: 'ks-debounce-exit', family: 'kill-switch', name: 'silent return gate', severity: 2,
    signals: ['if\\s+[^\\n]{0,80}(identifyexecutor|checkcaller)[^\\n]{0,40}then\\s*return\\s+end'],
    goal: 'static', counter: 'neutralize',
    note: 'Softer variant: silently returns instead of erroring (build "refuses to run" with zero output). Same AST defuse rule as ks-error-gate with return-only consequent.',
    source: 'common builds',
  },
  {
    id: 'ks-pcall-suicide', family: 'kill-switch', name: 'pcall-wrapped suicide', severity: 4,
    signals: ['pcall\\s*\\(\\s*function\\s*\\(\\s*\\)\\s*(error|while)', 'task\\.spawn\\s*\\(\\s*function\\s*\\(\\s*\\)\\s*(error|while)'],
    goal: 'static', counter: 'neutralize',
    note: 'Async suicide thread spawned when a probe trips. The spawn target body (error/while-true only) is emptied by the AST defuser.',
    source: 'common builds',
  },
  {
    id: 'ks-variable-gate', family: 'kill-switch', name: 'flag-driven kill switch', severity: 4,
    signals: ['(tamper|detected|flagged|bypassed)\\w*\\s*=\\s*(true|false)', 'if\\s+(tamper|detected|flagged)\\w*\\s+then'],
    goal: 'both', counter: 'neutralize',
    note: "Probes set a tamper flag consumed later by the kill gate. Static defuse handles direct gates; flag-consuming logic on derived keys is answered by correct env shapes (dynamic layer).",
    source: 'common builds',
  },
  {
    id: 'ks-string-assert', family: 'kill-switch', name: 'assert() integrity gate', severity: 3,
    signals: ['assert\\s*\\(\\s*[^,\\n]{0,80},\\s*["\'][^"\']{0,60}(tamper|detect|dump)'],
    goal: 'static', counter: 'neutralize',
    note: "assert with a tamper message. AST-defused when the tested expression contains a fingerprint call and the build tolerates it (assert removal keeps the flow).",
    source: 'common builds',
  },

  // ---- clock-gate --------------------------------------------------------------
  {
    id: 'cg-tick-delta', family: 'clock-gate', name: 'tick() delta init gate', severity: 5,
    signals: ['tick\\s*\\(\\s*\\)\\s*-', 'os\\.clock\\s*\\(\\s*\\)\\s*-'],
    goal: 'dynamic', counter: 'env',
    note: 'Escrow init loops bound by clock deltas. Advancing clock (v2.11.0) makes the gate terminate — pinned by env-sanity A-suite timing assertion.',
    source: 'v2.11.0 exploit',
  },
  {
    id: 'cg-wait-loop', family: 'clock-gate', name: 'wait() poll loop', severity: 3,
    signals: ['while[^\\n]{0,40}wait\\s*\\(\\s*\\)\\s*do', 'task\\.wait\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'env',
    note: 'wait returns 0 instantly (v2.8.0) so poll loops spin on the instruction hook, not the wall clock — bounded and fast.',
    source: 'jail-prelude 2.8.0',
  },
  {
    id: 'cg-time-anomaly', family: 'clock-gate', name: 'time anomaly detector', severity: 3,
    signals: ['os\\.time\\s*\\(\\s*\\)\\s*[<>]', 'os\\.date\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Scripts sanity-check wall-clock plausibility. Jail returns advancing time anchored at a real epoch and a fixed-format date string.',
    source: 'jail-prelude os table',
  },
  {
    id: 'cg-fps-gate', family: 'clock-gate', name: 'frame-time gate', severity: 2,
    signals: ['RenderStepped|Heartbeat|stepped'],
    goal: 'dynamic', counter: 'env',
    note: 'RunService signal connections. Inert services tolerate connection reads; executor profile returns empty connection tables from getconnections.',
    source: 'UNC Instances category',
  },
  {
    id: 'cg-elapsed-punish', family: 'clock-gate', name: 'elapsed-time punishment', severity: 4,
    signals: ['if\\s+[^\\n]{0,60}(tick|clock|time)\\s*\\(\\s*\\)[^\\n]{0,20}-[^\\n]{0,20}(then|error)'],
    goal: 'dynamic', counter: 'env',
    note: 'Punishes slow environments (a dump VM is slow). Our jail runs fast and clocks advance realistically — no anomaly to punish.',
    source: 'common builds',
  },

  // ---- network-tamper -------------------------------------------------------------
  {
    id: 'net-self-fetch', family: 'network-tamper', name: 'self-fetch integrity check', severity: 4,
    signals: ['HttpGet.{0,120}(==|~=|find)', 'game:\\s*HttpGet\\s*\\('],
    goal: 'both', counter: 'neutralize',
    note: "Script re-downloads itself (or a checksum endpoint) and errors on mismatch — dead against any offline env. AST-defused when paired with a kill consequent; executor profile ships a Synapse-shaped http stub for shape probes.",
    source: 'common builds + executor_vuln_test',
  },
  {
    id: 'net-webhook-exfil', family: 'network-tamper', name: 'webhook exfil beacon', severity: 2,
    signals: ['discord(app)?\\.com/api/webhooks', 'HttpPost.{0,80}webhook'],
    goal: 'dynamic', counter: 'env',
    note: 'Not a defense — tracking. HttpPost stub returns a failure-shaped response; no network leaves the jail either way (sandbox policy).',
    source: 'common builds',
  },
  {
    id: 'net-request-async', family: 'network-tamper', name: 'RequestAsync probe', severity: 2,
    signals: ['RequestAsync\\s*\\(', 'http_request\\s*\\(', '\\brequest\\s*\\(\\s*\\{'],
    goal: 'dynamic', counter: 'env',
    note: 'Generic HTTP probes. Executor profile: request/http_request return failure-shaped tables (Success=false) without network.',
    source: 'executor_vuln_test',
  },
  {
    id: 'net-h_post-gate', family: 'network-tamper', name: 'HttpPost availability gate', severity: 3,
    signals: ['HttpPost', 'game\\[?["\']?HttpPost'],
    goal: 'dynamic', counter: 'env',
    note: "Production shape: HttpPost/HttpGet on services read NIL (a truthy read made anti-dump think an executor was present — v1.8.0 fix). Executor profile provides callable stubs.",
    source: 'jail-prelude 1.8.0',
  },
  {
    id: 'net-pastebin-key', family: 'network-tamper', name: 'remote key/whitelist fetch', severity: 3,
    signals: ['pastebin\\.com|raw\\.githubusercontent\\.com|gist\\.githubusercontent\\.com'],
    goal: 'both', counter: 'neutralize',
    note: 'Remote whitelist/key fetches gate execution on network content. Paired kill gates are AST-defused; stubs return failure shapes.',
    source: 'common builds',
  },
  {
    id: 'net-websocket', family: 'network-tamper', name: 'websocket C2 probe', severity: 2,
    signals: ['websocket\\s*\\.\\s*connect|WebSocket\\.connect'],
    goal: 'dynamic', counter: 'env',
    note: 'C2-style channels. Stub: connect returns a failure shape; nothing leaves the jail.',
    source: 'executor_vuln_test',
  },

  // ---- vm-guard: VM dispatcher integrity ---------------------------------------------
  {
    id: 'vm-opcode-checksum', family: 'vm-guard', name: 'opcode table checksum', severity: 4,
    signals: ['(opcode|op_table|instructions).{0,60}(checksum|hash|crc)'],
    goal: 'dynamic', counter: 'env',
    note: "VM builds checksum their own opcode tables; tampering with the dispatcher poisons it. We never edit the dispatcher — we run it and capture its output. No counter needed beyond a correct env.",
    source: 'VM-family research (IronBrew/Luraph/Hercules)',
  },
  {
    id: 'vm-pc-integrity', family: 'vm-guard', name: 'program-counter integrity check', severity: 3,
    signals: ['while\\s+pc\\s*<='],
    goal: 'dynamic', counter: 'env',
    note: 'Dispatcher pc sanity loops. Runs unmodified inside the jail.',
    source: 'VM-family research',
  },
  {
    id: 'vm-const-pool', family: 'vm-guard', name: 'constant-pool decrypt binding', severity: 5,
    signals: ['(constants|pool|string_table).{0,60}(decrypt|xor|unpack)'],
    goal: 'dynamic', counter: 'env',
    note: "The pool decrypt binds to runtime-derived keys — the entire reason escrow builds yield garbage under wrong env shapes. The env-hardening layer's ONLY job is to present a shape that derives the real keys (or escalate to an executor identity).",
    source: 'MoonSec escrow + Luraph v14 research',
  },
  {
    id: 'vm-dispatch-nesting', family: 'vm-guard', name: 'dispatcher nesting depth guard', severity: 3,
    signals: ['while\\s+true\\s+do.{0,120}(opcodes|instructions)\\s*\\['],
    goal: 'dynamic', counter: 'env',
    note: 'The hot dispatch loop. Instruction budget bounds it; instrumentation (lift worker) must add zero overhead to the loop shape it inspects.',
    source: 'vm-lift design',
  },
  {
    id: 'vm-load-stage', family: 'vm-guard', name: 'load() second-stage launcher', severity: 4,
    signals: ['loadstring\\s*\\(\\s*[^)]{1,40}\\)\\s*\\(', 'load\\s*\\(\\s*\\w+\\s*\\)'],
    goal: 'dynamic', counter: 'env',
    note: 'Decrypt-then-load staging. Our load()-chunk capture (v1.8.0) recovers the FULL second-stage source/bytecode — the single highest-value capture in the engine.',
    source: 'jail-prelude 1.8.0',
  },
  {
    id: 'vm-string-vm', family: 'vm-guard', name: 'string-based VM state machine', severity: 3,
    signals: ['string\\.byte.{0,60}string\\.sub'],
    goal: 'dynamic', counter: 'env',
    note: 'String-driven state machines decode payload byte-by-byte. String sinks capture every produced string; sub/rep/char wrappers feed the pool.',
    source: 'jail-prelude string sinks',
  },

  // ---- readability/evasion extras observed in the leaked corpus ------------------------
  {
    id: 'misc-25ms-probe', family: 'env-probe', name: '25ms CFrame/task/workspace probe', severity: 4,
    signals: ['CFrame\\.new', 'task\\s*\\.\\s*wait\\s*\\(\\s*0\\.025\\s*\\)', 'game:GetService\\s*\\(\\s*["\']Workspace["\']\\s*\\)'],
    goal: 'dynamic', counter: 'env',
    note: "Timed micro-probes asserting the game/workspace/CFrame+task surface exists and answers fast. Inert universe answers instantly — the probe passes without wall-clock cost.",
    source: 'unveilr-v3 notes (25ms techniques) + thirdparty-samples suite',
  },
  {
    id: 'misc-gui-draw', family: 'env-probe', name: 'Drawing/UI marker render', severity: 2,
    signals: ['Drawing\\.new\\s*\\('],
    goal: 'dynamic', counter: 'escalate',
    note: 'UI "protected" markers (also an exfil/branding vector). Executor profile provides Drawing.new inert shapes.',
    source: 'UNC + common builds',
  },
  {
    id: 'misc-loadstring-chain', family: 'kill-switch', name: 'loadstring wrap of validated payload', severity: 3,
    signals: ['loadstring\\s*\\([^)]{0,60}\\)\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'env',
    note: 'loadstring(...)() final launch — the moment of full source exposure. Chunk capture catches the string; the loaded chunk runs inside the same jail.',
    source: 'jail-prelude load capture',
  },
  {
    id: 'misc-gethui-ui', family: 'env-probe', name: 'CoreGui/gethui branching', severity: 2,
    signals: ['CoreGui|gethui\\s*\\(\\s*\\)'],
    goal: 'dynamic', counter: 'escalate',
    note: 'UI parent selection branches on executor surfaces. Inert universe tolerates both branches.',
    source: 'UNC Instances',
  },
  {
    id: 'misc-env-sandbox-check', family: 'env-probe', name: 'sandbox/table-freeze detection', severity: 3,
    signals: ['isreadonly\\s*\\(\\s*getfenv', 'setreadonly\\s*\\(\\s*getfenv', 'freeze\\s*\\('],
    goal: 'dynamic', counter: 'env',
    note: 'Probes whether the env table is frozen/readonly — vanilla Lua tables are not. Our env reads as writable (no isreadonly in production shape).',
    source: 'UNC Metatable',
  },
  {
    id: 'misc-tamper-message', family: 'kill-switch', name: 'explicit tamper messaging', severity: 3,
    signals: ['(tamper|tampered|modified|detected).{0,40}(script|code|file|environment)', 'anti.?tamper\\w*'],
    goal: 'both', counter: 'neutralize',
    note: "Human-readable tamper strings (also excellent catalog telemetry: when these appear, the sample is confirming which family it belongs to). Gates paired with them are AST-defused.",
    source: 'common builds',
  },
  {
    id: 'misc-protected-call-chain', family: 'kill-switch', name: 'nested pcall validation ladder', severity: 3,
    signals: ['pcall[^\\n]{0,40}pcall[^\\n]{0,40}pcall'],
    goal: 'dynamic', counter: 'env',
    note: "Ladders of nested pcalls whose inner run does the real work only if every outer step 'looks right'. Correct env shapes keep every step green; no static edit needed (edits would break the ladder's own state machine).",
    source: 'common builds',
  },
  {
    id: 'misc-dual-profile', family: 'executor-whitelist', name: 'dual env branching (Studio vs executor)', severity: 3,
    signals: ['IsStudio.{0,120}(error|crash|return)', 'identifyexecutor.{0,120}(error|crash|return)'],
    goal: 'both', counter: 'escalate',
    note: "Builds with two valid branches: run in Studio OR run under executor X — everything else dies. Escalation covers the executor branch; the catalog flags the sample so the report explains it.",
    source: 'common builds',
  },
];

// ---- derived indexes --------------------------------------------------------

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));
const COMPILED = CATALOG.map((e) => ({
  entry: e,
  regs: e.signals.map((s) => {
    try { return new RegExp(s, 'gi'); } catch { return null; }
  }).filter(Boolean),
}));

export const FAMILIES = [...new Set(CATALOG.map((e) => e.family))].sort();
export const CATALOG_SIZE = CATALOG.length;

/** Get one entry by id (null when unknown). */
export function entryById(id) { return BY_ID.get(id) || null; }

/**
 * Scan Lua/JS source text against the catalog.
 * @returns {Array<{id, family, name, severity, counter, hits: number, note: string}>}
 *   matched entries, highest severity first.
 */
export function matchCatalog(source) {
  if (!source || typeof source !== 'string' || source.length > 24 * 1024 * 1024) return [];
  const out = [];
  for (const { entry, regs } of COMPILED) {
    let hits = 0;
    for (const re of regs) {
      const m = source.match(re);
      if (m) hits += m.length;
    }
    if (hits > 0) out.push({ id: entry.id, family: entry.family, name: entry.name, severity: entry.severity, counter: entry.counter, hits, note: entry.note });
  }
  out.sort((a, b) => b.severity - a.severity || b.hits - a.hits);
  return out;
}

/**
 * Executor-gate decision: does this sample REFUSE to run without executor
 * identity? (escalation trigger — production shape will not satisfy it)
 */
const EXECUTOR_GATE_RE = [
  /\bidentifyexecutor\s*\(/i,
  /\bgetexecutorname\s*\(/i,
  /\biscclosure\s*\(/i,
  /\bislclosure\s*\(/i,
  /\bcheckcaller\s*\(/i,
  /\bgetgenv\s*\(\s*\)/i,
  /\bnewcclosure\s*\(/i,
  /\bhookfunction\s*\(/i,
  /\bgetrawmetatable\s*\(/i,
  /\bhookmetamethod\s*\(/i,
  /\bcloneref\s*\(/i,
  /\bgetregistry\s*\(\s*\)/i,
  /\bgetsenv\s*\(/i,
  /\bgetcallingscript\s*\(/i,
  /\bgetthreadidentity\s*\(/i,
  /\bqueue_on_teleport\s*\(/i,
  /\bisexecutorclosure\s*\(/i,
  /\bis_executor_closure\s*\(/i,
  /\bcompareinstances\s*\(/i,
];
const KILL_RE = /(error\s*\(|while\s+true\s+do|os\.exit\s*\(|LPH_CRASH\s*\(|assert\s*\(|then\s+return\s+end)/i;

export function isExecutorGated(source) {
  if (!source || typeof source !== 'string') return false;
  const hasGate = EXECUTOR_GATE_RE.some((re) => re.test(source));
  const hasKill = KILL_RE.test(source);
  return hasGate && hasKill;
}

/** Executor identities used by the adaptive escalation ladder. */
export const EXECUTOR_IDENTITIES = [
  { key: 'synapse', name: 'Synapse Z', version: 'v2.0.3', identity: 8 },
  { key: 'scriptware', name: 'Script-Ware', version: 'v5.1.2', identity: 8 },
  { key: 'krnl', name: 'Krnl', version: 'v1.4.1', identity: 8 },
];
