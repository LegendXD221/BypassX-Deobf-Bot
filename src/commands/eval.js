/**
 * .eval — OWNER, DANGEROUS (L1-L5). Evaluate JavaScript in a jailed sandbox
 * that runs in a DISPOSABLE CHILD PROCESS with zero secrets.
 *
 * Anti-RCE design (the point of this command is to be unexploitable):
 *   1. vm.runInNewContext with an EMPTY host-object-free sandbox — no
 *      require/process/fetch/fs/network and no host functions to climb
 *      constructor chains from.
 *   2. Even if the vm is escaped (node:vm is not a hardened boundary), the
 *      escape only reaches a fresh child process spawned via spawnHardened:
 *        - ENV SCRUBBED — DISCORD_TOKEN / PASTEFY_TOKEN / GITHUB_TOKEN /
 *          DATABASE_URL and every *_TOKEN/*_SECRET/*_KEY var are stripped
 *          before the child exists;
 *        - isolated 0700 tmpdir cwd, no-network env, hard 12 s SIGKILL
 *          timeout, 1 MB output cap, killed on bot exit;
 *      so an escape yields an attacker nothing but an empty sandbox.
 *   3. Sync-only code inside the vm (5 s instruction timeout) — no event
 *      loop access, no timers, no async primitives.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawnHardened } from '../security.js';
import { ensureVarDir } from '../config.js';
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

const harnessPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'eval-harness.cjs');

export default {
  name: 'eval',
  description: '[owner] Evaluate JavaScript in a jailed sandbox (dangerous — confirmation required)',
  usage: '.eval <code>',
  owner: true,
  danger: true,
  slash: {
    options: [
      { name: 'code', description: 'JavaScript to evaluate (sync, jailed sandbox)', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const code = ctx.isSlash
      ? ctx.interaction.options.getString('code', true)
      : (ctx.args || []).join(' ');
    if (!code.trim()) return ctx.reply(errorReply('Missing code', 'Give me something to evaluate.'));

    await ctx.defer();
    const t0 = Date.now();
    const tmp = ensureVarDir('eval');
    const stdinFile = path.join(tmp, `in-${process.pid}-${t0}.json`);

    let output = '';
    let ok = true;
    try {
      fs.writeFileSync(stdinFile, JSON.stringify({ code }), { mode: 0o600 });
      const child = await spawnHardened(
        process.execPath,
        [harnessPath, stdinFile],
        { cwd: tmp, timeoutMs: 12_000, maxBuffer: 1024 * 1024, label: 'eval' },
      );
      let parsed = null;
      try { parsed = JSON.parse(child.stdout || '{}'); } catch { parsed = null; }
      const ms = Date.now() - t0;
      if (parsed && parsed.ok) {
        const logs = (parsed.logs || []).slice(0, 12).join('\n');
        output = `${logs ? `${logs}\n` : ''}=> ${String(parsed.result || 'undefined').slice(0, 900)}`;
      } else if (parsed && parsed.error) {
        ok = false;
        output = `✗ ${String(parsed.error).slice(0, 600)}`;
      } else {
        ok = false;
        output = `✗ sandbox child failed (exit ${child.code}${child.killed ? ', killed' : ''})\n${(child.stderr || '').slice(0, 300) || '(no stderr)'}`;
      }
      logger.info({ ms, ok }, 'owner eval');
      return ctx.reply(ownerOutputReply({
        title: 'eval', ok, input: code, output,
        meta: [`${ms}ms`, 'jailed vm in secret-free child', 'no require/process/network', '12s hard kill'],
      }));
    } catch (e) {
      ok = false;
      return ctx.reply(ownerOutputReply({
        title: 'eval failed', ok: false, input: code,
        output: String(e?.message || e).slice(0, 400),
      }));
    } finally {
      try { fs.rmSync(stdinFile, { force: true }); } catch { /* tmp */ }
    }
  },
};
