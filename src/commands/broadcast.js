/**
 * .broadcast — OWNER, DANGEROUS (L1-L5). Send a message to every server the
 * bot is in (system channel, else first sendable text channel). Skips
 * blacklisted guilds. Confirmation card shows the exact text + target count.
 */
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';
import * as db from '../db.js';

const MAX_GUILDS = 200;

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
    const guilds = [...ctx.client.guilds.cache.values()].slice(0, MAX_GUILDS);
    let sent = 0;
    let skippedBlacklisted = 0;
    let failed = 0;
    for (const g of guilds) {
      try {
        if (await db.blacklistHas(g.id)) { skippedBlacklisted += 1; continue; }
        const ch = g.systemChannel && g.systemChannel.viewable && g.systemChannel.permissionsFor(g.members.me)?.has(['SendMessages', 'ViewChannel'])
          ? g.systemChannel
          : g.channels.cache.find((c) => c.isTextBased() && c.viewable && c.permissionsFor(g.members.me)?.has(['SendMessages', 'ViewChannel']));
        if (!ch) { failed += 1; continue; }
        await ch.send({ content: `📣 **BypassX Deobf** — ${text}` });
        sent += 1;
        await new Promise((r) => setTimeout(r, 250)); // gentle pace (rate limits)
      } catch {
        failed += 1;
      }
    }
    logger.warn({ sent, failed, skippedBlacklisted }, 'owner broadcast');
    return ctx.reply(ownerOutputReply({
      title: 'broadcast complete', ok: true,
      input: text,
      output: `Delivered to **${sent}** server(s). Failed/unreachable: ${failed}. Skipped (blacklisted): ${skippedBlacklisted}.`,
      meta: [`${guilds.length} guild(s) scanned`, '250ms pace'],
    }));
  },
};
