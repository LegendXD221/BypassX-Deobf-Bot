/**
 * BypassX Deobf Bot — dynamic constant harvest bridge.
 *
 * Runs harvester-worker.js (jailed fengari Lua VM) through spawnHardened and
 * parses its single JSON result line. Used as the fallback tier when the
 * static engine hits an anti-tamper/escrow wall (MoonSec escrow builds,
 * Luraph v15.x payloads, …): the VM's init-time string decryption is captured
 * without executing anything outside the jail.
 */
import { spawnHardened } from './security.js';
import { logger } from './logger.js';

const workerPath = new URL('./harvester-worker.js', import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * @returns {Promise<{ok:boolean, ran?:boolean, strings?:string[], log?:string[],
 *   runError?:string, error?:string}>}
 */
export async function harvestConstants(inputPath, { timeoutMs = 120_000 } = {}) {
  const r = await spawnHardened(process.execPath, [workerPath, inputPath], {
    timeoutMs,
    label: 'harvest',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.code !== 0 && !r.stdout.trim()) {
    return { ok: false, error: `harvest worker exit ${r.code}${r.killed ? ' (timeout)' : ''}` };
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return { ok: false, error: 'harvest worker produced no result' };
  try {
    const data = JSON.parse(line);
    if (!data.ok) return { ok: false, error: data.error || 'harvest failed' };
    return { ok: true, ran: data.ran, strings: data.strings || [], log: data.log || [], runError: data.runError };
  } catch (e) {
    logger.warn({ err: String(e.message || e).slice(0, 150) }, 'harvest: bad worker output');
    return { ok: false, error: 'harvest output parse failed' };
  }
}

/** Build the recovered-constants Lua file from a harvest result. */
export function harvestToLua(h, { detectedName, version } = {}) {
  const header = [
    '-- BypassX Deobf Bot — dynamic constant recovery',
    `-- Detected: ${detectedName || 'unknown'}${version ? ` ${version}` : ''} (escrow/anti-tamper build)`,
    '-- Method: jailed in-memory VM run (no host, no network); decrypted string',
    '-- constants captured from the VM constant pool during init.',
    `-- Recovered ${h.strings.length} strings.`,
    '',
    'local STRINGS = {',
  ];
  const esc = (s) => s
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
    .replace(/\0/g, '\\0');
  const body = h.strings.map((s, i) => `  [${i + 1}] = "${esc(s)}",`).join('\n');
  return `${header.join('\n')}\n${body}\n}\n\nreturn STRINGS\n`;
}
