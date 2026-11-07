/**
 * .invite / /invite — add the bot to your server.
 */
import { CONFIG } from '../config.js';
import { errorReply, inviteReply } from '../replies.js';
import { PermissionFlagsBits } from 'discord.js';

export default {
  name: 'invite',
  description: 'Get the invite link for BypassX Deobf',
  usage: '.invite',
  slash: { options: [] },

  async run(ctx) {
    if (!CONFIG.clientId) return ctx.reply(errorReply('Not configured', 'CLIENT_ID is not set on this deployment.'));
    const perms = PermissionFlagsBits.SendMessages
      | PermissionFlagsBits.AttachFiles
      | PermissionFlagsBits.EmbedLinks
      | PermissionFlagsBits.ReadMessageHistory
      | PermissionFlagsBits.UseExternalEmojis;
    const url = `https://discord.com/oauth2/authorize?client_id=${CONFIG.clientId}&permissions=${perms}&scope=bot%20applications.commands`;
    return ctx.reply(inviteReply(url));
  },
};
