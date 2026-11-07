# Worklog — BypassX Deobf Bot

Self-updating worklog. Read before work; update + push after every change.

---

## 2026-11-07 — v1.4.0 "5-layer owner protection + Neon DB + anti-RCE"

### User asks driving this release
1. Remove **Link Sources** + **How It Works** from the help command. → done.
2. More powerful/dangerous commands, all protected by owner id with
   **5 layers of protection**. → done (see below).
3. "Make more better rced" — clarified: **no one should be able to use RCE to
   exploit the bot or abuse it** → hardened, not empowered (eval stays jailed,
   moved into a secret-free child process; see hardening notes).

### Added — dangerous owner commands (all danger-gated: L1–L5)
- `.restart` — destroy client + exit(0); Render reboots the service.
- `.db <sql | status>` — raw SQL on the Neon DB (`rawSql` in src/db.js);
  rows rendered as pipe tables, 20-row cap, latency + rowcount meta.
- `.broadcast <text>` — every guild's system channel (or first sendable),
  250 ms pace, skips blacklisted guilds, sent/failed report.
- `.dm <userId> <text>` — direct message any user.
- `.leave` / `.shutdown` / `.exec` / `.eval` — promoted to `danger: true`.
- Non-danger owner tools: `.blacklist add|remove|list`, `.activity`, `.env`
  (names + masked values only), `.owner` (panel + `/owner audit`).
- Public: `.history` (own recent jobs from the DB).

### Added — 5-layer protection (src/owner-guard.js, enforced in src/index.js)
- **L1 identity** — exact `CONFIG.ownerId` match; no roles/permission paths.
- **L2 PIN** — optional `OWNER_PIN`: prefix first-arg or slash `pin` option
  (auto-added to danger slash defs by `toSlashJson`); 3 fails → 15 min lock;
  correct pin resets the counter; stripped from args before commands run.
- **L3 confirm** — single-use danger button card (30 s), owner-only clicks,
  other users get an ephemeral refusal and the gate stays armed; buttons are
  stripped after resolution.
- **L4 rate limit** — 1 concurrent, 10 s cooldown (`DANGER_COOLDOWN_S`),
  12/hour cap (`DANGER_MAX_PER_HOUR`).
- **L5 audit** — every attempt (allowed/denied + layer) → console + Neon
  `owner_audit`; denials DM the owner (`alertOwner`, fire-and-forget).
- Blacklist gate: `blacklistHas(user)` + `blacklistHas(guild)` checked before
  every dispatch (30 s cache, owner bypasses, DB outage never blocks).

### Added — Neon Postgres free-tier support (src/db.js, `pg` dep)
- Activated **only** by `DATABASE_URL` (must be `postgres://…` — the sandbox's
  own `file:` DATABASE_URL is rejected by scheme check). SSL always on.
- Schema bootstraps: `bot_stats`, `deobf_history`, `owner_audit`, `blacklist`.
- Every helper is failure-isolated: DB off/broken ⇒ `{}`/`[]`/false/null and
  a warning log; the bot keeps working exactly as before.
- Wired: deobf/detect history + all-time stats (`.stats` shows DB line),
  audit trail, blacklist enforcement, `/health` now reports `db: {...}`.

### Hardened — anti-RCE (the "better rced" ask)
- `.eval` rewritten: code runs in `bin/eval-harness.cjs` — `vm.runInContext`
  with an **empty sandbox** (zero host objects → no constructor-chain escape),
  realm-native console only, 5 s instruction timeout, wrapped in an IIFE for
  `return` support — **inside a spawnHardened child process**: env scrubbed of
  every token/secret (`DATABASE_URL` included), isolated tmpdir, no-network,
  12 s SIGKILL, 1 MB cap. A vm escape reaches an empty disposable shell with
  no credentials. (Found+fixed on the way: `vm.compileFunction`'s `timeout`
  is NOT enforced on invocation in current Node — use `runInContext`.)
- `.exec` raised to 90 s (per-call `%% <seconds>` up to 300), 16 MB capture,
  long output auto-uploaded to Pastefy with the inline preview capped.
- keepalive HTTP server: request/headers/keepalive timeouts, clientError 400.
- Denial audit + owner DM = abuse alarm for brute-force attempts.

### Fixed
- `ctx.defer()` no longer throws when the interaction already replied (the
  confirm gate replies first, commands then defer+edit).
- PIN counter reset bug (lockedUntil=0 counted as "expired lock" every time).
- `package.json` version was stale at 1.2.0 → bumped with `config.version`.

### UI
- Help card: removed the "Link sources" + "How it works" blocks (user ask);
  utilities list gained `.history`. Owner commands stay unlisted (layer 0).

