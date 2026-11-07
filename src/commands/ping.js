/**
 * .ping / /ping — latency + status.
 */
import { probe as probeEngine } from '../engine.js';
import { pongReply } from '../replies.js';
import { CONFIG } from '../config.js';

export default {
  name: 'ping',
  description: 'Bot latency and engine status',
  usage: '.ping',
  slash: { options: [] },

  async run(ctx) {
    const ws = ctx.client?.ws?.ping ?? 0;
    const engine = await probeEngine();
    return ctx.reply(pongReply({
      wsPing: ws,
      uptimeS: process.uptime(),
      engine,
      version: CONFIG.version,
      guilds: ctx.client?.guilds?.cache?.size,
    }));
  },
};
