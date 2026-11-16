/**
 * .setprefix / /setprefix — OWNER ONLY. Per-server command prefix.
 *
 * Writes guild_settings.prefix (Neon DB, 8-char cap) — the dispatch loop in
 * src/index.js reads it live on every message, so the change lands instantly
 * with no restart. `reset` clears the override and falls back to the global
 * PREFIX ('.').
 */
import { setPrefixReply, errorReply } from '../replies.js';
import { setGuildSettings, guildPrefix, describe as dbDescribe } from '../db.js';
import { CONFIG } from '../config.js';
import { logger } from '../logger.js';

const RESET_WORDS = new Set(['reset', 'clear', 'default', 'off']);

export default {
  name: 'setprefix',
  description: '[owner] Set the command prefix for this server (default ".")',
  usage: '.setprefix <prefix | reset>',
  owner: true,
  slash: {
    options: [
      { name: 'prefix', description: 'New prefix (1-8 chars), or "reset" to restore the default "."', type: 'STRING', required: true },
    ],
  },

  async run(ctx) {
    const raw = ctx.isSlash
      ? ctx.interaction.options.getString('prefix', true)
      : (ctx.args || []).join(' ').trim();
    if (!raw) {
      return ctx.reply(errorReply('Missing prefix', `Give me a prefix (1-8 characters, e.g. \`${CONFIG.prefix}setprefix !\`) or \`${CONFIG.prefix}setprefix reset\`.`));
    }

    const guildId = ctx.interaction?.guildId || ctx.message?.guildId;
    if (!guildId) {
      return ctx.reply(errorReply('Server only', 'setprefix configures a per-server prefix — run it inside the server you want to change.'));
    }

    const d = dbDescribe();
    if (!d.enabled) {
      return ctx.reply(errorReply('Database offline', 'Per-server prefixes are stored in the database. Set DATABASE_URL and restart, then try again.'));
    }

    const oldPrefix = (await guildPrefix(guildId)) || CONFIG.prefix;

    // Reset → clear the override, back to the global default.
    if (RESET_WORDS.has(raw.toLowerCase())) {
      const ok = await setGuildSettings(guildId, { prefix: '' });
      if (!ok) return ctx.reply(errorReply('Write failed', 'The database rejected the update — check the logs.'));
      logger.info({ guildId, oldPrefix }, 'owner setprefix reset');
      return ctx.reply(setPrefixReply(oldPrefix, CONFIG.prefix, true));
    }

    const next = raw.trim();
    if (/\s/.test(next)) {
      return ctx.reply(errorReply('Invalid prefix', 'A prefix cannot contain spaces — it must be the first thing in a message.'));
    }
    if (next.length < 1 || next.length > 8) {
      return ctx.reply(errorReply('Invalid prefix', `Prefix must be 1-8 characters (got ${next.length}). Example: \`${CONFIG.prefix}setprefix !\``));
    }
    if (next === oldPrefix) {
      return ctx.reply(errorReply('Already set', `This server's prefix is already \`${next}\`. Use \`${CONFIG.prefix}setprefix reset\` to go back to \`${CONFIG.prefix}\`.`));
    }

    const ok = await setGuildSettings(guildId, { prefix: next });
    if (!ok) return ctx.reply(errorReply('Write failed', 'The database rejected the update — check the logs.'));
    logger.info({ guildId, prefix: next }, 'owner setprefix');
    return ctx.reply(setPrefixReply(oldPrefix, next, false));
  },
};
