/**
 * .dm — OWNER, DANGEROUS (L1-L5). Direct-message any user by id.
 */
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

export default {
  name: 'dm',
  description: '[owner] DM a user by id (dangerous — confirmation required)',
  usage: '.dm <userId> <text>',
  owner: true,
  danger: true,
  slash: {
    options: [
      { name: 'user_id', description: 'Discord user id to DM', type: 'STRING', required: true },
      { name: 'text', description: 'Message to send', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    let userId = '';
    let text = '';
    if (ctx.isSlash) {
      userId = ctx.interaction.options.getString('user_id', true);
      text = ctx.interaction.options.getString('text', true);
    } else {
      const args = ctx.args || [];
      userId = args.shift() || '';
      text = args.join(' ');
    }
    if (!/^\d{5,25}$/.test(userId)) return ctx.reply(errorReply('Invalid user id', 'Pass a numeric Discord user id.'));
    if (!text.trim()) return ctx.reply(errorReply('Missing text', 'Give me a message to send.'));

    try {
      const user = await ctx.client.users.fetch(userId);
      await user.send(text.slice(0, 1900));
      logger.warn({ target: userId }, 'owner dm sent');
      return ctx.reply(ownerOutputReply({
        title: 'dm delivered', ok: true,
        output: `Sent to **${user.tag}** (${userId}).`,
        meta: ['direct message'],
      }));
    } catch (e) {
      return ctx.reply(ownerOutputReply({
        title: 'dm failed', ok: false, input: userId,
        output: String(e?.message || e).slice(0, 300),
        meta: ['DMs may be closed'],
      }));
    }
  },
};
