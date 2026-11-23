/**
 * Lucid Deobf Bot — AntiTamper V3 persistent evidence store (VPS edition).
 *
 * The old engine was shaped by Render's ephemeral disk: every tamper signal
 * (defused vectors, escalation adoptions, jail sanity results) evaporated with
 * the container. On the persistent VPS the signals are worth KEEPING:
 *
 *   • append-only JSONL at var/antitamper/evidence.jsonl (one event per line)
 *   • capped + self-pruning: newest 5000 lines survive (prune on write)
 *   • failure-safe: every I/O path is try/catch — evidence NEVER breaks a run
 *   • summary(last) aggregates recent lines for /stats-style surfaces
 *
 * Event shapes (type discriminator):
 *   { type:'defuse',  vectors:[{id,count}], bytesSaved, file }
 *   { type:'envlog',  reads:[{n,c}], writes:[{n,c}], file }
 *   { type:'boot',    audit:{ok, issues[]}, pid }
 *   { type:'logger',  verdict, chunks, strings, notable:[{kind,preview}] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ensureVarDir } from '../config.js';

const MAX_LINES = 5000;
const MAX_BYTES_PER_LINE = 32 * 1024;

let dirPromise = null;
function evidencePath() {
  if (!dirPromise) dirPromise = ensureVarDir('antitamper');
  return path.join(String(dirPromise), 'evidence.jsonl');
}

/** Append one evidence event. Never throws. */
export function record(entry) {
  try {
    if (!entry || typeof entry !== 'object') return false;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    if (line.length > MAX_BYTES_PER_LINE) return false;
    const file = evidencePath();
    fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    prune(file);
    return true;
  } catch {
    return false;
  }
}

/** Keep the newest MAX_LINES lines. Never throws. */
function prune(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < 4 * 1024 * 1024) return; // fast path: small store, skip prune
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n', { mode: 0o600 });
  } catch { /* best effort */ }
}

/** Aggregate the most recent events. Never throws. Returns null when empty. */
export function summary(last = 500) {
  try {
    const raw = fs.readFileSync(evidencePath(), 'utf8');
    const lines = raw.split('\n').filter(Boolean).slice(-last);
    const out = { lines: lines.length, defusals: 0, vectors: {}, escalations: {}, envWrites: 0, bootIssues: 0, loggerRecordings: 0 };
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'defuse') {
        out.defusals += 1;
        for (const v of e.vectors || []) out.vectors[v.id] = (out.vectors[v.id] || 0) + v.count;
      } else if (e.type === 'envlog') {
        out.envWrites += (e.writes || []).reduce((a, w) => a + (w.c || 0), 0);
      } else if (e.type === 'boot' && e.audit && !e.audit.ok) {
        out.bootIssues += 1;
      } else if (e.type === 'logger') {
        out.loggerRecordings += 1;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Boot-time jail sanity audit, recorded as evidence. Fire-and-forget from the
 * bot's ready handler — on the VPS this proves at every boot that the jail
 * environment is still production-shaped (env-hardening layers intact).
 */
export function bootAudit() {
  try {
    // lazy import avoids a cycle: sanity.js ← index.js at module-eval time
    import('./sanity.js')
      .then((s) => {
        const res = s.audit ? s.audit() : null;
        const failures = res && Array.isArray(res.failures) ? res.failures : [];
        record({
          type: 'boot',
          audit: {
            ok: Boolean(res && res.ok),
            total: res ? res.total : 0,
            passed: res ? res.passed : 0,
            failures: failures.slice(0, 8).map((f) => `${f.profile}/${f.id}: ${String(f.err || '').slice(0, 80)}`),
          },
          pid: process.pid,
        });
      })
      .catch(() => { /* sanity unavailable — skip silently */ });
  } catch { /* never break boot */ }
}
