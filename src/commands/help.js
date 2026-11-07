/**
 * .help / /help — overview.
 */
import { helpReply } from '../replies.js';

export default {
  name: 'help',
  description: 'How to use BypassX Deobf',
  usage: '.help',
  slash: { options: [] },

  async run(ctx) {
    return ctx.reply(helpReply(ctx.prefix, ctx.client));
  },
};
