/**
 * BypassX Deobf Bot — SECRET owner dashboard (v2.3 "mission control").
 *
 * ONE layer matters most: the URL itself is the credential.
 *   https://<service>.onrender.com/dash/<DASHBOARD_TOKEN>
 * The token is a ≥128-bit secret that:
 *   • comes from the DASHBOARD_TOKEN env var, else auto-generated at boot and
 *     persisted to var/dash-token AND the database (dashboard_state table) so
 *     it SURVIVES Render redeploys (ephemeral filesystem) — the URL keeps working;
 *   • is compared timing-safely, and any wrong guess returns an identical 404;
 *   • a CORRECT token always gets in and clears any brute-force lockout for
 *     that IP — the owner can never lock themselves out;
 *   • is never linked, pinged, indexed, cached, or logged by anything public.
 *
 * 25+ owner tools: deobfuscate / detect / beautify / strings straight from the
 * browser, jailed eval, host shell, broadcast, DM, presence, ID lookup, invite
 * generator, blacklist, per-guild control, SQL, backup, history, env, logs,
 * audit, engine rebuild, rate-limit reset, restart / shutdown — every mutation
 * audited to the owner_audit table.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ensureVarDir } from './config.js';
import { logger, recentLogs } from './logger.js';
import * as db from './db.js';
import { CATALOG, FAMILIES, CATALOG_SIZE, EXECUTOR_IDENTITIES } from './antitamper/catalog.js';
import { ANTITAMPER_VERSION } from './antitamper/index.js';
import { probeCount } from './antitamper/sanity.js';
import { SERVICE_COMMANDS } from './service-catalog.js';
import { runJailedEval, runShell, broadcastAll } from './runners.js';
import { resetCooldowns } from './rate-limit.js';
import { deobfuscate } from './pipeline.js';
import { detectService } from './detect.js';
import { beautifyCode } from './postprocess.js';
import { safeFetch } from './fetchurl.js';
import { COMMANDS } from './commands-index.js';
import { renderPage } from './dashboard-page.js';
import os from 'node:os';

let dashClient = null; // set from index.js once the Discord client exists
let clientProvider = null; // injected by keepalive (jobStats, engine state)

export function setDashboardClient(client) { dashClient = client; }
export function initDashboardContext(providers) { clientProvider = providers || null; }

function client() { return dashClient; }

// ---- token -------------------------------------------------------------------

let cachedToken = null;

function fileToken() {
  const dir = ensureVarDir();
  const file = path.join(dir, 'dash-token');
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v.length >= 24) return v;
  } catch { /* first boot */ }
  return null;
}

function saveFileToken(t) {
  try {
    const dir = ensureVarDir();
    fs.writeFileSync(path.join(dir, 'dash-token'), t, { mode: 0o600 });
  } catch { /* best effort — DB + log still carry it */ }
}

function computeToken() {
  const env = (process.env.DASHBOARD_TOKEN || '').trim();
  if (env) return env;
  const gen = crypto.randomBytes(24).toString('base64url'); // 192-bit
  saveFileToken(gen);
  return gen;
}

function token() {
  if (!cachedToken) cachedToken = computeToken();
  return cachedToken;
}

/**
 * Keep the dashboard token STABLE across redeploys: Render's filesystem is
 * ephemeral, so the var/dash-token file dies on every deploy and the saved
 * dashboard URL would 404 forever. Fix: mirror the token in the database
 * (dashboard_state) and adopt the stored one when env/file are absent.
 * Priority: DASHBOARD_TOKEN env > database > var file > fresh generation.
 */
export async function initDashboardToken() {
  if (process.env.DASHBOARD_TOKEN?.trim()) {
    await db.kvSet('dash-token', process.env.DASHBOARD_TOKEN.trim()).catch(() => {});
    return token();
  }
  const stored = await db.kvGet('dash-token').catch(() => null);
  if (stored && stored.length >= 24) {
    cachedToken = stored;
    const ft = fileToken();
    if (ft !== stored) saveFileToken(stored); // heal the local file from DB
    return stored;
  }
  const ft = fileToken();
  if (ft) { cachedToken = ft; await db.kvSet('dash-token', ft).catch(() => {}); return ft; }
  const fresh = token();
  await db.kvSet('dash-token', fresh).catch(() => {});
  return fresh;
}

