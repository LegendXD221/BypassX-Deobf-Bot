/**
 * .exec — OWNER, DANGEROUS (L1-L5). Run a shell command on the host (the
 * Render container). The shared runner (src/runners.js → runShell) also powers
 * the owner dashboard: bash, 90 s default timeout (`%% <seconds>` raises it,
 * 300 s max), 16 MB capture, long output auto-pasted. Protected by the 5
 * owner layers at dispatch.
 */
import { createPaste } from '../pastefy.js';
import { runShell } from '../runners.js';
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

export default {
  name: 'exec',
  description: '[owner] Run a shell command on the host (dangerous — confirmation required)',
  usage: '.exec <command>',
  owner: true,
  danger: true,
  slash: {
    options: [
      { name: 'command', description: 'Shell command to run (bash, 90s timeout)', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const cmd = ctx.isSlash
      ? ctx.interaction.options.getString('command', true)
      : (ctx.args || []).join(' ');
    if (!cmd.trim()) return ctx.reply(errorReply('Missing command', 'Give me a shell command.'));

    await ctx.defer();
    const { ok, output, ms, exit, timeoutCap } = await runShell(cmd);
    logger.info({ ms }, 'owner exec done');

    const meta = [`${ms}ms`, `exit ${exit}`, `${timeoutCap}s cap`];
    if (output.length > 1500) {
      let paste = null;
      try {
        paste = await createPaste({ title: `BypassX Deobf — exec output (${ms}ms)`, text: output });
      } catch { /* file attachment still carries it */ }
      return ctx.reply(ownerOutputReply({
        title: 'exec', ok, input: cmd,
        output: `${output.slice(0, 1500)}\n… (${output.length - 1500} more chars)`,
        meta: [...meta, paste ? `full output: ${paste.url}` : 'full output attached'],
      }));
    }
    return ctx.reply(ownerOutputReply({ title: 'exec', ok, input: cmd, output, meta }));
  },
};
