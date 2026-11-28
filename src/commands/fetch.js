/**
 * .fetch / /fetch — resilient raw script fetcher (SSRF-safe, auto-raw URLs).
 */
import { CONFIG } from '../config.js';
import { getInputBuffer } from '../ctx.js';
import { detectService, guessLanguage } from '../detect.js';
import { BRAND, codeToolReply, errorReply, fmtBytes } from '../replies.js';

export default {
  name: 'fetch',
  description: 'Fetch raw script source from any supported paste/repo URL and identify it',
  usage: '.fetch <link | attach file>',
  slash: {
    options: [
      { name: 'link', description: 'Link to fetch (GitHub, Pastebin, Gist, Pastefy, Rentry, raw)', type: 'STRING', required: true },
      { name: 'file', description: 'Optional file attachment', type: 'ATTACHMENT', required: false },
    ],
  },

  async run(ctx) {
    await ctx.defer();
    let att;
    try {
      att = await getInputBuffer(ctx, { maxBytes: CONFIG.maxUploadBytes });
    } catch (e) {
      return ctx.reply(errorReply('Fetch failed', String(e.message || e).slice(0, 300)));
    }
    if (att.error) return ctx.reply(errorReply('No URL', att.error));
    if (att.buffer.subarray(0, 1024).includes(0)) {
      return ctx.reply(errorReply('Binary payload', `Fetched ${fmtBytes(att.buffer.length)} of binary data (not text).`));
    }

    const det = detectService(att.buffer);
    const lang = guessLanguage(att.buffer);
    const detLabel = det.best ? `${det.best.service.name} (${det.best.confidence}%)` : `Plain ${lang}`;

    return ctx.reply(codeToolReply({
      title: '🌐 Fetched Script',
      subtitle: att.note || detLabel,
      accent: BRAND.info,
      factsRows: [
        { label: 'File', value: att.filename || 'fetched.lua' },
        { label: 'Size', value: fmtBytes(att.buffer.length) },
        { label: 'Detected', value: detLabel },
      ],
      code: att.buffer.toString('utf8'),
      codeName: att.filename || `fetched.${lang === 'js' ? 'js' : 'lua'}`,
    }));
  },
};
