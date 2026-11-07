/**
 * BypassX Deobf Bot — SECRET owner dashboard.
 *
 * ONE layer matters most: the URL itself is the credential.
 *   https://<service>.onrender.com/dash/<DASHBOARD_TOKEN>
 * The token is a ≥128-bit secret that:
 *   • comes from the DASHBOARD_TOKEN env var, or is auto-generated at boot
 *     (persisted to var/dash-token and printed ONCE to the private Render log);
 *   • is compared timing-safely, and any wrong guess returns an identical 404;
 *   • is never linked, pinged, indexed, cached, or logged by anything public —
 *     the status page, /health, Discord cards and robots.txt never mention it.
 *
 * From here the owner (and only the owner) can: see every guild with member
 * counts, control per-guild behaviour (disable bot / deobf / detect, custom
 * prefix, message a channel, leave), broadcast, run the jailed eval + host
 * shell, raw SQL, blacklist management, live logs, audit trail, restart /
 * shutdown — every mutation audited to the owner_audit table.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ensureVarDir } from './config.js';
import { logger, recentLogs } from './logger.js';
import * as db from './db.js';
import { runJailedEval, runShell, broadcastAll } from './runners.js';
import { prettyEngine, esc, fmtBytes } from './pretty.js';

let dashClient = null; // set from index.js once the Discord client exists
let clientProvider = null; // injected by keepalive (jobStats, engine state)

export function setDashboardClient(client) { dashClient = client; }
export function initDashboardContext(providers) { clientProvider = providers || null; }

function client() { return dashClient; }

// ---- token -------------------------------------------------------------------

let cachedToken = null;

function readToken() {
  const env = (process.env.DASHBOARD_TOKEN || '').trim();
  if (env) return env;
  const dir = ensureVarDir();
  const file = path.join(dir, 'dash-token');
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v.length >= 24) return v;
  } catch { /* first boot */ }
  const gen = crypto.randomBytes(24).toString('base64url'); // 192-bit
  try { fs.writeFileSync(file, gen, { mode: 0o600 }); } catch { /* best effort */ }
  return gen;
}

function token() {
  if (!cachedToken) cachedToken = readToken();
  return cachedToken;
}

/** Log the private dashboard path once at boot (Render logs are owner-only). */
export function announceDashboard() {
  const t = token();
  logger.info({ dashboardPath: `/dash/${t}` }, 'dashboard: ready — private URL path (owner-only logs)');
  return t;
}

function safeEq(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  const dummy = Buffer.alloc(32);
  try {
    if (ab.length !== bb.length) { crypto.timingSafeEqual(dummy, dummy); return false; }
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ---- brute-force guard ---------------------------------------------------------

const fails = new Map(); // ip -> { count, until }
const FAIL_LIMIT = 8;
const FAIL_WINDOW_MS = 15 * 60_000;

function ipOf(req) {
  return String(req.socket?.remoteAddress || req.headers['x-forwarded-for'] || '?').split(',')[0].trim();
}

function registerFail(ip) {
  const now = Date.now();
  const st = fails.get(ip) || { count: 0, until: 0 };
  if (st.until && st.until <= now) { st.count = 0; st.until = 0; } // lockout expired
  st.count += 1;
  if (st.count >= FAIL_LIMIT && st.until <= now) {
    st.until = now + FAIL_WINDOW_MS;
    logger.warn({ ip }, 'dashboard: brute-force block (15 min)');
  }
  fails.set(ip, st);
  return st;
}

function blocked(ip) {
  const st = fails.get(ip);
  return Boolean(st?.until && st.until > Date.now());
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, st] of fails) if (st.until < now && st.count === 0) fails.delete(ip);
}, 60_000).unref();

// ---- http helpers ---------------------------------------------------------------

const SECURITY_HEADERS = {
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'cache-control': 'no-store, max-age=0',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://cdn.discordapp.com; connect-src 'self'; form-action 'self'; base-uri 'none'",
};

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

