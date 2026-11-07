/**
 * .restart — OWNER, DANGEROUS (L1-L5). Graceful restart: destroy the client
 * and exit; Render restarts the service automatically.
 */
import { CONFIG } from '../config.js';
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

export default {
  name: 'restart',
  description: '[owner] Restart the bot (dangerous — confirmation required)',
  usage: '.restart',
  owner: true,
  danger: true,
  slash: { options: [] },

  async run(ctx) {
    logger.warn({}, 'owner restart: destroying client + exiting');
    try {
      await ctx.reply(ownerOutputReply({
        title: 'restarting', ok: true,
        output: 'Destroying the Discord client and exiting — Render will boot a fresh process in seconds.',
        meta: [`v${CONFIG.version}`, 'exit(0) → auto-restart'],
      }));
    } catch { /* still restart */ }
    setTimeout(async () => {
      try { await ctx.client?.destroy(); } catch { /* already gone */ }
      process.exit(0);
    }, 800);
  },
};
