/**
 * .eval — OWNER, DANGEROUS (L1-L5). Evaluate JavaScript in a jailed sandbox
 * that runs in a DISPOSABLE CHILD PROCESS with zero secrets. The heavy lifting
 * lives in src/runners.js (runJailedEval) + bin/eval-harness.cjs — the same
 * runner also powers the owner dashboard, so there is exactly one jail.
 *
 * Anti-RCE design (the point of this command is to be unexploitable):
 *   1. vm.runInContext with an EMPTY host-object-free sandbox — no
 *      require/process/fetch/fs/network and no host functions to climb
 *      constructor chains from.
 *   2. Even if the vm is escaped (node:vm is not a hardened boundary), the
 *      escape only reaches a fresh child process spawned via spawnHardened:
 *      env scrubbed of every secret, isolated 0700 tmpdir, no-network env,
 *      hard 12 s SIGKILL timeout, 1 MB output cap, killed on bot exit.
 *   3. Sync-only code inside the vm (5 s instruction timeout).
 */
import { runJailedEval } from '../runners.js';
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

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
    const { ok, output, ms } = await runJailedEval(code);
    logger.info({ ms, ok }, 'owner eval');
    return ctx.reply(ownerOutputReply({
      title: 'eval', ok, input: code, output,
      meta: [`${ms}ms`, 'jailed vm in secret-free child', 'no require/process/network', '12s hard kill'],
    }));
  },
};
