/**
 * BypassX Deobf Bot — external Luraph v15 devirtualizer (vendored engine).
 *
 * Vendors caomod2077/Deobfuscator-Luraph-V15 (MIT) under vendor/luraph-v15/
 * and exposes it as a full-source recovery stage for Luraph v15/v14 builds.
 *
 * The vendored engine recovers TRUE source (CFG + SSA lift, closure
 * reconstruction, live constant decryption) for the standard Luraph v15
 * closure-maker layout — the shape our own real-Luau devirtualizer cannot
 * fully lift (it covers the CPS-loader/hybrid layout instead). The two are
 * complementary: the pipeline tries this engine first for v15 and falls
 * through to our own chain on any miss.
 *
 * Safety model (same containment class as our own bin/luau stage):
 *   • the sample runs inside the vendored offline Roblox emulator (envlog),
 *     never against a real environment;
 *   • the whole CLI is spawned hardened (env-sanitized, wall-clock kill,
 *     output-capped) in a throwaway temp dir;
 *   • output is accepted only if it parses as Lua/Luau, contains no trace
 *     internals (NUL markers) and differs from the input.
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { spawnHardened } from './security.js';
import { verifyCode } from './validate.js';
import { logger } from './logger.js';

const VENDOR_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor', 'luraph-v15');
const DEOB_JS = path.join(VENDOR_DIR, 'deob.js');

let _probe = null;

function findPython() {
  for (const bin of ['python3', 'python']) {
    try {
      const r = spawnSync(bin, ['-V'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) return bin;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Availability probe — cached. Checks vendor files, exec bits and python3.
 * @returns {{ available: boolean, reason: string }}
 */
export function probeExtEngine() {
  if (_probe) return _probe;
  let reason = 'ok';
  try {
    if (!fs.existsSync(DEOB_JS)) reason = 'vendored engine missing';
    else if (!fs.existsSync(path.join(VENDOR_DIR, 'bin', 'luau'))) reason = 'vendored luau missing';
    else if (!fs.existsSync(path.join(VENDOR_DIR, 'bin', 'luau-ast'))) reason = 'vendored luau-ast missing';
    else if (!findPython()) reason = 'python3 not available on host';
  } catch (e) {
    reason = String(e.message || e).slice(0, 80);
  }
  _probe = { available: reason === 'ok', reason };
  if (_probe.available) logger.info(null, '[luraph-ext] vendored Luraph v15 engine ready');
  else logger.warn(null, `[luraph-ext] unavailable: ${reason}`);
  return _probe;
}

/**
 * Run one vendored-engine phase.
 * @param {string} sampleText full obfuscated source
 * @param {{ timeoutMs?: number, version?: string, extraArgs?: string[], label?: string }} opts
 * @returns {Promise<null | { code, seconds, how, verification, phase }>} null on any miss
 */
async function runExtPhase(sampleText, { timeoutMs = 150_000, version = 'v15', extraArgs = [], label = 'luraph-ext' } = {}) {
  const probe = probeExtEngine();
  if (!probe.available) return null;

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bxext-'));
  const inPath = path.join(dir, 'input.lua');
  const outPath = path.join(dir, 'output.lua');
  await fsp.writeFile(inPath, sampleText, { mode: 0o600 });

  const totalS = Math.max(20, Math.floor(timeoutMs / 1000));
  const args = [
    DEOB_JS, inPath, '-o', outPath,
    '--timeout', String(Math.max(15, Math.floor(totalS * 0.55))),
    '--budget', String(Math.max(10, Math.floor(totalS * 0.35))),
    '--max-runs', '6',
    ...extraArgs,
  ];
  const t0 = Date.now();
  try {
    const r = await spawnHardened(process.execPath, args, {
      cwd: dir,
      timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      label,
    });
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    const stdout = (r.stdout || '').toString('utf8');

    let code = null;
    try {
      const st = await fsp.stat(outPath);
      if (st.size > 0) code = await fsp.readFile(outPath, 'utf8');
    } catch { /* no output file */ }

    if (!code) return null;
    if (code.includes('\u0000')) return null;          // behaviour-trace internals
    if (code === sampleText) return null;               // pass-through, nothing recovered
    const verification = verifyCode(code, { lang: 'lua', filename: 'luraph15-ext.lua' });
    if (verification.status !== 'verified') return null;

    const fnM = /(\d+) functions?, \d+ unlifted/.exec(stdout);
    const fns = fnM ? Number(fnM[1]) : null;
    const stmtM = /(\d+) statements recorded/.exec(stdout);
    const stmts = stmtM ? Number(stmtM[1]) : null;
    const trace = extraArgs.includes('--no-devirt');
    return {
      code,
      seconds,
      phase: trace ? 'trace' : 'devirt',
      how: trace
        ? `full source via vendored Luraph ${version} engine — behaviour-trace recovery${stmts ? `, ${stmts} statements recorded` : ''} (${seconds}s)`
        : `full source via vendored Luraph v15 devirtualizer (CFG+SSA lift${fns ? `, ${fns} functions` : ''}, ${seconds}s)`,
      verification,
    };
  } catch {
    return null; // hard timeout / crash — caller decides next step
  } finally {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

/**
 * Run the vendored devirtualizer on one sample — two phases:
 *
 *   1. CFG+SSA devirt lift — true full-source reconstruction for the standard
 *      v15 closure-maker layout.
 *   2. behaviour-trace recovery (--no-devirt) — for the hybrid CPS-loader
 *      layout the lifter cannot read ("no closure makers / dispatchers
 *      found"): the sample still runs in the offline emulator and its
 *      executed statements are recorded and re-emitted as real source.
 *
 * Phase 2 splits the remaining time budget with phase 1.
 * @param {string} sampleText full obfuscated source
 * @param {{ timeoutMs?: number, detectedName?: string, version?: string }} opts
 * @returns {Promise<null | { code, seconds, how, verification, phase }>} null on any miss
 */
export async function runExtDeobf(sampleText, { timeoutMs = 150_000, version = 'v15' } = {}) {
  const first = Math.floor(timeoutMs * 0.6);
  const devirt = await runExtPhase(sampleText, { timeoutMs: first, version, label: 'luraph-ext' });
  if (devirt) return devirt;
  const rest = Math.max(20_000, timeoutMs - first);
  return runExtPhase(sampleText, { timeoutMs: rest, version, extraArgs: ['--no-devirt'], label: 'luraph-ext-trace' });
}
