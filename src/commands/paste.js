/**
 * .paste / /paste — upload a text or file to Pastefy (utility).
 * Sources: attachment > slash text option > linked file > reply text.
 * Large content is auto-chunked into multi-part pastes.
 */
import { createPaste } from '../pastefy.js';
import { codeToolReply, errorReply } from '../replies.js';
import { getInputBuffer } from '../ctx.js';
import { CONFIG } from '../config.js';
import { logger } from '../logger.js';
import { fmtBytes } from '../replies.js';

export default {
  name: 'paste',
  description: 'Upload a file or text to Pastefy — large content is auto-split into parts',
  usage: '.paste <attach file | text>',
  slash: {
    options: [
      { name: 'file', description: 'A file to upload', type: 'ATTACHMENT', required: false },
      { name: 'text', description: 'Or raw text to upload', type: 'STRING', required: false },
    ],
  },

  async run(ctx) {
    await ctx.defer();

    let text = null;
    let filename = 'paste.txt';

    if (!ctx.isSlash && ctx.args?.length) {
      // Prefix: the whole argument string is the text (unless a file rides along).
      text = ctx.args.join(' ');
    }
    if (ctx.isSlash) {
      const t = ctx.interaction?.options?.getString('text');
      if (t) text = t;
    }

    if (!text || !text.trim()) {
      // Fall back to attachment / link input.
      let att;
      try {
        att = await getInputBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
      } catch (e) {
        return ctx.reply(errorReply('Download failed', String(e.message || e).slice(0, 300)));
      }
      if (att.error) {
        return ctx.reply(errorReply('Nothing to paste', 'Attach a file, add text after the command, or pass a link.'));
      }
      if (att.buffer.subarray(0, 1024).includes(0)) {
        return ctx.reply(errorReply('Binary file', 'Pastefy carries text only — this looks like a binary file.'));
      }
      text = att.buffer.toString('utf8');
      filename = att.filename || filename;
    }

    try {
      const paste = await createPaste({ title: `BypassX Deobf paste — ${filename}`, text });
      logger.info({ file: filename, bytes: Buffer.byteLength(text) }, 'paste: created');
      return ctx.reply(codeToolReply({
        title: '🧾 Paste created',
        subtitle: paste.parts?.length > 1 ? `${paste.parts.length} parts (auto-split)` : 'single paste',
        factsRows: [
          { label: 'Size', value: fmtBytes(Buffer.byteLength(text)) },
          { label: 'Name', value: filename },
        ],
        code: text.length <= 100_000 ? text : null,
        codeName: filename,
        paste,
      }));
    } catch (e) {
      logger.warn({ err: String(e.message || e) }, 'paste: failed');
      return ctx.reply(errorReply('Pastefy upload failed', String(e.message || e).slice(0, 400)));
    }
  },
};
