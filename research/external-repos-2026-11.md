# External repo scan — 2026-11-09 (five repos, checked hands-on)

Companion to `unveilr-v3-notes.md`. Every repo in this batch was cloned and
inspected (or confirmed dead); the promising ones were actually **executed
against real generated samples**, not just read. Verdicts are honest — two of
the three live repos did not survive testing.

## Verdict table

| Repo | Status | Verdict |
|---|---|---|
| [0x251/Prometheus-DeobfuscatorV2](https://github.com/0x251/Prometheus-DeobfuscatorV2) | live, 55★ | **Useful — mined** (technique intel) |
| [Virtualfluembody/prometheus-deobfuscator-rblx](https://github.com/Virtualfluembody/prometheus-deobfuscator-rblx) | **404 — dead** | unusable |
| [jte/lua-decompiler](https://github.com/jte/lua-decompiler) | live, active (Oct 2026) | **Reference-grade** — future integration node |
| [WhoIsGenn/deobfuscator](https://github.com/WhoIsGenn/deobfuscator) | **404 — dead** (user exists, 13 repos, none named deobfuscator) | unusable |
| [Sk8rz/lua-deobf-actions](https://github.com/Sk8rz/lua-deobf-actions) | live, 0★ | **Treasure chest** — vendored tools mined; its own White tool failed testing |

## 1. 0x251/Prometheus-DeobfuscatorV2 — useful, mined

Research-grade Prometheus deobfuscator (Lua 5.1/LuaJIT, ~1.6k lines, 12 passes,
needs the Prometheus obfuscator source beside it). Its unique techniques:

- **ConstantArrayDecode** — unrotates the `{1,17},{1,4},{5,17}` two-pointer
  rotation, base64-decodes, inlines constants.
- **UndoEncryptStrings** — reconstructs the PRNG *statically*: extracts
  `state_45 * M + A`, `state_8 * M % 257`, `secret_key` from the unparser
  output and rebuilds the LCG byte stream in Lua. Version-locked (matches one
  Prometheus string-encryption layout) but the pattern-extraction idea is
  reusable.
- **UndoProxifyLocals** — detects `t.a = <name>`-style proxy tables and
  rewrites reads/writes back to direct variables.
- **DispatchFlatten** (initial attempt), **UndoVmify**, dynamic trace with
  Roblox stubs, per-step metrics.

**What we took:** validation that our new `.prom` deep pass covers the same
ground (rotation + decoder undo) with a *stronger* method — instead of
statically reimplementing their encoder, we execute the obfuscator's own
decoder in a jailed Lua state (see §5). Their `UndoProxifyLocals` remains on
our roadmap as a post-restore pass.

## 2 & 4. The dead links

Both return 404. `WhoIsGenn` exists but has no deobfuscator repo (13 repos,
none match). Nothing to mine; do not retry.

## 3. jte/lua-decompiler — reference-grade Rust tool

Decompiles Lua 5.1–5.5, LuaJIT and **Luau bytecode versions 3–14** back to
source in Rust (also WASM at lua-decompiler.com). Actively maintained. Its
deobfuscation passes only rewrite what they can prove equivalent: opaque
predicates, junk loops, constant folding/propagation, lookup-table resolution,
**XOR string decoding with a bounded evaluator**, constant/identity function
inlining, dead-code removal, re-bound API naming. Plus **JMP-spaghetti
control-flow unflattening** and a CFG exporter/interactive bytecode debugger.

**Where it fits us:** when our jailed runs capture raw Lua/Luau *bytecode*
(`string.dump` payloads, Luau compile output), this is the highest-quality
off-the-shelf lifter available. Not integrated this sweep (Rust build, scope);
logged as the future node between our capture stage and delivery. Its
"structuring falls back to a while-loop state machine for irreducible flow"
matches our vm-lift pc-runner philosophy — good validation.

## 5. Sk8rz/lua-deobf-actions — vendored tools chest (and a broken tool)

An aggregator workflow (0★, 3 commits) that vendors *other people's*
deobfuscators. The chest is worth more than the wrapper:

- **`white/` — a Node.js Prometheus deobfuscator** (8.3k lines of passes on
  `luaparse`: constant-array 1.4k, readability 2.1k, rename 1.3k, dead-code,
  simplify, unwrap, `prometheus/devirtualize.js` for VMify, inliner).
  **TESTED AND REJECTED:** on a real Prometheus Weak-preset build it returned
  a 7-byte `do end` husk; on its target shapes it emitted undecrypted
  constants and nil-injected garbage (`D(11722502, {nil}, u)`). The pass loop
  (devirtualize → remove-unused-locals → cleanup-vm-remnants) destroys live
  code it cannot prove. Do not integrate. **Its vendored luaparse helpers
  (`lua/parse.js`, `lua/emit.js`) are sound and now vendored under
  `vendor/white/` where our own pass uses the emitter.**
- **`luraph-csharp/`** — a complete static Luraph VM deserializer in C#
  (4.5k lines): `LuraphDecoder.cs` (1.6k), `LuraphLifter.cs` (788),
  `HookFinder.cs`, `OpcodeMap.cs` + AST passes including
  `NumParamsInferrer.cs`. The checked-in `tmp_profile_v14.json` exposes the
  concrete v14 serialization surface:
  - `protoFormat: 2`, `twoChunk: false`, `booleanAsVarInt: true`
  - `charTableInitState: 0`, `charTableXorMask: 127`
  - `lcgMultiplier: 65`, `lcgIncrement: 117`
  - `floatTag: 82`, `stringTag: 240`, `constantsOffset: 22172`,
    `prototypesOffset: 98456`, `instructionsOffset: 12746`,
    `dispatchMode: 1`
  - operand modes: `0=constant, 1=relForward, 2=closureRef, 4=relBackward,
    7=register`
  Our v14 chain captures these *behaviorally* at runtime (no static parser),
  so this profile is cross-validation intel for a future static v14
  deserializer — and the operand-mode table directly matches the operand
  roles our probes recover.
- **`luraph/java/`** — AST pass set (BasicRenamer, ConstantFolder,
  ConstantPropagator, SourceGenerator, OptimizerMgr).
- **`medal-decompiler/`** — Rust Luau bytecode decompiler (deserializer,
  lifter, restructure crates); second opinion to jte's.
- **`ironbrew/`** — C# Ironbrew deobfuscator (we already handle IronBrew
  behaviorally).

## 6. What this scan produced in the bot (this sweep)

1. **CHECK\*-lite branch comments on the vm-lift devirt output**
   (`src/vm-lift.js`): every conditional/unconditional edge in the
   devirtualized pc-runner now carries a branch comment in the leaked
   SecureEnv CHECKIF style — `-- CHECK*-lite branch if id: N`, `-- ran, if
   id: N (taken)` / `-- didnt run (else) → [target]` — with the skip delta
   taken from the handler's *observed* probed behavior when available
   (honestly labeled `guessed from operand fields` otherwise). Fixed a real
   control-flow bug on the way: JMP-classified opcodes previously fell into
   the `(unclassified)` arm and advanced `__pc` by 1 instead of jumping;
   they now emit the real edge with target label and loop-back-edge marking.
2. **Prometheus deep static pass** (`src/prometheus-deep.js`, wired into the
   `prometheus` family route *before* the engine peel): locates the string
   table + rotation loop + accessor + decoder block as raw source slices,
   executes them **verbatim in a jailed fengari state** (stdlib minus
   io/os/load, count-hook budget), reads the decoded pool back, inlines every
   `A(<num>)` call site with the decoded literal, deletes the scaffolding,
   and gates on: 100% literal call sites resolved + scope-aware
   dangling-reference check (survives the obfuscator's name shadowing) +
   fengari re-verify. Ground-truth fixture pair generated with the *actual*
   Prometheus obfuscator (levno-710, Weak preset) is vendored at
   `test/fixtures/prometheus-weak-{src,obf}.lua`.
   **Before:** 4778 B in → 248 B string-pool dump. **After:** 4696 B verified
   code body with `"LocalPlayer"`, `"GetService"`, `"WalkSpeed"` … visible at
   their call sites.
3. **`vendor/white/`** — only the sound pieces of White (AST helpers/emitter);
   the destructive pass pipeline stays out.

## 7. Follow-ups logged

- CFF unflattening for the Prometheus-lineage numeric dispatch (`U = 12634606`
  handlers) — dynamic-trace reconstruction in our jail is the plan; 0x251's
  DispatchFlatten is an initial static attempt.
- jte/lua-decompiler as a bytecode-lifting node (Rust binary) behind a
  capability probe.
- `UndoProxifyLocals`-style post-restore pass for Prometheus family outputs.
