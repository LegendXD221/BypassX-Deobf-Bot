/**
 * BypassX Deobf Bot — AntiTamper Detection Catalog (v2.15.0).
 *
 * Every anti-tamper / anti-dump / environment-validation mechanism we know of,
 * across every supported service, with the countermeasure our jail (or the
 * pre-run neutralizer) applies. This is the brain of the AntiTamper engine:
 *   • neutralize.js matches `probe` patterns against incoming source
 *   • env-hardening.js builds per-family profiles from the `counter` ids
 *   • sanity.js asserts the jail actually delivers the counters
 *   • pipeline surfaces the hits in user-visible stages
 *
 * Sources: leaked UnveilR-V3 intel (vendored under research/unveilr-v3/),
 * Luraph official macro docs (LPH_PRECHECK family), the UNC / sUNC executor
 * conformance suites, aihkw/exe-test probe catalog, pqr-692/Roblox-Detections
 * (defender side), and every A/B-verified jail behavior from v2.11–v2.14.
 *
 * Entry shape:
 *   id        unique stable id
 *   name      human label (shows in bot stages)
 *   services  family ids from detect.js this mechanism is seen in ('*' = all)
 *   kind      category: env-fingerprint | closure-integrity | metatable-integrity
 *             | time-gate | identity-check | dump-guard | crash-trap
 *             | telemetry | env-poison | deadlock-gate | residue
 *   probe     what the protected script does to detect us (regex source or
 *             description; regex entries carry the `pattern` flag)
 *   pattern   optional JS RegExp source the neutralizer can match statically
 *   counter   what we do about it (human text; ids referenced by sanity.js)
 *   severity  critical (kills the run) | degrading (poisons output) | cosmetic
 */

