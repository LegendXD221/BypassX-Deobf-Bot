/**
 * .activity — OWNER. Change the bot presence.
 *   .activity playing|listening|watching|competing <text>
 *   .activity clear
 */
import { ownerOutputReply, errorReply } from '../replies.js';

const TYPES = { playing: 0, streaming: 1, listening: 2, watching: 3, competing: 5 };

export default {
  name: 'activity',
  description: '[owner] Change the bot presence',
  usage: '.activity <playing|listening|watching|competing|clear> [text]',
  owner: true,
  slash: {
    options: [
      { name: 'type', description: 'playing / listening / watching / competing / clear', type: 'STRING', required: true },
      { name: 'text', description: 'Activity text (not needed for clear)', type: 'STRING', required: false },
    ],
  },

  async run(ctx) {
    let type = '';
    let text = '';
    if (ctx.isSlash) {
      type = ctx.interaction.options.getString('type', true).toLowerCase();
      text = ctx.interaction.options.getString('text') || '';
    } else {
      const args = ctx.args || [];
      type = (args.shift() || '').toLowerCase();
      text = args.join(' ');
    }

    if (type === 'clear') {
      ctx.client.user.setPresence({ activities: [], status: 'online' });
      return ctx.reply(ownerOutputReply({ title: 'presence cleared', ok: true, output: 'Activity removed.', meta: ['presence'] }));
    }
    if (!(type in TYPES)) {
      return ctx.reply(errorReply('Unknown activity type', 'Use `playing`, `listening`, `watching`, `competing` or `clear`.'));
    }
    if (!text.trim()) return ctx.reply(errorReply('Missing text', `e.g. \`.activity ${type} .deobf | /deobf\``));

    // type 1 (streaming) needs a twitch/youtube url — downgrade to watching otherwise
    let activityType = TYPES[type];
    if (activityType === 1) activityType = 3;
    ctx.client.user.setPresence({ activities: [{ name: text.slice(0, 120), type: activityType }], status: 'online' });
    return ctx.reply(ownerOutputReply({
      title: 'presence updated', ok: true,
      output: `**${type}** ${text.slice(0, 120)}`,
      meta: ['presence'],
    }));
  },
};
