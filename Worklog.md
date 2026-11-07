# Worklog — BypassX Deobf Bot

Self-updating worklog. Read before work; update + push after every change.

---

## 2026-11-07 — v1.2.0 "link support"

### Added
- **Link input everywhere** (`src/fetchurl.js` new): `.deobf <url>`, `.detect <url>`,
  `/deobf link:`, `/detect link:` — plus reply-to-message now also picks a link
  out of the referenced text. Host-aware resolvers:
  - **Pastefy** `pastefy.app/<id>` → API raw content (title becomes filename,
    extension sniffed from content)
  - **GitHub** `blob|raw` → raw.githubusercontent rewrite; **private repos**
    auto-retry with the server's `GITHUB_TOKEN` (note becomes
    "GitHub file (private)")
  - **Gists** via `api.github.com/gists/<id>` (token-aware), first file
  - **Pastebin** `pastebin.com/<id>` → `/raw/<id>` rewrite
  - **Discord message links** `discord.com/channels/…/<msg>` — bot resolves the
    message and takes its first (largest) attachment, else the text content
  - **any direct URL** — browser-UA fetch, extension guessed by content sniff
    (lua/js/py/exe/gz/zip/elf/txt)
- **SSRF-hardened fetcher** (`safeFetch`): manual redirect loop (≤5 hops),
  every hop DNS-resolved and compared against a private/reserved blocklist
  (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl. cloud metadata,
  100.64/10, ULA/link-local/mapped v6, localhost/internal suffixes); plaintext
  http is upgraded to https; bodies size-capped while streaming; non-http(s)
  schemes rejected (`ftp://` friendly error). Fits the bot's RCE-protected
  story: samples are never executed, and links can never probe the internal
  network.
- **Unified input resolution** (`getInputBuffer` in `src/ctx.js`): link →
  attachment → referenced message (attachment or link inside its text), with
  user-safe error strings.
- Replies now show the fetched source: success card gets "• **Source:** link"
  + `-# Fetched from <note> — <url>`; detection report same. Help panel lists
  link sources. Success/detection cards pass `sourceUrl`/`sourceNote` through.
- **Tests**: `test/links.js` (17 checks: URL parsing, scheme rejection, private
  IP blocklist, SSRF blocks incl. loopback + cloud metadata + localhost,
  content sniffing, live GitHub/direct/Pastefy round-trip) and
  `test/e2e-links.js` (link → engine end-to-end). Both green locally.

### Fixed
- `normalizeUrl` silently rewrote `ftp://…` into `https://ftp://…` — now any
  explicit non-http(s) scheme is rejected up front.

### Verified (local, real samples)
- Link e2e: Prometheus VMify 1,596 B fetched from a GitHub link (private-repo
  token path) and from a Pastefy paste → **Prometheus 99% → full peel, 836 B
  recovered**, both sources, pastes OK.
- `node test/links.js` — 17 passed / 0 failed (includes live Pastefy
  round-trip + GitHub blob fetch).
- `node test/v2-smoke.js` — 13/13 Components V2 replies still pass.

### Next
- UptimeRobot external monitor (user-side, optional third-party layer).
- Luraph v15.1 devirtualization roadmap (per-build key capture).
- MoonSec V2 escrow dispatcher compatibility in the harvest jail.

---

## 2026-11-07 — v1.1.0 "Components V2 + dynamic harvest + 24/7 deploy"

### Added
- **Components V2 UI everywhere** (`src/replies.js` rewritten): accent-colored
  containers, sections w/ avatar thumbnails, separators, link buttons
  (paste / raw / invite / repo), inline File cards for recovered code and
  unpacked binaries. 13-reply smoke suite: `node test/v2-smoke.js` (all pass).
- **Dynamic constant harvester** (`src/harvest.js`, `src/harvester-worker.js`):
  jailed fengari (pure-JS Lua 5.3) VM that runs ONLY an obfuscator's decryption
  init — io/os/require removed, `bit32`/`bit` shims, getfenv/setfenv/unpack/
  loadstring 5.1 compat, inert Roblox proxies, polyglot NEUTRON fallback for
  missing globals, string sinks on char/sub/rep/reverse/upper/lower/format/
  gsub/table.concat, 300M instruction budget via debug count hook, graceful
  SIGTERM dump + spawnHardened 5s SIGKILL backstop. Verified live: MoonSec V3
  sample → 43 decrypted strings → Pastefy.
