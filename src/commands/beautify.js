/**
 * .beautify / /beautify — reformat messy/minified code (no deobfuscation).
 */
import { beautifyCode } from '../postprocess.js';
import { codeToolReply, errorReply } from '../replies.js';
import { getInputBuffer } from '../ctx.js';
import { CONFIG } from '../config.js';
import { fmtBytes } from '../replies.js';

export default {
  name: 'beautify',
  description: 'Reformat messy or minified code into clean indentation (no deobfuscation)',
  usage: '.beautify <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The code file', type: 'ATTACHMENT', required: false },
      { name: 'link', description: 'Or fetch it from a link (Pastefy, GitHub, Pastebin, gist, Discord message, direct)', type: 'STRING', required: false },
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
      return ctx.reply(errorReply('Binary file', 'Beautify works on text code only.'));
    }

    const result = beautifyCode(att.filename || 'code.txt', att.buffer);
    if (!result.passes.length) {
      return ctx.reply(errorReply('Nothing to beautify', 'I could not recognize this as Lua or JavaScript code, or it is already well-formatted.'));
    }
    return ctx.reply(codeToolReply({
      title: '✨ Beautified',
      subtitle: result.passes.join(' • '),
      factsRows: [
        { label: 'File', value: att.filename || 'code' },
        { label: 'Size', value: fmtBytes(att.buffer.length) },
      ],
      code: result.data.toString('utf8'),
      codeName: att.filename || 'beautified.txt',
    }));
  },
};
