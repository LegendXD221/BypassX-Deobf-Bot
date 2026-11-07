/**
 * BypassX Deobf Bot — Rust engine bridge.
 *
 * Wraps the precompiled `bypassx-deobf` CLI (static deobfuscation engine,
 * engine 0.12.0 / 64 crates) with:
 *   • hardened spawn (see security.js)
 *   • bounded concurrency (2 runs, queue 8)
 *   • per-run 0700 tmpdir, reaped after use
 *   • multi-stage strategy for maximum recovery:
 *       stage A  targeted:  lua deobfuscate --family <detected>
 *       stage B  generic:   auto --max-depth N --capture-stages
 *       stage C  sweep:     every lua family until one produces code
 *   • pyarmor: pyarmor unpack (v6/v7 dynamic-hook + v8/v9-pro static)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG, ensureVarDir } from './config.js';
import { logger } from './logger.js';
import { spawnHardened } from './security.js';

export const ENGINE_LUA_FAMILIES = [
  'luraph', 'moonsec-v3', 'moonsec-v2', 'moonsec-v1', 'ironbrew2', 'aztup-brew',
  'prometheus', 'hercules', 'boronide', 'dark-sec', 'luaobfuscator-com', 'psu',
  'wearedevs', 'slua',
];

const CODE_EXT = new Set([
  '.lua', '.luac', '.glua', '.py', '.pyc', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.php', '.rb', '.java', '.cs', '.il', '.rs', '.go', '.c', '.h', '.cpp',
  '.asm', '.wat', '.wast', '.ps1', '.bat', '.cmd', '.sh', '.vba', '.vb', '.txt',
]);
const REPORT_BASENAMES = /^(recovery|chain|report|anti-analysis|indicators|recon|ioc|frisk|behavior|prowl)\b/i;
const MAX_CODE_BYTES = 8 * 1024 * 1024;

const state = {
  probed: false,
  available: false,
  version: null,
  active: 0,
  queue: [],
};

export function enginePath() {
  if (CONFIG.enginePath) return CONFIG.enginePath;
  return path.join(CONFIG.varDir, 'engine', 'bypassx-deobf');
}

/** Probe the engine once; returns { available, version }. Re-probes while the
 *  engine is unavailable so keepalive's 60s refresh can pick up a late
 *  install instead of showing "preparing…" forever. */
export async function probe() {
  if (state.probed && state.available) return { available: state.available, version: state.version };
  state.probed = true;
  const p = enginePath();
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    if (state.available !== false || state.version !== null) {
      logger.warn({ path: p }, 'engine: binary missing or not executable');
    }
    state.available = false;
    state.version = null;
    return { available: false, version: null };
  }
  const r = await spawnHardened(p, ['--version'], { timeoutMs: 15_000, label: 'engine --version' });
  state.available = r.code === 0;
  state.version = (r.stdout.trim().split('\n')[0] || '').slice(0, 80) || (state.available ? 'unknown' : null);
  logger.info({ version: state.version, path: p }, 'engine probe');
  return { available: state.available, version: state.version };
}

// ---- bounded concurrency ----------------------------------------------------
async function withSlot(fn) {
  if (state.active >= CONFIG.maxConcurrent) {
    if (state.queue.length >= CONFIG.maxQueue) throw new Error('engine busy — too many queued jobs, try again in a moment');
    await new Promise((resolve, reject) => state.queue.push({ resolve, reject }));
  }
  state.active += 1;
  try {
    return await fn();
  } finally {
    state.active -= 1;
    const next = state.queue.shift();
    if (next) next.resolve();
  }
}

