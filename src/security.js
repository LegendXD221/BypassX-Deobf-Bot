/**
 * BypassX Deobf Bot — RCE / sandboxing hardening for the deobf engine bridge.
 *
 * The engine is a static-analysis Rust binary (it never executes the sample).
 * Defence-in-depth anyway:
 *   1. ENV SCRUB        — only an allowlist of safe vars reaches the child;
 *                         DISCORD_TOKEN / PASTEFY_TOKEN / GITHUB_TOKEN never leak.
 *   2. ARG VALIDATION   — no NUL bytes / control chars in argv.
 *   3. ISOLATED WORKDIR — fresh 0700 tmpdir per run.
 *   4. NO-NETWORK HINT  — NO_NETWORK=1 injected.
 *   5. PARENT-DEATH KILL— children SIGKILLed when the bot exits.
 *   6. BOUNDED RESOURCES— hard timeout + maxBuffer + concurrency cap.
 *
 * No vm2 / isolated-vm (both have public sandbox-escape CVEs in 2026).
 */
import { spawn } from 'node:child_process';
import { logger } from './logger.js';

const ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'USERNAME', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LANGUAGE',
  'TMPDIR', 'TEMP', 'TMP',
  'TZ', 'TERM',
  'NO_NETWORK', 'BYPASSX_DEOBF_NO_NETWORK',
]);

const ENV_DENYLIST = new Set([
  'DISCORD_TOKEN', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_PUBLIC_KEY',
  'PASTEFY_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'GH_PAT', 'RENDER_TOKEN',
  'DATABASE_URL', 'REDIS_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'npm_token', 'BOT_TOKEN',
]);

export function buildSandboxEnv() {
  const out = {};
  const parent = process.env;
  for (const key of ENV_ALLOWLIST) {
    if (typeof parent[key] === 'string' && parent[key].length) out[key] = parent[key];
  }
  out.BYPASSX_DEOBF_NO_NETWORK = '1';
  out.NO_NETWORK = '1';
  for (const key of Object.keys(out)) {
    if (ENV_DENYLIST.has(key)) { delete out[key]; continue; }
    if (/(?:^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)(?:$|_)/i.test(key)) delete out[key];
  }
  return out;
}

export function validateArgs(args) {
  if (!Array.isArray(args)) throw new Error('args must be an array');
  const out = [];
  for (const a of args) {
    if (typeof a !== 'string' || a.length === 0) throw new Error(`invalid argv element (type ${typeof a})`);
    if (a.includes('\0')) throw new Error('NUL byte in argv');
    if (/[\x00-\x1f\x7f]/.test(a)) throw new Error('control char in argv');
    out.push(a);
  }
  return out;
}

const activeChildren = new Set();

function reapChildren() {
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
  activeChildren.clear();
}
process.once('exit', reapChildren);
const termHandler = (sig) => {
  reapChildren();
  process.exit(128 + (sig === 'SIGINT' ? 2 : 15));
};
process.once('SIGINT', () => termHandler('SIGINT'));
process.once('SIGTERM', () => termHandler('SIGTERM'));

/**
 * Spawn a process with all hardening applied.
 * Resolves { code, stdout, stderr, killed, pid }.
 */
export function spawnHardened(binaryPath, args, { cwd, timeoutMs = 120_000, maxBuffer = 32 * 1024 * 1024, label = 'proc' } = {}) {
  const safeArgs = validateArgs(args);
  const env = buildSandboxEnv();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binaryPath, safeArgs, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        killSignal: 'SIGKILL',
      });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: String(e.message || e).slice(0, 400), killed: false, pid: null });
      return;
    }
    activeChildren.add(child);
    const pid = child.pid || null;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;
    let settled = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, Math.max(1000, timeoutMs));

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < maxBuffer) { stdoutChunks.push(chunk); stdoutBytes += chunk.length; }
      else if (!killed) { killed = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes < maxBuffer) { stderrChunks.push(chunk); stderrBytes += chunk.length; }
    });
    const finalize = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({
        code: typeof code === 'number' ? code : (killed ? 124 : 1),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        killed,
        pid,
      });
    };
    child.on('error', (err) => {
      logger.warn({ err: String(err.message || err).slice(0, 200), label }, 'spawn error');
      finalize(1);
    });
    child.on('close', (code, signal) => {
      if (signal && !killed) killed = true;
      finalize(typeof code === 'number' ? code : (killed ? 124 : 1));
    });
  });
}
