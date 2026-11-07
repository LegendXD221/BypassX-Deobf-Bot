/**
 * BypassX Deobf Bot — Neon Postgres (free tier) persistence layer.
 *
 * Activated purely by the presence of DATABASE_URL (Neon connection string,
 * e.g. postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require).
 * If it is missing or Neon is unreachable, EVERY function degrades to a safe
 * in-memory no-op — the bot keeps working exactly as before.
 *
 * Schema (bootstrap on first connect):
 *   bot_stats      key/value counters (all-time deobf counts etc.)
 *   deobf_history  one row per deobf/detect job (for .history + .stats)
 *   owner_audit    5-layer owner-protection audit trail (layer 5)
 *   blacklist      abusive users/guilds, enforced at dispatch
 *
 * Safety: Neon requires TLS → ssl: { rejectUnauthorized: false }. Pool is tiny
 * (free tier), connections are lazy, and every query is failure-isolated.
 */
import pg from 'pg';
import { logger } from './logger.js';

const state = {
  pool: null,
  bootstrapped: false,
  lastError: null,
  lastOkAt: null,
  latencyMs: null,
};

/** The live Neon URL — only real postgres:// strings count (read every call,
 *  so the dashboard value takes effect on the next process start). */
function dbUrl() {
  const u = String(process.env.DATABASE_URL || '').trim();
  return /^postgres(ql)?:\/\//i.test(u) ? u : '';
}

const BLACKLIST_TTL = 30_000;
const blacklistCache = { at: 0, set: new Set() };

function redact(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '••••••';
    if (u.pathname) return `${u.protocol}//${u.username}:••••••@${u.host}${u.pathname}`;
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid-url';
  }
}

export function describe() {
  const url = dbUrl();
  return {
    enabled: Boolean(url),
    connected: Boolean(url) && state.bootstrapped && !state.lastError,
    host: url ? redact(url) : null,
    latencyMs: state.latencyMs,
    error: state.lastError,
    lastOkAt: state.lastOkAt ? new Date(state.lastOkAt).toISOString() : null,
    breaker: { open: breakerOpen(), trips: breaker.trips, queued: gate.waiters.length, active: gate.active },
  };
}

/** Lazily create the pool + schema. Returns true when the DB is usable. */
export async function init() {
  const url = dbUrl();
  if (!url) return false;
  if (state.bootstrapped && state.pool) return true;
  try {
    const t0 = Date.now();
    state.pool = new pg.Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
    });
    state.pool.on('error', (e) => {
      state.lastError = String(e?.message || e).slice(0, 160);
      logger.warn({ err: state.lastError }, 'db: pool error');
    });
    await state.pool.query(`
      CREATE TABLE IF NOT EXISTS bot_stats (
        key        TEXT PRIMARY KEY,
        value      BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS deobf_history (
        id          BIGSERIAL PRIMARY KEY,
        user_id     TEXT,
        guild_id    TEXT,
        command     TEXT,
        family      TEXT,
        confidence  INTEGER,
        success     BOOLEAN,
        filename    TEXT,
        size        INTEGER,
        duration_ms INTEGER,
        paste_url   TEXT,
        source      TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS owner_audit (
        id         BIGSERIAL PRIMARY KEY,
        user_id    TEXT,
        username   TEXT,
        command    TEXT,
        args       TEXT,
        allowed    BOOLEAN,
        layer      TEXT,
        result     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS blacklist (
        id         BIGSERIAL PRIMARY KEY,
        target     TEXT UNIQUE,
        kind       TEXT,
        reason     TEXT,
        added_by   TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id       TEXT PRIMARY KEY,
        disabled       BOOLEAN NOT NULL DEFAULT FALSE,
        deobf_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
        detect_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        prefix         TEXT,
        note           TEXT,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS deobf_history_user_idx ON deobf_history (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS owner_audit_time_idx ON owner_audit (created_at DESC);
    `);
    state.bootstrapped = true;
    state.lastError = null;
    state.latencyMs = Date.now() - t0;
    state.lastOkAt = Date.now();
    logger.info({ latencyMs: state.latencyMs, host: describe().host }, 'db: Neon connected + schema ready');
    return true;
  } catch (e) {
    state.lastError = String(e?.message || e).slice(0, 200);
    logger.warn({ err: state.lastError }, 'db: init failed — running without persistence');
    return false;
  }
}

