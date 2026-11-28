/**
 * .exec — OWNER, DANGEROUS (L1-L5). Run a shell command on the host (the
 * Render container). The shared runner (src/runners.js → runShell) also powers
 * the owner dashboard: bash, 90 s default timeout (`%% <seconds>` raises it,
 * 300 s max), 16 MB capture, long output auto-pasted. Protected by the 5
 * owner layers at dispatch.
 */
import { AttachmentBuilder } from 'discord.js';
import { runShell } from '../runners.js';
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';
import { redactSecrets } from '../redact.js';

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
    const { ok, output: rawOutput, ms, exit, timeoutCap } = await runShell(cmd);
    const output = redactSecrets(rawOutput);
    logger.info({ ms }, 'owner exec done');

    const meta = [`${ms}ms`, `exit ${exit}`, `${timeoutCap}s cap`];
    if (output.length > 1500) {
      // Never upload host shell output to public Pastefy — keep inside ephemeral Discord attachment.
      const reply = ownerOutputReply({
        title: 'exec', ok, input: cmd,
        output: `${output.slice(0, 1500)}\n… (${output.length - 1500} more chars attached)`,
        meta: [...meta, 'redacted & private attachment'],
      });
      reply.files = [new AttachmentBuilder(Buffer.from(output.slice(0, 4 * 1024 * 1024), 'utf8'), { name: 'exec-output.txt' })];
      return ctx.reply(reply);
    }
    return ctx.reply(ownerOutputReply({ title: 'exec', ok, input: cmd, output, meta }));
  },
};
