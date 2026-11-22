# vendor/omnidbf — ported OmniDBF family deobfuscators (v2.24.0)

Static family deobfuscators ported from the OmniDBF bot source
(user-delivered via TransferXL, rebranded to Lucid Deobf at intake) into
this repo. Upstream author credit: **jamie @_jmi. / @jmialt_** — headers
preserved in every vendored file. Third-party licenses kept in place
(LuaObf-Deobf, ProstoneDeobf).

This tree is a **CommonJS island** inside the ESM bot repo
(`package.json` here pins `"type": "commonjs"` — do not remove it).
Nothing here is imported into the bot process: every family runs inside
`src/ported-worker.cjs` through `spawnHardened` (scrubbed env, hard
timeout, SIGKILL) — see `src/ported.js`.

## Ported (pure static — no external runtimes)

| Family | Module | Used by |
| --- | --- | --- |
| Clyde | `clyde_static_deob.js` + `clyde/` | `.clyde`, auto route (PORTED_FIRST) |
| LuaObfuscator.com | `LuaObf-Deobf/` (MIT) | `.lo`, auto route (PORTED_FIRST) |
| Prostone | `ProstoneDeobf/` (MIT — LeakD's Prometheus Deobfuscator fork) | `.prostone` (new command, v2.24.0) |
| IronVeil V1 | `ironveil_deob.js` + `IronveilV1/` | `.iv`, auto route (PORTED_FIRST) |
| MoonVeil (static) | `moonveil_deob.js` (envlogger dump runtime NOT vendored — stubbed) | fallback tier after harvest |

`moonveil_deob.js` carries a PORT PATCH: `require('../envlogger')` is
replaced with an unavailable stub. The lune dump runtime executes samples
outside this bot's jailed fengari VM, which violates the never-execute
guarantee — so only the static paths (detect / peelEnvelope /
extractReconstruction / loader-stub messaging) are functional here; VM
builds keep flowing through the engine sweep + jailed harvest.

## Deliberately NOT vendored (and why)

| Upstream module | Reason |
| --- | --- |
| `goofyscator/decompiler.py` | executes the sample inside a `lune` interpreter (subprocess) — never-execute violation. The useful part (executor environment mocks) was ported into `src/jail-prelude.js` (Luau `Random` class) instead. |
| `77fuscatorDeobf/deobfuscator.dll` | needs a .NET runtime on the host |
| `PSU-Deobfuscator` (Java engine) | needs a JRE (ships a Windows JDK) |
| `DeltaBypass/` | heavy Python key-bypass service (numpy/scipy/Pillow/fastapi/captcha) |
| `envlogger/` + `envlogger.js` | runs builds under `lune` (sample execution); 8.7 MB |
