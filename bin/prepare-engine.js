/**
 * BypassX Deobf Bot — engine binary boot-preparer.
 *
 * Downloads the precompiled static-analysis engine (no Rust toolchain needed)
 * on first boot, unpacks it into var/engine/, and verifies it runs.
 *
 * Order:
 *   1. ENGINE_PATH env (already-unpacked binary) — done.
 *   2. var/engine/bypassx-deobf from a previous run — done.
 *   3. ENGINE_URL (default: this repo's GitHub Release asset) — download.
 *   4. Fallback: raw.githubusercontent.com/LegendXD221/BypassX-Deobf (needs
 *      GITHUB_TOKEN if that repo is private).
 *
 * The binary is ~150 MB unpacked / ~50 MB gz. One-time download per machine.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { CONFIG, ensureVarDir } from '../src/config.js';

const FALLBACKS = [
  CONFIG.engineUrl,
  'https://raw.githubusercontent.com/LegendXD221/BypassX-Deobf/main/web/bin/bypassx-deobf.gz',
];

function looksExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).size > 1024 * 1024;
  } catch {
    return false;
  }
}

async function download(url, dest, { token = null } = {}) {
  console.log(`downloading engine: ${url}`);
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 * 1024) throw new Error(`download too small (${buf.length} bytes)`);
  await fsp.writeFile(dest, buf, { mode: 0o600 });
  return buf;
}

async function main() {
  const engineDir = ensureVarDir('engine');
  const target = path.join(engineDir, 'bypassx-deobf');
  const gzCache = path.join(engineDir, 'bypassx-deobf.gz');

  if (CONFIG.enginePath && looksExecutable(CONFIG.enginePath)) {
    console.log(`engine: using ENGINE_PATH=${CONFIG.enginePath}`);
    return;
  }
  if (looksExecutable(target)) {
    console.log(`engine: already prepared at ${target}`);
    verify(target);
    return;
  }

  let lastErr = null;
  for (const url of FALLBACKS) {
    try {
      const buf = await download(url, gzCache, { token: url.includes('raw.githubusercontent.com/LegendXD221/BypassX-Deobf/') ? CONFIG.githubToken : null });
      const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
      console.log(`unpacking engine (${(buf.length / 1024 / 1024).toFixed(1)} MB${isGz ? ', gzip' : ''})…`);
      const out = isGz ? zlib.gunzipSync(buf) : buf;
      await fsp.writeFile(target, out, { mode: 0o755 });
      await fsp.rm(gzCache, { force: true });
      verify(target);
      console.log('engine ready.');
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`engine source failed: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  console.error(`FATAL: could not prepare the engine: ${String(lastErr?.message || lastErr)}`);
  console.error('Set ENGINE_URL or ENGINE_PATH, or publish the release asset.');
  process.exit(1);
}

function verify(binPath) {
  const r = spawnSync(binPath, ['--version'], { timeout: 20_000, encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`engine version: ${(r.stdout || '').trim().split('\n')[0].slice(0, 80) || 'ok'}`);
  } else {
    console.warn('engine --version probe failed (may still run fine):', String(r.stderr || '').slice(0, 200));
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
