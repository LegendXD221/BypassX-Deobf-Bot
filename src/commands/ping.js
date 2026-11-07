/**
 * .ping / /ping — latency check.
 */
export default {
  name: 'ping',
  description: 'Bot latency',
  usage: '.ping',
  slash: { options: [] },

  async run(ctx) {
    const ws = ctx.client?.ws?.ping ?? 0;
    const text = `🏓 Pong! Gateway ${Math.round(ws)}ms${ctx.isSlash ? '' : ''}`;
    return ctx.reply({ content: text, embeds: [] });
  },
};