// ---- Neon free-tier overload protection -------------------------------------
//
// Neon's free plan has tiny compute + connection budgets, so the DB layer is
// deliberately gentle:
//   • CONCURRENCY CAP  — at most MAX_CONCURRENT queries in flight; extra
//     callers wait in a bounded queue (beyond MAX_QUEUE they fail fast with
//     null instead of piling up connections).
//   • CIRCUIT BREAKER  — BREAKER_FAILS consecutive failures trip the breaker
//     for BREAKER_COOLDOWN_MS; every call during the trip returns null
//     instantly without touching Neon (lets a struggling instance recover).
//   • STAT COALESCING  — stat() deltas buffer in memory and flush as one
//     batched UPSERT every STAT_FLUSH_MS (deobf traffic = ~0 queries).
const MAX_CONCURRENT = 2;
const MAX_QUEUE = 16;
const BREAKER_FAILS = 5;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
const STAT_FLUSH_MS = 30_000;

const gate = { active: 0, waiters: [] };
const breaker = { fails: 0, openUntil: 0, trips: 0 };

function acquireSlot() {
  if (gate.active < MAX_CONCURRENT) {
    gate.active += 1;
    return Promise.resolve();
  }
  if (gate.waiters.length >= MAX_QUEUE) {
    return Promise.reject(new Error('db queue full'));
  }
  return new Promise((resolve, reject) => {
    gate.waiters.push({ resolve, reject });
  });
}

function releaseSlot() {
  const next = gate.waiters.shift();
  if (next) next.resolve();
  else gate.active = Math.max(0, gate.active - 1);
}

function breakerOpen() {
  return breaker.openUntil > Date.now();
}

/**
 * Run a query. Resolves rows/rowCount, or null when the DB is unavailable,
 * tripped, or overloaded — callers must treat null as "no data", never as an
 * error.
 */
export async function query(text, params = []) {
  if (!dbUrl() || !state.pool) return null;
  if (breakerOpen()) return null;
  let released = false;
  try {
    await acquireSlot();
    released = true;
    const t0 = Date.now();
    const res = await state.pool.query(text, params);
    state.lastError = null;
    state.latencyMs = Date.now() - t0;
    state.lastOkAt = Date.now();
    breaker.fails = 0;
    return res;
  } catch (e) {
    breaker.fails += 1;
    if (breaker.fails >= BREAKER_FAILS) {
      breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      breaker.trips += 1;
      breaker.fails = 0;
      logger.warn({ trips: breaker.trips, cooldownMs: BREAKER_COOLDOWN_MS }, 'db: circuit breaker OPEN — cooling down');
    }
    state.lastError = String(e?.message || e).slice(0, 200);
    logger.warn({ err: state.lastError }, 'db: query failed');
    return null;
  } finally {
    if (released) releaseSlot();
  }
}

// ---- stats ------------------------------------------------------------------

const statBuf = new Map(); // key -> buffered delta
let statTimer = null;

/** Buffered counter bump — coalesced into one batched UPSERT per 30 s. */
export function stat(key, delta = 1) {
  const k = String(key).slice(0, 60);
  statBuf.set(k, (statBuf.get(k) || 0) + (Number(delta) || 0));
  if (!statTimer) statTimer = setTimeout(() => { flushStats().catch(() => {}); }, STAT_FLUSH_MS);
  statTimer.unref?.();
}

/** Force-flush buffered stat deltas (also called on an interval and in tests). */
export async function flushStats() {
  if (!statBuf.size) return 0;
  const entries = [...statBuf.entries()];
  statBuf.clear();
  let n = 0;
  for (const [key, delta] of entries) {
    const res = await query(
      `INSERT INTO bot_stats (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = bot_stats.value + $2, updated_at = now()`,
      [key, delta],
    );
    if (res) n += 1;
  }
  return n;
}

