# Vendor evaluation — external deobfuscator repos (v2.20.0 sweep)

User-requested evaluation of 5 queued repos (+1 carried over). Method:
`raw.githubusercontent.com/README.md` probe on main/master + `git ls-remote`
existence check (GitHub only asks for credentials when a repo does not exist,
so the auth prompt = dead/renamed/private). API was rate-limited, so raw+git
probes were used instead.

## Verdicts

| Repo | Exists? | What it is | Verdict for our stack |
| --- | --- | --- | --- |
| Prometheus-DeobfuscatorV2/Prometheus-DeobfuscatorV2 | **DEAD** (ls-remote auth prompt) | — | skip |
| jte-lua/lua-decompiler | **DEAD** | — | skip |
| WhoIsIsGenn/deobfuscator | **DEAD** | — | skip |
| Sk8rz/lua-deobf-actions | **ALIVE** (README 200, workflow yaml present) | GitHub Actions pipeline *aggregator* — chains third-party tools: Luraph deobf (C#+Java), Prometheus/White (JS), MoonSec V2/V3 (JS+.NET), IronBrew2/25ms (C#+JS), AztupBrew (JS), generic Python deobf. No new engine code. | reference only — no vendoring (it wraps public tools we already out-perform; adds CI dependency surface for zero gain) |
| caomro2077/Deobfuscator-Luraph-V15 | **DEAD** (ls-remote auth prompt) | — | skip |

## Sk8rz notes (reference, not vendored)
- workflow_dispatch + base64 script input + `auto` obfuscator routing
- installs lua5.4/luajit/dotnet/python/node/java per target — heavy CI, 30-min cap
- its per-family tools (IronBrew2, 25ms, MoonSec, Prometheus) are already
  covered by our engines; the aggregator's value is the *routing table*, which
  our own detect family already handles with live tiers.

## Engine work banked this session (real win, not vendor code)
- v14.7 static devirt groundwork (bloxfruits.lua): wire unwrap → in-VM state
  dump (native luau, 0.7 s vs fengari's incomplete 6.5 s+) → deserialized
  program graph extracted (35 protos / 9,124 instructions) → proto table
  schema mapped (c7=opcode column confirmed behaviorally, 65 live op rows
  classified: ARITH 23 / CALL 13 / COMPARE 12 / CONCAT 2 / RET 3 / closure 3 /
  junk rows filtered) → probe tooling + dump data committed under
  scripts/devirt-bf-v147.js, scripts/probe-bf-isa2.js, scripts/*analyze*.js,
  var/external/bf-v147-*.json. Next: per-proto dispatch-table decryption
  (the 182 ERR-INDEX rows are decoys/decoy-block ops — the lift's decoy
  filter drops them), then liftVmProgram adaptation for the v14.7 schema.
