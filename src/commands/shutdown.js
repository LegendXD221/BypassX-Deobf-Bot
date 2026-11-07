/**
 * .shutdown — OWNER ONLY. Graceful stop; Render restarts the service.
 */
import { ContainerBuilder, TextDisplayBuilder, MessageFlags } from 'discord.js';
import { errorReply } from '../replies.js';
import { logger } from '../logger.js';

export default {
  name: 'shutdown',
  description: '[owner] Gracefully stop the bot (Render restarts it)',
  usage: '.shutdown',
  owner: true,
  slash: { options: [] },

  async run(ctx) {
    logger.warn({}, 'owner shutdown requested');
    try {
      await ctx.reply({
        components: [new ContainerBuilder()
          .setAccentColor(0xf59e0b)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## 🛑 Shutting down\n-# Render will restart the service automatically'),
          )],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch { /* reply failed — still shut down */ }
    setTimeout(async () => {
      try { await ctx.client?.destroy(); } catch { /* already gone */ }
      process.exit(0);
    }, 1500);
  },
};
