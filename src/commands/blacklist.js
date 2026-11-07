/**
 * .blacklist — OWNER. Manage the global user/guild blacklist (stored in Neon).
 *   .blacklist add <id> [reason]   — block a user or guild everywhere
 *   .blacklist remove <id>         — unblock
 *   .blacklist list                — show entries
 * Enforced at dispatch for every public command (owner always bypasses).
 */
import { ownerOutputReply, errorReply } from '../replies.js';
import { logger } from '../logger.js';
import * as db from '../db.js';

export default {
  name: 'blacklist',
  description: '[owner] Global blacklist for abusive users/servers',
  usage: '.blacklist add|remove|list <id> [reason]',
  owner: true,
  slash: {
    options: [
      { name: 'action', description: 'add / remove / list', type: 'STRING', required: true, },
      { name: 'id', description: 'User or guild id (not needed for list)', type: 'STRING', required: false },
      { name: 'reason', description: 'Why (for add)', type: 'STRING', required: false },
    ],
  },

  async run(ctx) {
    let action = '';
    let id = '';
    let reason = '';
    if (ctx.isSlash) {
      action = ctx.interaction.options.getString('action', true).toLowerCase();
      id = ctx.interaction.options.getString('id') || '';
      reason = ctx.interaction.options.getString('reason') || '';
    } else {
      const args = ctx.args || [];
      action = (args.shift() || '').toLowerCase();
      id = args.shift() || '';
      reason = args.join(' ');
    }

    if (!db.describe().enabled) {
      return ctx.reply(errorReply('Database offline', 'The blacklist lives in the Neon database. Set DATABASE_URL first.'));
    }

    if (action === 'list') {
      const rows = await db.blacklistList();
      const lines = rows.map((r) => `• \`${r.target}\` — ${r.kind}${r.reason ? ` — ${String(r.reason).slice(0, 80)}` : ''} (by ${r.added_by || '?'})`);
      return ctx.reply(ownerOutputReply({
        title: 'blacklist', ok: true,
        output: lines.join('\n') || '(empty — nobody is blocked)',
        meta: [`${rows.length} entr(ies)`],
      }));
    }

    if (action === 'add') {
      if (!/^\d{5,25}$/.test(id)) return ctx.reply(errorReply('Invalid id', 'Pass the numeric user or guild id.'));
      const kind = ctx.client?.guilds?.cache?.has(id) ? 'guild' : 'user';
      const ok = await db.blacklistAdd(id, kind, reason || 'no reason given', ctx.userId);
      logger.warn({ target: id, kind }, 'owner blacklist add');
      return ctx.reply(ownerOutputReply({
        title: ok ? 'blacklisted' : 'blacklist failed', ok,
        output: ok ? `\`${id}\` (${kind}) is now blocked from using the bot everywhere.\nReason: ${reason || 'no reason given'}` : 'DB write failed — see logs.',
      }));
    }

    if (action === 'remove') {
      if (!/^\d{5,25}$/.test(id)) return ctx.reply(errorReply('Invalid id', 'Pass the numeric user or guild id.'));
      const ok = await db.blacklistRemove(id);
      return ctx.reply(ownerOutputReply({
        title: ok ? 'removed' : 'not found', ok,
        output: ok ? `\`${id}\` can use the bot again.` : `\`${id}\` was not on the blacklist.`,
      }));
    }

    return ctx.reply(errorReply('Unknown action', 'Use `add <id> [reason]`, `remove <id>` or `list`.'));
  },
};