/** Log the private dashboard path once at boot (Render logs are owner-only). */
export function announceDashboard() {
  const t = token();
  logger.info({ dashboardPath: `/dash/${t}` }, 'dashboard: ready — private URL path (owner-only logs)');
  logger.info({}, 'dashboard: if the URL stopped working, set DASHBOARD_TOKEN in Render env to pin it forever');
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
  // Render terminates TLS on a shared proxy: remoteAddress is the PROXY's
  // internal address for every client. Key the brute-force buckets on the
  // forwarded client address instead — otherwise one attacker spamming wrong
  // tokens locks the OWNER (and everyone else) out of the dashboard too.
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return String(req.socket?.remoteAddress || '?');
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

function clearFails(ip) { fails.delete(ip); }

/** Owner tool: clear every lockout + API rate bucket (fixes self-lockouts). */
export function resetDashboardLimits() {
  let lockouts = 0;
  const now = Date.now();
  for (const [, st] of fails) if (st.until > now) lockouts += 1;
  const apiBuckets = apiHits.size;
  fails.clear();
  apiHits.clear();
  const cooldowns = resetCooldowns();
  return { lockouts, apiBuckets, cooldowns };
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

async function readBody(req, limit = 4_000_000) {
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
const API_LIMIT = 120; // per minute — raised: the power-tools grid fires several calls

function apiAllowed(ip) {
  const now = Date.now();
  const arr = (apiHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= API_LIMIT) { apiHits.set(ip, arr); return false; }
  arr.push(now);
  apiHits.set(ip, arr);
  return true;
}

// ---- input resolution for the code tools -------------------------------------------

/** Accept raw code, or an SSRF-hardened URL fetch. Returns { buffer, filename, error }. */
async function resolveInput(body) {
  const url = String(body.url || '').trim();
  const code = typeof body.code === 'string' ? body.code : '';
  if (url) {
    // safeFetch THROWS on any failure (SSRF guard, redirects, size caps) and
    // resolves { buffer, contentType, finalUrl }.
    try {
      const r = await safeFetch(url, { maxBytes: CONFIG.maxUploadBytes, timeoutMs: 30_000 });
      let filename = 'fetched';
      try { filename = decodeURIComponent(new URL(r.finalUrl || url).pathname.split('/').pop() || 'fetched').slice(0, 80) || 'fetched'; } catch { /* keep */ }
      return { buffer: r.buffer, filename };
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 250) };
    }
  }
  if (code.trim()) return { buffer: Buffer.from(code, 'utf8'), filename: String(body.filename || 'pasted.lua').slice(0, 80) };
  return { error: 'paste code or give a URL' };
}

function clip(text, max = 120_000) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, clipped: false, total: s.length };
  return { text: s.slice(0, max), clipped: true, total: s.length };
}

// ---- engine intel (AntiTamper V2 catalog + service matrix) -------------------------

let ENGINE_INTEL = null; // the catalog is static — compute once, serve forever

