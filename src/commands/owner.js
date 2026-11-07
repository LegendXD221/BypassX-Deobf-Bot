/**
 * .owner — OWNER. The owner control panel: every owner command, the 5
 * protection layers with live status, and the recent audit trail.
 */
import {
  ownerPanelReply, ownerOutputReply, errorReply,
} from '../replies.js';
import * as db from '../db.js';
import { pinRequired, dangerStatus } from '../owner-guard.js';

export default {
  name: 'owner',
  description: '[owner] Control panel — owner commands, protection layers, audit',
  usage: '.owner [audit]',
  owner: true,
  slash: {
    options: [
      { name: 'section', description: '"audit" for the audit trail, blank for the panel', type: 'STRING', required: false },
    ],
  },

  async run(ctx) {
    const section = ctx.isSlash
      ? (ctx.interaction.options.getString('section') || '')
      : (ctx.args?.[0] || '');

    if (section.toLowerCase() === 'audit') {
      if (!db.describe().enabled) return ctx.reply(errorReply('Database offline', 'The audit trail lives in the Neon database. Set DATABASE_URL first.'));
      const rows = await db.auditTail(15);
      const lines = rows.map((r) => {
        const at = r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(5, 16) : '?';
        return `${r.allowed ? '✅' : '🚨'} \`${at}\` **${r.command}** — <@${r.user_id}>${r.layer ? ` • layer: ${r.layer}` : ''}${r.result ? ` • ${String(r.result).slice(0, 60)}` : ''}`;
      });
      return ctx.reply(ownerOutputReply({
        title: 'audit trail', ok: true,
        output: lines.join('\n') || '(no audit entries yet)',
        meta: ['last 15 events', 'newest last'],
      }));
    }

    return ctx.reply(ownerPanelReply(ctx.prefix, {
      pinSet: pinRequired(),
      db: db.describe(),
      danger: dangerStatus(),
    }));
  },
};