// ---- run helpers ------------------------------------------------------------
/** Fresh isolated 0700 workdir: { workDir, inputDir, outDir }. */
function freshDirs() {
  const workDir = ensureVarDir(`run/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const inputDir = path.join(workDir, 'in');
  const outDir = path.join(workDir, 'out');
  fs.mkdirSync(inputDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  return { workDir, inputDir, outDir };
}

async function runEngine(args, { inputDir, outDir, workDir, timeoutMs = CONFIG.engineTimeoutMs, label = 'engine' } = {}) {
  const p = enginePath();
  try {
    const r = await spawnHardened(p, args, { cwd: inputDir, timeoutMs, label });
    return { ...r, outDir, workDir };
  } catch (e) {
    return { code: 1, stdout: '', stderr: String(e.message || e), outDir, workDir, killed: false };
  }
}

async function cleanup(workDir) {
  try { await fsp.rm(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export async function walkDir(root) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...(await walkDir(p)));
    else {
      try {
        const st = await fsp.stat(p);
        out.push({ name: e.name, path: p, size: st.size });
      } catch { /* vanished */ }
    }
  }
  return out;
}

/** Filter engine output down to real recovered code files (no reports). */
export function pickCodeFiles(files) {
  return files
    .filter((f) => f.size > 0 && f.size <= MAX_CODE_BYTES)
    .filter((f) => CODE_EXT.has(path.extname(f.name).toLowerCase()))
    .filter((f) => !REPORT_BASENAMES.test(f.name))
    .sort((a, b) => b.size - a.size);
}

/**
 * Stage A — targeted Lua peel for a known engine family.
 * Returns { ok, files, exitCode, stderr }.
 */
export async function luaPeel(inputPath, family) {
  return withSlot(async () => {
    const dirs = freshDirs();
    const outFile = path.join(dirs.outDir, 'recovered.lua');
    const args = ['lua', 'deobfuscate', inputPath, '--family', family, '--out', outFile,
      '--i-have-authorization', '--force', '--json', '--quiet', '--progress', 'never'];
    const r = await runEngine(args, { ...dirs, label: `lua peel ${family}` });
    let files = [];
    try {
      const st = await fsp.stat(outFile).catch(() => null);
      if (st && st.size > 0) files = [{ name: path.basename(outFile), path: outFile, size: st.size }];
    } catch { /* ignore */ }
    const ok = r.code === 0 && files.length > 0;
    const result = { ok, files, exitCode: r.code, stderr: r.stderr.slice(0, 500), workDir: r.workDir };
    // Only reap on miss — on hit the pipeline still needs to read the files.
    if (!ok) await cleanup(r.workDir);
    return result;
  });
}

/**
 * Stage B — generic auto pipeline (handles Lua VMs, JS, Python, UPX/packers,
 * PyInstaller, and protector chains stacked on top).
 */
export async function autoRun(inputPath, { maxDepth = 6 } = {}) {
  return withSlot(async () => {
    const dirs = freshDirs();
    // IMPORTANT: -o must be the ABSOLUTE out dir — relative paths land in cwd.
    const args = ['auto', inputPath, '-o', dirs.outDir, '--max-depth', String(maxDepth),
      '--capture-stages', '--json', '--quiet', '--progress', 'never'];
    const r = await runEngine(args, { ...dirs, label: 'auto', timeoutMs: CONFIG.engineTimeoutMs });
    const all = await walkDir(r.outDir);
    const files = pickCodeFiles(all);
    return { ok: r.code === 0 && files.length > 0, files, all, exitCode: r.code, stderr: r.stderr.slice(0, 500), workDir: r.workDir };
  });
}

/**
 * pyArmor unpack — v6/v7 dynamic-hook + v8/v9-pro static → reconstructed .pyc.
 * Note: the pyarmor_runtime_* sibling directory must ship with the input for
 * v8/v9 builds (users should upload the whole obfuscator output as a zip).
 */
export async function pyarmorUnpack(inputPath) {
  return withSlot(async () => {
    const dirs = freshDirs();
    const args = ['pyarmor', 'unpack', inputPath, '-o', dirs.outDir, '--force', '--quiet'];
    const r = await runEngine(args, { ...dirs, label: 'pyarmor unpack' });
    const all = await walkDir(r.outDir);
    const files = pickCodeFiles(all);
    const ok = files.length > 0;
    const result = { ok, files, exitCode: r.code, stderr: r.stderr.slice(0, 500), workDir: r.workDir };
    // Only reap on miss — on hit the pipeline still needs to read the files.
    if (!ok) await cleanup(r.workDir);
    return result;
  });
}

/**
 * Decompile a reconstructed .pyc back toward readable Python source.
 * Returns { ok, files, workDir } — files may carry a `# decompile-error`
 * disasm-fallback body when full source recovery is refused (honest output).
 */
export async function pyDecompile(inputPath) {
  return withSlot(async () => {
    const dirs = freshDirs();
    const args = ['py', 'decompile', inputPath, '-o', dirs.outDir, '--force', '--quiet', '--progress', 'never'];
    const r = await runEngine(args, { ...dirs, label: 'py decompile' });
    const all = await walkDir(r.outDir);
    const files = all.filter((f) => f.name.toLowerCase().endsWith('.py') && f.size > 0 && f.size <= MAX_CODE_BYTES);
    const ok = files.length > 0;
    const result = { ok, files, exitCode: r.code, stderr: r.stderr.slice(0, 500), workDir: r.workDir };
    if (!ok) await cleanup(r.workDir);
    return result;
  });
}

/** Reap a workdir from a previous autoRun (call after consuming its files). */
export async function cleanupWorkDir(workDir) {
  if (workDir) await cleanup(workDir);
}

/** Read one output file into a Buffer (cap 8 MB). */
export async function readCodeFile(file) {
  const fh = await fsp.open(file.path, 'r');
  try {
    const len = Math.min(file.size, MAX_CODE_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally {
    await fh.close();
  }
}