export const CATALOG = [
  // ── Luraph family (luraph, tokrascript) ────────────────────────────────────
  {
    id: 'lph-crash', name: 'LPH_CRASH() crash trap', services: ['luraph', 'tokrascript'],
    kind: 'crash-trap', severity: 'critical',
    probe: 'Obfuscator emits LPH_CRACH/LPH_CRASH macro calls; invoking the stub hard-kills the runtime when a check trips.',
    pattern: 'LPH_CRASH\\s*\\(', counter: 'neutralize: rewrite every LPH_CRASH(...) call site into a trailing comment before the jail run.',
  },
  {
    id: 'lph-precheck', name: 'LPH_PRECHECK environment validation', services: ['luraph', 'tokrascript'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'LPH_PRECHECK(function() ... end) embeds whitelist / anti-tamper / environment validation whose failure prevents execution (Luraph official docs).',
    pattern: 'LPH_PRECHECK\\s*\\(', counter: 'neutralize: drop the LPH_PRECHECK wrapper (keep a comment); validation never runs, so it can never fail.',
  },
  {
    id: 'lph-macros', name: 'LPH JIT/ENC macro wrappers', services: ['luraph', 'tokrascript'],
    kind: 'residue', severity: 'degrading',
    probe: 'LPH_ENCSTR/LPH_ENCNUM/LPH_ENCFUNC/LPH_JIT/LPH_JIT_MAX/LPH_NO_VIRTUALIZE/LPH_NO_UPVALUES wrappers change call shapes and leave macro residue.',
    pattern: 'LPH_(ENCSTR|ENCNUM|ENCFUNC|JIT_MAX|JIT|NO_VIRTUALIZE|NO_UPVALUES)\\s*\\(', counter: 'neutralize: unwrap each macro to its argument (the wrapped function/expression), macro name kept as a comment.',
  },
  {
    id: 'luraph-tostring-fingerprint', name: 'tostring fingerprint 45195195', services: ['luraph', 'tokrascript'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'Compares tostring(...) of an environment/loadstring artifact against the magic constant 45195195 (leaked UnveilR-V3 intel: Luau-style loadstring error messages required).',
    counter: 'jail: fengari tostring shapes match production Lua for the compared values; load() error strings remain compiler-shaped. Verified by env-sanity suite B-layer.',
  },
  {
    id: 'luraph-setfenv-probe', name: 'setfenv environment probe', services: ['luraph', 'tokrascript'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'setfenv(0/1, fenv) redirection is used to detect swapped environments; nested VM chunks restart via `return(function(` signatures.',
    counter: 'jail: setfenv(fn, env) swaps the real _ENV upvalue; setfenv(0/1, _) stays inert; nested chunks re-detected and re-run by the lift worker.',
  },
  {
    id: 'luraph-yield-tell', name: 'coroutine.yield VM tell', services: ['luraph', 'tokrascript'],
    kind: 'env-fingerprint', severity: 'degrading',
    probe: 'Dispatcher yields between stages; a fake coroutine library that miscounts resumes desyncs the instruction stream.',
    counter: 'jail: fengari coroutines are real; count-hook budgets bound runaway streams without altering yield counts.',
  },

  // ── MoonSec family (v1/v2/v3) ──────────────────────────────────────────────
  {
    id: 'ms-getfenv-pool', name: 'getfenv constant-pool reads', services: ['moonsec_v1', 'moonsec_v2', 'moonsec_v3'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'Constants are read through fenv["<binary>"][1]; a getfenv that returns a different table than the spied environment poisons every key.',
    counter: 'jail: getfenv() returns the same _G the instrumentation sinks observe; pool capture reads the setfenv-d table directly (v2.11.0 pairing).',
  },
  {
    id: 'ms-skid-setfenv', name: 'setfenv C-closure skid detector', services: ['moonsec_v1', 'moonsec_v2', 'moonsec_v3'],
    kind: 'closure-integrity', severity: 'critical',
    probe: 'pcall(setfenv, suspect, {}) — if it does NOT error, the suspect is a Lua closure (executor/sandbox tell), and the build takes the garbage-key path.',
    counter: 'jail: setfenv on a C-backed function raises the 5.1 error "cannot change environment of given object" (v2.11.0).',
  },
  {
    id: 'ms-wait-number', name: 'wait() must return a number', services: ['moonsec_v1', 'moonsec_v2', 'moonsec_v3', 'psu', 'wearedevs'],
    kind: 'time-gate', severity: 'critical',
    probe: 'Init gates on game.Loaded / wait(); a wait() that returns non-number breaks key schedules or deadlocks the decrypt loop.',
    counter: 'jail: task.wait/wait() return a real advancing number (v2.8.0 yield upgrade).',
  },
  {
    id: 'ms-clock-gate', name: 'os.clock() frozen-clock deadlock', services: ['moonsec_v3', 'psu'],
    kind: 'deadlock-gate', severity: 'critical',
    probe: 'while os.clock() - t < X do end — a frozen clock burns the entire instruction budget on one gate and the pool stays empty.',
    counter: 'jail: clocks ADVANCE ~10ms per call (v2.11.0 leaked-corpus exploit) so gates terminate within budget.',
  },
  {
    id: 'ms-nonsense-keys', name: 'garbage-key poisoning via truthy probes', services: ['moonsec_v2', 'moonsec_v3', 'luraph'],
    kind: 'env-poison', severity: 'critical',
    probe: 'Anti-dump probes (islclosure, getconstants, hookfunction, identifyexecutor, require, package, io, …) are read; ANY truthy read feeds garbage into decryption keys.',
    counter: 'jail: __NILPROBE forces the whole executor/detection surface to read nil; absent host libs stay absent (v2.12.0 polyglot-resurrection fix).',
  },
  {
    id: 'ms-ldexp-bind', name: 'math.ldexp dispatcher bind', services: ['moonsec_v2'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'Dispatcher init binds math.ldexp; absence was the "attempt to call nil upvalue" wall.',
    counter: 'jail: math.ldexp/math.frexp implemented natively over 5.3 floats.',
  },

  // ── Prometheus ─────────────────────────────────────────────────────────────
  {
    id: 'prom-pc-flatten', name: 'pc-flattened control flow', services: ['prometheus'],
    kind: 'env-fingerprint', severity: 'degrading',
    probe: 'while true do pc = 1234; if pc == 1234 … dispatch flattening hides structure from static readers.',
    counter: 'engine: branch-comment devirtualization flattens naturally; number>10000 heuristic + ≥6-compare variable tracking recover the flow.',
  },
  {
    id: 'prom-constpool-b64', name: 'base64 constant pool', services: ['prometheus'],
    kind: 'dump-guard', severity: 'degrading',
    probe: 'String pool ships base64-encoded with custom alphabets; static dumps show encoded noise.',
    counter: 'engine: deep static pass undoes rotation + custom-alphabet decoders behaviorally and inlines literals at call sites (v2.13.0).',
  },

  // ── 25ms ───────────────────────────────────────────────────────────────────
  {
    id: '25ms-tamper-probe', name: 'game/workspace/CFrame tamper probe', services: ['25ms', 'wynfuscate'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'Anti-tamper inspects game / workspace / CFrame members plus the task library; faking the environment forces the clean path.',
    counter: 'jail: production-shaped inert DataModel (real identity fields, Is* booleans) + full task lib (v1.8.0/v2.12.0).',
  },
  {
    id: '25ms-concat-inject', name: 'pool-table concat obfuscation', services: ['25ms'],
    kind: 'dump-guard', severity: 'degrading',
    probe: 'Strings assembled by raw table-concat expressions invisible to function sinks.',
    counter: 'engine: 25ms-style concat-injection tier rewrites pool-table concats to _BXCAP() passthrough (v2.10.0).',
  },

  // ── WeAreDevs / slua / junk wrappers ──────────────────────────────────────
  {
    id: 'wearedevs-garbage-globals', name: 'garbage global nil-ing', services: ['wearedevs', 'slua', 'luast'],
    kind: 'env-poison', severity: 'degrading',
    probe: 'Forces sentinel globals (package, inf, …) to nil or reads them expecting absence.',
    counter: 'jail: host libs are truly absent keys, not nil-assigned stubs; polyglot fallback tolerates the rest.',
  },
  {
    id: 'wearedevs-unm-msg', name: 'arithmetic-on-unm error rewrite', services: ['wearedevs'],
    kind: 'env-fingerprint', severity: 'cosmetic',
    probe: 'Expecting Luau-shaped error text for invalid arithmetic on inert objects.',
    counter: 'jail: inert metatables return neutral values instead of erroring — probes keep running.',
  },

  // ── IronBrew family ────────────────────────────────────────────────────────
  {
    id: 'ib-rawset-shim', name: 'rawset missing-argument shim', services: ['ironbrew1', 'ironbrew2', 'ironbrew3'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'VM init calls rawset with partial args expecting 5.1 leniency.',
    counter: 'jail: rawset semantics preserved; pcall shim wraps dispatcher init errors into recoverable probes.',
  },
  {
    id: 'ib-pcall-shape', name: 'pcall must behave really', services: ['ironbrew1', 'ironbrew2', 'ironbrew3', 'psu'],
    kind: 'closure-integrity', severity: 'critical',
    probe: 'Error-path handling validates pcall return shapes; stubbed pcall desyncs the opcode walker.',
    counter: 'jail: fengari pcall is real; only error TEXT is neutralized.',
  },

  // ── Generic executor-detection surface (UNC / sUNC derived) ───────────────
  {
    id: 'unc-identifyexecutor', name: 'identifyexecutor whitelist', services: ['*'],
    kind: 'identity-check', severity: 'critical',
    probe: 'Whitelists gate execution on identifyexecutor()/getexecutorname() returning a known executor name.',
    counter: 'jail: reads nil (production shape). Profiles may masquerade via env-hardening when a family is known to whitelist.',
  },
  {
    id: 'unc-hook-surface', name: 'hookfunction/hookmetamethod surface', services: ['*'],
    kind: 'closure-integrity', severity: 'critical',
    probe: 'Presence of a hook surface implies an executor; truthy reads trigger anti-executor paths.',
    counter: 'jail: __NILPROBE keeps the whole hook surface nil (v2.12.0).',
  },
  {
    id: 'unc-getgenv-tell', name: 'getgenv / getrenv presence', services: ['*'],
    kind: 'identity-check', severity: 'critical',
    probe: 'Executor-only globals distinguish sandbox from game client.',
    counter: 'jail: absent keys read nil through the polyglot guard only for listed probes.',
  },
  {
    id: 'unc-namecall-integrity', name: '__namecall integrity check', services: ['*'],
    kind: 'metatable-integrity', severity: 'degrading',
    probe: 'getrawmetatable(game).__namecall is compared against the expected C function (remote-spy detection pattern).',
    counter: 'jail: game carries a locked inert metatable (__metatable = "BypassX"); namecall never diverges mid-run.',
  },
  {
    id: 'unc-index-check', name: 'index-tamper detection (IndexCheck)', services: ['*'],
    kind: 'metatable-integrity', severity: 'degrading',
    probe: 'Defender pattern: repeated member reads must return consistent shapes; divergence = tampering.',
    counter: 'jail: per-object keys carry their own identity — no shared stale key (v1.8.0 fix).',
  },
  {
    id: 'unc-xpcall-path', name: 'xpcall stack-path anomaly', services: ['*'],
    kind: 'closure-integrity', severity: 'degrading',
    probe: 'xpcall handler inspects debug stack depth/shape for emulator tells.',
    counter: 'jail: fengari debug lib is real; debug.info shim returns nil without fake frames.',
  },
  {
    id: 'unc-dexenv-leak', name: 'Dex environment leak check', services: ['*'],
    kind: 'env-fingerprint', severity: 'degrading',
    probe: 'WALKS _G for explorer/executor artifacts; junk keys or exotic tables are the tell.',
    counter: 'jail: _G contains exactly the production-shaped surface; polyglot fallback only resolves unknown reads.',
  },
  {
    id: 'unc-loadstring-err', name: 'loadstring error-message shape', services: ['*'],
    kind: 'env-fingerprint', severity: 'degrading',
    probe: 'load("f") must yield a compiler-error string, not a silent success or host exception.',
    counter: 'jail: fengari load() returns real (nil, msg) pairs; chunks captured on the way in.',
  },
  {
    id: 'unc-required-libs', name: 'require/package resurrection', services: ['*'],
    kind: 'identity-check', severity: 'critical',
    probe: 'pcall(require, "@lune/roblox") SUCCEEDING is an executor/sandbox fingerprint (leaked detection 8).',
    counter: 'jail: require/package/loadfile/dofile/io are ABSENT keys — polyglot __index cannot resurrect them (v2.12.0).',
  },
  {
    id: 'unc-task-bindings', name: 'task library completeness', services: ['*'],
    kind: 'env-fingerprint', severity: 'degrading',
    probe: 'task.bindings/task.cancel must exist and behave (leaked detection 7).',
    counter: 'jail: task.cancel/synchronize/desynchronize present; task.wait returns advancing numbers.',
  },

  // ── PSU / Clyde / LuaST family ─────────────────────────────────────────────
  {
    id: 'psu-loadstage', name: 'decrypt-then-load staging', services: ['psu', 'clyde', 'luast', 'boronide', 'darksec'],
    kind: 'dump-guard', severity: 'critical',
    probe: 'Full decrypted source is handed to load()/loadstring() at init.',
    counter: 'jail: LOAD-CHUNK CAPTURE records every chunk — complete recovery path (v1.8.0).',
  },
  {
    id: 'psu-garbage-nils', name: 'sentinel global nil expectations', services: ['psu', 'clyde', 'luast'],
    kind: 'env-poison', severity: 'degrading',
    probe: 'package/inf/sentinel globals must be absent for keys to decrypt cleanly.',
    counter: 'jail: absent-key semantics for the whole host surface.',
  },

  // ── Time / telemetry traps (all families) ─────────────────────────────────
  {
    id: 'time-os-clock', name: 'os.clock/tick advancing clocks', services: ['*'],
    kind: 'time-gate', severity: 'critical',
    probe: 'Timeout/heartbeat gates on clocks; frozen clocks deadlock, real clocks must advance.',
    counter: 'jail: os.clock/tick advance ~10ms per call; os.time anchored to a fixed epoch + clock.',
  },
  {
    id: 'time-fps-probe', name: 'RenderStepped/setfpscap probes', services: ['*'],
    kind: 'env-fingerprint', severity: 'cosmetic',
    probe: 'Frame-rate probes distinguish headless sandboxes from clients.',
    counter: 'jail: inert services absorb the probes; values never read truthy-executor.',
  },
  {
    id: 'telemetry-http', name: 'HttpGet/HttpPost telemetry', services: ['*'],
    kind: 'telemetry', severity: 'critical',
    probe: 'Protected builds phone home (webhooks/license servers) with environment dumps.',
    counter: 'jail: executor-only service methods read NIL — no host network egress from the jail, ever.',
  },
  {
    id: 'telemetry-websocket', name: 'WebSocket callback-home', services: ['*'],
    kind: 'telemetry', severity: 'critical',
    probe: 'License/heartbeat over WebSocket before payload decryption.',
    counter: 'jail: WebSocket/websocket read nil; init proceeds on the offline path.',
  },
  {
    id: 'telemetry-request', name: 'request()/http_request dump', services: ['*'],
    kind: 'telemetry', severity: 'critical',
    probe: 'Executor-style request() exfiltrates the environment report.',
    counter: 'jail: request/HttpRequest in __NILSERVICE — read nil, calls never happen.',
  },

  // ── Dump guards & integrity ───────────────────────────────────────────────
  {
    id: 'dump-stringdump', name: 'string.dump presence', services: ['*'],
    kind: 'dump-guard', severity: 'critical',
    probe: 'string.dump existing = executor tell (production Luau disables it).',
    counter: 'jail: string.dump explicitly nil (v1.8.0).',
  },
  {
    id: 'dump-chunk-capture', name: 'load()-chunk integrity', services: ['*'],
    kind: 'dump-guard', severity: 'degrading',
    probe: 'Chunks are hashed/compared post-load to detect modification.',
    counter: 'jail: capture is pass-through — chunks load unmodified; hashing sees identical bytes.',
  },
  {
    id: 'dump-script-hash', name: 'script source hash checks', services: ['*'],
    kind: 'dump-guard', severity: 'degrading',
    probe: 'getscripthash-style comparisons detect edited sources.',
    counter: 'jail: script is inert; hash paths never execute on host files.',
  },
  {
    id: 'dump-bytecode-guard', name: 'Luau bytecode RSB1 guard', services: ['*'],
    kind: 'dump-guard', severity: 'degrading',
    probe: 'RSB1-prefixed bytecode validated against obfuscator keys.',
    counter: 'engine: bytecode chunks classified and delivered as artifacts; jte lift decodes when built.',
  },

  // ── Residue / output hygiene ──────────────────────────────────────────────
  {
    id: 'residue-antitamper-leftovers', name: 'antitamper residue in output', services: ['*'],
    kind: 'residue', severity: 'degrading',
    probe: 'Admitted competitor weakness: pcall(setmetatable, game, {}) style residue leaks into deobfuscated output and breaks it.',
    pattern: 'setmetatable\\s*\\(\\s*(game|workspace|script)\\s*,|setmetatable\\s*,\\s*(game|workspace|script)\\b', counter: 'neutralize: comment the mutation line; jail note records the family.',
  },
  {
    id: 'residue-force-nil', name: 'ForceNil output pollution', services: ['wearedevs', 'slua'],
    kind: 'residue', severity: 'cosmetic',
    probe: 'Obfuscator emits explicit global-nil assignments that survive into output.',
    counter: 'readability engine: ForceNil-style lines are stripped in post-processing (v2.8.0).',
  },
  {
    id: 'residue-error-trap', name: 'error() validator traps', services: ['*'],
    kind: 'crash-trap', severity: 'degrading',
    probe: 'Validator functions error() on tamper detection; jail must let runs continue past them.',
    counter: 'jail: all probes pcall-guarded — the jail never throws on a sample.',
  },

  // ── Environment shape (production parity) ─────────────────────────────────
  {
    id: 'env-identity-fields', name: 'game identity fields', services: ['*'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'PlaceId/JobId/CreatorId/GameId are read for environment validation.',
    counter: 'jail: real-shaped numbers/UUIDs (v1.8.0).',
  },
  {
    id: 'env-is-probes', name: 'RunService Is* probes', services: ['*'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'IsStudio/IsEdit/IsRunMode must be false, IsClient true — Studio detection fed garbage keys pre-v1.8.0.',
    counter: 'jail: production booleans on every Is*/Has* probe.',
  },
  {
    id: 'env-loaded-gate', name: 'game.Loaded gate', services: ['moonsec_v2', 'moonsec_v3', 'psu'],
    kind: 'time-gate', severity: 'critical',
    probe: 'Yield-gates on game.Loaded before decrypting.',
    counter: 'jail: game.Loaded reads true instantly.',
  },
  {
    id: 'env-cframe-members', name: 'CFrame member access', services: ['25ms', 'wynfuscate'],
    kind: 'env-fingerprint', severity: 'degrading',
    probe: 'CFrame arithmetic used as an environment canary.',
    counter: 'jail: inert chain tolerates indexing/arithmetic without erroring.',
  },
  {
    id: 'env-buffer-lib', name: 'Luau buffer library', services: ['luraph', 'tokrascript'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'Loaders bind buffer at init (v15.1+); absence kills the loader.',
    counter: 'jail: full buffer implementation incl. readbits/writebits/copy/fill (v2.13.0).',
  },
  {
    id: 'env-bit32-floats', name: 'bit32 float-input tolerance', services: ['luraph', 'tokrascript', 'moonsec_v2'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'Decrypt arithmetic feeds FLOATS into bit32 — real 5.3 bitwise ops reject non-integers ("no integer representation" kills the loader).',
    counter: 'jail: every bit32 input reduced mod 2^32 with float floor (v2.14.0).',
  },
  {
    id: 'env-string-char-float', name: 'string.char/rep float tolerance', services: ['luraph', 'tokrascript'],
    kind: 'env-fingerprint', severity: 'critical',
    probe: 'Luau tolerates fractional args where 5.3 demands integers — Luraph v15.1 loaders hit this immediately.',
    counter: 'jail: string.char/string.rep floor their numeric args.',
  },
  {
    id: 'env-luau-extensions', name: 'Luau-only stdlib surface', services: ['*'],
    kind: 'env-fingerprint', severity: 'degrading',
    probe: 'math.round/clamp/sign, string.split, table.find/findLast/create/clear/clone, coroutine.close must exist.',
    counter: 'jail: full Luau extension surface implemented.',
  },
  {
    id: 'env-debug-info', name: 'debug.info shim', services: ['*'],
    kind: 'env-fingerprint', severity: 'degrading',
    probe: 'Luau debug.info exists on every executor; a missing one errors mid-init (leaked detection 10).',
    counter: 'jail: debug.info shim returns nil without fake line numbers (v2.12.0).',
  },
  {
    id: 'env-polyglot-fallback', name: 'polyglot unknown-global fallback', services: ['*'],
    kind: 'env-poison', severity: 'degrading',
    probe: 'State machines probe odd globals; a nil crash aborts the whole harvest.',
    counter: 'jail: unknown reads resolve to a value tolerating index/call/arith/concat — installed LAST so real bindings win.',
  },
  {
    id: 'env-mute-flag', name: 'instrumentation mute flag', services: ['*'],
    kind: 'residue', severity: 'cosmetic',
    probe: 'Lift-worker serialization chatter must never pollute the string pool.',
    counter: 'jail: _BX_MUTE rawget-guard mutes recording during worker-internal work (v2.10.0).',
  },
];

/** Unique ids + lookup helpers. */
export const CATALOG_BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

/** Entries relevant to a family ('*' entries always included). */
export function catalogForFamily(familyId) {
  return CATALOG.filter((e) => e.services.includes('*') || e.services.includes(familyId));
}

/** Compile pattern fields once for the neutralizer. */
export const PATTERNS = CATALOG.filter((e) => e.pattern).map((e) => ({
  id: e.id, name: e.name, severity: e.severity,
  services: e.services, re: new RegExp(e.pattern, 'g'),
}));

/** Every family id that can be forced via prefix commands / detection. */
export const SUPPORTED_FAMILIES = new Set([
  'luraph', 'tokrascript', 'moonsec_v1', 'moonsec_v2', 'moonsec_v3', 'ironbrew1', 'ironbrew2', 'ironbrew3',
  'prometheus', 'hercules', 'psu', 'boronide', 'darksec', 'luaobfuscator_com', 'wearedevs', 'junkie', 'luarmor',
  'somecoolobfuscator', 'moonveil', '77fuscator', 'xhider', 'goofyscator', 'ironveil', '25ms', 'synapsexen',
  'wynfuscate', 'clyde', 'luast', 'asteria', 'catph', 'devlyx', 'dexfuscator', 'realvux', 'lps', 'slua',
  'obfuscator_io', 'js_generic', 'pyarmor', 'upx', 'native_generic', 'unknown',
]);