### Tests
- `test/owner-guard.js` (new): L1 spoof attempts, L2 pin lifecycle (correct
  pin passes+resets, 3 fails lock, right pin refused while locked), L4
  concurrency/cooldown, DB no-env fallback for every helper, protection reply
  cards render, harness jail (return works, console captured, `process`
  unreachable, `require` not exposed, infinite loop killed). ALL PASS.
- v2-smoke 24/24, chunk-paste 11/11, links 17/17, e2e-links PASS (Prometheus
  via GitHub + Pastefy link → 99%, 836 B).

### Deploy
- render.yaml: `DATABASE_URL`, `OWNER_ID`, `OWNER_PIN` added (sync:false —
  user fills the Neon value manually in the dashboard). `.env.example` added.

---

## 2026-11-07 — v1.3.0 "clean UI + paste fix + accuracy verification + owner tools"

### Added
- **Syntax verification for every output** (`src/validate.js` new): recovered
  code is parsed (never executed) before delivery — Lua via jailed fengari
  compile (real grammar; Luau retried through the syntax shim), JS via
  `vm.Script` V8 parse, binary outputs honestly "unverifiable". The pipeline
  now reads up to 6 candidates, drops passthrough echoes, and **promotes the
  first candidate whose postprocessed output parses** (`accuracy:pick`),
  with a `verify` stage log and a `verification` document on the result.
  Success card shows `Verified: ✓/⚠/○` instead of a promise.
- **Multi-part Pastefy delivery** — the "failed to paste" bug: Pastefy 413s
  request bodies ≳1.1 MB, so big recovered files (e.g. Hercules 129 KB with
  heavy string escaping) never uploaded. `splitForPaste` now budgets the
  **JSON-escaped** size (string-dense obfuscated code expands ~1.3-2.2x),
  splits on line boundaries (byte-aware, multibyte-safe, oversized single
  lines hard-split), and `createPaste` uploads Part 1..N with the success
  card rendering per-part buttons (`Part 1/2 … Raw`) plus inline links for
  parts 5+. Verified live: 1.66 MB payload → 2 parts, both fetch back byte-
  correct.
- **Pastefy client hardening**: correct shape discovered empirically —
  `type: 'PASTE'` + `visibility: 'UNLISTED'` (the old `type: 'UNLISTED'`
  500'd with `{error:true}` and only worked via the third fallback shape),
  and `expireAt` **always** trips a server IllegalArgumentException → 500 —
  removed (expiry dropped; field kept in config for compat). Transient
  429/5xx/network failures retry 3x with exponential backoff + Retry-After.
- **New public commands**: `.stats` (jobs/success-rate/uptime/engine/memory),
  `.paste` (file/text/link → Pastefy, auto-split), `.beautify` (forced
  re-indent via `beautifyCode` in postprocess), `.strings` (string-table
  extraction with ordered dedupe, preview + full table to Pastefy).
- **Owner-only commands** (locked to `OWNER_ID`, enforced at dispatch for
  both slash + prefix): `.eval` (jailed node:vm — no require/process/
  network, sync-only 5s cap, console captured), `.exec` (bash on the host,
  20s timeout, 1MB buffer), `.servers`, `.leave <id>`, `.setstatus`,
  `.logs [n]` (new 300-line ring buffer in logger), `.shutdown` (graceful;
  Render restarts).

### Changed
- **Reply redesign (professional layout)** — every card now follows one
  discipline: header (title + single `-#` subtitle) → separator → facts
  block (uniform `**Label** value` rows) → separator → content → separator →
  actions. No more scattered fragments; help panel groups commands into
  Deobfuscate / Utilities / Info sections.
- **GitHub links removed from all bot replies** (footer button gone); smoke
  suite now asserts no `github.com` button URL rides any reply.
- `ctx.args` now carries prefix arguments (owner tools); `jobStats()` exported
  from keepalive for `.stats`.

### Verified (local, real samples)
- `test/v2-smoke.js` — 24/24 cards serialize (incl. parts/source/verify/
  stats/owner/logs/servers/codeTool) + zero GitHub buttons.
- `test/chunk-paste.js` — 11/11: splitter unit cases (rejoin with `join('')`
  exact, multibyte-safe, hard-split) + live 1.66 MB → 2-part paste round-trip.
- `test/links.js` — 17/17 still green (pastefy shape change compatible).
- `test/e2e-links.js` — Prometheus VMify via GitHub + Pastefy links: both
  verified outputs, 836 B recovered.
- `test/run.js` Hercules gauntlet: 336,864 → 129,612 B, `verify` stage ran,
  paste OK (`pastefy.app/Jw4Y2OgA`).

### Next
- UptimeRobot external monitor (user-side, optional third-party layer).
- Luraph v15.1 devirtualization roadmap (per-build key capture).
- MoonSec V2 escrow dispatcher compatibility in the harvest jail.

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
