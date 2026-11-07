/**
 * BypassX Deobf Bot — keep-alive HTTP server (Render free tier 24/7).
 *
 * Render free web services sleep after 15 minutes without INBOUND traffic.
 * Three layers keep the bot awake:
 *   1. This HTTP server  — /health endpoint (Render health checks + uptime monitors)
 *   2. Self-ping         — every 9 min hits PUBLIC_URL/health through the public
 *                          load balancer (localhost pings do NOT reset the idle timer)
 *   3. GitHub Actions    — .github/workflows/keepalive.yml pings every 10 min as
 *                          an independent layer even if self-ping fails
 *
 * Also exposes a human-readable status page at / with live engine + bot state.
 */
import http from 'node:http';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { probe as probeEngine } from './engine.js';
import { describe as dbDescribe } from './db.js';

const startedAt = Date.now();
const state = {
  discordReady: false,
  engine: { available: false, version: null },
  lastSelfPing: null,
  jobs: { total: 0, ok: 0, fail: 0, lastAt: null, lastFile: null },
};

export function markDiscordReady(v = true) { state.discordReady = v; }
export function bumpJob(ok, file = null) {
  state.jobs.total += 1;
  if (ok) state.jobs.ok += 1; else state.jobs.fail += 1;
  state.jobs.lastAt = Date.now();
  if (file) state.jobs.lastFile = String(file).slice(0, 80);
}
/** Live job counters for the .stats command. */
export function jobStats() {
  return { ...state.jobs, discordReady: state.discordReady };
}

function healthJson() {
  return {
    ok: true,
    service: 'bypassx-deobf-bot',
    version: CONFIG.version,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    discordReady: state.discordReady,
    engine: state.engine,
    db: dbDescribe(),
    jobs: {
      total: state.jobs.total,
      ok: state.jobs.ok,
      fail: state.jobs.fail,
      lastAt: state.jobs.lastAt ? new Date(state.jobs.lastAt).toISOString() : null,
      lastFile: state.jobs.lastFile,
    },
    lastSelfPing: state.lastSelfPing
      ? { ...state.lastSelfPing, at: new Date(state.lastSelfPing.at).toISOString() }
      : null,
  };
}

function statusPage() {
  const h = healthJson();
  return `<!doctype html><html><head><title>BypassX Deobf Bot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{background:#0b0b12;color:#e5e7eb;font-family:ui-sans-serif,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#14141f;border:1px solid #2d2d44;border-radius:16px;padding:32px;max-width:560px}
h1{margin:0 0 4px;font-size:22px;color:#a78bfa}
.sub{color:#9ca3af;font-size:13px;margin-bottom:18px}
.row{display:flex;gap:10px;margin:8px 0;font-size:14px}
.k{color:#9ca3af;min-width:130px}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px}
.up{background:#14321f;color:#4ade80}.down{background:#321414;color:#f87171}
a{color:#a78bfa}
</style></head><body><div class="card">
<h1>🧩 BypassX Deobf Bot</h1>
<div class="sub">The best Discord deobfuscation bot — static analysis, RCE-protected, pastefy delivery</div>
<div class="row"><span class="k">Status</span><span class="badge up">healthy</span></div>
<div class="row"><span class="k">Discord</span>${h.discordReady ? '<span class="badge up">connected</span>' : '<span class="badge down">connecting…</span>'}</div>
<div class="row"><span class="k">Engine</span>${h.engine.available ? `<span class="badge up">${h.engine.version || 'ready'}</span>` : '<span class="badge down">preparing…</span>'}</div>
<div class="row"><span class="k">Version</span><span>v${h.version}</span></div>
<div class="row"><span class="k">Uptime</span><span>${Math.floor(h.uptimeS / 60)}m ${h.uptimeS % 60}s</span></div>
<div class="row"><span class="k">Jobs</span><span>${h.jobs.ok} ok / ${h.jobs.fail} failed (total ${h.jobs.total})</span></div>
<div class="sub" style="margin-top:18px">Use <b>.deobf</b> / <b>/deobf</b> in Discord with an obfuscated file attached.<br>
<a href="/health">/health</a> JSON endpoint</div>
</div></body></html>`;
}

export function startKeepalive() {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || 3000;
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    try {
      if (url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(healthJson()));
      } else if (url === '/ping') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('pong');
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(statusPage());
      }
    } catch {
      try { res.writeHead(500); res.end('error'); } catch { /* socket gone */ }
    }
  });
  server.listen(port, '0.0.0.0', () => logger.info({ port }, 'keepalive http listening'));

  // HTTP hardening: bound slow-client abuse (no dynamic input is served —
  // only static /health, /ping and the status page — but be tidy anyway).
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 10_000;
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* gone */ }
  });

  // keep engine info fresh for /health + status page
  const refreshEngine = () => probeEngine().then((i) => { state.engine = i; }).catch(() => {});
  refreshEngine();
  setInterval(refreshEngine, 60_000).unref();

  // Layer 2: self-ping the PUBLIC url through Render's load balancer.
  const pub = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (pub) {
    const ping = async () => {
      try {
        const r = await fetch(`${pub}/health`, { signal: AbortSignal.timeout(20_000) });
        state.lastSelfPing = { at: Date.now(), status: r.status };
      } catch (e) {
        state.lastSelfPing = { at: Date.now(), error: String(e?.message || e).slice(0, 120) };
        logger.warn({ err: state.lastSelfPing.error }, 'self-ping failed');
      }
    };
    setTimeout(ping, 15_000);
    setInterval(ping, 9 * 60_000);
    logger.info({ publicUrl: pub }, 'self-ping enabled (every 9 min)');
  } else {
    logger.warn({}, 'PUBLIC_URL not set — self-ping disabled (GitHub Actions layer still applies)');
  }

  return server;
}
