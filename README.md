# BypassX Deobf Bot

**The best Discord bot for deobfuscating code.** Upload an obfuscated file — get back clean, readable source via [Pastefy](https://pastefy.app), with the obfuscator auto-detected and a **confidence percentage** shown for every guess.

Powered by the [BypassX Deobf](https://github.com/LegendXD221/BypassX-Deobf) static analysis engine (64 Rust crates, engine 0.12.0) — the same engine behind the [web API](https://bypassx-deobf.onrender.com) — plus [webcrack](https://github.com/j4k0xb/webcrack) for JavaScript.

---

## Highlights

- **Auto-detect with confidence %** — weighted byte-signature detection across 27 services; the bot tells you *what* obfuscated the file and *how sure* it is (e.g. `Luraph v15.1 — 99%`).
- **Pure code output** — the Pastefy paste contains **only the deobfuscated code**. No banners, no annotations, no junk.
- **Multi-stage recovery** — targeted family peel → generic auto pipeline (packer chains included) → full 14-family Lua sweep. Fallbacks are automatic and reported in the reply embed.
- **Prefix + slash commands** — `.deobf` and `/deobf` both work everywhere.
- **Honest walls** — when an obfuscator's newest build is genuinely static-proof (runtime-derived VM keys), the bot says so instead of pasting garbage back. Passthrough echo is detected and rejected.
- **Hardened** — samples are never executed (pure static analysis), the engine runs in a scrubbed-env 0700 tmpdir with hard timeouts and SIGKILL, and Discord tokens never reach child processes. No vm2/isolated-vm.

## Supported services

### ⬤ Full recovery (devirtualized / unpacked)

| Service | Versions | Notes |
| --- | --- | --- |
| **Luraph** | v11 → **v15.1** (latest) | wire-toolkit: quoted-carrier, BE ascii85, per-build constant-pool decryption; v15 odSQ path; older versions auto-handled too |
| **MoonSec** | V1 / V2 / V3 | static-key builds fully; escrow/runtime-key builds report an honest wall |
| **IronBrew** | 1 (Aztup Brew) & 2 | IronBrew2 = full devirt |
| **Prometheus** | latest, incl. **VMify** | AST + VM pipeline |
| **Hercules** | V2.x (latest) | full devirt |
| **obfuscator.io** | v4.x latest | webcrack: string-array (Base64/RC4), self-defending, control-flow, bundlers |
| **pyArmor** | v6 / v7 / v8 / **v9-pro** | static unpack → reconstructed `.pyc` → decompile; zip the obfuscator output (script + `pyarmor_runtime_*`) for v8/v9 |
| **UPX** | 3.x–5.x | packer chains via engine auto; unpacked binary returns as a Discord attachment |
| luau bytecode, SLua, WeAreDevs, PSU | latest | engine families |

### ◐ Partial recovery / best-effort (detected + attempted)

| Service | Versions | Status |
| --- | --- | --- |
| **MoonVeil** | v1.x → 2.0.26 (latest) | detected with version; current builds are full-VM — honest wall |
| **77fuscator** | v0.4.7 → 0.6.1 (latest) | detected with version; custom VM — honest wall |
| **Xhider** | latest | detected; MoonSec-style VM |
| **GoofyScator** | current (polymorphic VM) | detected; anti-tamper + proxy-locals |
| **Ironveil** | latest | detected |
| **25ms** | branded builds | detected; routes into VM peelers |
| IronBrew 3, Synapse Xen, wYnFuscate, Boronide, DarkSec, luaobfuscator.com, PSU, generic JS/packers | latest | detected + attempted |

*The bot never pretends: if a build keeps its keys at runtime, you get a clear explanation, not fake output.*

## Commands

| Prefix | Slash | What it does |
| --- | --- | --- |
| `.deobf` | `/deobf file:` | Detect + deobfuscate an attached file → Pastefy link (+ inline preview for small outputs) |
| `.detect` | `/detect file:` | Detection report only: confidence bar, evidence, runner-up candidates |
| `.families` | `/families` | Full support table with version ranges and recovery tiers |
| `.help` | `/help` | Overview |
| `.ping` | `/ping` | Latency |
| `.invite` | `/invite` | Add the bot to your server |

`.deobf` accepts the file attached to your message **or** as a reply to a message containing one. Size limit 10 MB (configurable).

## Quick start (self-host)

```bash
git clone https://github.com/LegendXD221/BypassX-Deobf-Bot
cd BypassX-Deobf-Bot
npm install
cp .env.example .env   # fill in DISCORD_TOKEN + CLIENT_ID
npm start
```

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications) → **Bot** → Reset Token → copy into `.env`.
2. **Enable `MESSAGE CONTENT INTENT`** on the same page (required for prefix commands).
3. Copy the **Application ID** into `CLIENT_ID` (slash commands self-register on boot; set `GUILD_ID` for instant guild-only registration while developing).
4. `npm start` downloads the deobf engine once (~50 MB) from the GitHub release, then connects.

Local testing without Discord:

```bash
npm run prepare-engine                 # fetch the engine
node test/run.js path/to/obfuscated.lua        # detect + deobf + paste
node test/run.js --detect-only file.lua        # detection report only
```

## Deploy on Render (free tier)

This repo ships a [Blueprint](render.yaml): **Render → New → Blueprint** → pick the repo → fill `DISCORD_TOKEN` / `CLIENT_ID` → deploy. It runs as a worker: `node bin/prepare-engine.js && node src/index.js`.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | **required** bot token |
| `CLIENT_ID` | — | **required for slash/invite** application id |
| `GUILD_ID` | — | instant slash registration to one guild (dev) |
| `PREFIX` | `.` | prefix-command prefix |
| `PASTEFY_TOKEN` | anonymous | Pastefy API key (free at pastefy.app/apikeys) |
| `PASTEFY_EXPIRE_DAYS` | `30` | paste expiry (0 = never) |
| `ENGINE_URL` | release asset | engine `.gz` download URL |
| `ENGINE_PATH` | — | use a local engine binary instead |
| `MAX_UPLOAD_MB` | `10` | attachment cap |
| `ENGINE_TIMEOUT_S` | `180` | per-run wall clock |

## How detection works

Every service carries weighted byte-level indicators (version headers, VM macros, runtime markers, identifier floods, binary magics) scanned over the first 256 KB + last 64 KB. Scores blend absolute evidence strength with the gap to the runner-up, so a version-header hit reads 90–99% while a lone heuristic stays 35–60%. Version strings are extracted straight from headers (`Luraph Obfuscator v15.1`, `MoonVeil 2.0.26`, `77fuscator 0.6.1`, …). Calibrated against the public [terrorlua/obfuscator-samples](https://github.com/terrorlua/obfuscator-samples) corpus (Luraph v1→v15.1, MoonVeil, 77fuscator, MoonSec, IronBrew 1/2/3, PSU, Boronide, Hercules, Prometheus, SynapseXen, wYnFuscate).

## Architecture

```
Discord (discord.js v14)
  ├── prefix + slash command layer          src/commands, src/index.js
  ├── detection  (weighted signatures)      src/detect.js
  ├── pipeline   (routing + retries)        src/pipeline.js
  │     ├── Rust engine bridge              src/engine.js      (lua peel / auto / pyarmor / py decompile)
  │     ├── webcrack worker (isolated)      src/webcrack-worker.js (obfuscator.io, JS)
  │     └── post-process (pure output)      src/postprocess.js
  ├── Pastefy delivery                      src/pastefy.js
  └── hardening                             src/security.js    (env scrub, tmpdir, timeouts, SIGKILL)
```

The engine binary is fetched at boot from the repo's GitHub Release — no Rust toolchain needed to run the bot.

## Credits & prior art

Built standing on excellent open-source work:

- [webcrack](https://github.com/j4k0xb/webcrack) — the obfuscator.io killer
- [Svenskithesource/PyArmor-Unpacker](https://github.com/Svenskithesource/PyArmor-Unpacker) & [Lil-House/Pyarmor-Static-Unpack-1shot](https://github.com/Lil-House/Pyarmor-Static-Unpack-1shot) — pyArmor research
- [PhoenixZeng/LuraphDeobfuscator](https://github.com/PhoenixZeng/LuraphDeobfuscator), [Lethal-Luka/IronbrewDeobfuscator](https://github.com/Lethal-Luka/IronbrewDeobfuscator), [ben-sb/obfuscator-io-deobfuscator](https://github.com/ben-sb/obfuscator-io-deobfuscator), [BlackCatOfficialytb/xhider-deobfuscator](https://github.com/BlackCatOfficialytb/xhider-deobfuscator) — technique references
- [terrorlua/obfuscator-samples](https://github.com/terrorlua/obfuscator-samples) — labeled sample corpus used for calibration
- [upx/upx](https://github.com/upx/upx), [Pastefy](https://pastefy.app)

**What this bot adds over the OSS bots:** 27-service detection with confidence %, Luraph v11–v15.1 wire decryption, a 64-crate static engine (Lua VMs + Python + packers in one), pure-output policy, honest walls, dual prefix/slash UX, and hardened sandboxing.

## License

MIT — see [LICENSE](LICENSE).
