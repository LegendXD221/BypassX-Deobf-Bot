/**
 * Lucid Deobf Bot — ported OmniDBF family bridge (v2.24.0).
 *
 * Bridges the vendored OmniDBF family deobfuscators (vendor/omnidbf/, CommonJS,
 * upstream credit preserved in vendor/omnidbf/README.md) into the hardened
 * pipeline. Each family runs inside src/ported-worker.cjs through
 * spawnHardened — scrubbed env, hard timeout, SIGKILL, no network, tokens
 * never reach the child — so the vendored third-party code never loads into
 * the bot's own heap.
 *
 * Ported (pure static, no external runtimes):
 *   clyde            — Clyde static VM inverter (stack/reg/max, lifted output)
 *   luaobfuscator_com— LuaObfuscator.com reconstruction (ast + vm lift)
 *   prostone         — Prostone AST+VM pipeline (Prometheus-derived, own parser)
 *   ironveil         — Ironveil V1 static engine
 *   moonveil         — MoonVeil static envelope peel + honest stub messaging
 *
 * Deliberately NOT ported (documented in the worklog):
 *   goofyscator py   — executes the sample inside a `lune` interpreter
 *                      (violates this bot's never-execute guarantee; our jailed
 *                      fengari harvest already covers VM pool decryption — and
 *                      gained OmniDBF's executor mocks in v2.24.0)
 *   77fuscator dll   — needs a .NET runtime
 *   psu java engine  — needs a JRE
 *   DeltaBypass      — heavy Python key-bypass service (numpy/fastapi/captcha)
 *
 * This module only launches workers and parses their JSON line — routing and
 * result shaping live in src/pipeline.js (runPortedRoute / tryPorted).
 */
import { spawnHardened } from './security.js';
import { logger } from './logger.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./ported-worker.cjs', import.meta.url));

/** vendor/omnidbf/deobfuscators — relative module ids keep upstream requires intact. */
export const PORTED_FAMILIES = {
  clyde: {
    mod: 'clyde_static_deob.js',
    detect: 'detectClyde',
    deobf: 'deobfuscateClyde',
    how: 'Clyde static VM inverter (ported OmniDBF lifter)',
  },
  luaobfuscator_com: {
    mod: 'LuaObf-Deobf/deobf.js',
    detect: null,
    deobf: 'luaobf:deobf',
    how: 'LuaObfuscator.com reconstruction (ported OmniDBF deobf)',
  },
  prostone: {
    mod: 'ProstoneDeobf/src/index.js',
    detect: null,
    deobf: 'prostone:deobfuscate',
    how: 'Prostone AST+VM pipeline (ported OmniDBF deobf)',
  },
  ironveil: {
    mod: 'ironveil_deob.js',
    detect: 'detectIronveil',
    deobf: 'deobfuscateIronveil',
    how: 'Ironveil V1 static engine (ported OmniDBF deobf)',
  },
  moonveil: {
    mod: 'moonveil_deob.js',
    detect: 'detectMoonVeil',
    deobf: 'deobfuscateMoonVeil',
    how: 'MoonVeil static envelope peel (ported OmniDBF, static-only)',
  },
};

/** Families the pipeline routes to the ported lifter FIRST (before engine). */
export const PORTED_FIRST = new Set(['clyde', 'luaobfuscator_com', 'ironveil', 'prostone']);

export function portedFamilyFor(serviceId) {
  return serviceId ? PORTED_FAMILIES[serviceId] || null : null;
}

/**
 * Run one ported family deobfuscator in the sandboxed worker.
 * @returns {Promise<{ok:true, output:string, stats?:object, meta?:object, how:string}
 *                 |{ok:false, error:string, meta?:object, how:string}>}
 */
export async function runPorted(serviceId, inputPath, { timeoutMs = 180_000, maxOutBytes = 8 * 1024 * 1024 } = {}) {
  const fam = portedFamilyFor(serviceId);
  if (!fam) return { ok: false, error: `no ported family for ${serviceId}`, how: 'ported' };
  const t0 = Date.now();
  let r;
  try {
    // detect='' would fail validateArgs — '-' is an unused placeholder the
    // worker skips (no such export resolves to a function).
    r = await spawnHardened(process.execPath, [workerPath, fam.mod, fam.detect || '-', fam.deobf, inputPath, String(maxOutBytes)], {
      timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      label: `ported:${serviceId}`,
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300), how: fam.how };
  }
  const line = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!line) {
    logger.warn({ serviceId, code: r.code, killed: r.killed, err: String(r.stderr || '').slice(0, 200) }, 'ported: worker produced no result');
    return { ok: false, error: `ported ${serviceId} worker produced no result${r.killed ? ' (timeout)' : ''}`, how: fam.how };
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: `ported ${serviceId} worker output not JSON`, how: fam.how };
  }
  if (!parsed.ok) {
    return { ok: false, error: String(parsed.error || 'ported deobfuscator failed').slice(0, 500), meta: parsed.meta, how: fam.how };
  }
  logger.info({ serviceId, ms: Date.now() - t0, out: parsed.output?.length ?? 0 }, 'ported: hit');
  return { ok: true, output: parsed.output, stats: parsed.stats || null, meta: parsed.meta, how: fam.how };
}
