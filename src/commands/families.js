/**
 * .families / /families — supported services table.
 */
import { familiesReply } from '../replies.js';

export default {
  name: 'families',
  description: 'List every supported obfuscator/packer with version ranges and recovery tiers',
  usage: '.families',
  slash: { options: [] },

  async run(ctx) {
    return ctx.reply(familiesReply(ctx.prefix));
  },
};
