/**
 * .servers — OWNER ONLY. List guilds the bot is in.
 */
import { ownerOutputReply } from '../replies.js';

export default {
  name: 'servers',
  description: '[owner] List the servers the bot is in',
  usage: '.servers',
  owner: true,
  slash: { options: [] },

  async run(ctx) {
    const guilds = [...(ctx.client?.guilds?.cache?.values() || [])]
      .map((g) => ({ name: g.name, id: g.id, memberCount: g.memberCount }))
      .sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
    const output = guilds.length
      ? guilds.map((g) => `${g.name} — ${g.memberCount ?? '?'} members — ${g.id}`).join('\n')
      : '(not in any guild)';
    return ctx.reply(ownerOutputReply({
      title: `servers (${guilds.length})`,
      ok: true,
      output,
      meta: ['sorted by size'],
    }));
  },
};