- **Luau → Lua shim** (`src/luau-shim.js`): string/comment-aware rewrite of
  Luau compound assignments (`o*=-1`, `h+=b`, `s..=t`, `x//=y`) that standard
  Lua VMs reject; best-effort, falls back to the original source on any doubt.
- **Keep-alive HTTP server** (`src/keepalive.js`): `/health` JSON, human
  status page at `/`, job counters, 9-min self-ping through `PUBLIC_URL`
  (through Render's LB — localhost doesn't reset the idle timer), engine
  probe cache. GitHub Actions layer: `.github/workflows/keepalive.yml`
  (pings every 10 min via `KEEPALIVE_URL` repo secret).
- **Engine release asset**: `bypassx-deobf.gz` (51.5 MB, engine 0.12.0,
  commit 54c88e2) uploaded to this repo's `engine-v0.11.0` release —
  `ENGINE_URL` default now resolves with zero auth on every boot (~7 s).

### Fixed
- `src/commands/help.js` had a syntax error (`elpEmbed` + stray bracket) that
  crashed the module load — caught by local testing, rewritten.
- webcrack passthrough false-positive: deobfuscated obfuscator.io output kept
  `_0x…` hex names (`mangle:false`), tripping the "still obfuscated" guard.
  Fixed by `mangle:true` in the worker + size-aware guard (flood ≥30 AND
  output ≥90% of input size). obfuscator.io RC4 sample: 7484 → 720 B full
  recovery.
- `guessLanguage` misrouted Luraph v15.1 (Lua) to the JS pipeline; now requires
  JS-only tokens (`const/let/=>/_0x…`) ≥2, and Lua `then` counts subtract JS
  `.then(` promise calls.
- Slash registration rejected: `deobf` description >100 chars → shortened.
- `tryHarvest` missing `stages` param → ReferenceError on first harvest run.

### Changed
- `render.yaml`: worker → **free web service** (`type: web`, healthCheckPath
  `/health`); workers aren't on the free plan.
- discord.js `^14.16.3` → `^14.28.1` (Components V2 support).
- Version 1.0.0 → 1.1.0.

### Verified (local, real samples)
- Prometheus VMify: full peel, paste OK.
- Hercules gauntlet 329 KB → 127 KB, paste OK.
- IronBrew2 hello/arith: recovered via auto, paste OK.
- Luraph v14.3 (constants decrypted), v14.7, v15.0, v15.1_a, v15.1_b, corpus
  v15.1: payload extraction + pastes OK.
- MoonSec V3 (escrow): 43-string dynamic harvest → paste OK.
- 77fuscator 0.6.1: 61 KB → 113 KB recovery → paste OK.
- obfuscator.io (RC4 + control-flow + rotate): full recovery → paste OK.
- Honest walls (no crash, clear notes): moonsec_v2 (escrow, 0 sink strings),
  moonsec_v3_b (escrow), moonveil 2.0.26 (full VM).

### Deployment (LIVE)
- **Live at https://bypassx-deobf-bot.onrender.com** — Render free web service
  `srv-dbnf4lp5efls73b60sp0` (original account), repo-based, autoDeploy from
  `main`, health check `/health`. Verified: `/health` 200 with
  `discordReady: true`, engine 0.12.0, v1.1.0.
- 24/7 plan on the free tier: `/health` checks + 9-min self-ping via
  PUBLIC_URL + GitHub Actions keepalive (secret KEEPALIVE_URL) every 10 min.
  The set-aside `bypassx-deobf` API service was **suspended** to free the
  workspace's 750 free instance-hours for the bot (re-enable in one click if
  ever needed; repo + code untouched).
- New-account deploy attempted first (token rnd_wlDo…): team workspace →
  Render requires a payment method for free services (HTTP 402), and repo
  deploys need the GitHub App connected (browser-only step). Prepared anyway:
  GHCR registry credential `rgc-dbnf0bqjnfac73c6v3kg` + public image
  `ghcr.io/legendxd221/bypassx-deobf-bot:latest`. Once a card is added there,
  the service can be created from the image in one API call.
- Backup artifact: Dockerfile + build-image.yml push the image to GHCR on
  every push to main.
- Bot verified live in sandbox before deploy: login OK (`BypassX Deobf#0267`),
  6 global slash commands registered on app 1568531740530581586, `/health`
  OK, engine probe OK.

### Next
- UptimeRobot external monitor (user-side, optional third-party layer).
- Luraph v15.1 devirtualization roadmap (per-build key capture).
- MoonSec V2 escrow dispatcher compatibility in the harvest jail.
