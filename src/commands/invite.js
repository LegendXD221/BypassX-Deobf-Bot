/**
 * .invite / /invite — add the bot to your server.
 */
import { CONFIG } from '../config.js';
import { errorEmbed } from '../replies.js';
import { PermissionFlagsBits } from 'discord.js';

export default {
  name: 'invite',
  description: 'Get the invite link for BypassX Deobf',
  usage: '.invite',
  slash: { options: [] },

  async run(ctx) {
    if (!CONFIG.clientId) return ctx.reply({ embeds: [errorEmbed('Not configured', 'CLIENT_ID is not set on this deployment.')] });
    const url = `https://discord.com/oauth2/authorize?client_id=${CONFIG.clientId}&permissions=${PermissionFlagsBits.SendMessages | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.UseExternalEmojis}&scope=bot%20applications.commands`;
    return ctx.reply({ content: `➕ Add me to your server:\n${url}` });
  },
};
