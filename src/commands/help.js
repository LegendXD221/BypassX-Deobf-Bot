/**
 * .help / /help — overview.
 */
import { helpEmbed } from '../replies.js';

export default {
  name: 'help',
  description: 'How to use BypassX Deobf',
  usage: '.help',
  slash: { options: [] },

  async run(ctx) {
    return ctx.reply({ embeds: [helpEmbed(ctx.prefix)] });
  },
};