function engineIntel() {
  if (ENGINE_INTEL) return ENGINE_INTEL;
  const byFamily = new Map();
  const severity = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const counters = { neutralize: 0, env: 0, escalate: 0 };
  const goals = { static: 0, dynamic: 0, both: 0 };
  for (const v of CATALOG) {
    byFamily.set(v.family, (byFamily.get(v.family) || 0) + 1);
    severity[v.severity] = (severity[v.severity] || 0) + 1;
    counters[v.counter] = (counters[v.counter] || 0) + 1;
    goals[v.goal] = (goals[v.goal] || 0) + 1;
  }
  const families = [...byFamily.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  ENGINE_INTEL = {
    antitamper: {
      version: ANTITAMPER_VERSION,
      catalogSize: CATALOG_SIZE,
      familyCount: FAMILIES.length,
      families,
      severity,
      counters,
      goals,
      killVectors: CATALOG.filter((v) => v.severity >= 4).length,
      identities: EXECUTOR_IDENTITIES.map((i) => i.key),
      sanityProbes: probeCount(),
    },
    services: SERVICE_COMMANDS.map((s) => ({
      cmd: s.cmd,
      name: s.name || s.cmd,
      family: s.serviceId || '',
      note: String(s.blurb || '').slice(0, 140),
    })),
  };
  return ENGINE_INTEL;
}

// ---- main handler -------------------------------------------------------------------

/**
 * Route /dash/* — called from keepalive for every request that starts with /dash.
 * Everything the public internet may send lands here; wrong tokens see a plain
 * 404 indistinguishable from any other unknown path. A CORRECT token always
 * passes and clears any brute-force state for the caller.
 */
export async function handleDashboard(req, res, rawUrl) {
  const ip = ipOf(req);
  // Parse once: pathname for routing, searchParams for query options (?n=…).
  let pathname = String(rawUrl || '/');
  let search = new URLSearchParams();
  try {
    const parsed = new URL(pathname, 'http://x');
    pathname = parsed.pathname;
    search = parsed.searchParams;
  } catch { /* keep raw fallback */ }

  let parts = [];
  try { parts = pathname.split('/').filter(Boolean); } catch { parts = []; }

  // Expected: ['dash', token] or ['dash', token, 'api', ...]
  const supplied = decodeURIComponent(parts[1] || '');
  const good = parts[0] === 'dash' && Boolean(supplied) && safeEq(supplied, token());
  if (!good) {
    if (supplied) registerFail(ip);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not Found');
  }
  // Correct token ⇒ trusted owner: wipe any lockout recorded for this IP.
  clearFails(ip);

  const rest = parts.slice(2); // e.g. ['api', 'state']

  if (req.method === 'GET' && rest.length === 0) {
    return html(res, 200, renderPage());
  }

  if (rest[0] !== 'api') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not Found');
  }

  if (!apiAllowed(ip)) return json(res, 429, { ok: false, error: 'slow down (120 req/min cap)' });

  try {
    return await routeApi(req, res, rest.slice(1).join('/'), search);
  } catch (e) {
    logger.warn({ err: String(e?.message || e).slice(0, 160) }, 'dashboard: api error');
    return json(res, 500, { ok: false, error: 'internal error: ' + String(e?.message || e).slice(0, 160) });
  }
}

