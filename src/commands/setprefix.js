/**
 * .setprefix — OWNER ONLY. Set the per-server prefix for prefix commands.
 * No argument → reset to the global default (CONFIG.prefix).
 * Per-guild override wins over the global for that server (index.js dispatch).
 */
import { CONFIG } from '../config.js';
import * as db from '../db.js';
import { logger } from '../logger.js';

function card(title, body) {
  return `**${title}**\n${body}`;
}

export default {
  name: 'setprefix',
  description: '[owner] Set the per-server prefix',
  usage: '.setprefix <prefix> | .setprefix reset',
  owner: true,
  slash: {
    options: [
      { name: 'prefix', description: 'New prefix (omit or "reset" to restore the global default)', type: 'STRING', required: false },
    ],
  },

  async run(ctx) {
    const raw = ctx.isSlash
      ? (ctx.interaction.options.getString('prefix') || '')
      : (ctx.args || []).join(' ');
    const arg = String(raw || '').trim();

    if (!ctx.guildId) {
      return ctx.reply(card('setprefix — server only', 'Run this inside a server; per-server prefixes do not apply to DMs.'));
    }

    const resetting = !arg || /^(reset|default|clear)$/i.test(arg);
    if (!resetting && arg.length > 8) {
      return ctx.reply(card('setprefix — too long', 'Prefixes are capped at 8 characters. Example: `.setprefix b!`'));
    }

    const next = resetting ? null : arg;
    const ok = await db.setGuildSettings(ctx.guildId, { prefix: next });
    if (!ok) {
      return ctx.reply(card('setprefix — database unavailable', 'The guild settings store is not reachable right now; the prefix was not changed.'));
    }

    const shown = resetting ? CONFIG.prefix : next;
    logger.info({ guildId: ctx.guildId, prefix: shown, reset: resetting }, 'owner setprefix');
    return ctx.reply(card(
      resetting ? 'Prefix reset' : 'Prefix updated',
      `Prefix commands in this server now use \`${shown}\`${resetting ? ' (global default)' : ''}.`,
    ));
  },
};