async function readBody(req, limit = 200_000) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

// ---- rate limit the API (protect the DB + host) -----------------------------------

const apiHits = new Map(); // ip -> timestamps[]
const API_LIMIT = 60; // per minute

function apiAllowed(ip) {
  const now = Date.now();
  const arr = (apiHits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  apiHits.set(ip, arr);
  return arr.length <= API_LIMIT;
}

// ---- main handler -------------------------------------------------------------------

/**
 * Route /dash/* — called from keepalive for every request that starts with /dash.
 * Everything the public internet may send lands here; wrong tokens see a plain
 * 404 indistinguishable from any other unknown path.
 */
export async function handleDashboard(req, res, pathname) {
  const ip = ipOf(req);
  let parts = [];
  try { parts = pathname.split('/').filter(Boolean); } catch { parts = []; }

  // Expected: ['dash', token] or ['dash', token, 'api', ...]
  const supplied = decodeURIComponent(parts[1] || '');
  if (parts[0] !== 'dash' || !supplied || !safeEq(supplied, token())) {
    if (supplied) registerFail(ip);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not Found');
  }
  if (blocked(ip)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not Found');
  }

  const rest = parts.slice(2); // e.g. ['api', 'state']

  if (req.method === 'GET' && rest.length === 0) {
    return html(res, 200, renderPage());
  }

  if (rest[0] !== 'api') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not Found');
  }

  if (!apiAllowed(ip)) return json(res, 429, { ok: false, error: 'slow down (60 req/min cap)' });

  try {
    return await routeApi(req, res, rest.slice(1).join('/'));
  } catch (e) {
    logger.warn({ err: String(e?.message || e).slice(0, 160) }, 'dashboard: api error');
    return json(res, 500, { ok: false, error: 'internal error' });
  }
}

async function routeApi(req, res, route) {
  const audit = (command, result, extra = {}) => db.audit({
    userId: 'dashboard', username: 'dashboard (owner web)', command,
    args: extra.args || '', allowed: true, layer: 'dashboard', result: String(result || '').slice(0, 200),
  });

  if (req.method === 'GET') {
    if (route === 'state') return json(res, 200, { ok: true, data: await stateData() });
    if (route === 'logs') {
      const n = Math.max(5, Math.min(300, Number(new URL(req.url, 'http://x').searchParams.get('n')) || 80));
      return json(res, 200, { ok: true, data: { lines: recentLogs(n) } });
    }
    if (route === 'audit') {
      if (!db.describe().enabled) return json(res, 200, { ok: true, data: { rows: [], note: 'database not configured' } });
      const rows = await db.auditTail(50);
      return json(res, 200, { ok: true, data: { rows } });
    }
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });

  const body = await readBody(req);

  if (route === 'guild') return guildAction(req, res, body, audit);
  if (route === 'exec') {
    const r = await runShell(body.cmd || '');
    await audit('dash-exec', `exit ${r.exit} in ${r.ms}ms`, { args: String(body.cmd || '').slice(0, 150) });
    return json(res, 200, { ok: true, data: r });
  }
  if (route === 'eval') {
    const r = await runJailedEval(body.code || '');
    await audit('dash-eval', r.ok ? `ok in ${r.ms}ms` : 'failed', { args: String(body.code || '').slice(0, 150) });
    return json(res, 200, { ok: true, data: r });
  }
  if (route === 'broadcast') {
    const text = String(body.text || '').trim();
    if (!text || text.length > 1500) return json(res, 200, { ok: false, error: 'text must be 1–1500 chars' });
    const r = await broadcastAll(client(), text, { isBlacklisted: (id) => db.blacklistHas(id) });
    await audit('dash-broadcast', `${r.sent}/${r.total} delivered`, { args: text.slice(0, 100) });
    return json(res, 200, { ok: true, data: r });
  }
  if (route === 'blacklist') {
    if (!db.describe().enabled) return json(res, 200, { ok: false, error: 'database not configured' });
    const action = String(body.action || '');
    const target = String(body.target || '').trim();
    if (action === 'add' && /^\d{5,25}$/.test(target)) {
      const kind = client()?.guilds?.cache?.has(target) ? 'guild' : 'user';
      const okWrite = await db.blacklistAdd(target, kind, String(body.reason || 'dashboard'), 'dashboard');
      await audit('dash-blacklist-add', `${target} (${kind})`);
      return json(res, 200, { ok: okWrite, data: { target, kind } });
    }
    if (action === 'remove' && /^\d{5,25}$/.test(target)) {
      const okWrite = await db.blacklistRemove(target);
      await audit('dash-blacklist-remove', target);
      return json(res, 200, { ok: okWrite, data: { target } });
    }
    return json(res, 200, { ok: false, error: 'use action add|remove with a numeric target' });
  }
  if (route === 'db') {
    if (!db.describe().enabled) return json(res, 200, { ok: false, error: 'database not configured' });
    const sql = String(body.sql || '').trim();
    if (!sql) return json(res, 200, { ok: false, error: 'empty SQL' });
    if (sql.toLowerCase() === 'status') {
      return json(res, 200, { ok: true, data: { status: db.describe() } });
    }
    const r = await db.rawSql(sql);
    await audit('dash-sql', r.error ? `error: ${r.error}` : `${r.rowCount ?? 0} rows in ${r.ms}ms`, { args: sql.slice(0, 120) });
    return json(res, 200, { ok: !r.error, data: r });
  }
  if (route === 'power') {
    const action = String(body.action || '');
    if (action === 'restart' || action === 'shutdown') {
      await audit(`dash-${action}`, 'process exit requested');
      json(res, 200, { ok: true, data: { action } });
      setTimeout(async () => {
        try { await client()?.destroy(); } catch { /* gone */ }
        process.exit(0);
      }, 600);
      return undefined;
    }
    return json(res, 200, { ok: false, error: 'action must be restart|shutdown' });
  }

  return json(res, 404, { ok: false, error: 'unknown api route' });
}

