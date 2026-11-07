/**
 * BypassX Deobf Bot — shared owner-power runners (Discord commands + dashboard).
 * Every runner is single-purpose, bounded, and audit-friendly.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { spawnHardened } from './security.js';
import { ensureVarDir } from './config.js';
import { logger } from './logger.js';

// bin/ lives at the repo ROOT (next to package.json), not under src/.
const harnessPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'eval-harness.cjs');

/**
 * Jailed eval — see bin/eval-harness.cjs + commands/eval.js for the full
 * anti-RCE design (empty-host-object vm inside a secret-free child).
 * Resolves { ok, output, ms }.
 */
export async function runJailedEval(code) {
  const t0 = Date.now();
  const tmp = ensureVarDir('eval');
  const codeFile = path.join(tmp, `in-${process.pid}-${t0}.json`);
  try {
    fs.writeFileSync(codeFile, JSON.stringify({ code: String(code || '') }), { mode: 0o600 });
    const child = await spawnHardened(
      process.execPath,
      [harnessPath, codeFile],
      { cwd: tmp, timeoutMs: 12_000, maxBuffer: 1024 * 1024, label: 'eval' },
    );
    let parsed = null;
    try { parsed = JSON.parse(child.stdout || '{}'); } catch { parsed = null; }
    const ms = Date.now() - t0;
    if (parsed && parsed.ok) {
      const logs = (parsed.logs || []).slice(0, 12).join('\n');
      return { ok: true, output: `${logs ? `${logs}\n` : ''}=> ${String(parsed.result || 'undefined').slice(0, 1200)}`, ms };
    }
    if (parsed && parsed.error) {
      return { ok: false, output: `✗ ${String(parsed.error).slice(0, 800)}`, ms };
    }
    return { ok: false, output: `✗ sandbox child failed (exit ${child.code}${child.killed ? ', killed' : ''})\n${(child.stderr || '').slice(0, 400) || '(no stderr)'}`, ms };
  } catch (e) {
    return { ok: false, output: `✗ ${String(e?.message || e).slice(0, 400)}`, ms: Date.now() - t0 };
  } finally {
    try { fs.rmSync(codeFile, { force: true }); } catch { /* tmp */ }
  }
}

/**
 * Host shell — bash, bounded timeout (default 90 s, max 300 s), 16 MB capture.
 * Accepts the Discord command's `%% <seconds>` tail too. Resolves
 * { ok, output, ms, exit, timeoutCap }.
 */
export function runShell(rawCmd, defaultTimeoutMs = 90_000) {
  const cmd = String(rawCmd || '').trim();
  let timeoutMs = defaultTimeoutMs;
  const m = cmd.match(/\s%%\s*(\d{1,3})\s*$/);
  if (m) timeoutMs = Math.min(300_000, Number(m[1]) * 1000);
  const clean = cmd.replace(/\s%%\s*\d{1,3}\s*$/, '');
  return new Promise((resolve) => {
    const t0 = Date.now();
    execCb(clean, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, cwd: process.cwd(), shell: '/bin/bash' }, (err, stdout, stderr) => {
      const ms = Date.now() - t0;
      let output = String(stdout || '');
      if (String(stderr || '').trim()) output += (output ? '\n' : '') + `[stderr]\n${stderr}`;
      if (err && err.killed) output += (output ? '\n' : '') + `[killed at ${timeoutMs / 1000}s timeout]`;
      else if (err) output += (output ? '\n' : '') + `[exit ${err.code ?? '?'}] ${String(err.message).split('\n')[0]}`;
      output = output.trim() || '(no output)';
      logger.info({ ms, cmd: clean.slice(0, 80) }, 'owner shell');
      resolve({ ok: !err, output, ms, exit: err ? (err.code ?? 'sig') : 0, timeoutCap: timeoutMs / 1000 });
    });
  });
}

/**
 * Broadcast to every guild (system channel, else first sendable text channel).
 * Skips blacklisted guilds. Resolves { sent, failed, skipped, total }.
 */
export async function broadcastAll(client, text, { isBlacklisted = null } = {}) {
  const guilds = [...(client?.guilds?.cache?.values() || [])].slice(0, 200);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const g of guilds) {
    try {
      if (isBlacklisted && await isBlacklisted(g.id)) { skipped += 1; continue; }
      const me = g.members.me;
      const ch = g.systemChannel && g.systemChannel.viewable && g.systemChannel.permissionsFor(me)?.has(['SendMessages', 'ViewChannel'])
        ? g.systemChannel
        : g.channels.cache.find((c) => c.isTextBased() && c.viewable && c.permissionsFor(me)?.has(['SendMessages', 'ViewChannel']));
      if (!ch) { failed += 1; continue; }
      await ch.send({ content: `📣 **BypassX Deobf** — ${text}` });
      sent += 1;
      await new Promise((r) => setTimeout(r, 250)); // gentle pace (rate limits)
    } catch {
      failed += 1;
    }
  }
  return { sent, failed, skipped, total: guilds.length };
}