export async function statsAll() {
  const res = await query('SELECT key, value FROM bot_stats');
  if (!res) return {};
  return Object.fromEntries(res.rows.map((r) => [r.key, Number(r.value)]));
}

// ---- deobf history ----------------------------------------------------------

export async function logDeobf(entry) {
  await query(
    `INSERT INTO deobf_history
       (user_id, guild_id, command, family, confidence, success, filename, size, duration_ms, paste_url, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      entry.userId ? String(entry.userId) : null,
      entry.guildId ? String(entry.guildId) : null,
      String(entry.command || 'deobf').slice(0, 20),
      entry.family ? String(entry.family).slice(0, 60) : null,
      Number.isFinite(entry.confidence) ? Math.round(entry.confidence) : null,
      Boolean(entry.success),
      entry.filename ? String(entry.filename).slice(0, 120) : null,
      Number.isFinite(entry.size) ? Math.round(entry.size) : null,
      Number.isFinite(entry.durationMs) ? Math.round(entry.durationMs) : null,
      entry.pasteUrl ? String(entry.pasteUrl).slice(0, 200) : null,
      entry.source ? String(entry.source).slice(0, 20) : null,
    ],
  );
}

export async function historyFor(userId, limit = 10) {
  const res = await query(
    `SELECT family, confidence, success, filename, paste_url, command, created_at
     FROM deobf_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [String(userId), Math.max(1, Math.min(25, limit))],
  );
  return res ? res.rows : [];
}

export async function allTimeCounts() {
  const res = await query(
    `SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE success)::bigint AS ok FROM deobf_history`,
  );
  if (!res) return null;
  return { total: Number(res.rows[0]?.total || 0), ok: Number(res.rows[0]?.ok || 0) };
}

// ---- owner audit (protection layer 5) ----------------------------------------

export async function audit(entry) {
  await query(
    `INSERT INTO owner_audit (user_id, username, command, args, allowed, layer, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.userId ? String(entry.userId) : null,
      entry.username ? String(entry.username).slice(0, 80) : null,
      String(entry.command || '?').slice(0, 40),
      String(entry.args || '').slice(0, 200),
      Boolean(entry.allowed),
      entry.layer ? String(entry.layer).slice(0, 40) : null,
      entry.result ? String(entry.result).slice(0, 200) : null,
    ],
  );
}

export async function auditTail(limit = 15) {
  const res = await query(
    `SELECT user_id, username, command, allowed, layer, result, created_at
     FROM owner_audit ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(50, limit))],
  );
  return res ? res.rows.reverse() : [];
}

// ---- blacklist ----------------------------------------------------------------

export async function blacklistAdd(target, kind, reason, addedBy) {
  invalidateBlacklist();
  const res = await query(
    `INSERT INTO blacklist (target, kind, reason, added_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (target) DO UPDATE SET kind = $2, reason = $3, added_by = $4, created_at = now()`,
    [String(target).slice(0, 60), String(kind).slice(0, 10), String(reason || '').slice(0, 200), String(addedBy || '').slice(0, 60)],
  );
  return Boolean(res);
}

export async function blacklistRemove(target) {
  invalidateBlacklist();
  const res = await query('DELETE FROM blacklist WHERE target = $1', [String(target).slice(0, 60)]);
  return res ? res.rowCount > 0 : false;
}

export async function blacklistList() {
  const res = await query('SELECT target, kind, reason, added_by, created_at FROM blacklist ORDER BY created_at DESC LIMIT 50');
  return res ? res.rows : [];
}

function invalidateBlacklist() {
  blacklistCache.at = 0;
  blacklistCache.set = new Set();
}

