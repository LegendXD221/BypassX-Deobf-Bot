# BypassX Deobf Bot

**The best Discord bot for deobfuscating code.** Send an obfuscated file or a link — get back clean, readable source via [Pastefy](https://pastefy.app), with the obfuscator auto-detected and a **confidence percentage** shown for every guess.

Powered by the [BypassX Deobf](https://github.com/LegendXD221/BypassX-Deobf) static analysis engine (64 Rust crates, engine 0.12.0) — the same engine behind the [web API](https://bypassx-deobf.onrender.com) — plus [webcrack](https://github.com/j4k0xb/webcrack) for JavaScript.

---

## Highlights

- **Components V2 UI** — every reply is a modern Discord Components V2 card (accent-colored container, sections, separators, link buttons, inline file cards).
- **Auto-detect with confidence %** — weighted byte-signature detection across 27 services; the bot tells you *what* obfuscated the file and *how sure* it is (e.g. `Luraph v15.1 — 99%`).
- **Pure code output** — the Pastefy paste contains **only the deobfuscated code**. No banners, no annotations, no junk.
- **Multi-stage recovery** — targeted family peel → generic auto pipeline (packer chains included) → full 14-family Lua sweep. Fallbacks are automatic and reported in the reply embed.
- **Prefix + slash commands** — `.deobf` and `/deobf` both work everywhere.
- **Dynamic constant harvest (last tier)** — for escrow/anti-tamper VM builds the bot runs ONLY the VM's decryption init inside a jailed fengari Lua VM (no host access, no network, instruction budget + hard SIGKILL) and captures the decrypted string pool — so even "impossible" builds deliver their constants instead of nothing.
- **Honest walls** — when a build is genuinely static-proof the bot says so instead of pasting garbage back. Passthrough echo is detected and rejected.
- **24/7 keep-alive on Render free** — web service + /health checks + 9-minute self-ping through the public URL + an independent GitHub Actions ping every 10 minutes.
- **Hardened** — samples are never executed (pure static analysis), the engine runs in a scrubbed-env 0700 tmpdir with hard timeouts and SIGKILL, and Discord tokens never reach child processes. No vm2/isolated-vm.

## Supported services

### ⬤ Full recovery (devirtualized / unpacked)

| Service | Versions | Notes |
| --- | --- | --- |
| **Luraph** | v11 → **v15.1** (latest) | wire-toolkit: quoted-carrier, BE ascii85, per-build constant-pool decryption; v15 odSQ path; older versions auto-handled too |
| **MoonSec** | V1 / V2 / V3 | static-key builds fully; escrow/runtime-key builds fall back to the jailed-VM dynamic constant harvest |
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
| **77fuscator** | v0.4.7 → 0.6.1 (latest) | detected with version; auto pipeline + dynamic harvest recover constants and code for tested 0.6.x builds |
| **Xhider** | latest | detected; MoonSec-style VM |
| **GoofyScator** | current (polymorphic VM) | detected; anti-tamper + proxy-locals |
| **Ironveil** | latest | detected |
| **25ms** | branded builds | detected; routes into VM peelers |
| IronBrew 3, Synapse Xen, wYnFuscate, Boronide, DarkSec, luaobfuscator.com, PSU, generic JS/packers | latest | detected + attempted |

*The bot never pretends: if a build keeps its keys at runtime, you get a clear explanation, not fake output.*

## Commands

| Prefix | Slash | What it does |
| --- | --- | --- |
| `.deobf` | `/deobf file:` `/deobf link:` | Detect + deobfuscate an attached file or linked file → Pastefy link (+ inline preview for small outputs) |
| `.detect` | `/detect file:` `/detect link:` | Detection report only: confidence bar, evidence, runner-up candidates |
| `.beautify` | `/beautify file:` `/beautify link:` | Reformat messy/minified code — no deobfuscation |
| `.strings` | `/strings file:` `/strings link:` | Extract the string table — quick recon of what the file hides |
| `.paste` | `/paste file:` `/paste text:` | Upload any text/file to Pastefy (large content auto-split into parts) |
| `.stats` | `/stats` | Jobs served, success rate, uptime, engine build |
| `.families` | `/families` | Full support table with version ranges and recovery tiers |
| `.help` | `/help` | Overview |
| `.ping` | `/ping` | Latency |
| `.invite` | `/invite` | Add the bot to your server |

**Owner-only** (locked to `OWNER_ID`, default `1134757298733064203`):

| Prefix | Slash | What it does |
| --- | --- | --- |
| `.eval` | `/eval code:` | Evaluate JavaScript in a jailed sandbox (no require/process/network, 5s cap) |
| `.exec` | `/exec command:` | Run a shell command on the host (bash, 20s timeout) |
| `.servers` | `/servers` | List every server the bot is in |
| `.leave` | `/leave guild_id:` | Leave a server |
| `.setstatus` | `/setstatus text:` | Change the bot presence |
| `.logs` | `/logs count:` | Tail the in-process log ring buffer |
| `.shutdown` | `/shutdown` | Graceful stop (Render restarts the service) |

`.deobf` accepts the file attached to your message **or** as a reply to a message containing one. It also accepts **links** — paste any of these after the command:

- `pastefy.app/<id>` — Pastefy pastes (fetched via the API)
- `github.com/u/r/blob/…` / `/raw/…` — GitHub files (private repos work when the server has `GITHUB_TOKEN`)
- `gist.github.com/u/<id>` — gists (first file)
- `pastebin.com/<id>` — Pastebin (rewritten to `/raw/`)
- `discord.com/channels/…/<message>` — Discord message links: I read the message's first attachment (or its text)
- any direct URL to the raw obfuscated file

Every redirect hop is DNS-checked and private/reserved/metadata addresses (127/8, 10/8, 169.254/16 including cloud metadata, …) are blocked — the link fetcher is SSRF-hardened like the rest of the pipeline. Size limit 10 MB (configurable). Results arrive as a Components V2 card with **paste + raw buttons**, an inline preview, and the recovered file attached.

### Accuracy: verified output, not promises

Every recovered file is **parsed before delivery** — Lua through a real Lua
grammar check (jailed fengari compile, Luau retried via a syntax shim) and
JavaScript through a V8 parse. When the engine returns several candidates the
pipeline **promotes the first one that actually parses**, and the success card
shows the honest result:

- `Verified: ✓ Lua syntax OK` — the delivered code parses cleanly
- `Verified: ⚠ syntax check failed — …` — rare; the best available output is still delivered, honestly labeled
- `Verified: ○ binary output — no source parser` — unpacked binaries

Large recovered files no longer fail to paste: the Pastefy client now splits
content into **multi-part pastes** (the old single-request path hit Pastefy's
~1.1 MB request limit and returned 413 — that was the "failed to paste" bug).
Chunking budgets the JSON-escaped size, splits on line boundaries, and every
part is verified fetchable.

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
node test/links.js                             # link support: unit + live fetch tests
node test/e2e-links.js                         # link → deobf end-to-end (needs engine)
```

## Deploy on Render (free tier, 24/7)

This repo ships a [Blueprint](render.yaml): **Render → New → Blueprint** → pick the repo → fill `DISCORD_TOKEN` / `CLIENT_ID` / `PUBLIC_URL` → deploy. It runs as a **free web service** (`node bin/prepare-engine.js && node src/index.js`) whose keep-alive HTTP server answers Render health checks.

Render free services sleep after 15 idle minutes — three layers prevent that:

1. **Self-ping** — every 9 min the service hits its own `PUBLIC_URL/health` through the public load balancer (localhost pings don't count for Render's idle timer).
2. **GitHub Actions** — [.github/workflows/keepalive.yml](.github/workflows/keepalive.yml) pings `/health` every 10 min (set the repo secret `KEEPALIVE_URL` to your service URL).
3. **/health** — live status JSON (discord state, engine version, job counters) also rendered as a human status page at `/`.

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
Discord (discord.js v14, Components V2 UI)
  ├── prefix + slash command layer          src/commands, src/index.js
  ├── V2 reply builders                     src/replies.js     (containers, sections, buttons, file cards)
  ├── detection  (weighted signatures)      src/detect.js
  ├── pipeline   (routing + retries)        src/pipeline.js
  │     ├── Rust engine bridge              src/engine.js      (lua peel / auto / pyarmor / py decompile)
  │     ├── webcrack worker (isolated)      src/webcrack-worker.js (obfuscator.io, JS)
  │     ├── dynamic constant harvest        src/harvest.js + src/harvester-worker.js (jailed fengari VM)
  │     ├── Luau → Lua shim                 src/luau-shim.js   (compound-assign rewrite)
  │     └── post-process (pure output)      src/postprocess.js
  ├── Pastefy delivery                      src/pastefy.js
  ├── keep-alive HTTP server                src/keepalive.js   (/health, status page, self-ping)
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

**What this bot adds over the OSS bots:** 27-service detection with confidence %, Luraph v11–v15.1 wire decryption, a 64-crate static engine (Lua VMs + Python + packers in one), a jailed-VM dynamic constant harvester for escrow builds, pure-output policy, honest walls, Components V2 UX, dual prefix/slash commands, 24/7 free-tier keep-alive, and hardened sandboxing.

## License

MIT — see [LICENSE](LICENSE).
