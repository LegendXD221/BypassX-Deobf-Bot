/**
 * BypassX Deobf Bot — jte bytecode-lift adapter (v2.14.0).
 *
 * research/jte-lua-decompiler/ vendors a reference-grade Rust decompiler
 * (Lua 5.1–5.5 / LuaJIT / Luau v3–14 bytecode → CFG → structured AST →
 * readable Lua; MIT/Apache-2.0). When its CLI binary is built, captured
 * bytecode chunks (RSB1 Luau / \x1bLua 5.1) decompile to REAL SOURCE instead
 * of being delivered as opaque binary artifacts — the missing half of the
 * decrypt-then-load recovery path.
 *
 * Binary resolution order:
 *   1. $JTE_BIN environment variable (explicit override)
 *   2. <repo>/bin/jte (build artifact — `scripts/build-jte.sh`)
 *   3. absent → { ok:false, note:'jte binary not built' } (graceful; callers
 *      fall back to raw-bytecode delivery, nothing changes for the user)
 *
 * Build once per deployment image:
 *   scripts/build-jte.sh        # cargo build --release -p cli → bin/jte
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnHardened } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveBinary() {
  if (process.env.JTE_BIN && fs.existsSync(process.env.JTE_BIN)) return process.env.JTE_BIN;
  const repoBin = path.join(here, '..', 'bin', 'jte');
  if (fs.existsSync(repoBin)) return repoBin;
  return null;
}

/** Luau RSB1 bytecode (Roblox serialized) — jte reads Luau v3-14 deserialization. */
export function isLuauBytecode(buf) {
  return Boolean(buf && buf.length > 4 && buf.subarray(0, 4).toString('latin1') === 'RSB1');
}

/** Standard Lua bytecode (\x1bLua signature). */
export function isLuaBytecode(buf) {
  return Boolean(buf && buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '\x1bLua');
}

/** Is a jte binary available in this deployment? (Cheap — no spawn.) */
export function jteBinaryPresent() {
  return resolveBinary() !== null;
}

/**
 * Decompile a bytecode buffer to readable Lua via the jte CLI.
 * @param {Buffer} buf - bytecode (RSB1 Luau or \x1bLua)
 * @param {{ timeoutMs?: number, deobfuscate?: boolean, flatten?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, code?: string, how?: string, note?: string }>}
 */
export async function jteDecompile(buf, opts = {}) {
  const bin = resolveBinary();
  if (!bin) return { ok: false, note: 'jte binary not built (scripts/build-jte.sh)' };
  const tmp = path.join(os.tmpdir(), `bxbot-jte-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.luac`);
  const out = `${tmp}.lua`;
  try {
    await fs.promises.writeFile(tmp, buf);
    const args = [tmp, out];
    if (opts.deobfuscate !== false) args.push('--deobfuscate');
    if (opts.flatten) args.push('--flatten');
    const r = await spawnHardened(bin, args, {
      timeoutMs: Math.min(opts.timeoutMs ?? 60_000, 120_000),
      label: 'jte-decompile',
      maxBuffer: 16 * 1024 * 1024,
    });
    const st = await fs.promises.stat(out).catch(() => null);
    if (r.code === 0 && st && st.size > 0) {
      const code = await fs.promises.readFile(out, 'utf8');
      if (code.trim().length > 0) {
        const parts = ['jte bytecode decompiler'];
        if (opts.deobfuscate !== false) parts.push('deobfuscation passes');
        if (opts.flatten) parts.push('CFF unflatten');
        return { ok: true, code, how: parts.join(' + ') };
      }
    }
    return { ok: false, note: `jte exited ${r.code}${r.stderr ? `: ${String(r.stderr).slice(0, 120)}` : ''}` };
  } catch (e) {
    return { ok: false, note: String(e && e.message || e).slice(0, 160) };
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.rm(out, { force: true }).catch(() => {});
  }
}