/** Cached membership check (30s TTL) — cheap enough for every dispatch. */
export async function blacklistHas(target) {
  if (!target || !dbUrl()) return false;
  const now = Date.now();
  if (now - blacklistCache.at > BLACKLIST_TTL) {
    const res = await query('SELECT target FROM blacklist');
    // Refresh the TTL even on failure — a down/overloaded DB must not be
    // re-queried on literally every dispatch (the breaker alone is not
    // enough at command-fanout scale; serve the last known set instead).
    blacklistCache.at = now;
    if (res) {
      blacklistCache.set = new Set(res.rows.map((r) => String(r.target)));
    }
  }
  return blacklistCache.set.has(String(target));
}

// ---- guild settings (dashboard-controlled per-guild behaviour) ---------------

const GUILD_TTL = 60_000;
const guildCache = new Map(); // guildId -> { at, settings }

export const GUILD_DEFAULTS = Object.freeze({
  disabled: false,
  deobf_enabled: true,
  detect_enabled: true,
  prefix: null,
  note: null,
});

/** Cached per-guild settings (60 s TTL). Always resolves — defaults when the
 *  DB is off. Owner/dispatch code must never await an error from here. */
export async function getGuildSettings(guildId) {
  if (!guildId || !dbUrl()) return { ...GUILD_DEFAULTS };
  const now = Date.now();
  const hit = guildCache.get(String(guildId));
  if (hit && now - hit.at < GUILD_TTL) return hit.settings;
  const res = await query('SELECT disabled, deobf_enabled, detect_enabled, prefix, note FROM guild_settings WHERE guild_id = $1', [String(guildId)]);
  const settings = res?.rows?.[0]
    ? {
      disabled: Boolean(res.rows[0].disabled),
      deobf_enabled: Boolean(res.rows[0].deobf_enabled),
      detect_enabled: Boolean(res.rows[0].detect_enabled),
      prefix: res.rows[0].prefix || null,
      note: res.rows[0].note || null,
    }
    : { ...GUILD_DEFAULTS };
  guildCache.set(String(guildId), { at: now, settings });
  return settings;
}

/** Per-guild prefix for prefix commands (null → global PREFIX). */
export async function guildPrefix(guildId) {
  const s = await getGuildSettings(guildId);
  return s.prefix || null;
}

/** Merge-patch one guild's settings (dashboard). Invalidates the cache. */
export async function setGuildSettings(guildId, patch = {}) {
  const id = String(guildId || '');
  if (!id || !dbUrl()) return false;
  const cur = await getGuildSettings(id);
  const next = {
    disabled: typeof patch.disabled === 'boolean' ? patch.disabled : cur.disabled,
    deobf_enabled: typeof patch.deobf_enabled === 'boolean' ? patch.deobf_enabled : cur.deobf_enabled,
    detect_enabled: typeof patch.detect_enabled === 'boolean' ? patch.detect_enabled : cur.detect_enabled,
    prefix: patch.prefix !== undefined ? (String(patch.prefix || '').slice(0, 8) || null) : cur.prefix,
    note: patch.note !== undefined ? String(patch.note || '').slice(0, 200) || null : cur.note,
  };
  const res = await query(
    `INSERT INTO guild_settings (guild_id, disabled, deobf_enabled, detect_enabled, prefix, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (guild_id) DO UPDATE SET
       disabled = $2, deobf_enabled = $3, detect_enabled = $4, prefix = $5, note = $6, updated_at = now()`,
    [id, next.disabled, next.deobf_enabled, next.detect_enabled, next.prefix, next.note],
  );
  guildCache.delete(id);
  return Boolean(res);
}

// ---- raw SQL (owner .db command) ----------------------------------------------

export async function rawSql(text) {
  if (!dbUrl() || !state.pool) return { error: 'DATABASE_URL not configured — database is offline.' };
  const t0 = Date.now();
  try {
    const res = await state.pool.query(text);
    state.lastOkAt = Date.now();
    state.latencyMs = Date.now() - t0;
    const rows = res.rows || [];
    return {
      rowCount: res.rowCount ?? rows.length,
      fields: res.fields?.map((f) => f.name) || [],
      rows,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 400), ms: Date.now() - t0 };
  }
}