async function routeApi(req, res, route, search = new URLSearchParams()) {
  const audit = (command, result, extra = {}) => db.audit({
    userId: 'dashboard', username: 'dashboard (owner web)', command,
    args: extra.args || '', allowed: true, layer: 'dashboard', result: String(result || '').slice(0, 200),
  });

  if (req.method === 'GET') {
    if (route === 'state') return json(res, 200, { ok: true, data: await stateData() });
    if (route === 'engine') return json(res, 200, { ok: true, data: engineIntel() });
    if (route === 'logs') {
      const n = Math.max(5, Math.min(400, Number(search.get('n')) || 120));
      return json(res, 200, { ok: true, data: { lines: recentLogs(n) } });
    }
    if (route === 'audit') {
      if (!db.describe().enabled) return json(res, 200, { ok: true, data: { rows: [], note: 'database not configured' } });
      const rows = await db.auditTail(80);
      return json(res, 200, { ok: true, data: { rows } });
    }
    if (route === 'history') {
      if (!db.describe().enabled) return json(res, 200, { ok: true, data: { rows: [], note: 'database not configured' } });
      const rows = await db.historyTail(search.get('n') || 30);
      return json(res, 200, { ok: true, data: { rows } });
    }
    if (route === 'env') {
      const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|PIN|DATABASE_URL|URL$/i;
      const INTERESTING = [
        'DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'PREFIX', 'OWNER_ID', 'OWNER_PIN',
        'DATABASE_URL', 'PASTEFY_TOKEN', 'GITHUB_TOKEN', 'PUBLIC_URL', 'RENDER_EXTERNAL_URL',
        'MAX_UPLOAD_MB', 'ENGINE_TIMEOUT_S', 'PASTEFY_EXPIRE_DAYS', 'DANGER_COOLDOWN_S',
        'DANGER_MAX_PER_HOUR', 'CONFIRM_TIMEOUT_S', 'LOG_LEVEL', 'NODE_VERSION', 'PORT',
        'DASHBOARD_TOKEN', 'ENGINE_URL', 'ENGINE_PATH',
      ];
      const mask = (k, v) => {
        if (v === undefined || v === '') return '— (unset)';
        if (SECRET.test(k)) return '•••••••• (set, hidden)';
        return String(v).slice(0, 60);
      };
      return json(res, 200, { ok: true, data: { rows: INTERESTING.map((k) => ({ key: k, value: mask(k, process.env[k]) })) } });
    }
    if (route === 'commands') {
      return json(res, 200, {
        ok: true,
        data: {
          rows: COMMANDS.map((c) => ({ name: c.name, description: c.description || '', usage: c.usage || '', owner: Boolean(c.owner), danger: Boolean(c.danger) })),
        },
      });
    }
    if (route === 'backup') {
      if (!db.describe().enabled) return json(res, 200, { ok: false, error: 'database not configured' });
      const dump = {};
      for (const t of ['bot_stats', 'deobf_history', 'owner_audit', 'blacklist', 'guild_settings', 'dashboard_state']) {
        try {
          const r = await db.rawSql(`SELECT * FROM ${t} ORDER BY 1 DESC LIMIT 5000`);
          dump[t] = r.rows || [];
        } catch { dump[t] = { error: 'unreadable' }; }
      }
      await audit('dash-backup', Object.entries(dump).map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : 'err'}`).join(' '));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="bypassx-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        ...SECURITY_HEADERS,
      });
      return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), version: CONFIG.version, tables: dump }, null, 1));
    }
    if (route === 'invite') {
      const id = client()?.user?.id || CONFIG.clientId;
      const url = id
        ? `https://discord.com/oauth2/authorize?client_id=${id}&permissions=8&scope=bot%20applications.commands`
        : null;
      return json(res, 200, { ok: Boolean(url), data: { url, botId: id || null } });
    }
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });

  const body = await readBody(req);

  // ---- code power tools (deobf / detect / beautify / strings) ----------------------
  if (route === 'deobf') {
    const inp = await resolveInput(body);
    if (inp.error) return json(res, 200, { ok: false, error: inp.error });
    await audit('dash-deobf', `${inp.filename} ${inp.buffer.length}B hint=${body.hint || '-'}`, { args: inp.filename });
    try {
      const result = await deobfuscate({ buffer: inp.buffer, filename: inp.filename, hintId: body.hint || null });
      const out = clip(result.code || '');
      return json(res, 200, {
        ok: true,
        data: {
          detected: result.detected, lang: result.lang, stages: result.stages,
          originalSize: result.originalSize, recoveredSize: result.recoveredSize,
          durationMs: result.durationMs, note: result.note || '',
          output: out.text, clipped: out.clipped, totalChars: out.total,
          codeName: result.codeName || `deobf-${inp.filename}`,
        },
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: 'pipeline failed: ' + String(e?.message || e).slice(0, 200) });
    }
  }
  if (route === 'detect') {
    const inp = await resolveInput(body);
    if (inp.error) return json(res, 200, { ok: false, error: inp.error });
    await audit('dash-detect', `${inp.filename} ${inp.buffer.length}B`, { args: inp.filename });
    const d = detectService(inp.buffer);
    return json(res, 200, {
      ok: true,
      data: {
        filename: inp.filename, size: inp.buffer.length,
        best: d.best ? {
          name: d.best.service?.name, id: d.best.service?.id, version: d.best.version,
          confidence: d.best.confidence, evidence: (d.best.evidence || []).slice(0, 8),
        } : null,
        candidates: (d.candidates || []).slice(0, 6).map((c) => ({ name: c.service?.name, confidence: c.confidence })),
      },
    });
  }
  if (route === 'beautify') {
    const inp = await resolveInput(body);
    if (inp.error) return json(res, 200, { ok: false, error: inp.error });
    await audit('dash-beautify', `${inp.filename} ${inp.buffer.length}B`, { args: inp.filename });
    try {
      const r = beautifyCode(inp.filename, inp.buffer);
      const out = clip(r?.data ?? String(r ?? ''));
      return json(res, 200, { ok: true, data: { output: out.text, clipped: out.clipped, totalChars: out.total, codeName: `pretty-${inp.filename}` } });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  if (route === 'strings') {
    const inp = await resolveInput(body);
    if (inp.error) return json(res, 200, { ok: false, error: inp.error });
    await audit('dash-strings', `${inp.filename} ${inp.buffer.length}B`, { args: inp.filename });
    const text = inp.buffer.toString('utf8');
    const found = [];
    const seen = new Set();
    const push = (s) => {
      s = s.trim();
      if (s.length < 4 || s.length > 300) return;
      if (seen.has(s)) return;
      seen.add(s);
      found.push(s);
    };
    for (const line of text.split(/\r?\n/)) {
      for (const m of line.matchAll(/"((?:[^"\\\n]|\\.){4,300})"/g)) push(m[1]);
      for (const m of line.matchAll(/'((?:[^'\\\n]|\\.){4,300})'/g)) push(m[1]);
      for (const m of line.matchAll(/\[\[([^\]\n]{4,300})\]\]/g)) push(m[1]);
      if (found.length >= 5000) break;
    }
    const table = found.map((s, i) => `${String(i + 1).padStart(4)} | ${s.replace(/\n/g, '\\n').slice(0, 200)}`).join('\n');
    const out = clip(table);
    return json(res, 200, { ok: true, data: { count: found.length, output: out.text, clipped: out.clipped, totalChars: out.total, codeName: `strings-${inp.filename}.txt` } });
  }

  // ---- existing + new mutation tools ------------------------------------------------
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
  if (route === 'dm') {
    const userId = String(body.userId || '').trim();
    const text = String(body.text || '').trim();
    if (!/^\d{5,25}$/.test(userId)) return json(res, 200, { ok: false, error: 'numeric user id required' });
    if (!text) return json(res, 200, { ok: false, error: 'text required' });
    try {
      const u = await client().users.fetch(userId);
      await u.send(text.slice(0, 1900));
      await audit('dash-dm', `sent to ${u.tag} (${userId})`, { args: text.slice(0, 100) });
      return json(res, 200, { ok: true, data: { sent: true, tag: u.tag } });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  if (route === 'status') {
    const text = String(body.text || '').trim();
    if (!text) return json(res, 200, { ok: false, error: 'text required' });
    try {
      await client().user.setPresence({ activities: [{ name: text.slice(0, 120), type: 3 }], status: 'online' });
      await audit('dash-status', text.slice(0, 120));
      return json(res, 200, { ok: true, data: { set: text.slice(0, 120) } });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  if (route === 'lookup') {
    const id = String(body.id || '').trim();
    if (!/^\d{5,25}$/.test(id)) return json(res, 200, { ok: false, error: 'numeric id required' });
    const c = client();
    const out = { id, found: [] };
    const g = c?.guilds?.cache?.get(id);
    if (g) out.found.push({ kind: 'guild', name: g.name, members: g.memberCount ?? null, owner: g.ownerId, created: g.createdAt?.toISOString?.()?.slice(0, 10) || null });
    try {
      const u = await c?.users?.fetch(id);
      if (u) out.found.push({ kind: 'user', tag: u.tag, bot: u.bot, created: u.createdAt?.toISOString?.()?.slice(0, 10) || null, avatar: u.displayAvatarURL?.({ size: 64 }) || null });
    } catch { /* not a user */ }
    try {
      const ch = await c?.channels?.fetch(id);
      if (ch) out.found.push({ kind: 'channel', name: ch.name, type: ch.type, guild: ch.guild?.name || null });
    } catch { /* not a channel */ }
    const bl = db.describe().enabled ? await db.blacklistHas(id) : false;
    return json(res, 200, { ok: true, data: { ...out, blacklisted: bl } });
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
  if (route === 'engine-rebuild') {
    await audit('dash-engine-rebuild', 'prepare-engine started');
    const r = await runShell('node bin/prepare-engine.js', 300_000);
    return json(res, 200, { ok: true, data: r });
  }
  if (route === 'reset-limits') {
    const r = resetDashboardLimits();
    await audit('dash-reset-limits', `lockouts ${r.lockouts}, api buckets ${r.apiBuckets}, cooldowns ${r.cooldowns}`);
    return json(res, 200, { ok: true, data: r });
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
    heapMb: mem.heapUsed / 1024 / 1024,
    jobs,
    engine: clientProvider?.engine ? clientProvider.engine() : { available: false, version: null },
    db: d,
    stats,
    allTime,
    guilds,
    guildSettings,
    blacklist: d.enabled ? await db.blacklistList() : [],
    pinArmed: Boolean(process.env.OWNER_PIN),
    host: {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      cpus: os.cpus()?.length || 0,
      load1: os.loadavg?.()[0] ?? 0,
      pid: process.pid,
    },
    config: {
      prefix: CONFIG.prefix,
      ownerId: CONFIG.ownerId ? String(CONFIG.ownerId).replace(/\d(?=\d{4})/g, '•') : null,
      maxUploadMb: Math.round(CONFIG.maxUploadBytes / 1024 / 1024),
      engineTimeoutS: Math.round(CONFIG.engineTimeoutMs / 1000),
      commandCount: COMMANDS.length,
      publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '') || null,
    },
  };
}
