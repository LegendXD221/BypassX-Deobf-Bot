/**
 * .leave — OWNER ONLY. Leave a guild by id (defaults to the current guild).
 */
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';

export default {
  name: 'leave',
  description: '[owner] Leave a server by id',
  usage: '.leave <guildId> (defaults to this server)',
  owner: true,
  slash: {
    options: [
      { name: 'guild_id', description: 'Guild id to leave (blank = this server, prefix only)', type: 'STRING', required: false },
    ],
  },

  async run(ctx) {
    let id = ctx.isSlash
      ? (ctx.interaction.options.getString('guild_id') || '')
      : (ctx.args || [])[0] || '';
    if (!id && !ctx.isSlash && ctx.message?.guildId) id = ctx.message.guildId;
    if (!id) return ctx.reply(errorReply('Missing guild id', 'Pass the guild id (or use this inside the target server).'));

    try {
      const guild = await ctx.client.guilds.fetch(id);
      const name = guild.name;
      await guild.leave();
      logger.warn({ guild: id }, 'owner leave');
      return ctx.reply(ownerOutputReply({ title: 'left server', ok: true, output: `${name} (${id})`, meta: ['bot removed'] }));
    } catch (e) {
      return ctx.reply(ownerOutputReply({ title: 'leave failed', ok: false, input: id, output: String(e?.message || e).slice(0, 300) }));
    }
  },
};
