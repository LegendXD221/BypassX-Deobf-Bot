/**
 * .setstatus — OWNER ONLY. Change the bot's presence text.
 */
import { statusSetReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

export default {
  name: 'setstatus',
  description: '[owner] Change the bot presence text',
  usage: '.setstatus <text>',
  owner: true,
  slash: {
    options: [
      { name: 'text', description: 'What the bot should be "watching"', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const text = ctx.isSlash
      ? ctx.interaction.options.getString('text', true)
      : (ctx.args || []).join(' ');
    if (!text.trim()) return ctx.reply(errorReply('Missing text', 'Give me a presence text.'));
    try {
      ctx.client.user.setPresence({
        activities: [{ name: text.slice(0, 120), type: 3 }], // 3 = WATCHING
        status: 'online',
      });
      logger.info({ text: text.slice(0, 80) }, 'owner setstatus');
      return ctx.reply(statusSetReply(text.slice(0, 120)));
    } catch (e) {
      return ctx.reply(errorReply('Presence update failed', String(e?.message || e).slice(0, 300)));
    }
  },
};
