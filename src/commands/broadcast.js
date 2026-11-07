/**
 * .broadcast — OWNER, DANGEROUS (L1-L5). Send a message to every server the
 * bot is in via the shared runner (src/runners.js → broadcastAll): system
 * channel or first sendable text channel, 250 ms pace, blacklisted guilds
 * skipped. Confirmation card shows the exact text.
 */
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';
import * as db from '../db.js';
import { broadcastAll } from '../runners.js';

export default {
  name: 'broadcast',
  description: '[owner] Message every server (dangerous — confirmation required)',
  usage: '.broadcast <message>',
  owner: true,
  danger: true,
  slash: {
    options: [
      { name: 'message', description: 'Text to broadcast', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const text = ctx.isSlash
      ? ctx.interaction.options.getString('message', true)
      : (ctx.args || []).join(' ');
    if (!text.trim()) return ctx.reply(errorReply('Missing message', 'Give me something to broadcast.'));
    if (text.length > 1500) return ctx.reply(errorReply('Too long', 'Keep broadcasts under 1500 characters.'));

    await ctx.defer();
    const r = await broadcastAll(ctx.client, text, { isBlacklisted: (id) => db.blacklistHas(id) });
    logger.warn(r, 'owner broadcast');
    return ctx.reply(ownerOutputReply({
      title: 'broadcast complete', ok: true,
      input: text,
      output: `Delivered to **${r.sent}** server(s). Failed/unreachable: ${r.failed}. Skipped (blacklisted): ${r.skipped}.`,
      meta: [`${r.total} guild(s) scanned`, '250ms pace'],
    }));
  },
};
