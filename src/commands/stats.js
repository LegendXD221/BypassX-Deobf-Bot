/**
 * .stats / /stats — live bot statistics (public).
 */
import { CONFIG } from '../config.js';
import { statsReply } from '../replies.js';
import { jobStats } from '../keepalive.js';
import { probe as probeEngine } from '../engine.js';
import { describe as dbDescribe, allTimeCounts } from '../db.js';

export default {
  name: 'stats',
  description: 'Bot statistics: jobs, success rate, uptime, engine build',
  usage: '.stats',
  slash: { options: [] },

  async run(ctx) {
    await ctx.defer();
    const jobs = jobStats();
    const engine = await probeEngine();
    const mem = process.memoryUsage();
    const dbInfo = dbDescribe();
    const allTime = dbInfo.enabled ? await allTimeCounts() : null;
    return ctx.reply(statsReply({
      version: CONFIG.version,
      uptimeS: process.uptime(),
      engine,
      jobs,
      guilds: ctx.client?.guilds?.cache?.size,
      memoryMb: mem.rss / 1024 / 1024,
      discordReady: jobs.discordReady,
      pingMs: ctx.client?.ws?.ping ?? 0,
      owner: CONFIG.ownerId,
      dbInfo,
      allTime,
    }));
  },
};
