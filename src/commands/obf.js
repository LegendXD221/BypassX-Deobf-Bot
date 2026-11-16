/**
 * .obf / /obf — Xfuscator: the in-house obfuscator. Encrypts a Lua script
 * into a self-contained encrypted loader (string table → number encoding →
 * full-body XOR blob with integrity gate). The output always starts with the
 * Xfuscator signature header.
 */
import { xfuscate, XFUL_VERSION } from '../xfuscator.js';
import { codeToolReply, errorReply } from '../replies.js';
import { getInputBuffer } from '../ctx.js';
import { CONFIG } from '../config.js';
import { fmtBytes } from '../replies.js';
import { logger } from '../logger.js';
import { createPaste } from '../pastefy.js';

export default {
  name: 'obf',
  description: `Xfuscator (${XFUL_VERSION}) — encrypt a Lua script into a self-protected loader`,
  usage: '.obf <attach file | link>',
  slash: {
    options: [
      { name: 'file', description: 'The Lua file to obfuscate', type: 'ATTACHMENT', required: false },
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
      return ctx.reply(errorReply('Binary file', 'Xfuscator works on text Lua/Luau scripts only.'));
    }

    const src = att.buffer.toString('latin1');
    const r = xfuscate(src);
    if (!r.ok) {
      return ctx.reply(errorReply('Xfuscator refused this input', String(r.error || 'unknown').slice(0, 300)));
    }

    logger.info({ bytes: src.length, out: r.code.length, meta: r.meta }, 'xfuscator obf');

    let paste = null;
    if (r.code.length > 1600) {
      try {
        paste = await createPaste({ title: 'Xfuscator output', text: r.code });
      } catch { /* paste optional */ }
    }

    const m = r.meta || {};
    const layers = [
      m.strings?.extracted ? `string-table ×${m.strings.extracted}` : null,
      m.numbersEncoded ? `numbers ×${m.numbersEncoded}` : null,
      m.blob ? `encrypted blob ${fmtBytes(m.blob.encBytes)} (${m.blob.keys}-byte rolling key + integrity gate)` : null,
    ].filter(Boolean).join(' • ');

    return ctx.reply(codeToolReply({
      title: '🛡️ Xfuscated',
      subtitle: `Xfuscator ${XFUL_VERSION} — ${layers || 'loader'}`,
      factsRows: [
        { label: 'File', value: att.filename || 'script.lua' },
        { label: 'Size', value: `${fmtBytes(src.length)} → ${fmtBytes(r.code.length)}` },
      ],
      code: r.code,
      codeName: (att.filename || 'script.lua').replace(/\.luau?$/i, '') + '.obf.lua',
      paste,
      note: 'The loader self-verifies (integrity gate) before decrypting. Strings are table-encrypted, numbers are opaque expressions, and the whole body rides an encrypted blob — keep the output header intact, it identifies Xfuscator builds.',
    }));
  },
};
