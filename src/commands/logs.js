/**
 * .logs — OWNER ONLY. Tail the in-process log ring buffer.
 */
import { recentLogs } from '../logger.js';
import { logsReply } from '../replies.js';

export default {
  name: 'logs',
  description: '[owner] Show recent log lines',
  usage: '.logs [count=30]',
  owner: true,
  slash: {
    options: [
      { name: 'count', description: 'How many lines (default 30, max 120)', type: 'INTEGER', required: false },
    ],
  },

  async run(ctx) {
    let n = 30;
    if (ctx.isSlash) {
      n = ctx.interaction.options.getInteger('count') ?? 30;
    } else {
      const parsed = Number.parseInt((ctx.args || [])[0] ?? '', 10);
      if (Number.isFinite(parsed)) n = parsed;
    }
    return ctx.reply(logsReply(recentLogs(n)));
  },
};