async function guildAction(req, res, body, audit) {
  const c = client();
  const id = String(body.id || '').trim();
  const action = String(body.action || '');
  if (!c || !c.guilds?.cache?.has(id)) return json(res, 200, { ok: false, error: 'unknown guild' });
  const g = c.guilds.cache.get(id);

  if (action === 'leave') {
    const name = g.name;
    await audit('dash-leave', `${name} (${id})`);
    try { await g.leave(); } catch (e) { return json(res, 200, { ok: false, error: String(e?.message || e).slice(0, 200) }); }
    return json(res, 200, { ok: true, data: { left: name } });
  }
  if (action === 'message') {
    const channelId = String(body.channelId || '').trim();
    const text = String(body.text || '').slice(0, 1900);
    try {
      const ch = await c.channels.fetch(channelId);
      if (!ch?.isTextBased()) throw new Error('not a text channel');
      await ch.send(text);
      await audit('dash-guild-message', `${ch.name ?? channelId} in ${g.name}`, { args: text.slice(0, 100) });
      return json(res, 200, { ok: true, data: { sent: true } });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  if (action === 'settings') {
    if (!db.describe().enabled) return json(res, 200, { ok: false, error: 'database not configured — per-guild control needs DATABASE_URL' });
    const patch = {};
    if (typeof body.disabled === 'boolean') patch.disabled = body.disabled;
    if (typeof body.deobf_enabled === 'boolean') patch.deobf_enabled = body.deobf_enabled;
    if (typeof body.detect_enabled === 'boolean') patch.detect_enabled = body.detect_enabled;
    if (body.prefix !== undefined) patch.prefix = String(body.prefix || '').slice(0, 8);
    if (body.note !== undefined) patch.note = String(body.note || '').slice(0, 200);
    const okWrite = await db.setGuildSettings(id, patch);
    await audit('dash-guild-settings', `${g.name}: ${JSON.stringify(patch).slice(0, 120)}`);
    return json(res, 200, { ok: okWrite, data: await db.getGuildSettings(id) });
  }
  return json(res, 200, { ok: false, error: 'unknown guild action' });
}

// ---- data for the UI ----------------------------------------------------------------

async function stateData() {
  const c = client();
  const jobs = clientProvider?.jobStats ? clientProvider.jobStats() : { total: 0, ok: 0, fail: 0, discordReady: Boolean(c?.user) };
  const mem = process.memoryUsage();
  const d = db.describe();
  const guilds = c
    ? [...c.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount ?? null,
      icon: g.iconURL?.({ size: 64 }) || null,
      joinedAt: g.joinedTimestamp ? new Date(g.joinedTimestamp).toISOString().slice(0, 10) : null,
      ownerId: g.ownerId,
      channels: [...g.channels.cache.values()]
        .filter((ch) => ch.isTextBased?.() && ch.viewable)
        .slice(0, 60)
        .map((ch) => ({ id: ch.id, name: ch.name })),
    })).sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0))
    : [];
  const guildSettings = d.enabled ? await Promise.all(guilds.map((g) => db.getGuildSettings(g.id))) : [];
  const stats = d.enabled ? await db.statsAll() : {};
  const allTime = d.enabled ? await db.allTimeCounts() : null;
  return {
    version: CONFIG.version,
    uptimeS: Math.round(process.uptime()),
    discordReady: Boolean(c?.user),
    botTag: c?.user?.tag || null,
    botId: c?.user?.id || null,
    pingMs: Math.round(c?.ws?.ping || 0),
    memoryMb: mem.rss / 1024 / 1024,
    jobs,
    engine: clientProvider?.engine ? clientProvider.engine() : { available: false, version: null },
    db: d,
    stats,
    allTime,
    guilds,
    guildSettings,
    blacklist: d.enabled ? await db.blacklistList() : [],
    pinArmed: Boolean(process.env.OWNER_PIN),
  };
}

