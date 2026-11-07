/**
 * .history — public. Your last deobfuscation jobs (requires the Neon database;
 * degrades to a friendly note when DATABASE_URL is not configured).
 */
import { historyReply } from '../replies.js';

export default {
  name: 'history',
  description: 'Your last deobfuscation jobs',
  usage: '.history',
  slash: { options: [] },

  async run(ctx) {
    return ctx.reply(await historyReply(ctx.userId));
  },
};
