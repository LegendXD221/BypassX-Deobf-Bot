/**
 * .minify / /minify — strip comments and compact whitespace in Lua/JS safely.
 */
import { CONFIG } from '../config.js';
import { getInputBuffer } from '../ctx.js';
import { minifyCode } from '../postprocess.js';
import { BRAND, codeToolReply, errorReply, fmtBytes } from '../replies.js';

export default {
  name: 'minify',
  description: 'Strip comments and compact whitespace in Lua/JS code safely',
  usage: '.minify <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The Lua or JS file to minify', type: 'ATTACHMENT', required: false },
      { name: 'link', description: 'Or fetch it from a link', type: 'STRING', required: false },
    ],
  },

  async run(ctx) {
    await ctx.defer();
    let att;
    try {
      att = await getInputBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
    } catch (e) {
      return ctx.reply(errorReply('Download failed', String(e.message || e).slice(0, 300)));
    }
    if (att.error) return ctx.reply(errorReply('No input', att.error));
    if (att.buffer.subarray(0, 1024).includes(0)) {
      return ctx.reply(errorReply('Binary file', 'Minify works on text code only.'));
    }

    const result = minifyCode(att.filename || 'code.lua', att.buffer);
    if (!result.passes.length) {
      return ctx.reply(errorReply('Nothing to minify', 'I could not recognize this as Lua or JavaScript code.'));
    }
    const savedPct = Math.max(0, Math.round((1 - result.data.length / Math.max(1, att.buffer.length)) * 100));
    return ctx.reply(codeToolReply({
      title: '🗜️ Minified',
      subtitle: `${result.passes.join(' • ')} (${savedPct}% smaller)`,
      accent: BRAND.ok,
      factsRows: [
        { label: 'File', value: att.filename || 'code' },
        { label: 'Before → After', value: `${fmtBytes(att.buffer.length)} → ${fmtBytes(result.data.length)}` },
      ],
      code: result.data.toString('utf8'),
      codeName: att.filename || 'minified.lua',
    }));
  },
};