// ---- the single-page UI -----------------------------------------------------------------

function renderPage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>•</title>
<style>
:root{--bg:#0b0b12;--panel:#14141f;--panel2:#1a1a2a;--line:#2d2d44;--txt:#e5e7eb;--dim:#9ca3af;--vio:#a78bfa;--vio2:#7c3aed;--ok:#4ade80;--warn:#fbbf24;--err:#f87171}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--txt);font-family:ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px}
a{color:var(--vio)}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
h1{font-size:20px;margin:0;color:var(--vio)}
.pill{padding:3px 12px;border-radius:99px;font-size:12px;border:1px solid var(--line);background:var(--panel)}
.up{color:var(--ok);border-color:#1d4a2c}.down{color:var(--err);border-color:#4a1d1d}
nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
nav button{background:var(--panel);color:var(--txt);border:1px solid var(--line);padding:8px 14px;border-radius:10px;cursor:pointer;font-size:13px}
nav button.on{background:var(--vio2);border-color:var(--vio)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.card h3{margin:0 0 10px;font-size:14px;color:var(--vio)}
.kv{display:flex;justify-content:space-between;font-size:13px;padding:3px 0}
.kv b{color:var(--dim);font-weight:500}
.gcard{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
.ghead{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.ghead img{width:36px;height:36px;border-radius:10px}
.gname{font-weight:600}.gid{color:var(--dim);font-size:11px;font-family:ui-monospace,monospace}
.tog{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.tog button,.rowbtn button{border:1px solid var(--line);background:var(--panel2);color:var(--txt);padding:5px 10px;border-radius:8px;cursor:pointer;font-size:12px}
.tog button.on{background:#12331f;border-color:var(--ok);color:var(--ok)}
.tog button.off{background:#331216;border-color:var(--err);color:var(--err)}
.danger{background:#331216!important;border-color:var(--err)!important;color:var(--err)}
input,textarea,select{background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:7px 10px;font-size:13px;width:100%}
textarea{min-height:90px;font-family:ui-monospace,monospace;resize:vertical}
.rowbtn{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
pre{background:#0d0d16;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:12px;overflow:auto;max-height:340px;white-space:pre-wrap;word-break:break-word}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left}
th{color:var(--dim);font-weight:500}
.mut{color:var(--dim);font-size:12px}
.ok{color:var(--ok)}.err{color:var(--err)}.warn{color:var(--warn)}
.tab{display:none}.tab.on{display:block}
#toast{position:fixed;bottom:18px;right:18px;background:var(--panel);border:1px solid var(--vio);padding:10px 16px;border-radius:10px;display:none;font-size:13px;max-width:340px}
.spin{display:inline-block;animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
</style></head><body>
<header>
<h1>🧩 BypassX Deobf — Owner Dashboard</h1>
<span class="pill" id="p-disc">…</span><span class="pill" id="p-engine">…</span>
<span class="pill" id="p-db">…</span><span class="pill" id="p-ver">…</span>
<span class="pill" id="p-up">…</span><span class="pill" id="p-pin">…</span>
</header>
<nav>
<button data-t="ov" class="on">Overview</button><button data-t="gu">Guilds</button>
<button data-t="pw">Power</button><button data-t="bl">Blacklist</button>
<button data-t="lg">Logs</button><button data-t="au">Audit</button><button data-t="sq">SQL</button>
</nav>

<div class="tab on" id="t-ov"><div class="grid" id="ov-cards"></div></div>

<div class="tab" id="t-gu"><p class="mut">Per-guild control: toggles are enforced at dispatch (bot disabled / deobf off / detect off), the custom prefix replaces the global one for prefix commands. DB required.</p><div id="guilds"></div></div>

<div class="tab" id="t-pw">
<div class="gcard"><h3>⚡ Broadcast to every guild</h3><input id="bc-text" placeholder="Message text (max 1500)"><div class="rowbtn"><button id="bc-go">Send broadcast</button><span class="mut" id="bc-out"></span></div></div>
<div class="gcard"><h3>🧠 eval — jailed sandbox (secret-free child, 12s kill)</h3><textarea id="ev-code" placeholder="return 6 * 7;"></textarea><div class="rowbtn"><button id="ev-go">Run eval</button></div><pre id="ev-out" style="display:none"></pre></div>
<div class="gcard"><h3>🖥 exec — host shell (bash, 90s cap)</h3><textarea id="sh-cmd" placeholder="echo hello && ls -la"></textarea><div class="rowbtn"><button id="sh-go">Run shell</button></div><pre id="sh-out" style="display:none"></pre></div>
<div class="gcard"><h3>⏻ Process</h3><div class="rowbtn"><button class="danger" id="pw-restart">Restart bot</button><button class="danger" id="pw-stop">Shutdown</button><span class="mut">Render reboots the service automatically.</span></div></div>
</div>

<div class="tab" id="t-bl">
<div class="gcard"><h3>🚫 Global blacklist (users/guilds)</h3>
<div class="rowbtn"><input id="bl-target" placeholder="id" style="max-width:220px"><input id="bl-reason" placeholder="reason" style="max-width:280px"><button id="bl-add">Add</button><button id="bl-del">Remove</button></div>
<table id="bl-table"><thead><tr><th>target</th><th>kind</th><th>reason</th><th>by</th><th>added</th></tr></thead><tbody></tbody></table>
</div></div>

<div class="tab" id="t-lg"><div class="rowbtn"><button id="lg-ref">Refresh</button><span class="mut">last 80 lines (newest last)</span></div><pre id="lg-out">loading…</pre></div>

<div class="tab" id="t-au"><p class="mut">Every owner action (Discord + dashboard) with the protection layer that fired.</p><table id="au-table"><thead><tr><th>time</th><th>cmd</th><th>who</th><th>result</th><th>layer</th></tr></thead><tbody></tbody></table></div>

<div class="tab" id="t-sq"><p class="mut">Raw SQL on the Neon database — every statement is audited.</p><textarea id="sq-sql" placeholder="SELECT * FROM deobf_history ORDER BY created_at DESC LIMIT 10"></textarea><div class="rowbtn"><button id="sq-go">Run</button><button id="sq-st">DB status</button></div><pre id="sq-out" style="display:none"></pre></div>

<div id="toast"></div>
<script>
const BASE = location.pathname.replace(/\\/+$/,'');
const $ = (s) => document.querySelector(s);
function toast(msg, ok=true){ const t=$('#toast'); t.textContent=msg; t.style.borderColor= ok?'var(--ok)':'var(--err)'; t.style.display='block'; clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none',3500); }
async function api(path, body){
  const opt = body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {};
  const r = await fetch(BASE+'/api/'+path, opt);
  if (r.status === 404) throw new Error('token invalid');
  return r.json();
}
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtUp(s){ const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); return (d?d+'d ':'')+ (h?h+'h ':'') + m+'m'; }

document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); $('#t-'+b.dataset.t).classList.add('on');
  if (b.dataset.t==='lg') loadLogs(); if (b.dataset.t==='au') loadAudit();
});

let STATE=null;
async function refresh(){
  try{
    const r = await api('state');
    if(!r.ok){ toast('state failed','x'); return; }
    STATE = r.data; renderHeader(); renderOverview(); renderGuilds(); renderBlacklist();
  }catch(e){ $('#p-disc').textContent='offline'; $('#p-disc').className='pill down'; }
}
function renderHeader(){
  const s=STATE;
  $('#p-disc').textContent = s.discordReady ? ('🟢 '+ (s.botTag||'discord')) : '🔴 connecting';
  $('#p-disc').className = 'pill '+(s.discordReady?'up':'down');
  $('#p-engine').textContent = s.engine.available ? ('⚙ '+s.engine.version) : '⚙ preparing';
  $('#p-db').textContent = s.db.enabled ? (s.db.breaker.open ? '🟠 db breaker OPEN' : (s.db.connected?'🗄 db connected':'🟠 db retrying')) : '🗄 db off';
  $('#p-db').className = 'pill '+(s.db.enabled ? (s.db.breaker.open||!s.db.connected?'down':'up') : '');
  $('#p-ver').textContent = 'v'+s.version;
  $('#p-up').textContent = '⏱ '+fmtUp(s.uptimeS);
  $('#p-pin').textContent = s.pinArmed ? '🔐 PIN armed' : '🔓 no PIN';
  $('#p-pin').className = 'pill '+(s.pinArmed?'up':'down');
}
function card(title, rows){
  return '<div class="card"><h3>'+title+'</h3>'+rows.map(r=>'<div class="kv"><b>'+r[0]+'</b><span>'+r[1]+'</span></div>').join('')+'</div>';
}
function renderOverview(){
  const s=STATE, g=s.guilds||[];
  const all = s.allTime;
  $('#ov-cards').innerHTML =
    card('Bot', [['Version','v'+s.version],['Uptime',fmtUp(s.uptimeS)],['Gateway ping',s.pingMs+'ms'],['Memory',s.memoryMb.toFixed(0)+' MB'],['Bot id',esc(s.botId||'—')]]) +
    card('Jobs (this boot)', [['Succeeded','<span class="ok">'+s.jobs.ok+'</span>'],['Failed','<span class="err">'+s.jobs.fail+'</span>'],['Total',s.jobs.total]]) +
    card('Database', [['Status', s.db.enabled?(s.db.connected?'<span class="ok">connected</span>':'retrying'):'off'],['Host',esc(s.db.host||'—')],['Latency',(s.db.latencyMs??'—')+'ms'],['Breaker', s.db.breaker?(s.db.breaker.open?'<span class="err">OPEN</span>':'closed • trips '+s.db.breaker.trips+' • queue '+s.db.breaker.queued):'—'],['All-time', all?(all.ok+' ok / '+all.total):'—']]) +
    card('Guilds', [['Count',g.length],['Members',g.reduce((a,x)=>a+(x.memberCount||0),0)],['Biggest', g[0]?esc(g[0].name):'—']]) +
    card('Stats counters', Object.entries(s.stats||{}).map(([k,v])=>[k,String(v)]).slice(0,8)) +
    card('Protection', [['Owner PIN', s.pinArmed?'armed':'off'],['DB audit', s.db.enabled?'on':'off'],['Dashboard','this page • token-gated'],['Engine', esc(s.engine.version||'—')]]);
}
function renderGuilds(){
  const s=STATE, g=s.guilds||[];
  $('#guilds').innerHTML = g.map((x,i)=>{
    const st = (s.guildSettings||[])[i] || {};
    const chs = (x.channels||[]).map(c=>'<option value="'+c.id+'">#'+esc(c.name)+'</option>').join('');
    return '<div class="gcard" data-id="'+x.id+'">'
      +'<div class="ghead">'+(x.icon?'<img src="'+x.icon+'" alt="">':'<img alt="" style="background:var(--panel2)">')
      +'<div><div class="gname">'+esc(x.name)+'</div><div class="gid">'+x.id+' • '+(x.memberCount??'?')+' members • joined '+(x.joinedAt||'?')+'</div></div></div>'
      +'<div class="tog">'
      +'<button class="'+(st.disabled?'off':'on')+'" data-a="disabled">'+(st.disabled?'⛔ bot DISABLED':'✅ bot enabled')+'</button>'
      +'<button class="'+(st.deobf_enabled?'on':'off')+'" data-a="deobf_enabled">'+(st.deobf_enabled?'deobf on':'deobf off')+'</button>'
      +'<button class="'+(st.detect_enabled?'on':'off')+'" data-a="detect_enabled">'+(st.detect_enabled?'detect on':'detect off')+'</button>'
      +'</div>'
      +'<div class="rowbtn"><input class="gp" placeholder="custom prefix" value="'+esc(st.prefix||'')+'" style="max-width:130px"><button data-a="prefix">Save prefix</button></div>'
      +'<div class="rowbtn"><select class="gc">'+chs+'</select><input class="gm" placeholder="message text" style="flex:1"><button data-a="message">Send</button></div>'
      +'<div class="rowbtn"><button class="danger" data-a="leave">Leave server</button></div>'
      +'</div>';
  }).join('') || '<p class="mut">Not in any guild yet.</p>';

  document.querySelectorAll('#guilds .gcard').forEach(card=>{
    const id = card.dataset.id;
    card.querySelectorAll('.tog button, .rowbtn button').forEach(b=>{
      b.onclick = async ()=>{
        const a=b.dataset.a;
        try{
          if(a==='leave'){ if(!confirm('Leave this server?')) return; const r=await api('guild',{id,action:'leave'}); toast(r.ok?('left '+r.data.left):r.error, r.ok); refresh(); return; }
          if(a==='message'){ const cid=card.querySelector('.gc').value, text=card.querySelector('.gm').value; const r=await api('guild',{id,action:'message',channelId:cid,text}); toast(r.ok?'sent':r.error, r.ok); return; }
          if(a==='prefix'){ const p=card.querySelector('.gp').value; const r=await api('guild',{id,action:'settings',prefix:p}); toast(r.ok?'prefix saved':r.error, r.ok); refresh(); return; }
          // toggles: class 'off' ⇒ the setting is currently false → flip it
          const cur = b.classList.contains('off');
          const r=await api('guild',{id,action:'settings',[a]:!cur});
          toast(r.ok?'saved':r.error, r.ok); refresh();
        }catch(e){ toast(String(e.message||e),false); }
      };
    });
  });
}
function renderBlacklist(){
  const rows=(STATE.blacklist||[]);
  $('#bl-table tbody').innerHTML = rows.map(r=>'<tr><td>'+esc(r.target)+'</td><td>'+esc(r.kind)+'</td><td>'+esc(r.reason||'')+'</td><td>'+esc(r.added_by||'')+'</td><td>'+esc((r.created_at||'').slice(0,10))+'</td></tr>').join('') || '<tr><td colspan="5" class="mut">empty</td></tr>';
}
$('#bl-add').onclick=async()=>{ const r=await api('blacklist',{action:'add',target:$('#bl-target').value.trim(),reason:$('#bl-reason').value.trim()}); toast(r.ok?'added':r.error,r.ok); refresh(); };
$('#bl-del').onclick=async()=>{ const r=await api('blacklist',{action:'remove',target:$('#bl-target').value.trim()}); toast(r.ok?'removed':r.error,r.ok); refresh(); };

$('#bc-go').onclick=async()=>{ $('#bc-out').textContent='sending…'; const r=await api('broadcast',{text:$('#bc-text').value}); $('#bc-out').textContent = r.ok? ('delivered '+r.data.sent+'/'+r.data.total+' (failed '+r.data.failed+', skipped '+r.data.skipped+')') : r.error; };
$('#ev-go').onclick=async()=>{ const o=$('#ev-out'); o.style.display='block'; o.textContent='running…'; const r=await api('eval',{code:$('#ev-code').value}); o.textContent=r.data.output; };
$('#sh-go').onclick=async()=>{ const o=$('#sh-out'); o.style.display='block'; o.textContent='running…'; const r=await api('exec',{cmd:$('#sh-cmd').value}); o.textContent=r.data.output; };
$('#pw-restart').onclick=async()=>{ if(!confirm('Restart the bot?')) return; await api('power',{action:'restart'}); toast('restarting…'); };
$('#pw-stop').onclick=async()=>{ if(!confirm('Shut down the bot? Render will reboot it.')) return; await api('power',{action:'shutdown'}); toast('shutting down…'); };

async function loadLogs(){ const r=await api('logs?n=80'); $('#lg-out').textContent=(r.data.lines||[]).join('\\n')||'(no logs)'; }
$('#lg-ref').onclick=loadLogs;
async function loadAudit(){
  const r=await api('audit');
  const rows=r.data.rows||[];
  $('#au-table tbody').innerHTML = rows.map(x=>'<tr><td>'+esc((x.created_at||'').replace('T',' ').slice(0,16))+'</td><td>'+esc(x.command)+'</td><td>'+esc(x.username||x.user_id||'')+'</td><td class="'+(x.allowed?'ok':'err')+'">'+esc(x.result||'')+'</td><td>'+esc(x.layer||'')+'</td></tr>').join('') || '<tr><td colspan="5" class="mut">no audit entries</td></tr>';
}
$('#sq-go').onclick=async()=>{ const o=$('#sq-out'); o.style.display='block'; o.textContent='running…'; const r=await api('db',{sql:$('#sq-sql').value}); if(r.ok&&r.data.rows!==undefined){ const f=(r.data.fields||[]).join(' | '); const rows=(r.data.rows||[]).slice(0,30).map(x=>Object.values(x).map(v=>v===null?'∅':String(v instanceof Date? v.toISOString():v).slice(0,80)).join(' | ')); o.textContent=[f,...rows].join('\\n')+'\\n['+(r.data.rowCount??0)+' rows, '+r.data.ms+'ms]'; } else { o.textContent=r.ok?JSON.stringify(r.data,null,1).slice(0,3000):('✗ '+r.error); } };
$('#sq-st').onclick=async()=>{ const o=$('#sq-out'); o.style.display='block'; const r=await api('db',{sql:'status'}); o.textContent=JSON.stringify(r.data,null,1).slice(0,2000); };

refresh(); setInterval(refresh, 15000);
</script></body></html>`;
}
